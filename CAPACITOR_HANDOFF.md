# SVchat → Capacitor: передача контекста для сессии на Mac

Этот файл — вводная для Claude Code, запущенного на Mac пользователя.
Задача: обернуть существующий веб-мессенджер **SVchat** в нативные приложения
Android + iOS через **Capacitor** и довести до публикации в Google Play и App Store.
Спецификация — в `TASK_capacitor_ios_android.md` (пользователь приложит её; следуй ей
как плану). Этот файл — актуальный контекст и важные подводные камни.

Пользователь — **не технический**, работает в основном с телефона, на Mac выполняет
команды по твоим пошаговым инструкциям. Объясняй простым языком, давай команды
по одной, не вываливай длинные простыни. Все нажатия в Android Studio/Xcode —
делает пользователь, ты ведёшь по шагам и пишешь весь код.

-----

## Что такое SVchat

- Реалтайм-PWA-мессенджер. Прод: **https://svchat24.ru**, хостинг Render (free).
- Репозиторий: `github.com/avgur264-bot/svchat-server` (ветка разработки
  `claude/capabilities-overview-9h6g68`, пуш в неё → она же деплоится в прод как main).
- **Сервер**: `server.js` — Node + Socket.IO + Postgres + web-push (VAPID) + WebRTC-звонки.
- **Клиент**: `index.html` — минифицированный React-бандл, встроен ОДНИМ inline-`<script>`
  прямо в HTML. Отдельной сборки фронта нет — правки точечными заменами в бандле.
- **Текущая клиентская сборка: 173** (`window.__svBuild` в index.html, `CLIENT_BUILD` в server.js).

## ГЛАВНОЕ: не сломать рабочий сайт

- Capacitor — в ОТДЕЛЬНОЙ папке/репозитории. Подход `server.url: https://svchat24.ru`:
  приложение грузит ЖИВОЙ сайт, статику не пакуем. Обновления сайта видны в приложении
  без пересборки; пересборка нужна только при изменении нативной части.
- НЕ ломать `svchat24.ru`/Render. НЕ убирать Web Push. НЕ переписывать SVchat.

-----

## Подводные камни, специфичные для SVchat (читать обязательно)

### 1. Строгий CSP с хешами — ГЛАВНЫЙ риск для Capacitor
В `server.js` CSP задаёт `script-src 'self' 'sha256-...'` — разрешены только конкретные
inline-скрипты по их sha256. CSP прописан в ДВУХ местах: маршрут `/diag` и основной
маршрут приложения (`appHtml`). **Оба должны совпадать.**
Capacitor подмешивает мост (`window.Capacitor`, `capacitor.js`). При `server.url` сайт
грузится со своим CSP, и мост может быть **заблокирован**. Проверить В ПЕРВУЮ ОЧЕРЕДЬ
после первой Android-сборки. Решения: разрешить схему `capacitor://localhost` /
`https://localhost` в CSP, либо отдавать смягчённый CSP для нативной обёртки
(определять по User-Agent приложения). НЕ ослаблять CSP для обычного веба.

### 2. Система версий и пересчёт хешей CSP
ЛЮБОЕ изменение `index.html` меняет sha256 главного скрипта → нужно пересчитать
**все хеши** inline-скриптов и обновить их в `server.js` в ОБОИХ местах CSP,
плюс синхронно поднять `window.__svBuild` и `CLIENT_BUILD`.
Скрипт пересчёта (из корня репо):
```js
// scan.js
const fs=require('fs'),c=require('crypto');const h=fs.readFileSync('index.html','utf8');
const re=/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;let m,i=0;
while((m=re.exec(h))){const a=m[1]||'';if(/\bsrc=/.test(a)){i++;continue;}
console.log('#'+i+' sha256-'+c.createHash('sha256').update(m[2],'utf8').digest('base64'));i++;}
```
Проверка деплоя: `curl -s https://svchat24.ru/stats` → поле `"ver"`.
Render free иногда троттлит деплой — может помочь Manual Deploy в дашборде Render.

