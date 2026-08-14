/**
 * 分類查詢 - 管理後台邏輯
 * 負責：登入驗證、活動 CRUD、分類欄位、顯示欄位、分類密碼生成、密碼變更
 */

// 狀態
let adminPassword = '';
let activities = [];
let availableFields = [];   // 從試算表讀取的欄位
let categoryValues = [];    // 分類欄位的所有唯一值
let editingActivityId = null;
let pendingProtected = {};  // 目前編輯中活動的分類密碼 { 分類: 密碼 }

// DOM
const loginSection = document.getElementById('loginSection');
const adminPanel = document.getElementById('adminPanel');
const adminPwdInput = document.getElementById('adminPwd');
const btnLogin = document.getElementById('btnLogin');
const loginHint = document.getElementById('loginHint');

const activityListEl = document.getElementById('activityList');
const btnAddActivity = document.getElementById('btnAddActivity');
const modal = document.getElementById('activityModal');
const modalTitle = document.getElementById('modalTitle');
const editActivityIdInput = document.getElementById('editActivityId');
const actNameInput = document.getElementById('actName');
const actSheetUrlInput = document.getElementById('actSheetUrl');
const actSheetNameInput = document.getElementById('actSheetName');
const actCategoryField = document.getElementById('actCategoryField');
const fieldCheckboxesEl = document.getElementById('fieldCheckboxes');
const categoryPwdListEl = document.getElementById('categoryPwdList');
const catPwdHintEl = document.getElementById('catPwdHint');
const btnTestConnection = document.getElementById('btnTestConnection');
const connectionHint = document.getElementById('connectionHint');
const btnSaveActivity = document.getElementById('btnSaveActivity');
const modalCloseBtn = modal.querySelector('.modal-close');

const oldPwdInput = document.getElementById('oldPwd');
const newPwdInput = document.getElementById('newPwd');
const btnChangePwd = document.getElementById('btnChangePwd');
const pwdHint = document.getElementById('pwdHint');

// 初始化
function init() {
  btnLogin.addEventListener('click', handleLogin);
  adminPwdInput.addEventListener('keydown', e => e.key === 'Enter' && handleLogin());

  btnAddActivity.addEventListener('click', () => openModal());
  modalCloseBtn.addEventListener('click', () => closeModal());
  modal.addEventListener('click', e => e.target === modal && closeModal());
  btnTestConnection.addEventListener('click', handleTestConnection);
  actCategoryField.addEventListener('change', handleCategoryFieldChange);
  btnSaveActivity.addEventListener('click', handleSaveActivity);

  btnChangePwd.addEventListener('click', handleChangePassword);
}

// 登入
async function handleLogin() {
  const pwd = adminPwdInput.value.trim();
  if (!pwd) { showHint(loginHint, '請輸入密碼', true); return; }
  btnLogin.disabled = true; btnLogin.textContent = '驗證中…';
  try {
    const res = await api('admin_login', { pwd });
    if (!res.ok) throw new Error(res.error || '密碼錯誤');
    adminPassword = pwd;
    showHint(loginHint, res.firstTime ? '首次登入，密碼已設定' : '登入成功', false);
    loginSection.style.display = 'none';
    adminPanel.style.display = 'block';
    await loadActivities();
  } catch (err) {
    showHint(loginHint, err.message, true);
  } finally {
    btnLogin.disabled = false; btnLogin.textContent = '登入';
  }
}

// 載入活動列表
async function loadActivities() {
  try {
    const res = await api('getConfig', { pwd: adminPassword });
    if (!res.ok) throw new Error(res.error || '載入失敗');
    activities = res.config?.activities || [];
    renderActivityList();
  } catch (err) {
    console.error('載入活動失敗:', err);
    activityListEl.innerHTML = `<li class="hint error">載入失敗：${err.message}</li>`;
  }
}

