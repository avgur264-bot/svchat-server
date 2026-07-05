# CLAUDE.md

Guidance for AI assistants (Claude Code) working in this repository.

> Comments, docs, and UI strings in this project are in **Russian**. Match the
> surrounding language when editing code comments or user-facing text.

## What this is

**SVchat** — a realtime messenger PWA (private/group chats with E2E encryption,
calls, polls, media, push). Production: **https://svchat24.ru**, hosted on
**Render.com** (free tier). Two moving parts:

- **`server.js`** — the entire backend in one CommonJS file: Node.js HTTP +
  **Socket.IO** realtime, **Postgres** persistence (`pg`), **Web Push** (VAPID,
  `web-push`), **S3** media storage (`@aws-sdk/client-s3`), WebRTC call
  signaling, and it also serves the static client.
- **`index.html`** — the entire frontend: a **minified React bundle inlined in
  one `<script>` tag**. There is **no frontend build step** — you edit the
  bundle in place with surgical string replacements.

Everything else is supporting material:

| Path | Purpose |
|------|---------|
| `svchat-e2e/` | Playwright end-to-end tests (run against prod by default) |
| `svchat-native/` | Capacitor wrappers (Android + iOS) that load the live site via `server.url` |
| `webhook.js` + `deploy.sh` | Legacy VPS auto-deploy (Render is the real deploy path now) |
| `SVCHAT.md` | Human-facing "where things live + recent changes" changelog (Russian) |
| `CAPACITOR_HANDOFF.md` | Context/gotchas for the Capacitor native-wrapping work |
| `README.md` | Short run/test instructions (Russian) |

## Critical rules (read before touching `index.html` or `server.js`)

### 1. Version numbers must stay in sync
The client build number lives in **two** places and they **must match**:
- `window.__svBuild = N` in `index.html`
- `const CLIENT_BUILD = N` in `server.js`

These drive client auto-update. **Bump both** in the same change whenever you
ship a client change. Current build: **197**. Verify prod:
`curl -s https://svchat24.ru/stats` → `{"ver":N,"client":N}`.

### 2. Any `index.html` change requires recomputing CSP hashes
`server.js` enforces a strict `Content-Security-Policy` with per-script
`'sha256-...'` hashes. The list of hashes appears in **two places** in
`server.js` (around the `/diag` route ~line 779 and the main app route ~line
1002) and **both must be updated identically**. Any edit to an inline `<script>`
in `index.html` changes its sha256, so recompute and replace in both spots.

Hash recompute script (run from repo root):
```js
// scan.js
const fs=require('fs'),c=require('crypto');const h=fs.readFileSync('index.html','utf8');
const re=/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;let m,i=0;
while((m=re.exec(h))){const a=m[1]||'';if(/\bsrc=/.test(a)){i++;continue;}
console.log('#'+i+' sha256-'+c.createHash('sha256').update(m[2],'utf8').digest('base64'));i++;}
```

### 3. Editing the minified bundle safely
`index.html` is minified. Make **point replacements**, and before applying a
replacement confirm the target string occurs **exactly once** (a small
node/grep check). Broad edits will silently corrupt the bundle.

### 4. Do not break the live site
Render deploys `main` automatically. Never remove Web Push, never weaken the CSP
for the ordinary web path, and keep the Capacitor wrappers on `server.url` (do
not bundle static assets into the native apps).

## Development workflow

There is no compile/build step and no test runner wired into the server. The
loop is: edit → bump build numbers → recompute CSP hashes → deploy.

```bash
npm install
node server.js        # listens on PORT (default 8080)
```

### Deploy (Render auto-deploys `main`)
Development happens on a feature branch; production is the `main` branch on
GitHub `avgur264-bot/svchat-server`. Deploy = get your work onto `main`:
```bash
git push origin <feature-branch>:main   # Render builds & deploys automatically
```
Render free tier sometimes throttles; a Manual Deploy in the Render dashboard
can help. `webhook.js`/`deploy.sh` are the older VPS deploy path and are not the
primary mechanism.

> Branch note for this environment: develop and push to the branch assigned in
> your task instructions. Do not push to `main` unless explicitly told to.

## Server architecture (`server.js`)

In-memory `Map`s hold live state; Postgres is the durable backing store (the
server still boots and runs in memory-only mode if `DATABASE_URL` is unset).

