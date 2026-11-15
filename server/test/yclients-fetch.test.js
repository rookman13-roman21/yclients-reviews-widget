'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { YclientsLimiterClientError, signWriteRequest, bodySha256 } = require('../yclients-limiter-client');
const {
  LEASE_TTL_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_BUDGET_MS,
  REPORT_RESERVE_MS,
  LIMITER_PRIORITY,
  LIMITER_SOURCE,
  createReviewsLimiter,
  createYclientsFetch,
  isLimiterRefusal,
} = require('../yclients-fetch');

const LIMITER_URL = 'http://limiter.test/v1';
const YCLIENTS_URL = 'https://api.yclients.ru/api/v1/comments/1/?page=1&count=200';
const silentLogger = { warn() {} };

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Один поддельный fetch на оба адреса: лимитер и yClients. Журнал вызовов общий,
// поэтому тест видит порядок «lease → запрос → report».
function harness({ lease = () => jsonResponse(200, { lease_id: 'lease-1' }), yclients = () => jsonResponse(200, { data: [] }) } = {}) {
  const calls = [];
  let leaseCounter = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === `${LIMITER_URL}/lease`) {
      leaseCounter += 1;
      calls.push({ kind: 'lease', body: JSON.parse(init.body), headers: init.headers });
      return lease(leaseCounter);
    }
    if (target === `${LIMITER_URL}/report`) {
      calls.push({ kind: 'report', body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true });
    }
    if (target.startsWith('https://api.yclients.ru/')) {
      calls.push({ kind: 'yclients', url: target, headers: init.headers, method: init.method });
      return yclients(target);
    }
    throw new Error('unexpected fetch ' + target);
  };
  const limiter = createReviewsLimiter({
    YCLIENTS_LIMITER_URL: LIMITER_URL,
    YCLIENTS_LIMITER_INTERNAL_SECRET: 'test-secret',
    YCLIENTS_LIMITER_MODE: 'off',
  }, { fetchImpl });
  const yclientsFetch = createYclientsFetch({ limiter, authorization: () => 'Bearer test', fetchImpl, logger: silentLogger });
  return { calls, limiter, yclientsFetch, kinds: () => calls.map((call) => call.kind) };
}

test('lease is taken before every yClients request with the reviews source and background priority', async () => {
  const h = harness({ lease: (n) => jsonResponse(200, { lease_id: 'lease-' + n }) });

  const first = await h.yclientsFetch(YCLIENTS_URL, { timeout: 5000 });
  const second = await h.yclientsFetch(YCLIENTS_URL.replace('page=1', 'page=2'));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'lease', 'yclients']);
  assert.deepEqual(h.calls[0].body, { source: LIMITER_SOURCE, priority: LIMITER_PRIORITY });
  assert.equal(LIMITER_SOURCE, 'reviews.snapshot');
  assert.equal(LIMITER_PRIORITY, 'background');
  assert.equal(h.calls[1].headers.Authorization, 'Bearer test');
  assert.equal(h.calls[1].method, 'GET');
});

test('lease request keeps the shared HMAC protocol', async () => {
  const h = harness();
  await h.yclientsFetch(YCLIENTS_URL);

  const { headers, body } = h.calls[0];
  const expected = signWriteRequest(
    '/lease',
    headers['X-MBS-YClients-Limiter-Timestamp'],
    headers['X-MBS-YClients-Limiter-Nonce'],
    bodySha256(body),
    'test-secret'
  );
  assert.equal(headers['X-MBS-YClients-Limiter-Body-SHA256'], bodySha256(body));
  assert.equal(headers['X-MBS-YClients-Limiter-Signature'], expected);
});

test('mode is always required: YCLIENTS_LIMITER_MODE=off cannot bypass the limiter', async () => {
  const h = harness({ lease: () => jsonResponse(503, {}) });
  assert.equal(h.limiter.mode, 'required');

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL), isLimiterRefusal);
  assert.deepEqual(h.kinds(), ['lease']);
});

test('deferred lease: request is not sent and no report is made', async () => {
  const h = harness({ lease: () => jsonResponse(429, { status: 'deferred', retry_after_ms: 4000 }) });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL), (error) => {
    assert.ok(error instanceof YclientsLimiterClientError);
    assert.equal(error.code, 'deferred');
    assert.equal(error.retryAfterMs, 4000);
    return true;
  });
  assert.deepEqual(h.kinds(), ['lease']);
});

