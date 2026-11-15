'use strict';

// Запускает настоящий server.js в отдельном процессе и временной папке.
// Лимитер и yClients подменены в памяти (mock-upstreams.js): в сеть ничего
// не уходит. Тест управляет подменой по IPC и читает лог процесса.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', '..');
const ORIGIN = 'https://baristaschool.ru';
const ADMIN_KEY = 'test-admin-key';
const SERVER_FILES = [
  'server.js',
  'kv-store.js',
  'review-feed.js',
  'review-visit-enrichment.js',
  'yclients-fetch.js',
  'yclients-limiter-client.js',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(envOverrides = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-limiter-'));
  for (const file of SERVER_FILES) fs.copyFileSync(path.join(SERVER_DIR, file), path.join(workDir, file));
  fs.symlinkSync(fs.realpathSync(path.join(SERVER_DIR, 'node_modules')), path.join(workDir, 'node_modules'), 'dir');
  const port = await freePort();
  let output = '';
  let messageId = 0;
  const pending = new Map();

  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'mock-upstreams.js'), 'server.js'], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DISABLE_CRON: '1',
      ADMIN_KEY,
      YCLIENTS_PARTNER_TOKEN: 'test-partner',
      YCLIENTS_USER_TOKEN: 'test-user',
      YCLIENTS_COMPANY_ID: '453962',
      YCLIENTS_RECORDS_SNAPSHOT_PATH: '',
      INTERNAL_REVIEWS_FEED_PATH: '',
      YCLIENTS_LIMITER_URL: 'http://limiter.test/api/internal/yclients-limiter/v1',
      YCLIENTS_LIMITER_INTERNAL_SECRET: 'test-secret',
      // Проверяет и то, что значение off из окружения не отключает лимитер.
      YCLIENTS_LIMITER_MODE: 'off',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('message', (message) => {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve) resolve(message);
  });

  function control(type, state) {
    return new Promise((resolve) => {
      messageId += 1;
      pending.set(messageId, resolve);
      child.send({ id: messageId, type, state });
    });
  }

  function request(method, pathname, { admin = false } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Origin: ORIGIN };
      if (admin) headers['X-Admin-Key'] = ADMIN_KEY;
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function waitFor(predicate, what, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for ' + what + ':\n' + output);
  }

  function stop() {
    child.kill('SIGKILL');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  try {
    await waitFor(async () => {
      try { return (await request('GET', '/health')).status === 200; } catch (_) { return false; }
    }, 'server start');
  } catch (error) {
    stop();
    throw error;
  }

  return {
    control,
    request,
    waitFor,
    stop,
    output: () => output,
    upstreamCalls: async () => (await control('dump')).calls,
  };
}

module.exports = { startServer };
