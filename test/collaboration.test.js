const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('list approval shares only mentioned tasks and notifications have persistent controls', { skip: process.env.HARU_INTEGRATION !== '1' }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-collaboration-'));
  const port = 31992;
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
  const created = await request('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'bob', role: 'user' } });
  assert.equal(created.status, 201);
  const bobCookie = await login('bob', created.data.temporaryPassword);
  assert.equal((await request('/api/account/password', { method: 'PATCH', cookie: bobCookie, body: { currentPassword: created.data.temporaryPassword, newPassword: 'bob-secure-password' } })).status, 200);

  const adminSnapshot = await request('/api/bootstrap', { cookie: adminCookie });
  const inbox = adminSnapshot.data.lists.find(item => item.name === '수집');
  const tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = new Date(tomorrowDate.getTime() - tomorrowDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const privateTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '공유하지 않은 작업', listId: inbox.id, due: `${tomorrow}T08:00` } });
  assert.equal(privateTask.status, 201);
  const invitedTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '공유 검토 @bob@localhost', listId: inbox.id, due: `${tomorrow}T09:00`, recurrence: { type: 'daily' } } });
  assert.equal(invitedTask.status, 201);
  assert.equal(invitedTask.data.task.title, '공유 검토');
  assert.deepEqual(invitedTask.data.task.sharedWithUserIds, [created.data.user.id]);
  assert.deepEqual(invitedTask.data.task.shareParticipants.map(item => item.username), ['bob']);
  assert.equal(invitedTask.data.collaborationRequests[0].status, 'pending');

  const notifications = await request('/api/notifications', { cookie: bobCookie });
  const invitation = notifications.data.notifications.find(item => item.type === 'collaboration');
  assert.ok(invitation);
  assert.equal(notifications.data.unreadCount, 1);
  assert.equal((await request(`/api/notifications/${invitation.id}`, { method: 'PATCH', cookie: bobCookie })).data.unreadCount, 0);
  const readInvitation = await request('/api/notifications', { cookie: bobCookie });
  assert.equal(readInvitation.data.notifications.find(item => item.id === invitation.id).read, true);
  assert.equal((await request(`/api/collaborations/${invitation.id}/respond`, { method: 'POST', cookie: bobCookie, body: { decision: 'approved' } })).status, 200);

  const bobSnapshot = await request('/api/bootstrap', { cookie: bobCookie });
  const sharedInbox = bobSnapshot.data.lists.find(item => item.id === inbox.id);
  assert.equal(sharedInbox.shared, true);
  const bobInvitedTask = bobSnapshot.data.tasks.find(item => item.id === invitedTask.data.task.id);
  assert.ok(bobInvitedTask);
  assert.deepEqual(bobInvitedTask.shareParticipants.map(item => item.username), ['admin']);
  assert.ok(!bobSnapshot.data.tasks.some(item => item.id === privateTask.data.task.id));
  assert.equal((await request(`/api/tasks/${privateTask.data.task.id}`, { method: 'PATCH', cookie: bobCookie, body: { completed: true } })).status, 404);
  assert.equal((await request(`/api/tasks/${privateTask.data.task.id}`, { method: 'DELETE', cookie: bobCookie })).status, 404);
  const dueNotifications = await request('/api/notifications', { cookie: bobCookie });
  assert.ok(dueNotifications.data.notifications.some(item => item.type === 'due' && item.id === invitedTask.data.task.id));
  assert.ok(!dueNotifications.data.notifications.some(item => item.id === privateTask.data.task.id));
  assert.equal((await request(`/api/notifications/${invitedTask.data.task.id}`, { method: 'DELETE', cookie: bobCookie })).status, 200);
  assert.ok(!(await request('/api/notifications', { cookie: bobCookie })).data.notifications.some(item => item.id === invitedTask.data.task.id));
  const sharedTask = await request('/api/tasks', { method: 'POST', cookie: bobCookie, body: { title: 'Bob이 추가한 일', listId: sharedInbox.id } });
  assert.equal(sharedTask.status, 201);
  assert.equal(sharedTask.data.task.userId, 'usr_admin');

  assert.equal((await request('/api/settings', { method: 'PATCH', cookie: adminCookie, body: { sortBy: 'manual' } })).status, 200);
  const reordered = await request('/api/tasks/order', { method: 'PUT', cookie: adminCookie, body: { taskIds: [invitedTask.data.task.id, privateTask.data.task.id] } });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.data.settings.manualTaskOrder.slice(0, 2), [invitedTask.data.task.id, privateTask.data.task.id]);
  assert.equal((await request('/api/tasks/order', { method: 'PUT', cookie: bobCookie, body: { taskIds: [privateTask.data.task.id] } })).status, 403);

  const completed = await request(`/api/tasks/${invitedTask.data.task.id}`, { method: 'PATCH', cookie: bobCookie, body: { completed: true } });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.nextTask.completed, false);
  assert.equal(completed.data.nextTask.recurrence.type, 'daily');
  assert.notEqual(completed.data.nextTask.due, invitedTask.data.task.due);
  const recurringNotification = await request('/api/notifications', { cookie: bobCookie });
  assert.ok(recurringNotification.data.notifications.some(item => item.id === completed.data.nextTask.id));
  assert.equal((await request('/api/notifications/read-all', { method: 'POST', cookie: bobCookie })).data.unreadCount, 0);
  const allRead = await request('/api/notifications', { cookie: bobCookie });
  assert.ok(allRead.data.notifications.length > 0);
  assert.ok(allRead.data.notifications.every(item => item.read));
  assert.equal((await request('/api/notifications', { method: 'DELETE', cookie: bobCookie })).status, 200);
  assert.equal((await request('/api/notifications', { cookie: bobCookie })).data.notifications.length, 0);

  const recurrenceCases = [
    [{ type: 'hourly' }, '2026-01-01T10:00', '2026-01-01T11:00'],
    [{ type: 'weekly', weekday: 1 }, '2026-01-06', '2026-01-12'],
    [{ type: 'monthly', day: 31 }, '2026-01-31', '2026-02-28'],
    [{ type: 'yearly', month: 2, day: 29 }, '2024-02-29', '2025-02-28']
  ];
  for (const [recurrence, due, expected] of recurrenceCases) {
    const createdTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: `${recurrence.type} 반복`, listId: inbox.id, due, recurrence } });
    const result = await request(`/api/tasks/${createdTask.data.task.id}`, { method: 'PATCH', cookie: adminCookie, body: { completed: true } });
    assert.equal(result.data.nextTask.due, expected);
  }

  const projectList = await request('/api/lists', { method: 'POST', cookie: adminCookie, body: { name: '장기 프로젝트' } });
  const parsedTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '보고서 작성 *(장기 프로젝트) !3 #(집중 작업) #검토 내일' } });
  assert.equal(parsedTask.status, 201);
  assert.equal(parsedTask.data.task.title, '보고서 작성');
  assert.equal(parsedTask.data.task.listId, projectList.data.list.id);
  assert.equal(parsedTask.data.task.priority, 'high');
  assert.deepEqual(parsedTask.data.task.tags, ['집중 작업', '검토']);
  assert.equal(parsedTask.data.task.due, tomorrow);

  const localDate = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todayTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'today english date', listId: inbox.id } });
  assert.equal(todayTask.data.task.title, 'english date');
  assert.equal(todayTask.data.task.due, localDate(new Date()));
  const tomorrowTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'english deadline tomorrow', listId: inbox.id } });
  assert.equal(tomorrowTask.data.task.title, 'english deadline');
  assert.equal(tomorrowTask.data.task.due, tomorrow);
  const fullDateTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '회계 마감 on 2026/10/31', listId: inbox.id } });
  assert.equal(fullDateTask.data.task.title, '회계 마감');
  assert.equal(fullDateTask.data.task.due, '2026-10-31');
  const now = new Date(); let shortYear = now.getFullYear();
  const shortCandidate = new Date(shortYear, 11, 25);
  if (localDate(shortCandidate) < localDate(now)) shortYear += 1;
  const shortDateTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '선물 준비 12/25', listId: inbox.id } });
  assert.equal(shortDateTask.data.task.title, '선물 준비');
  assert.equal(shortDateTask.data.task.due, `${shortYear}-12-25`);

  const badgeBefore = await request('/api/notifications', { cookie: adminCookie });
  const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const laterLocal = new Date(later.getTime() - later.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const laterTask = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '48시간 뒤 알림 목록', listId: inbox.id, due: laterLocal } });
  const badgeAfter = await request('/api/notifications', { cookie: adminCookie });
  assert.ok(badgeAfter.data.notifications.some(item => item.id === laterTask.data.task.id));
  assert.equal(badgeAfter.data.unreadCount, badgeBefore.data.unreadCount);

  const ymd = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const koreanWeekdays = [['일요일', 0], ['월요일', 1], ['화요일', 2], ['수요일', 3], ['목요일', 4], ['금요일', 5], ['토요일', 6]];
  const weekdayBase = new Date();
  for (const [weekdayName, weekday] of koreanWeekdays) {
    const expected = new Date(weekdayBase); expected.setDate(expected.getDate() + ((weekday - expected.getDay() + 7) % 7));
    const result = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: `${weekdayName}까지 요일 자동 처리`, listId: inbox.id } });
    assert.equal(result.status, 201, weekdayName);
    assert.equal(result.data.task.title, '요일 자동 처리', weekdayName);
    assert.equal(result.data.task.due, ymd(expected), weekdayName);
  }
  const nearestSundayOffset = (7 - weekdayBase.getDay()) % 7;
  const nextSunday = new Date(weekdayBase); nextSunday.setDate(nextSunday.getDate() + nearestSundayOffset + 7);
  const afterNextSunday = new Date(weekdayBase); afterNextSunday.setDate(afterNextSunday.getDate() + nearestSundayOffset + 14);
  const lastSunday = new Date(weekdayBase.getFullYear(), weekdayBase.getMonth() + 1, 0);
  lastSunday.setDate(lastSunday.getDate() - ((lastSunday.getDay() - 0 + 7) % 7));
  for (const [phrase, expected] of [['다음 일요일', nextSunday], ['다다음 일요일', afterNextSunday], ['마지막 일요일', lastSunday]]) {
    const result = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: `${phrase} 주간 계획`, listId: inbox.id } });
    assert.equal(result.status, 201, phrase);
    assert.equal(result.data.task.title, '주간 계획', phrase);
    assert.equal(result.data.task.due, ymd(expected), phrase);
  }

  const ambiguous = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'Tuesday 회의', listId: inbox.id } });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.data.code, 'DUE_CONFIRM_REQUIRED');
  const accepted = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'Tuesday 회의', listId: inbox.id, dueDecision: 'accept' } });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.task.title, '회의');
  assert.ok(accepted.data.task.due);
  const kept = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'Tuesday 회고', listId: inbox.id, dueDecision: 'keep' } });
  assert.equal(kept.status, 201);
  assert.equal(kept.data.task.title, 'Tuesday 회고');
  assert.equal(kept.data.task.due, null);

  const markerSettings = await request('/api/settings', { method: 'PATCH', cookie: adminCookie, body: { listMarker: '~', priorityMarker: '%', tagMarker: '^', sortBy: 'priority', sortDirection: 'desc' } });
  assert.equal(markerSettings.status, 200);
  assert.equal((await request('/api/settings', { method: 'PATCH', cookie: adminCookie, body: { listMarker: '@', priorityMarker: '%', tagMarker: '^' } })).status, 400);
  const customMarkers = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '사용자 마커 ~업무 %2 ^분류' } });
  assert.equal(customMarkers.status, 201);
  assert.equal(customMarkers.data.task.title, '사용자 마커');
  assert.equal(customMarkers.data.task.priority, 'medium');
  assert.deepEqual(customMarkers.data.task.tags, ['분류']);
  assert.equal((await request('/api/settings', { method: 'PATCH', cookie: adminCookie, body: { listMarker: '!', priorityMarker: '!', tagMarker: '#' } })).status, 400);

  const disposableList = await request('/api/lists', { method: 'POST', cookie: adminCookie, body: { name: '삭제 시험' } });
  await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '삭제될 일 1', listId: disposableList.data.list.id } });
  await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '삭제될 일 2', listId: disposableList.data.list.id } });
  assert.equal((await request(`/api/lists/${disposableList.data.list.id}`, { method: 'DELETE', cookie: adminCookie, body: { confirmation: '틀린 이름' } })).status, 400);
  const deletedList = await request(`/api/lists/${disposableList.data.list.id}`, { method: 'DELETE', cookie: adminCookie, body: { confirmation: '삭제 시험' } });
  assert.equal(deletedList.status, 200);
  assert.equal(deletedList.data.deletedTaskCount, 2);
  assert.ok(!deletedList.data.lists.some(item => item.id === disposableList.data.list.id));
  assert.ok(!deletedList.data.tasks.some(item => item.listId === disposableList.data.list.id));

  const grants = await request('/api/collaborations', { cookie: bobCookie });
  assert.equal(grants.data.collaborations.length, 1);
  assert.equal((await request(`/api/collaborations/${grants.data.collaborations[0].id}`, { method: 'DELETE', cookie: bobCookie })).status, 200);
  const afterRemoval = await request('/api/bootstrap', { cookie: bobCookie });
  assert.ok(!afterRemoval.data.lists.some(item => item.id === inbox.id));

  const remote = await request('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: '원격 요청 @someone@remote.example', listId: inbox.id } });
  assert.equal(remote.status, 400);
});
