const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewFeed, normalizeFeedReview, writeFeedAtomic } = require('../review-feed');

test('internal feed keeps null ratings and permits a missing trainer', () => {
  const item = normalizeFeedReview({
    id: '42', date: '2026-07-28T10:00:00+03:00', rating: null,
    clientName: 'Аня', trainerName: null, text: 'Спасибо за занятие'
  });
  assert.deepEqual(item, {
    id: '42', date: '2026-07-28T10:00:00+03:00', rating: null,
    client_name: 'Аня', trainer_name: null, text: 'Спасибо за занятие'
  });
});

test('internal feed permits visit context but never serializes a client identifier', () => {
  const item = normalizeFeedReview({
    id: '43',
    date: '2026-07-30T12:00:00+03:00',
    rating: 4,
    clientName: 'Аня',
    trainerName: 'Никита',
    clientId: 'private-client-id',
    lastVisit: { date: '2026-07-29T10:00:00+03:00', serviceTitle: 'Основы бариста' },
    text: 'Очень полезное занятие'
  });

  assert.deepEqual(item.last_visit, {
    date: '2026-07-29T10:00:00+03:00',
    service_title: 'Основы бариста'
  });
  assert.equal(Object.hasOwn(item, 'client_id'), false);
  assert.equal(JSON.stringify(item).includes('private-client-id'), false);
});

test('internal feed deduplicates stable IDs and rejects records without them', () => {
  const feed = buildReviewFeed([
    { id: 'one', date: '2026-07-28T10:00:00Z', rating: 5, text: 'Первый вариант' },
    { id: 'one', date: '2026-07-28T11:00:00Z', rating: 3, text: 'Актуальный вариант' },
    { id: '', date: '2026-07-28T12:00:00Z', rating: 1, text: 'Без ID' }
  ], '2026-07-28T12:00:00Z');

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].rating, 3);
  assert.equal(feed.items[0].text, 'Актуальный вариант');
});

test('atomic writer never exposes an incomplete JSON file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-feed-'));
  const target = path.join(directory, 'feed.json');
  const feed = buildReviewFeed([{ id: 'one', rating: 5, text: 'Отзыв' }]);

  writeFeedAtomic(target, feed);

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), feed);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('atomic writer rejects accidental client identifiers in the private feed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-feed-'));
  const target = path.join(directory, 'feed.json');
  const feed = buildReviewFeed([{ id: 'one', rating: 5, text: 'Отзыв' }]);
  feed.items[0].client_id = 'must-not-be-published';

  assert.throws(() => writeFeedAtomic(target, feed), /must not contain client IDs/);
  fs.rmSync(directory, { recursive: true, force: true });
});
