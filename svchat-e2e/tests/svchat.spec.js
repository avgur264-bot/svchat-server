// SVchat — Playwright E2E. Запуск: npm test  (URL через SVCHAT_URL).
const { test, expect, devices } = require('@playwright/test');

const INSECURE = !!process.env.PW_INSECURE; // для ручных контекстов (тесты 5, 10)

// Вход без онбординга: сервер доверяет userId из профиля (TOFU), localStorage достаточно.
async function seed(context, profile) {
  await context.addInitScript((p) => {
    try {
      localStorage.setItem('chatapp_authed', 'true');
      localStorage.setItem('svchat_profile', JSON.stringify({
        name: p.name, color: '#2f6ef0', id: p.id,
        initials: (p.name || 'U').trim().slice(0, 2).toUpperCase()
      }));
    } catch (e) {}
  }, profile);
}

// Войти в открытую группу с заданным именем (первый создаёт, остальные присоединяются к той же).
async function enterRoom(page, room) {
  const createAndGo = page.getByRole('button', { name: 'Создать и войти' });
  if (!(await createAndGo.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /Создать группу/ }).click().catch(() => {});
  }
  await page.getByPlaceholder(/Например|Назван/).fill(room);
  await page.getByRole('button', { name: 'Создать и войти' }).click();
  await page.getByPlaceholder('Сообщение...').waitFor({ state: 'visible', timeout: 20000 });
  await waitForConnected(page);
}

// Дождаться установления Socket.IO (учитывает «холодный старт» Render до ~60 сек).
// Баннеры «сервер просыпается…» / «websocket error» исчезают после подключения.
async function waitForConnected(page) {
  await expect(page.getByText(/просыпается|websocket error|нет связи/i))
    .toHaveCount(0, { timeout: 70000 });
}

async function sendMessage(page, text) {
  const input = page.getByPlaceholder('Сообщение...');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. Health-check — сервер и PostgreSQL живы', async ({ request }) => {
  const r = await request.get('/health');
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.db).toBe(true);
  expect(j.push).toBe(true); // VAPID_PRIVATE задан -> push включён
});

test('2. PWA загружается, build актуальный, без критичных ошибок', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__svBuild === 'number', null, { timeout: 20000 });
  const build = await page.evaluate(() => window.__svBuild);
  expect(build).toBeGreaterThanOrEqual(101);
  // отфильтровать заведомо безобидные (CDN-шрифты/иконки, meta X-Frame-Options)
  const critical = errors.filter((e) => !/X-Frame-Options|fetching the script|jsdelivr|gstatic|googleapis|font|manifest|icon/i.test(e));
  expect(critical, '\n' + critical.join('\n')).toHaveLength(0);
});

test('3. Вход выполнен — пользователь внутри приложения', async ({ context, page }) => {
  await seed(context, { name: 'Алиса E2E', id: 'u-e2e-login' });
  await page.goto('/');
  // нижняя навигация => мы в приложении, а не на экране онбординга
  await expect(page.getByText('Контакты', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Настройки', { exact: true })).toBeVisible();
});

test('4. Отправка сообщения в групповой чат', async ({ context, page }) => {
  await seed(context, { name: 'Алиса E2E', id: 'u-e2e-send' });
  await page.goto('/');
  await enterRoom(page, 'e2e-' + Date.now());
  const text = 'Привет E2E ' + Date.now();
  await sendMessage(page, text);
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10000 });
});

test('5. Доставка второму пользователю в реальном времени (WebSocket)', async ({ browser }) => {
  const room = 'e2e-pair-' + Date.now();
  const cA = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  const cB = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  await seed(cA, { name: 'Алиса', id: 'u-e2e-a-' + Date.now() });
  await seed(cB, { name: 'Боб', id: 'u-e2e-b-' + Date.now() });
  const a = await cA.newPage();
  const b = await cB.newPage();
  try {
    await a.goto('/'); await enterRoom(a, room);
    await b.goto('/'); await enterRoom(b, room);
    const text = 'realtime-' + Date.now();
    await sendMessage(a, text);
    await expect(b.getByText(text).first()).toBeVisible({ timeout: 15000 });
  } finally {
    await cA.close(); await cB.close();
  }
});

test('6. Превью последнего сообщения в списке чатов', async ({ context, page }) => {
  await seed(context, { name: 'Алиса E2E', id: 'u-e2e-prev' });
  await page.goto('/');
  const room = 'e2e-prev-' + Date.now();
  await enterRoom(page, room);
  const text = 'preview-' + Date.now();
  await sendMessage(page, text);
  await expect(page.getByText(text).first()).toBeVisible();
  // назад в список чатов
  await page.getByText('Чаты', { exact: true }).click();
  // в карточке комнаты видно последнее сообщение
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10000 });
});

