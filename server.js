/**
 * SVchat Realtime Server
 * Настоящий WebSocket-сервер: передаёт сообщения между живыми людьми в реальном времени.
 * Хранит последние сообщения в памяти (история чата для входящих).
 *
 * Запуск: node server.js  (порт из PORT или 8080)
 */
const http = require('http')
const { WebSocketServer } = require('ws')

const PORT = process.env.PORT || 8080
const HISTORY_LIMIT = 200 // последних сообщений на комнату

// ── Хранилище в памяти ──────────────────────────────────────────────────────
const rooms = new Map()      // roomId -> Set<ws>
const history = new Map()    // roomId -> [messages]
const users = new Map()      // ws -> { id, name, room }

function getHistory(room) {
  if (!history.has(room)) history.set(room, [])
  return history.get(room)
}

function broadcast(room, data, exclude = null) {
  const clients = rooms.get(room)
  if (!clients) return
  const msg = JSON.stringify(data)
  for (const client of clients) {
    if (client !== exclude && client.readyState === 1) client.send(msg)
  }
}

function roomUserList(room) {
  const clients = rooms.get(room)
  if (!clients) return []
  return [...clients].map(c => users.get(c)).filter(Boolean).map(u => ({ id: u.id, name: u.name }))
}

// ── HTTP (health-check для хостинга) ────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, online: users.size }))
  } else {
    res.writeHead(404); res.end()
  }
})

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      // Вход в комнату: { type:'join', room, userId, name }
      case 'join': {
        const room = String(msg.room || 'general').slice(0, 64)
        const user = { id: msg.userId || Math.random().toString(36).slice(2), name: String(msg.name || 'Гость').slice(0, 40), room }
        users.set(ws, user)
        if (!rooms.has(room)) rooms.set(room, new Set())
        rooms.get(room).add(ws)

        // Отправляем новичку историю + список участников
        ws.send(JSON.stringify({ type: 'history', messages: getHistory(room) }))
        ws.send(JSON.stringify({ type: 'users', users: roomUserList(room) }))
        // Сообщаем остальным
        broadcast(room, { type: 'user_joined', user: { id: user.id, name: user.name } }, ws)
        broadcast(room, { type: 'users', users: roomUserList(room) })
        break
      }

      // Сообщение: { type:'message', text | encrypted, msgType }
      case 'message': {
        const user = users.get(ws)
        if (!user) return
        const entry = {
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          from: user.id,
          fromName: user.name,
          msgType: msg.msgType || 'text',
          text: msg.text,
          encrypted: msg.encrypted,
          dataUrl: msg.dataUrl,
          time: new Date().toISOString(),
        }
        const h = getHistory(user.room)
        h.push(entry)
        if (h.length > HISTORY_LIMIT) h.shift()
        broadcast(user.room, { type: 'message', message: entry })
        break
      }

      // Печатает: { type:'typing' }
      case 'typing': {
        const user = users.get(ws)
        if (!user) return
        broadcast(user.room, { type: 'typing', userId: user.id, name: user.name }, ws)
        break
      }

      // WebRTC сигналинг (для будущих звонков): просто пересылаем
      case 'signal': {
        const user = users.get(ws)
        if (!user) return
        broadcast(user.room, { type: 'signal', from: user.id, data: msg.data, target: msg.target }, ws)
        break
      }
    }
  })

  ws.on('close', () => {
    const user = users.get(ws)
    if (user) {
      const clients = rooms.get(user.room)
      if (clients) {
        clients.delete(ws)
        if (clients.size === 0) rooms.delete(user.room)
        else {
          broadcast(user.room, { type: 'user_left', user: { id: user.id, name: user.name } })
          broadcast(user.room, { type: 'users', users: roomUserList(user.room) })
        }
      }
      users.delete(ws)
    }
  })
})

// Пинг каждые 30с — отсеиваем мёртвые соединения
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    ws.ping()
  })
}, 30000)

server.listen(PORT, () => {
  console.log(`SVchat server на порту ${PORT}`)
})
