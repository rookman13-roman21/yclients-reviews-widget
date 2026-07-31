const fs = require('fs');
const path = require('path');

const REVIEW_FEED_SCHEMA = 1;

function nullableRating(value) {
  if (value === null || typeof value === 'undefined' || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 5 ? numeric : null;
}

function normalizeVisit(lastVisit) {
  if (!lastVisit || typeof lastVisit !== 'object') return null;
  const date = String(lastVisit.date || '').trim();
  if (!date) return null;
  const serviceTitle = String(lastVisit.serviceTitle || lastVisit.service_title || '').trim();
  return {
    date,
    service_title: serviceTitle || null
  };
}

function normalizeFeedReview({ id, date, rating, clientName, trainerName, lastVisit, text }) {
  const stableId = String(id || '').trim();
  const reviewText = String(text || '').trim();
  if (!stableId || !reviewText) return null;

  const normalized = {
    id: stableId,
    date: date ? String(date) : null,
    rating: nullableRating(rating),
    client_name: clientName ? String(clientName).trim() || null : null,
    trainer_name: trainerName ? String(trainerName).trim() || null : null,
    text: reviewText
  };
  const visit = normalizeVisit(lastVisit);
  return visit ? { ...normalized, last_visit: visit } : normalized;
}

function buildReviewFeed(items, generatedAt = new Date().toISOString()) {
  const byId = new Map();
  for (const item of items || []) {
    const normalized = normalizeFeedReview(item || {});
    if (normalized) byId.set(normalized.id, normalized);
  }
  const reviews = [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.date || '') || 0;
    const rightTime = Date.parse(right.date || '') || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return right.id.localeCompare(left.id);
  });
  return {
    schema_version: REVIEW_FEED_SCHEMA,
    generated_at: generatedAt,
    source: 'yclients-comments-snapshot',
    items: reviews
  };
}

function assertFeed(feed) {
  if (!feed || feed.schema_version !== REVIEW_FEED_SCHEMA || !Array.isArray(feed.items)) {
    throw new Error('invalid internal reviews feed');
  }
  for (const item of feed.items) {
    if (!item || !item.id || !item.text || !Object.prototype.hasOwnProperty.call(item, 'rating')) {
      throw new Error('invalid internal reviews feed item');
    }
    if (Object.prototype.hasOwnProperty.call(item, 'client_id')) {
      throw new Error('internal reviews feed must not contain client IDs');
    }
    if (Object.prototype.hasOwnProperty.call(item, 'last_visit')) {
      const visit = item.last_visit;
      if (!visit || typeof visit !== 'object' || !String(visit.date || '').trim()) {
        throw new Error('invalid internal reviews feed visit context');
      }
      const unsupportedKeys = Object.keys(visit).filter(key => !['date', 'service_title'].includes(key));
      if (unsupportedKeys.length) throw new Error('internal reviews feed visit context contains private fields');
    }
  }
}

function writeFeedAtomic(targetPath, feed) {
  assertFeed(feed);
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });

  const serialized = JSON.stringify(feed) + '\n';
  // Validate exactly what will be published before replacing a known-good feed.
  assertFeed(JSON.parse(serialized));

  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temporaryPath, 'wx', 0o640);
  try {
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, 0o640);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

module.exports = {
  REVIEW_FEED_SCHEMA,
  buildReviewFeed,
  normalizeFeedReview,
  normalizeVisit,
  nullableRating,
  writeFeedAtomic
};
