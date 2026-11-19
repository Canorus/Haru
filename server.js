const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.HARU_DATA_DIR ? path.resolve(process.env.HARU_DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '');
const COOKIE_PATH = `${BASE_PATH}/` || '/';
const CALDAV_UPSTREAM = String(process.env.CALDAV_UPSTREAM || '').replace(/\/$/, '');
const CALDAV_USERNAME = process.env.CALDAV_USERNAME || '';
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD || '';
const CALDAV_APP_USER = process.env.CALDAV_APP_USER || 'admin';
const INSTANCE_DOMAIN = String(process.env.INSTANCE_DOMAIN || 'localhost').trim().toLowerCase();
const CREDENTIAL_KEY_SOURCE = String(process.env.HARU_CREDENTIAL_KEY || '');
const INITIAL_ADMIN_PASSWORD = String(process.env.HARU_INITIAL_ADMIN_PASSWORD || '');
const APP_VERSION = 'haru-offline-v12';
const ROLE_RANK = { guest: 0, user: 1, admin: 2 };
const MARKER_CHOICES = '~!#$%^&*';
const AUTO_DELETE_COMPLETED_VALUES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const SHORTCUT_TOKEN_SCOPES = new Set(['read', 'write']);
const SETTING_KEYS = ['defaultListId', 'defaultDue', 'defaultPriority', 'syncServer', 'mcpEnabled', 'theme', 'listMarker', 'priorityMarker', 'tagMarker', 'sortBy', 'sortDirection', 'autoDeleteCompleted'];
const caldavLastSync = new Map();
const caldavSyncPromises = new Map();
let eventSequence = 0;
const eventClients = new Set();
const clientSyncUsers = new Set();
let generatedInitialAdminPassword = '';

function normalizeBasePath(value) {
  const clean = String(value).trim();
  if (!clean || clean === '/') return '';
  return `/${clean.replace(/^\/+|\/+$/g, '')}`;
}

function unicodeText(value) {
  return String(value ?? '').normalize('NFC');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function initialAdminPassword() {
  if (INITIAL_ADMIN_PASSWORD) {
    if (INITIAL_ADMIN_PASSWORD.length < 8) throw new Error('HARU_INITIAL_ADMIN_PASSWORD must be at least 8 characters.');
    return INITIAL_ADMIN_PASSWORD;
  }
  generatedInitialAdminPassword = crypto.randomBytes(18).toString('base64url');
  return generatedInitialAdminPassword;
}

function initialStore() {
  const now = new Date().toISOString();
  const adminPassword = initialAdminPassword();
  return {
    users: [{
      id: 'usr_admin', username: 'admin', domain: INSTANCE_DOMAIN,
      passwordHash: hashPassword(adminPassword), role: 'admin', mustChangePassword: !INITIAL_ADMIN_PASSWORD, createdAt: now
    }],
    lists: [
      { id: 'list_inbox', userId: 'usr_admin', name: '수집', color: '#a6c4d9', isDefault: true, createdAt: now, version: 1 },
      { id: 'list_work', userId: 'usr_admin', name: '업무', color: '#b0dfe3', isDefault: false, createdAt: now, version: 1 },
      { id: 'list_personal', userId: 'usr_admin', name: '개인', color: '#e4b9c2', isDefault: false, createdAt: now, version: 1 }
    ],
    tasks: [
      { id: 'task_welcome', userId: 'usr_admin', listId: 'list_inbox', title: 'Haru에 오신 것을 환영해요', notes: '태스크를 완료해 보세요.', due: null, priority: 'medium', completed: false, createdAt: now, updatedAt: now, version: 1 },
      { id: 'task_try', userId: 'usr_admin', listId: 'list_work', title: '새 태스크 입력해 보기', notes: '', due: new Date(Date.now() + 86400000).toISOString().slice(0, 10), priority: 'high', completed: false, createdAt: now, updatedAt: now, version: 1 }
    ],
    settings: [{ userId: 'usr_admin', defaultListId: 'list_inbox', defaultDue: 'none', defaultPriority: 'none', syncServer: '', syncUsername: '', syncStatus: 'setup', mcpEnabled: false, theme: 'system', listMarker: '*', priorityMarker: '!', tagMarker: '#', sortBy: 'createdAt', sortDirection: 'desc', autoDeleteCompleted: 'none', manualTaskOrder: [], version: 1 }],
    syncQueue: [],
    collaborations: [],
    notificationStates: [],
    sessions: [],
    processedMutations: [],
    taskTombstones: [],
    listTombstones: [],
    shortcutTokens: []
  };
}

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(initialStore(), null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let db = loadStore();
if (INSTANCE_DOMAIN !== 'localhost') {
  const seedAdmin = db.users.find(user => user.id === 'usr_admin' && user.username === 'admin' && user.domain === 'localhost');
  if (seedAdmin) {
    seedAdmin.domain = INSTANCE_DOMAIN;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}
for (const user of db.users) if (!user.role) user.role = user.username === 'admin' ? 'admin' : 'user';
for (const user of db.users) if (user.mustChangePassword === undefined) user.mustChangePassword = false;
for (const settings of db.settings) {
  if (!settings.theme) settings.theme = 'system';
  if (!MARKER_CHOICES.includes(settings.listMarker)) settings.listMarker = '*';
  if (!MARKER_CHOICES.includes(settings.priorityMarker)) settings.priorityMarker = '!';
  if (!MARKER_CHOICES.includes(settings.tagMarker)) settings.tagMarker = '#';
  if (new Set([settings.listMarker, settings.priorityMarker, settings.tagMarker]).size < 3) Object.assign(settings, { listMarker: '*', priorityMarker: '!', tagMarker: '#' });
  if (!['manual', 'createdAt', 'due', 'priority', 'remaining'].includes(settings.sortBy)) settings.sortBy = 'createdAt';
  if (!['asc', 'desc'].includes(settings.sortDirection)) settings.sortDirection = 'desc';
  if (!AUTO_DELETE_COMPLETED_VALUES.includes(settings.autoDeleteCompleted)) settings.autoDeleteCompleted = 'none';
  if (!Array.isArray(settings.manualTaskOrder)) settings.manualTaskOrder = [];
  if (!Number.isInteger(settings.version)) settings.version = 1;
  if (!settings.syncStatus) settings.syncStatus = settings.syncServer || CALDAV_UPSTREAM ? 'ready' : 'setup';
}
for (const task of db.tasks) {
  if (!task.recurrence) task.recurrence = { type: 'none' };
  if (!Array.isArray(task.tags)) task.tags = [];
  if (!Array.isArray(task.sharedWithUserIds)) task.sharedWithUserIds = [];
  if (task.completed && !task.completedAt) task.completedAt = task.updatedAt || task.createdAt;
  if (!task.completed) task.completedAt = null;
  if (!Number.isInteger(task.version)) task.version = 1;
}
for (const list of db.lists) if (!Number.isInteger(list.version)) list.version = 1;
if (!Array.isArray(db.syncQueue)) db.syncQueue = [];
if (!Array.isArray(db.collaborations)) db.collaborations = [];
if (!Array.isArray(db.notificationStates)) db.notificationStates = [];
// Before task-scoped sharing existed, the task that created a list invitation
// and the invitation itself received the same timestamp. Recover that initial
// explicit @mention without exposing every task in the approved list.
for (const collaboration of db.collaborations) {
  const createdAt = Date.parse(collaboration.createdAt);
  const originatingTask = db.tasks.filter(task => task.listId === collaboration.listId && (task.createdByUserId || task.userId) === collaboration.ownerUserId)
    .map(task => ({ task, distance: Math.abs(Date.parse(task.createdAt) - createdAt) }))
    .filter(item => Number.isFinite(item.distance) && item.distance < 2000)
    .sort((a, b) => a.distance - b.distance)[0]?.task;
  if (originatingTask && !originatingTask.sharedWithUserIds.includes(collaboration.inviteeUserId)) originatingTask.sharedWithUserIds.push(collaboration.inviteeUserId);
}
if (!Array.isArray(db.sessions)) db.sessions = [];
if (!Array.isArray(db.processedMutations)) db.processedMutations = [];
if (!Array.isArray(db.taskTombstones)) db.taskTombstones = [];
if (!Array.isArray(db.listTombstones)) db.listTombstones = [];
if (!Array.isArray(db.shortcutTokens)) db.shortcutTokens = [];
db.sessions = db.sessions.filter(session => Number(session.expiresAt) > Date.now());
function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function json(res, status, body, extra = {}) {
  const renewedSession = res._sessionCookie ? { 'Set-Cookie': res._sessionCookie } : {};
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Haru-Version': APP_VERSION, ...renewedSession, ...extra });
  res.end(JSON.stringify(body));
}

function openEventStream(req, res, user) {
  const renewedSession = res._sessionCookie ? { 'Set-Cookie': res._sessionCookie } : {};
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...renewedSession
  });
  res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
  const client = { res, userId: user.id };
  eventClients.add(client);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, 25000);
  heartbeat.unref?.();
  req.once('close', () => { clearInterval(heartbeat); eventClients.delete(client); });
}

function publishChange() {
  const message = `id: ${++eventSequence}\nevent: change\ndata: {"changed":true}\n\n`;
  for (const client of eventClients) {
    if (client.res.destroyed || client.res.writableEnded) eventClients.delete(client);
    else client.res.write(message);
  }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))];
  }));
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function shortcutTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function shortcutTokenView(token) {
  return { id: token.id, name: token.name, scope: token.scope, hint: token.hint, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt || null };
}

function revokeShortcutTokens(userId) {
  db.shortcutTokens = db.shortcutTokens.filter(token => token.userId !== userId);
}

function shortcutUser(req, requiredScope) {
  const raw = String(req.headers.authorization || '').match(/^Bearer\s+(haru_sc_[A-Za-z0-9_-]+)$/)?.[1];
  if (!raw) return { error: '단축어 토큰이 필요합니다.', status: 401 };
  const token = db.shortcutTokens.find(item => item.tokenHash === shortcutTokenHash(raw));
  if (!token) return { error: '유효하지 않거나 폐기된 단축어 토큰입니다.', status: 401 };
  if (token.scope !== requiredScope) return { error: `${requiredScope} 권한의 단축어 토큰이 필요합니다.`, status: 403 };
  const user = db.users.find(item => item.id === token.userId);
  const settings = user && db.settings.find(item => item.userId === user.id);
  if (!user || !settings?.mcpEnabled) return { error: '외부 도구 연결이 비활성화되어 있습니다.', status: 403 };
  const claimedUsername = unicodeText(req.headers['x-haru-username']).trim().toLowerCase();
  if (!claimedUsername || claimedUsername !== user.username.toLowerCase()) return { error: '단축어 사용자명이 토큰 계정과 일치하지 않습니다.', status: 403 };
  token.lastUsedAt = new Date().toISOString(); save();
  return { user, token };
}

function sessionCookie(req, token, maxAge) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(req.socket.encrypted);
  return `session=${token}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function currentUser(req, res) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const session = db.sessions.find(item => item.tokenHash === sessionHash(token));
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    db.sessions = db.sessions.filter(item => item !== session); save(); return null;
  }
  session.expiresAt = Date.now() + 30 * 86400000;
  session.lastSeenAt = new Date().toISOString();
  if (res) res._sessionCookie = sessionCookie(req, token, 30 * 86400);
  save();
  return db.users.find(u => u.id === session.userId) || null;
}

async function body(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000_000) throw new Error('CalDAV 요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function uid(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function stableId(prefix, value) { return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`; }
function hostDomain(req) { return (req.headers.host || 'localhost').split(':')[0].toLowerCase(); }
function credentialKey() {
  if (CREDENTIAL_KEY_SOURCE.length < 32) throw Object.assign(new Error('서버의 HARU_CREDENTIAL_KEY 설정이 필요합니다.'), { status: 503 });
  return crypto.createHash('sha256').update(CREDENTIAL_KEY_SOURCE).digest();
}

