'use strict';

// Интеграционный тест: настоящий server.js в отдельном процессе и временной
// папке. Лимитер и yClients подменены в памяти (helpers/mock-upstreams.js),
// поэтому в сеть ничего не уходит. Проверяется поведение целиком: lease на
// каждую страницу, отказ лимитера, реальный 429 и то, что прежний снимок
// отзывов продолжает отдаваться.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const SERVER_DIR = path.join(__dirname, '..');
const ORIGIN = 'https://baristaschool.ru';
const ADMIN_KEY = 'test-admin-key';
const SERVER_FILES = [
  'server.js',
  'kv-store.js',
  'review-feed.js',
  'review-visit-enrichment.js',
  'yclients-fetch.js',
  'yclients-limiter-client.js',
];

let child;
let workDir;
let port;
let messageId = 0;
let output = '';
const pending = new Map();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
}

function control(type, state) {
  return new Promise((resolve) => {
    messageId += 1;
    pending.set(messageId, resolve);
    child.send({ id: messageId, type, state });
  });
}

async function upstreamCalls() {
  return (await control('dump')).calls;
}

function request(method, pathname, { admin = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: ORIGIN };
    if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start:\n' + output);
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-limiter-'));
  for (const file of SERVER_FILES) fs.copyFileSync(path.join(SERVER_DIR, file), path.join(workDir, file));
  fs.symlinkSync(fs.realpathSync(path.join(SERVER_DIR, 'node_modules')), path.join(workDir, 'node_modules'), 'dir');
  port = await freePort();

  child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'mock-upstreams.js'), 'server.js'], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DISABLE_CRON: '1',
      ADMIN_KEY,
      YCLIENTS_PARTNER_TOKEN: 'test-partner',
      YCLIENTS_USER_TOKEN: 'test-user',
      YCLIENTS_COMPANY_ID: '453962',
      YCLIENTS_RECORDS_SNAPSHOT_PATH: '',
      INTERNAL_REVIEWS_FEED_PATH: '',
      YCLIENTS_LIMITER_URL: 'http://limiter.test/api/internal/yclients-limiter/v1',
      YCLIENTS_LIMITER_INTERNAL_SECRET: 'test-secret',
      // Проверяет и то, что значение off из окружения не отключает лимитер.
      YCLIENTS_LIMITER_MODE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('message', (message) => {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve) resolve(message);
  });
  await waitForServer();
});

after(() => {
  if (child) child.kill('SIGKILL');
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

// Тесты идут по порядку и делят один процесс: первый создаёт снимок,
// остальные проверяют, что сбои его не затирают.

test('forced refresh takes a lease for every page of pagination', async () => {
  await control('set', { limiter: 'grant', yclients: 'ok', reviews: 203 });
  await control('reset-calls');

  const res = await request('GET', '/reviews?count=5&refresh=1', { admin: true });

  assert.equal(res.status, 200, output);
  assert.equal(res.body.total, 203);
  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'lease', 'yclients']);
  assert.deepEqual(calls.filter((call) => call.kind === 'yclients').map((call) => call.page), ['1', '2']);
  for (const lease of calls.filter((call) => call.kind === 'lease')) {
    assert.deepEqual(lease.body, { source: 'reviews.snapshot', priority: 'background' });
  }
});

test('limiter refusal: nothing is sent to yClients, no report, previous snapshot is still served', async () => {
  await control('set', { limiter: 'deferred', yclients: 'ok', reviews: 1 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=6&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.equal(forced.body.detail, 'deferred');

  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease']);

  const widget = await request('GET', '/reviews?count=7');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);
  assert.equal(widget.body.items.length, 7);

  const bundle = await request('GET', '/reviews-bundle');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.count, 203);
});

