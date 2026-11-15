'use strict';

// Единственная точка выхода сервиса отзывов в API yClients.
// Каждый HTTP-запрос сначала получает разрешение (lease) общего лимитера
// YClients-Dashboard. Без разрешения запрос не отправляется.

const { YclientsLimiterClient, YclientsLimiterClientError } = require('./yclients-limiter-client');

const LIMITER_SOURCE = 'reviews.snapshot';
const LIMITER_PRIORITY = 'background';

// Lease общего лимитера живёт 15 секунд (leaseTtlMs в YClients-Dashboard).
// Report о 429 по истёкшему lease лимитер отклоняет как unknown_lease, и
// cooldown не включается. Поэтому запрос в yClients не ждёт ответа дольше
// 12 секунд: ответ 429 и report по нему укладываются в срок жизни lease.
// Вызывающий код может задать таймаут короче, но не длиннее.
const LEASE_TTL_MS = 15000;
const MAX_REQUEST_TIMEOUT_MS = 12000;

// Режим всегда required: значение YCLIENTS_LIMITER_MODE=off или degraded в .env
// не должно возвращать сервису прямой путь в yClients мимо общего учёта.
function createReviewsLimiter(environment = process.env, options = {}) {
  return new YclientsLimiterClient(
    { ...environment, YCLIENTS_LIMITER_MODE: 'required' },
    { source: LIMITER_SOURCE, fetchImpl: options.fetchImpl }
  );
}

function isLimiterRefusal(error) {
  return error instanceof YclientsLimiterClientError;
}

function createYclientsFetch({
  limiter,
  authorization,
  fetchImpl,
  logger = console,
  maxRequestTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!limiter) throw new Error('yclients-fetch: limiter is required');
  const timeoutCapMs = Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Number(maxRequestTimeoutMs) || MAX_REQUEST_TIMEOUT_MS));

  return async function yclientsFetch(url, opts = {}) {
    const send = () => {
      const headers = {
        'Accept': 'application/vnd.yclients.v2+json',
        'Content-Type': 'application/json',
        'Authorization': typeof authorization === 'function' ? authorization() : String(authorization || ''),
        ...opts.headers
      };
      // Таймаут считается от отправки запроса, а не от ожидания разрешения.
      const controller = new AbortController();
      const requested = Number(opts.timeout) > 0 ? Number(opts.timeout) : timeoutCapMs;
      const timeout = setTimeout(() => controller.abort(), Math.min(requested, timeoutCapMs));
      return (fetchImpl || fetch)(url, { method: opts.method || 'GET', headers, signal: controller.signal })
        .finally(() => clearTimeout(timeout));
    };

    try {
      // run(): lease → запрос → при ответе 429 отправляет report по этому lease.
      // Отказ в lease бросает ошибку до вызова send(), report при этом не шлётся.
      return await limiter.run(LIMITER_PRIORITY, send);
    } catch (error) {
      if (isLimiterRefusal(error)) {
        logger.warn('[yclients] Request not sent: limiter refused lease (' + error.code + ')');
      }
      throw error;
    }
  };
}

module.exports = {
  LEASE_TTL_MS,
  MAX_REQUEST_TIMEOUT_MS,
  LIMITER_PRIORITY,
  LIMITER_SOURCE,
  createReviewsLimiter,
  createYclientsFetch,
  isLimiterRefusal,
};
