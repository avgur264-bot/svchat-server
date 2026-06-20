# SVchat → Capacitor: передача контекста для сессии на Mac

Этот файл — вводная для Claude Code, запущенного на Mac пользователя.
Задача: обернуть существующий веб-мессенджер **SVchat** в нативные приложения
Android + iOS через **Capacitor**, по спецификации из `TASK_capacitor_ios_android.md`
(пользователь приложит её отдельно — следуй ей как основному плану).

Пользователь — **не технический**, работает в основном с телефона, на Mac выполняет
команды по твоим пошаговым инструкциям. Объясняй простым языком, давай команды
по одной, не вываливай длинные простыни. Все нажатия кнопок в Android Studio/Xcode —
делает пользователь, ты ведёшь по шагам.

-----

## Что такое SVchat (контекст проекта)

- Реалтайм-мессенджер PWA. Прод: **https://svchat24.ru** (домен), хостинг Render
  (`svchat-server.onrender.com`, free tier). Репозиторий бэкенда+клиента:
  `github.com/avgur264-bot/svchat-server`.
- **Сервер**: `server.js` — Node + Socket.IO + Postgres + web-push (VAPID).
- **Клиент**: `index.html` — минифицированный React-бандл, **встроен прямо в HTML**
  одним большим inline-`<script>`. Отдельной сборки фронта нет — правки делаются
  прямо в этом бандле.
- Деплой: пуш в ветку `main` репозитория → Render автоматически собирает.

## ВАЖНО: не сломать рабочий сайт

- Capacitor создаётся в **ОТДЕЛЬНОЙ папке/репозитории** (`~/svchat-app`), он лишь
  оборачивает живой сайт. **Не меняй сайт без явной необходимости.**
- Архитектура — `server.url: https://svchat24.ru` в `capacitor.config`: приложение
  грузит ЖИВОЙ сайт, а не запакованную статику. Обновления сайта видны в приложении
  без пересборки. Пересборка нужна только при изменении нативной части.

-----

## Подводные камни, специфичные для SVchat (прочитай обязательно)

### 1. Строгий CSP с хешами — ГЛАВНЫЙ риск для Capacitor
В `server.js` Content-Security-Policy задаёт `script-src 'self' 'sha256-...'` —
разрешены только конкретные inline-скрипты по их sha256. CSP прописан в ДВУХ местах:
маршрут `/diag` (~строка 621) и основной маршрут приложения (`appHtml`, ~строка 810).
**Оба должны совпадать.**

Capacitor подмешивает в страницу свой мост (`window.Capacitor`, `capacitor.js`).
При `server.url` сайт грузится со своим CSP, и инъекция моста может быть
**заблокирована**. Это нужно проверить в первую очередь после A1. Возможные решения:
- добавить в `connect-src`/`script-src` схему capacitor (`capacitor://localhost`,
  `https://localhost`) и разрешить мост;
- либо отдавать смягчённый CSP, когда запрос идёт из нативной обёртки
  (определять по заголовку User-Agent приложения / отдельному параметру).
Не ослабляй CSP для обычного веба — только для нативного контекста.

### 2. Система версий и пересчёт хешей CSP
ЛЮБОЕ изменение `index.html` меняет sha256 главного скрипта → нужно пересчитать
**все 5 хешей** inline-скриптов и обновить их в `server.js` (в ОБОИХ местах CSP),
плюс синхронно поднять `window.__svBuild` (в index.html) и `CLIENT_BUILD` (в server.js).
Скрипт для пересчёта хешей (запускать из корня репо):
```js
// scan.js
const fs=require('fs'),c=require('crypto');const h=fs.readFileSync('index.html','utf8');
const re=/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;let m,i=0;
while((m=re.exec(h))){const a=m[1]||'';if(/\bsrc=/.test(a)){i++;continue;}
console.log('#'+i+' sha256-'+c.createHash('sha256').update(m[2],'utf8').digest('base64'));i++;}
```
Проверка готовности деплоя: `curl -s https://svchat24.ru/stats` → поле `"ver"`.

### 3. Мостовой слой isNative — в бандле index.html
Определение среды:
```js
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const platform = window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform();
```
Точки, где нужна ветка `isNative`:
- **Пуши**: сейчас Web Push (VAPID) + Service Worker. В нативе — `PushNotifications.register()`,
  получить FCM/APNs-токен, отправить на сервер.
- **Сохранение медиа**: функция сохранения файла (искать в бандле обработчик
  скачивания/`download`/`navigator.share`). В нативе — `@capacitor-community/media`
  пишет прямо в галерею/Фото.
Правки в минифицированном бандле делать аккуратно, точечными заменами.

### 4. Серверные пуши FCM — рядом с Web Push, НЕ вместо
Сейчас сервер шлёт только Web Push. Добавить `firebase-admin` и отправку через FCM:
- хранить тип подписки на устройство: `web` | `fcm`;
- расширить приём подписки (FCM-токен + платформа);
- при новом сообщении: web-подписчикам — `webpush.sendNotification` (как сейчас),
  fcm-подписчикам — `firebase-admin` messaging;
- секрет Firebase (service account JSON) — в env Render, не в код.
**Не удаляй существующий Web Push** — он нужен браузеру/PWA.
Push-логика на сервере: смотри `pushToUser`, `pushToRoom`, карты `pushSubs`/`userSubs`,
обработчик `message` (ветка `isDm`) и `dm_invite`.

### 5. Render free tier
Засыпает при простое (есть self-ping каждые ~10 мин). После серии деплоев
**троттлит очередь сборок** (деплой может «висеть» десятки минут). Ускорение —
Manual Deploy в дашборде Render → Deploy latest commit.

-----

## Что уже сделано в основном репо (на момент передачи)
- Починен баг личных чатов с дублями аккаунтов (приоритет зарегистрированного
  аккаунта в справочнике `/users`).
- Добавлена надёжность личных чатов: при `dm_invite` и первом сообщении получатель
  регистрируется участником комнаты (чат подтянется у второго при следующем открытии).
- Текущая клиентская сборка ~166. (Серверный фикс надёжности и удаление временного
  диагностического эндпоинта `/_diag_dm` могли ещё ждать зависшего деплоя Render —
  проверь `curl -s https://svchat24.ru/stats`.)

## Рекомендованный порядок (без лишних трат)
1. Общая часть: `npm init`, установить `@capacitor/core @capacitor/cli`,
   `npx cap init SVchat ru.svchat.app --web-dir=www`, создать `capacitor.config.json`
   с `server.url`, заглушку `www/index.html`, плагины
   (`@capacitor/push-notifications`, `@capacitor/filesystem`, `@capacitor-community/media`).
2. **Android (A1)**: `@capacitor/android`, `npx cap add android`, `npx cap sync`,
   `npx cap open android` → собрать APK → поставить на Samsung → проверить, что
   открывается SVchat. **Сразу проверить, не блокирует ли CSP мост Capacitor.**
3. **A2**: сохранение медиа в галерею (быстрая видимая польза).
4. **Сервер FCM + A3**: пуши Android, проверить «закрыл приложение → пришло сообщение».
5. Только потом — публикация Google Play ($25) и/или iOS ($99/год, ревью строже).
Шаги 1–4 — без единого платежа. iOS откладывать до отладки Android.

## Что НЕ делать
- Не переписывать SVchat с нуля. Не ломать сайт/Render. Не убирать Web Push.
- Не паковать статику — только `server.url`.
- Не лезть в iOS-публикацию до отладки Android-обёртки.
