'use strict';

// Единственная точка выхода сервиса отзывов в API yClients.
// Каждый HTTP-запрос сначала получает разрешение (lease) общего лимитера
// YClients-Dashboard. Без разрешения запрос не отправляется.

const { YclientsLimiterClient, YclientsLimiterClientError } = require('./yclients-limiter-client');

const LIMITER_SOURCE = 'reviews.snapshot';
const LIMITER_PRIORITY = 'background';

// Срок жизни lease. Report о 429 по истёкшему lease лимитер отклоняет как
// unknown_lease, и cooldown не включается. Поэтому ответ yClients ждём только
// до момента «срок lease минус запас на отправку report».
//
// Срок берётся из ответа лимитера (`expires_at_ms`): он отсчитан от выдачи
// lease на сервере, поэтому время доставки ответа /lease уже учтено. Сверху
// он ограничен 15 секундами от получения ответа — значением leaseTtlMs по
// умолчанию; так расхождение часов не может дать запросу лишнее время.
const LEASE_TTL_MS = 15000;
// Запас на отправку report: таймаут вызова лимитера в клиенте по умолчанию 2 с.
const REPORT_RESERVE_MS = 3000;
// Если на запрос осталось меньше, он не отправляется вовсе.
const MIN_REQUEST_BUDGET_MS = 1000;
// Наибольшее ожидание ответа yClients: 15 с − 3 с.
const MAX_REQUEST_TIMEOUT_MS = LEASE_TTL_MS - REPORT_RESERVE_MS;

// Режим всегда required: значение YCLIENTS_LIMITER_MODE=off или degraded в .env
// не должно возвращать сервису прямой путь в yClients мимо общего учёта.
//
// Клиент лимитера — неизменяемая копия и возвращает только lease_id. Срок
// lease читается из того же ответа /lease обёрткой над fetch: протокол и
// подпись запросов при этом не меняются.
function createReviewsLimiter(environment = process.env, options = {}) {
  const leaseDeadlines = new Map();
  const baseFetch = options.fetchImpl;
  const observingFetch = async (url, init) => {
    const response = await (baseFetch || fetch)(url, init);
    if (response && response.ok && String(url).endsWith('/lease')) {
      const receivedAt = Date.now();
      const body = await response.clone().json().catch(() => null);
      if (body && body.lease_id) {
        const expiresAt = Number(body.expires_at_ms);
        if (leaseDeadlines.size > 100) leaseDeadlines.clear();
        leaseDeadlines.set(String(body.lease_id), {
          receivedAt,
          expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
        });
      }
    }
    return response;
  };
  const limiter = new YclientsLimiterClient(
    { ...environment, YCLIENTS_LIMITER_MODE: 'required' },
    { source: LIMITER_SOURCE, fetchImpl: observingFetch }
  );
  // Момент по местным часам, после которого report по этому lease уже не примут.
  limiter.takeLeaseDeadline = (lease, ttlMs = LEASE_TTL_MS) => {
    const key = lease && lease.leaseId ? String(lease.leaseId) : '';
    const seen = leaseDeadlines.get(key);
    leaseDeadlines.delete(key);
    if (!seen) return Date.now() + ttlMs;
    const byReceipt = seen.receivedAt + ttlMs;
    return seen.expiresAt === null ? byReceipt : Math.min(seen.expiresAt, byReceipt);
  };
  return limiter;
}

function isLimiterRefusal(error) {
  return error instanceof YclientsLimiterClientError;
}

function rateLimitRetryAfterMs(response) {
  const header = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : 10000;
}

// Параметр timing нужен только тестам и ручной проверке на настоящем лимитере
// в уменьшенном масштабе времени. В server.js он не передаётся.
function createYclientsFetch({ limiter, authorization, fetchImpl, logger = console, timing = {} } = {}) {
  if (!limiter) throw new Error('yclients-fetch: limiter is required');
  const leaseTtlMs = timing.leaseTtlMs || LEASE_TTL_MS;
  const reportReserveMs = timing.reportReserveMs || REPORT_RESERVE_MS;
  const minRequestBudgetMs = timing.minRequestBudgetMs || MIN_REQUEST_BUDGET_MS;

  // opts.onTiming({ leaseWaitMs, requestMs, status, aborted }) вызывается после
  // каждого отправленного запроса. requestMs — только время от отправки в
  // yClients до ответа; ожидание lease в очереди лимитера считается отдельно.
  return async function yclientsFetch(url, opts = {}) {
    let lease;
    let budgetMs;
    const acquireStartedAt = Date.now();
    try {
      // Отказ в lease бросает ошибку до отправки запроса; report при этом не шлётся.
      lease = await limiter.acquire(LIMITER_PRIORITY);
      const deadline = typeof limiter.takeLeaseDeadline === 'function'
        ? limiter.takeLeaseDeadline(lease, leaseTtlMs)
        : Date.now() + leaseTtlMs;
      budgetMs = deadline - reportReserveMs - Date.now();
      // Lease пришёл слишком поздно: ответить и сообщить о 429 уже не успеть.
      if (budgetMs < minRequestBudgetMs) throw new YclientsLimiterClientError('lease_expiring');
    } catch (error) {
      if (isLimiterRefusal(error)) {
        logger.warn('[yclients] Request not sent: limiter refused lease (' + error.code + ')');
      }
      throw error;
    }

    const headers = {
      'Accept': 'application/vnd.yclients.v2+json',
      'Content-Type': 'application/json',
      'Authorization': typeof authorization === 'function' ? authorization() : String(authorization || ''),
      ...opts.headers
    };
    // Вызывающий код может сократить ожидание, но не продлить его за срок lease.
    const requested = Number(opts.timeout) > 0 ? Number(opts.timeout) : budgetMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(requested, budgetMs));
    const requestStartedAt = Date.now();
    const leaseWaitMs = requestStartedAt - acquireStartedAt;
    const reportTiming = (extra) => {
      if (typeof opts.onTiming !== 'function') return;
      try { opts.onTiming({ leaseWaitMs, requestMs: Date.now() - requestStartedAt, ...extra }); } catch (_) { /* учёт не влияет на запрос */ }
    };
    let response;
    try {
      response = await (fetchImpl || fetch)(url, { method: opts.method || 'GET', headers, signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        logger.warn('[yclients] Request aborted after ' + (Date.now() - requestStartedAt) + ' ms without a response (lease wait ' + leaseWaitMs + ' ms)');
      }
      reportTiming({ status: null, aborted });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    reportTiming({ status: Number(response && response.status) || null, aborted: false });
    if (response && Number(response.status) === 429) {
      await limiter.reportRateLimit(lease, rateLimitRetryAfterMs(response));
    }
    return response;
  };
}

module.exports = {
  LEASE_TTL_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_BUDGET_MS,
  REPORT_RESERVE_MS,
  LIMITER_PRIORITY,
  LIMITER_SOURCE,
  createReviewsLimiter,
  createYclientsFetch,
  isLimiterRefusal,
};
