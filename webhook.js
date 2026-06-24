const http = require('http')
const crypto = require('crypto')
const { execFile } = require('child_process')

const SECRET = process.env.WEBHOOK_SECRET || ''
const PORT = process.env.WEBHOOK_PORT || 9000

function verifySignature(payload, signature) {
  if (!SECRET) return true // если секрет не задан — пропускаем проверку
  const hmac = crypto.createHmac('sha256', SECRET)
  hmac.update(payload)
  const digest = 'sha256=' + hmac.digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))
  } catch (e) {
    return false
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const sig = req.headers['x-hub-signature-256'] || ''
    if (!verifySignature(body, sig)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    let payload
    try { payload = JSON.parse(body) } catch (e) {
      res.writeHead(400)
      res.end('Bad JSON')
      return
    }

    // Реагируем только на push в main
    if (payload.ref !== 'refs/heads/main') {
      res.writeHead(200)
      res.end('Skipped (not main)')
      return
    }

    res.writeHead(200)
    res.end('Deploying...')

    console.log('[webhook] Push в main — запускаем деплой...')
    execFile('/var/www/svchat/deploy.sh', (err, stdout, stderr) => {
      if (err) {
        console.error('[webhook] Ошибка деплоя:', err.message)
        console.error(stderr)
      } else {
        console.log('[webhook] Деплой успешен:')
        console.log(stdout)
      }
    })
  })
})

server.listen(PORT, () => {
  console.log(`Webhook-сервер слушает порт ${PORT}`)
})
