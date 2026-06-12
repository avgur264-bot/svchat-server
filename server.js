/**
 * SVchat Realtime Server (Socket.IO) + Web Push
 * Комнаты (открытые/закрытые), админ, история в памяти,
 * push-уведомления когда приложение закрыто (PWA на экране «Домой»).
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Server } = require('socket.io')
const webpush = require('web-push')

const PORT = process.env.PORT || 8080
const HISTORY_LIMIT = 200

// ── Web Push (VAPID) ─────────────────────────────────────────────────────────
const VAPID_PUBLIC = 'BIcya5h2_ej5u0BMkGyvjSXPLk9pHiy5LXUS0hjzXtipKS47A8xJcCpNrRHZXErGxZbzFXI8re34DPu215B_EjQ'
const VAPID_PRIVATE = 'CmR_1O1LAe-baaCuoUUdZBPk66STfCz0CuAs3KUHiKo'
webpush.setVapidDetails('mailto:admin@svchat.app', VAPID_PUBLIC, VAPID_PRIVATE)

// room -> Map<endpoint, { sub, userId }>
const pushSubs = new Map()
function addSub(room, userId, sub) {
  if (!sub || !sub.endpoint) return
  if (!pushSubs.has(room)) pushSubs.set(room, new Map())
  pushSubs.get(room).set(sub.endpoint, { sub, userId })
}
async function pushToRoom(room, exceptUserId, payload) {
  const m = pushSubs.get(room)
  if (!m) return
  const data = JSON.stringify(payload)
  for (const [endpoint, { sub, userId }] of [...m.entries()]) {
    if (userId === exceptUserId) continue
    try {
      await webpush.sendNotification(sub, data, { TTL: 60 })
    } catch (e) {
      const code = e && e.statusCode
      if (code === 404 || code === 410) m.delete(endpoint) // подписка умерла
    }
  }
}

const history = new Map()
const roomUsers = new Map()
const roomMeta = new Map()

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

// ── Статика: приложение, service worker, манифест, иконки ───────────────────
let appHtml = null
try { appHtml = fs.readFileSync(path.join(__dirname, 'index.html')) } catch {}

const SW_JS = `
self.addEventListener('install', e => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch {}
  const title = d.title || 'SVchat'
  const opts = {
    body: d.body || 'Новое сообщение',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'svchat',
    data: { url: d.url || '/' }
  }
  e.waitUntil(self.registration.showNotification(title, opts))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) { try { await c.focus(); return } catch {} }
    await self.clients.openWindow(e.notification.data && e.notification.data.url || '/')
  })())
})
`

const MANIFEST = JSON.stringify({
  name: 'SVchat',
  short_name: 'SVchat',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0a0e1a',
  theme_color: '#0057FF',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
  ]
})

const ICON_192 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAALaUlEQVR42u2deVRU1x3Hv8MMq7KoKKCIRAHFpSpWARXUWismxBhJxKhY66mhjRpbjbXVY05iTtucaj3aarXxWNcaTVsb96g1Chg1BJRVDRqQRVAERcAZdvqHiXFhuXfmDfNwvp9/5/fuvee9z7y736dBdCMIMRYb3gJCgQgFIhSIUCBCKBChQIQCEQpECAUiFIhQIEKBCKFAhAIRCkQoECEUiFAgQoEIBSIUiBAKRCgQoUCEAhFCgQgFIhSIUCBCKBChQIQCEQpECAUiFIhQIEKBCAUihAIRCkQoEKFAhFAgQoEIBSIUiBAKRCgQoUCEAhFCgQgFIhSIUCBCKBChQIQCEQpEKBAhFIhQIEKBCAUihAIR86JrF6X090RoAAZ4o293dO8ED1e4OsHeFnY6VNfCUAN9DfTVqDCg8B4K7qKgFAV3kVuCjHyUVvApmxENohtVWjINxvVH9EhMHgZPN+PTKSpDWi7S85GWiy++Rnax6IULI/CXOaLBB5Pxympz3YrzHyDEXzR4+nrsO2/dAtloMGcs3olEYA/lEy+8h4SrSLiC+KtIz2spsoszCjfBTuwdXVsPr1+Y5W3XxwPX14sG39fDMxZVtVbcBgr2w8UPsTXWLPYA6N4J0aHYMBcJ77USWVqBI5dEk7XVIjrULAWeFSYRvO98m9qjOoGWROLs+xjcSy3l2X5GIjgmzCxlmDlapsBxVtwLWz8Ha2ZBp1WR0EdTcKdcNDjEH36eyr+P/YXTvHYL57OsVaBV0/B2hOoa8nX12POFTHUzWuECxIRLBO+Is8AtUoVAkUFYOVWl3VSpSmGmogLptJgWIhrc0Iid8VYpkLMj/j5PveMcKTeQmisa7OeJ0ADFso4YjK4uosGnM5FfapUCvR2B7p2gZqSqBgVrMan+1/Y4y9wcCwtkq8WiSVA5/zyLunrR4OhQ2CrRD3B2xORhosGVVdifaJmbY+GpjIkyb+mHXLqBUxn48hpu3EHBXTyohqEGGsDBDm5O6OaKnl3g74nAHgh6Af29FXicxeX4LBWRQULBXZwxaQgOJpua6WvBcLQTDf7XBeirrVIgwafykLjLWLIbydlN/1prQIUB+aVPBDjaIawffjwIEwZhcC9oNMY3pcWLGhOugEDtov6yvECj+4lG7ozHzzahQXLexVCDE2k4kQYAXV0QGYTZ4RgTKG3SoWTcrUTnjqL/Clcn3Ncbf1t6dMbY/qLBOcVIuGqxJ2jJNpDWBn29hCJvlSF2i7Q9T3GnHNvOYNwq+C7Eir24clPi2po67D0nGuxgi9dDTCrqjFGw0Uj8tRobrVIgH3fRcee955Sc4skrwR8+RehK6Vqszfpi4rMijY3YEW/BZ2hRgTp1EI28fsvyfbGvvsHlAtHg8ED4uBuZ0SAfDPIRDU64ipxiaxXIyV64paaOCTLx/7pGY/yodEw7aT5bXiBDjcQfWg3sTkB9g1k8+P55aPDGKNFgfTX+/aUVC1QiPNE9ZbgqHCq8h/+liwY/HIiSZWx/eHcWDd6fiAqDFQtUWinxvzyyDHPHSfRNzIRUlWHES0hq+t3i9ZeFBaqsQsFd0eCODtgai6x1WD4F/b0tVuZPv5IY4HljFLQyN9jBFlNHiAbnl+J0pnULBODzDLn4Ph74/XRkrkHeRuxdhF+9iLB+6OjQdgWuqsUnwkvWPVwxYZBE4q/8EC6OosG7EkwdGFMEC49En8rA7HBjLuzZBdGh3y5DbmjEtSIk5yA5GxdzkJSNyirz1mLzxosGzwrDZ6kSwRJdQhXUX7D4rgxnR+RukBgQEqG+Ael5OPs1Tqbh9GWzNDOz1omuNNVXwyNWSGh3ZxRuFp36PZ+Fke+qQiALV2EVBqw7qnCaWhsM8cWCiTiwFCVbcHgZZodLjDkp++93sserw4Uip4+UWDiwXR2vH6hhQdn6YygqM1fidjq8NBQ73kLRZqz7KXp2USbZXQkS00+CHSvx+quqFp9coEDfcV+PqLWoqTNvLi6OWDQJ19fjzzFwdTI1tbwSnL4sGjx+ILzcWonx80Swn2iCB5JQ9oACPVmjv7W1LTKy02HxS0hfLbFYotlK5IzwLdZgRmvTGlKTr1K71axCIABbT2POJrO/hx714E6uwM9/ZFIi/0mU6Ou16of4xFlRGU6mU6BmWqahK5FZ0BZ56bT4aJ5ct/nZ7pX4PNQQXwzs2eyvoQESOxJ3xUvMx1mXQAAu5mDoMizZJbEf1PgBDA22vNnSc1W2K9SCrFL1l2VX/6hdIAC19Vh7BC8sxMJtuFpo3rwcbE3akhZ/RWItzszRTU/k2WoxTfhUhqRsiTVJVirQQx5UY8NxBC7G8OVYc9iMJo0MwItDjby2UWYzqHdnjGmq5R4xBO7O7bL5rGqBHv/PLd2NwMXwXYCYjdh8Eqm5CjcC5v/E+Gul1iM3OTkvPmNfU4e951X3gNR7QlkLONljeB8E+yHEHyH+rY+ytPpgus5DubEzHvHvIUxsb0m5AZ6xTyyjc3HE7Y/gYCt0+f5ERK1V3bPQoR2ir0bcZcR9N5QX4IUx/fFyECb8QPRhPI6dDqP64liK8U1pQYFcHDF52BPnz70WIlFg9UxftKcqTISsImw5hcmr0XUe5v8D39yWTmFYb+Nzl9oV+lRfTLz/VVxuvOIUSJTKKvztBAa+gw3H5S707Wp8phUGiX3pEYO/bzI316xuEqn9+RTIJKpqsXCb3EmlppwCC5mxGZ0W00e20rFvOos4ld7t5/ag8eUfy7TK7UzK6/MMibN5HnW7xKcvUnMlziiiQMqQXSyxHVFj2lr9hkbsShANHuGHAC8M7iWxe3B7nHrv8/P8qQPxZUamn42yQ3JaQ3warq4ee85SoGbY8iZiwuS2LogjeJgGYNJJGo96gheuiQbPHI0ZwrsHj6WguJwCNYO/J3bOR+YazB0He1uF7fHzEA3OU+J0QfGKpnc3iVP91Fx/qaUK69sdW2ORuwHvRil2XuKiSRJGGjF09CzmOCW+tAKHL1IgMTxc8f7ryNuIQ79BlMwBb88ydQRWvCoRn3hdgfKXPcCBJIXvycfn2miRndGobipDa4PIIEQGQV+NYyk4moLTmRKrJrzc8LspWDBRomN1X4+MfGUKvyNO4S9m7FB3/QU1z4U52SMqGFHBAJBXguQcpObiyk3kl6KgFOUG6KvRCHSwh5sT/DwxwBsTB2P8QOm21IEkxab3T6ShqMzUyd1HZBYgKZsCKYGPO3zcRTdYybI7QbGk6huwOwFLX7aW1w/4yctLNxReo67UU3/oIgVSO7/do3CCmQXNHkQsxcl0M+63pEDKsDP+2xOAlUWRkRsVrl6lQE9XXr80z25G0/ve5hgRoEBKkpqLSX801+cBTB/9a/svV7ZXge5aYo/3wWSMXYXb982YhYlNabVt/moByy+qDw3AjFGIClZs+KQF7pRjxT5sOWX2jHRa3NyEbi7GXJtVhL6/bjcCaTHwPcuWoKAUx1Kw9giOpuB2GRzt4Omm/GGahffwp0OY+dc2+qpoQyN6dJL42PvjrD1iyW9ftL830LO4dcCYQIQGYEQfDOstcWxgk94cS8F/E3E8ra3XFA/xxaUPjTHPd4Flvj34/Aj0FD7uGOCNAC/06ope7vB0Q5eO6NQRHexhp4POBnUNqKmDoQYlFSi+j/xSXLuFKzeReB037oBYu0CEvTBCgQihQIQCEQpEKBAhFIhQIEKBCAUiFIgQCkQoEKFAhAIRQoEIBSIUiFAgQigQoUCEAhEKRAgFIhSIUCBCgQgFIoQCEQpEKBChQIRQIEKBCAUiFIgQCkQoEKFAhAIRQoEIBSIUiFAgQigQoUCEAhEKRCgQIRSIUCBCgQgFIoQCEQpEKBChQIRQIEKBCAUiFIgQCkQoEKFAhAIRK+b/+qwyzvY7L34AAAAASUVORK5CYII=', 'base64')
const ICON_512 = Buffer.from('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AAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAAQAAEAAAAAEAAFjS/wHfsY/suZAc7QAAAABJRU5ErkJggg==', 'base64')

function readBody(req) {
  return new Promise(resolve => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, online: onlineTotal() }))
  } else if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(SW_JS)
  } else if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' })
    res.end(MANIFEST)
  } else if (url === '/icon-192.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
    res.end(ICON_192)
  } else if (url === '/icon-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
    res.end(ICON_512)
  } else if (url === '/vapid') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ key: VAPID_PUBLIC }))
  } else if (url === '/subscribe' && req.method === 'POST') {
    const b = await readBody(req)
    if (b && b.room && b.subscription) addSub(String(b.room).slice(0, 64), b.userId || '', b.subscription)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  } else if (appHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(appHtml)
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  }
})

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  maxHttpBufferSize: 25e6, // до ~20 МБ видео
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
})

io.on('connection', (socket) => {
  let currentRoom = null
  let me = null

  socket.on('join', (p = {}) => {
    const room = String(p.room || 'general').slice(0, 64)
    const password = p.password ? String(p.password).slice(0, 64) : null
    const user = { id: p.userId || socket.id, name: String(p.name || 'Гость').slice(0, 40) }

    const occupied = roomUsers.has(room) && roomUsers.get(room).size > 0
    let meta = roomMeta.get(room)

    if (!occupied) {
      const prev = roomMeta.get(room)
      if (prev && prev.password) {
        if (prev.password !== password) {
          socket.emit('join_error', { reason: 'wrong_password' })
          return
        }
        meta = prev
      } else {
        meta = { password: password || null, adminId: password ? user.id : null }
      }
      roomMeta.set(room, meta)
    } else {
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
      dur: msg.dur,
      time: new Date().toISOString(),
    }
    const h = getHistory(currentRoom)
    h.push(entry)
    if (h.length > HISTORY_LIMIT) h.shift()
    // Защита памяти: тяжёлые медиа в истории комнаты суммарно не больше ~60 МБ
    let mediaBytes = 0
    for (const e of h) mediaBytes += (e.dataUrl ? e.dataUrl.length : 0)
    while (mediaBytes > 60e6 && h.length > 1) {
      const dropped = h.shift()
      mediaBytes -= (dropped.dataUrl ? dropped.dataUrl.length : 0)
    }
    io.to(currentRoom).emit('message', { message: entry })

    // Push тем, у кого приложение закрыто
    pushToRoom(currentRoom, me.id, {
      title: me.name + ' · ' + currentRoom,
      body: entry.msgType === 'photo' ? '📷 Фото' : entry.msgType === 'video' ? '🎬 Видео' : entry.msgType === 'voice' ? '🎤 Голосовое' : String(entry.text || 'Сообщение').slice(0, 120),
      tag: 'svchat-' + currentRoom,
      url: '/?room=' + encodeURIComponent(currentRoom)
    }).catch(() => {})
  })

  socket.on('typing', () => {
    if (!currentRoom || !me) return
    socket.to(currentRoom).emit('typing', { userId: me.id, name: me.name })
  })

  socket.on('kick', (p = {}) => {
    if (!currentRoom || !me) return
    const meta = roomMeta.get(currentRoom)
    if (!meta || meta.adminId !== me.id) return
    const targetId = String(p.targetId || '')
    if (!targetId || targetId === me.id) return
    const m = roomUsers.get(currentRoom)
    if (!m) return
    for (const [sockId, u] of m.entries()) {
      if (u.id === targetId) {
        const ts = io.sockets.sockets.get(sockId)
        if (ts) { ts.emit('kicked', { room: currentRoom }); ts.leave(currentRoom) }
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
  console.log('SVchat server (push) на порту ' + PORT)
})
