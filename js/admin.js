/**
 * 分類查詢 - 管理後台邏輯
 * 負責：登入驗證（總管理員/單位管理員）、活動 CRUD、分類欄位、顯示欄位、
 *       分類密碼生成、密碼變更、單位管理
 */

// 狀態
let adminPassword = '';
let adminRole = 'admin';     // 'admin' | 'unit'
let adminUnit = null;        // 單位管理員的單位 { id, name }
let adminUnits = [];         // 總管理員可見的單位清單
let activities = [];
let availableFields = [];   // 從試算表讀取的欄位
let categoryValues = [];    // 分類欄位的所有唯一值
let editingActivityId = null;
let pendingProtected = {};  // 目前編輯中活動的分類密碼 { 分類: 密碼 }
let selectedFields = [];    // 顯示欄位排序清單（勾選 + 順序）
let defaultSortField = '';  // 預設排序欄位（需為勾選的顯示欄位之一）
let defaultSortDir = 'asc'; // 預設排序方向：asc / desc

// CSS.escape fallback（用於 selector 建構）
const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? s => CSS.escape(s) : s => String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);

// DOM
const loginSection = document.getElementById('loginSection');
const adminPanel = document.getElementById('adminPanel');
const loginRoleSelect = document.getElementById('loginRole');
const loginUnitGroup = document.getElementById('loginUnitGroup');
const loginUnitSelect = document.getElementById('loginUnit');
const adminPwdInput = document.getElementById('adminPwd');
const btnLogin = document.getElementById('btnLogin');
const loginHint = document.getElementById('loginHint');

const activityListEl = document.getElementById('activityList');
const btnAddActivity = document.getElementById('btnAddActivity');
const panelTitleEl = document.getElementById('panelTitle');
const loginRoleHintEl = document.getElementById('loginRoleHint');
const modal = document.getElementById('activityModal');
const modalTitle = document.getElementById('modalTitle');
const editActivityIdInput = document.getElementById('editActivityId');
const actNameInput = document.getElementById('actName');
const actUnitGroup = document.getElementById('actUnitGroup');
const actUnitSelect = document.getElementById('actUnit');
const actAccessKeyInput = document.getElementById('actAccessKey');
const actSheetUrlInput = document.getElementById('actSheetUrl');
const actSheetNameInput = document.getElementById('actSheetName');
const actCategoryField = document.getElementById('actCategoryField');
const fieldSortListEl = document.getElementById('fieldSortList');
const fieldSortHintEl = document.getElementById('fieldSortHint');
const actDefaultSortField = document.getElementById('actDefaultSortField');
const actDefaultSortDir = document.getElementById('actDefaultSortDir');
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

const unitAdminCard = document.getElementById('unitAdminCard');
const newUnitName = document.getElementById('newUnitName');
const newUnitPwd = document.getElementById('newUnitPwd');
const btnCreateUnit = document.getElementById('btnCreateUnit');
const unitListEl = document.getElementById('unitList');
const unitHintEl = document.getElementById('unitHint');
const changePwdCard = document.getElementById('changePwdCard');

// 初始化
function init() {
  btnLogin.addEventListener('click', handleLogin);
  adminPwdInput.addEventListener('keydown', e => e.key === 'Enter' && handleLogin());
  loginRoleSelect.addEventListener('change', handleLoginRoleChange);

  btnAddActivity.addEventListener('click', () => openModal());
  modalCloseBtn.addEventListener('click', () => closeModal());
  modal.addEventListener('click', e => e.target === modal && closeModal());
  btnTestConnection.addEventListener('click', handleTestConnection);
  actCategoryField.addEventListener('change', handleCategoryFieldChange);
  btnSaveActivity.addEventListener('click', handleSaveActivity);

  btnChangePwd.addEventListener('click', handleChangePassword);
  btnCreateUnit.addEventListener('click', handleCreateUnit);
}

