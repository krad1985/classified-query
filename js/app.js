/**
 * 分類查詢 - 前端主程式
 * 負責：活動分頁、分類過濾、密碼鎖解鎖、表格渲染、關鍵字篩選、網址參數分享
 */

// 狀態
let activities = [];            // [{id, name}]
let currentActivityId = null;
let activityInfo = null;        // { name, categoryField, displayFields }
let categories = [];            // [{name, count, locked}]
let currentCategory = '';       // '' 表示全部（僅未鎖定）
let currentData = { fields: [], rows: [] };
let publicToken = null;

// 已解鎖的分類密碼（session）
const unlockedCats = new Map(); // name -> password

// DOM
const tabsEl = document.getElementById('activityTabs');
const categoryBarEl = document.getElementById('categoryBar');
const categoryLabelEl = document.getElementById('categoryLabel');
const categoryTabsEl = document.getElementById('categoryTabs');
const btnCopyLink = document.getElementById('btnCopyLink');
const categorySearchInput = document.getElementById('categorySearch');
const searchBarEl = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
const resultCountEl = document.getElementById('resultCount');
const btnExportCsv = document.getElementById('btnExportCsv');
const tableHeadEl = document.getElementById('tableHead');
const tableBodyEl = document.getElementById('tableBody');
const emptyStateEl = document.getElementById('emptyState');
const tableWrapperEl = document.getElementById('tableWrapper');
const lastUpdatedEl = document.getElementById('lastUpdated');
const pwdModal = document.getElementById('pwdModal');
const pwdModalTitle = document.getElementById('pwdModalTitle');
const pwdModalDesc = document.getElementById('pwdModalDesc');
const pwdModalHint = document.getElementById('pwdModalHint');
const categoryPwdInput = document.getElementById('categoryPwdInput');

// 分類搜尋關鍵字（本地過濾，不影響後端）
let categoryFilter = '';

// 目標分類（等待解鎖）
let pendingCategory = null;

// 初始化
async function init() {
  try {
    const params = new URLSearchParams(location.search);
    const urlAct = params.get('act');
    const urlCat = params.get('cat');

    await loadActivities();

    // 活動選擇
    if (urlAct && activities.some(a => a.id === urlAct)) {
      currentActivityId = urlAct;
    } else {
      currentActivityId = activities[0]?.id || null;
    }

    if (currentActivityId) {
      await loadActivityInfo(currentActivityId);
      currentCategory = (urlCat && categories.some(c => c.name === urlCat)) ? urlCat : '';
      await switchCategory(currentCategory);
      // 若網址指定了鎖定分類，自動彈出密碼框
      if (urlCat && currentCategory === urlCat) {
        const catObj = categories.find(c => c.name === urlCat);
        if (catObj && catObj.locked) requestPassword(urlCat);
      }
    } else {
      renderTabs();
    }
    setupSearch();
    setupModalEvents();
  } catch (err) {
    console.error('初始化失敗:', err);
    showError('無法載入資料，請稍後再試');
  }
}

// 載入活動列表
async function loadActivities() {
  const res = await fetchJSON('listActivities');
  if (!res.ok) throw new Error(res.error || '載入活動失敗');
  activities = res.activities || [];
  publicToken = res.publicToken || null;
  if (publicToken) sessionStorage.setItem('publicToken', publicToken);
}

// 載入活動資訊與分類清單
async function loadActivityInfo(actId) {
  const token = sessionStorage.getItem('publicToken') || publicToken || '';
  const res = await fetchJSON('getActivityInfo', { act: actId, token });
  if (!res.ok) throw new Error(res.error || '載入活動資訊失敗');
  activityInfo = res.activity;
  categories = res.categories || [];
}

// 切換活動
async function switchActivity(actId) {
  currentActivityId = actId;
  currentCategory = '';
  await loadActivityInfo(actId);
  renderTabs();
  await switchCategory('');
}

// 切換分類
async function switchCategory(cat) {
  currentCategory = cat;
  renderTabs();
  renderCategoryTabs();

  if (!cat) {
    // 全部：只顯示未鎖定分類
    await loadData();
    return;
  }

  const catObj = categories.find(c => c.name === cat);
  if (catObj && catObj.locked) {
    const pwd = unlockedCats.get(cat);
    if (!pwd) {
      // 尚未解鎖 → 顯示空狀態並彈出密碼框
      renderTableEmpty('此分類已鎖定，請輸入密碼查看');
      requestPassword(cat);
      return;
    }
    await loadData(cat, pwd);
  } else {
    await loadData(cat);
  }
}