test('limiter unavailable (network error): request is not sent and no report is made', async () => {
  const h = harness({ lease: () => { throw new Error('ECONNREFUSED'); } });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL), (error) => isLimiterRefusal(error) && error.code === 'limiter_unavailable');
  assert.deepEqual(h.kinds(), ['lease']);
});

test('limiter not configured: request is not sent and the limiter is not called', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return jsonResponse(200, {}); };
  const limiter = createReviewsLimiter({}, { fetchImpl });
  const yclientsFetch = createYclientsFetch({ limiter, authorization: 'Bearer test', fetchImpl, logger: silentLogger });

  await assert.rejects(yclientsFetch(YCLIENTS_URL), (error) => isLimiterRefusal(error) && error.code === 'limiter_unavailable');
  assert.deepEqual(calls, []);
});

test('real yClients 429: report is sent for the lease and the response is returned', async () => {
  const h = harness({
    lease: () => jsonResponse(200, { lease_id: 'lease-429' }),
    yclients: () => jsonResponse(429, { success: false }, { 'Retry-After': '7' }),
  });

  const response = await h.yclientsFetch(YCLIENTS_URL);

  assert.equal(response.status, 429);
  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'report']);
  assert.deepEqual(h.calls[2].body, { lease_id: 'lease-429', outcome: 'rate_limited', retry_after_ms: 7000 });
});

test('real yClients 429 without Retry-After reports the default 10 s', async () => {
  const h = harness({ yclients: () => jsonResponse(429, {}) });

  await h.yclientsFetch(YCLIENTS_URL);

  assert.equal(h.calls[2].kind, 'report');
  assert.equal(h.calls[2].body.retry_after_ms, 10000);
});

test('other yClients errors and network failures send no report', async () => {
  const serverError = harness({ yclients: () => jsonResponse(500, {}) });
  assert.equal((await serverError.yclientsFetch(YCLIENTS_URL)).status, 500);
  assert.deepEqual(serverError.kinds(), ['lease', 'yclients']);

  const network = harness({ yclients: () => { throw new Error('socket hang up'); } });
  await assert.rejects(network.yclientsFetch(YCLIENTS_URL), (error) => !isLimiterRefusal(error) && /socket hang up/.test(error.message));
  assert.deepEqual(network.kinds(), ['lease', 'yclients']);
});

// ─── Срок жизни lease ───────────────────────────────────────────────────────
// Report о 429 по истёкшему lease лимитер отклоняет (unknown_lease), cooldown
// не включается. Тесты идут в масштабе 1:50: lease 300 мс вместо 15 с, запас
// на report 60 мс вместо 3 с, наименьший бюджет запроса 20 мс вместо 1 с.

const SCALED = { leaseTtlMs: 300, reportReserveMs: 60, minRequestBudgetMs: 20 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Поддельный лимитер с настоящим правилом срока: lease выдан в момент grantedAt,
// report позже grantedAt + ttl отклоняется как unknown_lease.
function timedHarness({ leaseDelayMs = 0, reportDelayMs = 0, yclientsAnswerAfterMs = 0, yclientsStatus = 429, sendExpiry = true, clockSkewMs = 0 } = {}) {
  const calls = [];
  let grantedAt = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === `${LIMITER_URL}/lease`) {
      grantedAt = Date.now();
      calls.push({ kind: 'lease' });
      await sleep(leaseDelayMs); // доставка ответа /lease
      const body = { lease_id: 'lease-timed' };
      if (sendExpiry) body.expires_at_ms = grantedAt + SCALED.leaseTtlMs + clockSkewMs;
      return jsonResponse(200, body);
    }
    if (target === `${LIMITER_URL}/report`) {
      await sleep(reportDelayMs); // доставка report
      const accepted = Date.now() <= grantedAt + SCALED.leaseTtlMs;
      calls.push({ kind: accepted ? 'report-accepted' : 'report-rejected', afterGrantMs: Date.now() - grantedAt });
      return accepted ? jsonResponse(200, { ok: true, status: 'cooldown_set' }) : jsonResponse(409, { ok: false, status: 'unknown_lease' });
    }
    calls.push({ kind: 'yclients', afterGrantMs: Date.now() - grantedAt });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(yclientsStatus, {}, { 'Retry-After': '7' })), yclientsAnswerAfterMs);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        calls.push({ kind: 'aborted', afterGrantMs: Date.now() - grantedAt });
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
  };
  const limiter = createReviewsLimiter({
    YCLIENTS_LIMITER_URL: LIMITER_URL,
    YCLIENTS_LIMITER_INTERNAL_SECRET: 'test-secret',
  }, { fetchImpl });
  const yclientsFetch = createYclientsFetch({ limiter, authorization: 'Bearer test', fetchImpl, logger: silentLogger, timing: SCALED });
  return { calls, yclientsFetch, kinds: () => calls.map((call) => call.kind) };
}