test('limiter unavailable is handled the same way as a refusal', async () => {
  await control('set', { limiter: 'down', yclients: 'ok', reviews: 1 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=8&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.equal(forced.body.detail, 'limiter_unavailable');
  assert.deepEqual((await upstreamCalls()).map((call) => call.kind), ['lease']);

  const widget = await request('GET', '/reviews?count=9');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);
});

test('real yClients 429: report is sent, previous snapshot is still served', async () => {
  await control('set', { limiter: 'grant', yclients: '429', reviews: 1 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=10&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.match(forced.body.detail, /status 429/);

  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'report']);
  assert.equal(calls[2].body.outcome, 'rate_limited');
  assert.equal(calls[2].body.retry_after_ms, 7000);
  assert.match(calls[2].body.lease_id, /^lease-\d+$/);

  const widget = await request('GET', '/reviews?count=11');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);
});

test('yClients 429 on the second page: report is sent, pagination stops, previous snapshot is kept', async () => {
  // 450 отзывов — три страницы. Если бы частичный результат сохранился, в снимке стало бы 200.
  await control('set', { limiter: 'grant', yclients: 'ok', reviews: 450, rateLimitFromPage: 2 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=14&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.match(forced.body.detail, /status 429/);

  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'lease', 'yclients', 'report']);
  assert.deepEqual(calls.filter((call) => call.kind === 'yclients').map((call) => call.page), ['1', '2']);

  const widget = await request('GET', '/reviews?count=15');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);
  const bundle = await request('GET', '/reviews-bundle');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.count, 203);
  await control('set', { rateLimitFromPage: 0 });
});

test('limiter refusal on the second page: second request is not sent, previous snapshot is kept', async () => {
  await control('set', { limiter: 'grant', yclients: 'ok', reviews: 450, leaseBudget: 1 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=16&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.equal(forced.body.detail, 'deferred');

  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'lease']);

  const widget = await request('GET', '/reviews?count=17');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);
  await control('set', { leaseBudget: null });
});

test('stale snapshot + limiter refusal: widget and bundle keep the previous snapshot', async () => {
  // Снимок «стареет» на два часа: непринудительное обновление обязано начаться и упасть.
  await control('set', { limiter: 'deferred', yclients: 'ok', reviews: 1, timeOffsetMs: 2 * 60 * 60 * 1000 });
  await control('reset-calls');

  const bundle = await request('GET', '/reviews-bundle');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.count, 203);
  assert.equal(bundle.body.refreshed, false);

  const widget = await request('GET', '/reviews?count=12');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 203);

  const calls = await upstreamCalls();
  assert.ok(calls.length >= 1, 'refresh was attempted');
  assert.ok(calls.every((call) => call.kind === 'lease'), 'only lease attempts, no yClients requests and no reports');
});

test('staff refresh stops at the first limiter refusal instead of trying every path', async () => {
  await control('set', { limiter: 'deferred', yclients: 'ok', timeOffsetMs: 0 });
  await control('reset-calls');

  const res = await request('POST', '/admin/refresh-staff', { admin: true });

  assert.equal(res.status, 502);
  assert.deepEqual((await upstreamCalls()).map((call) => call.kind), ['lease']);
});

test('staff refresh stops after a real yClients 429 and reports it once', async () => {
  await control('set', { limiter: 'grant', yclients: '429', timeOffsetMs: 0 });
  await control('reset-calls');

  const res = await request('POST', '/admin/refresh-staff', { admin: true });

  assert.equal(res.status, 502);
  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'report']);
  assert.equal(calls[2].body.outcome, 'rate_limited');
});

test('staff refresh still tries the next path after an ordinary yClients error, one lease per attempt', async () => {
  await control('set', { limiter: 'grant', yclients: 'ok', staffStatus: 404 });
  await control('reset-calls');

  const res = await request('POST', '/admin/refresh-staff', { admin: true });

  assert.equal(res.status, 502);
  assert.deepEqual(
    (await upstreamCalls()).map((call) => call.kind),
    ['lease', 'yclients', 'lease', 'yclients', 'lease', 'yclients', 'lease', 'yclients']
  );
  await control('set', { staffStatus: 200 });
});

test('after the limiter recovers the snapshot is refreshed again', async () => {
  await control('set', { limiter: 'grant', yclients: 'ok', reviews: 3, timeOffsetMs: 0 });
  await control('reset-calls');

  const res = await request('GET', '/reviews?count=13&refresh=1', { admin: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);
  assert.deepEqual((await upstreamCalls()).map((call) => call.kind), ['lease', 'yclients']);
});
