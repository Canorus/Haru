const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('a mutation on another client pushes a realtime change event', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-realtime-'));
  const port = 31994;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/haru', CALDAV_UPSTREAM: '', CALDAV_USERNAME: '', CALDAV_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { if (code && code !== 0) reject(new Error(`test server exited ${code}`)); });
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/haru`;
  const loginResponse = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'haru-test-password' })
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const eventResponse = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntil = async pattern => {
    const deadline = Date.now() + 3000;
    while (!pattern.test(received)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${pattern}`);
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), remaining))
      ]);
      if (result.done) throw new Error('event stream closed unexpectedly');
      received += decoder.decode(result.value, { stream: true });
    }
  };
  await readUntil(/event: ready/);
  const noOpRead = reader.read();
  const emptySync = await fetch(`${base}/api/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ mutations: [] })
  });
  assert.equal(emptySync.status, 200);
  const noOpPublished = await Promise.race([noOpRead.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 350))]);
  assert.equal(noOpPublished, false, 'an empty sync must not publish a realtime change');
  const createResponse = await fetch(`${base}/api/lists`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: '다른 기기 목록' })
  });
  assert.equal(createResponse.status, 201);
  const afterCreate = await noOpRead;
  if (!afterCreate.done) received += decoder.decode(afterCreate.value, { stream: true });
  await readUntil(/event: change/);
  const snapshotResponse = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } });
  const snapshot = await snapshotResponse.json();
  assert.ok(snapshot.lists.some(list => list.name === '다른 기기 목록'));
});
