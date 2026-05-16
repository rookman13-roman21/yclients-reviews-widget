// server.js — Express-сервер, полный порт proxy-worker.js с Cloudflare Workers
// Запуск: node server.js
// Зависимости: express, better-sqlite3, cors, dotenv, node-cron

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const KVStore = require('./kv-store');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const YCLIENTS_API_BASE = 'https://api.yclients.com';
const DEFAULT_TTL = 300;

// Env vars (set via .env or system environment)
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const YCLIENTS_PARTNER_TOKEN = process.env.YCLIENTS_PARTNER_TOKEN || '';
const YCLIENTS_USER_TOKEN = process.env.YCLIENTS_USER_TOKEN || '';
const YCLIENTS_COMPANY_ID = process.env.YCLIENTS_COMPANY_ID || '453962';
const YCLIENTS_WEBHOOK_SECRET = process.env.YCLIENTS_WEBHOOK_SECRET || '';
const YCLIENTS_READ_KEY = process.env.YCLIENTS_READ_KEY || '';
const STAFF_REFRESH_INTERVAL_HOURS = Number(process.env.STAFF_REFRESH_INTERVAL_HOURS || 6);
const CRON_CLEAN_LIMIT = Math.min(200, Number(process.env.CRON_CLEAN_LIMIT || 50));
const DISABLE_CRON = process.env.DISABLE_CRON === '1';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://baristaschool.ru,https://www.baristaschool.ru,https://api.baristaschool.ru,https://barista-school.ru,https://www.barista-school.ru,https://api.barista-school.ru').split(',').map(s => s.trim()).filter(Boolean);

// ─── Staff maps (hardcoded fallbacks, same as original) ─────────────────────

const STAFF_MAP = {
  3269178: 'Роман Лунгу',
  2748512: 'Денис Храмов'
};

const NAME_OVERRIDES = {
  'Денис Храмов': 'Денис Ефремов'
};

const ID_OVERRIDES = {
  '2748512': 'Денис Ефремов'
};

// ─── Init ────────────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const KV = new KVStore(path.join(dataDir, 'kv.db'));

const app = express();

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-YCLIENTS-Signature', 'X-API-Key', 'X-Admin-Key', 'X-Admin-Force', 'X-Force-Update', 'X-Dry-Run']
}));

// Parse JSON for POST (but capture raw body for webhook HMAC)
app.use((req, res, next) => {
  if (req.path === '/webhook') {
    // Capture raw body for HMAC verification
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks).toString('utf8');
      try { req.body = JSON.parse(req.rawBody); } catch (_) { req.body = null; }
      next();
    });
  } else {
    express.json({ limit: '5mb' })(req, res, next);
  }
});

// ─── In-memory caches (same as original isolate caches) ─────────────────────

let __staffCache = { ts: 0, map: {} };
let __nameOvCache = { ts: 0, map: {} };

// Simple response cache (replaces caches.default)
const responseCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { responseCache.delete(key); return null; }
  return entry.data;
}

function cachePut(key, data, ttlSeconds) {
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    // evict oldest entries
    const keys = [...responseCache.keys()];
    for (let i = 0; i < 100 && i < keys.length; i++) responseCache.delete(keys[i]);
  }
  responseCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ─── Staff map helpers ──────────────────────────────────────────────────────

async function getStaffMapCached(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (__staffCache.map && Object.keys(__staffCache.map).length && (now - (__staffCache.ts || 0)) < maxAgeMs) return __staffCache.map;
  let map = {};
  try {
    const raw = await KV.get('staff:map');
    if (raw) {
      try { map = JSON.parse(raw); } catch (_) { map = {}; }
    }
  } catch (_) { map = {}; }
  __staffCache = { ts: now, map };
  return map;
}

async function getNameOverridesCached(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (__nameOvCache.map && Object.keys(__nameOvCache.map).length && (now - (__nameOvCache.ts || 0)) < maxAgeMs) return __nameOvCache.map;
  let map = { ...NAME_OVERRIDES };
  try {
    const raw = await KV.get('staff:name_overrides');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') map = { ...map, ...parsed };
      } catch (_) {}
    }
  } catch (_) {}
  __nameOvCache = { ts: now, map };
  return map;
}

function applyStaffNameToBody(bodyObj, staffMap, nameOverrides) {
  try {
    const d = bodyObj && bodyObj.data ? bodyObj.data : null;
    if (!d) return bodyObj;
    const mid = d.master_id || (d.staff && d.staff.id) || null;
    const mapped = mid ? (ID_OVERRIDES[String(mid)] || staffMap[String(mid)] || STAFF_MAP[mid]) : null;
    if (mapped) {
      if (!d.staff || typeof d.staff !== 'object') d.staff = {};
      d.staff.name = mapped;
      d.master_name = mapped;
      return bodyObj;
    }
    const currentName = (d.staff && d.staff.name) || d.master_name || null;
    if (currentName && nameOverrides && nameOverrides[currentName]) {
      const nn = nameOverrides[currentName];
      if (!d.staff || typeof d.staff !== 'object') d.staff = {};
      d.staff.name = nn;
      d.master_name = nn;
    }
  } catch (_) {}
  return bodyObj;
}

