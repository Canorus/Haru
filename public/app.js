const $ = s => document.querySelector(s);
const BASE_PATH = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
const CLIENT_VERSION = 'haru-offline-v12';
const SERVER_KEY = `${location.origin}${BASE_PATH}`;
const LAST_USER_KEY = `haru-last-user:${SERVER_KEY}`;
const state = { user: null, lists: [], tasks: [], settings: null, shortcutTokens: [], notificationCount: 0, filter: 'all', pendingTask: null, pendingDueTask: null, pendingDeleteListId: null };
let realtimeSource = null;
let snapshotRefresh = null;
let realtimeRefreshTimer = null;
let offlineRecord = null;
let syncPromise = null;
let forcingUpdate = false;
let lastSyncFailure = '';
let settingsDirty = false;
const STORED_PASSWORD = '••••••••';
const MARKER_CHOICES = [...'~!#$%^&*'];
const localYmd = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = localYmd(new Date());
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme = 'system') {
  localStorage.setItem('haru-theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && themeMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#182228' : '#f3f0e7';
}
async function forceAppUpdate(version) {
  if (forcingUpdate) return;
  forcingUpdate = true;
  try {
    const registration = await navigator.serviceWorker?.getRegistration('./');
    await registration?.update();
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    if ('caches' in window) await Promise.all((await caches.keys()).map(key => caches.delete(key)));
  } finally {
    const url = new URL(location.href); url.searchParams.set('haru-version', version || Date.now()); location.replace(url);
  }
}
const api = async (path, options = {}) => {
  const response = await fetch(`${BASE_PATH}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const serverVersion = response.headers.get('X-Haru-Version');
  if (serverVersion && serverVersion !== CLIENT_VERSION) { forceAppUpdate(serverVersion); throw Object.assign(new Error('새 버전으로 업데이트합니다.'), { updating: true }); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), { status: response.status, data });
  return data;
};
let toastTimer;
const toast = (message, kind = 'info', duration = 2200) => { const el = $('#toast'); clearTimeout(toastTimer); el.textContent = message; el.className = `toast ${kind} show`; toastTimer = setTimeout(() => el.classList.remove('show'), duration); };
const uuid = prefix => `${prefix}_${crypto.randomUUID()}`;
const accountKey = userId => `${SERVER_KEY}::${userId}`;
function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('haru-offline-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function accountStore(mode, action) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('accounts', mode); const store = transaction.objectStore('accounts'); const request = action(store);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); transaction.oncomplete = () => db.close();
  });
}
const readAccount = userId => accountStore('readonly', store => store.get(accountKey(userId)));
const writeAccount = record => accountStore('readwrite', store => store.put(record));
function snapshotFromState() { return { appVersion: CLIENT_VERSION, user: state.user, lists: state.lists, tasks: state.tasks, settings: state.settings, notificationCount: state.notificationCount }; }
const exportValue = value => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length) ? 'none' : value;
function buildDataExport() {
  const exportedAt = new Date();
  const lists = state.lists.map(list => ({
    name: exportValue(list.name),
    data: {
      sourceId: exportValue(list.id), color: exportValue(list.color), isDefault: Boolean(list.isDefault),
      createdAt: exportValue(list.createdAt), version: exportValue(list.version), shared: Boolean(list.shared),
      owner: exportValue(list.owner?.address)
    },
    tasks: state.tasks.filter(task => task.listId === list.id).map(task => ({
      sourceId: exportValue(task.id), title: exportValue(task.title), notes: exportValue(task.notes),
      due: exportValue(task.due), priority: exportValue(task.priority), tags: exportValue(task.tags),
      completed: Boolean(task.completed), completedAt: exportValue(task.completedAt), recurrence: exportValue(task.recurrence),
      createdAt: exportValue(task.createdAt), updatedAt: exportValue(task.updatedAt), version: exportValue(task.version),
      shared: Boolean(task.shared), shareParticipants: exportValue((task.shareParticipants || []).map(item => item.address))
    }))
  }));
  return {
    format: 'haru-data-export', schemaVersion: 1,
    metadata: {
      exportedAt: exportedAt.toISOString(), deviceTime: exportedAt.toString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'none', locale: navigator.language || 'none',
      source: SERVER_KEY, account: exportValue(state.user?.address), appVersion: CLIENT_VERSION,
      listCount: lists.length, taskCount: lists.reduce((sum, list) => sum + list.tasks.length, 0)
    },
    lists
  };
}
function downloadDataExport() {
  const payload = buildDataExport(); const stamp = localYmd(new Date()).replaceAll('-', '');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `haru-export-${stamp}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  $('#dataTransferStatus').textContent = `${payload.metadata.listCount}개 리스트와 ${payload.metadata.taskCount}개 태스크를 내보냈습니다.`;
}
async function persistOffline() {
  if (!state.user) return;
  offlineRecord ||= { key: accountKey(state.user.id), server: SERVER_KEY, userId: state.user.id, outbox: [] };
  offlineRecord.key = accountKey(state.user.id); offlineRecord.server = SERVER_KEY; offlineRecord.userId = state.user.id; offlineRecord.snapshot = snapshotFromState(); offlineRecord.updatedAt = new Date().toISOString();
  await writeAccount(offlineRecord); localStorage.setItem(LAST_USER_KEY, state.user.id);
}
async function queueMutation(type, entityId, baseVersion, payload = {}) {
  offlineRecord ||= { key: accountKey(state.user.id), server: SERVER_KEY, userId: state.user.id, snapshot: snapshotFromState(), outbox: [] };
  if (type.startsWith('delete-')) {
    const createType = type.replace('delete-', 'create-');
    if (offlineRecord.outbox.some(item => item.entityId === entityId && item.type === createType)) {
      offlineRecord.outbox = offlineRecord.outbox.filter(item => item.entityId !== entityId); await persistOffline(); return null;
    }
  }
  const mutation = { id: uuid('mutation'), type, entityId, baseVersion, payload, createdAt: new Date().toISOString() };
  offlineRecord.outbox.push(mutation); await persistOffline();
  if (navigator.onLine) syncOffline().catch(() => {});
  return mutation;
}
async function syncOffline() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    if (!state.user) return null;
    if (!navigator.onLine) throw new Error('인터넷 연결이 없어 동기화하지 못했습니다.');
    offlineRecord ||= await readAccount(state.user.id) || { key: accountKey(state.user.id), server: SERVER_KEY, userId: state.user.id, snapshot: snapshotFromState(), outbox: [] };
    const attempted = [...offlineRecord.outbox]; const attemptedIds = new Set(attempted.map(item => item.id));
    const data = attempted.length
      ? await api('/api/sync', { method: 'POST', body: JSON.stringify({ mutations: attempted }) })
      : await api('/api/bootstrap');
    if (attempted.length) offlineRecord.outbox = offlineRecord.outbox.filter(item => !attemptedIds.has(item.id));
    Object.assign(state, { user: data.user, lists: data.lists, tasks: data.tasks, settings: data.settings, notificationCount: data.notificationCount });
    await persistOffline(); render();
    const conflicts = data.results?.filter(item => item.status === 'conflict') || [];
    const revoked = data.results?.filter(item => item.status === 'permission_revoked') || [];
    if (offlineRecord.outbox.length && navigator.onLine) setTimeout(() => syncOffline().catch(() => {}), 0);
    if (conflicts.length) toast('동기화 충돌이 발생해 마지막 서버 데이터로 통일했습니다.', 'conflict', 6000);
    else if (revoked.length) toast('권한이 취소되어 해당 오프라인 편집 내용을 버렸습니다.', 'error', 6000);
    else if (data.caldavError) toast('Haru 동기화는 완료됐지만 CalDAV 동기화에 실패했습니다.', 'error', 6000);
    lastSyncFailure = '';
    return data;
  })().catch(error => {
    if (!error.updating && error.message !== lastSyncFailure) { lastSyncFailure = error.message; toast(`동기화 실패 · ${error.message}`, 'error', 6000); }
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}
const escapeHtml = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const formatDate = due => {
  if (!due) return '';
  const datePart = due.slice(0, 10); const timePart = due.includes('T') ? ` ${due.slice(11, 16)}` : '';
  if (datePart === today) return `오늘${timePart}`;
  const tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1); const tomorrow = localYmd(tomorrowDate);
  if (datePart === tomorrow) return `내일${timePart}`;
  return `${new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(new Date(`${datePart}T12:00:00`))}${timePart}`;
};
const recurrenceLabel = recurrence => ({ none: '', hourly: '매시간', daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' })[recurrence?.type || 'none'];

async function bootstrap() {
  const cachedUserId = state.user?.id || localStorage.getItem(LAST_USER_KEY);
  if (cachedUserId) {
    offlineRecord = await readAccount(cachedUserId).catch(() => null);
    if (offlineRecord?.server === SERVER_KEY && offlineRecord.userId === cachedUserId && offlineRecord.snapshot) { Object.assign(state, offlineRecord.snapshot); showApp(); render(); }
  }
  try {
    const data = state.user && offlineRecord ? await syncOffline() : await api('/api/bootstrap');
    if (data && !offlineRecord) { Object.assign(state, data); await persistOffline(); showApp(); render(); }
    connectRealtime();
    if (state.user.mustChangePassword || new URLSearchParams(location.search).get('screen') === 'account') openAccountScreen(false);
    if (state.user.mustChangePassword) { $('#passwordForm').classList.remove('hidden'); $('#passwordForm input').focus(); toast('임시 비밀번호를 새 비밀번호로 변경해 주세요.'); }
  } catch (e) { if (!state.user && e.status !== 401 && !e.updating) toast(e.message, 'error', 6000); }
}
async function refreshSnapshot() {
  if (snapshotRefresh) return snapshotRefresh;
  snapshotRefresh = (async () => {
    const selectedListId = $('#taskListSelect')?.value;
    const data = await syncOffline();
    if (!data) return null;
    showApp();
    if (!['all', 'upcoming', 'completed'].includes(state.filter) && !state.lists.some(list => list.id === state.filter)) state.filter = 'all';
    renderLists(); renderTasks(); renderNotificationBadge();
    if (!$('#settingsScreen').classList.contains('hidden') && !settingsDirty) renderSettings();
    if (!$('#accountScreen').classList.contains('hidden')) renderAccount();
    if ($('#notificationDialog').open) openNotifications();
    if (selectedListId && state.lists.some(list => list.id === selectedListId)) $('#taskListSelect').value = selectedListId;
    return data;
  })().catch(error => {
    if (error.status === 401 && state.user) realtimeSource?.close();
    throw error;
  }).finally(() => { snapshotRefresh = null; });
  return snapshotRefresh;
}
function scheduleRealtimeRefresh() {
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(() => refreshSnapshot().catch(() => {}), 120);
}
function connectRealtime() {
  if (!('EventSource' in window) || realtimeSource) return;
  realtimeSource = new EventSource(`${BASE_PATH}/api/events`);
  realtimeSource.addEventListener('change', scheduleRealtimeRefresh);
}
function showApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#appView').classList.toggle('guest-mode', state.user.role === 'guest');
  $('#profileName').textContent = state.user.username; $('#profileAddress').textContent = state.user.address; document.querySelectorAll('.avatar').forEach(el => el.textContent = state.user.username[0].toUpperCase());
}
function render() { renderLists(); renderTasks(); renderSettings(); renderNotificationBadge(); }
function renderNotificationBadge() { const count = Number(state.notificationCount || 0); $('#notificationBadge').textContent = count > 99 ? '99+' : count; $('#notificationBadge').classList.toggle('hidden', !count); }
function renderAccount() {
  $('#accountUsername').textContent = state.user.username; $('#accountAddress').textContent = state.user.address;
  $('#accountRoleBadge').textContent = state.user.role;
  $('#accountTaskCount').textContent = state.tasks.length; $('#accountListCount').textContent = state.lists.length; $('#accountCompletedCount').textContent = state.tasks.filter(task => task.completed).length;
  $('#adminAccountPanel').classList.toggle('hidden', state.user.role !== 'admin');
  if (state.user.role === 'admin') loadAccountUsers();
  loadAccountCollaborations();
}
async function loadAccountUsers() {
  try {
    const { users } = await api('/api/users');
    $('#accountUsers').innerHTML = users.map(item => `<div class="account-user" data-user-id="${item.id}"><div><strong>${escapeHtml(item.username)}</strong><small>${escapeHtml(item.address)}${item.mustChangePassword ? ' · 비밀번호 변경 필요' : ''}</small></div><select class="user-role" aria-label="${escapeHtml(item.username)} 권한" ${item.role === 'admin' ? 'disabled' : ''}><option value="guest" ${item.role === 'guest' ? 'selected' : ''}>guest</option><option value="user" ${item.role === 'user' ? 'selected' : ''}>user</option><option value="admin" ${item.role === 'admin' ? 'selected' : ''}>admin</option></select><button class="delete-user" type="button" ${item.role === 'admin' ? 'disabled title="admin은 본인이 권한을 포기해야 합니다"' : ''}>삭제</button></div>`).join('');
  } catch (error) { toast(error.message); }
}
async function loadAccountCollaborations() {
  try {
    const { collaborations } = await api('/api/collaborations');
    $('#accountCollaborations').innerHTML = collaborations.length ? collaborations.map(item => {
      const mine = item.ownerUserId === state.user.id; const other = mine ? item.invitee : item.owner;
      return `<div class="account-user collaboration-row" data-collaboration-id="${item.id}"><div><strong>${escapeHtml(item.listName)}</strong><small>${mine ? '참여자' : '소유자'} · ${escapeHtml(other?.address || '')}</small></div><span class="collaboration-status">승인됨</span><button class="remove-collaboration" type="button">승인 제거</button></div>`;
    }).join('') : '<div class="empty-inline">승인된 협업 권한이 없습니다.</div>';
  } catch (error) { toast(error.message); }
}
function showScreen(screen) {
  for (const id of ['taskScreen', 'settingsScreen', 'accountScreen']) $(`#${id}`).classList.toggle('hidden', id !== screen);
}
function openAccountScreen(updateUrl = true) {
  renderAccount(); showScreen('accountScreen');
  document.querySelectorAll('.nav-item,.list-item').forEach(e => e.classList.remove('active'));
  $('#accountButton').classList.add('active'); $('#breadcrumb').textContent = '계정'; $('#todayLabel').textContent = '';
  $('#passwordForm').classList.add('hidden'); $('#passwordForm').reset(); $('#passwordError').textContent = '';
  if (updateUrl) history.replaceState(null, '', `${location.pathname}?screen=account`);
  $('#closeSidebar').click();
}
function renderLists() {
  const previousListId = $('#taskListSelect').value;
  const counts = Object.fromEntries(state.lists.map(l => [l.id, state.tasks.filter(t => t.listId === l.id && !t.completed).length]));
  const inbox = state.lists.find(l => !l.shared && l.id === state.settings.defaultListId) || state.lists.find(l => !l.shared && l.isDefault);
  const inboxNav = $('#inboxNav');
  $('#inboxNavRow').classList.toggle('hidden', !inbox);
  if (inbox) {
    inboxNav.dataset.list = inbox.id;
    inboxNav.classList.toggle('active', state.filter === inbox.id);
    $('#inboxName').textContent = inbox.name;
    $('#inboxCount').textContent = counts[inbox.id] || '';
    $('#deleteInboxButton').dataset.deleteList = inbox.id;
    $('#deleteInboxButton').setAttribute('aria-label', `${inbox.name} 리스트 삭제`);
  }
  $('#listNav').innerHTML = state.lists.filter(l => l.id !== inbox?.id).map(l => `<div class="list-row"><button class="list-item ${state.filter === l.id ? 'active' : ''}" data-list="${l.id}"><i class="list-dot" style="background:${l.color}"></i><span>${escapeHtml(l.name)}${l.shared ? ` <em>· ${escapeHtml(l.owner?.username || '')}</em>` : ''}</span><small>${counts[l.id] || ''}</small></button>${l.shared?'':`<button class="delete-list" type="button" data-delete-list="${l.id}" title="리스트 삭제" aria-label="${escapeHtml(l.name)} 리스트 삭제">×</button>`}</div>`).join('');
  const options = state.lists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}${l.shared ? ` · ${escapeHtml(l.owner?.username || '')}` : ''}</option>`).join('');
  $('#taskListSelect').innerHTML = options; $('#defaultListSetting').innerHTML = state.lists.filter(l => !l.shared).map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  const activeListId = state.lists.some(list => list.id === state.filter) ? state.filter : null;
  const selectedListId = activeListId || (state.lists.some(list => list.id === previousListId) ? previousListId : state.settings.defaultListId);
  $('#taskListSelect').value = selectedListId; $('#defaultListSetting').value = state.settings.defaultListId;
  $('#todayCount').textContent = state.tasks.filter(t => !t.completed).length || '';
  const listMarker=state.settings.listMarker||'*',priorityMarker=state.settings.priorityMarker||'!',tagMarker=state.settings.tagMarker||'#';
  $('#quickInput').placeholder=`할 일  ${listMarker}리스트  ${priorityMarker}3  ${tagMarker}태그  내일`;
}
function filteredTasks() {
  if (state.filter === 'completed') return state.tasks.filter(t => t.completed);
  if (state.filter === 'upcoming') return state.tasks.filter(t => !t.completed && t.due && t.due.slice(0, 10) > today);
  if (state.filter !== 'all') return state.tasks.filter(t => t.listId === state.filter && !t.completed);
  return state.tasks.filter(t => !t.completed);
}
function renderTasks() {
  const sortBy=state.settings?.sortBy||'createdAt',direction=(state.settings?.sortDirection||'desc')==='asc'?1:-1;
  const priorityValue={none:0,low:1,medium:2,high:3};
  const sortValue=task=>sortBy==='createdAt'?Date.parse(task.createdAt||0):sortBy==='priority'?(priorityValue[task.priority]??0):sortBy==='remaining'?(task.due?Math.ceil((new Date(task.due.slice(0,10)+'T00:00:00')-new Date(today+'T00:00:00'))/86400000):null):(task.due?Date.parse(task.due.length===10?`${task.due}T00:00:00`:task.due):null);
  const manualOrder=new Map((state.settings?.manualTaskOrder||[]).map((id,index)=>[id,index]));
  const tasks = filteredTasks().sort((a,b)=>{if(sortBy==='manual'){const av=manualOrder.has(a.id)?manualOrder.get(a.id):Number.MAX_SAFE_INTEGER,bv=manualOrder.has(b.id)?manualOrder.get(b.id):Number.MAX_SAFE_INTEGER;return av-bv||Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0);}const av=sortValue(a),bv=sortValue(b);if(av===null&&bv===null)return Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0);if(av===null)return 1;if(bv===null)return-1;if(av===bv)return Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0);return(av-bv)*direction;});
  const selectedList = state.lists.find(l => l.id === state.filter);
  const labels = state.filter === 'completed' ? ['완료', '완료 처리한 할 일을 확인하고 필요하면 다시 열 수 있습니다.'] : state.filter === 'upcoming' ? ['예정', '기한이 설정된 미완료 할 일을 확인합니다.'] : selectedList ? [selectedList.name, `${selectedList.name} 리스트의 미완료 할 일입니다.`] : ['오늘', '완료되지 않은 할 일을 한곳에서 확인합니다.'];
  $('#viewTitle').textContent = labels[0]; $('#viewSubtitle').textContent = labels[1]; $('#sectionTitle').textContent = state.filter === 'completed' ? '완료한 일' : '할 일';
  $('#taskCount').textContent = `${tasks.length}개`;
  if (!$('#taskScreen').classList.contains('hidden')) { $('#breadcrumb').textContent = labels[0]; $('#todayLabel').textContent = new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short'}).format(new Date()); }
  $('#dateEyebrow').textContent = new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric'}).format(new Date()).toUpperCase();
  $('#taskList').innerHTML = tasks.length ? tasks.map(t => {
    const list = state.lists.find(l => l.id === t.listId); const dueDate = t.due?.slice(0,10); const dueClass = dueDate === today ? 'today' : dueDate && dueDate < today ? 'overdue' : '';
    const tags = (t.tags || []).map(tag => `<span class="task-tag">#${escapeHtml(tag)}</span>`).join('');
    const shareLabels=(t.shareParticipants||[]).map(user=>`@${escapeHtml(user.username)}`).join(' ');
    const editable=state.user.role!=='guest';
    return `<article class="task-row ${t.completed?'completed':''} ${sortBy==='manual'?'manual-sort':''} ${editable?'editable':''}" data-id="${t.id}" draggable="${sortBy==='manual'}" ${editable?'tabindex="0" role="button" aria-label="태스크 편집"':''}>${sortBy==='manual'?'<button class="task-drag-handle" type="button" title="드래그해서 순서 변경" aria-label="태스크 순서 변경">☷</button>':''}<input class="task-check" type="checkbox" ${t.completed?'checked':''} aria-label="완료"><div class="task-main"><div class="task-title">${escapeHtml(t.title)}</div><div class="task-meta"><span class="meta-list"><i class="list-dot" style="background:${list?.color || '#aaa'}"></i>${escapeHtml(list?.name || '')}${list?.shared ? ` · ${escapeHtml(list.owner?.username || '')}` : ''}</span>${t.shared&&shareLabels?`<span class="task-shared">${shareLabels}</span>`:''}${t.due?`<span class="due ${dueClass}">◷ ${formatDate(t.due)}</span>`:''}${t.recurrence?.type && t.recurrence.type !== 'none'?`<span class="repeat-label">↻ ${recurrenceLabel(t.recurrence)}</span>`:''}${tags}</div></div><i class="priority ${t.priority}"></i><button class="task-menu" title="삭제">×</button></article>`;
  }).join('') : `<div class="empty-state"><strong>${state.filter === 'completed' ? '완료한 할 일이 없습니다.' : '표시할 할 일이 없습니다.'}</strong><p>${state.filter === 'completed' ? '할 일을 완료하면 이 목록에서 다시 확인할 수 있습니다.' : '위 입력창에서 새 할 일을 추가하세요.'}</p></div>`;
}
function updateEditRecurrenceFields() {
  const type=$('#editTaskRepeat').value; const details=$('#editTaskRepeatDetails');
  details.classList.toggle('hidden',!['weekly','monthly','yearly'].includes(type));
  $('#editTaskWeekdayWrap').classList.toggle('hidden',type!=='weekly');
  $('#editTaskMonthDayWrap').classList.toggle('hidden',type!=='monthly');
  $('#editTaskYearWrap').classList.toggle('hidden',type!=='yearly');
}
function openTaskEditor(task) {
  if (!task || state.user.role==='guest') return;
  const currentList=state.lists.find(list=>list.id===task.listId);
  const eligibleLists=state.lists.filter(list=>list.userId===currentList?.userId);
  $('#editTaskId').value=task.id; $('#editTaskTitle').value=task.title; $('#editTaskNotes').value=task.notes||'';
  $('#editTaskList').innerHTML=eligibleLists.map(list=>`<option value="${list.id}">${escapeHtml(list.name)}${list.shared?` · ${escapeHtml(list.owner?.username||'')}`:''}</option>`).join('');
  $('#editTaskList').value=task.listId; $('#editTaskPriority').value=task.priority||'none';
  $('#editTaskDue').value=task.due?(task.due.length===10?`${task.due}T00:00`:task.due.slice(0,16)):'';
  $('#editTaskTags').value=(task.tags||[]).join(', ');
  const recurrence=task.recurrence||{type:'none'}; $('#editTaskRepeat').value=recurrence.type||'none';
  $('#editTaskWeekday').value=String(recurrence.weekday??0); $('#editTaskMonthDay').value=String(recurrence.day??1);
  $('#editTaskYearMonth').value=String(recurrence.month??1); $('#editTaskYearDay').value=String(recurrence.day??1);
  $('#editTaskError').textContent=''; updateEditRecurrenceFields(); $('#editTaskDialog').showModal();
  requestAnimationFrame(()=>$('#editTaskTitle').focus());
}
function editedRecurrence() {
  const type=$('#editTaskRepeat').value; const recurrence={type};
  if(type==='weekly')recurrence.weekday=Number($('#editTaskWeekday').value);
  if(type==='monthly')recurrence.day=Number($('#editTaskMonthDay').value);
  if(type==='yearly'){recurrence.month=Number($('#editTaskYearMonth').value);recurrence.day=Number($('#editTaskYearDay').value);}
  return recurrence;
}
function setCalDavStatus(status, message) {
  const normalized = ['ready', 'syncing', 'error'].includes(status) ? status : 'setup';
  const labels = { setup: '설정 중', ready: '설정 정상', syncing: '동기화 중', error: '동기화 문제' };
  const indicator = $('#caldavSyncIndicator');
  indicator.className = `caldav-sync-indicator ${normalized}`;
  indicator.title = labels[normalized]; indicator.setAttribute('aria-label', labels[normalized]);
  $('#caldavSyncStatus').textContent = message || labels[normalized];
}
function updateCalDavButton() {
  const ready = Boolean($('#syncServerSetting').value.trim() && $('#syncUsernameSetting').value.trim() && $('#syncPasswordSetting').value);
  $('#caldavSyncButton').disabled = !ready;
  return ready;
}
function renderSettings(force = false) {
  if (!state.settings) return;
  if (!force && settingsDirty && !$('#settingsScreen').classList.contains('hidden')) return;
  const theme = state.settings.theme || 'system';
  $('#defaultDueSetting').value = state.settings.defaultDue; $('#defaultPrioritySetting').value = state.settings.defaultPriority; $('#autoDeleteCompletedSetting').value = state.settings.autoDeleteCompleted || 'none'; $('#syncServerSetting').value = state.settings.syncServer || ''; $('#mcpSetting').checked = state.settings.mcpEnabled; $('#themeSetting').value = theme;
  $('#syncUsernameSetting').value = state.settings.syncUsername || '';
  $('#syncPasswordSetting').value = state.settings.syncPasswordSet ? STORED_PASSWORD : '';
  for(const [id,key] of [['listMarkerSetting','listMarker'],['priorityMarkerSetting','priorityMarker'],['tagMarkerSetting','tagMarker']]){$(`#${id}`).innerHTML=MARKER_CHOICES.map(marker=>`<option value="${escapeHtml(marker)}">${escapeHtml(marker)}</option>`).join('');$(`#${id}`).value=state.settings[key]||({listMarker:'*',priorityMarker:'!',tagMarker:'#'}[key]);}
  $('#taskSortBy').value=state.settings.sortBy||'createdAt';$('#taskSortDirection').value=state.settings.sortDirection||'desc';$('#taskSortDirection').disabled=state.settings.sortBy==='manual';updateMarkerOptions();applyTheme(theme);
  const status = state.settings.syncStatus || (state.settings.syncPasswordSet ? 'ready' : 'setup');
  const message = status === 'error' ? (state.settings.syncLastError || '마지막 동기화에 실패했습니다.') : status === 'ready' && state.settings.syncLastAt ? `마지막 동기화 · ${new Date(state.settings.syncLastAt).toLocaleString()}` : '';
  setCalDavStatus(status, message); updateCalDavButton();
  renderShortcutTokens();
}
function renderShortcutTokens() {
  const enabled = Boolean(state.settings?.mcpEnabled);
  $('#createShortcutTokenButton').disabled = !enabled || state.user?.role === 'guest';
  $('#shortcutTokenHelp').textContent = enabled ? '토큰 원문은 발급 직후 한 번만 표시되며 서버에는 해시만 저장됩니다.' : '외부 도구 토큰 사용을 켜고 설정을 저장한 뒤 발급할 수 있습니다.';
  $('#shortcutTokenList').innerHTML = state.shortcutTokens.length ? state.shortcutTokens.map(token => `<div class="shortcut-token-row" data-shortcut-token-id="${escapeHtml(token.id)}"><div><strong>${escapeHtml(token.name)}</strong><small>${token.scope === 'read' ? '전체 데이터 조회' : '할 일 등록'} · …${escapeHtml(token.hint)}${token.lastUsedAt ? ` · 최근 사용 ${escapeHtml(new Date(token.lastUsedAt).toLocaleString())}` : ''}</small></div><button type="button" data-revoke-shortcut-token>폐기</button></div>`).join('') : '<div class="empty-inline">발급된 단축어 토큰이 없습니다.</div>';
}
async function loadShortcutTokens() {
  const data = await api('/api/shortcut-tokens'); state.shortcutTokens = data.tokens || []; renderShortcutTokens();
}
function updateMarkerOptions(){const selects=[$('#listMarkerSetting'),$('#priorityMarkerSetting'),$('#tagMarkerSetting')],values=selects.map(select=>select.value);selects.forEach((select,index)=>[...select.options].forEach(option=>option.disabled=values.some((value,other)=>other!==index&&value===option.value)));const duplicate=new Set(values).size!==values.length;$('#markerError').textContent=duplicate?'각 마커는 서로 달라야 합니다.':'';$('#saveSettingsButton').disabled=duplicate;$('#markerExample').textContent=`예: 보고서 ${values[0]}업무 ${values[1]}3 ${values[2]}검토`;return !duplicate;}
function selectFilter(filter) {
  state.filter = filter; document.querySelectorAll('.nav-item,.list-item').forEach(e => e.classList.remove('active'));
  const el = document.querySelector(`[data-filter="${filter}"],[data-list="${filter}"]`); el?.classList.add('active');
  $('#accountButton').classList.remove('active'); showScreen('taskScreen'); history.replaceState(null, '', location.pathname); renderTasks();
  if (state.lists.some(list => list.id === filter)) $('#taskListSelect').value = filter;
  $('#closeSidebar').click();
}

const normalizeSearchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
function renderSearchResults() {
  const rawQuery = $('#searchInput').value.trim();
  const query = normalizeSearchText(rawQuery.replace(/^#/, ''));
  if (!query) { $('#searchResults').innerHTML = '<div class="search-empty">태스크 제목이나 #태그를 입력해 주세요.</div>'; return; }
  const matches = state.tasks.filter(task => {
    const list = state.lists.find(item => item.id === task.listId);
    return [task.title, task.notes, list?.name, ...(task.tags || [])].some(value => normalizeSearchText(value).includes(query));
  });
  $('#searchResults').innerHTML = matches.length ? matches.map(task => {
    const list = state.lists.find(item => item.id === task.listId);
    const tags = (task.tags || []).map(tag => `#${escapeHtml(tag)}`).join(' ');
    return `<button class="search-result" type="button" data-search-task="${task.id}"><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(list?.name || '')}${task.due ? ` · ${escapeHtml(formatDate(task.due))}` : ''}${task.completed ? ' · 완료' : ''}</small></span>${tags ? `<em>${tags}</em>` : ''}</button>`;
  }).join('') : '<div class="search-empty">일치하는 태스크나 태그가 없습니다.</div>';
}
function openSearch() {
  $('#searchInput').value = ''; renderSearchResults(); $('#searchDialog').showModal();
  requestAnimationFrame(() => $('#searchInput').focus());
}

function repositionTaskRow(row, target, clientY) {
  if (!row || !target || row === target || !target.classList.contains('manual-sort')) return false;
  const after = clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
  target.parentNode.insertBefore(row, after ? target.nextSibling : target);
  return true;
}
async function persistManualTaskOrder() {
  const taskIds = [...$('#taskList').querySelectorAll('.task-row')].map(row => row.dataset.id);
  if (!taskIds.length) return;
  const previous = [...(state.settings.manualTaskOrder || [])]; const visible = new Set(taskIds); const baseVersion = state.settings.version || 1;
  state.settings.manualTaskOrder = [...taskIds, ...previous.filter(id => !visible.has(id))];
  state.settings.version = baseVersion + 1; renderTasks();
  await queueMutation('task-order', state.user.id, baseVersion, { taskIds });
}
let draggedTaskRow = null;
$('#taskList').addEventListener('dragstart',e=>{const row=e.target.closest('.task-row.manual-sort');if(!row)return e.preventDefault();draggedTaskRow=row;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.id);});
$('#taskList').addEventListener('dragover',e=>{if(!draggedTaskRow)return;e.preventDefault();repositionTaskRow(draggedTaskRow,e.target.closest('.task-row'),e.clientY);});
$('#taskList').addEventListener('drop',e=>{if(!draggedTaskRow)return;e.preventDefault();persistManualTaskOrder();});
$('#taskList').addEventListener('dragend',()=>{draggedTaskRow?.classList.remove('dragging');draggedTaskRow=null;});
let pointerTaskRow = null; let pointerTaskMoved = false;
$('#taskList').addEventListener('pointerdown',e=>{const handle=e.target.closest('.task-drag-handle');if(!handle||e.pointerType==='mouse')return;e.preventDefault();pointerTaskRow=handle.closest('.task-row');pointerTaskMoved=false;pointerTaskRow.classList.add('dragging');});
window.addEventListener('pointermove',e=>{if(!pointerTaskRow)return;e.preventDefault();const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.task-row');pointerTaskMoved=repositionTaskRow(pointerTaskRow,target,e.clientY)||pointerTaskMoved;const workspace=$('.workspace');if(e.clientY<90)workspace.scrollBy(0,-14);else if(e.clientY>innerHeight-70)workspace.scrollBy(0,14);},{passive:false});
const finishPointerTaskDrag=()=>{if(!pointerTaskRow)return;pointerTaskRow.classList.remove('dragging');pointerTaskRow=null;if(pointerTaskMoved)persistManualTaskOrder();pointerTaskMoved=false;};
window.addEventListener('pointerup',finishPointerTaskDrag);window.addEventListener('pointercancel',finishPointerTaskDrag);

$('#domainSuffix').textContent = `@${location.hostname}`;
$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); $('#loginError').textContent=''; try { const data = await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))}); state.user=data.user; await bootstrap(); } catch(err) { $('#loginError').textContent=err.message; } });
$('#logoutButton').addEventListener('click', async () => { realtimeSource?.close(); localStorage.removeItem(LAST_USER_KEY); await api('/api/logout',{method:'POST'}); location.reload(); });
$('.sidebar .brand').addEventListener('click',e=>{e.preventDefault();selectFilter('all');});
$('#accountButton').addEventListener('click',e=>{e.preventDefault();openAccountScreen();});
$('#backToTasksButton').addEventListener('click',()=>selectFilter('all'));
$('#showPasswordButton').addEventListener('click',()=>{$('#passwordForm').classList.remove('hidden');$('#passwordForm input').focus();});
$('#cancelPasswordButton').addEventListener('click',()=>{$('#passwordForm').classList.add('hidden');$('#passwordForm').reset();$('#passwordError').textContent='';});
$('#transferAccountButton').addEventListener('click',()=>toast('계정 정보 이전은 다음 업데이트에서 지원할 예정이에요.'));
$('#passwordForm').addEventListener('submit',async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));$('#passwordError').textContent='';if(values.newPassword!==values.confirmPassword){$('#passwordError').textContent='새 비밀번호가 서로 일치하지 않습니다.';return;}try{const data=await api('/api/account/password',{method:'PATCH',body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});state.user=data.user;e.target.reset();e.target.classList.add('hidden');toast('비밀번호를 변경했어요.');}catch(err){$('#passwordError').textContent=err.message;}});
$('#addAccountButton').addEventListener('click',()=>{$('#createAccountForm').reset();$('#createAccountError').textContent='';$('#temporaryPasswordResult').classList.add('hidden');$('#createAccountSubmit').classList.remove('hidden');$('#createAccountDialog').showModal();});
$('#cancelCreateAccountButton').addEventListener('click',()=>$('#createAccountDialog').close());
$('#createAccountForm').addEventListener('submit',async e=>{e.preventDefault();$('#createAccountError').textContent='';try{const data=await api('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});$('#temporaryPassword').textContent=data.temporaryPassword;$('#temporaryPasswordResult').classList.remove('hidden');$('#createAccountSubmit').classList.add('hidden');await loadAccountUsers();}catch(err){$('#createAccountError').textContent=err.message;}});
$('#copyTemporaryPassword').addEventListener('click',async()=>{await navigator.clipboard.writeText($('#temporaryPassword').textContent);toast('임시 비밀번호를 복사했어요.');});
$('#accountUsers').addEventListener('change',async e=>{if(!e.target.matches('.user-role'))return;const row=e.target.closest('.account-user');try{await api(`/api/users/${row.dataset.userId}/role`,{method:'PATCH',body:JSON.stringify({role:e.target.value})});await loadAccountUsers();toast('계정 권한을 변경했어요.');}catch(err){toast(err.message);await loadAccountUsers();}});
$('#accountUsers').addEventListener('click',async e=>{const button=e.target.closest('.delete-user');if(!button||button.disabled)return;const row=button.closest('.account-user');if(!confirm('이 계정과 계정의 Haru 데이터를 삭제할까요?'))return;try{await api(`/api/users/${row.dataset.userId}`,{method:'DELETE'});await loadAccountUsers();toast('계정을 삭제했어요.');}catch(err){toast(err.message);}});
$('#accountCollaborations').addEventListener('click',async e=>{const button=e.target.closest('.remove-collaboration');if(!button)return;const row=button.closest('.account-user');if(!confirm('이 리스트의 협업 승인을 제거할까요?'))return;try{await api(`/api/collaborations/${row.dataset.collaborationId}`,{method:'DELETE'});const data=await api('/api/bootstrap');Object.assign(state,data);render();await loadAccountCollaborations();toast('협업 승인을 제거했어요.');}catch(err){toast(err.message);}});
$('#relinquishAdminButton').addEventListener('click',()=>{$('#relinquishAdminForm').reset();$('#relinquishAdminError').textContent='';$('#relinquishAdminDialog').showModal();});
$('#cancelRelinquishAdminButton').addEventListener('click',()=>$('#relinquishAdminDialog').close());
$('#relinquishAdminForm').addEventListener('submit',async e=>{e.preventDefault();$('#relinquishAdminError').textContent='';try{const data=await api('/api/account/relinquish-admin',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});state.user=data.user;$('#relinquishAdminDialog').close();showApp();renderAccount();toast('admin 권한을 포기했어요.');}catch(err){$('#relinquishAdminError').textContent=err.message;}});
document.addEventListener('click', e => { const nav=e.target.closest('[data-filter]'); if(nav) selectFilter(nav.dataset.filter); const list=e.target.closest('[data-list]'); if(list) selectFilter(list.dataset.list); });
async function createTask(payload) {
  const list = state.lists.find(item => item.id === (payload.listId || state.settings.defaultListId));
  if (!list) { toast('태스크를 추가할 리스트가 없습니다.', 'error'); return false; }
  const now = new Date().toISOString(); const id = uuid('task');
  const task = { id, userId: list.userId || state.user.id, createdByUserId: state.user.id, sharedWithUserIds: [], listId: list.id, title: payload.title.trim(), notes: payload.notes || '', due: payload.due || null, priority: payload.priority || state.settings.defaultPriority || 'none', tags: payload.tags || [], recurrence: payload.recurrence || { type: 'none' }, completed: false, completedAt: null, createdAt: now, updatedAt: now, version: 1, shared: Boolean(list.shared), shareParticipants: [] };
  state.tasks.push(task); $('#quickInput').value=''; $('#taskDue').value=''; state.pendingTask=null; state.pendingDueTask=null; render();
  await queueMutation('create-task', id, 0, { ...payload, listId: list.id, createdAt: now, dueDecision: payload.dueDecision || 'keep' }); return true;
}
$('#quickAddForm').addEventListener('submit', async e => {
  e.preventDefault(); const input=$('#quickInput'); if(!input.value.trim()) return;
  const type=$('#taskRepeat').value;const recurrence={type};if(type==='weekly')recurrence.weekday=Number($('#repeatWeekday').value);if(type==='monthly')recurrence.day=Number($('#repeatMonthDay').value);if(type==='yearly'){recurrence.month=Number($('#repeatYearMonth').value);recurrence.day=Number($('#repeatYearDay').value);}
  const payload={title:input.value,listId:$('#taskListSelect').value,due:$('#taskDue').value||null,priority:$('#taskPriority').value,recurrence};
  try { if(await createTask(payload)) toast('태스크를 추가했어요.'); }
  catch(err) { toast(err.message); }
});
$('#taskList').addEventListener('change', async e => { if(!e.target.matches('.task-check'))return; const row=e.target.closest('.task-row'); const task=state.tasks.find(item=>item.id===row.dataset.id);if(!task)return;const baseVersion=task.version||1;task.completed=e.target.checked;task.updatedAt=new Date().toISOString();task.completedAt=task.completed?task.updatedAt:null;task.version=baseVersion+1;render();await queueMutation('update-task',task.id,baseVersion,{completed:task.completed}); });
$('#taskList').addEventListener('click', async e => {
  const button=e.target.closest('.task-menu');
  if(button){const row=button.closest('.task-row');const task=state.tasks.find(item=>item.id===row.dataset.id);if(!task)return;state.tasks=state.tasks.filter(t=>t.id!==task.id);render();await queueMutation('delete-task',task.id,task.version||1);toast('태스크를 삭제했어요.');return;}
  if(e.target.closest('button,input,select,textarea,a'))return;
  const row=e.target.closest('.task-row.editable'); if(!row)return;
  openTaskEditor(state.tasks.find(item=>item.id===row.dataset.id));
});
$('#taskList').addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key)||e.target!==e.currentTarget&&e.target!==e.target.closest('.task-row'))return;const row=e.target.closest('.task-row.editable');if(!row)return;e.preventDefault();openTaskEditor(state.tasks.find(item=>item.id===row.dataset.id));});
$('#editTaskRepeat').addEventListener('change',updateEditRecurrenceFields);
$('#cancelEditTaskButton').addEventListener('click',()=>$('#editTaskDialog').close());
$('#editTaskForm').addEventListener('submit',async e=>{
  e.preventDefault(); const task=state.tasks.find(item=>item.id===$('#editTaskId').value); if(!task){$('#editTaskDialog').close();return;}
  const title=$('#editTaskTitle').value.trim(); if(!title){$('#editTaskError').textContent='태스크 제목을 입력해 주세요.';return;}
  let due=$('#editTaskDue').value||null; if(task.due?.length===10&&due===`${task.due}T00:00`)due=task.due;
  const tags=[...new Set($('#editTaskTags').value.split(',').map(tag=>tag.trim().replace(/^#/,'')).filter(Boolean))].slice(0,20);
  const payload={title,notes:$('#editTaskNotes').value.trim(),listId:$('#editTaskList').value,due,priority:$('#editTaskPriority').value,tags,recurrence:editedRecurrence()};
  const baseVersion=task.version||1; Object.assign(task,payload,{updatedAt:new Date().toISOString(),version:baseVersion+1}); render(); $('#editTaskDialog').close();
  try{await queueMutation('update-task',task.id,baseVersion,payload);toast('태스크를 수정했어요.');}catch(error){toast(error.message,'error',6000);}
});
$('#addListButton').addEventListener('click',()=>{state.pendingTask=null;$('#newListName').value='';$('#listDialogCopy').textContent='새로운 공간에 할 일을 모아보세요.';$('#listDialog').showModal();});
document.querySelector('[data-close]').addEventListener('click',()=>$('#listDialog').close());
$('#listForm').addEventListener('submit',async e=>{e.preventDefault();const name=$('#newListName').value.trim();if(!name)return;const now=new Date().toISOString();const list={id:uuid('list'),userId:state.user.id,name,color:'#a6c4d9',isDefault:false,createdAt:now,version:1};state.lists.push(list);const pending=state.pendingTask?{...state.pendingTask,listId:list.id}:null;state.pendingTask=null;$('#listDialog').close();render();await queueMutation('create-list',list.id,0,{name,color:list.color,createdAt:now});if(pending){if(await createTask(pending))toast('새 리스트를 만들고 태스크를 추가했어요.');}else toast('새 리스트를 만들었어요.');});
$('#acceptDueButton').addEventListener('click',async()=>{const payload=state.pendingDueTask;$('#dueConfirmDialog').close();if(!payload)return;try{if(await createTask({...payload,dueDecision:'accept'}))toast('기한을 적용해 태스크를 추가했어요.');}catch(err){toast(err.message);}});
$('#keepDueAsTextButton').addEventListener('click',async()=>{const payload=state.pendingDueTask;$('#dueConfirmDialog').close();if(!payload)return;try{if(await createTask({...payload,dueDecision:'keep'}))toast('날짜 표현을 내용으로 유지했어요.');}catch(err){toast(err.message);}});
document.addEventListener('click',e=>{const button=e.target.closest('[data-delete-list]');if(!button)return;const list=state.lists.find(item=>item.id===button.dataset.deleteList&&!item.shared);if(!list)return;state.pendingDeleteListId=list.id;$('#deleteListName').textContent=list.name;$('#deleteListTaskCount').textContent=state.tasks.filter(task=>task.listId===list.id).length;$('#deleteListConfirmation').value='';$('#deleteListError').textContent='';$('#deleteListDialog').showModal();});
$('#cancelDeleteListButton').addEventListener('click',()=>{$('#deleteListDialog').close();state.pendingDeleteListId=null;});
$('#deleteListForm').addEventListener('submit',async e=>{e.preventDefault();const id=state.pendingDeleteListId;if(!id)return;const list=state.lists.find(item=>item.id===id);if(!list)return;$('#deleteListError').textContent='';if($('#deleteListConfirmation').value.trim()!==list.name){$('#deleteListError').textContent=`확인란에 '${list.name}'을 정확히 입력해 주세요.`;return;}const deletedTaskCount=state.tasks.filter(task=>task.listId===id).length;state.tasks=state.tasks.filter(task=>task.listId!==id);state.lists=state.lists.filter(item=>item.id!==id);state.pendingDeleteListId=null;$('#deleteListDialog').close();if(state.filter===id)state.filter='all';render();selectFilter(state.filter);await queueMutation('delete-list',id,list.version||1);toast(`${deletedTaskCount}개 태스크와 리스트를 삭제했어요.`);});
$('#settingsButton').addEventListener('click',()=>{settingsDirty=false;showScreen('settingsScreen');renderSettings(true);loadShortcutTokens().catch(error=>toast(error.message,'error'));history.replaceState(null,'',location.pathname);document.querySelectorAll('.nav-item,.list-item').forEach(e=>e.classList.remove('active'));$('#accountButton').classList.remove('active');$('#settingsButton').classList.add('active');$('#breadcrumb').textContent='설정';$('#todayLabel').textContent='';$('#closeSidebar').click();});
$('#themeSetting').addEventListener('change',e=>applyTheme(e.target.value));
for(const id of ['listMarkerSetting','priorityMarkerSetting','tagMarkerSetting'])$(`#${id}`).addEventListener('change',()=>{settingsDirty=true;updateMarkerOptions();});
for(const id of ['defaultListSetting','defaultDueSetting','defaultPrioritySetting','autoDeleteCompletedSetting','mcpSetting','themeSetting'])$(`#${id}`).addEventListener('change',()=>{settingsDirty=true;if(id==='mcpSetting'){state.settings.mcpEnabled=$('#mcpSetting').checked;renderShortcutTokens();}});
for(const id of ['syncServerSetting','syncUsernameSetting','syncPasswordSetting'])$(`#${id}`).addEventListener('input',()=>{settingsDirty=true;setCalDavStatus('setup','입력한 설정을 동기화해 확인해 주세요.');updateCalDavButton();});
$('#saveSettingsButton').addEventListener('click',async()=>{if(!updateMarkerOptions())return;const payload={defaultListId:$('#defaultListSetting').value,defaultDue:$('#defaultDueSetting').value,defaultPriority:$('#defaultPrioritySetting').value,autoDeleteCompleted:$('#autoDeleteCompletedSetting').value,mcpEnabled:$('#mcpSetting').checked,theme:$('#themeSetting').value,listMarker:$('#listMarkerSetting').value,priorityMarker:$('#priorityMarkerSetting').value,tagMarker:$('#tagMarkerSetting').value};const baseVersion=state.settings.version||1;Object.assign(state.settings,payload,{version:baseVersion+1});settingsDirty=false;render();await queueMutation('update-settings',state.user.id,baseVersion,payload);if(navigator.onLine)await syncOffline();if(!payload.mcpEnabled)state.shortcutTokens=[];renderShortcutTokens();toast('설정을 저장했어요.');});
$('#createShortcutTokenButton').addEventListener('click',async()=>{const name=$('#shortcutTokenName').value.trim();if(!name){toast('토큰 이름을 입력해 주세요.','error');$('#shortcutTokenName').focus();return;}try{const data=await api('/api/shortcut-tokens',{method:'POST',body:JSON.stringify({name,scope:$('#shortcutTokenScope').value})});state.shortcutTokens.push(data.token);renderShortcutTokens();$('#shortcutTokenValue').textContent=data.value;$('#shortcutTokenDialog').showModal();$('#shortcutTokenName').value='';}catch(error){toast(error.message,'error',6000);}});
$('#shortcutTokenList').addEventListener('click',async event=>{const button=event.target.closest('[data-revoke-shortcut-token]');if(!button)return;const row=button.closest('[data-shortcut-token-id]');try{await api(`/api/shortcut-tokens/${encodeURIComponent(row.dataset.shortcutTokenId)}`,{method:'DELETE'});state.shortcutTokens=state.shortcutTokens.filter(token=>token.id!==row.dataset.shortcutTokenId);renderShortcutTokens();toast('토큰을 폐기했어요.');}catch(error){toast(error.message,'error');}});
$('#copyShortcutTokenButton').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#shortcutTokenValue').textContent);toast('토큰을 복사했어요.');}catch{toast('복사하지 못했습니다. 토큰을 직접 선택해 주세요.','error');}});
$('#closeShortcutTokenButton').addEventListener('click',()=>{$('#shortcutTokenValue').textContent='';$('#shortcutTokenDialog').close();});
$('#caldavSyncButton').addEventListener('click',async()=>{
  if(!updateCalDavButton())return;
  const button=$('#caldavSyncButton');const password=$('#syncPasswordSetting').value;
  button.disabled=true;setCalDavStatus('syncing','CalDAV 서버와 동기화하는 중입니다…');
  try{
    const data=await api('/api/caldav/sync',{method:'POST',body:JSON.stringify({server:$('#syncServerSetting').value.trim(),username:$('#syncUsernameSetting').value.trim(),password:password===STORED_PASSWORD?'':password})});
    Object.assign(state,{user:data.user,lists:data.lists,tasks:data.tasks,settings:data.settings,notificationCount:data.notificationCount});
    settingsDirty=false;await persistOffline();render();renderSettings(true);toast('CalDAV 동기화를 완료했어요.');
  }catch(error){
    if(error.data?.settings)state.settings=error.data.settings;
    setCalDavStatus('error',error.message);updateCalDavButton();toast(`CalDAV 동기화 실패 · ${error.message}`,'error',6000);
  }
});
for(const id of ['taskSortBy','taskSortDirection'])$(`#${id}`).addEventListener('change',async()=>{const payload={sortBy:$('#taskSortBy').value,sortDirection:$('#taskSortDirection').value};const baseVersion=state.settings.version||1;Object.assign(state.settings,payload,{version:baseVersion+1});renderTasks();renderSettings();await queueMutation('update-settings',state.user.id,baseVersion,payload);});
$('#exportDataButton').addEventListener('click',()=>{try{downloadDataExport();toast('JSON 파일을 내보냈어요.');}catch(error){toast(`내보내기 실패 · ${error.message}`,'error',6000);}});
$('#importDataButton').addEventListener('click',()=>{$('#importDataFile').value='';$('#importDataFile').click();});
$('#importDataFile').addEventListener('change',async e=>{
  const file=e.target.files?.[0]; if(!file)return;
  try{
    const payload=JSON.parse(await file.text());
    if(payload?.format!=='haru-data-export'||payload?.schemaVersion!==1||!Array.isArray(payload?.lists))throw new Error('Haru JSON 내보내기 파일이 아닙니다.');
    const listCount=payload.lists.length,taskCount=payload.lists.reduce((sum,list)=>sum+(Array.isArray(list?.tasks)?list.tasks.length:0),0);
    if(!confirm(`${listCount}개 리스트와 ${taskCount}개 태스크를 현재 계정에 가져올까요? 기존 데이터는 유지됩니다.`))return;
    $('#dataTransferStatus').textContent='데이터를 가져오는 중입니다…';
    const data=await api('/api/account/import',{method:'POST',body:JSON.stringify(payload)});
    Object.assign(state,{user:data.user,lists:data.lists,tasks:data.tasks,settings:data.settings,notificationCount:data.notificationCount});
    await persistOffline();render();$('#dataTransferStatus').textContent=`${data.importedLists}개 리스트와 ${data.importedTasks}개 태스크를 복원했습니다${data.skippedTasks?` · 중복 ${data.skippedTasks}개 제외`:''}.`;
    toast('JSON 데이터를 가져왔어요.');
  }catch(error){$('#dataTransferStatus').textContent=`가져오기 실패 · ${error.message}`;toast(error.message,'error',6000);}
});
$('#resetDataButton').addEventListener('click',()=>{$('#resetDataForm').reset();$('#resetDataError').textContent='';$('#resetDataDialog').showModal();});
$('#cancelResetDataButton').addEventListener('click',()=>$('#resetDataDialog').close());
$('#resetDataForm').addEventListener('submit',async e=>{e.preventDefault();$('#resetDataError').textContent='';const values=Object.fromEntries(new FormData(e.target));try{const data=await api('/api/account/data',{method:'DELETE',body:JSON.stringify(values)});state.lists=data.lists;state.tasks=data.tasks;state.settings=data.settings;$('#resetDataDialog').close();render();selectFilter('all');toast(data.syncPending?'Haru 데이터는 초기화됐고 CalDAV 동기화를 재시도할게요.':'모든 데이터를 초기화하고 동기화했어요.');}catch(err){$('#resetDataError').textContent=err.message;}});
$('#openSidebar').addEventListener('click',()=>$('.sidebar').classList.add('open'));$('#closeSidebar').addEventListener('click',()=>$('.sidebar').classList.remove('open'));
document.addEventListener('pointerdown',e=>{const sidebar=$('.sidebar');if(matchMedia('(max-width:760px)').matches&&sidebar.classList.contains('open')&&!sidebar.contains(e.target)&&!e.target.closest('#openSidebar'))sidebar.classList.remove('open');});
$('#taskRepeat').addEventListener('change',e=>{document.querySelectorAll('.repeat-detail').forEach(el=>el.classList.add('hidden'));if(e.target.value==='weekly')$('#repeatWeekday').classList.remove('hidden');if(e.target.value==='monthly')$('#repeatMonthDay').classList.remove('hidden');if(e.target.value==='yearly')$('#repeatYearFields').classList.remove('hidden');});
$('#syncButton').addEventListener('click',async()=>{try{await refreshSnapshot();toast('동기화를 완료했어요.');}catch{}});
$('#searchButton').addEventListener('click',openSearch);
$('#closeSearchButton').addEventListener('click',()=>$('#searchDialog').close());
$('#searchInput').addEventListener('input',renderSearchResults);
$('#searchResults').addEventListener('click',e=>{const result=e.target.closest('[data-search-task]');if(!result)return;const task=state.tasks.find(item=>item.id===result.dataset.searchTask);if(!task)return;$('#searchDialog').close();selectFilter(task.completed?'completed':task.listId);requestAnimationFrame(()=>{const row=document.querySelector(`.task-row[data-id="${CSS.escape(task.id)}"]`);row?.focus();row?.scrollIntoView({block:'center',behavior:'smooth'});});});
document.addEventListener('keydown',e=>{
  if((e.code!=='KeyN'&&e.key.toLocaleLowerCase()!=='n')||e.metaKey||e.ctrlKey||e.altKey||e.isComposing||!state.user||state.user.role==='guest')return;
  const target=e.target;if(target.matches('input,textarea,select')||target.isContentEditable||document.querySelector('dialog[open]'))return;
  e.preventDefault();showScreen('taskScreen');history.replaceState(null,'',location.pathname);renderTasks();
  if(state.lists.some(list=>list.id===state.filter))$('#taskListSelect').value=state.filter;
  $('#quickInput').focus();
});
async function openNotifications(){try{const {notifications,unreadCount}=await api('/api/notifications');state.notificationCount=unreadCount;renderNotificationBadge();$('#notificationList').innerHTML=notifications.length?notifications.map(item=>{const management=`<div class="notification-manage"><button data-notification-action="read" type="button" ${item.read?'disabled':''}>${item.read?'확인됨':'확인'}</button><button data-notification-action="remove" type="button">제거</button></div>`;return item.type==='collaboration'?`<article class="notification-item collaboration-notice ${item.read?'':'unread'}" data-notification-id="${item.id}" data-collaboration-id="${item.id}"><span class="notification-icon">⇄</span><div><strong>${escapeHtml(item.collaboration.owner?.address||'')}님의 협업 요청</strong><p><b>${escapeHtml(item.collaboration.listName)}</b> 리스트에서 @로 지정된 태스크를 함께 사용하도록 초대했습니다.</p><div class="notification-actions"><button data-decision="rejected" type="button">거절</button><button class="primary-button" data-decision="approved" type="button">승인</button></div>${management}</div></article>`:`<article class="notification-item ${item.read?'':'unread'}" data-notification-id="${item.id}"><span class="notification-icon due-icon">◷</span><div><strong>${escapeHtml(item.task.title)}</strong><p>${escapeHtml(item.listName)} · ${formatDate(item.due)}</p>${management}</div></article>`;}).join(''):'<div class="notification-empty">새로운 알림이 없습니다.</div>';if(!$('#notificationDialog').open)$('#notificationDialog').showModal();}catch(err){toast(err.message);}}
$('#notificationButton').addEventListener('click',openNotifications);$('#closeNotificationButton').addEventListener('click',()=>$('#notificationDialog').close());
$('#readAllNotificationsButton').addEventListener('click',async()=>{try{await api('/api/notifications/read-all',{method:'POST'});await openNotifications();toast('모든 알림을 확인했어요.');}catch(err){toast(err.message);}});
$('#removeAllNotificationsButton').addEventListener('click',async()=>{try{await api('/api/notifications',{method:'DELETE'});await openNotifications();toast('모든 알림을 제거했어요.');}catch(err){toast(err.message);}});
$('#notificationList').addEventListener('click',async e=>{const action=e.target.closest('[data-notification-action]');if(action){const item=action.closest('[data-notification-id]');try{await api(`/api/notifications/${encodeURIComponent(item.dataset.notificationId)}`,{method:action.dataset.notificationAction==='remove'?'DELETE':'PATCH'});await openNotifications();toast(action.dataset.notificationAction==='remove'?'알림을 제거했어요.':'알림을 확인했어요.');}catch(err){toast(err.message);}return;}const button=e.target.closest('[data-decision]');if(!button)return;const item=button.closest('[data-collaboration-id]');try{await api(`/api/collaborations/${item.dataset.collaborationId}/respond`,{method:'POST',body:JSON.stringify({decision:button.dataset.decision})});const data=await api('/api/bootstrap');Object.assign(state,data);render();await openNotifications();toast(button.dataset.decision==='approved'?'협업 요청을 승인했어요.':'협업 요청을 거절했어요.');}catch(err){toast(err.message);}});
let installPrompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installButton').classList.remove('hidden');});$('#installButton').addEventListener('click',async()=>{await installPrompt?.prompt();installPrompt=null;$('#installButton').classList.add('hidden');});
themeMedia.addEventListener('change',()=>{if((state.settings?.theme||localStorage.getItem('haru-theme')||'system')==='system')applyTheme('system');});
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' });
  navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='CACHE_UPDATED'&&event.data.version!==CLIENT_VERSION)forceAppUpdate(event.data.version);});
}
window.addEventListener('online',()=>{if(state.user)syncOffline().catch(()=>{});});
setInterval(()=>{if(state.user&&!document.hidden)refreshSnapshot().catch(()=>{});},15000);
document.addEventListener('visibilitychange',()=>{if(state.user&&!document.hidden)refreshSnapshot().catch(()=>{});});
window.addEventListener('beforeunload',()=>realtimeSource?.close());
bootstrap();
