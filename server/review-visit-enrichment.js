const fs = require('fs');

const VISIT_CONTEXT_CACHE_PREFIX = 'reviews:visit-context:v2:';
const VISIT_CONTEXT_SINCE_KEY = 'reviews:visit-context:v1:since';
const NOT_FOUND_RECHECK_MS = 6 * 60 * 60 * 1000;
const VISIT_CONTEXT_CACHE_SCHEMA = 2;

let recordsSnapshotCache = {
  path: '',
  mtimeMs: 0,
  size: 0,
  index: null
};

function cleanText(value) {
  return String(value || '').trim();
}

function cleanId(value) {
  const text = cleanText(value);
  return text || null;
}

function normalizePhone(value) {
  let digits = cleanText(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  if (digits.length === 10 && digits.startsWith('9')) digits = '7' + digits;
  return /^7\d{10}$/.test(digits) ? digits : null;
}

function parseDateTime(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  // yClients can return a local datetime without an offset. Interpret that
  // format as Moscow time explicitly so a server timezone cannot change the
  // order of a visit and its review.
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const localYclientsDateTime = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?$/.test(raw);
  const comparable = localYclientsDateTime && !hasExplicitOffset
    ? raw.replace(' ', 'T') + '+03:00'
    : raw;
  const timestamp = Date.parse(comparable);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasFullDateTime(value) {
  const raw = cleanText(value);
  return Boolean(raw && (raw.includes('T') || /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(raw)));
}

/**
 * The comments endpoint is not documented as a client-history endpoint.  We
 * therefore accept only explicit client identifiers that belong to the
 * comment author; names and phone numbers are deliberately never a fallback.
 */
function reviewClientId(comment) {
  if (!comment || typeof comment !== 'object') return null;
  const user = comment.user && typeof comment.user === 'object' ? comment.user : {};
  const client = comment.client && typeof comment.client === 'object' ? comment.client : {};
  // `user_id` identifies a comment user, not necessarily a yClients client
  // record. Production data has shown the two ID spaces can differ, so never
  // let a comment-user ID suppress the guarded phone fallback below.
  return cleanId(comment.client_id)
    || cleanId(user.client_id)
    || cleanId(client.id);
}

function reviewPhone(comment) {
  if (!comment || typeof comment !== 'object') return null;
  const user = comment.user && typeof comment.user === 'object' ? comment.user : {};
  const client = comment.client && typeof comment.client === 'object' ? comment.client : {};
  return normalizePhone(comment.user_phone)
    || normalizePhone(comment.phone)
    || normalizePhone(user.phone)
    || normalizePhone(comment.client_phone)
    || normalizePhone(client.phone);
}

function isCompletedVisit(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.deleted || record.is_deleted || record.cancelled || record.canceled) return false;
  const attendance = cleanText(
    Object.prototype.hasOwnProperty.call(record, 'attendance')
      ? record.attendance
      : record.visit_attendance
  ).toLowerCase();
  return attendance === '1' || attendance === 'visited' || attendance === 'came';
}

function visitServiceTitle(record) {
  const services = Array.isArray(record && record.services) ? record.services : [];
  const titles = services
    .filter(item => item && typeof item === 'object')
    .map(item => cleanText(item.title))
    .filter(Boolean);
  return titles.length ? titles.join(', ') : null;
}

function normalizedVisit(record) {
  if (!isCompletedVisit(record)) return null;
  const date = cleanText(record.datetime || record.date);
  const timestamp = parseDateTime(date);
  if (timestamp === null) return null;
  return {
    date,
    timestamp,
    serviceTitle: visitServiceTitle(record)
  };
}

function recordClientId(record) {
  const client = record && record.client && typeof record.client === 'object' ? record.client : {};
  return cleanId(record && record.client_id) || cleanId(client.id);
}

function recordPhones(record) {
  const client = record && record.client && typeof record.client === 'object' ? record.client : {};
  return [...new Set([
    normalizePhone(record && record.phone),
    normalizePhone(client.phone),
    normalizePhone(client.mobile),
    normalizePhone(client.mobile_phone)
  ].filter(Boolean))];
}

function buildRecordIndexes(payload) {
  const records = payload && Array.isArray(payload.records) ? payload.records : null;
  if (!records) throw new Error('records snapshot is invalid');

  const clientIndex = new Map();
  const phoneIndex = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const clientId = recordClientId(record);
    if (clientId) {
      for (const phone of recordPhones(record)) {
        const clientIds = phoneIndex.get(phone) || new Set();
        clientIds.add(clientId);
        phoneIndex.set(phone, clientIds);
      }
    }
    const visit = normalizedVisit(record);
    if (!clientId || !visit) continue;
    const visits = clientIndex.get(clientId) || [];
    visits.push(visit);
    clientIndex.set(clientId, visits);
  }
  for (const visits of clientIndex.values()) visits.sort((left, right) => left.timestamp - right.timestamp);
  return { clientIndex, phoneIndex };
}

function buildRecordsIndex(payload) {
  return buildRecordIndexes(payload).clientIndex;
}

function buildRecordsPhoneIndex(payload) {
  return buildRecordIndexes(payload).phoneIndex;
}