function compactEvent(parsed) {
  try {
    const ev = parsed || {};
    const data = ev.data || {};
    const text = (data.text || data.message || '').trim();
    return {
      event: ev.event || null,
      text: text || null,
      date: data.date || data.created_at || null,
      id: data.id || null,
      rating: (typeof data.rating !== 'undefined') ? data.rating : (data.rate || data.score || data.stars || data.mark || data.value || data.grade || null),
      author_name: data.client ? (data.client.name || data.client.full_name) : (data.user_name || data.client_name || data.author || data.name || data.user || null),
      author_surname: data.author_surname || data.user_surname || null,
      master_id: (typeof data.master_id !== 'undefined') ? data.master_id : (data.staff_id || null),
      master_name: data.staff ? (data.staff.name || data.staff.full_name) : (data.master_name || data.master || data.staff_name || data.trainer_name || null)
    };
  } catch (e) {
    return null;
  }
}

// ─── HMAC verification ──────────────────────────────────────────────────────

function verifyHmacSHA256(message, secret, signatureHeader) {
  const computed = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  const normalized = signatureHeader.replace(/^sha256=|^sha1=|^hmac=| /gi, '');
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(normalized, 'hex')
  );
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

function checkAdmin(req) {
  const key = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  return ADMIN_KEY && String(key) === String(ADMIN_KEY);
}

function checkOrigin(req) {
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o));
}

function checkReadKey(req) {
  if (!YCLIENTS_READ_KEY) return true;
  const key = req.headers['x-api-key'] || '';
  return String(key) === String(YCLIENTS_READ_KEY);
}