// 載入資料
async function loadData(cat = '', pwd = '') {
  const token = sessionStorage.getItem('publicToken') || publicToken || '';
  showLoading(true);
  try {
    const res = await fetchJSON('getList', { act: currentActivityId, token, cat, pwd });
    if (!res.ok) {
      if (res.code === 'NEED_PWD') {
        renderTableEmpty('此分類已鎖定，請輸入密碼查看');
        requestPassword(cat);
        return;
      }
      throw new Error(res.error || '載入資料失敗');
    }
    currentData = { fields: res.fields || [], rows: res.rows || [] };
    renderTable();
    updateLastUpdated(res.updatedAt);
    searchBarEl.style.display = 'flex';
    btnCopyLink.style.display = currentCategory ? 'inline-flex' : 'none';
  } catch (err) {
    console.error('載入資料失敗:', err);
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

// 密碼解鎖
function requestPassword(cat) {
  pendingCategory = cat;
  const catObj = categories.find(c => c.name === cat);
  pwdModalTitle.textContent = `解鎖「${cat}」`;
  pwdModalDesc.textContent = catObj ? `此分類共 ${catObj.count} 筆，需輸入系統提供的密碼才能檢視。` : '請輸入系統提供的密碼。';
  pwdModalHint.textContent = '';
  pwdModalHint.className = 'hint';
  categoryPwdInput.value = '';
  pwdModal.showModal();
  setTimeout(() => categoryPwdInput.focus(), 100);
}

async function confirmUnlock() {
  const pwd = categoryPwdInput.value.trim();
  if (!pwd) { showHint(pwdModalHint, '請輸入密碼', true); return; }
  const cat = pendingCategory;
  if (!cat) return;
  const btn = document.getElementById('pwdModalConfirm');
  btn.disabled = true; btn.textContent = '驗證中…';
  try {
    const token = sessionStorage.getItem('publicToken') || publicToken || '';
    const res = await fetchJSON('getList', { act: currentActivityId, token, cat, pwd });
    if (!res.ok) {
      showHint(pwdModalHint, res.code === 'NEED_PWD' ? '密碼錯誤，請再試一次' : (res.error || '驗證失敗'), true);
      return;
    }
    // 解鎖成功
    unlockedCats.set(cat, pwd);
    pwdModal.close();
    currentData = { fields: res.fields || [], rows: res.rows || [] };
    renderTable();
    updateLastUpdated(res.updatedAt);
    searchBarEl.style.display = 'flex';
    btnCopyLink.style.display = currentCategory ? 'inline-flex' : 'none';
    btnExportCsv.style.display = 'inline-flex';
    renderCategoryTabs(); // 更新鎖定圖示
  } catch (err) {
    showHint(pwdModalHint, err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '解鎖查看';
  }
}

// 複製分類連結
function copyCategoryLink() {
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('act', currentActivityId);
  url.searchParams.set('cat', currentCategory);
  const text = url.toString();
  navigator.clipboard.writeText(text).then(() => {
    const old = btnCopyLink.textContent;
    btnCopyLink.textContent = '已複製';
    setTimeout(() => { btnCopyLink.textContent = old; }, 1500);
  });
}

// 渲染分頁籤
function renderTabs() {
  tabsEl.innerHTML = '';
  activities.forEach(act => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'activity-tab' + (act.id === currentActivityId ? ' active' : '');
    btn.textContent = act.name;
    btn.dataset.id = act.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', act.id === currentActivityId ? 'true' : 'false');
    btn.addEventListener('click', () => switchActivity(act.id));
    tabsEl.appendChild(btn);
  });
}

// 渲染分類籤
function renderCategoryTabs() {
  categoryBarEl.style.display = activityInfo ? 'flex' : 'none';
  if (!activityInfo) return;
  categoryLabelEl.textContent = activityInfo.categoryField || '分類';
  categoryTabsEl.innerHTML = '';

  // 「全部」籤（不受分類搜尋影響）
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'category-tab' + (!currentCategory ? ' active' : '');
  allBtn.textContent = '全部';
  allBtn.dataset.cat = '';
  allBtn.addEventListener('click', () => switchCategory(''));
  categoryTabsEl.appendChild(allBtn);

  const kw = categoryFilter.trim().toLowerCase();
  categories
    .filter(c => !kw || c.name.toLowerCase().includes(kw))
    .forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-tab' + (c.name === currentCategory ? ' active' : '');
      btn.dataset.cat = c.name;
      btn.textContent = `${c.name} (${c.count})`;
      if (c.locked) {
        btn.classList.add('locked');
        const lock = document.createElement('span');
        lock.className = 'lock-badge';
        lock.textContent = unlockedCats.has(c.name) ? '🔓' : '🔒';
        lock.title = unlockedCats.has(c.name) ? '已解鎖' : '需密碼';
        btn.appendChild(lock);
      }
      btn.addEventListener('click', () => switchCategory(c.name));
      categoryTabsEl.appendChild(btn);
    });

  // 若目前分類被搜尋過濾掉，仍保留它的籤（避免畫面遺失選取）
  if (currentCategory && kw && !categories.find(c => c.name === currentCategory)?.name.toLowerCase().includes(kw)) {
    const cur = categories.find(c => c.name === currentCategory);
    if (cur) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-tab active';
      btn.dataset.cat = cur.name;
      btn.textContent = `${cur.name} (${cur.count})`;
      if (cur.locked) {
        btn.classList.add('locked');
        const lock = document.createElement('span');
        lock.className = 'lock-badge';
        lock.textContent = unlockedCats.has(cur.name) ? '🔓' : '🔒';
        btn.appendChild(lock);
      }
      btn.addEventListener('click', () => switchCategory(cur.name));
      categoryTabsEl.appendChild(btn);
    }
  }
}

