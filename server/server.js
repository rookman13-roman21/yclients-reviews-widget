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
const REVIEWS_SNAPSHOT_KEY = 'reviews:snapshot:v1';
const REVIEWS_SNAPSHOT_SCHEMA = 2;
const REVIEWS_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const REVIEWS_SNAPSHOT_PAGE_SIZE = 200;
const REVIEWS_SNAPSHOT_MAX_PAGES = 50;
const REVIEWS_PUBLIC_CACHE_TTL = 300;
const SITE_HEALTH_LOG_MAX_BYTES = 20 * 1024 * 1024;
const SITE_HEALTH_MONITOR_VERSION = '20260608-2';
const SITE_HEALTH_CHECK_INTERVAL = process.env.SITE_HEALTH_CHECK_INTERVAL || '*/1 * * * *';
const SITE_HEALTH_SERVICE_CHECK_INTERVAL = process.env.SITE_HEALTH_SERVICE_CHECK_INTERVAL || '*/15 * * * *';
const SITE_HEALTH_CHECK_TIMEOUT_MS = Number(process.env.SITE_HEALTH_CHECK_TIMEOUT_MS || 10000);


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
const SITE_HEALTH_CHECK_URLS = (process.env.SITE_HEALTH_CHECK_URLS || [
  'https://baristaschool.ru/',
  'https://baristaschool.ru/coffee_club',
  'https://baristaschool.ru/excu',
  'https://baristaschool.ru/latte_art_battle',
  'https://api.barista-school.ru/health',
  'https://api.barista-school.ru/widgets/reviews.js',
  'https://api.barista-school.ru/static/karta-uchenikov/karta-uchenikov.js'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const SITE_HEALTH_SERVICE_CHECK_URLS = (process.env.SITE_HEALTH_SERVICE_CHECK_URLS || [
  'https://baristaschool.ru/barista_courses',
  'https://baristaschool.ru/probarista',
  'https://baristaschool.ru/latte-art',
  'https://baristaschool.ru/expert',
  'https://baristaschool.ru/alternative',
  'https://baristaschool.ru/sence',
  'https://baristaschool.ru/group',
  'https://baristaschool.ru/master_open',
  'https://baristaschool.ru/business-intensive',
  'https://baristaschool.ru/open_coffeeshop',
  'https://baristaschool.ru/bar_engineering',
  'https://baristaschool.ru/regions',
  'https://baristaschool.ru/sca_menu',
  'https://baristaschool.ru/unique_menu',
  'https://baristaschool.ru/summer_drinks',
  'https://baristaschool.ru/home_barista_online',
  'https://baristaschool.ru/home_barista',
  'https://baristaschool.ru/barista_3',
  'https://baristaschool.ru/coffie_team',
  'https://baristaschool.ru/coffee_club',
  'https://baristaschool.ru/capping',
  'https://baristaschool.ru/tea_capping',
  'https://baristaschool.ru/master_doma',
  'https://baristaschool.ru/casino',
  'https://baristaschool.ru/excu',
  'https://baristaschool.ru/latte_art_battle',
  'https://baristaschool.ru/mbs_mixology_cup'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

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
const siteHealthLogPath = path.join(dataDir, 'site-health.jsonl');

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
let __reviewsSnapshotRefreshPromise = null;
const __siteHealthRate = new Map();

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

function checkSiteHealthOrigin(req) {
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (!origin) return true;
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o));
}

function truncateString(value, max = 500) {
  if (value === null || typeof value === 'undefined') return null;
  return String(value).slice(0, max);
}

function sanitizeUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value), 'https://baristaschool.ru');
    return u.origin + u.pathname;
  } catch (_) {
    return truncateString(value, 300);
  }
}