function yclientsFetch(url, opts = {}) {
  const headers = {
    'Accept': 'application/vnd.yclients.v2+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${YCLIENTS_PARTNER_TOKEN}` + (YCLIENTS_USER_TOKEN ? `, User ${YCLIENTS_USER_TOKEN}` : ''),
    ...opts.headers
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 30000);
  return fetch(url, { method: opts.method || 'GET', headers, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => res.send('ok'));

// ─── GET /reviews ───────────────────────────────────────────────────────────

app.get('/reviews', async (req, res) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });

    const companyId = req.query.company_id || YCLIENTS_COMPANY_ID;
    if (!companyId) return res.status(400).json({ success: false, message: 'company_id is required' });

    const staffParam = req.query.staff_id || req.query.staff_ids || '';
    const page = req.query.page || '1';
    const count = req.query.count || '20';
    const ttl = Number(req.query.ttl || DEFAULT_TTL);

    if (!YCLIENTS_PARTNER_TOKEN) return res.status(500).json({ success: false, message: 'YCLIENTS_PARTNER_TOKEN not configured' });

    // Check cache
    const cacheKey = `reviews:${companyId}:s:${staffParam || 'all'}:p:${page}:c:${count}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set({ 'X-Cache': 'HIT', 'Cache-Control': `public, max-age=${ttl}` });
      return res.json(cached);
    }

    const target = new URL(`${YCLIENTS_API_BASE}/api/v1/comments/${encodeURIComponent(companyId)}/`);
    target.searchParams.set('page', page);
    target.searchParams.set('count', count);
    if (staffParam) {
      const list = staffParam.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 1) target.searchParams.set('staff_id', list[0]);
      else list.forEach(id => target.searchParams.append('staff_id', id));
    }

    const yResp = await yclientsFetch(target.toString());
    const upstreamText = await yResp.text();

    if (yResp.status >= 200 && yResp.status < 300) {
      let parsed = null;
      try { parsed = JSON.parse(upstreamText); } catch (_) {}

      let dataArr = [];
      let meta = {};
      if (parsed && Array.isArray(parsed.data)) { dataArr = parsed.data; meta = parsed.meta || {}; }
      else if (Array.isArray(parsed)) dataArr = parsed;
      else if (parsed && Array.isArray(parsed.comments)) dataArr = parsed.comments;

      const totalGuess = Number((meta.total || meta.count || meta.items_total) || (parsed && (parsed.total || parsed.count)) || 0) || dataArr.length;

      const items = dataArr.map(d => {
        const compact = {
          event: 'api.comments',
          text: (d.text || '').trim(),
          date: d.date || null,
          id: d.id || null,
          rating: (typeof d.rating !== 'undefined') ? d.rating : null,
          author_name: d.user_name || null,
          author_surname: null,
          master_id: (typeof d.master_id !== 'undefined') ? d.master_id : null,
          master_name: (typeof d.master_id !== 'undefined' && d.master_id != null) ? (STAFF_MAP[d.master_id] || null) : null
        };
        let ts = null;
        try { ts = compact.date ? Date.parse(compact.date) : null; if (!Number.isFinite(ts)) ts = null; } catch (_) { ts = null; }
        return { id: String(d.id || ''), ts, compact, body: { event: 'api.comments', data: d } };
      });

      const itemsWithMaster = items.filter(it => {
        const mid = it && it.compact ? it.compact.master_id : null;
        return mid !== null && typeof mid !== 'undefined' && String(mid).trim() !== '';
      });

      const outData = { items: itemsWithMaster, total: totalGuess, page: Number(page), limit: Number(count) };
      cachePut(cacheKey, outData, ttl);
      res.set({ 'X-Cache': 'MISS', 'Cache-Control': `public, max-age=${ttl}` });
      return res.json(outData);
    }

    res.status(yResp.status).send(upstreamText);
  } catch (e) {
    res.status(500).json({ error: 'reviews_failed', detail: e.message });
  }
});

// ─── GET /reviews-bundle ────────────────────────────────────────────────────

app.get('/reviews-bundle', async (req, res) => {
  try {
    const BUNDLE_TTL = 21600; // 6 hours

    const cacheKey = 'reviews-bundle-v1';
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set({ 'X-Cache': 'HIT', 'Cache-Control': `public, max-age=${BUNDLE_TTL}` });
      return res.json(cached);
    }

    if (!YCLIENTS_PARTNER_TOKEN) return res.status(500).json({ error: 'not configured' });

    const staffMap = await getStaffMapCached();
    const nameOverrides = await getNameOverridesCached();

    const PAGE_SIZE = 200;
    let allReviews = [];
    let page = 1;
    let guard = 0;

    while (guard < 50) {
      const target = new URL(`${YCLIENTS_API_BASE}/api/v1/comments/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`);
      target.searchParams.set('page', String(page));
      target.searchParams.set('count', String(PAGE_SIZE));

      const resp = await yclientsFetch(target.toString(), { timeout: 15000 });
      if (!resp.ok) break;

      let parsed;
      try { parsed = JSON.parse(await resp.text()); } catch (_) { break; }

      let dataArr = [];
      if (parsed && Array.isArray(parsed.data)) dataArr = parsed.data;
      else if (Array.isArray(parsed)) dataArr = parsed;
      else if (parsed && Array.isArray(parsed.comments)) dataArr = parsed.comments;
      if (!dataArr.length) break;

      for (const d of dataArr) {
        const mid = d.master_id != null ? String(d.master_id) : null;
        if (!mid) continue;

        const text = (d.text || '').trim();
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length < 4) continue;

        let mname = null;
        if (mid) {
          mname = ID_OVERRIDES[mid] || staffMap[mid] || STAFF_MAP[Number(mid)] || STAFF_MAP[mid] || d.master_name || null;
        }
        if (!mname && d.master_name && nameOverrides[d.master_name]) {
          mname = nameOverrides[d.master_name];
        }

        allReviews.push({
          id: d.id || null,
          t: text,
          d: d.date || null,
          r: (typeof d.rating !== 'undefined') ? d.rating : 5,
          a: d.user_name || '',
          m: mid,
          mn: mname || ''
        });
      }

      if (dataArr.length < PAGE_SIZE) break;
      page++;
      guard++;
    }

    const outData = { reviews: allReviews, ts: Date.now(), count: allReviews.length };
    cachePut(cacheKey, outData, BUNDLE_TTL);
    res.set({ 'X-Cache': 'MISS', 'X-Reviews-Count': String(allReviews.length), 'Cache-Control': `public, max-age=${BUNDLE_TTL}` });
    return res.json(outData);
  } catch (e) {
    res.status(500).json({ error: 'bundle_failed', detail: e.message });
  }
});

// ─── POST /webhook ──────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  try {
    if (!YCLIENTS_WEBHOOK_SECRET) return res.status(500).send('Webhook secret not configured');

    const bodyText = req.rawBody;
    const signatureHeader =
      req.headers['x-yclients-signature'] ||
      req.headers['x-signature'] ||
      req.headers['x-hub-signature'];

    if (!signatureHeader) return res.status(400).send('Missing signature header');

    let signatureValid = false;
    try {
      signatureValid = verifyHmacSHA256(bodyText, YCLIENTS_WEBHOOK_SECRET, signatureHeader);
    } catch (_) {
      signatureValid = false;
    }
    if (!signatureValid) return res.status(401).send('Invalid signature');

    let parsedBody = req.body;
    if (!parsedBody || !parsedBody.data) return res.json({ ok: true, skipped: 'no data' });

    const staffMap = await getStaffMapCached();
    const nameOverrides = await getNameOverridesCached();
    if (parsedBody.data) applyStaffNameToBody(parsedBody, staffMap, nameOverrides);

    const compact = compactEvent(parsedBody);
    if (!compact || !compact.text) return res.json({ ok: true, skipped: 'empty review' });

    const words = compact.text.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 4) return res.json({ ok: true, skipped: 'too short review' });

    if (!compact.master_id && !(parsedBody.data.master_id || (parsedBody.data.staff && parsedBody.data.staff.id))) {
      return res.json({ ok: true, skipped: 'no_master' });
    }

    let eventId;
    const srcId = parsedBody.data.id || parsedBody.data.source_id || parsedBody.data.client_id;
    if (srcId) eventId = `yclients:${String(srcId)}`;
    else eventId = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

    await KV.put(eventId, JSON.stringify(parsedBody));
    await KV.put('events:version', String(Date.now()));

    res.json({ ok: true, id: eventId });
  } catch (e) {
    res.status(500).json({ error: 'webhook_failed', detail: e.message });
  }
});

// ─── GET /events ────────────────────────────────────────────────────────────

app.get('/events', async (req, res) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });

    const limit = Math.min(100, Number(req.query.limit || 20));
    const page = Math.max(1, Number(req.query.page || 1));

    const staffMapForRead = await getStaffMapCached();
    const nameOverrides = await getNameOverridesCached();

    // Version-based cache
    let version = 'v1';
    try { const v = await KV.get('events:version'); if (v) version = v; } catch (_) {}

    const cacheKey = `events:ver:${version}:limit:${limit}:page:${page}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set({ 'X-Cache': 'HIT', 'X-Events-Version': version });
      return res.json(cached);
    }

    // List all KV keys
    const forbidden = new Set(['events:version', 'staff:map', 'staff:last_refresh', 'trainer:disabled', 'staff:name_overrides']);
    let allKeys = [];
    let cursor = undefined;
    while (true) {
      const result = await KV.list({ limit: 1000, cursor });
      const names = result.keys.map(k => k.name).filter(n => n && !forbidden.has(n));
      allKeys.push(...names);
      if (!result.cursor) break;
      cursor = result.cursor;
    }

    // Fetch all items and build compact representation
    const allItems = [];
    for (const k of allKeys) {
      try {
        const v = await KV.get(k);
        if (!v) continue;
        const parsed = JSON.parse(v);
        const rawCompact = compactEvent(parsed);

        if (parsed && parsed.data) {
          applyStaffNameToBody(parsed, staffMapForRead, nameOverrides);
        }

        const data = parsed && parsed.data ? parsed.data : {};
        const text = rawCompact && rawCompact.text ? String(rawCompact.text) : (data.text || data.message || '');
        if (!text || !text.trim()) continue;

        const dateVal = (rawCompact && rawCompact.date) || data.date || data.created_at || null;
        const idVal = (rawCompact && rawCompact.id) || data.id || null;
        const ratingRaw = (rawCompact && typeof rawCompact.rating !== 'undefined') ? rawCompact.rating : (data.rating || null);
        const rating = (ratingRaw === null || typeof ratingRaw === 'undefined' || ratingRaw === '') ? null : (Number(ratingRaw) || 0);
        const author = (rawCompact && rawCompact.author_name) || (data.client && data.client.name) || data.user_name || null;
        const authorSurname = (rawCompact && rawCompact.author_surname) || data.author_surname || null;
        const masterIdRaw = (rawCompact && rawCompact.master_id != null) ? rawCompact.master_id : (data.master_id || (data.staff && data.staff.id) || null);
        const master_id = masterIdRaw != null ? (Number(masterIdRaw) || masterIdRaw) : null;

        let master_name = (rawCompact && rawCompact.master_name) || (data.staff && data.staff.name) || data.master_name || null;
        if (master_id && staffMapForRead[String(master_id)]) master_name = staffMapForRead[String(master_id)];
        if (!master_name && master_id && STAFF_MAP[String(master_id)]) master_name = STAFF_MAP[String(master_id)];

        const compactNorm = {
          event: (rawCompact && rawCompact.event) || (parsed && parsed.event) || 'api.comments',
          text: text.trim(),
          date: dateVal,
          id: idVal,
          rating: rating,
          author_name: author,
          author_surname: authorSurname,
          master_id: master_id,
          master_name: master_name
        };

        let ts = null;
        try { ts = dateVal ? Date.parse(dateVal) : null; if (!Number.isFinite(ts)) ts = null; } catch (_) {}
        allItems.push({ id: k, ts, compact: compactNorm, body: parsed });
      } catch (_) {}
    }

    // Sort by ts desc
    allItems.sort((a, b) => {
      const at = a.ts ?? -Infinity; const bt = b.ts ?? -Infinity;
      if (at !== bt) return bt - at;
      const an = Number(a.compact && a.compact.id);
      const bn = Number(b.compact && b.compact.id);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
      return String(b.id).localeCompare(String(a.id));
    });

    // Filter: require master_id + >=4 words
    const filtered = allItems.filter(it => {
      const mid = it.compact ? it.compact.master_id : null;
      if (mid == null || String(mid).trim() === '') return false;
      const text = (it.compact.text || '').trim();
      if (!text) return false;
      return text.split(/\s+/).filter(w => w.length > 0).length >= 4;
    });

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    const outData = { items, total, page, limit };
    cachePut(cacheKey, outData, 300);
    res.set({ 'X-Cache': 'MISS', 'X-Events-Version': version });
    res.json(outData);
  } catch (e) {
    res.status(500).json({ error: 'events_failed', detail: e.message });
  }
});