function encryptCredential(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptCredential(value) {
  if (!value || CREDENTIAL_KEY_SOURCE.length < 32) return '';
  const [version, iv, tag, encrypted] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function calDavConfig(user) {
  const settings = db.settings.find(item => item.userId === user.id);
  const legacy = user.username === CALDAV_APP_USER;
  const server = String(settings?.syncServer || (legacy ? CALDAV_UPSTREAM : '')).trim().replace(/\/$/, '');
  const username = String(settings?.syncUsername || (legacy ? CALDAV_USERNAME : '')).trim();
  const password = decryptCredential(settings?.syncPasswordEncrypted) || (legacy ? CALDAV_PASSWORD : '');
  return { server, username, password, enabled: Boolean(server && username && password) };
}

function normalizeCalDavServer(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw Object.assign(new Error('올바른 CalDAV 서버 URL을 입력해 주세요.'), { status: 400 }); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw Object.assign(new Error('CalDAV 서버는 HTTPS URL이어야 합니다.'), { status: 400 });
  parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function usesCalDav(user) { return calDavConfig(user).enabled; }
function completedTaskCutoff(policy, now = new Date()) {
  const cutoff = new Date(now);
  if (policy === 'daily') cutoff.setHours(cutoff.getHours() - 24);
  else if (policy === 'weekly') cutoff.setDate(cutoff.getDate() - 7);
  else if (policy === 'monthly') {
    const day = cutoff.getDate(); cutoff.setDate(1); cutoff.setMonth(cutoff.getMonth() - 1);
    cutoff.setDate(Math.min(day, new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate()));
  } else if (policy === 'yearly') {
    const month = cutoff.getMonth(); const day = cutoff.getDate(); cutoff.setDate(1); cutoff.setFullYear(cutoff.getFullYear() - 1, month);
    cutoff.setDate(Math.min(day, new Date(cutoff.getFullYear(), month + 1, 0).getDate()));
  }
  else return null;
  return cutoff.getTime();
}
function purgeCompletedTasksForUser(user, now = new Date()) {
  const settings = db.settings.find(item => item.userId === user.id);
  const cutoff = completedTaskCutoff(settings?.autoDeleteCompleted, now);
  if (cutoff === null) return 0;
  const expired = db.tasks.filter(task => {
    if (task.userId !== user.id || !task.completed) return false;
    const completedAt = Date.parse(task.completedAt || task.updatedAt || task.createdAt);
    return Number.isFinite(completedAt) && completedAt <= cutoff;
  });
  if (!expired.length) return 0;
  const nowIso = now.toISOString(); const expiredIds = new Set(expired.map(task => task.id));
  for (const task of expired) {
    if (usesCalDav(user) && task.caldavHref) db.syncQueue.push({ id: uid('sync'), userId: user.id, type: 'delete-task', href: task.caldavHref, etag: task.caldavEtag, createdAt: nowIso });
    if (!db.taskTombstones.some(item => item.id === task.id && item.userId === task.userId)) db.taskTombstones.push({ id: task.id, userId: task.userId, version: (task.version || 1) + 1, deletedAt: nowIso });
  }
  db.tasks = db.tasks.filter(task => !expiredIds.has(task.id));
  for (const item of db.settings) item.manualTaskOrder = item.manualTaskOrder.filter(id => !expiredIds.has(id));
  db.notificationStates = db.notificationStates.filter(item => !expiredIds.has(item.notificationId));
  save(); publishChange();
  return expired.length;
}
async function runCompletedTaskCleanup(user, now = new Date()) {
  const deleted = purgeCompletedTasksForUser(user, now);
  if (deleted && usesCalDav(user)) try { await flushCalDavQueue(user); } catch {}
  return deleted;
}
function settingsView(settings, user) {
  if (!settings) return null;
  const { syncPasswordEncrypted, ...safe } = settings;
  const config = calDavConfig(user);
  return { ...safe, syncPasswordSet: Boolean(config.password), syncStatus: config.enabled ? (settings.syncStatus || 'ready') : 'setup' };
}
function temporaryPassword() { return crypto.randomBytes(12).toString('base64url'); }
function userView(user, domain = user.domain) { return { id: user.id, username: user.username, address: `${user.username}@${domain}`, role: user.role, mustChangePassword: Boolean(user.mustChangePassword), createdAt: user.createdAt }; }

function taskView(task, viewer) {
  const participantIds = new Set([task.userId, task.createdByUserId, ...(task.sharedWithUserIds || [])].filter(Boolean));
  const shared = participantIds.size > 1;
  participantIds.delete(viewer.id);
  const shareParticipants = shared ? [...participantIds].map(id => db.users.find(user => user.id === id)).filter(Boolean).map(user => ({ id: user.id, username: user.username, address: `${user.username}@${user.domain}` })) : [];
  return { ...task, shared, shareParticipants };
}

function collaborationView(item) {
  const list = db.lists.find(candidate => candidate.id === item.listId);
  const owner = db.users.find(candidate => candidate.id === item.ownerUserId);
  const invitee = db.users.find(candidate => candidate.id === item.inviteeUserId);
  return { ...item, listName: list?.name || '(삭제된 리스트)', owner: owner ? userView(owner) : null, invitee: invitee ? userView(invitee) : null };
}

function canAccessList(user, list) {
  return Boolean(list && (list.userId === user.id || db.collaborations.some(item => item.listId === list.id && item.inviteeUserId === user.id && item.status === 'approved')));
}

function accessibleLists(user) {
  return db.lists.filter(list => canAccessList(user, list)).map(list => {
    const owner = db.users.find(candidate => candidate.id === list.userId);
    return { ...list, shared: list.userId !== user.id, owner: owner ? { id: owner.id, username: owner.username, address: `${owner.username}@${owner.domain}` } : null };
  });
}

function canAccessTask(user, task) {
  if (!task) return false;
  if (task.userId === user.id) return true;
  const approved = db.collaborations.some(item => item.listId === task.listId && item.inviteeUserId === user.id && item.status === 'approved');
  return approved && (task.createdByUserId === user.id || task.sharedWithUserIds.includes(user.id));
}

function accessibleTasks(user) {
  return db.tasks.filter(task => canAccessTask(user, task)).map(task => taskView(task, user));
}

function normalizeRecurrence(value) {
  const recurrence = typeof value === 'object' && value ? value : { type: String(value || 'none') };
  const type = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'].includes(recurrence.type) ? recurrence.type : 'none';
  if (type === 'weekly') return { type, weekday: Math.min(6, Math.max(0, Number(recurrence.weekday) || 0)) };
  if (type === 'monthly') return { type, day: Math.min(31, Math.max(1, Number(recurrence.day) || 1)) };
  if (type === 'yearly') return { type, month: Math.min(12, Math.max(1, Number(recurrence.month) || 1)), day: Math.min(31, Math.max(1, Number(recurrence.day) || 1)) };
  return { type };
}

function nextRecurringDue(task) {
  const recurrence = normalizeRecurrence(task.recurrence);
  if (recurrence.type === 'none') return null;
  const hasTime = String(task.due || '').includes('T');
  let date = task.due ? new Date(hasTime ? task.due : `${task.due}T09:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) date = new Date();
  if (recurrence.type === 'hourly') date.setHours(date.getHours() + 1);
  if (recurrence.type === 'daily') date.setDate(date.getDate() + 1);
  if (recurrence.type === 'weekly') {
    let offset = (recurrence.weekday - date.getDay() + 7) % 7;
    if (!offset) offset = 7;
    date.setDate(date.getDate() + offset);
  }
  if (recurrence.type === 'monthly') {
    const target = new Date(date); target.setDate(1); target.setMonth(target.getMonth() + 1);
    target.setDate(Math.min(recurrence.day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate())); date = target;
  }
  if (recurrence.type === 'yearly') {
    const year = date.getFullYear() + 1;
    const maxDay = new Date(year, recurrence.month, 0).getDate();
    date = new Date(date); date.setFullYear(year, recurrence.month - 1, Math.min(recurrence.day, maxDay));
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString();
  return recurrence.type === 'hourly' || hasTime ? local.slice(0, 16) : local.slice(0, 10);
}

function rawNotificationsFor(user) {
  const invitations = db.collaborations.filter(item => item.inviteeUserId === user.id && item.status === 'pending').map(item => ({ type: 'collaboration', id: item.id, createdAt: item.createdAt, collaboration: collaborationView(item) }));
  const limit = new Date(); limit.setDate(limit.getDate() + 3);
  const limitDate = new Date(limit.getTime() - limit.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const dueTasks = accessibleTasks(user).filter(task => !task.completed && task.due && task.due.slice(0, 10) <= limitDate).sort((a, b) => a.due.localeCompare(b.due)).map(task => {
    const list = db.lists.find(candidate => candidate.id === task.listId);
    return { type: 'due', id: task.id, due: task.due, task, listName: list?.name || '' };
  });
  return [...invitations, ...dueTasks];
}

function notificationsFor(user) {
  return rawNotificationsFor(user).map(item => {
    const state = db.notificationStates.find(candidate => candidate.userId === user.id && candidate.notificationId === item.id);
    return { ...item, read: Boolean(state?.readAt), readAt: state?.readAt || null };
  }).filter(item => !db.notificationStates.some(state => state.userId === user.id && state.notificationId === item.id && state.removedAt));
}

function notificationCount(user) {
  const now = Date.now();
  return notificationsFor(user).filter(item => {
    if (item.read) return false;
    if (item.type !== 'due') return true;
    const dueAt = new Date(item.due.length === 10 ? `${item.due}T23:59:59.999` : item.due).getTime();
    return Number.isFinite(dueAt) && dueAt >= now && dueAt - now <= 24 * 60 * 60 * 1000;
  }).length;
}

function updateNotificationState(user, notificationId, changes) {
  let state = db.notificationStates.find(item => item.userId === user.id && item.notificationId === notificationId);
  if (!state) {
    state = { userId: user.id, notificationId, readAt: null, removedAt: null };
    db.notificationStates.push(state);
  }
  Object.assign(state, changes);
  return state;
}

function localDateFromOffset(days, now = new Date()) {
  const date = new Date(now); date.setDate(date.getDate() + days);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function nextWeekday(weekday, now = new Date(), extraWeeks = 0) {
  let offset = (weekday - now.getDay() + 7) % 7;
  if (!offset) offset = 7;
  return localDateFromOffset(offset + extraWeeks * 7, now);
}

function nearestWeekday(weekday, now = new Date(), extraWeeks = 0) {
  const offset = (weekday - now.getDay() + 7) % 7;
  return localDateFromOffset(offset + extraWeeks * 7, now);
}

function lastWeekdayOfMonth(weekday, now = new Date()) {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  lastDay.setDate(lastDay.getDate() - ((lastDay.getDay() - weekday + 7) % 7));
  return localDateFromOffset(0, lastDay);
}

function parseNaturalDue(input, decision) {
  const relative = { '오늘': 0, '내일': 1, '모레': 2, '글피': 3 };
  const korean = input.match(/(?:^|\s)(오늘|내일|모레|글피)(?=\s|$)/u);
  if (korean) return { due: localDateFromOffset(relative[korean[1]]), phrase: korean[1], title: input.replace(korean[0], ' ').replace(/\s+/g, ' ').trim() };
  const englishRelative = input.match(/(?:^|\s)(today|tomorrow)(?=\s|$)/i);
  if (englishRelative) {
    const phrase = englishRelative[1];
    return { due: localDateFromOffset(phrase.toLowerCase() === 'tomorrow' ? 1 : 0), phrase, title: input.replace(englishRelative[0], ' ').replace(/\s+/g, ' ').trim() };
  }
  const validDate = (year, month, day) => {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? localDateFromOffset(0, date) : null;
  };
  const fullNumeric = input.match(/(?:^|\s)((?:on\s+)?(\d{4})[\/-](\d{1,2})[\/-](\d{1,2}))(?=\s|$)/i);
  if (fullNumeric) {
    const due = validDate(Number(fullNumeric[2]), Number(fullNumeric[3]), Number(fullNumeric[4]));
    if (due) return { due, phrase: fullNumeric[1], title: input.replace(fullNumeric[0], ' ').replace(/\s+/g, ' ').trim() };
  }
  const shortNumeric = input.match(/(?:^|\s)((?:on\s+)?(\d{1,2})[\/-](\d{1,2}))(?=\s|$)/i);
  if (shortNumeric) {
    const now = new Date(); const month = Number(shortNumeric[2]); const day = Number(shortNumeric[3]);
    let year = now.getFullYear(); let due = validDate(year, month, day);
    if (due && due < localDateFromOffset(0, now)) due = validDate(++year, month, day);
    if (due) return { due, phrase: shortNumeric[1], title: input.replace(shortNumeric[0], ' ').replace(/\s+/g, ' ').trim() };
  }
  const weekdays = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const explicit = input.match(/(?:^|\s)(on|by)\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)(?=\s|$)/i);
  if (explicit) return { due: nextWeekday(weekdays[explicit[2].toLowerCase()]), phrase: explicit[0].trim(), title: input.replace(explicit[0], ' ').replace(/\s+/g, ' ').trim() };
  const koWeekdays = { '일요일': 0, '월요일': 1, '화요일': 2, '수요일': 3, '목요일': 4, '금요일': 5, '토요일': 6 };
  const koreanWeekday = input.match(/(?:^|\s)((?:(다다음|다음|마지막)\s+)?(일요일|월요일|화요일|수요일|목요일|금요일|토요일)(?:까지)?)(?=\s|$)/u);
  if (koreanWeekday) {
    const [, phrase, modifier, weekdayName] = koreanWeekday;
    const weekday = koWeekdays[weekdayName];
    const due = modifier === '마지막' ? lastWeekdayOfMonth(weekday) : nearestWeekday(weekday, new Date(), modifier === '다다음' ? 2 : modifier === '다음' ? 1 : 0);
    return { due, phrase, title: input.replace(koreanWeekday[0], ' ').replace(/\s+/g, ' ').trim() };
  }
  const ambiguousEn = input.match(/(?:^|\s)(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)(?=\s|$)/i);
  const ambiguous = ambiguousEn;
  if (!ambiguous) return { due: null, title: input };
  const phrase = ambiguous[1];
  const weekday = weekdays[phrase.toLowerCase()];
  const stripped = input.replace(ambiguous[0], ' ').replace(/\s+/g, ' ').trim();
  if (decision === 'accept') return { due: nextWeekday(weekday), phrase, title: stripped };
  if (decision === 'keep') return { due: null, phrase, title: input };
  return { due: null, phrase, title: input, confirmation: { phrase, suggestedDue: nextWeekday(weekday), suggestedTitle: stripped } };
}

function markerRegex(marker, valuePattern, flags = 'gu') {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}${valuePattern}`, flags);
}

function parseQuickTask(input, dueDecision, settings = {}) {
  input = unicodeText(input);
  const listMarker = settings.listMarker || '*'; const priorityMarker = settings.priorityMarker || '!'; const tagMarker = settings.tagMarker || '#';
  const mentionPattern = /(?:^|\s)@([\p{L}\p{N}._-]{2,40})(?:@([\p{L}\p{N}.-]+))?(?=\s|$)/gu;
  const mentions = [...input.matchAll(mentionPattern)].map(match => ({ username: match[1].toLowerCase(), domain: match[2]?.toLowerCase() || null }));
  const inputForFlags = input.replace(mentionPattern, ' ');
  const listPattern = markerRegex(listMarker, '(?:\\(([^()]+)\\)|([^\\s]+))');
  const tagPattern = markerRegex(tagMarker, '(?:\\(([^()]+)\\)|([^\\s]+))');
  const priorityPattern = markerRegex(priorityMarker, '(?:\\(([123])\\)|([123]))(?=\\s|$)', 'g');
  const listMatches = [...inputForFlags.matchAll(listPattern)];
  const tagMatches = [...inputForFlags.matchAll(tagPattern)];
  const priorityMatches = [...inputForFlags.matchAll(priorityPattern)];
  const listNames = listMatches.map(match => unicodeText(match[1] || match[2]).trim()).filter(Boolean);
  const tags = [...new Set(tagMatches.map(match => unicodeText(match[1] || match[2]).trim()).filter(Boolean))].slice(0, 20);
  const priorityNumber = priorityMatches.at(-1)?.[1] || priorityMatches.at(-1)?.[2];
  const priority = ({ '3': 'high', '2': 'medium', '1': 'low' })[priorityNumber] || null;
  const withoutFlags = inputForFlags
    .replace(listPattern, ' ')
    .replace(tagPattern, ' ')
    .replace(priorityPattern, ' ')
    .replace(/\s+/g, ' ').trim();
  const naturalDue = parseNaturalDue(withoutFlags, dueDecision);
  return { title: naturalDue.title, listName: listNames.at(-1) || null, tags, priority, mentions, naturalDue: naturalDue.due, dueConfirmation: naturalDue.confirmation };
}

async function addTask(user, payload, source = 'user') {
  const settings = db.settings.find(s => s.userId === user.id);
  const parsed = parseQuickTask(payload.title, payload.dueDecision, settings);
  let listId = payload.listId || settings?.defaultListId;
  if (parsed.listName) {
    const matched = accessibleLists(user).sort((a, b) => Number(a.shared) - Number(b.shared)).find(l => l.name.toLocaleLowerCase() === parsed.listName.toLocaleLowerCase());
    if (!matched) return { missingList: parsed.listName };
    listId = matched.id;
  }
  const list = db.lists.find(l => l.id === listId && canAccessList(user, l));
  if (!list || !parsed.title) return { error: '태스크 제목과 유효한 리스트가 필요합니다.' };
  const invitees = [];
  for (const mention of parsed.mentions) {
    const localDomains = new Set([user.domain, 'localhost', '127.0.0.1']);
    if (mention.domain && !localDomains.has(mention.domain)) return { error: `원격 인스턴스(${mention.domain}) 협업 전송은 아직 지원하지 않습니다.` };
    const target = db.users.find(candidate => candidate.domain === user.domain && candidate.username.toLowerCase() === mention.username);
    if (!target) return { error: `@${mention.username} 계정을 찾을 수 없습니다.` };
    if (target.id === user.id) return { error: '자기 자신에게 협업을 요청할 수 없습니다.' };
    if (!invitees.some(item => item.id === target.id)) invitees.push(target);
  }
  if (invitees.length && list.userId !== user.id) return { error: '협업 초대는 자신이 소유한 리스트에서만 보낼 수 있습니다.' };
  if (!payload.due && parsed.dueConfirmation) return { dueConfirmation: parsed.dueConfirmation };
  let due = payload.due || parsed.naturalDue || null;
  if (!due && settings?.defaultDue === 'today') due = localDateFromOffset(0);
  if (!due && settings?.defaultDue === 'tomorrow') due = localDateFromOffset(1);
  const now = new Date().toISOString();
  const payloadTags = Array.isArray(payload.tags) ? payload.tags.map(tag => unicodeText(tag).trim()).filter(Boolean) : [];
  const tags = [...new Set([...payloadTags, ...parsed.tags])].slice(0, 20);
  const requestedId = /^task_[A-Za-z0-9_-]{8,}$/.test(String(payload.id || '')) ? String(payload.id) : uid('task');
  const task = { id: requestedId, userId: list.userId, createdByUserId: user.id, sharedWithUserIds: invitees.map(target => target.id), listId, title: unicodeText(parsed.title), notes: unicodeText(payload.notes), due, priority: parsed.priority || payload.priority || settings?.defaultPriority || 'none', tags, recurrence: normalizeRecurrence(payload.recurrence), source: ['user', 'cli', 'caldav', 'mcp', 'ai'].includes(source) ? source : 'user', completed: false, completedAt: null, createdAt: payload.createdAt || now, updatedAt: now, version: 1 };
  const duplicate = db.tasks.find(candidate => candidate.userId === task.userId && candidate.listId === task.listId && candidate.title === task.title && candidate.notes === task.notes && candidate.due === task.due && candidate.priority === task.priority && candidate.completed === task.completed && JSON.stringify(candidate.tags || []) === JSON.stringify(task.tags) && JSON.stringify(normalizeRecurrence(candidate.recurrence)) === JSON.stringify(task.recurrence) && JSON.stringify(candidate.sharedWithUserIds || []) === JSON.stringify(task.sharedWithUserIds));
  if (duplicate) return { task: duplicate, collaborationRequests: [], duplicate: true };
  const listOwner = db.users.find(candidate => candidate.id === list.userId);
  if (listOwner && usesCalDav(listOwner) && list.caldavHref && !clientSyncUsers.has(listOwner.id)) await putTaskToCalDav(listOwner, task, list, true);
  const collaborationRequests = [];
  if (list.userId === user.id) for (const target of invitees) {
    let request = db.collaborations.find(item => item.listId === list.id && item.inviteeUserId === target.id);
    if (!request) {
      request = { id: uid('collab'), listId: list.id, ownerUserId: user.id, requesterUserId: user.id, inviteeUserId: target.id, inviteeAddress: `${target.username}@${target.domain}`, status: 'pending', createdAt: now, updatedAt: now };
      db.collaborations.push(request);
    } else if (request.status === 'rejected') {
      request.status = 'pending'; request.updatedAt = now;
    }
    if (request.status === 'pending') db.notificationStates = db.notificationStates.filter(item => !(item.userId === target.id && item.notificationId === request.id));
    collaborationRequests.push(collaborationView(request));
  }
  db.tasks.push(task); save(); return { task, collaborationRequests };
}

async function updateTask(user, taskId, payload) {
  const task = db.tasks.find(candidate => candidate.id === taskId && canAccessTask(user, candidate));
  if (!task) return { status: 404, error: '태스크를 찾을 수 없습니다.' };
  const originalList = db.lists.find(list => list.id === task.listId);
  const nextTask = { ...task };
  for (const key of ['title', 'notes', 'due', 'priority', 'tags', 'completed', 'listId', 'recurrence']) {
    if (key in payload) nextTask[key] = ['title', 'notes'].includes(key) ? unicodeText(payload[key]) : payload[key];
  }
  nextTask.title = nextTask.title.trim();
  nextTask.notes = unicodeText(nextTask.notes);
  nextTask.tags = [...new Set((Array.isArray(nextTask.tags) ? nextTask.tags : []).map(tag => unicodeText(tag).trim()).filter(Boolean))].slice(0, 20);
  if (!nextTask.title) return { status: 400, error: '태스크 제목이 필요합니다.' };
  if (!['none', 'low', 'medium', 'high'].includes(nextTask.priority)) return { status: 400, error: '우선도는 none, low, medium, high 중 하나여야 합니다.' };
  nextTask.recurrence = normalizeRecurrence(nextTask.recurrence);
  const targetList = db.lists.find(list => list.id === nextTask.listId);
  if (!canAccessList(user, targetList)) return { status: 403, error: '대상 리스트에 접근할 수 없습니다.' };
  if (targetList.userId !== originalList.userId) return { status: 403, error: '다른 소유자의 리스트로 태스크를 이동할 수 없습니다.' };
  const wasCompleted = task.completed;
  nextTask.updatedAt = new Date().toISOString();
  nextTask.version = (task.version || 1) + 1;
  if (!wasCompleted && nextTask.completed) nextTask.completedAt = nextTask.updatedAt;
  if (wasCompleted && !nextTask.completed) nextTask.completedAt = null;
  const listOwner = db.users.find(candidate => candidate.id === targetList.userId);
  if (listOwner && usesCalDav(listOwner) && task.caldavHref) await putTaskToCalDav(listOwner, nextTask, targetList, false);
  let nextTaskInstance = null;
  if (!wasCompleted && nextTask.completed && nextTask.recurrence.type !== 'none') {
    const now = new Date().toISOString();
    const nextDue = nextRecurringDue(nextTask);
    nextTaskInstance = db.tasks.find(item => item.recurrenceSourceTaskId === task.id && item.due === nextDue) || { ...nextTask, id: uid('task'), caldavHref: undefined, caldavEtag: undefined, caldavRaw: undefined, completed: false, completedAt: null, due: nextDue, recurrenceSourceTaskId: task.id, createdByUserId: user.id, createdAt: now, updatedAt: now, version: 1 };
    if (listOwner && usesCalDav(listOwner) && targetList.caldavHref) await putTaskToCalDav(listOwner, nextTaskInstance, targetList, true);
    if (!db.tasks.includes(nextTaskInstance)) db.tasks.push(nextTaskInstance);
  }
  Object.assign(task, nextTask);
  save();
  return { task, nextTask: nextTaskInstance };
}

function syncSnapshot(user, req) {
  return {
    appVersion: APP_VERSION,
    user: userView(user, hostDomain(req)),
    lists: accessibleLists(user),
    tasks: accessibleTasks(user),
    settings: settingsView(db.settings.find(item => item.userId === user.id), user),
    notificationCount: notificationCount(user)
  };
}

const importedValue = (value, fallback = null) => value === 'none' || value === null || value === undefined ? fallback : value;
const importedTimestamp = (value, fallback) => {
  const parsed = Date.parse(importedValue(value, ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};
async function importAccountData(user, payload) {
  if (payload?.format !== 'haru-data-export' || payload?.schemaVersion !== 1 || !Array.isArray(payload?.lists)) throw Object.assign(new Error('Haru JSON 내보내기 파일이 아닙니다.'), { status: 400 });
  if (payload.lists.length > 1000) throw Object.assign(new Error('한 번에 가져올 수 있는 리스트 수를 초과했습니다.'), { status: 400 });
  const now = new Date().toISOString(); const createdListIds = new Set(); const changedTaskIds = new Set();
  let importedLists = 0; let importedTasks = 0; let skippedTasks = 0; let totalTasks = 0; let importedDefaultListId = null;
  for (const sourceList of payload.lists) {
    if (!sourceList || !Array.isArray(sourceList.tasks)) continue;
    totalTasks += sourceList.tasks.length;
    if (totalTasks > 20000) throw Object.assign(new Error('한 번에 가져올 수 있는 태스크 수를 초과했습니다.'), { status: 400 });
    const name = unicodeText(importedValue(sourceList.name, '')).trim().slice(0, 100);
    if (!name) continue;
    let list = db.lists.find(item => item.userId === user.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!list) {
      list = { id: uid('list'), userId: user.id, name, color: unicodeText(importedValue(sourceList.data?.color, '#a6c4d9')).slice(0, 32), isDefault: false, createdAt: importedTimestamp(sourceList.data?.createdAt, now), version: 1 };
      db.lists.push(list); createdListIds.add(list.id); importedLists += 1;
    }
    if (sourceList.data?.isDefault === true) importedDefaultListId = list.id;
    for (const sourceTask of sourceList.tasks) {
      if (!sourceTask || typeof sourceTask !== 'object') continue;
      const title = unicodeText(importedValue(sourceTask.title, '')).trim().slice(0, 500);
      if (!title) { skippedTasks += 1; continue; }
      const tagsSource = importedValue(sourceTask.tags, []);
      const tags = [...new Set((Array.isArray(tagsSource) ? tagsSource : []).map(tag => unicodeText(tag).trim()).filter(Boolean))].slice(0, 20);
      const priority = ['none', 'low', 'medium', 'high'].includes(sourceTask.priority) ? sourceTask.priority : 'none';
      const createdAt = importedTimestamp(sourceTask.createdAt, now); const updatedAt = importedTimestamp(sourceTask.updatedAt, createdAt);
      const completed = sourceTask.completed === true;
      const task = { id: uid('task'), userId: user.id, createdByUserId: user.id, sharedWithUserIds: [], listId: list.id, title, notes: unicodeText(importedValue(sourceTask.notes, '')).slice(0, 5000), due: importedValue(sourceTask.due, null), priority, tags, recurrence: normalizeRecurrence(importedValue(sourceTask.recurrence, { type: 'none' })), completed, completedAt: completed ? importedTimestamp(sourceTask.completedAt, updatedAt) : null, createdAt, updatedAt, version: 1 };
      if (db.tasks.some(candidate => taskContentKey(candidate) === taskContentKey(task))) { skippedTasks += 1; continue; }
      db.tasks.push(task); changedTaskIds.add(task.id); importedTasks += 1;
    }
  }
  const settings = db.settings.find(item => item.userId === user.id);
  if (importedDefaultListId && settings.defaultListId !== importedDefaultListId) {
    for (const list of db.lists.filter(item => item.userId === user.id)) list.isDefault = list.id === importedDefaultListId;
    settings.defaultListId = importedDefaultListId; settings.version = (settings.version || 1) + 1;
  }
  save();
  const caldavError = await syncClientChangesToCalDav(user, changedTaskIds, createdListIds);
  return { importedLists, importedTasks, skippedTasks, caldavError };
}

function rememberMutation(user, mutation, result) {
  db.processedMutations.push({ id: mutation.id, userId: user.id, result, processedAt: new Date().toISOString() });
  if (db.processedMutations.length > 10000) db.processedMutations.splice(0, db.processedMutations.length - 10000);
}

function mutationResult(mutation, status, extra = {}) {
  return { id: mutation.id, type: mutation.type, status, ...extra };
}

function taskContentKey(task) {
  return JSON.stringify({ userId: task.userId, createdByUserId: task.createdByUserId || task.userId, sharedWithUserIds: [...(task.sharedWithUserIds || [])].sort(), listId: task.listId, title: task.title, notes: task.notes || '', due: task.due || null, priority: task.priority || 'none', tags: task.tags || [], recurrence: normalizeRecurrence(task.recurrence), completed: Boolean(task.completed) });
}

function deduplicateTasksForUser(user) {
  const seen = new Map(); const removed = new Set();
  for (const task of db.tasks.filter(item => item.userId === user.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const key = taskContentKey(task); const first = seen.get(key);
    if (!first) { seen.set(key, task); continue; }
    removed.add(task.id);
    if (usesCalDav(user) && task.caldavHref) db.syncQueue.push({ id: uid('sync'), userId: user.id, type: 'delete-task', href: task.caldavHref, etag: task.caldavEtag, createdAt: new Date().toISOString() });
  }
  if (removed.size) {
    db.tasks = db.tasks.filter(task => !removed.has(task.id));
    for (const settings of db.settings) settings.manualTaskOrder = settings.manualTaskOrder.filter(id => !removed.has(id));
  }
}

async function processClientMutations(user, mutations) {
  const results = [];
  const changedTaskIds = new Set();
  const createdListIds = new Set();
  const aliases = new Map();
  const invalidEntities = new Set();
  const deleteTypes = new Set(['delete-task', 'delete-list']);
  const ordered = [...mutations].sort((a, b) => Number(deleteTypes.has(b.type)) - Number(deleteTypes.has(a.type)) || a.index - b.index);
  for (const mutation of ordered) {
    const prior = db.processedMutations.find(item => item.userId === user.id && item.id === mutation.id);
    if (prior) { results.push({ ...prior.result, replayed: true }); continue; }
    let result;
    const payload = mutation.payload && typeof mutation.payload === 'object' ? { ...mutation.payload } : {};
    if (payload.listId && aliases.has(payload.listId)) payload.listId = aliases.get(payload.listId);
    const entityKey = `${mutation.type.endsWith('settings') || mutation.type === 'task-order' ? 'settings' : mutation.type.split('-').at(-1)}:${mutation.entityId}`;
    if (invalidEntities.has(entityKey)) {
      result = mutationResult(mutation, 'conflict'); rememberMutation(user, mutation, result); results.push(result); continue;
    }
    if (mutation.type === 'delete-task') {
      const task = db.tasks.find(item => item.id === mutation.entityId);
      if (!task) result = mutationResult(mutation, 'applied');
      else if (!canAccessTask(user, task)) result = mutationResult(mutation, 'permission_revoked');
      else if (Number(mutation.baseVersion) !== Number(task.version)) result = mutationResult(mutation, 'conflict');
      else {
        const owner = db.users.find(candidate => candidate.id === task.userId);
        if (usesCalDav(owner) && task.caldavHref) db.syncQueue.push({ id: uid('sync'), userId: owner.id, type: 'delete-task', href: task.caldavHref, etag: task.caldavEtag, createdAt: new Date().toISOString() });
        db.taskTombstones.push({ id: task.id, userId: task.userId, version: task.version + 1, deletedAt: new Date().toISOString() });
        db.tasks = db.tasks.filter(item => item !== task);
        for (const settings of db.settings) settings.manualTaskOrder = settings.manualTaskOrder.filter(id => id !== task.id);
        result = mutationResult(mutation, 'applied');
      }
    } else if (mutation.type === 'delete-list') {
      const list = db.lists.find(item => item.id === mutation.entityId);
      if (!list) result = mutationResult(mutation, 'applied');
      else if (list.userId !== user.id) result = mutationResult(mutation, 'permission_revoked');
      else if (Number(mutation.baseVersion) !== Number(list.version)) result = mutationResult(mutation, 'conflict');
      else {
        if (usesCalDav(user) && list.caldavHref) db.syncQueue.push({ id: uid('sync'), userId: user.id, type: 'delete-list', href: list.caldavHref, createdAt: new Date().toISOString() });
        const deletedTaskIds = new Set(db.tasks.filter(task => task.listId === list.id).map(task => task.id));
        db.tasks = db.tasks.filter(task => task.listId !== list.id);
        db.lists = db.lists.filter(item => item !== list);
        db.collaborations = db.collaborations.filter(item => item.listId !== list.id);
        db.listTombstones.push({ id: list.id, userId: user.id, version: list.version + 1, deletedAt: new Date().toISOString() });
        const settings = db.settings.find(item => item.userId === user.id);
        settings.manualTaskOrder = settings.manualTaskOrder.filter(id => !deletedTaskIds.has(id));
        let replacement = db.lists.find(item => item.userId === user.id);
        if (!replacement) {
          const now = new Date().toISOString();
          replacement = { id: uid('list'), userId: user.id, name: '수집', color: '#a6c4d9', isDefault: true, createdAt: now, version: 1 };
          db.lists.push(replacement); createdListIds.add(replacement.id);
        }
        if (settings.defaultListId === list.id || list.isDefault) {
          for (const item of db.lists.filter(item => item.userId === user.id)) item.isDefault = item.id === replacement.id;
          settings.defaultListId = replacement.id; settings.version += 1;
        }
        result = mutationResult(mutation, 'applied');
      }
    } else if (mutation.type === 'create-list') {
      const name = unicodeText(payload.name).trim(); const color = payload.color || '#a6c4d9';
      const duplicate = db.lists.find(item => item.userId === user.id && item.name.toLowerCase() === name.toLowerCase() && item.color === color);
      if (duplicate) { aliases.set(mutation.entityId, duplicate.id); result = mutationResult(mutation, 'merged', { canonicalId: duplicate.id }); }
      else if (!name || !/^list_[A-Za-z0-9_-]{8,}$/.test(String(mutation.entityId || ''))) result = mutationResult(mutation, 'rejected');
      else {
        const list = { id: mutation.entityId, userId: user.id, name, color, isDefault: false, createdAt: payload.createdAt || new Date().toISOString(), version: 1 };
        db.lists.push(list); createdListIds.add(list.id); aliases.set(mutation.entityId, list.id); result = mutationResult(mutation, 'applied', { canonicalId: list.id });
      }
    } else if (mutation.type === 'create-task') {
      const list = db.lists.find(item => item.id === payload.listId);
      if (list && !canAccessList(user, list)) result = mutationResult(mutation, 'permission_revoked');
      else {
        const created = await addTask(user, { ...payload, id: mutation.entityId, dueDecision: payload.dueDecision || 'keep' });
        if (created.error || created.missingList) result = mutationResult(mutation, list ? 'rejected' : 'permission_revoked');
        else {
          changedTaskIds.add(created.task.id);
          result = mutationResult(mutation, created.duplicate ? 'merged' : 'applied', { canonicalId: created.task.id });
        }
      }
    } else if (mutation.type === 'update-task') {
      const task = db.tasks.find(item => item.id === mutation.entityId);
      if (!task) result = mutationResult(mutation, 'conflict');
      else if (!canAccessTask(user, task)) result = mutationResult(mutation, 'permission_revoked');
      else if (Number(mutation.baseVersion) !== Number(task.version)) result = mutationResult(mutation, 'conflict');
      else {
        const wasCompleted = task.completed; const originalList = db.lists.find(list => list.id === task.listId);
        const next = { ...task };
        for (const key of ['title', 'notes', 'due', 'priority', 'tags', 'completed', 'listId', 'recurrence']) if (key in payload) next[key] = ['title', 'notes'].includes(key) ? unicodeText(payload[key]) : payload[key];
        next.title = next.title.trim(); next.notes = unicodeText(next.notes); next.tags = [...new Set((Array.isArray(next.tags) ? next.tags : []).map(tag => unicodeText(tag).trim()).filter(Boolean))].slice(0, 20);
        const targetList = db.lists.find(list => list.id === next.listId);
        if (!next.title) result = mutationResult(mutation, 'rejected');
        else if (!canAccessList(user, targetList) || targetList.userId !== originalList.userId) result = mutationResult(mutation, 'permission_revoked');
        else {
          next.recurrence = normalizeRecurrence(next.recurrence); next.updatedAt = new Date().toISOString(); next.version = task.version + 1;
          if (!wasCompleted && next.completed) next.completedAt = next.updatedAt;
          if (wasCompleted && !next.completed) next.completedAt = null;
          Object.assign(task, next); changedTaskIds.add(task.id);
          if (!wasCompleted && task.completed && task.recurrence.type !== 'none') {
            const due = nextRecurringDue(task);
            let occurrence = db.tasks.find(item => item.recurrenceSourceTaskId === task.id && item.due === due);
            if (!occurrence) {
              const now = new Date().toISOString();
              occurrence = { ...task, id: uid('task'), caldavHref: undefined, caldavEtag: undefined, caldavRaw: undefined, completed: false, completedAt: null, due, recurrenceSourceTaskId: task.id, createdByUserId: user.id, createdAt: now, updatedAt: now, version: 1 };
              db.tasks.push(occurrence); changedTaskIds.add(occurrence.id);
            }
          }
          result = mutationResult(mutation, 'applied');
        }
      }
    } else if (mutation.type === 'update-settings' || mutation.type === 'task-order') {
      const settings = db.settings.find(item => item.userId === user.id);
      if (Number(mutation.baseVersion) !== Number(settings.version)) result = mutationResult(mutation, 'conflict');
      else if (mutation.type === 'task-order') {
        const ids = Array.isArray(payload.taskIds) ? payload.taskIds : [];
        const accessibleIds = new Set(accessibleTasks(user).map(task => task.id));
        if (ids.some(id => !accessibleIds.has(id))) result = mutationResult(mutation, 'permission_revoked');
        else { settings.manualTaskOrder = [...ids, ...settings.manualTaskOrder.filter(id => !ids.includes(id) && accessibleIds.has(id))]; settings.version += 1; result = mutationResult(mutation, 'applied'); }
      } else {
        const changes = Object.fromEntries(SETTING_KEYS.filter(key => key in payload).map(key => [key, payload[key]]));
        if ('autoDeleteCompleted' in changes && !AUTO_DELETE_COMPLETED_VALUES.includes(changes.autoDeleteCompleted)) result = mutationResult(mutation, 'rejected');
        else if ('mcpEnabled' in changes && typeof changes.mcpEnabled !== 'boolean') result = mutationResult(mutation, 'rejected');
        else {
          if (changes.mcpEnabled === false) revokeShortcutTokens(user.id);
          Object.assign(settings, changes); settings.version += 1; result = mutationResult(mutation, 'applied');
        }
      }
    } else result = mutationResult(mutation, 'rejected');
    if (result.status === 'conflict' || result.status === 'permission_revoked') invalidEntities.add(entityKey);
    rememberMutation(user, mutation, result); results.push(result);
  }
  deduplicateTasksForUser(user);
  save();
  return { results, changedTaskIds, createdListIds };
}

async function syncClientChangesToCalDav(user, changedTaskIds, createdListIds) {
  if (!usesCalDav(user)) return null;
  try {
    await flushCalDavQueue(user);
    for (const listId of createdListIds) {
      const list = db.lists.find(item => item.id === listId && item.userId === user.id);
      if (list && !list.caldavHref) list.caldavHref = await createCalDavList(user, list.name, list.color);
    }
    for (const taskId of changedTaskIds) {
      const task = db.tasks.find(item => item.id === taskId && item.userId === user.id);
      const list = task && db.lists.find(item => item.id === task.listId);
      if (task && list?.caldavHref) await putTaskToCalDav(user, task, list, !task.caldavHref);
    }
    save();
    await syncFromCalDav(user, true);
    return null;
  } catch (error) {
    return error.message;
  }
}

function escapeIcs(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function dueToIcs(value) {
  if (!value) return null;
  if (String(value).includes('T')) return `${String(value).replace(/[-:]/g, '')}${String(value).length === 16 ? '00' : ''}`;
  return String(value).replaceAll('-', '');
}

function rewriteDavXml(value, fromPrefix, toPrefix) {
  if (!value) return value;
  const hrefStart = '(<(?:[A-Za-z][\\w.-]*:)?href\\b[^>]*>)';
  if (!fromPrefix) return value.replace(new RegExp(`${hrefStart}/`, 'gi'), `$1${toPrefix}/`);
  const escaped = fromPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${hrefStart}${escaped}(?=/|<)`, 'gi'), `$1${toPrefix}`);
}

async function proxyCalDav(req, res, url) {
  if (!CALDAV_UPSTREAM) return json(res, 503, { error: 'CalDAV upstream이 설정되지 않았습니다.' });
  const suffix = url.pathname.slice('/caldav'.length) || '/';
  const target = new URL(CALDAV_UPSTREAM);
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = url.search;
  const headers = {};
  for (const name of ['authorization', 'content-type', 'depth', 'if-match', 'if-none-match', 'prefer', 'brief']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (req.headers.destination) {
    headers.destination = req.headers.destination.replace(`${BASE_PATH}/caldav`, CALDAV_UPSTREAM);
  }
  let payload = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : await rawBody(req);
  if (payload?.length && String(req.headers['content-type'] || '').includes('xml')) {
    const xml = rewriteDavXml(payload.toString('utf8'), `${BASE_PATH}/caldav`, '');
    payload = Buffer.from(xml);
  }
  const upstream = await fetch(target, { method: req.method, headers, body: payload, redirect: 'manual' });
  const responseHeaders = {};
  for (const name of ['content-type', 'etag', 'dav', 'allow', 'www-authenticate', 'cache-control', 'last-modified']) {
    const value = upstream.headers.get(name); if (value) responseHeaders[name] = value;
  }
  const location = upstream.headers.get('location');
  if (location) responseHeaders.location = location.replace(CALDAV_UPSTREAM, `${BASE_PATH}/caldav`);
  let responseBody = Buffer.from(await upstream.arrayBuffer());
  if (String(responseHeaders['content-type'] || '').includes('xml')) {
    const xml = rewriteDavXml(responseBody.toString('utf8'), '', `${BASE_PATH}/caldav`);
    responseBody = Buffer.from(xml);
    responseHeaders['content-length'] = String(responseBody.length);
  }
  res.writeHead(upstream.status, responseHeaders);
  res.end(req.method === 'HEAD' ? undefined : responseBody);
}

function taskToIcs(task) {
  const fmt = s => String(s).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const due = task.due ? `\r\nDUE${String(task.due).includes('T') ? '' : ';VALUE=DATE'}:${dueToIcs(task.due)}` : '';
  const priority = { high: 1, medium: 5, low: 9, none: 0 }[task.priority] ?? 0;
  const categories = task.tags?.length ? `\r\nCATEGORIES:${task.tags.map(escapeIcs).join(',')}` : '';
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Haru//Tasks//KO\r\nBEGIN:VTODO\r\nUID:${task.id}@haru\r\nDTSTAMP:${fmt(task.updatedAt)}\r\nSUMMARY:${escapeIcs(task.title)}\r\nDESCRIPTION:${escapeIcs(task.notes)}${due}\r\nPRIORITY:${priority}${categories}\r\nSTATUS:${task.completed ? 'COMPLETED' : 'NEEDS-ACTION'}\r\nX-HARU-LIST-ID:${task.listId}\r\nX-HARU-RECURRENCE:${escapeIcs(JSON.stringify(normalizeRecurrence(task.recurrence)))}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
}

function xmlDecode(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z][\\w.-]*:)?${name}>`, 'i'));
  return xmlDecode(match?.[1] || '');
}

function davResponses(xml) {
  return String(xml).match(/<(?:[A-Za-z][\w.-]*:)?response\b[\s\S]*?<\/(?:[A-Za-z][\w.-]*:)?response>/gi) || [];
}

function unescapeIcs(value) {
  return String(value || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function icsProperty(raw, name) {
  const unfolded = String(raw).replace(/\r?\n[ \t]/g, '');
  const match = unfolded.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'mi'));
  return match ? unescapeIcs(match[1].trim()) : '';
}

function icsDate(value) {
  if (!value) return null;
  const timestamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (timestamp) return `${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}`;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function recurrenceFromIcs(raw) {
  try { return normalizeRecurrence(JSON.parse(icsProperty(raw, 'X-HARU-RECURRENCE') || '{"type":"none"}')); }
  catch { return { type: 'none' }; }
}

function icsTimestamp(value) {
  if (!value) return new Date().toISOString();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : new Date().toISOString();
}

function priorityFromIcs(value) {
  const n = Number(value || 0); return !n ? 'none' : n <= 3 ? 'high' : n <= 6 ? 'medium' : 'low';
}

function priorityToIcs(value) { return { high: 1, medium: 5, low: 9, none: 0 }[value] ?? 0; }

function replaceIcsProperty(raw, name, value, parameters = '') {
  const lines = String(raw).replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  const filtered = lines.filter(line => !new RegExp(`^${name}(?:;|:)`, 'i').test(line));
  const index = filtered.findIndex(line => /^END:VTODO$/i.test(line));
  if (value !== null && value !== undefined && value !== '') filtered.splice(index < 0 ? filtered.length : index, 0, `${name}${parameters}:${value}`);
  return `${filtered.join('\r\n')}\r\n`;
}

function updateTaskIcs(task) {
  let raw = task.caldavRaw || taskToIcs(task);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  raw = replaceIcsProperty(raw, 'SUMMARY', escapeIcs(task.title));
  raw = replaceIcsProperty(raw, 'DESCRIPTION', escapeIcs(task.notes));
  raw = replaceIcsProperty(raw, 'DUE', dueToIcs(task.due), task.due && !String(task.due).includes('T') ? ';VALUE=DATE' : '');
  raw = replaceIcsProperty(raw, 'PRIORITY', String(priorityToIcs(task.priority)));
  raw = replaceIcsProperty(raw, 'CATEGORIES', task.tags?.length ? task.tags.map(escapeIcs).join(',') : null);
  raw = replaceIcsProperty(raw, 'STATUS', task.completed ? 'COMPLETED' : 'NEEDS-ACTION');
  raw = replaceIcsProperty(raw, 'PERCENT-COMPLETE', task.completed ? '100' : '0');
  raw = replaceIcsProperty(raw, 'COMPLETED', task.completed ? stamp : null);
  raw = replaceIcsProperty(raw, 'LAST-MODIFIED', stamp);
  raw = replaceIcsProperty(raw, 'DTSTAMP', stamp);
  raw = replaceIcsProperty(raw, 'SEQUENCE', String(Number(icsProperty(raw, 'SEQUENCE') || 0) + 1));
  raw = replaceIcsProperty(raw, 'X-HARU-RECURRENCE', escapeIcs(JSON.stringify(normalizeRecurrence(task.recurrence))));
  return raw;
}

async function directDav(user, pathname, method, payload, extraHeaders = {}) {
  const config = calDavConfig(user);
  if (!config.enabled) throw new Error('CalDAV 서버, ID와 비밀번호를 모두 설정해 주세요.');
  const target = new URL(config.server);
  target.pathname = `${target.pathname.replace(/\/$/, '')}${pathname}`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const response = await fetch(target, { method, headers: { Authorization: authorization, ...extraHeaders }, body: payload });
  const responseBody = await response.text();
  if (!response.ok && response.status !== 207) throw new Error(`CalDAV ${method} 실패 (${response.status})`);
  return { status: response.status, headers: response.headers, body: responseBody };
}

async function syncFromCalDav(user, force = false) {
  if (!usesCalDav(user)) return;
  if (clientSyncUsers.has(user.id)) return;
  if (db.syncQueue.some(item => item.userId === user.id)) {
    try { await flushCalDavQueue(user); } catch { return; }
    if (db.syncQueue.some(item => item.userId === user.id)) return;
  }
  if (!force && Date.now() - (caldavLastSync.get(user.id) || 0) < 15000) return;
  if (caldavSyncPromises.has(user.id)) return caldavSyncPromises.get(user.id);
  const syncPromise = (async () => {
    const config = calDavConfig(user);
    const home = `/${encodeURIComponent(config.username)}/`;
    const propfind = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><d:sync-token/><c:supported-calendar-component-set/><i:calendar-color/></d:prop></d:propfind>`;
    const discovery = await directDav(user, home, 'PROPFIND', propfind, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' });
    const collections = davResponses(discovery.body).map(block => ({ href: xmlTag(block, 'href'), name: xmlTag(block, 'displayname'), color: xmlTag(block, 'calendar-color'), components: xmlTag(block, 'supported-calendar-component-set') || block })).filter(item => item.href !== home && /VTODO/i.test(item.components));
    const lists = []; const tasks = [];
    for (const collection of collections) {
      const listId = stableId('list_dav', collection.href);
      const existingList = db.lists.find(list => list.userId === user.id && list.caldavHref === collection.href);
      lists.push({ id: listId, userId: user.id, name: unicodeText(collection.name || collection.href.split('/').filter(Boolean).at(-1)), color: /^#[0-9a-f]{6}/i.test(collection.color) ? collection.color.slice(0, 7) : '#a6c4d9', isDefault: false, createdAt: existingList?.createdAt || new Date().toISOString(), version: (existingList?.version || 0) + 1, caldavHref: collection.href });
      const query = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`;
      const result = await directDav(user, collection.href, 'REPORT', query, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' });
      for (const block of davResponses(result.body)) {
        const href = xmlTag(block, 'href'); const raw = xmlTag(block, 'calendar-data'); if (!raw) continue;
        const status = icsProperty(raw, 'STATUS').toUpperCase(); const percent = Number(icsProperty(raw, 'PERCENT-COMPLETE') || 0);
        const existing = db.tasks.find(task => task.userId === user.id && task.caldavHref === href);
        tasks.push({ id: stableId('task_dav', href), userId: user.id, createdByUserId: existing?.createdByUserId || user.id, sharedWithUserIds: existing?.sharedWithUserIds || [], listId, title: unicodeText(icsProperty(raw, 'SUMMARY') || '(제목 없음)'), notes: unicodeText(icsProperty(raw, 'DESCRIPTION')), due: icsDate(icsProperty(raw, 'DUE')), priority: priorityFromIcs(icsProperty(raw, 'PRIORITY')), tags: icsProperty(raw, 'CATEGORIES').split(',').map(tag => unicodeText(tag).trim()).filter(Boolean), recurrence: recurrenceFromIcs(raw), completed: status === 'COMPLETED' || Boolean(icsProperty(raw, 'COMPLETED')) || percent === 100, createdAt: existing?.createdAt || icsTimestamp(icsProperty(raw, 'CREATED')), updatedAt: icsTimestamp(icsProperty(raw, 'LAST-MODIFIED') || icsProperty(raw, 'DTSTAMP')), version: (existing?.version || 0) + 1, caldavHref: href, caldavEtag: xmlTag(block, 'getetag'), caldavRaw: raw });
      }
    }
    const defaultList = lists.find(list => list.name === '수집') || lists[0]; if (defaultList) defaultList.isDefault = true;
    db.lists = [...db.lists.filter(list => list.userId !== user.id), ...lists];
    db.tasks = [...db.tasks.filter(task => task.userId !== user.id), ...tasks];
    const settings = db.settings.find(item => item.userId === user.id); if (settings && defaultList && !lists.some(list => list.id === settings.defaultListId)) settings.defaultListId = defaultList.id;
    caldavLastSync.set(user.id, Date.now()); save();
  })().finally(() => { caldavSyncPromises.delete(user.id); });
  caldavSyncPromises.set(user.id, syncPromise);
  return syncPromise;
}

async function putTaskToCalDav(user, task, list, creating = false) {
  if (!task.caldavHref) task.caldavHref = `${list.caldavHref}${encodeURIComponent(task.id)}.ics`;
  const raw = updateTaskIcs(task);
  const result = await directDav(user, task.caldavHref, 'PUT', raw, { 'Content-Type': 'text/calendar; charset=utf-8', [creating ? 'If-None-Match' : 'If-Match']: creating ? '*' : (task.caldavEtag || '*') });
  task.caldavRaw = raw; task.caldavEtag = result.headers.get('etag') || task.caldavEtag; caldavLastSync.set(user.id, 0);
}

async function createCalDavList(user, name, color) {
  const href = `/${encodeURIComponent(calDavConfig(user).username)}/${crypto.randomUUID()}/`;
  const body = `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>${xmlEscape(name)}</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><i:calendar-color>${xmlEscape(color)}FF</i:calendar-color></d:prop></d:set></c:mkcalendar>`;
  await directDav(user, href, 'MKCALENDAR', body, { 'Content-Type': 'application/xml; charset=utf-8' }); return href;
}

async function flushCalDavQueue(user) {
  if (!usesCalDav(user)) return;
  for (const operation of db.syncQueue.filter(item => item.userId === user.id)) {
    try {
      if (operation.type === 'delete-task') await directDav(user, operation.href, 'DELETE', undefined, operation.etag ? { 'If-Match': operation.etag } : {});
      if (operation.type === 'delete-list') await directDav(user, operation.href, 'DELETE');
      if (operation.type === 'create-list') {
        const list = db.lists.find(item => item.id === operation.listId && item.userId === user.id);
        if (list) list.caldavHref = await createCalDavList(user, list.name, list.color);
      }
      db.syncQueue = db.syncQueue.filter(item => item.id !== operation.id); save();
    } catch (error) {
      if (/\(404\)/.test(error.message)) { db.syncQueue = db.syncQueue.filter(item => item.id !== operation.id); save(); continue; }
      operation.lastError = error.message; operation.updatedAt = new Date().toISOString(); save(); throw error;
    }
  }
}

async function resetUserData(user) {
  if (caldavSyncPromises.has(user.id)) await caldavSyncPromises.get(user.id);
  if (usesCalDav(user)) await syncFromCalDav(user, true);
  const lists = db.lists.filter(list => list.userId === user.id);
  const tasks = db.tasks.filter(task => task.userId === user.id);
  const ownedListIds = new Set(lists.map(list => list.id));
  const now = new Date().toISOString();
  const listId = uid('list');
  const inbox = { id: listId, userId: user.id, name: '수집', color: '#a6c4d9', isDefault: true, createdAt: now, version: 1 };
  if (usesCalDav(user)) {
    const operations = [
      ...tasks.filter(task => task.caldavHref).map(task => ({ id: uid('sync'), userId: user.id, type: 'delete-task', href: task.caldavHref, etag: task.caldavEtag, createdAt: now })),
      ...lists.filter(list => list.caldavHref).map(list => ({ id: uid('sync'), userId: user.id, type: 'delete-list', href: list.caldavHref, createdAt: now })),
      { id: uid('sync'), userId: user.id, type: 'create-list', listId, createdAt: now }
    ];
    db.syncQueue.push(...operations);
  }
  db.tasks = db.tasks.filter(task => task.userId !== user.id);
  db.lists = [...db.lists.filter(list => list.userId !== user.id), inbox];
  db.collaborations = db.collaborations.filter(item => !ownedListIds.has(item.listId));
  db.notificationStates = db.notificationStates.filter(item => item.userId !== user.id);
  const settings = db.settings.find(item => item.userId === user.id);
  if (settings) { settings.defaultListId = listId; settings.manualTaskOrder = []; settings.version += 1; }
  else db.settings.push({ userId: user.id, defaultListId: listId, defaultDue: 'none', defaultPriority: 'none', syncServer: '', syncUsername: '', syncStatus: 'setup', mcpEnabled: false, theme: 'system', listMarker: '*', priorityMarker: '!', tagMarker: '#', sortBy: 'createdAt', sortDirection: 'desc', autoDeleteCompleted: 'none', manualTaskOrder: [], version: 1 });
  caldavLastSync.set(user.id, Date.now()); save();
  if (usesCalDav(user)) try { await flushCalDavQueue(user); } catch {}
  return { lists: [inbox], tasks: [], settings: settingsView(db.settings.find(item => item.userId === user.id), user), syncPending: db.syncQueue.some(item => item.userId === user.id) };
}

async function shortcutApi(req, res, url) {
  const isSnapshot = url.pathname === '/api/shortcuts/snapshot' && req.method === 'GET';
  const isCreate = url.pathname === '/api/shortcuts/tasks' && req.method === 'POST';
  if (!isSnapshot && !isCreate) return json(res, 404, { error: '단축어 API 경로를 찾을 수 없습니다.' });
  const auth = shortcutUser(req, isSnapshot ? 'read' : 'write');
  if (!auth.user) return json(res, auth.status, { error: auth.error }, { 'WWW-Authenticate': 'Bearer realm="Haru Shortcuts"' });
  const { user } = auth;
  if (isSnapshot) {
    return json(res, 200, {
      metadata: { instance: hostDomain(req), username: user.username, generatedAt: new Date().toISOString(), appVersion: APP_VERSION },
      ...syncSnapshot(user, req)
    });
  }
  if (user.role === 'guest') return json(res, 403, { error: 'guest 계정은 태스크를 등록할 수 없습니다.' });
  const payload = await body(req);
  const rawTaskId = unicodeText(req.headers['x-haru-task-id']).trim();
  const taskId = rawTaskId && rawTaskId.toLowerCase() !== 'null' ? rawTaskId : null;
  if (taskId && !/^task_[A-Za-z0-9_-]+$/.test(taskId)) return json(res, 400, { error: 'X-Haru-Task-Id 헤더가 올바르지 않습니다.' });
  if (!taskId && (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 500)) return json(res, 400, { error: '1~500자의 태스크 제목이 필요합니다.' });
  if (taskId && typeof payload.title === 'string' && payload.title.length > 500) return json(res, 400, { error: '태스크 제목은 500자 이하여야 합니다.' });
  if (payload.priority && !['none', 'low', 'medium', 'high'].includes(payload.priority)) return json(res, 400, { error: '우선도는 none, low, medium, high 중 하나여야 합니다.' });
  if (payload.list && !payload.listId) {
    const requested = unicodeText(payload.list).trim().toLocaleLowerCase();
    const matched = accessibleLists(user).sort((a, b) => Number(a.shared) - Number(b.shared)).find(item => item.name.toLocaleLowerCase() === requested);
    if (!matched) return json(res, 409, { code: 'LIST_NOT_FOUND', listName: unicodeText(payload.list).trim() });
    payload.listId = matched.id;
  }
  if (taskId) {
    const result = await updateTask(user, taskId, payload);
    if (result.error) return json(res, result.status, { error: result.error });
    publishChange();
    return json(res, 200, { task: taskView(result.task, user), nextTask: result.nextTask ? taskView(result.nextTask, user) : null });
  }
  const result = await addTask(user, { ...payload, dueDecision: payload.dueDecision || 'accept' }, 'ai');
  if (result.missingList) return json(res, 409, { code: 'LIST_NOT_FOUND', listName: result.missingList });
  if (result.dueConfirmation) return json(res, 409, { code: 'DUE_CONFIRM_REQUIRED', ...result.dueConfirmation });
  if (result.error) return json(res, 400, { error: result.error });
  publishChange();
  return json(res, 201, { ...result, task: taskView(result.task, user) });
}

async function api(req, res, url) {
  if (url.pathname === '/api/version' && req.method === 'GET') return json(res, 200, { version: APP_VERSION });
  if (url.pathname.startsWith('/api/shortcuts/')) return shortcutApi(req, res, url);
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const payload = await body(req);
    const username = unicodeText(payload.username).trim().toLowerCase();
    const domain = hostDomain(req);
    const user = db.users.find(u => u.username.toLowerCase() === username && (u.domain === domain || (u.domain === 'localhost' && ['127.0.0.1', 'localhost'].includes(domain))));
    if (!user || !verifyPassword(String(payload.password || ''), user.passwordHash)) return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 30 * 86400000;
    db.sessions = db.sessions.filter(item => item.expiresAt > Date.now());
    const now = new Date().toISOString();
    db.sessions.push({ tokenHash: sessionHash(token), userId: user.id, expiresAt, createdAt: now, lastSeenAt: now });
    save();
    return json(res, 200, { user: userView(user, domain) }, { 'Set-Cookie': sessionCookie(req, token, 30 * 86400) });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).session;
    if (token) { const hash = sessionHash(token); db.sessions = db.sessions.filter(item => item.tokenHash !== hash); save(); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  const user = currentUser(req, res);
  if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
  if (user.mustChangePassword && !['/api/bootstrap', '/api/events', '/api/account/password'].includes(url.pathname)) return json(res, 428, { error: '임시 비밀번호를 먼저 변경해 주세요.', code: 'PASSWORD_CHANGE_REQUIRED' });
  if (url.pathname === '/api/events' && req.method === 'GET') return openEventStream(req, res, user);
  const guestAllowedMutation = url.pathname === '/api/account/password' || url.pathname.startsWith('/api/notifications') || /^\/api\/collaborations\/[^/]+(?:\/respond)?$/.test(url.pathname);
  if (user.role === 'guest' && !guestAllowedMutation && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return json(res, 403, { error: 'guest 계정은 읽기 전용입니다.' });
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const payload = await body(req);
    const incoming = Array.isArray(payload.mutations) ? payload.mutations.slice(0, 1000) : [];
    const mutations = incoming.filter(item => item && typeof item.id === 'string' && typeof item.type === 'string').map((item, index) => ({ ...item, index }));
    if (caldavSyncPromises.has(user.id)) await caldavSyncPromises.get(user.id);
    clientSyncUsers.add(user.id);
    let processed;
    try { processed = await processClientMutations(user, mutations); }
    finally { clientSyncUsers.delete(user.id); }
    purgeCompletedTasksForUser(user);
    const caldavError = await syncClientChangesToCalDav(user, processed.changedTaskIds, processed.createdListIds);
    if (processed.results.some(item => item.status === 'applied')) publishChange();
    return json(res, 200, { ...syncSnapshot(user, req), results: processed.results, caldavError });
  }
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자만 계정 목록을 볼 수 있습니다.' });
    return json(res, 200, { users: db.users.filter(item => item.domain === user.domain).map(item => userView(item, hostDomain(req))) });
  }
  if (url.pathname === '/api/shortcut-tokens' && req.method === 'GET') {
    return json(res, 200, { tokens: db.shortcutTokens.filter(token => token.userId === user.id).map(shortcutTokenView) });
  }
  if (url.pathname === '/api/shortcut-tokens' && req.method === 'POST') {
    const payload = await body(req); const name = unicodeText(payload.name).trim(); const scope = String(payload.scope || '');
    const settings = db.settings.find(item => item.userId === user.id);
    if (!settings?.mcpEnabled) return json(res, 409, { error: '외부 도구 연결을 먼저 활성화하고 설정을 저장해 주세요.' });
    if (!name || name.length > 40) return json(res, 400, { error: '토큰 이름은 1~40자로 입력해 주세요.' });
    if (!SHORTCUT_TOKEN_SCOPES.has(scope)) return json(res, 400, { error: '토큰 권한은 read 또는 write여야 합니다.' });
    if (scope === 'write' && user.role === 'guest') return json(res, 403, { error: 'guest 계정은 쓰기 토큰을 만들 수 없습니다.' });
    if (db.shortcutTokens.filter(token => token.userId === user.id).length >= 10) return json(res, 409, { error: '활성 단축어 토큰은 최대 10개까지 만들 수 있습니다.' });
    const rawToken = `haru_sc_${crypto.randomBytes(32).toString('base64url')}`;
    const token = { id: uid('shortcut'), userId: user.id, name, scope, tokenHash: shortcutTokenHash(rawToken), hint: `${rawToken.slice(0, 12)}…${rawToken.slice(-4)}`, createdAt: new Date().toISOString(), lastUsedAt: null };
    db.shortcutTokens.push(token); save();
    return json(res, 201, { token: shortcutTokenView(token), value: rawToken });
  }
  const shortcutTokenMatch = url.pathname.match(/^\/api\/shortcut-tokens\/([^/]+)$/);
  if (shortcutTokenMatch && req.method === 'DELETE') {
    const before = db.shortcutTokens.length;
    db.shortcutTokens = db.shortcutTokens.filter(token => !(token.id === shortcutTokenMatch[1] && token.userId === user.id));
    if (db.shortcutTokens.length === before) return json(res, 404, { error: '단축어 토큰을 찾을 수 없습니다.' });
    save(); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/users' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자만 사용자를 만들 수 있습니다.' });
    const payload = await body(req);
    const username = unicodeText(payload.username).trim().toLowerCase();
    const requestedRole = String(payload.role || 'user');
    const generatedPassword = temporaryPassword();
    const password = String(payload.password || generatedPassword);
    const domain = user.domain;
    if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) return json(res, 400, { error: '사용자명은 2~40자의 문자, 숫자, 점, 밑줄 또는 하이픈이어야 합니다.' });
    if (!(requestedRole in ROLE_RANK) || ROLE_RANK[requestedRole] > ROLE_RANK[user.role]) return json(res, 400, { error: '자신의 권한보다 높은 등급을 부여할 수 없습니다.' });
    if (password.length < 8) return json(res, 400, { error: '비밀번호는 8자 이상이어야 합니다.' });
    if (db.users.some(item => item.domain === domain && item.username.toLowerCase() === username)) return json(res, 409, { error: '이미 존재하는 사용자입니다.' });
    const now = new Date().toISOString(); const userId = uid('usr'); const listId = uid('list');
    const created = { id: userId, username, domain, passwordHash: hashPassword(password), role: requestedRole, mustChangePassword: true, createdAt: now };
    db.users.push(created);
    db.lists.push({ id: listId, userId, name: '수집', color: '#a6c4d9', isDefault: true, createdAt: now, version: 1 });
    db.settings.push({ userId, defaultListId: listId, defaultDue: 'none', defaultPriority: 'none', syncServer: '', syncUsername: '', syncStatus: 'setup', mcpEnabled: false, theme: 'system', listMarker: '*', priorityMarker: '!', tagMarker: '#', sortBy: 'createdAt', sortDirection: 'desc', autoDeleteCompleted: 'none', manualTaskOrder: [], version: 1 });
    save(); publishChange(); return json(res, 201, { user: userView(created, hostDomain(req)), temporaryPassword: password });
  }
  const userRoleMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/role$/);
  if (userRoleMatch && req.method === 'PATCH') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자만 권한을 변경할 수 있습니다.' });
    const target = db.users.find(item => item.id === userRoleMatch[1] && item.domain === user.domain);
    if (!target) return json(res, 404, { error: '계정을 찾을 수 없습니다.' });
    if (target.role === 'admin') return json(res, 409, { error: 'admin 권한은 본인만 포기할 수 있습니다.' });
    const payload = await body(req); const role = String(payload.role || '');
    if (!(role in ROLE_RANK) || ROLE_RANK[role] > ROLE_RANK[user.role]) return json(res, 400, { error: '자신의 권한보다 높은 등급을 부여할 수 없습니다.' });
    target.role = role; save(); publishChange(); return json(res, 200, { user: userView(target) });
  }
  const userDeleteMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userDeleteMatch && req.method === 'DELETE') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자만 계정을 삭제할 수 있습니다.' });
    const target = db.users.find(item => item.id === userDeleteMatch[1] && item.domain === user.domain);
    if (!target) return json(res, 404, { error: '계정을 찾을 수 없습니다.' });
    if (target.role === 'admin') return json(res, 409, { error: 'admin 계정은 본인이 권한을 포기하기 전에는 삭제할 수 없습니다.' });
    const targetListIds = new Set(db.lists.filter(item => item.userId === target.id).map(item => item.id));
    db.users = db.users.filter(item => item.id !== target.id); db.lists = db.lists.filter(item => item.userId !== target.id); db.tasks = db.tasks.filter(item => item.userId !== target.id).map(task => ({ ...task, sharedWithUserIds: task.sharedWithUserIds.filter(id => id !== target.id) })); db.settings = db.settings.filter(item => item.userId !== target.id); db.syncQueue = db.syncQueue.filter(item => item.userId !== target.id); db.collaborations = db.collaborations.filter(item => item.inviteeUserId !== target.id && !targetListIds.has(item.listId)); db.notificationStates = db.notificationStates.filter(item => item.userId !== target.id);
    db.sessions = db.sessions.filter(session => session.userId !== target.id);
    revokeShortcutTokens(target.id);
    save(); publishChange(); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/account/relinquish-admin' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, 400, { error: '현재 계정은 admin이 아닙니다.' });
    const payload = await body(req); const nextRole = String(payload.role || 'user');
    if (!verifyPassword(String(payload.password || ''), user.passwordHash)) return json(res, 403, { error: '현재 비밀번호가 올바르지 않습니다.' });
    if (!['user', 'guest'].includes(nextRole)) return json(res, 400, { error: '포기 후 권한은 user 또는 guest여야 합니다.' });
    const admins = db.users.filter(item => item.domain === user.domain && item.role === 'admin');
    if (admins.length < 2) return json(res, 409, { error: '마지막 admin은 권한을 포기할 수 없습니다. 다른 admin을 먼저 지정하세요.' });
    user.role = nextRole; save(); publishChange(); return json(res, 200, { user: userView(user, hostDomain(req)) });
  }
  if (url.pathname === '/api/account/password' && req.method === 'PATCH') {
    const payload = await body(req); const currentPassword = String(payload.currentPassword || ''); const newPassword = String(payload.newPassword || '');
    if (!verifyPassword(currentPassword, user.passwordHash)) return json(res, 403, { error: '현재 비밀번호가 올바르지 않습니다.' });
    if (newPassword.length < 8) return json(res, 400, { error: '새 비밀번호는 8자 이상이어야 합니다.' });
    if (currentPassword === newPassword) return json(res, 400, { error: '새 비밀번호가 현재 비밀번호와 같습니다.' });
    user.passwordHash = hashPassword(newPassword); user.mustChangePassword = false; save();
    const currentTokenHash = sessionHash(parseCookies(req).session);
    db.sessions = db.sessions.filter(session => session.userId !== user.id || session.tokenHash === currentTokenHash);
    save();
    publishChange();
    return json(res, 200, { ok: true, user: userView(user, hostDomain(req)) });
  }
  if (url.pathname === '/api/notifications' && req.method === 'GET') {
    return json(res, 200, { notifications: notificationsFor(user), unreadCount: notificationCount(user) });
  }
  if (url.pathname === '/api/notifications/read-all' && req.method === 'POST') {
    const now = new Date().toISOString();
    for (const notification of notificationsFor(user)) updateNotificationState(user, notification.id, { readAt: now });
    save(); publishChange(); return json(res, 200, { ok: true, unreadCount: 0 });
  }
  if (url.pathname === '/api/notifications' && req.method === 'DELETE') {
    const now = new Date().toISOString();
    for (const notification of rawNotificationsFor(user)) updateNotificationState(user, notification.id, { readAt: now, removedAt: now });
    save(); publishChange(); return json(res, 200, { ok: true, unreadCount: 0 });
  }
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (notificationMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    const notificationId = decodeURIComponent(notificationMatch[1]);
    if (!rawNotificationsFor(user).some(item => item.id === notificationId)) return json(res, 404, { error: '알림을 찾을 수 없습니다.' });
    const now = new Date().toISOString();
    updateNotificationState(user, notificationId, req.method === 'DELETE' ? { readAt: now, removedAt: now } : { readAt: now });
    save(); publishChange(); return json(res, 200, { ok: true, unreadCount: notificationCount(user) });
  }
  if (url.pathname === '/api/collaborations' && req.method === 'GET') {
    const collaborations = db.collaborations.filter(item => item.status === 'approved' && (item.ownerUserId === user.id || item.inviteeUserId === user.id)).map(collaborationView);
    return json(res, 200, { collaborations });
  }
  const collaborationRespondMatch = url.pathname.match(/^\/api\/collaborations\/([^/]+)\/respond$/);
  if (collaborationRespondMatch && req.method === 'POST') {
    const collaboration = db.collaborations.find(item => item.id === collaborationRespondMatch[1] && item.inviteeUserId === user.id);
    if (!collaboration) return json(res, 404, { error: '협업 요청을 찾을 수 없습니다.' });
    if (collaboration.status !== 'pending') return json(res, 409, { error: '이미 처리한 협업 요청입니다.' });
    const payload = await body(req); const decision = String(payload.decision || '');
    if (!['approved', 'rejected'].includes(decision)) return json(res, 400, { error: '승인 또는 거절을 선택하세요.' });
    collaboration.status = decision; collaboration.updatedAt = new Date().toISOString(); save(); publishChange();
    return json(res, 200, { collaboration: collaborationView(collaboration) });
  }
  const collaborationDeleteMatch = url.pathname.match(/^\/api\/collaborations\/([^/]+)$/);
  if (collaborationDeleteMatch && req.method === 'DELETE') {
    const collaboration = db.collaborations.find(item => item.id === collaborationDeleteMatch[1]);
    if (!collaboration || ![collaboration.ownerUserId, collaboration.inviteeUserId].includes(user.id)) return json(res, 404, { error: '협업 권한을 찾을 수 없습니다.' });
    db.collaborations = db.collaborations.filter(item => item.id !== collaboration.id); save(); publishChange();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/account/import' && req.method === 'POST') {
    try {
      const result = await importAccountData(user, await body(req, 10_000_000));
      publishChange();
      return json(res, 200, { ok: true, ...syncSnapshot(user, req), ...result });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || '데이터를 가져오지 못했습니다.' });
    }
  }
  if (url.pathname === '/api/account/data' && req.method === 'DELETE') {
    const payload = await body(req);
    if (!verifyPassword(String(payload.password || ''), user.passwordHash)) return json(res, 403, { error: '현재 비밀번호가 올바르지 않습니다.' });
    if (unicodeText(payload.confirmation).trim() !== '초기화') return json(res, 400, { error: '확인란에 초기화를 정확히 입력해 주세요.' });
    const snapshot = await resetUserData(user);
    publishChange();
    return json(res, 200, { ok: true, ...snapshot });
  }
  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    await syncFromCalDav(user);
    await runCompletedTaskCleanup(user);
    return json(res, 200, syncSnapshot(user, req));
  }
  if (url.pathname === '/api/lists' && req.method === 'POST') {
    const payload = await body(req); const name = unicodeText(payload.name).trim();
    if (!name) return json(res, 400, { error: '리스트 이름을 입력하세요.' });
    if (db.lists.some(l => l.userId === user.id && l.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: '같은 이름의 리스트가 있습니다.' });
    const color = payload.color || '#a6c4d9';
    const caldavHref = usesCalDav(user) ? await createCalDavList(user, name, color) : undefined;
    const list = { id: uid('list'), userId: user.id, name, color, isDefault: false, createdAt: new Date().toISOString(), version: 1, ...(caldavHref ? { caldavHref } : {}) };
    db.lists.push(list); save(); publishChange(); return json(res, 201, { list });
  }
  const listDeleteMatch = url.pathname.match(/^\/api\/lists\/([^/]+)$/);
  if (listDeleteMatch && req.method === 'DELETE') {
    const list = db.lists.find(item => item.id === listDeleteMatch[1] && item.userId === user.id);
    if (!list) return json(res, 404, { error: '삭제할 수 있는 리스트를 찾지 못했습니다.' });
    const payload = await body(req);
    if (unicodeText(payload.confirmation).trim() !== list.name) return json(res, 400, { error: `확인란에 '${list.name}'을 정확히 입력해 주세요.` });
    const deletedTaskCount = db.tasks.filter(task => task.listId === list.id).length;
    const now = new Date().toISOString();
    if (usesCalDav(user) && list.caldavHref) db.syncQueue.push({ id: uid('sync'), userId: user.id, type: 'delete-list', href: list.caldavHref, createdAt: now });
    db.tasks = db.tasks.filter(task => task.listId !== list.id);
    db.lists = db.lists.filter(item => item.id !== list.id);
    db.collaborations = db.collaborations.filter(item => item.listId !== list.id);
    const settings = db.settings.find(item => item.userId === user.id);
    for (const userSettings of db.settings) userSettings.manualTaskOrder = userSettings.manualTaskOrder.filter(id => db.tasks.some(task => task.id === id));
    let replacement = db.lists.find(item => item.userId === user.id);
    if (!replacement) {
      replacement = { id: uid('list'), userId: user.id, name: '수집', color: '#a6c4d9', isDefault: true, createdAt: now, version: 1 };
      db.lists.push(replacement);
      if (usesCalDav(user)) db.syncQueue.push({ id: uid('sync'), userId: user.id, type: 'create-list', listId: replacement.id, createdAt: now });
    }
    if (settings?.defaultListId === list.id || list.isDefault) {
      for (const item of db.lists.filter(item => item.userId === user.id)) item.isDefault = item.id === replacement.id;
      if (settings) settings.defaultListId = replacement.id;
    }
    caldavLastSync.set(user.id, Date.now()); save();
    if (usesCalDav(user)) try { await flushCalDavQueue(user); } catch {}
    publishChange();
    return json(res, 200, { ok: true, deletedTaskCount, lists: accessibleLists(user), tasks: accessibleTasks(user), settings: settingsView(settings, user), syncPending: db.syncQueue.some(item => item.userId === user.id) });
  }
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const result = await addTask(user, await body(req));
    if (result.missingList) return json(res, 409, { code: 'LIST_NOT_FOUND', listName: result.missingList });
    if (result.dueConfirmation) return json(res, 409, { code: 'DUE_CONFIRM_REQUIRED', ...result.dueConfirmation });
    if (result.error) return json(res, 400, { error: result.error });
    publishChange();
    return json(res, 201, { ...result, task: taskView(result.task, user) });
  }
  if (url.pathname === '/api/tasks/order' && req.method === 'PUT') {
    const payload = await body(req);
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.map(String) : [];
    if (!taskIds.length || taskIds.length > 5000 || new Set(taskIds).size !== taskIds.length) return json(res, 400, { error: '올바른 태스크 정렬 순서가 필요합니다.' });
    const accessibleIds = new Set(accessibleTasks(user).map(task => task.id));
    if (taskIds.some(id => !accessibleIds.has(id))) return json(res, 403, { error: '접근할 수 없는 태스크는 정렬할 수 없습니다.' });
    const settings = db.settings.find(item => item.userId === user.id);
    const submitted = new Set(taskIds);
    const remaining = settings.manualTaskOrder.filter(id => accessibleIds.has(id) && !submitted.has(id));
    settings.manualTaskOrder = [...taskIds, ...remaining];
    settings.version = (settings.version || 1) + 1;
    save(); publishChange(); return json(res, 200, { settings: settingsView(settings, user) });
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const result = await updateTask(user, taskMatch[1], await body(req));
    if (result.error) return json(res, result.status, { error: result.error });
    publishChange();
    return json(res, 200, { task: taskView(result.task, user), nextTask: result.nextTask ? taskView(result.nextTask, user) : null });
  }
  if (taskMatch && req.method === 'DELETE') {
    const task = db.tasks.find(t => t.id === taskMatch[1] && canAccessTask(user, t));
    const listOwner = task && db.users.find(candidate => candidate.id === db.lists.find(list => list.id === task.listId)?.userId);
    if (listOwner && usesCalDav(listOwner) && task?.caldavHref) await directDav(listOwner, task.caldavHref, 'DELETE', undefined, task.caldavEtag ? { 'If-Match': task.caldavEtag } : {});
    const before = db.tasks.length;
    db.tasks = db.tasks.filter(t => t !== task);
    if (before === db.tasks.length) return json(res, 404, { error: '태스크를 찾을 수 없습니다.' });
    for (const settings of db.settings) settings.manualTaskOrder = settings.manualTaskOrder.filter(id => id !== task.id);
    save(); publishChange(); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/caldav/sync' && req.method === 'POST') {
    const payload = await body(req);
    const settings = db.settings.find(item => item.userId === user.id);
    const server = normalizeCalDavServer(payload.server);
    const username = unicodeText(payload.username).trim();
    const suppliedPassword = String(payload.password || '');
    const existingPassword = decryptCredential(settings.syncPasswordEncrypted) || (user.username === CALDAV_APP_USER ? CALDAV_PASSWORD : '');
    if (!username || (!suppliedPassword && !existingPassword)) return json(res, 400, { error: 'CalDAV ID와 비밀번호를 모두 입력해 주세요.' });
    settings.syncServer = server;
    settings.syncUsername = username;
    if (suppliedPassword) settings.syncPasswordEncrypted = encryptCredential(suppliedPassword);
    settings.syncStatus = 'syncing';
    settings.syncLastError = '';
    settings.version = (settings.version || 1) + 1;
    save();
    try {
      caldavLastSync.set(user.id, 0);
      await syncFromCalDav(user, true);
      settings.syncStatus = 'ready';
      settings.syncLastAt = new Date().toISOString();
      settings.syncLastError = '';
      save(); publishChange();
      return json(res, 200, syncSnapshot(user, req));
    } catch (error) {
      settings.syncStatus = 'error';
      settings.syncLastError = String(error.message || 'CalDAV 연결에 실패했습니다.').slice(0, 300);
      save(); publishChange();
      return json(res, 502, { error: settings.syncLastError, settings: settingsView(settings, user) });
    }
  }
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    const payload = await body(req); let settings = db.settings.find(s => s.userId === user.id);
    if (payload.theme && !['system', 'light', 'dark'].includes(payload.theme)) return json(res, 400, { error: '올바르지 않은 테마 설정입니다.' });
    if (payload.sortBy && !['manual', 'createdAt', 'due', 'priority', 'remaining'].includes(payload.sortBy)) return json(res, 400, { error: '올바르지 않은 정렬 기준입니다.' });
    if (payload.sortDirection && !['asc', 'desc'].includes(payload.sortDirection)) return json(res, 400, { error: '올바르지 않은 정렬 방향입니다.' });
    if (payload.autoDeleteCompleted && !AUTO_DELETE_COMPLETED_VALUES.includes(payload.autoDeleteCompleted)) return json(res, 400, { error: '올바르지 않은 완료 태스크 자동 삭제 설정입니다.' });
    if ('mcpEnabled' in payload && typeof payload.mcpEnabled !== 'boolean') return json(res, 400, { error: '외부 도구 사용 설정은 참 또는 거짓이어야 합니다.' });
    const markerValues = [payload.listMarker ?? settings.listMarker, payload.priorityMarker ?? settings.priorityMarker, payload.tagMarker ?? settings.tagMarker];
    if (markerValues.some(marker => typeof marker !== 'string' || marker.length !== 1 || !MARKER_CHOICES.includes(marker))) return json(res, 400, { error: `마커는 ${MARKER_CHOICES} 중에서 선택해야 합니다.` });
    if (new Set(markerValues).size !== markerValues.length) return json(res, 400, { error: '리스트·우선도·태그 마커는 서로 달라야 합니다.' });
    const changes = Object.fromEntries(SETTING_KEYS.filter(key => key in payload).map(key => [key, payload[key]]));
    if (changes.mcpEnabled === false) revokeShortcutTokens(user.id);
    Object.assign(settings, changes, { userId: user.id, version: (settings.version || 1) + 1 }); save();
    await runCompletedTaskCleanup(user); publishChange(); return json(res, 200, { settings: settingsView(settings, user) });
  }
  return json(res, 404, { error: 'API 경로를 찾을 수 없습니다.' });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, requested));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (BASE_PATH && url.pathname === BASE_PATH) {
      res.writeHead(308, { Location: `${BASE_PATH}/${url.search}` }); return res.end();
    }
    if (BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) {
      return json(res, 404, { error: '이 애플리케이션 경로가 아닙니다.' });
    }
    url.pathname = url.pathname.slice(BASE_PATH.length) || '/';
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if ((url.pathname === '/caldav' || url.pathname.startsWith('/caldav/')) && CALDAV_UPSTREAM) {
      return await proxyCalDav(req, res, url);
    }
    if (url.pathname.startsWith('/caldav/tasks/') && req.method === 'GET') {
      const user = currentUser(req, res); if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
      const task = db.tasks.find(t => t.id === path.basename(url.pathname, '.ics') && canAccessTask(user, t));
      if (!task) return json(res, 404, { error: '태스크를 찾을 수 없습니다.' });
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: `"${task.updatedAt}"` }); return res.end(taskToIcs(task));
    }
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error); return json(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Haru running at http://${HOST}:${PORT}${BASE_PATH || '/'}`);
  if (generatedInitialAdminPassword) console.log(`Initial admin password (shown once): ${generatedInitialAdminPassword}`);
  Promise.all(db.users.map(user => runCompletedTaskCleanup(user))).catch(error => console.error('Completed task cleanup failed:', error));
});
setInterval(() => {
  Promise.all(db.users.map(user => runCompletedTaskCleanup(user))).catch(error => console.error('Completed task cleanup failed:', error));
}, 60 * 60 * 1000).unref();
