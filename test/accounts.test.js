const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('account roles, temporary passwords, admin protection and guest access', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-accounts-'));
  const port = 31991;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/haru', CALDAV_UPSTREAM: '', CALDAV_USERNAME: '', CALDAV_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`test server exited ${code}`)));
  });

  const request = async (route, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/haru${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, password) => {
    const result = await request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(result.status, 200); return result.cookie;
  };

  const adminCookie = await login('admin', 'haru-test-password');
  const createdAdmin = await request('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'secondadmin', role: 'admin' } });
  assert.equal(createdAdmin.status, 201);
  assert.equal(createdAdmin.data.user.role, 'admin');
  assert.ok(createdAdmin.data.temporaryPassword.length >= 8);

  const secondCookie = await login('secondadmin', createdAdmin.data.temporaryPassword);
  const forced = await request('/api/tasks', { method: 'POST', cookie: secondCookie, body: { title: 'blocked' } });
  assert.equal(forced.status, 428);
  const changed = await request('/api/account/password', { method: 'PATCH', cookie: secondCookie, body: { currentPassword: createdAdmin.data.temporaryPassword, newPassword: 'second-admin-password' } });
  assert.equal(changed.status, 200);
  const relinquished = await request('/api/account/relinquish-admin', { method: 'POST', cookie: secondCookie, body: { password: 'second-admin-password', role: 'user' } });
  assert.equal(relinquished.status, 200);
  assert.equal(relinquished.data.user.role, 'user');
  assert.equal((await request(`/api/users/${createdAdmin.data.user.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);

  const guest = await request('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'viewer', role: 'guest' } });
  assert.equal(guest.status, 201);
  const guestCookie = await login('viewer', guest.data.temporaryPassword);
  assert.equal((await request('/api/account/password', { method: 'PATCH', cookie: guestCookie, body: { currentPassword: guest.data.temporaryPassword, newPassword: 'guest-password-123' } })).status, 200);
  assert.equal((await request('/api/tasks', { method: 'POST', cookie: guestCookie, body: { title: 'read only' } })).status, 403);
  assert.equal((await request(`/api/users/${guest.data.user.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);

  const users = await request('/api/users', { cookie: adminCookie });
  const rootAdmin = users.data.users.find(item => item.username === 'admin');
  assert.equal((await request(`/api/users/${rootAdmin.id}`, { method: 'DELETE', cookie: adminCookie })).status, 409);
});
