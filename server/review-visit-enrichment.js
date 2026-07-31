const fs = require('fs');

const VISIT_CONTEXT_CACHE_PREFIX = 'reviews:visit-context:v1:';
const VISIT_CONTEXT_SINCE_KEY = 'reviews:visit-context:v1:since';
const NOT_FOUND_RECHECK_MS = 6 * 60 * 60 * 1000;

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
  return cleanId(comment.client_id)
    || cleanId(comment.user_id)
    || cleanId(user.client_id)
    || cleanId(user.id)
    || cleanId(client.id);
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

function buildRecordsIndex(payload) {
  const records = payload && Array.isArray(payload.records) ? payload.records : null;
  if (!records) throw new Error('records snapshot is invalid');

  const index = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const client = record.client && typeof record.client === 'object' ? record.client : {};
    const clientId = cleanId(record.client_id) || cleanId(client.id);
    const visit = normalizedVisit(record);
    if (!clientId || !visit) continue;
    const visits = index.get(clientId) || [];
    visits.push(visit);
    index.set(clientId, visits);
  }
  for (const visits of index.values()) visits.sort((left, right) => left.timestamp - right.timestamp);
  return index;
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
  const index = buildRecordsIndex(payload);
  recordsSnapshotCache = { path: snapshotPath, mtimeMs: stat.mtimeMs, size: stat.size, index };
  return index;
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

function cachedVisitContext(raw, reviewDate, now) {
  if (!raw) return undefined;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { return undefined; }
  if (!parsed || parsed.schema_version !== 1 || parsed.review_date !== reviewDate) return undefined;
  if (parsed.last_visit) return parsed.last_visit;
  const resolvedAt = Number(parsed.resolved_at || 0);
  return Number.isFinite(resolvedAt) && now - resolvedAt < NOT_FOUND_RECHECK_MS ? null : undefined;
}

function publicReviewItem(item) {
  const { clientId, lastVisit, ...publicItem } = item;
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

async function enrichReviewItems(items, { kv, visitIndex, since, now = Date.now() }) {
  const enriched = [];
  const stats = { eligible: 0, linked: 0, missingClientId: 0, found: 0, notFound: 0, cached: 0 };
  for (const item of items || []) {
    const reviewDate = cleanText(item && item.date);
    const reviewTimestamp = parseDateTime(reviewDate);
    if (!item || !item.id || reviewTimestamp === null || reviewTimestamp < since) {
      enriched.push(publicReviewItem(item || {}));
      continue;
    }

    stats.eligible += 1;
    if (!item.clientId) {
      stats.missingClientId += 1;
      enriched.push(publicReviewItem(item));
      continue;
    }

    stats.linked += 1;
    const cacheKey = VISIT_CONTEXT_CACHE_PREFIX + String(item.id);
    const cached = cachedVisitContext(await kv.get(cacheKey), reviewDate, now);
    if (typeof cached !== 'undefined') {
      stats.cached += 1;
      if (cached) stats.found += 1;
      else stats.notFound += 1;
      enriched.push(publicReviewItem({ ...item, lastVisit: cached || null }));
      continue;
    }

    const lastVisit = lastVisitBeforeReview(visitIndex.get(String(item.clientId)), reviewDate);
    await kv.put(cacheKey, JSON.stringify({
      schema_version: 1,
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
  buildRecordsIndex,
  enrichReviewItems,
  getOrCreateEnrichmentSince,
  isCompletedVisit,
  lastVisitBeforeReview,
  readRecordsSnapshotIndex,
  reviewClientId
};