function sanitizeHealthEvent(input, req) {
  const body = input && typeof input === 'object' ? input : {};
  const now = Date.now();
  const type = truncateString(body.type || 'event', 80) || 'event';
  const page = sanitizeUrl(body.page || body.href || body.path || '');
  const resource = sanitizeUrl(body.resource || body.url || body.src || '');
  const ipRaw = String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();

  const out = {
    ts: now,
    iso: new Date(now).toISOString(),
    type,
    ok: typeof body.ok === 'boolean' ? body.ok : undefined,
    page,
    path: truncateString(body.path || '', 240),
    resource,
    status: Number.isFinite(Number(body.status)) ? Number(body.status) : undefined,
    duration_ms: Number.isFinite(Number(body.duration_ms)) ? Math.round(Number(body.duration_ms)) : undefined,
    message: truncateString(body.message || body.reason || '', 500),
    detail: truncateString(body.detail || '', 500),
    widget: truncateString(body.widget || '', 80),
    selector: truncateString(body.selector || '', 160),
    browser: truncateString(body.browser || '', 120),
    user_agent: truncateString(body.user_agent || req.headers['user-agent'] || '', 240),
    referrer: sanitizeUrl(body.referrer || req.headers['referer'] || ''),
    source: truncateString(body.source || 'browser', 40),
    version: truncateString(body.version || SITE_HEALTH_MONITOR_VERSION, 40),
    ip_hash: ipRaw ? crypto.createHash('sha256').update(ipRaw).digest('hex').slice(0, 16) : null
  };

  Object.keys(out).forEach(k => {
    if (typeof out[k] === 'undefined' || out[k] === '') delete out[k];
  });
  return out;
}

async function appendSiteHealthEvent(event) {
  try {
    if (fs.existsSync(siteHealthLogPath)) {
      const stat = fs.statSync(siteHealthLogPath);
      if (stat.size > SITE_HEALTH_LOG_MAX_BYTES) {
        const rotated = siteHealthLogPath + '.1';
        try { if (fs.existsSync(rotated)) fs.unlinkSync(rotated); } catch (_) {}
        fs.renameSync(siteHealthLogPath, rotated);
      }
    }
    await fs.promises.appendFile(siteHealthLogPath, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    console.error('[site-health] append failed:', e.message);
  }
}

function readRecentSiteHealthEvents(limit = 500) {
  if (!fs.existsSync(siteHealthLogPath)) return [];
  const maxBytes = 5 * 1024 * 1024;
  const stat = fs.statSync(siteHealthLogPath);
  const fd = fs.openSync(siteHealthLogPath, 'r');
  try {
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return buffer.toString('utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function buildSiteHealthSummary(events) {
  const byType = {};
  const byPage = {};
  const byResource = {};
  const byGroup = {};
  let failures = 0;
  let slow = 0;
  for (const ev of events) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
    if (ev.page) byPage[ev.page] = (byPage[ev.page] || 0) + 1;
    if (ev.resource) byResource[ev.resource] = (byResource[ev.resource] || 0) + 1;
    if (ev.group) byGroup[ev.group] = (byGroup[ev.group] || 0) + 1;
    if (ev.ok === false || /error|missing|timeout|failed|problem/i.test(ev.type || '')) failures++;
    if (Number(ev.duration_ms || 0) >= 10000) slow++;
  }
  const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, count]) => ({ key, count }));
  return {
    total: events.length,
    failures,
    slow,
    by_type: top(byType),
    by_page: top(byPage),
    by_group: top(byGroup),
    by_resource: top(byResource)
  };
}