function renderActivityList() {
  if (activities.length === 0) {
    activityListEl.innerHTML = '<li class="hint">尚無活動，點擊「＋ 新增活動」開始</li>';
    return;
  }
  activityListEl.innerHTML = activities.map(act => {
    const lockedCount = Object.keys(act.protectedCategories || {}).length;
    return `
    <li class="activity-item">
      <div class="activity-item-info">
        <span class="activity-item-name">${escapeHtml(act.name)}</span>
        <span class="activity-item-meta">
          分類欄位: ${escapeHtml(act.categoryField || '（無）')} · 顯示欄位: ${(act.displayFields || []).join(', ') || '（無）'} · 鎖定分類: ${lockedCount} 個
        </span>
      </div>
      <div class="activity-item-actions">
        <button class="btn btn-secondary btn-sm" data-edit="${act.id}">編輯</button>
        <button class="btn btn-danger btn-sm" data-delete="${act.id}">刪除</button>
      </div>
    </li>
  `;
  }).join('');

  activityListEl.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => openModal(btn.dataset.edit))
  );
  activityListEl.querySelectorAll('[data-delete]').forEach(btn =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.delete))
  );
}

// Modal 開啟/關閉
function openModal(actId = null) {
  editingActivityId = actId;
  modalTitle.textContent = actId ? '編輯活動' : '新增活動';
  resetModalForm();
  if (actId) {
    const act = activities.find(a => a.id === actId);
    if (act) {
      editActivityIdInput.value = act.id;
      actNameInput.value = act.name;
      actSheetUrlInput.value = act.sheetUrl || '';
      actSheetNameInput.value = act.sheetName || '';
      pendingProtected = { ...(act.protectedCategories || {}) };
      handleTestConnection(true).then(() => {
        actCategoryField.value = act.categoryField || '';
        fieldCheckboxesEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = (act.displayFields || []).includes(cb.value);
        });
        updateCategoryValues();
        renderCategoryPwdList();
      });
    }
  }
  modal.showModal();
}

function closeModal() {
  modal.close();
  resetModalForm();
  editingActivityId = null;
  pendingProtected = {};
}

function resetModalForm() {
  editActivityIdInput.value = '';
  actNameInput.value = '';
  actSheetUrlInput.value = '';
  actSheetNameInput.value = '';
  actCategoryField.innerHTML = '<option value="">（請先測試連線取得欄位）</option>';
  fieldCheckboxesEl.innerHTML = '';
  categoryPwdListEl.innerHTML = '';
  catPwdHintEl.textContent = '';
  availableFields = [];
  categoryValues = [];
  pendingProtected = {};
  connectionHint.textContent = '';
  connectionHint.className = 'hint';
}

// 測試連線並取得欄位
async function handleTestConnection(silent = false) {
  const url = actSheetUrlInput.value.trim();
  if (!url) { showHint(connectionHint, '請先輸入試算表網址', true); return; }
  if (!silent) { btnTestConnection.disabled = true; btnTestConnection.textContent = '測試中…'; }
  try {
    const res = await api('testConnection', { url, pwd: adminPassword });
    if (!res.ok) throw new Error(res.error);
    availableFields = res.fields || [];
    renderFieldOptions();
    if (!silent) showHint(connectionHint, `連線成功！取得 ${availableFields.length} 個欄位（工作表：${res.sheetName}）`, false);
  } catch (err) {
    if (!silent) showHint(connectionHint, err.message, true);
    availableFields = [];
    renderFieldOptions();
  } finally {
    if (!silent) { btnTestConnection.disabled = false; btnTestConnection.textContent = '測試連線並取得欄位'; }
  }
}

function renderFieldOptions() {
  // 分類欄位下拉
  actCategoryField.innerHTML = availableFields.length
    ? `<option value="">（請選擇分類欄位）</option>` + availableFields.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')
    : '<option value="">（請先測試連線取得欄位）</option>';

  // 顯示欄位勾選
  if (availableFields.length === 0) {
    fieldCheckboxesEl.innerHTML = '<p class="hint">請先測試連線以取得欄位清單</p>';
    return;
  }
  fieldCheckboxesEl.innerHTML = availableFields.map(f => `
    <label><input type="checkbox" value="${escapeHtml(f)}"> ${escapeHtml(f)}</label>
  `).join('');
}