// ─── GET /event/:id ─────────────────────────────────────────────────────────

app.get('/event/:id', async (req, res) => {
  try {
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });
    const v = await KV.get(req.params.id);
    if (!v) return res.status(404).json({ error: 'not found' });
    const parsed = JSON.parse(v);
    const compact = compactEvent(parsed);
    res.json({ id: req.params.id, compact, body: parsed });
  } catch (e) {
    res.status(500).json({ error: 'read_failed', detail: e.message });
  }
});

// ─── GET /trainers ──────────────────────────────────────────────────────────

app.get('/trainers', async (req, res) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });

    const trainers = new Map();

    // Seed with STAFF_MAP
    Object.keys(STAFF_MAP).forEach(k => {
      const id = Number(k);
      if (!Number.isFinite(id)) return;
      trainers.set(String(id), { id: String(id), name: STAFF_MAP[id], count: 0 });
    });

    // Load from KV staff:map
    try {
      const rawMap = await KV.get('staff:map');
      if (rawMap) {
        const parsedMap = JSON.parse(rawMap || '{}');
        Object.keys(parsedMap).forEach(k => {
          const id = String(k);
          if (!trainers.has(id)) trainers.set(id, { id, name: parsedMap[k], count: 0 });
          else if (!trainers.get(id).name) trainers.get(id).name = parsedMap[k];
        });
      }
    } catch (_) {}

    // Load disabled trainers
    let disabledSet = new Set();
    try {
      const raw = await KV.get('trainer:disabled');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(x => { if (x != null) disabledSet.add(String(x)); });
      }
    } catch (_) {}

    // Scan all KV keys for trainer info
    let cursor = undefined;
    while (true) {
      const result = await KV.list({ limit: 1000, cursor });
      const names = result.keys.map(k => k.name).filter(n => n && n !== 'events:version');
      for (const name of names) {
        try {
          const v = await KV.get(name);
          if (!v) continue;
          const parsed = JSON.parse(v);
          const compact = compactEvent(parsed);
          let mid = null, mname = null;
          if (compact && compact.master_id) mid = String(compact.master_id);
          if (compact && compact.master_name) mname = compact.master_name;
          if (!mid && parsed && parsed.data) {
            mid = parsed.data.master_id ? String(parsed.data.master_id) : (parsed.data.staff && parsed.data.staff.id ? String(parsed.data.staff.id) : null);
            mname = mname || (parsed.data.staff && parsed.data.staff.name) || parsed.data.master_name || null;
          }
          if (mid) {
            const entry = trainers.get(mid) || { id: mid, name: mname || STAFF_MAP[mid] || `Тренер ${mid}`, count: 0, enabled: true };
            entry.count = (entry.count || 0) + 1;
            if (!entry.name && parsed && parsed.data && parsed.data.staff && parsed.data.staff.name) entry.name = parsed.data.staff.name;
            if (disabledSet.has(String(mid))) entry.enabled = false;
            trainers.set(mid, entry);
          }
        } catch (_) {}
      }
      if (!result.cursor) break;
      cursor = result.cursor;
    }

    let out = Array.from(trainers.values()).map(t => ({
      id: String(t.id), name: t.name || `Тренер ${t.id}`, count: t.count || 0,
      enabled: disabledSet.has(String(t.id)) ? false : ((typeof t.enabled === 'boolean') ? t.enabled : true)
    }));

    // Apply name overrides
    try {
      const nameOv = await getNameOverridesCached();
      out = out.map(t => {
        const byId = ID_OVERRIDES[String(t.id)];
        if (byId) return { ...t, name: byId };
        const byName = nameOv && t.name && nameOv[t.name];
        if (byName) return { ...t, name: byName };
        return t;
      });
    } catch (_) {}

    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    // Filter by active staff from YClients (fired=0)
    try {
      const rawActive = await KV.get('staff:active_ids');
      if (rawActive) {
        const activeSet = new Set(JSON.parse(rawActive));
        if (activeSet.size > 0) {
          out = out.filter(t => activeSet.has(String(t.id)));
        }
      }
    } catch (_) {}

    const includeZero = req.query.include_zero === '1' || req.query.include_zero === 'true';
    const includeDisabled = req.query.include_disabled === '1' || req.query.include_disabled === 'true';

    out = out.filter(t => {
      if (!includeDisabled && t.enabled === false) return false;
      if (!includeZero && Number(t.count || 0) <= 0) return false;
      return true;
    });

    res.json({ trainers: out });
  } catch (e) {
    res.status(500).json({ error: 'trainers_failed', detail: e.message });
  }
});

