'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { YclientsLimiterClientError, signWriteRequest, bodySha256 } = require('../yclients-limiter-client');
const {
  LEASE_TTL_MS,
  MAX_REQUEST_TIMEOUT_MS,
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

// Lease живёт 15 секунд. Если ждать ответа yClients дольше, report о позднем 429
// лимитер отклонит как unknown_lease и cooldown не включится.

function slowYclients({ answerAfterMs, status = 429 }) {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    const target = String(url);
    if (target === `${LIMITER_URL}/lease`) {
      calls.push({ kind: 'lease', at: Date.now() });
      return Promise.resolve(jsonResponse(200, { lease_id: 'lease-slow' }));
    }
    if (target === `${LIMITER_URL}/report`) {
      calls.push({ kind: 'report', at: Date.now(), body: JSON.parse(init.body) });
      return Promise.resolve(jsonResponse(200, { ok: true }));
    }
    calls.push({ kind: 'yclients', at: Date.now() });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(status, {}, { 'Retry-After': '7' })), answerAfterMs);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        calls.push({ kind: 'aborted', at: Date.now() });
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
  };
  const limiter = createReviewsLimiter({
    YCLIENTS_LIMITER_URL: LIMITER_URL,
    YCLIENTS_LIMITER_INTERNAL_SECRET: 'test-secret',
  }, { fetchImpl });
  return { calls, fetchImpl, limiter };
}

test('request timeout cap is shorter than the lease lifetime', () => {
  assert.equal(LEASE_TTL_MS, 15000);
  assert.equal(MAX_REQUEST_TIMEOUT_MS, 12000);
  assert.ok(MAX_REQUEST_TIMEOUT_MS + 2000 <= LEASE_TTL_MS, 'at least 2 s remain for the report');
});

test('a caller cannot wait for yClients longer than the cap: the request is aborted before the lease expires', async () => {
  // Масштаб 1:100: предел 120 мс вместо 12 с, вызывающий просит 20 с, как обновление отзывов.
  const h = slowYclients({ answerAfterMs: 5000 });
  const yclientsFetch = createYclientsFetch({
    limiter: h.limiter, authorization: 'Bearer test', fetchImpl: h.fetchImpl, logger: silentLogger, maxRequestTimeoutMs: 120,
  });

  await assert.rejects(yclientsFetch(YCLIENTS_URL, { timeout: 20000 }), (error) => !isLimiterRefusal(error) && error.name === 'AbortError');

  assert.deepEqual(h.calls.map((call) => call.kind), ['lease', 'yclients', 'aborted']);
  const waited = h.calls[2].at - h.calls[1].at;
  assert.ok(waited >= 100 && waited < 1500, 'aborted at the cap, waited ' + waited + ' ms');
});

test('a 429 that arrives just before the cap is still reported within the lease lifetime', async () => {
  const h = slowYclients({ answerAfterMs: 80 });
  const yclientsFetch = createYclientsFetch({
    limiter: h.limiter, authorization: 'Bearer test', fetchImpl: h.fetchImpl, logger: silentLogger, maxRequestTimeoutMs: 120,
  });

  const response = await yclientsFetch(YCLIENTS_URL, { timeout: 20000 });

  assert.equal(response.status, 429);
  assert.deepEqual(h.calls.map((call) => call.kind), ['lease', 'yclients', 'report']);
  assert.equal(h.calls[2].body.lease_id, 'lease-slow');
  // В том же масштабе lease живёт 150 мс: report уходит раньше.
  assert.ok(h.calls[2].at - h.calls[0].at < 150, 'report sent ' + (h.calls[2].at - h.calls[0].at) + ' ms after the lease');
});

test('the cap cannot be raised above 12 s and a shorter caller timeout is respected', async () => {
  const h = slowYclients({ answerAfterMs: 5000 });
  const yclientsFetch = createYclientsFetch({
    limiter: h.limiter, authorization: 'Bearer test', fetchImpl: h.fetchImpl, logger: silentLogger, maxRequestTimeoutMs: 600000,
  });

  await assert.rejects(yclientsFetch(YCLIENTS_URL, { timeout: 60 }), { name: 'AbortError' });
  const waited = h.calls[2].at - h.calls[1].at;
  assert.ok(waited < 1500, 'caller timeout of 60 ms applied, waited ' + waited + ' ms');
});
