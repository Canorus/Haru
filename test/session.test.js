const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('login session survives a server restart and logout revokes it', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-session-'));
  const port = 31993;
  let child;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/haru', CALDAV_UPSTREAM: '', CALDAV_USERNAME: '', CALDAV_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { if (code && code !== 0) reject(new Error(`test server exited ${code}`)); });
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  };
  t.after(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/haru${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') };
  };

  await start();
  const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'haru-test-password' } });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /^session=/);
  const firstExpiry = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).sessions[0].expiresAt;
  await new Promise(resolve => setTimeout(resolve, 15));
  const refreshed = await request('/api/bootstrap', { cookie: login.cookie });
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.setCookie, /Max-Age=2592000/);
  const renewedSession = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).sessions[0];
  assert.ok(renewedSession.expiresAt > firstExpiry);
  assert.ok(renewedSession.lastSeenAt);

  await stop();
  await start();
  assert.equal((await request('/api/bootstrap', { cookie: login.cookie })).status, 200);

  assert.equal((await request('/api/logout', { method: 'POST', cookie: login.cookie })).status, 200);
  assert.equal((await request('/api/bootstrap', { cookie: login.cookie })).status, 401);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  assert.equal(stored.sessions.length, 0);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8').includes(login.cookie.slice('session='.length)));
});
