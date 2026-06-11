/**
 * SVchat Realtime Server (Socket.IO)
 * Надёжный обмен сообщениями в реальном времени.
 * Socket.IO сам выбирает транспорт: сначала HTTP-polling (работает везде),
 * затем повышает до WebSocket. Если WebSocket недоступен — остаётся на polling.
 * Хранит последние сообщения в памяти (история комнаты).
 */
const http = require('http')
const { Server } = require('socket.io')

const PORT = process.env.PORT || 8080
const HISTORY_LIMIT = 200

const history = new Map()    // roomId -> [messages]
const roomUsers = new Map()  // roomId -> Map<socketId, {id, name}>

function getHistory(room) {
  if (!history.has(room)) history.set(room, [])
  return history.get(room)
}
function userList(room) {
  const m = roomUsers.get(room)
  return m ? [...m.values()] : []
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify({ ok: true, online: [...roomUsers.values()].reduce((n, m) => n + m.size, 0) }))
})

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
})

io.on('connection', (socket) => {
  let currentRoom = null
  let me = null

  socket.on('join', (p = {}) => {
    currentRoom = String(p.room || 'general').slice(0, 64)
    me = { id: p.userId || socket.id, name: String(p.name || 'Гость').slice(0, 40) }
    socket.join(currentRoom)
    if (!roomUsers.has(currentRoom)) roomUsers.set(currentRoom, new Map())
    roomUsers.get(currentRoom).set(socket.id, me)
    socket.emit('history', { messages: getHistory(currentRoom) })
    io.to(currentRoom).emit('users', { users: userList(currentRoom) })
    socket.to(currentRoom).emit('user_joined', { user: me })
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
  console.log(`SVchat Socket.IO server на порту ${PORT}`)
})
