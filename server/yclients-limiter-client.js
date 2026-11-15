'use strict';

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_BACKGROUND_TIMEOUT_MS = 45000;
const DEFAULT_LOCAL_INTERVAL_MS = 350;
const localNextPermitAt = new Map();

class YclientsLimiterClientError extends Error {
  constructor(code, retryAfterMs = 0) {
    super(code);
    this.name = 'YclientsLimiterClientError';
    this.code = code;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bodySha256(body) {
  return crypto.createHash('sha256').update(stableJson(body), 'utf8').digest('hex');
}

function signWriteRequest(pathname, timestamp, nonce, bodyHash, secret) {
  const canonical = `POST\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
  return crypto
    .createHmac('sha256', `yclients-rate-limiter-v1:${String(secret || '')}`)
    .update(canonical, 'utf8')
    .digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function normalizedMode(value) {
  const mode = String(value || 'required').trim().toLowerCase();
  return ['required', 'degraded', 'off'].includes(mode) ? mode : 'required';
}

function positiveInteger(value, fallback, minimum = 0, maximum = 600000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function positiveNumber(value, fallback, minimum = 0, maximum = 600000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function retryAfterMs(headers, body) {
  const bodyValue = Number(body?.retry_after_ms);
  if (Number.isFinite(bodyValue) && bodyValue > 0) return Math.floor(bodyValue);
  const headerValue = headers && (headers.get ? headers.get('retry-after') : headers['retry-after']);
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : 0;
}

class YclientsLimiterClient {
  constructor(environment = process.env, options = {}) {
    this.endpoint = String(environment.YCLIENTS_LIMITER_URL || '').replace(/\/$/, '');
    this.secret = String(environment.YCLIENTS_LIMITER_INTERNAL_SECRET || '');
    this.mode = normalizedMode(environment.YCLIENTS_LIMITER_MODE);
    this.source = String(options.source || environment.YCLIENTS_LIMITER_SOURCE || 'course-booking.api');
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = positiveInteger(environment.YCLIENTS_LIMITER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 10000);
    this.backgroundTimeoutMs = positiveInteger(
      environment.YCLIENTS_LIMITER_BACKGROUND_TIMEOUT_MS,
      this.timeoutMs,
      250,
      MAX_BACKGROUND_TIMEOUT_MS
    );
    this.localIntervalMs = positiveNumber(
      environment.YCLIENTS_REQUEST_INTERVAL_SECONDS,
      DEFAULT_LOCAL_INTERVAL_MS / 1000,
      0,
      60
    ) * 1000 || DEFAULT_LOCAL_INTERVAL_MS;
  }

  async _localLease(priority) {
    const key = `${this.source}:${priority}`;
    const now = Date.now();
    const permittedAt = Math.max(now, Number(localNextPermitAt.get(key) || 0));
    localNextPermitAt.set(key, permittedAt + this.localIntervalMs);
    if (permittedAt > now) await delay(permittedAt - now);
    return { local: true };
  }

  _canUseBookingFallback(priority, error) {
    return this.mode === 'degraded' && priority === 'booking' && error.code === 'limiter_unavailable';
  }

  async _call(pathname, body, timeoutMs = this.timeoutMs) {
    if (!this.endpoint || !this.secret) throw new YclientsLimiterClientError('limiter_unavailable');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const bodyHash = bodySha256(body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MBS-YClients-Limiter-Timestamp': timestamp,
          'X-MBS-YClients-Limiter-Nonce': nonce,
          'X-MBS-YClients-Limiter-Body-SHA256': bodyHash,
          'X-MBS-YClients-Limiter-Signature': signWriteRequest(pathname, timestamp, nonce, bodyHash, this.secret),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new YclientsLimiterClientError(
          responseBody.status === 'deferred' ? 'deferred' : 'limiter_unavailable',
          retryAfterMs(response.headers, responseBody)
        );
      }
      return responseBody;
    } catch (error) {
      if (error instanceof YclientsLimiterClientError) throw error;
      throw new YclientsLimiterClientError('limiter_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  async acquire(priority = 'booking') {
    if (this.mode === 'off') return this._localLease(priority);
    try {
      const timeoutMs = priority === 'background' ? this.backgroundTimeoutMs : this.timeoutMs;
      const response = await this._call('/lease', { source: this.source, priority }, timeoutMs);
      if (!response.lease_id) throw new YclientsLimiterClientError('limiter_unavailable');
      return { leaseId: response.lease_id, local: false };
    } catch (error) {
      if (this._canUseBookingFallback(priority, error)) return this._localLease(priority);
      throw error;
    }
  }

  async reportRateLimit(lease, retryAfterMilliseconds) {
    if (!lease || lease.local) return;
    try {
      await this._call('/report', {
        lease_id: lease.leaseId,
        outcome: 'rate_limited',
        retry_after_ms: positiveInteger(retryAfterMilliseconds, 10000, 1000, 10 * 60 * 1000),
      });
    } catch (_) {
      // The upstream 429 is still returned to the caller. A failed report must
      // not trigger a blind retry of a booking write.
    }
  }

  async run(priority, operation) {
    const lease = await this.acquire(priority);
    const response = await operation();
    if (response && Number(response.status) === 429) {
      await this.reportRateLimit(lease, retryAfterMs(response.headers, null) || 10000);
    }
    return response;
  }
}

module.exports = {
  YclientsLimiterClient,
  YclientsLimiterClientError,
  bodySha256,
  signWriteRequest,
};
