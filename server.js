/**
 * SVchat Realtime Server (Socket.IO)
 * Комнаты (открытые и закрытые с паролем), администратор, история в памяти.
 * Раздаёт приложение (index.html) с того же адреса — без межсайтовых запросов.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Server } = require('socket.io')

const PORT = process.env.PORT || 8080
const HISTORY_LIMIT = 200

const history = new Map()    // room -> [messages]
const roomUsers = new Map()  // room -> Map<socketId, {id, name}>
const roomMeta = new Map()   // room -> { password: string|null, adminId: string|null }

function getHistory(room) {
  if (!history.has(room)) history.set(room, [])
  return history.get(room)
}
function userList(room) {
  const m = roomUsers.get(room)
  const meta = roomMeta.get(room)
  if (!m) return []
  return [...m.values()].map(u => ({ ...u, isAdmin: !!(meta && meta.adminId === u.id) }))
}
function onlineTotal() {
  return [...roomUsers.values()].reduce((n, m) => n + m.size, 0)
}

// ── HTTP: /health + раздача приложения ──────────────────────────────────────
let appHtml = null
try { appHtml = fs.readFileSync(path.join(__dirname, 'index.html')) } catch {}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, online: onlineTotal() }))
  } else if (appHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(appHtml)
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true }))
  }
})

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  maxHttpBufferSize: 10e6, // до 10 МБ (фото)
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
})

io.on('connection', (socket) => {
  let currentRoom = null
  let me = null

  // Вход: { room, userId, name, password? }
  socket.on('join', (p = {}) => {
    const room = String(p.room || 'general').slice(0, 64)
    const password = p.password ? String(p.password).slice(0, 64) : null
    const user = { id: p.userId || socket.id, name: String(p.name || 'Гость').slice(0, 40) }

    const occupied = roomUsers.has(room) && roomUsers.get(room).size > 0
    let meta = roomMeta.get(room)

    if (!occupied) {
      // Комната пуста: вошедший задаёт правила. С паролем — становится администратором.
      meta = { password: password || null, adminId: password ? user.id : (meta ? meta.adminId : null) }
      // Если комната уже существовала с паролем (все вышли) — пароль сохраняется,
      // но прежний админ остаётся; вход требует пароль.
      const prev = roomMeta.get(room)
      if (prev && prev.password) {
        if (prev.password !== password) {
          socket.emit('join_error', { reason: 'wrong_password' })
          return
        }
        meta = prev
      }
      roomMeta.set(room, meta)
    } else {
      // В комнате есть люди: если есть пароль — проверяем
      if (meta && meta.password && meta.password !== password) {
        socket.emit('join_error', { reason: 'wrong_password' })
        return
      }
    }

    currentRoom = room
    me = user
    socket.join(room)
    if (!roomUsers.has(room)) roomUsers.set(room, new Map())
    roomUsers.get(room).set(socket.id, me)

    socket.emit('joined', { room, isAdmin: !!(meta && meta.adminId === me.id), locked: !!(meta && meta.password) })
    socket.emit('history', { messages: getHistory(room) })
    io.to(room).emit('users', { users: userList(room) })
    socket.to(room).emit('user_joined', { user: me })
  })

  socket.on('message', (msg = {}) => {
    if (!currentRoom || !me) return
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      from: me.id,
      fromName: me.name,
      msgType: msg.msgType || 'text',
      text: msg.text,
      encrypted: msg.encrypted,
      dataUrl: msg.dataUrl,
      time: new Date().toISOString(),
    }
    const h = getHistory(currentRoom)
    h.push(entry)
    if (h.length > HISTORY_LIMIT) h.shift()
    io.to(currentRoom).emit('message', { message: entry })
  })

  socket.on('typing', () => {
    if (!currentRoom || !me) return
    socket.to(currentRoom).emit('typing', { userId: me.id, name: me.name })
  })

  // Администратор удаляет участника: { targetId }
  socket.on('kick', (p = {}) => {
    if (!currentRoom || !me) return
    const meta = roomMeta.get(currentRoom)
    if (!meta || meta.adminId !== me.id) return // только админ
    const targetId = String(p.targetId || '')
    if (!targetId || targetId === me.id) return
    const m = roomUsers.get(currentRoom)
    if (!m) return
    for (const [sockId, u] of m.entries()) {
      if (u.id === targetId) {
        const targetSocket = io.sockets.sockets.get(sockId)
        if (targetSocket) {
          targetSocket.emit('kicked', { room: currentRoom })
          targetSocket.leave(currentRoom)
        }
        m.delete(sockId)
      }
    }
    io.to(currentRoom).emit('users', { users: userList(currentRoom) })
  })

  socket.on('signal', (data = {}) => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('signal', { from: me && me.id, data: data.data, target: data.target })
  })

  socket.on('disconnect', () => {
    if (currentRoom && roomUsers.has(currentRoom)) {
      roomUsers.get(currentRoom).delete(socket.id)
      if (roomUsers.get(currentRoom).size === 0) roomUsers.delete(currentRoom)
      io.to(currentRoom).emit('users', { users: userList(currentRoom) })
      if (me) socket.to(currentRoom).emit('user_left', { user: me })
    }
  })
})

server.listen(PORT, () => {
  console.log(`SVchat server на порту ${PORT}`)
})
