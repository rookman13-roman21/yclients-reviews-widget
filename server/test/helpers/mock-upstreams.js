'use strict';

// Подключается через `node --require` перед server.js в интеграционном тесте.
// Подменяет global fetch: адреса лимитера и api.yclients.ru обслуживаются
// в памяти, наружу не уходит ни один запрос. Состоянием управляет тест по IPC.

const LIMITER_URL = process.env.YCLIENTS_LIMITER_URL;
const PAGE_SIZE = 200;

const state = { limiter: 'grant', yclients: 'ok', reviews: 0, timeOffsetMs: 0 };
const calls = [];
let leaseCounter = 0;

const realNow = Date.now.bind(Date);
Date.now = () => realNow() + state.timeOffsetMs;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function review(index) {
  return {
    id: 1000 + index,
    master_id: 77,
    master_name: 'Тестовый Наставник',
    user_name: 'Гость',
    rating: 5,
    date: '2026-11-01 10:00:00',
    text: 'Очень понравилось занятие, спасибо большое, номер ' + index,
  };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);

  if (target === `${LIMITER_URL}/lease`) {
    calls.push({ kind: 'lease', body: JSON.parse(init.body) });
    if (state.limiter === 'deferred') return json(429, { status: 'deferred', retry_after_ms: 5000 });
    if (state.limiter === 'down') throw new Error('connect ECONNREFUSED');
    leaseCounter += 1;
    return json(200, { lease_id: 'lease-' + leaseCounter });
  }

  if (target === `${LIMITER_URL}/report`) {
    calls.push({ kind: 'report', body: JSON.parse(init.body) });
    return json(200, { ok: true });
  }

  if (target.startsWith('https://api.yclients.ru/')) {
    const parsed = new URL(target);
    calls.push({ kind: 'yclients', path: parsed.pathname, page: parsed.searchParams.get('page') });
    if (state.yclients === '429') return json(429, { success: false }, { 'Retry-After': '7' });
    if (parsed.pathname.includes('/comments/')) {
      const page = Number(parsed.searchParams.get('page') || 1);
      const start = (page - 1) * PAGE_SIZE;
      const data = [];
      for (let i = start; i < Math.min(state.reviews, start + PAGE_SIZE); i += 1) data.push(review(i));
      return json(200, { success: true, data });
    }
    return json(200, { success: true, data: [{ id: 77, name: 'Тестовый Наставник' }] });
  }

  throw new Error('mock-upstreams: unexpected outbound request to ' + new URL(target).host);
};

process.on('message', (message) => {
  if (message.type === 'set') Object.assign(state, message.state);
  if (message.type === 'reset-calls') calls.length = 0;
  process.send({ id: message.id, calls: calls.slice() });
});
