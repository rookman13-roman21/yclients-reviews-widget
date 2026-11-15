'use strict';

// Плановое обновление снимка: каждый запуск cron пишет строку начала с
// временной меткой и строку итога с id попытки, а попытка — свои строки начала
// и итога с тем же id. По этим строкам считается суточная приёмка.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { startServer } = require('./helpers/server-harness');

let server;

before(async () => {
  server = await startServer({
    DISABLE_CRON: '0',
    REVIEWS_SNAPSHOT_CRON: '* * * * * *', // каждую секунду
    SITE_HEALTH_CHECK_INTERVAL: '0 0 1 1 *',
    SITE_HEALTH_SERVICE_CHECK_INTERVAL: '0 0 1 1 *',
    SITE_HEALTH_CHECK_URLS: 'https://site-health.invalid/',
  });
});
after(() => { if (server) server.stop(); });

const RUN_FINISHED = /\[cron\] Reviews snapshot run finished: started_at=(\d{4}-\d\d-\d\dT[\d:.]+Z), result=(\S+), refresh_id=(\S+)/g;

function runs() {
  return [...server.output().matchAll(RUN_FINISHED)].map((match) => ({ startedAt: match[1], result: match[2], refreshId: match[3] }));
}

test('successful planned run: start line, finish line and the linked refresh attempt', async () => {
  await server.control('set', { limiter: 'grant', yclients: 'ok', reviews: 5 });

  const run = await server.waitFor(() => runs().find((item) => item.result === 'updated'), 'a successful planned run');
  const log = server.output();

  assert.ok(log.includes('[cron] Reviews snapshot run started: at=' + run.startedAt), log);
  assert.ok(log.includes('[reviews] Refresh started: id=' + run.refreshId + ', at='), log);
  assert.match(log, new RegExp('\\[reviews\\] Refresh started: id=' + run.refreshId + ', at=\\S+, trigger=cron-snapshot, force=1'));
  assert.ok(log.includes('[reviews] Refresh finished: id=' + run.refreshId + ', result=ok, reviews=5, pages=1, requests=1, '), log);
});

test('failed planned run: finish line says failed and the attempt names the reason', async () => {
  await server.control('set', { limiter: 'deferred' });

  const run = await server.waitFor(() => runs().find((item) => item.result === 'failed'), 'a failed planned run');
  const log = server.output();

  assert.ok(log.includes('[cron] Reviews snapshot run started: at=' + run.startedAt), log);
  assert.ok(log.includes('[reviews] Refresh finished: id=' + run.refreshId + ', result=failed, error=limiter_deferred, pages=0, requests=0, '), log);

  const widget = await server.request('GET', '/reviews?count=3');
  assert.equal(widget.status, 200);
  assert.equal(widget.body.total, 5);
});

test('every planned run has exactly one finish line', async () => {
  await server.waitFor(() => runs().length >= 4, 'four planned runs');
  const log = server.output();
  const started = [...log.matchAll(/\[cron\] Reviews snapshot run started: at=(\S+)/g)].map((match) => match[1]);
  const finished = runs().map((item) => item.startedAt);

  for (const at of finished) assert.ok(started.includes(at));
  assert.equal(new Set(finished).size, finished.length);
  assert.ok(started.length - finished.length <= 1, 'at most the run in progress has no finish line yet');
});