function getSiteHealthMonitorScript() {
  return `// MBS site health monitor ${SITE_HEALTH_MONITOR_VERSION}
(function() {
  'use strict';
  if (window.__mbsSiteHealthMonitor) return;
  window.__mbsSiteHealthMonitor = true;

  var VERSION = ${JSON.stringify(SITE_HEALTH_MONITOR_VERSION)};
  var ENDPOINT = 'https://api.barista-school.ru/site-health/event';
  var MAX_EVENTS = 24;
  var SLOW_PAGE_MS = 12000;
  var SLOW_FETCH_MS = 10000;
  var SLOW_RESOURCE_MS = 8000;
  var sent = 0;

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function browserName() {
    var ua = navigator.userAgent || '';
    if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Android/i.test(ua)) return 'Safari';
    if (/Chrome|CriOS/i.test(ua)) return 'Chrome';
    if (/Firefox/i.test(ua)) return 'Firefox';
    return 'Other';
  }

  function cleanUrl(value) {
    if (!value) return '';
    try {
      var u = new URL(String(value), location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return String(value).slice(0, 300);
    }
  }

  function importantUrl(value) {
    var s = String(value || '');
    return /api\\.barista-school\\.ru|baristaschool\\.ru|static\\.tildacdn\\.com|forma\\.tinkoff\\.ru|mod\\.calltouch\\.ru|cdn-ru\\.bitrix24\\.ru|yandex\\.ru|googletagmanager\\.com/i.test(s);
  }

  function send(type, data) {
    if (sent >= MAX_EVENTS) return;
    sent += 1;
    var payload = Object.assign({
      type: type,
      page: cleanUrl(location.href),
      path: location.pathname,
      referrer: cleanUrl(document.referrer || ''),
      browser: browserName(),
      user_agent: (navigator.userAgent || '').slice(0, 240),
      source: 'browser',
      version: VERSION
    }, data || {});
    var json = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true
      }).catch(function() {});
    } catch (e) {}
  }

  window.addEventListener('error', function(e) {
    var target = e.target || e.srcElement;
    if (target && target !== window) {
      var resource = target.src || target.href || '';
      if (resource && importantUrl(resource)) {
        send('resource_error', {
          resource: cleanUrl(resource),
          detail: (target.tagName || '').toLowerCase()
        });
      }
      return;
    }
    send('js_error', {
      message: String(e.message || 'JS error').slice(0, 500),
      resource: cleanUrl(e.filename || ''),
      detail: [e.lineno || 0, e.colno || 0].join(':')
    });
  }, true);

  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason && (e.reason.message || e.reason.stack || e.reason);
    send('promise_error', { message: String(reason || 'Unhandled promise rejection').slice(0, 500) });
  });

  if (window.fetch) {
    var originalFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var started = now();
      return originalFetch.apply(this, arguments).then(function(resp) {
        var duration = Math.round(now() - started);
        if (importantUrl(url) && (!resp.ok || duration >= SLOW_FETCH_MS)) {
          send('fetch_problem', {
            resource: cleanUrl(url),
            status: resp.status,
            ok: resp.ok,
            duration_ms: duration
          });
        }
        return resp;
      }).catch(function(err) {
        if (importantUrl(url)) {
          send('fetch_error', {
            resource: cleanUrl(url),
            ok: false,
            duration_ms: Math.round(now() - started),
            message: String(err && err.message || err || 'fetch failed').slice(0, 500)
          });
        }
        throw err;
      });
    };
  }

  function navTimings() {
    var nav = performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    if (nav) {
      return {
        duration_ms: Math.round(nav.duration || 0),
        detail: 'dom=' + Math.round(nav.domContentLoadedEventEnd || 0) + ';load=' + Math.round(nav.loadEventEnd || 0)
      };
    }
    if (performance && performance.timing) {
      var t = performance.timing;
      return { duration_ms: Math.max(0, t.loadEventEnd - t.navigationStart) };
    }
    return {};
  }

  function checkResources() {
    if (!performance || !performance.getEntriesByType) return;
    var entries = performance.getEntriesByType('resource') || [];
    entries.forEach(function(r) {
      if (!r || !importantUrl(r.name)) return;
      var duration = Math.round(r.duration || 0);
      if (duration >= SLOW_RESOURCE_MS) {
        send('slow_resource', {
          resource: cleanUrl(r.name),
          duration_ms: duration,
          detail: r.initiatorType || ''
        });
      }
    });
  }

  var widgets = [
    { name: 'reviews', selectors: ['#mbs-reviews-widget', '#yc-widget'] },
    { name: 'projects_map', selectors: ['#mbs-cases-map-widget'] },
    { name: 'events_schedule', selectors: ['#mbs-events-widget', '.mbs-events-widget'] },
    { name: 'courses_widget', selectors: ['#mbs-courses-widget', '.mbs-courses-widget'] },
    { name: 'booking_widget', selectors: ['#bbb-widget', '#barista-booking-widget', '.bbb-widget', '.basic-barista-widget', '[data-booking-url]'] },
    { name: 'photo_gallery', selectors: ['#mbs-photo-gallery', '.mbs-gallery-widget', '[data-mbs-gallery]'] }
  ];

  function checkWidgets() {
    widgets.forEach(function(w) {
      var root = null;
      var selector = '';
      for (var i = 0; i < w.selectors.length; i++) {
        root = document.querySelector(w.selectors[i]);
        if (root) { selector = w.selectors[i]; break; }
      }
      if (!root) return;
      var text = (root.innerText || root.textContent || '').slice(0, 300);
      var rect = root.getBoundingClientRect ? root.getBoundingClientRect() : { height: 0 };
      var problem = '';
      if (/Не удалось|Попробовать снова|Ошибка|error|failed/i.test(text)) problem = 'error_text';
      else if (/Загрузка|loading|skeleton/i.test(text) && rect.height > 40) problem = 'still_loading';
      else if (rect.height < 20 && !text.trim()) problem = 'empty_root';
      if (problem) {
        send('widget_problem', {
          widget: w.name,
          selector: selector,
          message: problem,
          detail: text
        });
      }
    });
  }

  window.addEventListener('load', function() {
    var timing = navTimings();
    send('page_load', Object.assign({ ok: true }, timing));
    if (timing.duration_ms && timing.duration_ms >= SLOW_PAGE_MS) {
      send('slow_page', Object.assign({ ok: false }, timing));
    }
    setTimeout(checkResources, 1500);
  });

  setTimeout(checkWidgets, 15000);
})();
`;
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


function parseYclientsCommentsPayload(parsed) {
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.comments)) return parsed.comments;
  return [];
}

