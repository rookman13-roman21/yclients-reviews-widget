const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecordsIndex,
  enrichReviewItems,
  getOrCreateEnrichmentSince,
  lastVisitBeforeReview,
  reviewClientId
} = require('../review-visit-enrichment');

function memoryKv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, String(value)); },
    values
  };
}

const records = {
  records: [
    {
      client: { id: 11, phone: '+79990000000', name: 'Не попадает в feed' },
      datetime: '2026-07-28T09:00:00+03:00', attendance: 1,
      services: [{ title: 'Базовый курс бариста' }]
    },
    {
      client: { id: 11 }, datetime: '2026-07-28T15:00:00+03:00', attendance: 1,
      services: [{ title: 'Латте-арт' }]
    },
    {
      client: { id: 11 }, datetime: '2026-07-29T10:00:00+03:00', attendance: 1,
      services: [{ title: 'Будущий визит' }]
    },
    {
      client: { id: 11 }, datetime: '2026-07-28T16:00:00+03:00', attendance: -1,
      services: [{ title: 'Неявка' }]
    },
    {
      client: { id: 11 }, datetime: '2026-07-28T17:00:00+03:00', attendance: 1, cancelled: true,
      services: [{ title: 'Отмена' }]
    }
  ]
};

test('selects the last completed visit before the full review datetime', () => {
  const index = buildRecordsIndex(records);
  const visit = lastVisitBeforeReview(index.get('11'), '2026-07-28T18:00:00+03:00');

  assert.deepEqual(visit, {
    date: '2026-07-28T15:00:00+03:00',
    service_title: 'Латте-арт'
  });
  assert.equal(lastVisitBeforeReview(index.get('11'), '2026-07-28'), null);
});

test('compares yClients local datetimes in Moscow time', () => {
  const index = buildRecordsIndex({
    records: [{
      client: { id: 12 }, datetime: '2026-07-28 10:00:00', attendance: 1,
      services: [{ title: 'Каппинг' }]
    }]
  });

  assert.deepEqual(lastVisitBeforeReview(index.get('12'), '2026-07-28 10:30:00'), {
    date: '2026-07-28 10:00:00',
    service_title: 'Каппинг'
  });
});

test('uses only explicit client identifiers from the review, never the name or phone', () => {
  assert.equal(reviewClientId({ client_id: 11, user_name: 'Аня' }), '11');
  assert.equal(reviewClientId({ user: { id: 12 }, user_name: 'Аня' }), '12');
  assert.equal(reviewClientId({ user_name: 'Аня', user_phone: '+79990000000' }), null);
});

test('caches review visit context by review ID and keeps client IDs out of the feed item', async () => {
  const kv = memoryKv();
  const index = buildRecordsIndex(records);
  const items = [{
    id: 'review-1', date: '2026-07-28T18:00:00+03:00', clientId: '11',
    clientName: 'Аня', trainerName: 'Никита', rating: 4, text: 'Спасибо за занятие'
  }];

  const first = await enrichReviewItems(items, {
    kv, visitIndex: index, since: Date.parse('2026-07-28T00:00:00+03:00'), now: 100
  });
  const second = await enrichReviewItems(items, {
    kv, visitIndex: new Map(), since: Date.parse('2026-07-28T00:00:00+03:00'), now: 200
  });

  assert.equal(first.stats.found, 1);
  assert.equal(second.stats.cached, 1);
  assert.deepEqual(second.items[0].lastVisit, first.items[0].lastVisit);
  assert.equal(Object.hasOwn(second.items[0], 'clientId'), false);
  assert.equal(JSON.stringify(second.items[0]).includes('11'), false);
});

test('creates the historic boundary once so existing reviews are not enriched', async () => {
  const kv = memoryKv();
  const since = await getOrCreateEnrichmentSince(kv, Date.parse('2026-07-30T09:00:00Z'));
  const repeated = await getOrCreateEnrichmentSince(kv, Date.parse('2026-07-31T09:00:00Z'));

  assert.equal(since, Date.parse('2026-07-30T09:00:00.000Z'));
  assert.equal(repeated, since);
});