// 渲染表格
function renderTable() {
  const { fields, rows } = currentData;
  const filteredRows = getFilteredRows();

  tableHeadEl.innerHTML = '';
  const tr = document.createElement('tr');
  fields.forEach(f => {
    const th = document.createElement('th');
    th.textContent = f;
    tr.appendChild(th);
  });
  tableHeadEl.appendChild(tr);

  tableBodyEl.innerHTML = '';
  if (filteredRows.length === 0) {
    renderTableEmpty('此分類尚無資料');
    return;
  }
  emptyStateEl.style.display = 'none';
  tableWrapperEl.style.display = 'block';
  resultCountEl.textContent = `共 ${filteredRows.length} 筆`;

  filteredRows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach(cell => {
      const td = document.createElement('td');
      td.textContent = cell ?? '';
      tr.appendChild(td);
    });
    tableBodyEl.appendChild(tr);
  });
}

function renderTableEmpty(msg) {
  emptyStateEl.textContent = msg;
  emptyStateEl.style.display = 'block';
  tableWrapperEl.style.display = 'none';
  resultCountEl.textContent = '';
  currentData = { fields: [], rows: [] };
  btnExportCsv.style.display = 'none';
}

// 匯出目前分類（含關鍵字過濾）為 CSV
function exportCsv() {
  const { fields, rows } = currentData;
  const filteredRows = getFilteredRows();
  if (filteredRows.length === 0) {
    alert('目前沒有可匯出的資料');
    return;
  }
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  lines.push(fields.map(esc).join(','));
  filteredRows.forEach(r => lines.push(r.map(esc).join(',')));
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM 讓 Excel 正確辨識 UTF-8

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const actName = activityInfo?.name || '名冊';
  const catPart = currentCategory ? `_${currentCategory}` : '_全部';
  a.href = url;
  a.download = `${actName}${catPart}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 關鍵字篩選
function setupSearch() {
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderTable(), 120);
  });

  // 分類搜尋：只影響分類籤的本地顯示
  categorySearchInput.addEventListener('input', () => {
    categoryFilter = categorySearchInput.value;
    renderCategoryTabs();
  });
}

function getFilteredRows() {
  const keyword = searchInput.value.trim().toLowerCase();
  if (!keyword) return currentData.rows;
  return currentData.rows.filter(row =>
    row.some(cell => String(cell).toLowerCase().includes(keyword))
  );
}

function updateLastUpdated(iso) {
  if (!iso) { lastUpdatedEl.textContent = ''; return; }
  const d = new Date(iso);
  lastUpdatedEl.textContent = `更新時間：${d.toLocaleString('zh-TW', { hour12: false })}`;
}

function showLoading(on) {
  tabsEl.style.opacity = on ? '0.6' : '1';
  tabsEl.style.pointerEvents = on ? 'none' : 'auto';
  searchInput.disabled = on;
}

function showError(msg) {
  emptyStateEl.textContent = msg;
  emptyStateEl.style.display = 'block';
  tableWrapperEl.style.display = 'none';
  searchBarEl.style.display = 'none';
}

// Modal 事件
function setupModalEvents() {
  document.getElementById('pwdModalConfirm').addEventListener('click', confirmUnlock);
  document.getElementById('pwdModalCancel').addEventListener('click', () => pwdModal.close());
  document.getElementById('pwdModalClose').addEventListener('click', () => pwdModal.close());
  categoryPwdInput.addEventListener('keydown', e => e.key === 'Enter' && confirmUnlock());
  btnCopyLink.addEventListener('click', copyCategoryLink);
  btnExportCsv.addEventListener('click', exportCsv);
}

// 統一 fetch 包裝
async function fetchJSON(action, params = {}) {
  const url = new URL(CONFIG.GAS_URL);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function showHint(el, msg, isError) {
  el.textContent = msg;
  el.className = 'hint' + (isError ? ' error' : ' success');
}

// 啟動
document.addEventListener('DOMContentLoaded', init);