function normalizeReviewComment(d, staffMap = {}, nameOverrides = {}) {
  const mid = d && d.master_id != null ? String(d.master_id) : null;
  if (!mid) return null;

  const text = String((d && d.text) || '').trim();
  const wordCount = text ? text.split(/\s+/).filter(w => w.length > 0).length : 0;
  if (wordCount < 4) return null;

  let masterName = ID_OVERRIDES[mid] || staffMap[mid] || STAFF_MAP[Number(mid)] || STAFF_MAP[mid] || (d && d.master_name) || null;
  if (!masterName && d && d.master_name && nameOverrides[d.master_name]) masterName = nameOverrides[d.master_name];

  let ts = null;
  try {
    ts = d && d.date ? Date.parse(d.date) : null;
    if (!Number.isFinite(ts)) ts = null;
  } catch (_) {
    ts = null;
  }

  const compact = {
    event: 'api.comments',
    text,
    date: (d && d.date) || null,
    id: (d && d.id) || null,
    rating: (d && typeof d.rating !== 'undefined') ? d.rating : 5,
    author_name: (d && d.user_name) || null,
    author_surname: null,
    master_id: mid,
    master_name: masterName || null
  };

  return {
    id: String((d && d.id) || ''),
    ts,
    compact,
    body: {
      event: 'api.comments',
      data: {
        id: (d && d.id) || null,
        type: (d && d.type) || null,
        master_id: mid,
        text,
        date: (d && d.date) || null,
        rating: (d && typeof d.rating !== 'undefined') ? d.rating : 5,
        user_name: (d && d.user_name) || '',
        user_avatar: (d && d.user_avatar) || '',
        master_name: masterName || (d && d.master_name) || null,
        staff: {
          id: mid,
          name: masterName || (d && d.master_name) || (((d && d.staff) || {}).name) || null
        }
      }
    }
  };
}

function filterSnapshotReviews(snapshot, { staffParam = '', ratingMin = 0, page = 1, count = 20 } = {}) {
  const staffSet = new Set(String(staffParam || '').split(',').map(s => s.trim()).filter(Boolean));
  const minRating = Math.max(0, Number(ratingMin) || 0);
  const pageNum = Math.max(1, Number(page) || 1);
  const limit = Math.max(1, Math.min(100, Number(count) || 20));

  let items = Array.isArray(snapshot && snapshot.items) ? snapshot.items : [];
  if (staffSet.size) {
    items = items.filter(it => {
      const mid = it && it.compact ? it.compact.master_id : null;
      return mid != null && staffSet.has(String(mid));
    });
  }
  if (minRating > 0) {
    items = items.filter(it => Number(it && it.compact ? it.compact.rating : 0) >= minRating);
  }

  const total = items.length;
  const start = (pageNum - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total,
    page: pageNum,
    limit,
    snapshot_ts: snapshot && snapshot.ts ? snapshot.ts : null,
    snapshot_age_ms: snapshot && snapshot.ts ? Math.max(0, Date.now() - Number(snapshot.ts)) : null
  };
}

async function loadReviewsSnapshot() {
  const cached = cacheGet(REVIEWS_SNAPSHOT_KEY);
  if (cached && Array.isArray(cached.items)) return cached;

  const raw = await KV.get(REVIEWS_SNAPSHOT_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || parsed.schema_version !== REVIEWS_SNAPSHOT_SCHEMA) return null;
    cachePut(REVIEWS_SNAPSHOT_KEY, parsed, REVIEWS_PUBLIC_CACHE_TTL);
    return parsed;
  } catch (_) {
    return null;
  }
}

