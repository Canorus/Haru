const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('public PWA assets and production schema exist', () => {
  for (const file of ['public/index.html','public/app.js','public/styles.css','public/sw.js','public/manifest.webmanifest','docs/schema.sql','cli/todo.py','test/session.test.js','test/realtime.test.js']) assert.equal(fs.existsSync(file), true, file);
});

test('initial admin password is configured or randomly generated, never hard-coded', () => {
  const source = fs.readFileSync('server.js','utf8');
  assert.match(source, /HARU_INITIAL_ADMIN_PASSWORD/);
  assert.match(source, /generatedInitialAdminPassword/);
  assert.doesNotMatch(source, /hashPassword\(['"][^'"]+['"]\)/);
});

test('quick-list syntax and CalDAV fields are wired', () => {
  const server = fs.readFileSync('server.js','utf8');
  assert.match(server, /LIST_NOT_FOUND/);
  assert.match(server, /BEGIN:VTODO/);
  assert.match(server, /PERCENT-COMPLETE|STATUS/);
  assert.match(server, /DUE_CONFIRM_REQUIRED/);
  assert.match(server, /CATEGORIES/);
});

test('subdirectory deployment and full Unicode are explicit', () => {
  const server = fs.readFileSync('server.js','utf8');
  const app = fs.readFileSync('public/app.js','utf8');
  const schema = fs.readFileSync('docs/schema.sql','utf8');
  assert.match(server, /BASE_PATH/);
  assert.match(server, /INSTANCE_DOMAIN/);
  assert.match(server, /normalize\('NFC'\)/);
  assert.match(app, /document\.baseURI/);
  assert.match(schema, /server_encoding/);
  assert.match(schema, /emoji is supported/);
});

test('Radicale proxy preserves DAV methods under the base path', () => {
  const server = fs.readFileSync('server.js','utf8');
  assert.match(server, /CALDAV_UPSTREAM/);
  assert.match(server, /proxyCalDav/);
  assert.match(server, /authorization.*content-type.*depth.*if-match.*if-none-match/);
  assert.equal(fs.existsSync('compose.yaml'), true);
  assert.equal(fs.existsSync('Dockerfile'), true);
});