// ─── Admin endpoints ────────────────────────────────────────────────────────

// POST /admin/import
app.post('/admin/import', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });

  const payload = req.body;
  if (!payload) return res.status(400).json({ error: 'invalid_json' });

  const items = Array.isArray(payload) ? payload : [payload];
  const results = [];
  const forceOverwrite = String(req.headers['x-admin-force'] || '').toLowerCase() === 'true';

  for (const item of items) {
    try {
      let parsedItem = (typeof item === 'string') ? JSON.parse(item) : item;
      const staffMap = await getStaffMapCached();
      const nameOverrides = await getNameOverridesCached();
      if (parsedItem && parsedItem.data) applyStaffNameToBody(parsedItem, staffMap, nameOverrides);
      const bodyText = JSON.stringify(parsedItem);
      const eventId = (item && (item.id || (item.data && item.data.id))) ? String(item.id || (item.data && item.data.id)) : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

      if (!forceOverwrite) {
        const existing = await KV.get(eventId);
        if (existing) { results.push({ id: eventId, ok: true, skipped: true }); continue; }
      }

      const compact = compactEvent(parsedItem || { data: parsedItem && parsedItem.data ? parsedItem.data : {} });
      const txt = compact && compact.text ? String(compact.text).trim() : '';
      const wordCount = txt ? txt.split(/\s+/).filter(w => w.length > 0).length : 0;
      if (wordCount < 4) { results.push({ id: eventId, ok: true, skipped: true, reason: 'too_short' }); continue; }
      if (!compact || !compact.master_id) { results.push({ id: eventId, ok: true, skipped: true, reason: 'no_master' }); continue; }

      await KV.put(eventId, bodyText);
      await KV.put('events:version', String(Date.now()));
      results.push({ id: eventId, ok: true });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }

  res.json({ imported: results.length, results });
});