**HTTP routes** (plain `http` server): `/health`, `/stats`, `/diag`, `/vapid`,
`/ice` (STUN/TURN config), `/users` (directory), `/set_password`, `/sw.js`,
`/manifest.json` (+`.webmanifest`); everything else serves the app HTML.

**Socket.IO events** (the real API surface): `hello`, `join`, `message`,
`typing`, `delivered`, `read`, `get_media`, `get_older`, `react`, `delete_msg`,
`edit_msg`, `pin_msg`, `create_poll`, `vote_poll`, `kick`, `dm_invite`,
`auth_account`, `my_rooms`, `set_pin`, `set_readhide`, `set_visibility`,
`contact_remove`, `call_notify`, `group_call`, `set_room_password`,
`set_room_avatar`, `signal` (WebRTC), `disconnect`.

**Postgres tables** (all prefixed `svchat_`, created with `CREATE TABLE IF NOT
EXISTS` on boot): `rooms`, `messages`, `push`, `members`, `reads`, `delivs`,
`auth`, `authtok`, `accounts`, `keys`, `hidden`, `seen`, `readhide`,
`dirremoved`, `pins`, `meta`.

**Key subsystems:**
- **Auth / multi-device (TOFU):** a `userId` is claimed on first use; devices
  bind tokens into `userAuth` (`svchat_authtok`, up to `MAX_DEVICES=12`). Any
  token in an account's set owns it; empty set = unclaimed.
- **Push:** `pushSubs` (room→endpoint) and `userSubs` (user→endpoint) indexes;
  `pushToRoom`/`pushToUser`. Dead subscriptions (HTTP 400/403/404/410) are
  pruned from memory and DB.
- **Media:** uploads go to S3 (`s3Put`); the DB stores only the **key**. Clients
  fetch bytes on demand via the `get_media` socket event (`s3Get` → data URL).
- **Calls:** WebRTC signaling over the `signal` socket event; ICE/TURN served by
  `/ice` (metered.ca TURN).
- **E2E encryption:** private chats exchange ECDH public keys (`pubKeys` /
  `svchat_keys`); the server relays but does not read plaintext.

## Environment variables

Set in the Render dashboard, never in code. Server boots with sensible
degradations when optional ones are missing (no push, memory-only, etc.):

`DATABASE_URL`, `VAPID_PUBLIC` / `VAPID_PRIVATE`, `OWNER_KEY`,
`TURN_USERNAME` / `TURN_CREDENTIAL`, `PORT`,
`S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`.

## Testing (`svchat-e2e/`)

Playwright E2E tests, run against **production** by default (override with
`SVCHAT_URL`).

```bash
cd svchat-e2e && npm install && npx playwright install chromium
npm run test:smoke     # stable, no-WebSocket gate ("is the site alive")
npm run test:realtime  # Socket.IO delivery/files (needs real network, can flake)
npm test               # everything
```

CI: `.github/workflows/e2e.yml` runs on push to `main`, daily, and manually.
**Smoke tests are the gate** (failure = red build); **realtime tests are
informational** (`continue-on-error`, tagged `@realtime`) because they flake
against the live free-tier server (cold starts). The workflow warms up Render
(`/health`) before running. Tests log in by seeding `localStorage`
(`chatapp_authed`, `svchat_profile`) — the server trusts the `userId` via TOFU,
so no phone/email login is needed.

## Native apps (`svchat-native/`, Capacitor)

Thin WebView wrappers that load `https://svchat24.ru` via `server.url` — site
updates appear without rebuilding; rebuild only for native changes.
`appId: ru.svchat.app`. Android APK:
```bash
cd svchat-native/android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```
iOS can only be built on a Mac with Xcode. Native-specific gotchas (CSP vs. the
Capacitor bridge, `isNative` branch points, FCM push) are documented in
`CAPACITOR_HANDOFF.md` — read it before native work.

## Conventions

- **One-file backend, one-file frontend.** Resist splitting them; the whole
  system assumes `server.js` + inlined `index.html`.
- **Russian** for comments and UI strings.
- Commit messages follow the existing style: `vNNN: <short summary>` for client
  changes (e.g. `v197: персональная ссылка-приглашение создаёт взаимный контакт`).
- Keep `SVCHAT.md` updated with notable user-facing changes when you ship them.
- Never write model identifiers or internal/service strings into commits, code,
  or any pushed artifact.
