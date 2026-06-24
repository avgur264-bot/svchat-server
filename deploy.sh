#!/bin/bash
set -e
cd /var/www/svchat

echo "[deploy] Скачиваем index.html..."
curl -fsSL https://raw.githubusercontent.com/avgur264-bot/svchat-server/main/index.html -o index.html.tmp
mv index.html.tmp index.html

echo "[deploy] Скачиваем server.js..."
curl -fsSL https://raw.githubusercontent.com/avgur264-bot/svchat-server/main/server.js -o server.js.tmp
mv server.js.tmp server.js

echo "[deploy] Скачиваем package.json..."
curl -fsSL https://raw.githubusercontent.com/avgur264-bot/svchat-server/main/package.json -o package.json.tmp
mv package.json.tmp package.json

echo "[deploy] npm install..."
npm install --production --silent

echo "[deploy] Перезапускаем pm2..."
# Переменные окружения нужно передать явно при рестарте
export $(cat /var/www/svchat/.env | xargs)
pm2 restart svchat

echo "[deploy] Готово: $(date)"