async function saveReviewsSnapshot(snapshot) {
  await KV.put(REVIEWS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  cachePut(REVIEWS_SNAPSHOT_KEY, snapshot, REVIEWS_PUBLIC_CACHE_TTL);
}

async function refreshReviewsSnapshot({ force = false } = {}) {
  const current = await loadReviewsSnapshot();
  const age = current && current.ts ? Date.now() - Number(current.ts) : Infinity;
  const schemaIsCurrent = current && current.schema_version === REVIEWS_SNAPSHOT_SCHEMA;
  if (!force && current && schemaIsCurrent && Number.isFinite(age) && age < REVIEWS_SNAPSHOT_TTL_MS) {
    return { snapshot: current, refreshed: false, reason: 'fresh' };
  }

  if (!YCLIENTS_PARTNER_TOKEN) {
    if (current) return { snapshot: current, refreshed: false, reason: 'tokens_missing_stale' };
    throw new Error('YCLIENTS_PARTNER_TOKEN not configured');
  }

  if (__reviewsSnapshotRefreshPromise) {
    const snapshot = await __reviewsSnapshotRefreshPromise;
    return { snapshot, refreshed: false, reason: 'refresh_in_progress' };
  }

  __reviewsSnapshotRefreshPromise = (async () => {
    const staffMap = await getStaffMapCached();
    const nameOverrides = await getNameOverridesCached();
    const items = [];
    let page = 1;
    let pagesLoaded = 0;

    while (pagesLoaded < REVIEWS_SNAPSHOT_MAX_PAGES) {
      const target = new URL(YCLIENTS_API_BASE + '/api/v1/comments/' + encodeURIComponent(YCLIENTS_COMPANY_ID) + '/');
      target.searchParams.set('page', String(page));
      target.searchParams.set('count', String(REVIEWS_SNAPSHOT_PAGE_SIZE));

      const resp = await yclientsFetch(target.toString(), { timeout: 20000 });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error('YClients comments status ' + resp.status + ': ' + txt.slice(0, 200));
      }

      let parsed = null;
      try { parsed = JSON.parse(await resp.text()); } catch (e) { throw new Error('YClients comments invalid JSON'); }

      const dataArr = parseYclientsCommentsPayload(parsed);
      if (!dataArr.length) break;

      for (const d of dataArr) {
        const normalized = normalizeReviewComment(d, staffMap, nameOverrides);
        if (normalized) items.push(normalized);
      }

      pagesLoaded++;
      if (dataArr.length < REVIEWS_SNAPSHOT_PAGE_SIZE) break;
      page++;
    }

    items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

    const snapshot = {
      schema_version: REVIEWS_SNAPSHOT_SCHEMA,
      items,
      ts: Date.now(),
      count: items.length,
      pages_loaded: pagesLoaded,
      source: 'yclients-comments-daily'
    };
    await saveReviewsSnapshot(snapshot);
    await KV.put('reviews:snapshot:last_refresh', String(snapshot.ts));
    console.log('[reviews] Snapshot refreshed: ' + items.length + ' reviews, pages=' + pagesLoaded);
    return snapshot;
  })();

  try {
    const snapshot = await __reviewsSnapshotRefreshPromise;
    return { snapshot, refreshed: true, reason: 'updated' };
  } finally {
    __reviewsSnapshotRefreshPromise = null;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => res.send('ok'));

// Hosted widgets for Tilda. Tilda keeps a tiny stable embed; widget code updates here.
app.use('/widgets', express.static(path.join(__dirname, 'public', 'widgets'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    }
  }
}));

// ─── Site health monitor ────────────────────────────────────────────────────

app.get('/site-health/monitor.js', (req, res) => {
  res.set({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600'
  });
  res.send(getSiteHealthMonitorScript());
});

app.post('/site-health/event', async (req, res) => {
  try {
    if (!checkSiteHealthOrigin(req)) return res.status(403).json({ error: 'forbidden' });

    const ipRaw = String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
    const bucket = Math.floor(Date.now() / 60000);
    const rateKey = ipRaw + ':' + bucket;
    const current = (__siteHealthRate.get(rateKey) || 0) + 1;
    __siteHealthRate.set(rateKey, current);
    if (__siteHealthRate.size > 5000) {
      for (const key of __siteHealthRate.keys()) {
        if (!key.endsWith(':' + bucket)) __siteHealthRate.delete(key);
      }
    }
    if (current > 120) return res.status(429).json({ error: 'rate_limited' });

    const event = sanitizeHealthEvent(req.body, req);
    await appendSiteHealthEvent(event);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'site_health_failed', detail: e.message });
  }
});