test('7. Авто-переподключение после обрыва сети', async ({ context, page }) => {
  await seed(context, { name: 'Алиса E2E', id: 'u-e2e-recon' });
  await page.goto('/');
  await enterRoom(page, 'e2e-recon-' + Date.now());
  await context.setOffline(true);
  await page.waitForTimeout(2500);
  await context.setOffline(false);
  await page.waitForTimeout(4000);
  const input = page.getByPlaceholder('Сообщение...');
  await expect(input).toBeEnabled();
  // и после reconnect можно отправить
  const text = 'after-reconnect-' + Date.now();
  await sendMessage(page, text);
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10000 });
});

test('8. Мобильная вёрстка — нет горизонтального скролла', async ({ browser }) => {
  const c = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: INSECURE });
  await seed(c, { name: 'Алиса', id: 'u-e2e-mobile' });
  const p = await c.newPage();
  try {
    await p.goto('/');
    await p.waitForFunction(() => typeof window.__svBuild === 'number', null, { timeout: 20000 });
    await p.waitForTimeout(1500);
    const { sw, vw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
    expect(sw).toBeLessThanOrEqual(vw + 5);
  } finally {
    await c.close();
  }
});

test('9. Статус сообщения меняется на «прочитано» (✓✓)', async ({ browser }) => {
  const room = 'e2e-read-' + Date.now();
  const cA = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  const cB = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  await seed(cA, { name: 'Алиса', id: 'u-e2e-ra-' + Date.now() });
  await seed(cB, { name: 'Боб', id: 'u-e2e-rb-' + Date.now() });
  const a = await cA.newPage();
  const b = await cB.newPage();
  try {
    await a.goto('/'); await enterRoom(a, room);
    const text = 'read-' + Date.now();
    await sendMessage(a, text);
    await expect(a.getByText(text).first()).toBeVisible();
    // Боб входит в ту же комнату и читает → у Алисы статус становится ✓✓ (синий)
    await b.goto('/'); await enterRoom(b, room);
    await expect(b.getByText(text).first()).toBeVisible({ timeout: 15000 });
    await expect(a.getByText('✓✓').first()).toBeVisible({ timeout: 15000 });
  } finally {
    await cA.close(); await cB.close();
  }
});

test('10. Личный чат показывает индикатор шифрования 🔒', async ({ browser }) => {
  const idA = 'u-e2e-da-' + Date.now();
  const idB = 'u-e2e-db-' + Date.now();
  const dm = 'dm:' + [idA, idB].sort().join(':'); // детерминированный id личной комнаты
  const cA = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  const cB = await browser.newContext({ ignoreHTTPSErrors: INSECURE });
  await seed(cA, { name: 'Алиса', id: idA });
  await seed(cB, { name: 'Боб', id: idB });
  const a = await cA.newPage();
  const b = await cB.newPage();
  try {
    // оба открывают одну личку по URL → клиенты обмениваются ключами → включается E2E
    await b.goto('/?room=' + encodeURIComponent(dm) + '&dm=' + encodeURIComponent('Алиса'));
    await b.getByPlaceholder('Сообщение...').waitFor({ timeout: 20000 });
    await a.goto('/?room=' + encodeURIComponent(dm) + '&dm=' + encodeURIComponent('Боб'));
    await a.getByPlaceholder('Сообщение...').waitFor({ timeout: 20000 });
    await waitForConnected(a);
    // индикатор 🔒 в шапке (span title="Зашифровано (E2E)")
    await expect(a.getByTitle('Зашифровано (E2E)')).toBeVisible({ timeout: 25000 });
  } finally {
    await cA.close(); await cB.close();
  }
});

test('11. Отправка файла — карточка с именем появляется', async ({ context, page }) => {
  await seed(context, { name: 'Алиса E2E', id: 'u-e2e-file' });
  await page.goto('/');
  await enterRoom(page, 'e2e-file-' + Date.now());
  await page.getByRole('button', { name: 'Прикрепить' }).click(); // открыть меню вложений
  const fname = 'e2e-doc-' + Date.now() + '.txt';
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByText('Файл', { exact: true }).click(),
  ]);
  await chooser.setFiles({ name: fname, mimeType: 'text/plain', buffer: Buffer.from('hello e2e file') });
  await expect(page.getByText(fname).first()).toBeVisible({ timeout: 15000 });
});
