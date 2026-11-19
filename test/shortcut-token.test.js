const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('scoped shortcut tokens create tasks and return a safe full snapshot', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-shortcut-token-'));
  const port = 31996;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/haru', CALDAV_UPSTREAM: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { if (code) reject(new Error(`test server exited ${code}`)); });
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const request = async (route, { method = 'GET', body, cookie, token, username = 'admin', taskId } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/haru${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}`, 'X-Haru-Username': username } : {}), ...(taskId !== undefined ? { 'X-Haru-Task-Id': taskId } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };

  const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'haru-test-password' } });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/shortcut-tokens', { method: 'POST', cookie: login.cookie, body: { name: 'disabled', scope: 'read' } })).status, 409);
  assert.equal((await request('/api/settings', { method: 'PATCH', cookie: login.cookie, body: { mcpEnabled: true } })).status, 200);

  const readIssued = await request('/api/shortcut-tokens', { method: 'POST', cookie: login.cookie, body: { name: 'Siri 조회', scope: 'read' } });
  const writeIssued = await request('/api/shortcut-tokens', { method: 'POST', cookie: login.cookie, body: { name: 'Siri 등록', scope: 'write' } });
  assert.equal(readIssued.status, 201); assert.equal(writeIssued.status, 201);
  assert.match(readIssued.data.value, /^haru_sc_/); assert.match(writeIssued.data.value, /^haru_sc_/);
  const storedText = fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8');
  assert.equal(storedText.includes(readIssued.data.value), false); assert.equal(storedText.includes(writeIssued.data.value), false);

  assert.equal((await request('/api/shortcuts/snapshot', { token: readIssued.data.value, username: 'someone-else' })).status, 403);
  assert.equal((await request('/api/shortcuts/tasks', { method: 'POST', token: readIssued.data.value, body: { title: '권한 오류' } })).status, 403);
  assert.equal((await request('/api/shortcuts/snapshot', { token: writeIssued.data.value })).status, 403);
  const created = await request('/api/shortcuts/tasks', { method: 'POST', token: writeIssued.data.value, body: { title: 'Siri에서 등록', list: '수집', priority: 'high', due: '2026-12-25' } });
  assert.equal(created.status, 201); assert.equal(created.data.task.title, 'Siri에서 등록'); assert.equal(created.data.task.source, 'ai');
  const updated = await request('/api/shortcuts/tasks', { method: 'POST', token: writeIssued.data.value, taskId: created.data.task.id, body: { title: 'Siri에서 수정', priority: 'low', due: null } });
  assert.equal(updated.status, 200); assert.equal(updated.data.task.id, created.data.task.id); assert.equal(updated.data.task.title, 'Siri에서 수정'); assert.equal(updated.data.task.priority, 'low'); assert.equal(updated.data.task.due, null);
  assert.equal((await request('/api/shortcuts/tasks', { method: 'POST', token: writeIssued.data.value, taskId: 'task_missing', body: { title: '없음' } })).status, 404);
  const nullIdCreated = await request('/api/shortcuts/tasks', { method: 'POST', token: writeIssued.data.value, taskId: 'null', body: { title: 'null ID 신규 등록' } });
  assert.equal(nullIdCreated.status, 201); assert.notEqual(nullIdCreated.data.task.id, created.data.task.id);
  const snapshot = await request('/api/shortcuts/snapshot', { token: readIssued.data.value });
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.metadata.username, 'admin');
  assert.ok(snapshot.data.lists.some(list => list.name === '수집'));
  assert.ok(snapshot.data.tasks.some(task => task.title === 'Siri에서 수정'));
  assert.equal('syncPassword' in snapshot.data.settings, false);

  const listed = await request('/api/shortcut-tokens', { cookie: login.cookie });
  assert.equal(listed.data.tokens.length, 2); assert.equal(JSON.stringify(listed.data).includes(readIssued.data.value), false);
  assert.equal((await request(`/api/shortcut-tokens/${writeIssued.data.token.id}`, { method: 'DELETE', cookie: login.cookie })).status, 200);
  assert.equal((await request('/api/shortcuts/tasks', { method: 'POST', token: writeIssued.data.value, body: { title: '폐기됨' } })).status, 401);
  assert.equal((await request('/api/settings', { method: 'PATCH', cookie: login.cookie, body: { mcpEnabled: false } })).status, 200);
  assert.equal((await request('/api/shortcuts/snapshot', { token: readIssued.data.value })).status, 401);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).shortcutTokens.length, 0);
});