### 3. Мостовой слой isNative — в бандле index.html
```js
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const platform = window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform();
```
Точки, где нужна ветка `isNative`:
- **Пуши**: сейчас Web Push (VAPID) + Service Worker. В нативе — `PushNotifications.register()`,
  получить FCM/APNs-токен, отправить на сервер.
- **Сохранение медиа в галерею**: найти в бандле обработчик сохранения файла; в нативе —
  через нативный плагин (например `@capacitor-community/media`) писать прямо в галерею/Фото.
Правки в минифицированном бандле — точечными заменами (через node-скрипт с проверкой,
что строка встречается ровно 1 раз), затем пересчёт CSP-хешей (см. п.2).

### 4. Серверные пуши FCM — рядом с Web Push, НЕ вместо
Добавить `firebase-admin` и отправку через FCM:
- хранить тип подписки на устройство: `web` | `fcm`;
- при новом сообщении: web-подписчикам — `webpush.sendNotification` (как сейчас),
  fcm-подписчикам — `firebase-admin` messaging;
- секрет Firebase (service account JSON) — в env Render, не в код.
Push-логика на сервере: `pushToUser`, `pushToRoom`, карты `pushSubs`/`userSubs`,
обработчик `message` (ветка `isDm`) и `dm_invite`.

### 5. Звонки (WebRTC) — уже работают в вебе
Звонки на ванильном WebRTC: `svCallStart/svCallPc/svCallCommon/svCallUi`, сигналинг через
Socket.IO событие `signal` (типы `sv_offer/sv_answer/sv_ice/sv_end`). ICE/TURN — эндпоинт
`/ice` (STUN + TURN metered.ca, креды в env `TURN_USERNAME`/`TURN_CREDENTIAL`).
В нативной обёртке проверь разрешения камеры/микрофона (Android manifest, iOS Info.plist:
`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`).

-----

## Что уже сделано в основном репо (на момент передачи, сборка 173)
- Доступ без VPN, починен CSP (приложение грузится).
- **Мульти-устройство**: аккаунт живёт на нескольких устройствах (таблица `svchat_authtok`,
  `userAuth` = Set токенов, `addAuth`, вход по паролю добавляет устройство).
- Безопасный «Выход из аккаунта» (не удаляет аккаунт).
- Закрытые группы: участник заходит без повторного ввода пароля; приём хеша как «пропуска».
- Личные чаты: починены дубли ID в справочнике (`/users`), надёжность приглашений
  (`dm_invite`/первое сообщение регистрируют участника).
- **Закрепление чатов** 📌 + сортировка (закреплённые → непрочитанные → остальные),
  синхронизация через сервер (таблица `svchat_pins`, событие `set_pin`, отдача в `my_rooms`).
- Экран звонка: кнопки вниз, автоскрытие; надёжное воспроизведение удалённого звука на iOS.

## Рекомендованный порядок (без лишних трат; этапы 1–4 бесплатны)
1. Общая часть: `npm init -y`; `npm i @capacitor/core @capacitor/cli`;
   `npx cap init SVchat ru.svchat.app --web-dir=www`; создать `www/index.html` (заглушка);
   `capacitor.config` с `server.url: "https://svchat24.ru"`.
2. **Android (A1)**: `npm i @capacitor/android`; `npx cap add android`; `npx cap sync`;
   `npx cap open android` → собрать APK → поставить на Samsung → убедиться, что открывается
   SVchat. **Сразу проверить, не блокирует ли CSP мост Capacitor** (см. п.1).
3. **A2** — сохранение медиа в галерею (быстрая видимая польза).
4. **Сервер FCM + A3** — пуши Android; проверить «закрыл приложение → пришло сообщение».
5. Публикация Google Play ($25), затем iOS ($99/год, ревью строже): `@capacitor/ios`,
   `npx cap add ios`, Xcode, разрешения, APNs.

## Что НЕ делать
- Не ломать сайт/Render. Не убирать Web Push. Не паковать статику (только `server.url`).
- Не лезть в iOS-публикацию до отладки Android-обёртки.
- Идентификатор модели/служебные строки не писать в коммиты/код.