// 登入角色切換
function handleLoginRoleChange() {
  const isUnit = loginRoleSelect.value === 'unit';
  loginUnitGroup.style.display = isUnit ? 'block' : 'none';
  adminPwdInput.placeholder = isUnit ? '單位管理密碼' : '總管理員密碼';
  if (isUnit) loadUnitsForLogin();
}

// 載入單位清單供登入下拉選單（公開端點，不需密碼）
async function loadUnitsForLogin() {
  try {
    const res = await api('listUnitsPublic');
    if (!res.ok || !res.units) throw new Error(res.error || '載入單位失敗');
    loginUnitSelect.innerHTML = res.units.length
      ? res.units.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('')
      : '<option value="">（尚無單位，請先請總管理員建立）</option>';
  } catch (err) {
    loginUnitSelect.innerHTML = '<option value="">（載入失敗，請稍後再試）</option>';
  }
}

// 登入
async function handleLogin() {
  const pwd = adminPwdInput.value.trim();
  if (!pwd) { showHint(loginHint, '請輸入密碼', true); return; }

  const role = loginRoleSelect.value;
  const unitId = role === 'unit' ? loginUnitSelect.value : '';
  if (role === 'unit' && !unitId) { showHint(loginHint, '請選擇單位', true); return; }

  btnLogin.disabled = true; btnLogin.textContent = '驗證中…';
  try {
    let res;
    if (role === 'unit') {
      res = await api('unit_login', { unit: unitId, pwd });
    } else {
      res = await api('admin_login', { pwd });
    }
    if (!res.ok) throw new Error(res.error || '密碼錯誤');
    adminPassword = pwd;
    adminRole = role;
    adminUnit = role === 'unit' ? res.unit : null;
    showHint(loginHint, res.firstTime ? '首次登入，密碼已設定' : '登入成功', false);
    loginSection.style.display = 'none';
    adminPanel.style.display = 'block';
    applyRoleUI();
    await loadActivities();
  } catch (err) {
    showHint(loginHint, err.message, true);
  } finally {
    btnLogin.disabled = false; btnLogin.textContent = '登入';
  }
}

// 依登入角色調整 UI
function applyRoleUI() {
  const isAdmin = adminRole === 'admin';
  panelTitleEl.textContent = isAdmin ? '活動管理' : `活動管理（${adminUnit ? adminUnit.name : ''}）`;
  loginRoleHintEl.textContent = isAdmin
    ? '總管理員：可管理所有活動與單位'
    : `單位管理員：僅能管理「${adminUnit ? adminUnit.name : ''}」的活動`;
  unitAdminCard.style.display = isAdmin ? 'block' : 'none';
  actUnitGroup.style.display = isAdmin ? 'block' : 'none';
  // 單位管理員無法自行變更密碼（由總管理員重設），隱藏變更卡片
  changePwdCard.style.display = isAdmin ? 'block' : 'none';
  if (!isAdmin) {
    actUnitSelect.innerHTML = `<option value="${escapeHtml(adminUnit.id)}">${escapeHtml(adminUnit.name)}</option>`;
  } else if (adminUnits.length > 0) {
    actUnitSelect.innerHTML = '<option value="">（公開，所有訪客可見）</option>' +
      adminUnits.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
  }
}

// 載入活動列表
async function loadActivities() {
  try {
    const params = { pwd: adminPassword };
    if (adminRole === 'unit') {
      params.unit = adminUnit.id;
      params.unitPwd = adminPassword;
    }
    const res = await api('getConfig', params);
    if (!res.ok) throw new Error(res.error || '載入失敗');
    activities = res.config?.activities || [];
    adminUnits = res.config?.units || [];
    renderActivityList();
    if (adminRole === 'admin') renderUnitList();
  } catch (err) {
    console.error('載入活動失敗:', err);
    activityListEl.innerHTML = `<li class="hint error">載入失敗：${err.message}</li>`;
  }
}