// GET /admin/list-ids
app.get('/admin/list-ids', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const allKeys = [];
    let cursor = undefined;
    while (true) {
      const result = await KV.list({ limit: 1000, cursor });
      const names = result.keys.map(k => k.name).filter(n => n && n !== 'events:version');
      allKeys.push(...names);
      if (!result.cursor) break;
      cursor = result.cursor;
    }
    res.json({ keys: allKeys });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', detail: e.message });
  }
});

// POST /admin/enrich
app.post('/admin/enrich', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });

  const force = req.query.force === '1' || req.headers['x-force-update'] === '1';
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
  const cursorIn = req.query.cursor || undefined;

  try {
    const result = await KV.list({ limit, cursor: cursorIn });
    const forbidden = new Set(['events:version', 'staff:map', 'staff:last_refresh', 'trainer:disabled', 'staff:name_overrides']);
    const pageKeys = result.keys.map(k => k.name).filter(n => n && !forbidden.has(n));

    let enriched = 0, skipped = 0, errors = 0;
    const staffMap = await getStaffMapCached();

    for (const key of pageKeys) {
      try {
        const v = await KV.get(key);
        if (!v) continue;
        const parsed = JSON.parse(v);
        if (!parsed || !parsed.data || !parsed.data.id) continue;

        const compact = compactEvent(parsed);
        if (!compact || !compact.text) { skipped++; continue; }

        let changed = false;
        if (parsed.data.user_name) {
          if (!parsed.data.client || typeof parsed.data.client !== 'object') { parsed.data.client = { name: parsed.data.user_name }; changed = true; }
          else if (force && parsed.data.client.name !== parsed.data.user_name) { parsed.data.client.name = parsed.data.user_name; changed = true; }
        }

        const before = (parsed.data.staff && parsed.data.staff.name) || parsed.data.master_name || null;
        const nameOv = await getNameOverridesCached();
        applyStaffNameToBody(parsed, staffMap, nameOv);
        const after = (parsed.data.staff && parsed.data.staff.name) || parsed.data.master_name || null;
        if (after && after !== before) changed = true;
        else if (force && after) changed = true;
        if (!changed && !force) { skipped++; continue; }

        await KV.put(key, JSON.stringify(parsed));
        enriched++;
      } catch (e) {
        errors++;
      }
    }

    await KV.put('events:version', String(Date.now()));
    res.json({ enriched, skipped, errors, processed: pageKeys.length, nextCursor: result.cursor || null });
  } catch (e) {
    res.status(500).json({ error: 'enrich_failed', detail: e.message });
  }
});

// POST /admin/staff-map (set)
app.post('/admin/staff-map', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'mapping object required' });
  try {
    await KV.put('staff:map', JSON.stringify(body));
    __staffCache = { ts: Date.now(), map: body };
    res.json({ ok: true, stored: Object.keys(body).length });
  } catch (e) {
    res.status(500).json({ error: 'store_failed', detail: e.message });
  }
});

// GET /admin/get-staff-map
app.get('/admin/get-staff-map', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const map = await getStaffMapCached(0);
    res.json({ ok: true, count: Object.keys(map).length, map });
  } catch (e) {
    res.status(500).json({ error: 'read_failed', detail: e.message });
  }
});