app.get('/site-health/report', async (req, res) => {
  const queryKey = req.query.key || '';
  const headerKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  if (!ADMIN_KEY || (String(queryKey) !== String(ADMIN_KEY) && String(headerKey) !== String(ADMIN_KEY))) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 500) || 500));
  const events = readRecentSiteHealthEvents(limit);
  res.json({
    ok: true,
    log: siteHealthLogPath,
    version: SITE_HEALTH_MONITOR_VERSION,
    checks: SITE_HEALTH_CHECK_URLS,
    service_checks: SITE_HEALTH_SERVICE_CHECK_URLS,
    check_intervals: {
      core: SITE_HEALTH_CHECK_INTERVAL,
      service: SITE_HEALTH_SERVICE_CHECK_INTERVAL
    },
    summary: buildSiteHealthSummary(events),
    events
  });
});

// ─── GET /reviews ───────────────────────────────────────────────────────────

app.get('/reviews', async (req, res) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });

    const companyId = req.query.company_id || YCLIENTS_COMPANY_ID;
    if (!companyId) return res.status(400).json({ success: false, message: 'company_id is required' });
    if (String(companyId) !== String(YCLIENTS_COMPANY_ID)) {
      return res.status(400).json({ success: false, message: 'unsupported company_id' });
    }

    const staffParam = req.query.staff_id || req.query.staff_ids || '';
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const count = Math.max(1, Math.min(100, Number(req.query.count || 20) || 20));
    const ttl = Number(req.query.ttl || REVIEWS_PUBLIC_CACHE_TTL);
    const ratingMin = Number(req.query.rating_min || 0) || 0;
    const forceRefresh = req.query.refresh === '1' && checkAdmin(req);
    const fullLoadAllowed = req.query.full === '1' || req.query.allow_full === '1';

    const cacheKey = 'reviews:snapshot-route:' + companyId + ':s:' + (staffParam || 'all') + ':r:' + ratingMin + ':p:' + page + ':c:' + count + ':full:' + (fullLoadAllowed ? '1' : '0');
    if (!forceRefresh) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        res.set({ 'X-Cache': 'HIT', 'X-Reviews-Source': 'snapshot', 'Cache-Control': 'public, max-age=' + ttl });
        return res.json(cached);
      }
    }

    if (!fullLoadAllowed && page > 1) {
      const outData = { items: [], total: 0, page, limit: count, limited: true };
      cachePut(cacheKey, outData, ttl);
      res.set({
        'X-Cache': 'LIMITED',
        'X-Reviews-Source': 'snapshot',
        'X-Reviews-Limited': '1',
        'Cache-Control': 'public, max-age=' + ttl
      });
      return res.json(outData);
    }

    let snapshot = await loadReviewsSnapshot();
    const isStale = !snapshot || !snapshot.ts || (Date.now() - Number(snapshot.ts)) > REVIEWS_SNAPSHOT_TTL_MS;

    if (forceRefresh || !snapshot) {
      const refreshed = await refreshReviewsSnapshot({ force: forceRefresh || !snapshot });
      snapshot = refreshed.snapshot;
    } else if (isStale) {
      refreshReviewsSnapshot().catch(e => console.error('[reviews] Background snapshot refresh failed:', e.message));
    }

    if (!snapshot || !Array.isArray(snapshot.items)) {
      return res.status(503).json({ error: 'reviews_snapshot_unavailable' });
    }

    const outData = filterSnapshotReviews(snapshot, { staffParam, ratingMin, page, count });
    cachePut(cacheKey, outData, ttl);
    res.set({
      'X-Cache': forceRefresh ? 'REFRESH' : 'MISS',
      'X-Reviews-Source': 'snapshot',
      'X-Reviews-Snapshot-Age': String(outData.snapshot_age_ms || 0),
      'Cache-Control': 'public, max-age=' + ttl
    });
    return res.json(outData);
  } catch (e) {
    res.status(500).json({ error: 'reviews_failed', detail: e.message });
  }
});

