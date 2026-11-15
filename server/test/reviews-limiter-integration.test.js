'use strict';

// Интеграционный тест: настоящий server.js в отдельном процессе и временной
// папке. Лимитер и yClients подменены в памяти (helpers/mock-upstreams.js),
// поэтому в сеть ничего не уходит. Проверяется поведение целиком: lease на
// каждую страницу, отказ лимитера, реальный 429 и то, что прежний снимок
// отзывов продолжает отдаваться.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { startServer } = require('./helpers/server-harness');

let server;
const control = (type, state) => server.control(type, state);
const request = (method, pathname, options) => server.request(method, pathname, options);
const upstreamCalls = () => server.upstreamCalls();

before(async () => { server = await startServer(); });
after(() => { if (server) server.stop(); });

// Тесты идут по порядку и делят один процесс: первый создаёт снимок,
// остальные проверяют, что сбои его не затирают.

test('forced refresh takes a lease for every page of pagination', async () => {
  await control('set', { limiter: 'grant', yclients: 'ok', reviews: 203 });
  await control('reset-calls');

  const res = await request('GET', '/reviews?count=5&refresh=1', { admin: true });

  assert.equal(res.status, 200, server.output());
  assert.equal(res.body.total, 203);
  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease', 'yclients', 'lease', 'yclients']);
  assert.deepEqual(calls.filter((call) => call.kind === 'yclients').map((call) => call.page), ['1', '2']);
  for (const lease of calls.filter((call) => call.kind === 'lease')) {
    assert.deepEqual(lease.body, { source: 'reviews.snapshot', priority: 'background' });
  }
  // Строка для суточной приёмки: время ответа yClients отдельно от ожидания lease.
  const log = server.output();
  assert.match(log, /\[reviews\] Snapshot refreshed: 203 reviews, pages=2, slowest_yclients_ms=\d+, slowest_lease_wait_ms=\d+/);
  // Начало и итог попытки связаны одним id.
  const started = /\[reviews\] Refresh started: id=(\S+), at=\d{4}-\d\d-\d\dT[\d:.]+Z, trigger=route, force=1/.exec(log);
  assert.ok(started, log);
  assert.ok(log.includes('[reviews] Refresh finished: id=' + started[1] + ', result=ok, reviews=203, pages=2, requests=2, slowest_yclients_ms='), log);
});

test('limiter refusal: nothing is sent to yClients, no report, previous snapshot is still served', async () => {
  await control('set', { limiter: 'deferred', yclients: 'ok', reviews: 1 });
  await control('reset-calls');

  const forced = await request('GET', '/reviews?count=6&refresh=1', { admin: true });
  assert.equal(forced.status, 500);
  assert.equal(forced.body.detail, 'deferred');

  const calls = await upstreamCalls();
  assert.deepEqual(calls.map((call) => call.kind), ['lease']);
  assert.match(server.output(), /\[reviews\] Refresh finished: id=\S+, result=failed, error=limiter_deferred, pages=0, requests=0, /);

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
  // Неуспешная попытка тоже пишет итог: причина и время ответа yClients.
  assert.match(server.output(), /\[reviews\] Refresh finished: id=\S+, result=failed, error=yclients_status_429, pages=1, requests=2, slowest_yclients_ms=\d+, slowest_lease_wait_ms=\d+, duration_ms=\d+/);
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
