const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('offline mutations merge duplicates, reject conflicts, prioritize deletes and create one recurrence', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-offline-'));
  const port = 31995;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HARU_INITIAL_ADMIN_PASSWORD: 'haru-test-password', HARU_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/haru', CALDAV_UPSTREAM: '', CALDAV_USERNAME: '', CALDAV_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Haru running')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { if (String(chunk).trim()) reject(new Error(String(chunk))); });
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/haru`;
  const request = async (route, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'haru-test-password' } });
  assert.equal(login.status, 200); const cookie = login.cookie;
  const initial = (await request('/api/bootstrap', { cookie })).data;
  const inbox = initial.lists.find(list => list.isDefault);

  const listId = 'list_offline_test_1234';
  const firstId = 'task_offline_first_1234';
  const duplicateId = 'task_offline_duplicate_1234';
  const sync = await request('/api/sync', { method: 'POST', cookie, body: { mutations: [
    { id: 'mutation_list_1234', type: 'create-list', entityId: listId, baseVersion: 0, payload: { name: '오프라인', color: '#a6c4d9' } },
    { id: 'mutation_task_1234', type: 'create-task', entityId: firstId, baseVersion: 0, payload: { title: '같은 내용', listId, priority: 'high', recurrence: { type: 'none' } } },
    { id: 'mutation_duplicate_1234', type: 'create-task', entityId: duplicateId, baseVersion: 0, payload: { title: '같은 내용', listId, priority: 'high', recurrence: { type: 'none' } } }
  ] } });
  assert.equal(sync.status, 200);
  assert.equal(sync.data.results.find(item => item.id === 'mutation_duplicate_1234').status, 'merged');
  assert.equal(sync.data.tasks.filter(task => task.title === '같은 내용').length, 1);

  const editable = await request('/api/tasks', { method: 'POST', cookie, body: { title: '편집 전', listId: inbox.id } });
  const edited = await request(`/api/tasks/${editable.data.task.id}`, { method: 'PATCH', cookie, body: { title: '편집 후', notes: '메모', due: '2026-10-10T18:30', priority: 'high', tags: ['업무', '검토', '업무'], recurrence: { type: 'weekly', weekday: 2 } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.task.title, '편집 후');
  assert.deepEqual(edited.data.task.tags, ['업무', '검토']);
  assert.deepEqual(edited.data.task.recurrence, { type: 'weekly', weekday: 2 });
  assert.equal((await request(`/api/tasks/${editable.data.task.id}`, { method: 'PATCH', cookie, body: { title: '  ' } })).status, 400);

  const importPayload = { format: 'haru-data-export', schemaVersion: 1, metadata: { deviceTime: 'Fri Oct 16 2026 10:00:00 GMT+0900' }, lists: [{ name: '복원 목록', data: { color: '#a6c4d9', isDefault: false, createdAt: '2026-10-16T01:00:00.000Z' }, tasks: [{ title: '복원 태스크', notes: 'none', due: 'none', priority: 'high', tags: 'none', completed: true, recurrence: { type: 'none' }, createdAt: '2026-10-16T01:01:00.000Z', updatedAt: '2026-10-16T01:02:00.000Z' }] }] };
  const imported = await request('/api/account/import', { method: 'POST', cookie, body: importPayload });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.importedLists, 1);
  assert.equal(imported.data.importedTasks, 1);
  const restored = imported.data.tasks.find(task => task.title === '복원 태스크');
  assert.equal(restored.notes, ''); assert.equal(restored.due, null); assert.deepEqual(restored.tags, []); assert.equal(restored.completed, true);
  const repeatedImport = await request('/api/account/import', { method: 'POST', cookie, body: importPayload });
  assert.equal(repeatedImport.data.importedTasks, 0); assert.equal(repeatedImport.data.skippedTasks, 1);
  const cleanupSetting = await request('/api/settings', { method: 'PATCH', cookie, body: { autoDeleteCompleted: 'daily' } });
  assert.equal(cleanupSetting.status, 200);
  assert.equal(cleanupSetting.data.settings.autoDeleteCompleted, 'daily');
  const cleaned = await request('/api/bootstrap', { cookie });
  assert.ok(!cleaned.data.tasks.some(task => task.id === restored.id));
  assert.equal((await request('/api/settings', { method: 'PATCH', cookie, body: { autoDeleteCompleted: 'invalid' } })).status, 400);
  await request('/api/settings', { method: 'PATCH', cookie, body: { autoDeleteCompleted: 'none' } });

  const direct = await request('/api/tasks', { method: 'POST', cookie, body: { title: '충돌 대상', listId: inbox.id } });
  const staleVersion = direct.data.task.version;
  await request(`/api/tasks/${direct.data.task.id}`, { method: 'PATCH', cookie, body: { priority: 'medium' } });
  const conflict = await request('/api/sync', { method: 'POST', cookie, body: { mutations: [
    { id: 'mutation_conflict_1234', type: 'update-task', entityId: direct.data.task.id, baseVersion: staleVersion, payload: { priority: 'high' } }
  ] } });
  assert.equal(conflict.data.results[0].status, 'conflict');
  assert.equal(conflict.data.tasks.find(task => task.id === direct.data.task.id).priority, 'medium');

  const deletable = await request('/api/tasks', { method: 'POST', cookie, body: { title: '삭제 우선', listId: inbox.id } });
  const deletion = await request('/api/sync', { method: 'POST', cookie, body: { mutations: [
    { id: 'mutation_update_after_delete_1234', type: 'update-task', entityId: deletable.data.task.id, baseVersion: deletable.data.task.version, payload: { completed: true } },
    { id: 'mutation_delete_first_1234', type: 'delete-task', entityId: deletable.data.task.id, baseVersion: deletable.data.task.version, payload: {} }
  ] } });
  assert.equal(deletion.data.results.find(item => item.id === 'mutation_delete_first_1234').status, 'applied');
  assert.ok(!deletion.data.tasks.some(task => task.id === deletable.data.task.id));

  const recurring = await request('/api/tasks', { method: 'POST', cookie, body: { title: '반복 단일 생성', listId: inbox.id, due: '2026-10-06', recurrence: { type: 'daily' } } });
  const recurrence = await request('/api/sync', { method: 'POST', cookie, body: { mutations: [
    { id: 'mutation_repeat_first_1234', type: 'update-task', entityId: recurring.data.task.id, baseVersion: recurring.data.task.version, payload: { completed: true } },
    { id: 'mutation_repeat_second_1234', type: 'update-task', entityId: recurring.data.task.id, baseVersion: recurring.data.task.version, payload: { completed: true } }
  ] } });
  assert.equal(recurrence.data.results.find(item => item.id === 'mutation_repeat_first_1234').status, 'applied');
  assert.equal(recurrence.data.results.find(item => item.id === 'mutation_repeat_second_1234').status, 'conflict');
  assert.equal(recurrence.data.tasks.filter(task => task.recurrenceSourceTaskId === recurring.data.task.id).length, 1);

  const bob = await request('/api/users', { method: 'POST', cookie, body: { username: 'offlinebob', role: 'user' } });
  const bobLogin = await request('/api/login', { method: 'POST', body: { username: 'offlinebob', password: bob.data.temporaryPassword } });
  const bobCookie = bobLogin.cookie;
  await request('/api/account/password', { method: 'PATCH', cookie: bobCookie, body: { currentPassword: bob.data.temporaryPassword, newPassword: 'offline-bob-password' } });
  const shared = await request('/api/tasks', { method: 'POST', cookie, body: { title: '권한 취소 시험 @offlinebob', listId: inbox.id } });
  const collaborationId = shared.data.collaborationRequests[0].id;
  await request(`/api/collaborations/${collaborationId}/respond`, { method: 'POST', cookie: bobCookie, body: { decision: 'approved' } });
  const bobSnapshot = (await request('/api/bootstrap', { cookie: bobCookie })).data;
  const bobTask = bobSnapshot.tasks.find(task => task.id === shared.data.task.id);
  assert.ok(bobTask);
  await request(`/api/collaborations/${collaborationId}`, { method: 'DELETE', cookie });
  const revoked = await request('/api/sync', { method: 'POST', cookie: bobCookie, body: { mutations: [
    { id: 'mutation_revoked_1234', type: 'update-task', entityId: bobTask.id, baseVersion: bobTask.version, payload: { completed: true } }
  ] } });
  assert.equal(revoked.data.results[0].status, 'permission_revoked');
  assert.ok(!revoked.data.tasks.some(task => task.id === bobTask.id));
});
