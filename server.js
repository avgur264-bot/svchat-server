/**
 * SVchat Realtime Server (Socket.IO) + Web Push
 * Комнаты (открытые/закрытые), админ, история в памяти,
 * push-уведомления когда приложение закрыто (PWA на экране «Домой»).
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { Server } = require('socket.io')
const webpush = require('web-push')

const PORT = process.env.PORT || 8080
const HISTORY_LIMIT = 500

// ── Web Push (VAPID) ─────────────────────────────────────────────────────────
// VAPID_PUBLIC — не секрет, можно хранить в коде.
// VAPID_PRIVATE — секрет: задать в Render → Environment → VAPID_PRIVATE.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BA-Yx74xj5Oa8MXYY_bN75dEEx6yE7LzL36hFRuP0S9-XpHRutcxAPfa5nLg-xMAxQ3xZ0_7QnuTU7waWYcfDW0'
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || ''
// Без приватного ключа push отключаем, но сервер должен подняться (чат важнее уведомлений)
let pushEnabled = false
if (VAPID_PRIVATE) {
  try { webpush.setVapidDetails('mailto:admin@svchat.app', VAPID_PUBLIC, VAPID_PRIVATE); pushEnabled = true }
  catch (e) { console.error('[push] неверный VAPID-ключ, push отключён:', e.message) }
} else {
  console.warn('[push] VAPID_PRIVATE не задан — push-уведомления отключены (задайте env VAPID_PRIVATE)')
}

// room -> Map<endpoint, { sub, userId }>
const pushSubs = new Map()
// userId -> Map<endpoint, sub>: индекс для O(1)-поиска подписок пользователя (pushToUser)
const userSubs = new Map()
function indexSub(userId, endpoint, sub) {
  const u = String(userId || '')
  if (!u || !endpoint || !sub) return
  if (!userSubs.has(u)) userSubs.set(u, new Map())
  userSubs.get(u).set(endpoint, sub)
}
function unindexSub(userId, endpoint) {
  const u = String(userId || '')
  const s = userSubs.get(u)
  if (!s) return
  s.delete(endpoint)
  if (!s.size) userSubs.delete(u)
}
function addSub(room, userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || sub.endpoint.length > 500) return
  if (!pushSubs.has(room)) pushSubs.set(room, new Map())
  pushSubs.get(room).set(sub.endpoint, { sub, userId })
  indexSub(userId, sub.endpoint, sub)
}
async function pushToRoom(room, exceptUserId, payload) {
  if (!pushEnabled) return
  const m = pushSubs.get(room)
  if (!m) return
  const online = onlineIdsIn(room)
  const data = JSON.stringify(payload)
  // Рассылаем параллельно: одна «мёртвая» подписка не задерживает остальные
  await Promise.all([...m.entries()].map(async ([endpoint, { sub, userId }]) => {
    if (online.has(String(userId))) return // приложение открыто в этой комнате — push не нужен
    if (userId === exceptUserId) return
    try {
      await webpush.sendNotification(sub, data, { TTL: 60 })
    } catch (e) {
      const code = e && e.statusCode
      if (code === 400 || code === 403 || code === 404 || code === 410) { m.delete(endpoint); unindexSub(userId, endpoint); dbDelSub(endpoint) } // подписка умерла
    }
  }))
}

const history = new Map()
const roomMembers = new Map() // room -> Map<userId, {name, lastSeen}> — все, кто когда-либо заходил
const roomReads = new Map()   // room -> Map<userId, ISO-время последнего прочитанного>
const roomDelivs = new Map()  // room -> Map<userId, ISO-время последнего доставленного на устройство>
const roomUsers = new Map()
const roomMeta = new Map()
const userAuth = new Map() // userId -> Set<sha256(token)>: привязанные устройства аккаунта (мульти-устройство)
const OWNER_KEY = process.env.OWNER_KEY || '' // секрет владельца (Render env); пусто = функция выключена
const CLIENT_BUILD = 168 // номер актуальной клиентской сборки (index.html) для авто-обновления
const hiddenUsers = new Set() // userId, скрытые из общего справочника
const liveOnline = new Map() // userId -> Set(socketId): присутствие в приложении (как в Telegram)
const EMPTY_SET = new Set()
const dirRemoved = new Set() // userId, удалённые владельцем из справочника (дубликаты)
const seenAt = new Map() // userId -> ISO: время последнего выхода
const readHidden = new Set() // userId: скрывает статус прочтения (реципрокно, кроме владельца)
const owners = new Set() // userId владельцев (права админа во всех группах)
const pubKeys = new Map() // userId -> публичный ключ ECDH (для E2E личных чатов)
function isOwner(uid){ return !!uid && owners.has(uid) }
function hashTok(t){ return crypto.createHash('sha256').update(String(t)).digest('hex') }
// Мульти-устройство: аккаунт может иметь несколько привязанных токенов (по одному на устройство).
// Владельцем считается любой, чей токен есть в наборе; если набор пуст — id ещё не занят (TOFU).
const MAX_DEVICES = 12
function ownsUid(userId, token){ const set = userAuth.get(userId); if (!set || set.size === 0) return true; return !!token && set.has(hashTok(token)) }
// Привязать токен устройства к аккаунту (добавляет, не заменяет — чтобы другие устройства не отваливались)
function addAuth(userId, token){
  if (!token) return
  const th = hashTok(token)
  let set = userAuth.get(userId); if (!set) { set = new Set(); userAuth.set(userId, set) }
  if (set.has(th)) return
  if (set.size >= MAX_DEVICES) { const oldest = set.values().next().value; set.delete(oldest); dbDelAuthTok(userId, oldest) }
  set.add(th); dbSaveAuth(userId, th)
}
const accounts = new Map()      // nick_key -> {nick, userId, passHash}: уникальные ники
const accountByUid = new Map()  // userId -> nick_key
function nickKey(s){ return String(s || '').trim().toLowerCase() }

// ── База данных (Этап 2): Postgres через DATABASE_URL ────────────────────────
// Если переменная не задана — сервер работает как раньше (всё в памяти).
let pool = null
const DB_URL = process.env.DATABASE_URL || ''
if (DB_URL) {
  try {
    const { Pool } = require('pg')
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('.render.com') ? { rejectUnauthorized: false } : false,
      max: 5,
    })
    pool.on('error', e => console.error('[db] ошибка пула:', e.message))
  } catch (e) { console.error('[db] модуль pg недоступен:', e.message) }
} else {
  console.log('[db] DATABASE_URL не задан — режим памяти (история сотрётся при деплое)')
}

const dbReady = (async () => {
  if (!pool) return false
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_rooms (
      room TEXT PRIMARY KEY, password TEXT, admin_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_messages (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, entry JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`)
    await pool.query(`CREATE INDEX IF NOT EXISTS svchat_messages_room_idx ON svchat_messages (room, created_at)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_push (
      endpoint TEXT PRIMARY KEY, room TEXT NOT NULL, user_id TEXT, sub JSONB NOT NULL)`)
    const rooms = await pool.query(`SELECT room, password, admin_id FROM svchat_rooms`)
    for (const r of rooms.rows) roomMeta.set(r.room, { password: r.password, adminId: r.admin_id })
    const subs = await pool.query(`SELECT endpoint, room, user_id, sub FROM svchat_push`)
    for (const r of subs.rows) {
      if (!pushSubs.has(r.room)) pushSubs.set(r.room, new Map())
      pushSubs.get(r.room).set(r.endpoint, { sub: r.sub, userId: r.user_id })
      indexSub(r.user_id, r.endpoint, r.sub)
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_members (
      room TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, last_seen TIMESTAMPTZ DEFAULT now(), photo TEXT,
      PRIMARY KEY (room, user_id))`)
    await pool.query(`ALTER TABLE svchat_members ADD COLUMN IF NOT EXISTS photo TEXT`)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_reads (
      room TEXT NOT NULL, user_id TEXT NOT NULL, ts TEXT,
      PRIMARY KEY (room, user_id))`)
    const mems = await pool.query(`SELECT room, user_id, name, last_seen, photo FROM svchat_members`)
    for (const r of mems.rows) {
      if (!roomMembers.has(r.room)) roomMembers.set(r.room, new Map())
      roomMembers.get(r.room).set(r.user_id, { name: r.name, lastSeen: r.last_seen, photo: r.photo || null })
    }
    const reads = await pool.query(`SELECT room, user_id, ts FROM svchat_reads`)
    for (const r of reads.rows) {
      if (!roomReads.has(r.room)) roomReads.set(r.room, new Map())
      roomReads.get(r.room).set(r.user_id, r.ts)
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_delivs (
      room TEXT NOT NULL, user_id TEXT NOT NULL, ts TEXT,
      PRIMARY KEY (room, user_id))`)
    const delivs = await pool.query(`SELECT room, user_id, ts FROM svchat_delivs`)
    for (const r of delivs.rows) {
      if (!roomDelivs.has(r.room)) roomDelivs.set(r.room, new Map())
      roomDelivs.get(r.room).set(r.user_id, r.ts)
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_auth (user_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL)`)
    // Мульти-устройство: набор токенов на аккаунт. Мигрируем старую одно-токенную таблицу.
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_authtok (user_id TEXT NOT NULL, token_hash TEXT NOT NULL, PRIMARY KEY (user_id, token_hash))`)
    await pool.query(`INSERT INTO svchat_authtok (user_id, token_hash) SELECT user_id, token_hash FROM svchat_auth ON CONFLICT DO NOTHING`)
    const authRows = await pool.query(`SELECT user_id, token_hash FROM svchat_authtok`)
    for (const r of authRows.rows) { let s = userAuth.get(r.user_id); if (!s) { s = new Set(); userAuth.set(r.user_id, s) } s.add(r.token_hash) }
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_accounts (nick_key TEXT PRIMARY KEY, nick TEXT NOT NULL, user_id TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`)
    const accRows = await pool.query(`SELECT nick_key, nick, user_id, pass_hash FROM svchat_accounts`)
    for (const r of accRows.rows) { accounts.set(r.nick_key, { nick: r.nick, userId: r.user_id, passHash: r.pass_hash }); accountByUid.set(r.user_id, r.nick_key) }
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_keys (user_id TEXT PRIMARY KEY, pub TEXT NOT NULL)`)
    const keyRows = await pool.query(`SELECT user_id, pub FROM svchat_keys`)
    for (const r of keyRows.rows) pubKeys.set(r.user_id, r.pub)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_hidden (user_id TEXT PRIMARY KEY)`)
    const hidRows = await pool.query(`SELECT user_id FROM svchat_hidden`)
    for (const r of hidRows.rows) hiddenUsers.add(r.user_id)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_seen (user_id TEXT PRIMARY KEY, ts TEXT NOT NULL)`)
    const seenRows = await pool.query(`SELECT user_id, ts FROM svchat_seen`)
    for (const r of seenRows.rows) seenAt.set(r.user_id, r.ts)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_readhide (user_id TEXT PRIMARY KEY)`)
    const rhRows = await pool.query(`SELECT user_id FROM svchat_readhide`)
    for (const r of rhRows.rows) readHidden.add(r.user_id)
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_dirremoved (user_id TEXT PRIMARY KEY)`)
    const drRows = await pool.query(`SELECT user_id FROM svchat_dirremoved`)
    for (const r of drRows.rows) dirRemoved.add(r.user_id)
    console.log('[db] готово: комнат', rooms.rowCount, '· push-подписок', subs.rowCount, '· участников', mems.rowCount)
    return true
  } catch (e) {
    console.error('[db] инициализация не удалась, режим памяти:', e.message)
    pool = null
    return false
  }
})()

// Одноразовое фоновое восстановление участников из истории (НЕ блокирует входы)
async function backfillMembers() {
  if (!pool) return
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS svchat_meta (key TEXT PRIMARY KEY, value TEXT)`)
    const done = await pool.query(`SELECT value FROM svchat_meta WHERE key = 'members_backfill'`)
    if (done.rowCount > 0) return
    console.log('[backfill] восстанавливаю участников из истории (в фоне)...')
    const hist = await pool.query(
      `SELECT room, entry->>'from' AS uid, entry->>'fromName' AS uname, max(created_at) AS last_ts
       FROM svchat_messages
       WHERE entry->>'from' IS NOT NULL
       GROUP BY room, entry->>'from', entry->>'fromName'`)
    let added = 0
    for (const r of hist.rows) {
      if (!r.uid || r.room.startsWith('dm:')) continue
      if (!roomMembers.has(r.room)) roomMembers.set(r.room, new Map())
      const reg = roomMembers.get(r.room)
      if (!reg.has(r.uid)) {
        const seen = r.last_ts ? new Date(r.last_ts).toISOString() : new Date().toISOString()
        reg.set(r.uid, { name: r.uname || r.uid, lastSeen: seen })
        await pool.query(
          `INSERT INTO svchat_members (room, user_id, name, last_seen) VALUES ($1, $2, $3, $4)
           ON CONFLICT (room, user_id) DO NOTHING`,
          [r.room, r.uid, r.uname || r.uid, seen])
        added++
        // живым комнатам сразу обновляем панель
        try { broadcastMembers(r.room) } catch {}
      }
    }
    await pool.query(`INSERT INTO svchat_meta (key, value) VALUES ('members_backfill', '1')
                      ON CONFLICT (key) DO NOTHING`)
    console.log('[backfill] готово, восстановлено участников:', added)
  } catch (e) { console.error('[backfill] ошибка (не критично):', e.message) }
}
dbReady.then(ok => { if (ok) setTimeout(() => backfillMembers(), 3000) })

async function dbSaveAuth(userId, tokenHash) {
  if (!pool) return
  try {
    await pool.query(`INSERT INTO svchat_authtok (user_id, token_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, tokenHash])
  } catch (e) { console.error('[db] auth:', e.message) }
}
async function dbDelAuthTok(userId, tokenHash) {
  if (!pool) return
  try { await pool.query(`DELETE FROM svchat_authtok WHERE user_id = $1 AND token_hash = $2`, [userId, tokenHash]) } catch (e) { console.error('[db] authtok del:', e.message) }
}
async function dbSaveDirRemoved(userId) {
  if (!pool) return
  try { await pool.query(`INSERT INTO svchat_dirremoved (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]) } catch (e) { console.error('[db] dirremoved:', e.message) }
}
async function dbSaveReadHide(userId, hidden) {
  if (!pool) return
  try {
    if (hidden) await pool.query(`INSERT INTO svchat_readhide (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId])
    else await pool.query(`DELETE FROM svchat_readhide WHERE user_id = $1`, [userId])
  } catch (e) { console.error('[db] readhide:', e.message) }
}
async function dbSaveSeen(userId, ts) {
  if (!pool) return
  try { await pool.query(`INSERT INTO svchat_seen (user_id, ts) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET ts = EXCLUDED.ts`, [userId, ts]) } catch (e) { console.error('[db] seen:', e.message) }
}
async function dbSaveHidden(userId, hidden) {
  if (!pool) return
  try {
    if (hidden) await pool.query(`INSERT INTO svchat_hidden (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId])
    else await pool.query(`DELETE FROM svchat_hidden WHERE user_id = $1`, [userId])
  } catch (e) { console.error('[db] hidden:', e.message) }
}
async function dbSaveKey(userId, pub) {
  if (!pool) return
  try {
    await pool.query(`INSERT INTO svchat_keys (user_id, pub) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET pub = EXCLUDED.pub`, [userId, pub])
  } catch (e) { console.error('[db] key:', e.message) }
}
async function dbSaveAccount(key, nick, userId, passHash) {
  if (!pool) return
  try {
    await pool.query(`INSERT INTO svchat_accounts (nick_key, nick, user_id, pass_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (nick_key) DO UPDATE SET nick = EXCLUDED.nick, user_id = EXCLUDED.user_id, pass_hash = EXCLUDED.pass_hash`, [key, nick, userId, passHash])
  } catch (e) { console.error('[db] account:', e.message) }
}
async function dbDelAccount(key, userId) {
  if (!pool) return
  try {
    await pool.query(`DELETE FROM svchat_accounts WHERE nick_key = $1`, [key])
    await pool.query(`DELETE FROM svchat_auth WHERE user_id = $1`, [userId])
    await pool.query(`DELETE FROM svchat_authtok WHERE user_id = $1`, [userId])
  } catch (e) { console.error('[db] account del:', e.message) }
}
function releaseAccount(uid) {
  const key = accountByUid.get(uid)
  if (!key) return
  accounts.delete(key); accountByUid.delete(uid); userAuth.delete(uid)
  dbDelAccount(key, uid)
}
async function dbSaveRoom(room, meta) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO svchat_rooms (room, password, admin_id) VALUES ($1, $2, $3)
       ON CONFLICT (room) DO UPDATE SET password = EXCLUDED.password, admin_id = EXCLUDED.admin_id`,
      [room, meta.password || null, meta.adminId || null])
  } catch (e) { console.error('[db] комната:', e.message) }
}
const PRUNE_EVERY = 25 // как часто (раз в N вставок на комнату) подчищать старые сообщения
const msgInserts = new Map() // room -> счётчик вставок с последней чистки
async function dbSaveMsg(room, entry) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO svchat_messages (id, room, entry) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [entry.id, room, entry])
    // Чистим хвост не на каждое сообщение, а пачками — тяжёлый DELETE с подзапросом реже бьёт по БД
    const n = (msgInserts.get(room) || 0) + 1
    if (n >= PRUNE_EVERY) {
      msgInserts.set(room, 0)
      await pool.query(
        `DELETE FROM svchat_messages WHERE room = $1 AND id IN (
           SELECT id FROM svchat_messages WHERE room = $1 ORDER BY created_at DESC OFFSET $2)`,
        [room, HISTORY_LIMIT])
    } else {
      msgInserts.set(room, n)
    }
  } catch (e) { console.error('[db] сообщение:', e.message) }
}
async function dbUpdateMsg(room, entry) {
  if (!pool) return
  try {
    await pool.query(`UPDATE svchat_messages SET entry = $3 WHERE room = $1 AND id = $2`,
      [room, entry.id, entry])
  } catch (e) { console.error('[db] обновление сообщения:', e.message) }
}
async function dbLoadHistory(room) {
  if (!pool) return null
  try {
    const r = await pool.query(
      `SELECT entry FROM (
         SELECT entry, created_at FROM svchat_messages WHERE room = $1 ORDER BY created_at DESC LIMIT $2
       ) t ORDER BY created_at ASC`,
      [room, HISTORY_LIMIT])
    return r.rows.map(x => x.entry)
  } catch (e) { console.error('[db] история:', e.message); return null }
}
async function dbGetMsg(room, id) {
  if (!pool) return null
  try {
    const r = await pool.query(`SELECT entry FROM svchat_messages WHERE room = $1 AND id = $2 LIMIT 1`, [room, id])
    return r.rows[0] ? r.rows[0].entry : null
  } catch (e) { return null }
}
async function dbSaveSub(room, userId, sub) {
  if (!pool || !sub || !sub.endpoint) return
  try {
    await pool.query(
      `INSERT INTO svchat_push (endpoint, room, user_id, sub) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET room = EXCLUDED.room, user_id = EXCLUDED.user_id, sub = EXCLUDED.sub`,
      [sub.endpoint, room, userId || '', sub])
  } catch (e) { console.error('[db] подписка:', e.message) }
}
async function dbDelSub(endpoint) {
  if (!pool) return
  try { await pool.query(`DELETE FROM svchat_push WHERE endpoint = $1`, [endpoint]) } catch {}
}

async function dbSaveMember(room, userId, name, photo) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO svchat_members (room, user_id, name, last_seen, photo) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (room, user_id) DO UPDATE SET name = $3, last_seen = now(), photo = COALESCE($4, svchat_members.photo)`,
      [room, userId, name, photo || null])
  } catch (e) { console.error('[db] member:', e.message) }
}

async function dbDelMember(room, userId) {
  if (!pool) return
  try { await pool.query(`DELETE FROM svchat_members WHERE room = $1 AND user_id = $2`, [room, userId]) } catch {}
}

async function dbSaveRead(room, userId, ts) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO svchat_reads (room, user_id, ts) VALUES ($1, $2, $3)
       ON CONFLICT (room, user_id) DO UPDATE SET ts = $3`,
      [room, userId, ts])
  } catch (e) { console.error('[db] read:', e.message) }
}

async function dbSaveDeliv(room, userId, ts) {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO svchat_delivs (room, user_id, ts) VALUES ($1, $2, $3)
       ON CONFLICT (room, user_id) DO UPDATE SET ts = $3`,
      [room, userId, ts])
  } catch (e) { console.error('[db] deliv:', e.message) }
}

// Полный список участников комнаты: и онлайн, и не в сети
function memberList(room) {
  const meta = roomMeta.get(room)
  const adminId = meta && meta.adminId
  const onlineIds = new Set()
  const m = roomUsers.get(room)
  if (m) for (const u of m.values()) onlineIds.add(String(u.id))
  const out = []
  const reg = roomMembers.get(room)
  if (reg) for (const [id, rec] of reg.entries()) {
    // lastSeen: берём самое свежее из времени в этой комнате и глобального последнего выхода (seenAt)
    const gs = seenAt.get(String(id))
    const ls = (gs && (!rec.lastSeen || gs > rec.lastSeen)) ? gs : (rec.lastSeen || null)
    const appOn = (liveOnline.get(String(id)) || EMPTY_SET).size > 0
    out.push({ id, name: rec.name, online: onlineIds.has(String(id)), appOnline: appOn, isAdmin: adminId === id, lastSeen: ls, photo: rec.photo || null })
  }
  // онлайн-пользователи, которых ещё нет в реестре (режим памяти без базы)
  if (m) for (const u of m.values()) {
    if (!reg || !reg.has(String(u.id))) out.push({ id: u.id, name: u.name, online: true, appOnline: true, isAdmin: adminId === u.id, lastSeen: null, photo: u.photo || null })
  }
  out.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'ru'))
  return out
}

function onlineIdsIn(room) {
  const out = new Set()
  const m = roomUsers.get(room)
  if (m) for (const u of m.values()) out.add(String(u.id))
  return out
}

function touchMember(room, user) {
  if (!roomMembers.has(room)) roomMembers.set(room, new Map())
  const prev = roomMembers.get(room).get(String(user.id))
  const photo = (user.photo || (prev && prev.photo)) || null
  roomMembers.get(room).set(String(user.id), { name: user.name, lastSeen: new Date().toISOString(), photo })
  dbSaveMember(room, String(user.id), user.name, photo)
}

function broadcastMembers(room) {
  io.to(room).emit('members', { members: memberList(room) })
}
// При смене присутствия (онлайн/офлайн) обновляем шапки личных чатов этого пользователя
function broadcastPresenceToDms(uid) {
  uid = String(uid || '')
  if (!uid) return
  for (const [room, reg] of roomMembers.entries()) {
    if (room.startsWith('dm:') && reg.has(uid)) broadcastMembers(room)
  }
}

const HISTORY_INIT = 30 // сколько сообщений отдаём при входе
function liteEntry(e) {
  if (!e || !e.dataUrl) return e
  const c = Object.assign({}, e)
  delete c.dataUrl
  c.media = 1
  return c
}
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
// ── Личные чаты (Этап 3) ─────────────────────────────────────────────────────
function isDm(room) { return typeof room === 'string' && room.startsWith('dm:') }

// ── Безопасность паролей: scrypt с солью, формат "scrypt$<соль>$<хеш>" ──
// Асинхронный scrypt, чтобы тяжёлый хеш не блокировал event loop (вход/логин).
const scryptAsync = require('util').promisify(crypto.scrypt)
async function hashPassword(plain) {
  if (!plain) return null
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = (await scryptAsync(String(plain), salt, 32)).toString('hex')
  return 'scrypt$' + salt + '$' + hash
}
async function verifyPassword(plain, stored) {
  if (!stored) return !plain
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$')
    const calc = (await scryptAsync(String(plain || ''), salt, 32)).toString('hex')
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(calc, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  // Совместимость: старые комнаты с паролем в открытом виде
  return stored === plain
}
// Вход в КОМНАТУ: принимаем и сам пароль, и его сохранённый хеш.
// Хеш отдаётся синхронизированным участникам в my_rooms — это их «пропуск».
// Без этого после потери локального пароля (например, при пересоздании ярлыка/закладки)
// участник не может войти в свою же закрытую группу.
async function verifyRoomPass(plain, stored) {
  if (!stored) return !plain
  if (plain && plain === stored) return true
  return verifyPassword(plain, stored)
}
function dmMembers(room) {
  const p = String(room).split(':')
  return p.length === 3 && p[1] && p[2] ? [p[1], p[2]] : null
}
function dmRoomId(a, b) {
  const ids = [String(a), String(b)].sort()
  return 'dm:' + ids[0] + ':' + ids[1]
}
// Push конкретному человеку по userId — ищем его подписки во всех комнатах
async function pushToUser(userId, payload) {
  if (!pushEnabled) return
  const u = userSubs.get(String(userId))
  if (!u || !u.size) return
  const data = JSON.stringify(payload)
  // Подписки берём из индекса напрямую, без перебора всех комнат
  await Promise.all([...u.entries()].map(async ([endpoint, sub]) => {
    try { await webpush.sendNotification(sub, data) } catch (e) {
      const code = e && e.statusCode
      if (code === 400 || code === 403 || code === 404 || code === 410) { unindexSub(userId, endpoint); dbDelSub(endpoint) } // мёртвый endpoint самоочистится из комнат при pushToRoom
    }
  }))
}

function onlineTotal() {
  return [...roomUsers.values()].reduce((n, m) => n + m.size, 0)
}

// ── Статика: приложение, service worker, манифест, иконки ───────────────────
let appHtml = null
try { appHtml = fs.readFileSync(path.join(__dirname, 'index.html')) } catch {}
let appHtmlGz = null
try { if (appHtml) appHtmlGz = zlib.gzipSync(appHtml) } catch {}
// ETag по содержимому: повторные загрузки получают 304 без перекачки ~100КБ
const appHtmlEtag = appHtml ? '"' + crypto.createHash('sha256').update(appHtml).digest('hex').slice(0, 16) + '"' : null
// Brotli (меньше gzip на ~18%) считаем асинхронно, чтобы не задерживать старт сервера
let appHtmlBr = null
if (appHtml) zlib.brotliCompress(appHtml, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }, (e, out) => { if (!e) appHtmlBr = out })

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
    tag: d.room ? 'svchat-' + d.room : (d.tag || 'svchat'),
    renotify: true,
    data: { url: d.url || '/', room: d.room || '' }
  }
  const doBump = () => new Promise(res => {
    try {
      const r = indexedDB.open('svbadge', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('s')
      r.onsuccess = () => {
        try {
          const tx = r.result.transaction('s', 'readwrite'), st = tx.objectStore('s'), g = st.get('n')
          g.onsuccess = () => {
            const n = (g.result || 0) + 1
            st.put(n, 'n')
            tx.oncomplete = () => { try { self.navigator.setAppBadge && self.navigator.setAppBadge(n) } catch {} res() }
            tx.onerror = () => res()
          }
          g.onerror = () => res()
        } catch { res() }
      }
      r.onerror = () => res()
    } catch { res() }
  })
  e.waitUntil((async () => {
    let fg = false
    try {
      const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      fg = cl.some(c => c.focused || c.visibilityState === 'visible')
    } catch (e) {}
    if (fg) return // приложение открыто и активно — не беспокоим
    await doBump()
    await self.registration.showNotification(title, opts)
  })())
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  const room = (e.notification.data && e.notification.data.room) || ''
  // Сброс бейджа при клике
  try {
    const r = indexedDB.open('svbadge', 1)
    r.onsuccess = () => { try { r.result.transaction('s','readwrite').objectStore('s').put(0,'n') } catch {} }
  } catch {}
  try { self.navigator.clearAppBadge && self.navigator.clearAppBadge() } catch {}
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      try {
        await c.focus()
        c.postMessage({ type: 'open-room', url, room })
        return
      } catch {}
    }
    await self.clients.openWindow(url)
  })())
})
`


function isTrustedOrigin(req) {
  const origin = req.headers['origin'] || ''
  const referer = req.headers['referer'] || ''
  const src = origin || referer
  if (!src) return true
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(src) ||
    /svchat-server\.onrender\.com/.test(src) ||
    /svchat24\.ru/.test(src)
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } })
  })
}

// ── Иконки приложения (зашиты в код, чтобы жить в одном файле) ──
const ICONS = {
  '512': Buffer.from('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', 'base64'),
  '192': Buffer.from('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', 'base64'),
  '180': Buffer.from('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', 'base64'),
  '152': Buffer.from('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', 'base64'),
}
const MANIFEST = JSON.stringify({
  name: 'SVchat', short_name: 'SVchat', start_url: '/', scope: '/',
  display: 'standalone', background_color: '#0b50e0', theme_color: '#0b50e0',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
})
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, online: onlineTotal(), db: !!pool, push: pushEnabled, subs: [...pushSubs.values()].reduce((n, m) => n + m.size, 0) }))
  } else if (url === '/diag') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'sha256-X6oK9y5ylEdf4IYfPBkHtHzmC+2TGXysO6K6AOYj0bc=' 'sha256-Teo6bznhpC673bmFeNM+9sYI/kpWB9hnLsujc8XF8wo=' 'sha256-EPWGZOZfEBu49JDq/HQJ4LoLtGdLiVqUMs3AbSFQ+aY=' 'sha256-O2f3zsK7kBCYSt0KF3+gEirrV/EXQXpmtibD5mWOeEA=' 'sha256-RrJCSws2CH5usRS3o35JllpWHU18qUVj9FawGU7R+gg='; style-src 'unsafe-inline'; connect-src 'self' wss: https: blob: data:" })
    res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SVchat диагностика</title><style>body{font:17px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#0b1020;color:#fff}h1{font-size:19px}#log div{padding:9px 11px;margin:7px 0;border-radius:10px;background:#1b2440;word-break:break-word}.ok{background:#0f5132 !important}.err{background:#842029 !important}.big{font-size:20px;font-weight:700}</style></head><body><h1>SVchat — диагностика связи</h1><div id="log"></div><script src="/socket.io/socket.io.js"></script><script>
var L=document.getElementById('log');
function add(t,c){var d=document.createElement('div');d.textContent=t;if(c)d.className=c;L.appendChild(d);}
var prof=null,tok='';
try{prof=JSON.parse(localStorage.getItem('svchat_profile')||'null')}catch(_){}
try{tok=localStorage.getItem('svchat_token')||''}catch(_){}
if(!prof){add('⚠️ На этом устройстве вход НЕ выполнен (нет профиля). Открой эту страницу там, где ты залогинен.','err');}
else{add('Аккаунт на этом устройстве: '+(prof.name||'?'));add('userId: '+(prof.id||'?'));}
if(typeof io==='undefined'){add('❌ Socket.IO не загрузился','err');}
else{
  var s=io({transports:['polling'],reconnection:false});
  var done=false,to=setTimeout(function(){if(!done){done=true;add('⏱ Таймаут подключения','err');}},18000);
  s.on('connect_error',function(e){if(done)return;done=true;clearTimeout(to);add('❌ Ошибка подключения: '+(e&&e.message?e.message:e),'err');});
  s.on('connect',function(){if(done)return;done=true;clearTimeout(to);add('✅ Подключено к серверу','ok');
    if(!prof){return;}
    add('Спрашиваю сервер: какие комнаты у этого аккаунта...');
    s.timeout(12000).emit('my_rooms',{userId:prof.id,auth:tok},function(err,res){
      if(err){add('❌ my_rooms ошибка/таймаут: '+err,'err');return;}
      if(!res||!res.ok){add('❌ Отказ: '+((res&&res.reason)||'?')+((res&&res.reason==='forbidden')?' — этот userId принадлежит другому токену (на этом устройстве другой/новый аккаунт)':''),'err');return;}
      add('✅ Комнат на сервере у этого аккаунта: '+res.rooms.length,'ok big');
      res.rooms.forEach(function(r){add(r.dm?('• Личный чат с: '+(r.peer||'?')):('• Группа: '+r.room));});
      if(!res.rooms.length){add('Похоже, это НЕ тот аккаунт, где 8 чатов. Нужно войти под ником основного аккаунта (с паролем).','err');}
    });
  });
}
</script></body></html>`)
  } else if (url === '/presence') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    const online = []
    for (const [uid, set] of liveOnline.entries()) if (set && set.size > 0) online.push(uid)
    res.end(JSON.stringify({ online }))
  } else if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(SW_JS)
  } else if (url === '/vapid') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ key: VAPID_PUBLIC }))
  } else if (url.startsWith('/icons/icon-') || url === '/icon-192.png' || url === '/apple-touch-icon.png' || url === '/apple-touch-icon-precomposed.png') {
    const m = url.match(/icon-(\d+)/)
    const sz = m && ICONS[m[1]] ? m[1] : '180'
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
    res.end(ICONS[sz])
  } else if (url === '/manifest.json' || url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' })
    res.end(MANIFEST)
  } else if (url === '/remove_contact' && req.method === 'POST') {
    if (!isTrustedOrigin(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'forbidden' })); return }
    const b = await readBody(req)
    const owner = b && b.owner ? String(b.owner) : ''
    const uid = String((b && b.userId) || '').slice(0, 80)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    if (!OWNER_KEY || owner !== OWNER_KEY) { res.end(JSON.stringify({ ok: false, reason: 'not_owner' })); return }
    if (uid) { dirRemoved.add(uid); dbSaveDirRemoved(uid) }
    res.end(JSON.stringify({ ok: !!uid }))
  } else if (url === '/set_password' && req.method === 'POST') {
    if (!isTrustedOrigin(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'forbidden' })); return }
    await dbReady
    const b = await readBody(req)
    const password = String((b && b.password) || '')
    const token = b && b.auth ? String(b.auth).slice(0, 128) : ''
    const userId = String((b && b.userId) || '').slice(0, 80)
    const nick = String((b && b.nick) || '').trim().slice(0, 40)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    if (!userId || nick.length < 2 || password.length < 4) { res.end(JSON.stringify({ ok: false, reason: 'bad_input' })); return }
    if (!ownsUid(userId, token)) { res.end(JSON.stringify({ ok: false, reason: 'id_taken' })); return }
    const myKey = accountByUid.get(userId)
    if (myKey && accounts.get(myKey)) {
      const acc = accounts.get(myKey); const passHash = await hashPassword(password)
      acc.passHash = passHash; dbSaveAccount(myKey, acc.nick, userId, passHash)
      if (token) addAuth(userId, token)
      res.end(JSON.stringify({ ok: true, userId, nick: acc.nick, changed: true })); return
    }
    const key = nickKey(nick)
    const existing = accounts.get(key)
    if (existing && existing.userId !== userId) { res.end(JSON.stringify({ ok: false, reason: 'nick_taken' })); return }
    const passHash = await hashPassword(password)
    accounts.set(key, { nick, userId, passHash }); accountByUid.set(userId, key)
    dbSaveAccount(key, nick, userId, passHash)
    if (token) addAuth(userId, token)
    res.end(JSON.stringify({ ok: true, userId, nick }))
  } else if (url === '/pubkey' && req.method === 'POST') {
    const b = await readBody(req)
    const id = String((b && b.id) || '').slice(0, 80)
    const pub = String((b && b.pub) || '').slice(0, 1000)
    if (id && pub) { pubKeys.set(id, pub); dbSaveKey(id, pub) }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: !!(id && pub) }))
  } else if (url === '/pubkey') {
    const q = new URLSearchParams((req.url || '').split('?')[1] || '')
    const id = String(q.get('id') || '').slice(0, 80)
    const pub = id ? pubKeys.get(id) : null
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(pub ? { ok: true, pub } : { ok: false }))
  } else if (url === '/users') {
    await dbReady
    const qp = new URLSearchParams((req.url || '').split('?')[1] || '')
    const meId = String(qp.get('me') || '')
    const showHidden = !!OWNER_KEY && qp.get('owner') === OWNER_KEY
    const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')
    const byKey = new Map()
    const addUser = (uid, nm, ls, isAccount) => {
      const id = String(uid || '')
      const nme = String(nm || '').trim()
      if (!id || !nme || id === meId) return
      if (id.indexOf('u-e2e-') === 0) return // тестовые аккаунты из автотестов — не показывать в справочнике
      if (dirRemoved.has(id)) return
      const hid = hiddenUsers.has(id)
      if (hid && !showHidden) return
      const key = norm(nme) || nme.toLowerCase()
      const isOn = liveOnline.has(id) && liveOnline.get(id).size > 0
      const prev = byKey.get(key)
      if (!prev) { byKey.set(key, { id, name: nme, online: isOn, hidden: hid, lastSeen: ls || null, acct: !!isAccount }); return }
      // Зарегистрированный аккаунт всегда задаёт ID для имени; дубли-«гости» его не перебивают
      if (isAccount && !prev.acct) { prev.id = id; prev.acct = true }
      if (isOn) { if (!prev.acct && !prev.online) prev.id = id; prev.online = true }
      if (ls && (!prev.lastSeen || ls > prev.lastSeen)) prev.lastSeen = ls
    }
    for (const a of accounts.values()) addUser(a.userId, a.nick, null, true)
    for (const m of roomMembers.values()) for (const [uid, info] of m.entries()) addUser(uid, info && info.name, info && info.lastSeen, false)
    const list = [...byKey.values()].map(v => ({ id: v.id, name: v.name, hidden: v.hidden, online: v.online, lastSeen: seenAt.get(v.id) || v.lastSeen || null })).slice(0, 500)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, users: list }))
  } else if (url === '/stats') {
    const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')
    const keys = new Set()
    const add = nm => { const k = norm(nm); if (k) keys.add(k) }
    for (const a of accounts.values()) { if (!dirRemoved.has(String(a.userId))) add(a.nick) }
    for (const m of roomMembers.values()) for (const [uid, info] of m.entries()) { if (!dirRemoved.has(String(uid))) add(info && info.name) }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, users: keys.size, online: (io && io.engine ? io.engine.clientsCount : 0), ver: CLIENT_BUILD, client: CLIENT_BUILD }))
  } else if (url === '/find') {
    const q = new URLSearchParams((req.url || '').split('?')[1] || '')
    const nick = String(q.get('nick') || '').trim()
    const acc = nick.length >= 2 ? accounts.get(nickKey(nick)) : null
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(acc ? { ok: true, userId: acc.userId, nick: acc.nick } : { ok: false }))
  } else if (url === '/ice') {
    const u = process.env.TURN_USERNAME
    const c = process.env.TURN_CREDENTIAL
    const iceServers = [{ urls: 'stun:stun.relay.metered.ca:80' }]
    if (u && c) {
      iceServers.push(
        { urls: 'turn:standard.relay.metered.ca:80', username: u, credential: c },
        { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: u, credential: c },
        { urls: 'turn:standard.relay.metered.ca:443', username: u, credential: c },
        { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: u, credential: c })
    } else {
      iceServers.push({ urls: 'stun:stun.l.google.com:19302' })
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ iceServers }))
  } else if (url === '/summary' && req.method === 'POST') {
    const b = await readBody(req)
    const meId = String((b && b.me) || '').slice(0, 80)
    const rooms = Array.isArray(b && b.rooms) ? b.rooms.slice(0, 100) : []
    const summary = {}
    // Считаем комнаты параллельно, а не последовательным циклом запросов
    await Promise.all(rooms.map(async it => {
      const room = String((it && it.room) || '').slice(0, 64)
      if (!room) return
      const since = String((it && it.since) || '')
      let count = 0
      if (pool) {
        try {
          const r = await pool.query(`SELECT count(*)::int AS c FROM svchat_messages WHERE room = $1 AND (entry->>'from') <> $2 AND ($3 = '' OR (entry->>'time') > $3)`, [room, meId, since])
          count = (r.rows[0] && r.rows[0].c) || 0
        } catch (e) { count = 0 }
      } else {
        const h = getHistory(room)
        for (const e of h) if (String(e.from) !== meId && (!since || (e.time || '') > since)) count++
      }
      summary[room] = { count }
    }))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ summary }))
  } else if (url === '/subscribe' && req.method === 'POST') {
    if (!isTrustedOrigin(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'forbidden' })); return }
    const b = await readBody(req)
    if (b && b.room && b.subscription) {
      const rm = String(b.room).slice(0, 64)
      const uid = String(b.userId || '').slice(0, 80)
      addSub(rm, uid, b.subscription)
      dbSaveSub(rm, uid, b.subscription)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  } else if (appHtml) {
    const ae = String(req.headers['accept-encoding'] || '')
    if (appHtmlEtag && req.headers['if-none-match'] === appHtmlEtag) {
      res.writeHead(304, { 'ETag': appHtmlEtag, 'Cache-Control': 'no-cache' }); res.end(); return
    }
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': appHtmlEtag, 'Vary': 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'sha256-X6oK9y5ylEdf4IYfPBkHtHzmC+2TGXysO6K6AOYj0bc=' 'sha256-Teo6bznhpC673bmFeNM+9sYI/kpWB9hnLsujc8XF8wo=' 'sha256-EPWGZOZfEBu49JDq/HQJ4LoLtGdLiVqUMs3AbSFQ+aY=' 'sha256-O2f3zsK7kBCYSt0KF3+gEirrV/EXQXpmtibD5mWOeEA=' 'sha256-RrJCSws2CH5usRS3o35JllpWHU18qUVj9FawGU7R+gg='; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' wss: https: blob: data:; font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com; worker-src 'self' blob:; frame-ancestors 'none'" }
    if (appHtmlBr && /\bbr\b/.test(ae)) {
      h['Content-Encoding'] = 'br'
      res.writeHead(200, h); res.end(appHtmlBr)
    } else if (appHtmlGz && /\bgzip\b/.test(ae)) {
      h['Content-Encoding'] = 'gzip'
      res.writeHead(200, h); res.end(appHtmlGz)
    } else {
      res.writeHead(200, h); res.end(appHtml)
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  }
})

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  maxHttpBufferSize: 45e6, // с запасом над клиентским лимитом ~22 МБ видео
  cors: { origin: (origin, cb) => { const ok = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || /svchat-server\.onrender\.com$/.test(origin) || /svchat24\.ru$/.test(origin); cb(null, ok); }, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
})

io.on('connection', (socket) => {
  let currentRoom = null
  let me = null
  let pUid = null
  const goOnline = (uid) => { uid = String(uid || ''); if (!uid) return; pUid = uid; const was = (liveOnline.get(uid) || EMPTY_SET).size > 0; if (!liveOnline.has(uid)) liveOnline.set(uid, new Set()); liveOnline.get(uid).add(socket.id); if (!was) { broadcastPresenceToDms(uid); io.emit('presence', { id: uid, on: true }) } }
  // Антифлуд: не более ~8 сообщений за 5 сек и ~20 join за 30 сек на соединение
  const rl = { msg: [], join: [], typing: [], signal: [], dm: [], rw: [], med: [], old: [] }
  function allow(kind, max, windowMs) {
    const now = Date.now()
    const arr = rl[kind]
    while (arr.length && now - arr[0] > windowMs) arr.shift()
    if (arr.length >= max) return false
    arr.push(now)
    return true
  }

  socket.on('hello', (p = {}) => {
    const uid = String(p.userId || '').slice(0, 80)
    const token = p.auth ? String(p.auth).slice(0, 128) : ''
    if (!uid || !ownsUid(uid, token)) return
    goOnline(uid)
  })

  socket.on('rtt', (ts, ack) => { if (typeof ack === 'function') ack(1) })

  // Снимок присутствия по запросу (для индикаторов онлайна в списке чатов)
  socket.on('get_presence', () => {
    const online = []
    for (const [uid, set] of liveOnline.entries()) if (set && set.size > 0) online.push(uid)
    socket.emit('presence_all', { online })
  })

  socket.on('join', async (p = {}) => {
    if (!allow('join', 20, 30000)) { socket.emit('join_error', { reason: 'rate_limited' }); return }
    await dbReady
    const room = String(p.room || 'general').slice(0, 64)
    const password = p.password ? String(p.password).slice(0, 64) : null
    const auth = p.auth ? String(p.auth).slice(0, 128) : ''
    // TOFU v2: userId с токеном — проверяем; без токена — генерируем на сервере
    let assignedId = String(p.userId || '').slice(0, 80)
    if (assignedId) {
      if (!ownsUid(assignedId, auth)) { socket.emit('join_error', { reason: 'id_taken' }); return }
      if (auth) addAuth(assignedId, auth) // привязываем устройство (если ещё нет)
      else assignedId = 'u-' + crypto.randomBytes(12).toString('hex') // нет токена и id свободен — нельзя доверять, новый гость
    } else {
      assignedId = 'u-' + crypto.randomBytes(12).toString('hex')
    }
    const user = { id: assignedId, name: String(p.name || 'Гость').slice(0, 40), photo: (p.photo && typeof p.photo === 'string' && p.photo.startsWith('data:image/') && p.photo.length < 400000) ? p.photo : null }
    goOnline(user.id)
    // Зарегистрированный аккаунт: ник берём с сервера, подделать нельзя
    const aKey = accountByUid.get(user.id)
    if (aKey && accounts.get(aKey)) user.name = accounts.get(aKey).nick

    const occupied = roomUsers.has(room) && roomUsers.get(room).size > 0
    let meta = roomMeta.get(room)
    // Уже подтверждённый участник группы (или админ/владелец) не вводит пароль повторно —
    // пароль нужен только при ПЕРВОМ входе. Чинит «Неверный пароль» из-за устаревшего
    // локального пароля после ресинхронизации или смены устройства.
    const knownMember = !isDm(room) && (
      (roomMembers.get(room) && roomMembers.get(room).has(String(user.id))) ||
      (meta && String(meta.adminId) === String(user.id)) ||
      isOwner(user.id)
    )

    if (isDm(room)) {
      // Личная комната: доступ только двум участникам по их ID, пароли не используются
      const mm = dmMembers(room)
      if (!mm || !mm.includes(String(user.id))) {
        socket.emit('join_error', { reason: 'no_access' })
        return
      }
      meta = meta || { password: null, adminId: null }
      roomMeta.set(room, meta)
    } else if (!occupied) {
      const prev = roomMeta.get(room)
      if (prev && prev.password) {
        if (!knownMember && !(await verifyRoomPass(password, prev.password))) {
          socket.emit('join_error', { reason: 'wrong_password' })
          return
        }
        meta = prev
        // Миграция: если пароль ещё в открытом виде — пересохраняем хешем (только при наличии введённого пароля)
        if (password && !String(prev.password).startsWith('scrypt$')) {
          meta.password = await hashPassword(password)
          dbSaveRoom(room, meta)
        }
      } else {
        meta = { password: password ? await hashPassword(password) : null, adminId: user.id }
        dbSaveRoom(room, meta)
      }
      roomMeta.set(room, meta)
    } else {
      if (!knownMember && meta && meta.password && !(await verifyRoomPass(password, meta.password))) {
        socket.emit('join_error', { reason: 'wrong_password' })
        return
      }
    }

    currentRoom = room
    me = user
    if (OWNER_KEY && p.ownerKey && String(p.ownerKey) === OWNER_KEY) owners.add(me.id)
    if (p.pubKey) { const pk = String(p.pubKey).slice(0, 1000); pubKeys.set(me.id, pk); dbSaveKey(me.id, pk) }
    socket.join(room)
    if (!roomUsers.has(room)) roomUsers.set(room, new Map())
    roomUsers.get(room).set(socket.id, me)

    // История: если в памяти пусто (после рестарта) — поднимаем из базы
    let h = getHistory(room)
    if (h.length === 0) {
      const fromDb = await dbLoadHistory(room)
      if (fromDb && fromDb.length) { history.set(room, fromDb); h = fromDb }
    }

    touchMember(room, me)

    socket.emit('joined', { room, id: me.id, isAdmin: (!!(meta && meta.adminId === me.id)) || isOwner(me.id), locked: !!(meta && meta.password) })
    socket.emit('history', { messages: h.slice(-HISTORY_INIT).map(liteEntry), more: h.length > HISTORY_INIT })
    const rd = roomReads.get(room)
    let rdOut = {}
    if (rd) {
      if (isOwner(me.id)) rdOut = Object.fromEntries(rd.entries())
      else if (!readHidden.has(String(me.id))) { for (const [rid, rts] of rd.entries()) if (!readHidden.has(rid)) rdOut[rid] = rts }
    }
    socket.emit('reads_state', { reads: rdOut })
    const dv = roomDelivs.get(room)
    socket.emit('delivs_state', { delivs: dv ? Object.fromEntries(dv.entries()) : {} })
    io.to(room).emit('users', { users: userList(room) })
    broadcastMembers(room)
    socket.to(room).emit('user_joined', { user: me })
  })

  socket.on('message', (msg = {}, ack) => {
    if (!currentRoom || !me) { if (typeof ack === 'function') ack({ ok: false }); return }
    if (!allow('msg', 8, 5000)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'rate_limited' })
      socket.emit('rate_limited', { reason: 'too_fast' })
      return
    }
    // Ограничение длины текста
    msg.text = (msg.text == null) ? '' : String(msg.text)
    if (msg.text.length > 4000) msg.text = msg.text.slice(0, 4000)
    // Валидация типа и медиа: только data:-URL, лимиты по типу
    const MT = ['text', 'photo', 'video', 'voice', 'file']
    if (!MT.includes(msg.msgType)) msg.msgType = 'text'
    if (msg.dataUrl != null) {
      const du = String(msg.dataUrl)
      const cap = msg.msgType === 'video' ? 32e6 : msg.msgType === 'photo' ? 8e6 : msg.msgType === 'voice' ? 6e6 : msg.msgType === 'file' ? 15e6 : 0
      if ((!msg.enc && !du.startsWith('data:')) || du.length > cap) {
        if (typeof ack === 'function') ack({ ok: false, error: 'bad_media' })
        return
      }
      msg.dataUrl = du
    }
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      from: me.id,
      cid: msg.cid ? String(msg.cid).slice(0, 40) : undefined,
      fromName: me.name,
      msgType: msg.msgType || 'text',
      text: msg.text,
      replyTo: msg.replyTo && msg.replyTo.id ? {
        id: String(msg.replyTo.id).slice(0, 64),
        name: String(msg.replyTo.name || '').slice(0, 40),
        text: String(msg.replyTo.text || '').slice(0, 90)
      } : undefined,
      encrypted: msg.encrypted,
      enc: msg.enc ? 1 : undefined,
      iv: msg.iv ? String(msg.iv).slice(0, 64) : undefined,
      ct: msg.ct ? String(msg.ct).slice(0, 20000) : undefined,
      miv: msg.miv ? String(msg.miv).slice(0, 64) : undefined,
      mmime: msg.mmime ? String(msg.mmime).slice(0, 60) : undefined,
      dataUrl: msg.dataUrl,
      thumb: msg.thumb ? String(msg.thumb).slice(0, 200000) : undefined,
      dur: msg.dur,
      len: msg.len,
      fileName: msg.fileName ? String(msg.fileName).slice(0, 200) : undefined,
      fileSize: typeof msg.fileSize === 'number' ? msg.fileSize : undefined,
      time: new Date().toISOString(),
    }
    const h = getHistory(currentRoom)
    h.push(entry)
    if (h.length > HISTORY_LIMIT) h.shift()
    // Защита памяти: тяжёлые медиа в истории комнаты суммарно не больше ~60 МБ
    let mediaBytes = 0
    for (const e of h) mediaBytes += (e.dataUrl ? e.dataUrl.length : 0)
    while (mediaBytes > 40e6 && h.length > 1) {
      const dropped = h.shift()
      mediaBytes -= (dropped.dataUrl ? dropped.dataUrl.length : 0)
    }
    io.to(currentRoom).emit('message', { message: entry })
    if (typeof ack === 'function') ack({ ok: true })
    dbSaveMsg(currentRoom, entry)

    // Push тем, у кого приложение закрыто
    if (isDm(currentRoom)) {
      const mm = dmMembers(currentRoom) || []
      const other = mm.find(x => x !== String(me.id))
      // Надёжность: гарантируем, что получатель числится участником лички —
      // тогда чат подтянется у него при следующем открытии, даже если приглашение было пропущено.
      if (other) {
        const reg = roomMembers.get(currentRoom)
        if (!reg || !reg.has(String(other))) {
          const k = accountByUid.get(String(other))
          touchMember(currentRoom, { id: other, name: (k && accounts.get(k)) ? accounts.get(k).nick : 'Собеседник' })
        }
      }
      if (other && !onlineIdsIn(currentRoom).has(other)) pushToUser(other, {
        title: '\u{1F4AC} ' + me.name,
        body: entry.msgType === 'photo' ? '\u{1F4F7} Фото' : entry.msgType === 'video' ? '\u{1F3AC} Видео' : entry.msgType === 'voice' ? '\u{1F3A4} Голосовое' : entry.msgType === 'file' ? '\u{1F4CE} Файл' : String(entry.text || 'Сообщение').slice(0, 120),
        tag: 'svchat-' + currentRoom,
        room: currentRoom,
        url: '/?room=' + encodeURIComponent(currentRoom) + '&dm=' + encodeURIComponent(me.name)
      }).catch(() => {})
      return
    }
    pushToRoom(currentRoom, me.id, {
      title: me.name + ' · ' + currentRoom,
      body: entry.msgType === 'photo' ? '📷 Фото' : entry.msgType === 'video' ? '🎬 Видео' : entry.msgType === 'voice' ? '🎤 Голосовое' : entry.msgType === 'file' ? '📎 Файл' : String(entry.text || 'Сообщение').slice(0, 120),
      tag: 'svchat-' + currentRoom,
      room: currentRoom,
      url: '/?room=' + encodeURIComponent(currentRoom)
    }).catch(() => {})
  })

  socket.on('typing', () => {
    if (!currentRoom || !me) return
    if (!allow('typing', 10, 5000)) return
    socket.to(currentRoom).emit('typing', { userId: me.id, name: me.name })
  })

  socket.on('delivered', (p = {}) => {
    if (!currentRoom || !me) return
    if (!allow('rw', 30, 10000)) return
    const ts = String(p.ts || '').slice(0, 40)
    if (!ts) return
    if (!roomDelivs.has(currentRoom)) roomDelivs.set(currentRoom, new Map())
    const m = roomDelivs.get(currentRoom)
    const prev = m.get(String(me.id))
    if (prev && prev >= ts) return
    m.set(String(me.id), ts)
    dbSaveDeliv(currentRoom, String(me.id), ts)
    io.to(currentRoom).emit('delivs', { userId: String(me.id), ts })
  })

  // Реакция на сообщение: тоггл эмодзи от пользователя
  // Догрузка медиа конкретного сообщения (ленивая загрузка)
  socket.on('get_media', async (p = {}, ack) => {
    if (typeof ack !== 'function') return
    if (!currentRoom || !me) { ack({ ok: false }); return }
    if (!allow('med', 60, 10000)) { ack({ ok: false, error: 'rate_limited' }); return }
    const id = String(p.id || '')
    const entry = getHistory(currentRoom).find(e => e.id === id)
    if (entry && entry.dataUrl) { ack({ ok: true, dataUrl: entry.dataUrl }); return }
    const fromDb = await dbGetMsg(currentRoom, id) // вытеснено из памяти — берём из базы
    if (fromDb && fromDb.dataUrl) ack({ ok: true, dataUrl: fromDb.dataUrl })
    else ack({ ok: false })
  })

  // Догрузка более ранних сообщений (пагинация вверх)
  socket.on('get_older', (p = {}, ack) => {
    if (typeof ack !== 'function') return
    if (!currentRoom || !me) { ack({ messages: [], more: false }); return }
    if (!allow('old', 10, 10000)) { ack({ messages: [], more: false }); return }
    const beforeId = String(p.before || '')
    const h = getHistory(currentRoom)
    const idx = h.findIndex(e => e.id === beforeId)
    const older = idx > 0 ? h.slice(0, idx) : []
    const page = older.slice(-HISTORY_INIT)
    ack({ messages: page.map(liteEntry), more: older.length > HISTORY_INIT })
  })

  socket.on('react', (p = {}) => {
    if (!currentRoom || !me) return
    if (!allow('msg', 20, 5000)) return
    const id = String(p.id || '')
    const emoji = String(p.emoji || '').slice(0, 8)
    if (!id || !emoji) return
    const h = getHistory(currentRoom)
    const entry = h.find(e => e.id === id)
    if (!entry || entry.deleted) return // нельзя реагировать на удалённое сообщение
    if (!entry.reactions) entry.reactions = {}
    if (!entry.reactions[emoji] && Object.keys(entry.reactions).length >= 12) return
    const users = entry.reactions[emoji] || []
    const idx = users.indexOf(String(me.id))
    if (idx >= 0) users.splice(idx, 1)   // снять свою реакцию
    else users.push(String(me.id))        // поставить
    if (users.length) entry.reactions[emoji] = users
    else delete entry.reactions[emoji]
    io.to(currentRoom).emit('reaction', { id, reactions: entry.reactions })
    dbUpdateMsg(currentRoom, entry)
  })

  // Удаление своего сообщения (админ может удалять любые)
  socket.on('delete_msg', (p = {}) => {
    if (!currentRoom || !me) return
    if (!allow('rw', 30, 10000)) return
    const id = String(p.id || '')
    if (!id) return
    const h = getHistory(currentRoom)
    const entry = h.find(e => e.id === id)
    if (!entry) return
    const meta = roomMeta.get(currentRoom)
    const isAdmin = (meta && meta.adminId === me.id) || isOwner(me.id)
    if (String(entry.from) !== String(me.id) && !isAdmin) return // нельзя удалять чужое
    entry.deleted = true
    entry.text = ''
    entry.dataUrl = undefined
    entry.msgType = 'text'
    entry.reactions = undefined
    io.to(currentRoom).emit('msg_deleted', { id })
    dbUpdateMsg(currentRoom, entry)
  })

  socket.on('read', (p = {}) => {
    if (!currentRoom || !me) return
    if (!allow('rw', 30, 10000)) return
    const ts = String(p.ts || '').slice(0, 40)
    if (!ts) return
    if (!roomReads.has(currentRoom)) roomReads.set(currentRoom, new Map())
    const m = roomReads.get(currentRoom)
    const prev = m.get(String(me.id))
    if (prev && prev >= ts) return // уже отмечено более позднее
    m.set(String(me.id), ts)
    dbSaveRead(currentRoom, String(me.id), ts)
    const rHidden = readHidden.has(String(me.id))
    const rm = roomUsers.get(currentRoom)
    if (rm) for (const [sid, u] of rm.entries()) {
      const vid = String(u.id)
      if (isOwner(vid) || (!readHidden.has(vid) && !rHidden)) io.to(sid).emit('reads', { userId: String(me.id), ts })
    }
  })

  socket.on('kick', (p = {}) => {
    if (!currentRoom || !me) return
    const meta = roomMeta.get(currentRoom)
    if (!meta || (meta.adminId !== me.id && !isOwner(me.id))) return
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
    if (roomMembers.has(currentRoom)) roomMembers.get(currentRoom).delete(targetId)
    dbDelMember(currentRoom, targetId)
    io.to(currentRoom).emit('users', { users: userList(currentRoom) })
    broadcastMembers(currentRoom)
  })

  socket.on('dm_invite', (p = {}) => {
    if (!me) return
    if (!allow('dm', 5, 30000)) return
    const targetId = String(p.targetId || '')
    if (!targetId || targetId === String(me.id)) return
    const dm = dmRoomId(me.id, targetId)
    // Надёжность: сразу регистрируем ОБОИХ участников в комнате, чтобы личный чат
    // подтянулся у адресата при следующем открытии приложения через my_rooms —
    // даже если он сейчас офлайн и пропустит живое приглашение, и даже без push.
    const accNick = (uid, fallback) => { const k = accountByUid.get(String(uid)); if (k && accounts.get(k)) return accounts.get(k).nick; return String(fallback || '').slice(0, 40) || 'Собеседник' }
    touchMember(dm, { id: me.id, name: me.name })
    touchMember(dm, { id: targetId, name: accNick(targetId, p.targetName) })
    // Доставляем приглашение всем живым сокетам адресата, где бы он ни был в приложении
    let deliveredLive = false
    const sentTo = new Set()
    for (const [, mm] of roomUsers.entries()) {
      for (const [sockId, u] of mm.entries()) {
        if (String(u.id) === targetId && !sentTo.has(sockId)) {
          sentTo.add(sockId)
          const ts = io.sockets.sockets.get(sockId)
          if (ts) { ts.emit('dm_invited', { room: dm, fromId: String(me.id), fromName: me.name }); deliveredLive = true }
        }
      }
    }
    // Если адресат нигде не онлайн — push
    if (!deliveredLive) pushToUser(targetId, {
      title: me.name,
      body: '\u{1F4AC} приглашает вас в личный чат',
      tag: 'svchat-' + dm,
      room: dm,
      url: '/?room=' + encodeURIComponent(dm) + '&dm=' + encodeURIComponent(me.name)
    }).catch(() => {})
  })

  // Удаление контакта: чистим запись человека (по id и по имени — дубли) из реестра твоих комнат
  // Регистрация-или-вход по уникальному нику + паролю
  socket.on('auth_account', async (p = {}, ack) => {
    if (typeof ack !== 'function') return
    if (!allow('join', 20, 30000)) { ack({ ok: false, reason: 'rate_limited' }); return }
    await dbReady
    const nick = String(p.nick || '').trim().slice(0, 40)
    const password = String(p.password || '')
    const token = p.auth ? String(p.auth).slice(0, 128) : ''
    if (nick.length < 2) { ack({ ok: false, reason: 'bad_input' }); return }
    if (password && password.length < 4) { ack({ ok: false, reason: 'bad_input' }); return }
    const key = nickKey(nick)
    const existing = accounts.get(key)
    if (existing) {
      if (existing.passHash) {
        if (!(await verifyPassword(password, existing.passHash))) { ack({ ok: false, reason: 'wrong_password' }); return }
      } else if (!ownsUid(existing.userId, token)) {
        ack({ ok: false, reason: 'nick_taken' }); return
      }
      if (token) addAuth(existing.userId, token)
      ack({ ok: true, userId: existing.userId, nick: existing.nick })
      return
    }
    const userId = (String(p.userId || '').slice(0, 80)) || ('u-' + crypto.randomBytes(8).toString('hex'))
    if (!ownsUid(userId, token)) { ack({ ok: false, reason: 'id_taken' }); return }
    const passHash = password ? await hashPassword(password) : ''
    accounts.set(key, { nick, userId, passHash }); accountByUid.set(userId, key)
    dbSaveAccount(key, nick, userId, passHash)
    if (token) addAuth(userId, token)
    ack({ ok: true, userId, nick, created: true })
  })

  // Список комнат пользователя (для синхронизации чатов при входе с другого устройства).
  // Возвращаем все комнаты, где есть его userId, чтобы клиент восстановил список чатов.
  socket.on('my_rooms', async (p = {}, ack) => {
    if (typeof ack !== 'function') return
    if (!allow('med', 30, 10000)) { ack({ ok: false, reason: 'rate_limited' }); return }
    await dbReady
    const userId = String(p.userId || '').slice(0, 80)
    const token = p.auth ? String(p.auth).slice(0, 128) : ''
    if (!userId || !ownsUid(userId, token)) { ack({ ok: false, reason: 'forbidden' }); return }
    const rooms = []
    for (const [room, reg] of roomMembers.entries()) {
      if (!reg || !reg.has(String(userId))) continue
      if (room.indexOf('dm:') === 0) {
        const parts = room.split(':') // ['dm', id1, id2]
        const peerId = parts[1] === String(userId) ? parts[2] : parts[1]
        let peer = ''
        const rec = reg.get(String(peerId)); if (rec && rec.name) peer = rec.name
        if (!peer) { const k = accountByUid.get(peerId); if (k) { const a = accounts.get(k); if (a) peer = a.nick } }
        rooms.push({ room, dm: 1, peer: peer || 'Личный чат', pass: null })
      } else {
        const meta = roomMeta.get(room)
        rooms.push({ room, pass: (meta && meta.password) ? meta.password : null })
      }
    }
    ack({ ok: true, rooms })
  })

  // Установить/сменить пароль своего аккаунта (для тех, кто зашёл до появления аккаунтов)
  socket.on('set_readhide', (p = {}) => {
    const userId = String(p.userId || '').slice(0, 80)
    const token = p.auth ? String(p.auth).slice(0, 128) : ''
    if (!userId || !ownsUid(userId, token)) return
    const hidden = !!p.hidden
    if (hidden) readHidden.add(userId); else readHidden.delete(userId)
    dbSaveReadHide(userId, hidden)
  })

  socket.on('set_visibility', (p = {}) => {
    const userId = String(p.userId || '').slice(0, 80)
    const token = p.auth ? String(p.auth).slice(0, 128) : ''
    if (!userId || !ownsUid(userId, token)) return
    const hidden = !!p.hidden
    if (hidden) hiddenUsers.add(userId); else hiddenUsers.delete(userId)
    dbSaveHidden(userId, hidden)
  })

  socket.on('contact_remove', (p = {}) => {
    if (!me) return
    if (!allow('dm', 10, 30000)) return
    const targetId = String(p.targetId || '')
    const name = String(p.name || '').trim().toLowerCase()
    if (!targetId && !name) return
    const rooms = Array.isArray(p.rooms) ? p.rooms.map(x => String(x).slice(0, 64)).slice(0, 100) : []
    for (const room of rooms) {
      const reg = roomMembers.get(room)
      if (!reg || !reg.has(String(me.id))) continue // только твои комнаты
      let changed = false
      const meta = roomMeta.get(room)
      const isAdmin = (!!(meta && String(meta.adminId) === String(me.id))) || isOwner(me.id)
      for (const [uid, rec] of [...reg.entries()]) {
        const match = (targetId && uid === targetId) || (name && String((rec && rec.name) || '').trim().toLowerCase() === name)
        if (!match) continue
        const allowed = isAdmin || uid === String(me.id) // админ — любого; остальные — только себя
        if (!allowed) continue
        reg.delete(uid); dbDelMember(room, uid); changed = true
        if (isAdmin && uid !== String(me.id)) releaseAccount(uid) // сброс аккаунта админом: ник освобождается
      }
      if (changed) broadcastMembers(room)
    }
  })

  // Звонок: уведомить второго участника лички, если он не в комнате
  socket.on('call_notify', () => {
    if (!currentRoom || !me || !isDm(currentRoom)) return
    if (!allow('dm', 5, 30000)) return
    const mm = dmMembers(currentRoom) || []
    const other = mm.find(x => x !== String(me.id))
    if (!other || onlineIdsIn(currentRoom).has(other)) return
    pushToUser(other, {
      title: '\u{1F4DE} ' + me.name,
      body: 'Входящий звонок — нажмите, чтобы ответить',
      tag: 'svcall-' + currentRoom,
      url: '/?room=' + encodeURIComponent(currentRoom) + '&dm=' + encodeURIComponent(me.name)
    }).catch(() => {})
  })

  // Групповой звонок: push всем участникам группы, кого нет в комнате
  socket.on('group_call', () => {
    if (!currentRoom || !me || isDm(currentRoom)) return
    if (!allow('dm', 5, 30000)) return
    const online = onlineIdsIn(currentRoom)
    const reg = roomMembers.get(currentRoom)
    if (!reg) return
    for (const [uid] of reg.entries()) {
      if (String(uid) === String(me.id) || online.has(String(uid))) continue
      pushToUser(String(uid), {
        title: '\u{1F4F9} ' + me.name,
        body: 'Групповой видеозвонок — нажмите, чтобы войти',
        tag: 'svgcall-' + currentRoom,
        room: currentRoom,
        url: '/?room=' + encodeURIComponent(currentRoom)
      }).catch(() => {})
    }
  })

  socket.on('set_room_password', async (p = {}) => {
    if (!currentRoom || !me) return
    if (isDm(currentRoom)) return
    const meta = roomMeta.get(currentRoom)
    if (!meta || (meta.adminId !== me.id && !isOwner(me.id))) return
    const pw = p.password != null ? String(p.password).slice(0, 64) : ''
    meta.password = pw ? await hashPassword(pw) : null
    roomMeta.set(currentRoom, meta)
    dbSaveRoom(currentRoom, meta)
  })

  socket.on('set_room_avatar', (p = {}) => {
    if (!currentRoom || !me) return
    if (isDm(currentRoom)) return
    const meta = roomMeta.get(currentRoom)
    const isAdmin = (meta && meta.adminId === me.id) || isOwner(me.id)
    if (!isAdmin) return // только админ
    const avatar = p.avatar && typeof p.avatar === 'string' && p.avatar.startsWith('data:image/') && p.avatar.length < 500000 ? p.avatar : null
    io.to(currentRoom).emit('room_avatar', { room: currentRoom, avatar })
  })

  socket.on('signal', (data = {}) => {
    if (!currentRoom) return
    if (!allow('signal', 40, 10000)) return
    try { if (JSON.stringify(data.data || '').length > 20000) return } catch { return }
    socket.to(currentRoom).emit('signal', { from: me && me.id, data: data.data, target: String(data.target || '').slice(0, 80) })
  })

  socket.on('disconnect', () => {
    if (pUid) {
      const s = liveOnline.get(pUid)
      if (s) { s.delete(socket.id); if (s.size === 0) { liveOnline.delete(pUid); const ts = new Date().toISOString(); seenAt.set(pUid, ts); dbSaveSeen(pUid, ts); broadcastPresenceToDms(pUid); io.emit('presence', { id: pUid, on: false }) } }
    }
    if (currentRoom && roomUsers.has(currentRoom)) {
      roomUsers.get(currentRoom).delete(socket.id)
      if (roomUsers.get(currentRoom).size === 0) roomUsers.delete(currentRoom)
      io.to(currentRoom).emit('users', { users: userList(currentRoom) })
      if (me) {
        touchMember(currentRoom, me)
        socket.to(currentRoom).emit('user_left', { user: me })
      }
      broadcastMembers(currentRoom)
    }
  })
})

// Heartbeat присутствия: пока пользователь онлайн, обновляем его «последний онлайн» раз в минуту.
// Иначе при рестарте сервера (деплой) или обрыве сокета без чистого disconnect время застревает.
setInterval(() => {
  const now = new Date().toISOString()
  for (const [uid, set] of liveOnline.entries()) {
    if (set && set.size > 0) { seenAt.set(uid, now); dbSaveSeen(uid, now) }
  }
}, 60000)

// Анти-засыпание: Render free спит после 15 мин простоя, и тогда первое подключение
// нового пользователя не успевает за таймаут регистрации → «Нет связи с сервером».
// Пингуем сами себя каждые 10 минут, чтобы инстанс всегда был «тёплым».
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || 'https://svchat-server.onrender.com').replace(/\/+$/, '')
setInterval(() => { fetch(SELF_URL + '/health').catch(() => {}) }, 10 * 60 * 1000)

server.listen(PORT, () => {
  console.log('SVchat server (v152: сокет подключается заранее (вход с первого раза) + фикс auth' + PORT)
})