// 建立單位
async function handleCreateUnit() {
  const name = newUnitName.value.trim();
  const unitPwd = newUnitPwd.value.trim();
  if (!name) { showHint(unitHintEl, '請輸入單位名稱', true); return; }
  if (unitPwd.length < 6) { showHint(unitHintEl, '單位管理密碼至少 6 碼', true); return; }
  btnCreateUnit.disabled = true; btnCreateUnit.textContent = '建立中…';
  try {
    const res = await api('createUnit', { pwd: adminPassword, name, unitAdminPwd: unitPwd });
    if (!res.ok) throw new Error(res.error);
    newUnitName.value = ''; newUnitPwd.value = '';
    showHint(unitHintEl, `單位「${res.name}」已建立，單位 Token：${res.token}`, false);
    await loadActivities();
  } catch (err) {
    showHint(unitHintEl, err.message, true);
  } finally {
    btnCreateUnit.disabled = false; btnCreateUnit.textContent = '建立單位';
  }
}

// 渲染單位清單
function renderUnitList() {
  if (!adminUnits || adminUnits.length === 0) {
    unitListEl.innerHTML = '<li class="hint">尚無單位。</li>';
    return;
  }
  unitListEl.innerHTML = adminUnits.map(u => `
    <li class="activity-item">
      <div class="activity-item-info">
        <span class="activity-item-name">${escapeHtml(u.name)}</span>
        <span class="activity-item-meta">
          單位 ID：<code style="word-break:break-all;">${escapeHtml(u.id)}</code>
          · 活動數: ${u.activityCount ?? 0}
          ${u.token ? ` · Token: <code style="word-break:break-all;">${escapeHtml(u.token)}</code>` : ''}
        </span>
      </div>
      <div class="activity-item-actions">
        <button class="btn btn-secondary btn-sm" data-unit-pwd="${escapeHtml(u.id)}">重設密碼</button>
        <button class="btn btn-danger btn-sm" data-unit-del="${escapeHtml(u.id)}">刪除</button>
      </div>
    </li>
  `).join('');

  unitListEl.querySelectorAll('[data-unit-pwd]').forEach(btn =>
    btn.addEventListener('click', () => resetUnitPassword(btn.dataset.unitPwd))
  );
  unitListEl.querySelectorAll('[data-unit-del]').forEach(btn =>
    btn.addEventListener('click', () => deleteUnit(btn.dataset.unitDel))
  );
}

// 重設單位密碼
async function resetUnitPassword(unitId) {
  const newPwd = prompt('請輸入新的單位管理密碼（至少 6 碼）：');
  if (!newPwd) return;
  if (newPwd.length < 6) { alert('密碼至少 6 碼'); return; }
  try {
    const res = await api('setUnitPassword', { pwd: adminPassword, id: unitId, newPwd });
    if (!res.ok) throw new Error(res.error);
    alert('單位密碼已更新');
  } catch (err) {
    alert('重設失敗：' + err.message);
  }
}

// 刪除單位
async function deleteUnit(unitId) {
  if (!confirm('確定要刪除這個單位嗎？僅能刪除無活動的單位。')) return;
  try {
    const res = await api('deleteUnit', { pwd: adminPassword, id: unitId });
    if (!res.ok) throw new Error(res.error);
    await loadActivities();
  } catch (err) {
    alert('刪除失敗：' + err.message);
  }
}

