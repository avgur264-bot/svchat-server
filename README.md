# SVchat

[![E2E Tests](https://github.com/avgur264-bot/svchat-server/actions/workflows/e2e.yml/badge.svg)](https://github.com/avgur264-bot/svchat-server/actions/workflows/e2e.yml)

Реалтайм‑мессенджер (Socket.IO) + Postgres + Web Push. PWA с тёмной темой,
личными чатами с E2E‑шифрованием, файлами и push‑уведомлениями.

- `server.js` — Node.js сервер (Socket.IO, Postgres, web-push, раздача статики)
- `index.html` — клиент (React, PWA)
- `svchat-e2e/` — сквозные тесты (Playwright). См. [svchat-e2e/README.md](svchat-e2e/README.md)

Бейдж выше показывает статус автотестов: 🟢 зелёный — сайт жив и ключевые
функции работают; 🔴 красный — что‑то сломалось (смотри вкладку **Actions**).

## Запуск сервера

```bash
npm install
node server.js        # слушает PORT (по умолчанию 8080)
```

Переменные окружения: `DATABASE_URL`, `VAPID_PUBLIC`/`VAPID_PRIVATE`,
`OWNER_KEY`, `TURN_USERNAME`/`TURN_CREDENTIAL`, `PORT`.

## Тесты

```bash
cd svchat-e2e && npm install && npx playwright install chromium
npm run test:smoke   # быстрая проверка «сайт жив»
npm test             # все E2E
```
