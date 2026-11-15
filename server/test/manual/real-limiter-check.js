'use strict';

// Ручная проверка на настоящем коде общего лимитера (тред 0810, пакет 1).
// В `npm test` не входит: нужен исходный код YClients-Dashboard.
//
//   DASHBOARD_SRC=/path/to/YClients-Dashboard/src node test/manual/real-limiter-check.js
//
// Поднимает на 127.0.0.1 настоящие маршруты и настоящий YclientsRateLimiter
// (подпись HMAC, выдача и истечение lease, приём report) со сроком lease 3 с
// вместо 15. yClients подменён. Задержки доставки lease и report вносятся
// между клиентом и лимитером. В сеть наружу ничего не уходит.

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { createReviewsLimiter, createYclientsFetch, isLimiterRefusal } = require('../../yclients-fetch');

const dashboardSrc = process.env.DASHBOARD_SRC;
if (!dashboardSrc) {
  console.error('Set DASHBOARD_SRC to the src directory of a YClients-Dashboard checkout.');
  process.exit(2);
}
const { YclientsRateLimiter } = require(path.join(dashboardSrc, 'yclients-rate-limiter'));
const { mountYclientsLimiterRoutes } = require(path.join(dashboardSrc, 'yclients-rate-limiter-routes'));

const SECRET = 'manual-check-secret';
// Масштаб 1:5 к production: lease 3 с (15), запас на report 600 мс (3 с), минимум 200 мс (1 с).
const TIMING = { leaseTtlMs: 3000, reportReserveMs: 600, minRequestBudgetMs: 200 };
const YCLIENTS_URL = 'https://api.yclients.ru/api/v1/comments/1/?page=1&count=200';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scenario(name, { leaseDelayMs = 0, reportDelayMs = 0, answerAfterMs, timeout = 20000 }, check) {
  const limiter = new YclientsRateLimiter({ leaseTtlMs: TIMING.leaseTtlMs, minIntervalMs: 50 });
  const app = express();
  app.use(express.json());
  mountYclientsLimiterRoutes(app, { limiter, env: { YCLIENTS_LIMITER_INTERNAL_SECRET: SECRET } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/internal/yclients-limiter/v1`;

  const log = [];
  const startedAt = Date.now();
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith(base)) {
      if (target.endsWith('/report')) await sleep(reportDelayMs);
      const response = await fetch(url, init);
      if (target.endsWith('/lease')) await sleep(leaseDelayMs);
      if (target.endsWith('/report')) log.push({ kind: 'report', httpStatus: response.status, atMs: Date.now() - startedAt });
      return response;
    }
    log.push({ kind: 'yclients', atMs: Date.now() - startedAt });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } })), answerAfterMs);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        log.push({ kind: 'aborted', atMs: Date.now() - startedAt });
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };

  const client = createReviewsLimiter({
    YCLIENTS_LIMITER_URL: base,
    YCLIENTS_LIMITER_INTERNAL_SECRET: SECRET,
    // Как в production .env: фоновый lease ждём до 35 с.
    YCLIENTS_LIMITER_BACKGROUND_TIMEOUT_MS: '35000',
  }, { fetchImpl });
  const yclientsFetch = createYclientsFetch({ limiter: client, authorization: 'Bearer manual', fetchImpl, logger: { warn() {} }, timing: TIMING });

  let outcome;
  try {
    const response = await yclientsFetch(YCLIENTS_URL, { timeout });
    outcome = 'status ' + response.status;
  } catch (error) {
    outcome = isLimiterRefusal(error) ? 'refused: ' + error.code : 'error: ' + error.name;
  }
  const now = Date.now();
  const result = {
    outcome,
    log,
    metrics: { ...limiter.metrics },
    cooldownActive: limiter.cooldownUntil > now,
  };
  limiter.close();
  await new Promise((resolve) => server.close(resolve));

  check(result);
  console.log('ok  ' + name);
  console.log('    ' + outcome + ' | ' + log.map((entry) => `${entry.kind}${entry.httpStatus ? ' ' + entry.httpStatus : ''}@${entry.atMs}ms`).join(', ')
    + ` | rateLimited=${result.metrics.rateLimited} invalidReports=${result.metrics.invalidReports} cooldown=${result.cooldownActive}`);
}

(async () => {
  await scenario('429 без задержек: report принят, cooldown включён', { answerAfterMs: 300 }, (r) => {
    assert.equal(r.outcome, 'status 429');
    assert.equal(r.metrics.rateLimited, 1);
    assert.equal(r.metrics.invalidReports, 0);
    assert.equal(r.cooldownActive, true);
  });

  await scenario('lease шёл 1 с, 429 на пределе бюджета: report принят', { leaseDelayMs: 1000, answerAfterMs: 1300 }, (r) => {
    assert.equal(r.outcome, 'status 429');
    assert.equal(r.metrics.rateLimited, 1);
    assert.equal(r.metrics.invalidReports, 0);
    assert.equal(r.cooldownActive, true);
  });

  await scenario('lease шёл 1 с, report шёл 500 мс: report принят', { leaseDelayMs: 1000, reportDelayMs: 500, answerAfterMs: 1300 }, (r) => {
    assert.equal(r.outcome, 'status 429');
    assert.equal(r.metrics.rateLimited, 1);
    assert.equal(r.metrics.invalidReports, 0);
  });

  await scenario('lease шёл 1 с, yClients молчит: запрос прерван до истечения lease, отклонённых report нет', { leaseDelayMs: 1000, answerAfterMs: 10000 }, (r) => {
    assert.equal(r.outcome, 'error: AbortError');
    assert.ok(r.log.find((entry) => entry.kind === 'aborted').atMs <= TIMING.leaseTtlMs - TIMING.reportReserveMs + 150);
    assert.equal(r.metrics.rateLimited, 0);
    assert.equal(r.metrics.invalidReports, 0);
  });

  await scenario('lease шёл 2,7 с из 3: запрос в yClients не отправлен', { leaseDelayMs: 2700, answerAfterMs: 100 }, (r) => {
    assert.equal(r.outcome, 'refused: lease_expiring');
    assert.equal(r.log.length, 0);
    assert.equal(r.metrics.invalidReports, 0);
  });

  console.log('all scenarios passed');
})().catch((error) => {
  console.error('FAILED:', error && error.message);
  process.exit(1);
});