test('production timing: the request budget plus the report reserve equals the lease lifetime', () => {
  assert.equal(LEASE_TTL_MS, 15000);
  assert.equal(REPORT_RESERVE_MS, 3000);
  assert.equal(MAX_REQUEST_TIMEOUT_MS, 12000);
  assert.equal(MIN_REQUEST_BUDGET_MS, 1000);
});

test('caller asks for 20 s, yClients is silent: aborted before the lease expires, no report', async () => {
  const h = timedHarness({ yclientsAnswerAfterMs: 5000 });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 }), { name: 'AbortError' });

  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'aborted']);
  assert.ok(h.calls[2].afterGrantMs <= SCALED.leaseTtlMs - SCALED.reportReserveMs + 25, 'aborted ' + h.calls[2].afterGrantMs + ' ms after the grant');
});

test('slow lease delivery shortens the request budget: a late 429 is still reported in time', async () => {
  // Lease шёл 150 мс из 300. Прежний фиксированный предел (240 мс от получения)
  // дождался бы ответа на 380-й мс и опоздал с report.
  const h = timedHarness({ leaseDelayMs: 150, yclientsAnswerAfterMs: 70 });

  const response = await h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 });

  assert.equal(response.status, 429);
  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'report-accepted']);
});

test('slow lease delivery + slow yClients: aborted at the lease-based deadline, not at a fixed cap', async () => {
  const h = timedHarness({ leaseDelayMs: 150, yclientsAnswerAfterMs: 200 });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 }), { name: 'AbortError' });

  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'aborted']);
  assert.ok(h.calls[2].afterGrantMs <= SCALED.leaseTtlMs - SCALED.reportReserveMs + 25, 'aborted ' + h.calls[2].afterGrantMs + ' ms after the grant');
});

test('lease delivered too late: request is not sent and no report is made', async () => {
  const h = timedHarness({ leaseDelayMs: 260 });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL), (error) => isLimiterRefusal(error) && error.code === 'lease_expiring');

  assert.deepEqual(h.kinds(), ['lease']);
});

test('slow report delivery within the reserve is still accepted', async () => {
  const h = timedHarness({ yclientsAnswerAfterMs: 220, reportDelayMs: 40 });

  const response = await h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 });

  assert.equal(response.status, 429);
  assert.deepEqual(h.kinds(), ['lease', 'yclients', 'report-accepted']);
});

test('limiter clock ahead of ours cannot extend the budget beyond the default lifetime', async () => {
  const h = timedHarness({ yclientsAnswerAfterMs: 5000, clockSkewMs: 60000 });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 }), { name: 'AbortError' });

  assert.ok(h.calls[2].afterGrantMs <= SCALED.leaseTtlMs - SCALED.reportReserveMs + 25, 'aborted ' + h.calls[2].afterGrantMs + ' ms after the grant');
});

test('lease response without expires_at_ms falls back to the default lifetime from receipt', async () => {
  const h = timedHarness({ yclientsAnswerAfterMs: 5000, sendExpiry: false });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL, { timeout: 20000 }), { name: 'AbortError' });

  assert.ok(h.calls[2].afterGrantMs <= SCALED.leaseTtlMs - SCALED.reportReserveMs + 25);
});

test('a shorter caller timeout is respected', async () => {
  const h = timedHarness({ yclientsAnswerAfterMs: 5000 });

  await assert.rejects(h.yclientsFetch(YCLIENTS_URL, { timeout: 40 }), { name: 'AbortError' });

  assert.ok(h.calls[2].afterGrantMs < 150, 'aborted ' + h.calls[2].afterGrantMs + ' ms after the grant');
});