test('account management and admin CLI user creation are present', () => {
  const server = fs.readFileSync('server.js','utf8');
  const html = fs.readFileSync('public/index.html','utf8');
  const cli = fs.readFileSync('cli/todo.py','utf8');
  assert.match(server, /\/api\/account\/password/);
  assert.match(server, /\/api\/users/);
  assert.match(html, /accountTaskCount/);
  assert.match(html, /id="accountScreen"/);
  assert.match(html, /계정 정보 이전/);
  assert.doesNotMatch(html, /테스트 계정/);
  assert.doesNotMatch(html, /<input[^>]+value="(?:admin|haru-test-password)"/);
  assert.match(html, /app\.js\?v=32/);
  assert.match(html, /id="inboxNav"/);
  assert.doesNotMatch(html, /🔔/);
  assert.ok(html.indexOf('id="taskDue"') > html.indexOf('id="taskRepeat"'));
  assert.match(html, /notificationDialog/);
  assert.match(html, /taskRepeat/);
  assert.match(server, /collaborations/);
  assert.match(server, /nextRecurringDue/);
  assert.match(fs.readFileSync('public/sw.js','utf8'), /haru-offline-v12/);
  assert.match(server, /\/api\/account\/data/);
  assert.match(html, /id="resetDataButton"/);
  assert.match(html, /CalDAV가 연결된 경우 동기화 데이터도 함께 삭제/);
  const css = fs.readFileSync('public/styles.css','utf8');
  assert.match(css, /#taskListSelect,#taskDue,#taskDue::\-webkit-datetime-edit,#taskDue::\-webkit-date-and-time-value\{font-size:11px\}/);
  assert.match(css, /#taskListSelect,#taskDue,#taskDue::\-webkit-datetime-edit,#taskDue::\-webkit-date-and-time-value\{font-size:11px!important\}/);
  for (const color of ['#a6c4d9','#b0dfe3','#d5e7e2','#f3f0e7','#e4b9c2']) assert.match(css, new RegExp(color));
  assert.equal(fs.existsSync('docs/INSTALL.md'), true);
  assert.match(html, /id="themeSetting"/);
  assert.match(css, /data-theme="dark"/);
  assert.match(css, /data-theme="dark"\] \.brand-mark/);
  assert.match(css, /data-theme="dark"\] \.count/);
  assert.match(css, /data-theme="dark"\] #listForm input\{background:var\(--white\);color:var\(--ink\)/);
  assert.match(css, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),textarea\{font-size:16px!important\}/);
  assert.doesNotMatch(css, /textarea,select\{font-size:16px!important\}/);
  assert.doesNotMatch(css, /\.task-row:hover\{[^}]*transform/);
  assert.match(css, /\.task-row:hover\{[^}]*box-shadow:inset 3px/);
  assert.match(css, /\.task-row\{[^}]*transition:background-color \.75s,border-color \.75s,box-shadow \.75s/);
  assert.match(html, /id="dueConfirmDialog"/);
  assert.match(html, /id="deleteListDialog"/);
  assert.match(html, /id="listMarkerSetting"/);
  assert.match(html, /id="taskSortBy"/);
  assert.match(server, /MARKER_CHOICES/);
  assert.match(server, /listDeleteMatch/);
  assert.match(fs.readFileSync('compose.yaml','utf8'), /CALDAV_UPSTREAM: \$\{CALDAV_UPSTREAM:-\}/);
  assert.match(server, /ROLE_RANK = \{ guest: 0, user: 1, admin: 2 \}/);
  assert.match(server, /mustChangePassword/);
  assert.match(server, /flushCalDavQueue/);
  assert.match(html, /id="addAccountButton"/);
  assert.match(html, /id="relinquishAdminButton"/);
  assert.match(cli, /add_parser\("create"/);
  assert.match(html, /id="editTaskDialog"/);
  assert.match(html, /id="editTaskTitle"/);
  assert.match(html, /id="editTaskNotes"/);
  assert.match(html, /id="editTaskTags"/);
  assert.match(fs.readFileSync('public/app.js','utf8'), /openTaskEditor/);
  assert.match(fs.readFileSync('public/app.js','utf8'), /queueMutation\('update-task'/);
  assert.match(html, /id="exportDataButton"/);
  assert.match(html, /id="importDataButton"/);
  assert.match(server, /\/api\/account\/import/);
  assert.match(fs.readFileSync('public/app.js','utf8'), /haru-data-export/);
  assert.match(html, /id="syncUsernameSetting"/);
  assert.match(html, /id="syncPasswordSetting"/);
  assert.match(html, /id="caldavSyncButton"/);
  assert.match(html, /id="createShortcutTokenButton"/);
  assert.match(html, /id="shortcutTokenDialog"/);
  assert.match(server, /\/api\/shortcuts\/snapshot/);
  assert.match(server, /\/api\/shortcuts\/tasks/);
  assert.match(server, /shortcutTokenHash/);
  assert.match(fs.readFileSync('docs/schema.sql','utf8'), /CREATE TABLE shortcut_tokens/);
  assert.equal(fs.existsSync('docs/SHORTCUTS.md'), true);
  assert.match(html, /id="searchButton"/);
  assert.match(html, /id="searchInput"/);
  assert.match(html, /id="autoDeleteCompletedSetting"/);
  assert.match(server, /purgeCompletedTasksForUser/);
  assert.match(server, /AUTO_DELETE_COMPLETED_VALUES/);
  assert.match(html, /개인화 · 동기화 · 데이터/);
  assert.match(html, /class="nav-icon"><svg/);
  assert.match(css, /\.quick-tools select,\.quick-tools input\{font-size:11px\}/);
  assert.match(css, /\.quick-input input\{font-size:15px\}/);
  assert.match(fs.readFileSync('public/app.js','utf8'), /taskScreen'\)\.classList\.contains\('hidden'\)/);
  assert.match(fs.readFileSync('public/app.js','utf8'), /e\.code!=='KeyN'/);
  assert.match(server, /24 \* 60 \* 60 \* 1000/);
  assert.match(server, /aes-256-gcm/);
  assert.match(server, /HARU_CREDENTIAL_KEY/);
  assert.match(server, /settingsView/);
});

test('authenticated realtime synchronization is wired for lists and tasks', () => {
  const server = fs.readFileSync('server.js','utf8');
  const app = fs.readFileSync('public/app.js','utf8');
  assert.match(server, /text\/event-stream/);
  assert.match(server, /X-Accel-Buffering/);
  assert.match(server, /publishChange\(\)/);
  assert.match(app, /new EventSource/);
  assert.match(app, /refreshSnapshot/);
});

test('task-scoped sharing and persistent notification controls are wired', () => {
  const server = fs.readFileSync('server.js','utf8');
  const app = fs.readFileSync('public/app.js','utf8');
  const html = fs.readFileSync('public/index.html','utf8');
  const schema = fs.readFileSync('docs/schema.sql','utf8');
  assert.match(server, /sharedWithUserIds/);
  assert.match(server, /canAccessTask/);
  assert.match(server, /notificationStates/);
  assert.match(server, /\/api\/notifications\/read-all/);
  assert.match(app, /task-shared/);
  assert.match(html, /readAllNotificationsButton/);
  assert.match(html, /removeAllNotificationsButton/);
  assert.match(schema, /CREATE TABLE task_shares/);
  assert.match(schema, /CREATE TABLE notification_states/);
});

test('named sharing, scrollable sidebar and manual task ordering are wired', () => {
  const server = fs.readFileSync('server.js','utf8');
  const app = fs.readFileSync('public/app.js','utf8');
  const html = fs.readFileSync('public/index.html','utf8');
  const css = fs.readFileSync('public/styles.css','utf8');
  assert.match(server, /shareParticipants/);
  assert.match(server, /\/api\/tasks\/order/);
  assert.match(app, /task-drag-handle/);
  assert.match(app, /persistManualTaskOrder/);
  assert.match(html, /<option value="manual">수동<\/option>/);
  assert.match(css, /\.sidebar\{min-height:0;height:100vh;overflow-y:auto/);
  assert.match(css, /\.task-row\.manual-sort/);
});