function readRecordsSnapshotIndex(snapshotPath) {
  const stat = fs.statSync(snapshotPath);
  if (
    recordsSnapshotCache.index
    && recordsSnapshotCache.path === snapshotPath
    && recordsSnapshotCache.mtimeMs === stat.mtimeMs
    && recordsSnapshotCache.size === stat.size
  ) {
    return recordsSnapshotCache.index;
  }

  const payload = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const indexes = buildRecordIndexes(payload);
  recordsSnapshotCache = { path: snapshotPath, mtimeMs: stat.mtimeMs, size: stat.size, index: indexes };
  return indexes;
}

function lastVisitBeforeReview(visits, reviewDate) {
  const reviewTimestamp = parseDateTime(reviewDate);
  if (reviewTimestamp === null || !hasFullDateTime(reviewDate) || !Array.isArray(visits)) return null;
  for (let index = visits.length - 1; index >= 0; index -= 1) {
    const visit = visits[index];
    if (visit.timestamp <= reviewTimestamp) {
      return {
        date: visit.date,
        service_title: visit.serviceTitle
      };
    }
  }
  return null;
}

function lastVisitByUniquePhone(phoneIndex, visitIndex, phone, reviewDate) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !(phoneIndex instanceof Map)) return { status: 'unavailable', lastVisit: null };
  const clientIds = phoneIndex.get(normalizedPhone);
  if (!clientIds || clientIds.size === 0) return { status: 'not_found', lastVisit: null };
  if (clientIds.size !== 1) return { status: 'ambiguous', lastVisit: null };
  const [clientId] = clientIds;
  return {
    status: 'unique',
    lastVisit: lastVisitBeforeReview(visitIndex instanceof Map ? visitIndex.get(clientId) : null, reviewDate)
  };
}

function cachedVisitContext(raw, reviewDate, now) {
  if (!raw) return undefined;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { return undefined; }
  if (!parsed || parsed.schema_version !== VISIT_CONTEXT_CACHE_SCHEMA || parsed.review_date !== reviewDate) return undefined;
  if (parsed.last_visit) return parsed.last_visit;
  const resolvedAt = Number(parsed.resolved_at || 0);
  return Number.isFinite(resolvedAt) && now - resolvedAt < NOT_FOUND_RECHECK_MS ? null : undefined;
}

function publicReviewItem(item) {
  const { clientId, clientPhone, lastVisit, ...publicItem } = item;
  return lastVisit ? { ...publicItem, lastVisit } : publicItem;
}

async function getOrCreateEnrichmentSince(kv, now = Date.now()) {
  const raw = await kv.get(VISIT_CONTEXT_SINCE_KEY);
  const timestamp = parseDateTime(raw);
  if (timestamp !== null) return timestamp;
  const created = new Date(now).toISOString();
  await kv.put(VISIT_CONTEXT_SINCE_KEY, created);
  return parseDateTime(created);
}

async function enrichReviewItems(items, { kv, visitIndex, phoneIndex, since, now = Date.now() }) {
  const enriched = [];
  const stats = {
    eligible: 0, linked: 0, missingClientId: 0, found: 0, notFound: 0, cached: 0,
    phoneResolved: 0, phoneAmbiguous: 0, phoneUnavailable: 0
  };
  for (const item of items || []) {
    const reviewDate = cleanText(item && item.date);
    const reviewTimestamp = parseDateTime(reviewDate);
    if (!item || !item.id || reviewTimestamp === null || reviewTimestamp < since) {
      enriched.push(publicReviewItem(item || {}));
      continue;
    }

    stats.eligible += 1;
    if (item.clientId) stats.linked += 1;
    else stats.missingClientId += 1;
    const cacheKey = VISIT_CONTEXT_CACHE_PREFIX + String(item.id);
    const cached = cachedVisitContext(await kv.get(cacheKey), reviewDate, now);
    if (typeof cached !== 'undefined') {
      stats.cached += 1;
      if (cached) stats.found += 1;
      else stats.notFound += 1;
      enriched.push(publicReviewItem({ ...item, lastVisit: cached || null }));
      continue;
    }

    let lastVisit = item.clientId
      ? lastVisitBeforeReview(visitIndex instanceof Map ? visitIndex.get(String(item.clientId)) : null, reviewDate)
      : null;
    if (!lastVisit && !item.clientId) {
      const phoneResult = lastVisitByUniquePhone(phoneIndex, visitIndex, item.clientPhone, reviewDate);
      if (phoneResult.lastVisit) {
        lastVisit = phoneResult.lastVisit;
        stats.phoneResolved += 1;
      } else if (phoneResult.status === 'ambiguous') {
        stats.phoneAmbiguous += 1;
      } else if (phoneResult.status === 'unavailable') {
        stats.phoneUnavailable += 1;
      }
    }
    await kv.put(cacheKey, JSON.stringify({
      schema_version: VISIT_CONTEXT_CACHE_SCHEMA,
      review_date: reviewDate,
      last_visit: lastVisit,
      resolved_at: now
    }));
    if (lastVisit) stats.found += 1;
    else stats.notFound += 1;
    enriched.push(publicReviewItem({ ...item, lastVisit }));
  }
  return { items: enriched, stats };
}

module.exports = {
  VISIT_CONTEXT_CACHE_PREFIX,
  VISIT_CONTEXT_SINCE_KEY,
  buildRecordsPhoneIndex,
  buildRecordsIndex,
  enrichReviewItems,
  getOrCreateEnrichmentSince,
  isCompletedVisit,
  lastVisitBeforeReview,
  normalizePhone,
  readRecordsSnapshotIndex,
  reviewClientId,
  reviewPhone
};