// 渲染活動列表
function renderActivityList() {
  if (activities.length === 0) {
    activityListEl.innerHTML = '<li class="hint">尚無活動，點擊「＋ 新增活動」開始</li>';
    return;
  }
  activityListEl.innerHTML = activities.map(act => {
    const lockedCount = Object.keys(act.protectedCategories || {}).length;
    const unitName = (adminUnits.find(u => u.id === act.unit)?.name) || (adminRole === 'unit' && act.unit === adminUnit.id ? adminUnit.name : '');
    const unitTag = act.unit
      ? `<span class="tag">${escapeHtml(unitName || act.unit)}</span>`
      : '<span class="tag tag-ghost">公開</span>';
    const keyTag = act.accessKey
      ? '<span class="tag">金鑰保護</span>'
      : '';
    return `
    <li class="activity-item">
      <div class="activity-item-info">
        <span class="activity-item-name">${escapeHtml(act.name)} ${unitTag} ${keyTag}</span>
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
      if (adminRole === 'admin') {
        if (act.unit) actUnitSelect.value = act.unit;
        else actUnitSelect.value = '';
      }
      actAccessKeyInput.value = act.accessKey || '';
      actSheetUrlInput.value = act.sheetUrl || '';
      actSheetNameInput.value = act.sheetName || '';
      pendingProtected = { ...(act.protectedCategories || {}) };
      defaultSortField = act.defaultSortField || '';
      defaultSortDir = act.defaultSortDir || 'asc';
      // 顯示欄位：依活動既有的 displayFields 順序建立選取與排序
      const existing = act.displayFields || [];
      selectedFields = existing.length ? [...existing] : [];
      handleTestConnection(true).then(() => {
        actCategoryField.value = act.categoryField || '';
        // 若 selectedFields 尚未建立（活動無顯示欄位），預設全選
        if (existing.length === 0) {
          selectedFields = [...availableFields];
        } else {
          // 補上試算表新增的欄位（排在後方）
          availableFields.forEach(f => { if (!selectedFields.includes(f)) selectedFields.push(f); });
        }
        renderFieldSortList();
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
  if (adminRole === 'admin') actUnitSelect.value = '';
  actAccessKeyInput.value = '';
  actSheetUrlInput.value = '';
  actSheetNameInput.value = '';
  actCategoryField.innerHTML = '<option value="">（請先測試連線取得欄位）</option>';
  fieldSortListEl.innerHTML = '';
  fieldSortHintEl.textContent = '';
  categoryPwdListEl.innerHTML = '';
  catPwdHintEl.textContent = '';
  availableFields = [];
  categoryValues = [];
  pendingProtected = {};
  selectedFields = [];
  defaultSortField = '';
  defaultSortDir = 'asc';
  connectionHint.textContent = '';
  connectionHint.className = 'hint';
}

// 測試連線並取得欄位
async function handleTestConnection(silent = false) {
  const url = actSheetUrlInput.value.trim();
  if (!url) { showHint(connectionHint, '請先輸入試算表網址', true); return; }
  if (!silent) { btnTestConnection.disabled = true; btnTestConnection.textContent = '測試中…'; }
  try {
    const res = await api('testConnection', { url, ...authParams() });
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

  // 顯示欄位排序清單
  renderFieldSortList();
}

// 渲染顯示欄位排序清單（勾選 + 上移/下移）
function renderFieldSortList() {
  if (availableFields.length === 0) {
    fieldSortListEl.innerHTML = '<li class="hint">請先測試連線以取得欄位清單</li>';
    return;
  }

  // 確保 selectedFields 與 availableFields 同步（保留既有選取與順序）
  const selectedSet = new Set(selectedFields);
  selectedFields = selectedFields.filter(f => availableFields.includes(f));
  availableFields.forEach(f => { if (!selectedFields.includes(f)) selectedFields.push(f); });

  fieldSortListEl.innerHTML = selectedFields.map((f, i) => `
    <li class="field-sort-item" data-field="${escapeHtml(f)}">
      <label>
        <input type="checkbox" data-check="${escapeHtml(f)}" ${selectedSet.has(f) ? 'checked' : ''}>
        ${escapeHtml(f)}
      </label>
      <div class="sort-btns">
        <button type="button" class="btn btn-secondary btn-icon" data-up="${escapeHtml(f)}" aria-label="上移 ${escapeHtml(f)}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn btn-secondary btn-icon" data-down="${escapeHtml(f)}" aria-label="下移 ${escapeHtml(f)}" ${i === selectedFields.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
    </li>
  `).join('');

  // 勾選切換：加入/移出顯示欄位
  fieldSortListEl.querySelectorAll('[data-check]').forEach(cb =>
    cb.addEventListener('change', () => {
      const f = cb.dataset.check;
      const idx = selectedFields.indexOf(f);
      if (cb.checked) {
        if (idx < 0) selectedFields.push(f);
      } else {
        if (idx >= 0) selectedFields.splice(idx, 1);
      }
      updateFieldSortHint();
      renderSortFieldOptions();
    })
  );

  // 上移 / 下移
  fieldSortListEl.querySelectorAll('[data-up]').forEach(btn =>
    btn.addEventListener('click', () => moveField(btn.dataset.up, -1))
  );
  fieldSortListEl.querySelectorAll('[data-down]').forEach(btn =>
    btn.addEventListener('click', () => moveField(btn.dataset.down, 1))
  );

  updateFieldSortHint();
  renderSortFieldOptions();
}

// 渲染「預設排序欄位」下拉（僅列出勾選的顯示欄位）
function renderSortFieldOptions() {
  if (!actDefaultSortField) return;
  const checked = selectedFields.filter(f => {
    const cb = fieldSortListEl.querySelector(`[data-check="${cssEsc(f)}"]`);
    return cb && cb.checked;
  });

  const dir = actDefaultSortDir.value === 'desc' ? 'desc' : 'asc';
  actDefaultSortDir.value = defaultSortDir === 'desc' ? 'desc' : 'asc';

  // 若目前的預設排序欄位不在勾選清單中，重設為空
  if (defaultSortField && !checked.includes(defaultSortField)) {
    defaultSortField = '';
  }

  actDefaultSortField.innerHTML =
    '<option value="">（不排序，依原始順序）</option>' +
    checked.map(f => `<option value="${escapeHtml(f)}" ${f === defaultSortField ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');
}

// 調整欄位順序
function moveField(field, dir) {
  const idx = selectedFields.indexOf(field);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= selectedFields.length) return;
  const tmp = selectedFields[idx];
  selectedFields[idx] = selectedFields[target];
  selectedFields[target] = tmp;
  renderFieldSortList();
}

// 更新排序提示
function updateFieldSortHint() {
  const checked = selectedFields.filter(f => {
    const cb = fieldSortListEl.querySelector(`[data-check="${cssEsc(f)}"]`);
    return cb && cb.checked;
  });
  fieldSortHintEl.textContent = checked.length
    ? `已選 ${checked.length} 個欄位：${checked.join(' → ')}`
    : '尚未勾選任何欄位';
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
    const res = await api('getCategoryValues', { url, field, ...authParams() });
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

// 依登入角色回傳後端權限參數
function authParams() {
  if (adminRole === 'unit') return { unit: adminUnit.id, unitPwd: adminPassword };
  return { pwd: adminPassword };
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
      const res = await api('generateCategoryPassword', { act: actId, cat, ...authParams() });
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
  const displayFields = selectedFields.filter(f => {
    const cb = fieldSortListEl.querySelector(`[data-check="${cssEsc(f)}"]`);
    return cb && cb.checked;
  });

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
      protectedCategories: pendingProtected,
      defaultSortField: actDefaultSortField.value || '',
      defaultSortDir: actDefaultSortDir.value === 'desc' ? 'desc' : 'asc',
      accessKey: actAccessKeyInput.value.trim() || ''
    };
    // 總管理員可指定所屬單位
    if (adminRole === 'admin') data.unit = actUnitSelect.value;
    const res = await api('saveActivity', { ...authParams(), data: JSON.stringify(data) });
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
    const res = await api('deleteActivity', { ...authParams(), id });
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