// 分類欄位變更
function handleCategoryFieldChange() {
  updateCategoryValues();
  renderCategoryPwdList();
}

// 依試算表資料取得分類欄位的唯一值
async function updateCategoryValues() {
  const field = actCategoryField.value;
  categoryValues = [];
  if (!field) { renderCategoryPwdList(); return; }
  const url = actSheetUrlInput.value.trim();
  const sheetId = url ? extractSheetId(url) : null;
  if (!sheetId) return;
  try {
    const res = await api('getCategoryValues', { url, field, pwd: adminPassword });
    if (res.ok) categoryValues = res.values || [];
  } catch (err) {
    // 若 action 未實作或失敗，改用分類密碼既有值 + 無清單
    console.error('取得分類值失敗:', err);
  }
  renderCategoryPwdList();
}

// 渲染分類密碼鎖清單
function renderCategoryPwdList() {
  const field = actCategoryField.value;
  if (!field) {
    categoryPwdListEl.innerHTML = '<p class="hint">請先選擇分類欄位。</p>';
    return;
  }

  // 合併：資料中的分類值 + 已鎖定的分類
  const names = new Set(categoryValues);
  Object.keys(pendingProtected).forEach(k => names.add(k));
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh-TW'));

  if (sorted.length === 0) {
    categoryPwdListEl.innerHTML = '<p class="hint">此欄位尚無分類值。</p>';
    return;
  }

  categoryPwdListEl.innerHTML = sorted.map(name => {
    const hasPwd = pendingProtected[name] != null;
    return `
    <div class="cat-pwd-row ${hasPwd ? 'locked' : ''}">
      <span class="cat-pwd-name">${escapeHtml(name)}</span>
      <div class="cat-pwd-controls">
        <span class="cat-pwd-value">${hasPwd ? escapeHtml(pendingProtected[name]) : '未鎖定'}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-gen="${escapeHtml(name)}">${hasPwd ? '重新生成' : '生成密碼'}</button>
        ${hasPwd ? `<button type="button" class="btn btn-danger btn-sm" data-clear="${escapeHtml(name)}">解除</button>` : ''}
        <button type="button" class="btn btn-secondary btn-sm" data-link="${escapeHtml(name)}">複製連結</button>
      </div>
    </div>
  `;
  }).join('');

  categoryPwdListEl.querySelectorAll('[data-gen]').forEach(btn =>
    btn.addEventListener('click', () => generatePasswordFor(btn.dataset.gen))
  );
  categoryPwdListEl.querySelectorAll('[data-clear]').forEach(btn =>
    btn.addEventListener('click', () => { delete pendingProtected[btn.dataset.clear]; renderCategoryPwdList(); })
  );
  categoryPwdListEl.querySelectorAll('[data-link]').forEach(btn =>
    btn.addEventListener('click', () => copyCategoryLink(btn.dataset.link))
  );
}

// 複製單一分類的專屬查詢網址
function copyCategoryLink(cat) {
  const actId = editActivityIdInput.value || '';
  if (!actId) { showHint(catPwdHintEl, '請先儲存活動後再複製分類連結', true); return; }
  const base = location.href.split('?')[0].replace(/admin\.html.*$/, 'index.html');
  const url = `${base}?act=${encodeURIComponent(actId)}&cat=${encodeURIComponent(cat)}`;
  navigator.clipboard.writeText(url).then(() => {
    showHint(catPwdHintEl, `已複製「${cat}」專屬網址`, false);
  }).catch(() => {
    showHint(catPwdHintEl, '複製失敗，請手動複製：' + url, true);
  });
}