// POST /admin/refresh-staff
app.post('/admin/refresh-staff', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!YCLIENTS_PARTNER_TOKEN || !YCLIENTS_COMPANY_ID) return res.status(500).json({ error: 'YCLIENTS tokens missing' });

  const candidatePaths = [
    `/api/v1/staff/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`,
    `/api/v1/staff/`,
    `/api/v1/employees/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`,
    `/api/v1/staff?company_id=${encodeURIComponent(YCLIENTS_COMPANY_ID)}`
  ];

  let found = null, urlTried = null;
  for (const p of candidatePaths) {
    const target = `${YCLIENTS_API_BASE}${p}`;
    urlTried = target;
    try {
      const r = await yclientsFetch(target, { timeout: 10000 });
      if (!r.ok) continue;
      let parsed;
      try { parsed = JSON.parse(await r.text()); } catch (_) { continue; }
      if (Array.isArray(parsed)) { found = parsed; break; }
      if (Array.isArray(parsed.data)) { found = parsed.data; break; }
      if (Array.isArray(parsed.staff)) { found = parsed.staff; break; }
      if (Array.isArray(parsed.items)) { found = parsed.items; break; }
    } catch (_) {}
  }

  if (!found) return res.status(502).json({ error: 'staff_list_not_found', tried: urlTried });

  const map = {};
  const activeIds = [];
  for (const s of found) {
    const id = s.id || s.staff_id || s.master_id || null;
    const name = s.name || s.full_name || (s.first_name && s.last_name ? `${s.first_name} ${s.last_name}` : null) || null;
    if (id && name) {
      map[String(id)] = String(name);
      if (!s.fired) activeIds.push(String(id));
    }
  }

  await KV.put('staff:map', JSON.stringify(map));
  if (activeIds.length) await KV.put('staff:active_ids', JSON.stringify(activeIds));
  __staffCache = { ts: Date.now(), map };
  res.json({ ok: true, stored: Object.keys(map).length, active: activeIds.length, tried: urlTried });
});

// POST /admin/clean-short
app.post('/admin/clean-short', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    let cursor = req.query.cursor || undefined;
    const dry = req.query.dry === '1' || req.headers['x-dry-run'] === '1';
    const maxDelete = Math.max(0, Number(req.query.max_delete || req.query.max || 100));
    let deleted = 0, scanned = 0;
    const matched = [];

    while (true) {
      const result = await KV.list({ limit: 1000, cursor });
      const names = result.keys.map(k => k.name).filter(n => n && n !== 'events:version');
      for (const name of names) {
        try {
          scanned++;
          const v = await KV.get(name);
          if (!v) continue;
          const parsed = JSON.parse(v);
          const compact = compactEvent(parsed || { data: {} });
          const text = compact && compact.text ? String(compact.text).trim() : '';
          const wc = text ? text.split(/\s+/).filter(w => w.length > 0).length : 0;
          if (wc < 4) {
            matched.push(name);
            if (!dry) { await KV.delete(name); deleted++; }
            if (!dry && deleted >= maxDelete) break;
            if (dry && matched.length >= Math.max(10, maxDelete)) break;
          }
        } catch (_) {}
      }
      if ((!dry && deleted >= maxDelete) || (dry && matched.length >= Math.max(10, maxDelete))) {
        return res.json({ scanned, deleted, matchedSample: matched.slice(0, 50), nextCursor: result.cursor || null });
      }
      if (!result.cursor) {
        await KV.put('events:version', String(Date.now()));
        return res.json({ scanned, deleted, matchedSample: matched.slice(0, 50), nextCursor: null });
      }
      cursor = result.cursor;
    }
  } catch (e) {
    res.status(500).json({ error: 'clean_failed', detail: e.message });
  }
});

// POST /admin/backfill
app.post('/admin/backfill', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!YCLIENTS_PARTNER_TOKEN) return res.status(500).json({ error: 'YCLIENTS tokens missing' });

  const perPage = Math.max(1, Math.min(100, Number(req.query.per_page || 100)));
  let page = Math.max(1, Number(req.query.start_page || 1));
  const maxPages = Math.max(1, Number(req.query.max_pages || 1));
  let pagesProcessed = 0, totalImported = 0, errors = 0, nextPage = null;

  try {
    const staffMap = await getStaffMapCached();
    while (true) {
      const target = new URL(`${YCLIENTS_API_BASE}/api/v1/comments/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`);
      target.searchParams.set('page', String(page));
      target.searchParams.set('count', String(perPage));

      const yResp = await yclientsFetch(target.toString(), { timeout: 20000 });
      if (!yResp.ok) {
        const txt = await yResp.text().catch(() => '');
        return res.status(502).json({ error: 'upstream_error', status: yResp.status, detail: txt });
      }

      let parsed;
      try { parsed = JSON.parse(await yResp.text()); } catch (_) { parsed = null; }
      let items = [];
      if (parsed && Array.isArray(parsed.data)) items = parsed.data;
      else if (Array.isArray(parsed)) items = parsed;
      else if (parsed && Array.isArray(parsed.comments)) items = parsed.comments;
      if (!items.length) break;

      for (const d of items) {
        try {
          const id = d.id || null;
          if (!id) continue;
          const key = `yclients:${String(id)}`;
          const bodyObj = { event: 'api.comments', data: d };
          const nameOv = await getNameOverridesCached();
          applyStaffNameToBody(bodyObj, staffMap, nameOv);
          const compact = compactEvent(bodyObj);
          const txt = compact && compact.text ? compact.text.trim() : '';
          const wc = txt ? txt.split(/\s+/).filter(w => w.length > 0).length : 0;
          if (wc < 4 || !compact.master_id) continue;
          await KV.put(key, JSON.stringify(bodyObj));
          totalImported++;
        } catch (e) { errors++; }
      }

      pagesProcessed++;
      if (items.length < perPage) { nextPage = null; break; }
      if (pagesProcessed >= maxPages) { nextPage = page + 1; break; }
      page++;
    }

    await KV.put('events:version', String(Date.now()));
    res.json({
      imported: totalImported, errors,
      start_page: Math.max(1, Number(req.query.start_page || 1)),
      per_page: perPage, pages_processed: pagesProcessed,
      last_page: page, next_page: nextPage
    });
  } catch (e) {
    res.status(500).json({ error: 'backfill_failed', detail: e.message });
  }
});

