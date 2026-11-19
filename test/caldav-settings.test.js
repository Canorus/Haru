const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('CalDAV credentials are encrypted, hidden from responses and used through Basic auth', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-caldav-'));
  const appPort = 32001;
  const davPort = 32002;
  const seen = [];
  const dav = http.createServer(async (req, res) => {
    let requestBody = '';
    for await (const chunk of req) requestBody += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: requestBody });
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"></d:multistatus>');
  });
  await new Promise(resolve => dav.listen(davPort, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(appPort), BASE_PATH: '/haru', CALDAV_UPSTREAM: '', CALDAV_USERNAME: '', CALDAV_PASSWORD: '', HARU_CREDENTIAL_KEY: 'test-only-credential-key-with-32-bytes' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { if (String(chunk).trim()) reject(new Error(String(chunk))); });
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    dav.closeAllConnections();
    await new Promise(resolve => dav.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${appPort}/haru`;
  const request = async (route, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'haru-test-password' } });
  const password = 'violet.sparrow.river';
  const synced = await request('/api/caldav/sync', { method: 'POST', cookie: login.cookie, body: { server: `http://127.0.0.1:${davPort}`, username: 'davuser', password } });
  assert.equal(synced.status, 200);
  assert.equal(synced.data.settings.syncUsername, 'davuser');
  assert.equal(synced.data.settings.syncPasswordSet, true);
  assert.equal(synced.data.settings.syncStatus, 'ready');
  assert.equal(JSON.stringify(synced.data).includes(password), false);
  assert.equal(seen[0].method, 'PROPFIND');
  assert.equal(seen[0].url, '/davuser/');
  assert.equal(seen[0].authorization, `Basic ${Buffer.from(`davuser:${password}`).toString('base64')}`);
  const stored = fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8');
  assert.equal(stored.includes(password), false);
  assert.match(stored, /"syncPasswordEncrypted": "v1\./);
});