// 生成分類密碼（呼叫後端產生，系統給定）
async function generatePasswordFor(cat) {
  const actId = editActivityIdInput.value || 'NEW';
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    // 後端需要既有活動 ID；若為新增，先在本地生成
    if (actId === 'NEW') {
      pendingProtected[cat] = genLocalPassword();
    } else {
      const res = await api('generateCategoryPassword', { act: actId, cat, pwd: adminPassword });
      if (!res.ok) throw new Error(res.error);
      pendingProtected[cat] = res.password;
      // 同步更新活動列表
      const act = activities.find(a => a.id === actId);
      if (act) { act.protectedCategories = act.protectedCategories || {}; act.protectedCategories[cat] = res.password; }
    }
    renderCategoryPwdList();
  } catch (err) {
    showHint(catPwdHintEl, err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function genLocalPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 6; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  return pwd;
}

// 儲存活動
async function handleSaveActivity() {
  const name = actNameInput.value.trim();
  const sheetUrl = actSheetUrlInput.value.trim();
  const sheetName = actSheetNameInput.value.trim();
  const categoryField = actCategoryField.value;
  const displayFields = Array.from(fieldCheckboxesEl.querySelectorAll('input:checked')).map(cb => cb.value);

  if (!name) { alert('請輸入活動名稱'); return; }
  if (!sheetUrl) { alert('請輸入試算表網址'); return; }
  if (!categoryField) { alert('請選擇分類欄位'); return; }
  if (displayFields.length === 0) { alert('請至少勾選一個顯示欄位'); return; }

  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) { alert('無法解析試算表 ID，請確認網址格式'); return; }

  btnSaveActivity.disabled = true; btnSaveActivity.textContent = '儲存中…';
  try {
    const data = {
      id: editingActivityId || undefined,
      name,
      sheetId,
      sheetName: sheetName || undefined,
      sheetUrl,
      categoryField,
      displayFields,
      protectedCategories: pendingProtected
    };
    const res = await api('saveActivity', { pwd: adminPassword, data: JSON.stringify(data) });
    if (!res.ok) throw new Error(res.error);
    closeModal();
    await loadActivities();
  } catch (err) {
    alert('儲存失敗：' + err.message);
  } finally {
    btnSaveActivity.disabled = false; btnSaveActivity.textContent = '儲存';
  }
}

// 刪除活動
async function handleDelete(id) {
  if (!confirm('確定要刪除這個活動嗎？此操作無法復原。')) return;
  try {
    const res = await api('deleteActivity', { pwd: adminPassword, id });
    if (!res.ok) throw new Error(res.error);
    await loadActivities();
  } catch (err) {
    alert('刪除失敗：' + err.message);
  }
}

// 變更密碼
async function handleChangePassword() {
  const oldPwd = oldPwdInput.value;
  const newPwd = newPwdInput.value;
  if (!oldPwd || !newPwd) { showHint(pwdHint, '請填寫舊密碼與新密碼', true); return; }
  if (newPwd.length < 6) { showHint(pwdHint, '新密碼至少 6 碼', true); return; }
  btnChangePwd.disabled = true; btnChangePwd.textContent = '更新中…';
  try {
    const res = await api('changePassword', { pwd: adminPassword, oldPwd, newPwd });
    if (!res.ok) throw new Error(res.error);
    adminPassword = newPwd;
    oldPwdInput.value = ''; newPwdInput.value = '';
    showHint(pwdHint, '密碼已更新', false);
  } catch (err) {
    showHint(pwdHint, err.message, true);
  } finally {
    btnChangePwd.disabled = false; btnChangePwd.textContent = '更新密碼';
  }
}

// API 統一呼叫
async function api(action, params = {}) {
  const url = new URL(CONFIG.GAS_URL);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// 工具
function extractSheetId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showHint(el, msg, isError) {
  el.textContent = msg;
  el.className = 'hint' + (isError ? ' error' : ' success');
}

// 啟動
document.addEventListener('DOMContentLoaded', init);