// ─── Cron jobs ──────────────────────────────────────────────────────────────

async function cronRefreshStaff() {
  try {
    if (!YCLIENTS_PARTNER_TOKEN || !YCLIENTS_COMPANY_ID) return;
    const candidatePaths = [
      `/api/v1/staff/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`,
      `/api/v1/staff/`,
      `/api/v1/employees/${encodeURIComponent(YCLIENTS_COMPANY_ID)}/`
    ];

    let found = null;
    for (const p of candidatePaths) {
      try {
        const r = await yclientsFetch(`${YCLIENTS_API_BASE}${p}`, { timeout: 10000 });
        if (!r.ok) continue;
        let parsed;
        try { parsed = JSON.parse(await r.text()); } catch (_) { continue; }
        if (Array.isArray(parsed)) { found = parsed; break; }
        if (Array.isArray(parsed.data)) { found = parsed.data; break; }
        if (Array.isArray(parsed.staff)) { found = parsed.staff; break; }
        if (Array.isArray(parsed.items)) { found = parsed.items; break; }
      } catch (_) {}
    }

    if (!found) return;
    const map = {};
    const activeIds = [];
    for (const s of found) {
      const id = s.id || s.staff_id || null;
      const name = s.name || s.full_name || null;
      if (id && name) {
        map[String(id)] = String(name);
        if (!s.fired) activeIds.push(String(id));
      }
    }
    if (Object.keys(map).length) {
      await KV.put('staff:map', JSON.stringify(map));
      if (activeIds.length) await KV.put('staff:active_ids', JSON.stringify(activeIds));
      __staffCache = { ts: Date.now(), map };
      console.log(`[cron] Staff map refreshed: ${Object.keys(map).length} entries, active: ${activeIds.length}`);
    }
  } catch (e) {
    console.error('[cron] Staff refresh error:', e.message);
  }
}

async function cronCleanShort() {
  try {
    const SHORT_MIN_WORDS = 4;
    let cursor = undefined;
    let deleted = 0;
    while (deleted < CRON_CLEAN_LIMIT) {
      const result = await KV.list({ limit: 100, cursor });
      const names = result.keys.map(k => k.name).filter(n => n && n !== 'events:version');
      for (const name of names) {
        if (deleted >= CRON_CLEAN_LIMIT) break;
        try {
          const v = await KV.get(name);
          if (!v) continue;
          const parsed = JSON.parse(v);
          const compact = compactEvent(parsed || { data: {} });
          const text = compact && compact.text ? compact.text.trim() : '';
          const wc = text ? text.split(/\s+/).filter(w => w.length > 0).length : 0;
          if (wc > 0 && wc < SHORT_MIN_WORDS) {
            await KV.delete(name);
            deleted++;
          }
        } catch (_) {}
      }
      if (!result.cursor) break;
      cursor = result.cursor;
    }
    if (deleted > 0) {
      await KV.put('events:version', String(Date.now()));
      console.log(`[cron] Cleaned ${deleted} short reviews`);
    }
  } catch (e) {
    console.error('[cron] Clean short error:', e.message);
  }
}

if (!DISABLE_CRON) {
  // Every 6 hours (like wrangler.toml cron 0 */6 * * *)
  cron.schedule('0 */6 * * *', async () => {
    console.log('[cron] Running scheduled tasks...');
    try {
      const lastRefreshRaw = await KV.get('staff:last_refresh');
      const lastRefresh = lastRefreshRaw ? Number(lastRefreshRaw) : 0;
      const now = Date.now();
      if (!lastRefresh || (now - lastRefresh) > STAFF_REFRESH_INTERVAL_HOURS * 3600000) {
        await cronRefreshStaff();
        await KV.put('staff:last_refresh', String(now));
      }
    } catch (_) {}
    await cronCleanShort();
  });
  console.log('[cron] Scheduled tasks enabled (every 6 hours)');
}

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Barista Reviews Proxy running on port ${PORT}`);
  console.log(`[server] Admin key: ${ADMIN_KEY ? 'configured' : 'NOT SET (admin endpoints disabled)'}`);
  console.log(`[server] Yclients: partner=${YCLIENTS_PARTNER_TOKEN ? 'configured' : 'NOT SET'}, company=${YCLIENTS_COMPANY_ID}`);
});

// Graceful shutdown
process.on('SIGINT', () => { KV.close(); process.exit(0); });
process.on('SIGTERM', () => { KV.close(); process.exit(0); });
