const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecordsPhoneIndex,
  buildRecordsIndex,
  enrichReviewItems,
  getOrCreateEnrichmentSince,
  lastVisitBeforeReview,
  reviewClientId,
  reviewPhone
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

test('normalizes an explicit review phone without treating it as a client ID', () => {
  assert.equal(reviewPhone({ user_phone: '8 (999) 000-00-00' }), '79990000000');
  assert.equal(reviewPhone({ user_phone: '9990000000' }), '79990000000');
  assert.equal(reviewPhone({ user_phone: '999000000' }), null);
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

test('uses a phone fallback only for one exact snapshot client and never exposes the phone', async () => {
  const kv = memoryKv();
  const visitIndex = buildRecordsIndex(records);
  const phoneIndex = buildRecordsPhoneIndex(records);
  const phone = '79990000000';
  const items = [{
    id: 'review-phone-1', date: '2026-07-28T18:00:00+03:00', clientId: 'nonmatching-comment-user',
    clientPhone: phone, clientName: 'Аня', trainerName: 'Никита', rating: 5, text: 'Спасибо'
  }];

  const result = await enrichReviewItems(items, {
    kv, visitIndex, phoneIndex, since: Date.parse('2026-07-28T00:00:00+03:00'), now: 100
  });

  assert.equal(result.stats.phoneResolved, 1);
  assert.deepEqual(result.items[0].lastVisit, {
    date: '2026-07-28T15:00:00+03:00',
    service_title: 'Латте-арт'
  });
  assert.equal(JSON.stringify(result.items[0]).includes(phone), false);
  assert.equal(JSON.stringify([...kv.values.values()]).includes(phone), false);
});

test('keeps a successful client ID match ahead of a different phone match', async () => {
  const kv = memoryKv();
  const recordsWithDifferentPhone = {
    records: [...records.records, {
      client: { id: 22, phone: '+79991111111' },
      datetime: '2026-07-28T17:00:00+03:00', attendance: 1,
      services: [{ title: 'Телефонный fallback не должен выбраться' }]
    }]
  };
  const result = await enrichReviewItems([{
    id: 'review-id-priority', date: '2026-07-28T18:00:00+03:00', clientId: '11',
    clientPhone: '79991111111', text: 'Спасибо'
  }], {
    kv,
    visitIndex: buildRecordsIndex(recordsWithDifferentPhone),
    phoneIndex: buildRecordsPhoneIndex(recordsWithDifferentPhone),
    since: Date.parse('2026-07-28T00:00:00+03:00'), now: 100
  });

  assert.equal(result.stats.phoneResolved, 0);
  assert.deepEqual(result.items[0].lastVisit, {
    date: '2026-07-28T15:00:00+03:00',
    service_title: 'Латте-арт'
  });
});

test('does not resolve a program from an invalid phone', async () => {
  const kv = memoryKv();
  const result = await enrichReviewItems([{
    id: 'review-invalid-phone', date: '2026-07-28T18:00:00+03:00',
    clientPhone: '999000000', text: 'Спасибо'
  }], {
    kv,
    visitIndex: buildRecordsIndex(records),
    phoneIndex: buildRecordsPhoneIndex(records),
    since: Date.parse('2026-07-28T00:00:00+03:00'), now: 100
  });

  assert.equal(result.stats.phoneUnavailable, 1);
  assert.equal(Object.hasOwn(result.items[0], 'lastVisit'), false);
});

test('refuses a phone fallback shared by multiple snapshot clients', async () => {
  const kv = memoryKv();
  const duplicatedPhoneRecords = {
    records: [...records.records, {
      client: { id: 22, phone: '+79990000000' },
      datetime: '2026-07-28T12:00:00+03:00', attendance: 1,
      services: [{ title: 'Другой визит' }]
    }]
  };
  const result = await enrichReviewItems([{
    id: 'review-phone-ambiguous', date: '2026-07-28T18:00:00+03:00', clientPhone: '79990000000', text: 'Спасибо'
  }], {
    kv,
    visitIndex: buildRecordsIndex(duplicatedPhoneRecords),
    phoneIndex: buildRecordsPhoneIndex(duplicatedPhoneRecords),
    since: Date.parse('2026-07-28T00:00:00+03:00'), now: 100
  });

  assert.equal(result.stats.phoneAmbiguous, 1);
  assert.equal(Object.hasOwn(result.items[0], 'lastVisit'), false);
});

test('creates the historic boundary once so existing reviews are not enriched', async () => {
  const kv = memoryKv();
  const since = await getOrCreateEnrichmentSince(kv, Date.parse('2026-07-30T09:00:00Z'));
  const repeated = await getOrCreateEnrichmentSince(kv, Date.parse('2026-07-31T09:00:00Z'));

  assert.equal(since, Date.parse('2026-07-30T09:00:00.000Z'));
  assert.equal(repeated, since);
});