// ─── GET /reviews-bundle ────────────────────────────────────────────────────

app.get('/reviews-bundle', async (req, res) => {
  try {
    if (!checkOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    if (!checkReadKey(req)) return res.status(401).json({ error: 'unauthorized' });

    const forceRefresh = req.query.refresh === '1' && checkAdmin(req);
    const refreshed = await refreshReviewsSnapshot({ force: forceRefresh });
    const snapshot = refreshed.snapshot;
    const outData = {
      reviews: (snapshot.items || []).map(it => ({
        id: it.id || null,
        t: it.compact ? it.compact.text : '',
        d: it.compact ? it.compact.date : null,
        r: it.compact ? it.compact.rating : 5,
        a: it.compact ? it.compact.author_name : '',
        m: it.compact ? it.compact.master_id : null,
        mn: it.compact ? it.compact.master_name : ''
      })),
      ts: snapshot.ts,
      count: snapshot.count || (snapshot.items || []).length,
      refreshed: refreshed.refreshed,
      source: 'snapshot'
    };
    res.set({
      'X-Cache': refreshed.refreshed ? 'REFRESH' : 'HIT',
      'X-Reviews-Source': 'snapshot',
      'X-Reviews-Count': String(outData.count),
      'Cache-Control': 'public, max-age=' + REVIEWS_PUBLIC_CACHE_TTL
    });
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

async function cronRefreshReviewsSnapshot() {
  try {
    await refreshReviewsSnapshot();
  } catch (e) {
    console.error('[cron] Reviews snapshot refresh error:', e.message);
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

async function siteHealthFetchCheck(url, group = 'core') {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITE_HEALTH_CHECK_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'MBS-SiteHealth/1.0',
        'Accept': 'text/html,application/javascript,application/json,text/plain,*/*'
      }
    });
    const duration = Date.now() - started;
    await appendSiteHealthEvent({
      ts: Date.now(),
      iso: new Date().toISOString(),
      type: 'server_check',
      source: 'server',
      group,
      ok: resp.ok,
      resource: sanitizeUrl(url),
      status: resp.status,
      duration_ms: duration,
      version: SITE_HEALTH_MONITOR_VERSION
    });
  } catch (e) {
    await appendSiteHealthEvent({
      ts: Date.now(),
      iso: new Date().toISOString(),
      type: 'server_check_error',
      source: 'server',
      group,
      ok: false,
      resource: sanitizeUrl(url),
      duration_ms: Date.now() - started,
      message: truncateString(e && e.message ? e.message : e, 500),
      version: SITE_HEALTH_MONITOR_VERSION
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function cronSiteHealthChecks() {
  for (const url of SITE_HEALTH_CHECK_URLS) {
    const group = url.includes('api.barista-school.ru') ? 'api' : 'core';
    await siteHealthFetchCheck(url, group);
  }
}

async function cronSiteHealthServiceChecks() {
  for (const url of SITE_HEALTH_SERVICE_CHECK_URLS) {
    await siteHealthFetchCheck(url, 'service');
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
    await cronRefreshReviewsSnapshot();
    await cronCleanShort();
  });

  // Daily forced refresh at 04:20 MSK. Visitors always read the snapshot, not YClients directly.
  cron.schedule('20 4 * * *', async () => {
    console.log('[cron] Refreshing reviews snapshot...');
    try {
      await refreshReviewsSnapshot({ force: true });
    } catch (e) {
      console.error('[cron] Reviews daily snapshot refresh error:', e.message);
    }
  });

  cron.schedule(SITE_HEALTH_CHECK_INTERVAL, async () => {
    try {
      await cronSiteHealthChecks();
    } catch (e) {
      console.error('[cron] Site health checks failed:', e.message);
    }
  });

  cron.schedule(SITE_HEALTH_SERVICE_CHECK_INTERVAL, async () => {
    try {
      await cronSiteHealthServiceChecks();
    } catch (e) {
      console.error('[cron] Site health service checks failed:', e.message);
    }
  });

  refreshReviewsSnapshot().catch(e => console.error('[startup] Reviews snapshot warmup failed:', e.message));
  cronSiteHealthChecks().catch(e => console.error('[startup] Site health checks failed:', e.message));
  console.log('[cron] Scheduled tasks enabled (staff every 6 hours, reviews daily, site health core every minute, services every 15 minutes)');
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
