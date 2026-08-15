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

// 單位隔離參數（來自 URL ?unit=&unitToken= 或 config.js UNIT）
let activeUnit = '';
let activeUnitToken = '';
// 活動金鑰解鎖狀態（session）：activityId -> key
const unlockedActivityKeys = new Map();

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
const btnPrintRoster = document.getElementById('btnPrintRoster');
const tableEl = document.getElementById('dataTable');
const tableHeadEl = document.getElementById('tableHead');
const tableBodyEl = document.getElementById('tableBody');
const cardListEl = document.getElementById('cardList');
const emptyStateEl = document.getElementById('emptyState');
const tableWrapperEl = document.getElementById('tableWrapper');
const tableHscrollEl = document.getElementById('tableHscroll');
const tableHscrollTrackEl = document.getElementById('tableHscrollTrack');
const lastUpdatedEl = document.getElementById('lastUpdated');
const pwdModal = document.getElementById('pwdModal');
const pwdModalTitle = document.getElementById('pwdModalTitle');
const pwdModalDesc = document.getElementById('pwdModalDesc');
const pwdModalHint = document.getElementById('pwdModalHint');
const categoryPwdInput = document.getElementById('categoryPwdInput');
const keyModal = document.getElementById('keyModal');
const keyModalTitle = document.getElementById('keyModalTitle');
const keyModalDesc = document.getElementById('keyModalDesc');
const keyModalHint = document.getElementById('keyModalHint');
const activityKeyInput = document.getElementById('activityKeyInput');

// 分類搜尋關鍵字（本地過濾，不影響後端）
let categoryFilter = '';

// 排序狀態：{ field, dir }；field 為 '' 表示不排序（依原始順序）
// userTouched 為 true 表示訪客已手動排序，之後載入資料不再覆蓋
let sortState = { field: '', dir: 'asc', userTouched: false };
let currentFields = []; // 目前表格的欄位清單（供欄寬調整）

// 目標分類（等待解鎖）
let pendingCategory = null;

// 初始化
async function init() {
  try {
    const params = new URLSearchParams(location.search);
    const urlAct = params.get('act');
    const urlCat = params.get('cat');
    const urlKey = params.get('key'); // 活動金鑰（選擇性，C 模式）

    // 單位參數：URL 優先，其次 config.js
    activeUnit = params.get('unit') || (typeof CONFIG !== 'undefined' && CONFIG.UNIT) || '';
    activeUnitToken = params.get('unitToken') || (typeof CONFIG !== 'undefined' && CONFIG.UNIT_TOKEN) || '';

    // 若網址指定活動金鑰，先記住
    if (urlKey) unlockedActivityKeys.set(urlAct, urlKey);

    await loadActivities();

    // 活動選擇
    if (urlAct && activities.some(a => a.id === urlAct)) {
      currentActivityId = urlAct;
    } else {
      currentActivityId = activities[0]?.id || null;
    }

    if (currentActivityId) {
      const infoOk = await loadActivityInfo(currentActivityId);
      currentCategory = (urlCat && categories.some(c => c.name === urlCat)) ? urlCat : '';
      if (!infoOk) {
        renderTabs();
        renderCategoryTabs();
        renderTableEmpty('此活動需輸入存取金鑰');
      } else if (urlCat && currentCategory === urlCat) {
        await switchCategory(currentCategory);
        // 若網址指定了鎖定分類，自動彈出密碼框
        const catObj = categories.find(c => c.name === urlCat);
        if (catObj && catObj.locked) requestPassword(urlCat);
      } else {
        renderTabs();
        renderCategoryTabs();
        renderTableEmpty('請點選上方分類開始翻閱');
      }
    } else {
      renderTabs();
    }
    setupSearch();
    setupModalEvents();
    setupHscroll();
  } catch (err) {
    console.error('初始化失敗:', err);
    showError('無法載入資料，請稍後再試');
  }
}

// 載入活動列表
async function loadActivities() {
  const params = {};
  if (activeUnit) { params.unit = activeUnit; params.unitToken = activeUnitToken; }
  const res = await fetchJSON('listActivities', params);
  if (!res.ok) throw new Error(res.error || '載入活動失敗');
  activities = res.activities || [];
  publicToken = res.publicToken || null;
  if (publicToken) sessionStorage.setItem('publicToken', publicToken);
}

// 載入活動資訊與分類清單
// 回傳 true 成功；false 表示活動需金鑰（已彈出輸入框）
async function loadActivityInfo(actId) {
  const token = sessionStorage.getItem('publicToken') || publicToken || '';
  const params = { act: actId, token };
  // 活動有金鑰且已解鎖 → 帶上 key
  const key = unlockedActivityKeys.get(actId);
  if (key) params.key = key;
  const res = await fetchJSON('getActivityInfo', params);
  if (!res.ok) {
    // C 模式：金鑰不足 → 彈出金鑰解鎖框，回傳 false
    if (res.code === 'NEED_KEY') {
      requestActivityKey(actId);
      activityInfo = null;
      categories = [];
      return false;
    }
    throw new Error(res.error || '載入活動資訊失敗');
  }
  activityInfo = res.activity;
  categories = res.categories || [];
  return true;
}

// 切換活動
async function switchActivity(actId) {
  currentActivityId = actId;
  currentCategory = '';
  sortState = { field: '', dir: 'asc', userTouched: false };
  searchInput.value = '';
  const ok = await loadActivityInfo(actId);
  renderTabs();
  if (!ok) { renderTableEmpty('此活動需輸入存取金鑰'); return; }
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
    const params = { act: currentActivityId, token, cat, pwd };
    const key = unlockedActivityKeys.get(currentActivityId);
    if (key) params.key = key;
    const res = await fetchJSON('getList', params);
    if (!res.ok) {
      if (res.code === 'NEED_PWD') {
        renderTableEmpty('此分類已鎖定，請輸入密碼查看');
        requestPassword(cat);
        return;
      }
      if (res.code === 'NEED_KEY') {
        renderTableEmpty('此活動需輸入存取金鑰');
        requestActivityKey(currentActivityId);
        return;
      }
      throw new Error(res.error || '載入資料失敗');
    }
    currentData = { fields: res.fields || [], rows: res.rows || [] };
    applyDefaultSortIfNeeded();
    restoreSearchMemory();
    renderTable();
    updateLastUpdated(res.updatedAt);
    searchBarEl.style.display = 'flex';
    btnCopyLink.style.display = currentCategory ? 'inline-flex' : 'none';
    btnExportCsv.style.display = 'inline-flex';
    btnPrintRoster.style.display = 'inline-flex';
    renderCategoryTabs(); // 更新鎖定圖示
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

// 活動金鑰解鎖（C 模式）
function requestActivityKey(actId) {
  const act = activities.find(a => a.id === actId);
  keyModalTitle.textContent = `開啟「${act ? act.name : '活動'}」`;
  keyModalDesc.textContent = '此活動已設定存取金鑰，請輸入系統提供的金鑰才能檢視。';
  keyModalHint.textContent = '';
  keyModalHint.className = 'hint';
  activityKeyInput.value = '';
  keyModal.showModal();
  setTimeout(() => activityKeyInput.focus(), 100);
}

async function confirmActivityKey() {
  const key = activityKeyInput.value.trim();
  if (!key) { showHint(keyModalHint, '請輸入金鑰', true); return; }
  const actId = currentActivityId;
  if (!actId) return;
  const btn = document.getElementById('keyModalConfirm');
  btn.disabled = true; btn.textContent = '驗證中…';
  try {
    const token = sessionStorage.getItem('publicToken') || publicToken || '';
    const res = await fetchJSON('getActivityInfo', { act: actId, token, key });
    if (!res.ok) {
      showHint(keyModalHint, res.code === 'NEED_KEY' ? '金鑰錯誤，請再試一次' : (res.error || '驗證失敗'), true);
      return;
    }
    // 金鑰正確：記住並載入活動
    unlockedActivityKeys.set(actId, key);
    keyModal.close();
    activityInfo = res.activity;
    categories = res.categories || [];
    currentCategory = '';
    renderTabs();
    renderCategoryTabs();
    renderTableEmpty('請點選上方分類開始翻閱');
  } catch (err) {
    showHint(keyModalHint, err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '開啟活動';
  }
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
    const params = { act: currentActivityId, token, cat, pwd };
    const key = unlockedActivityKeys.get(currentActivityId);
    if (key) params.key = key;
    const res = await fetchJSON('getList', params);
    if (!res.ok) {
      showHint(pwdModalHint, res.code === 'NEED_PWD' ? '密碼錯誤，請再試一次' : (res.error || '驗證失敗'), true);
      return;
    }
    // 解鎖成功
    unlockedCats.set(cat, pwd);
    pwdModal.close();
    currentData = { fields: res.fields || [], rows: res.rows || [] };
    applyDefaultSortIfNeeded();
    renderTable();
    updateLastUpdated(res.updatedAt);
    searchBarEl.style.display = 'flex';
    btnCopyLink.style.display = currentCategory ? 'inline-flex' : 'none';
    btnExportCsv.style.display = 'inline-flex';
    btnPrintRoster.style.display = 'inline-flex';
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
  if (activeUnit) { url.searchParams.set('unit', activeUnit); url.searchParams.set('unitToken', activeUnitToken); }
  const key = unlockedActivityKeys.get(currentActivityId);
  if (key) url.searchParams.set('key', key);
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

  tableWrapperEl.style.display = 'none';
  cardListEl.style.display = 'none';

  if (filteredRows.length === 0) {
    renderTableEmpty('此分類尚無資料');
    return;
  }
  emptyStateEl.style.display = 'none';
  resultCountEl.textContent = `共 ${filteredRows.length} 筆`;

  // 欄位少於 5 欄 → 左右雙欄名單卡片；否則全寬表格
  if (fields.length > 0 && fields.length < 5) {
    tableHscrollEl.style.display = 'none';
    renderCardList(fields, filteredRows);
  } else {
    renderDataTable(fields, filteredRows);
  }
}

// 欄位多（>=5）：全寬表格
function renderDataTable(fields, filteredRows) {
  currentFields = fields;
  tableWrapperEl.style.display = 'block';
  buildColgroup(fields);

  tableHeadEl.innerHTML = '';
  const tr = document.createElement('tr');
  fields.forEach((f, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'sortable';
    th.title = f + '（點擊排序）';
    const inner = document.createElement('span');
    inner.className = 'th-inner';
    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = f;
    inner.appendChild(label);
    if (sortState.field === f) {
      th.classList.add('sorted', sortState.dir);
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
      inner.appendChild(arrow);
    }
    th.appendChild(inner);
    th.addEventListener('click', () => handleSort(f));
    tr.appendChild(th);

    // 欄寬拖曳把手（只在可捲動的寬表格提供）
    const grip = document.createElement('span');
    grip.className = 'col-grip';
    grip.title = '拖曳調整欄寬';
    grip.addEventListener('pointerdown', e => startColResize(e, i));
    grip.addEventListener('click', e => e.stopPropagation());
    th.appendChild(grip);
  });
  tableHeadEl.appendChild(tr);

  tableBodyEl.innerHTML = '';
  filteredRows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach(cell => {
      const td = document.createElement('td');
      const text = cell ?? '';
      td.textContent = text;
      if (String(text).length > 24) td.title = String(text);
      tr.appendChild(td);
    });
    tableBodyEl.appendChild(tr);
  });

  syncHscroll();
}

// 獨立水平捲軸：與表格捲動雙向同步
function setupHscroll() {
  tableWrapperEl.addEventListener('scroll', () => {
    if (tableHscrollEl.style.display !== 'none') {
      tableHscrollEl.scrollLeft = tableWrapperEl.scrollLeft;
    }
  });
  tableHscrollEl.addEventListener('scroll', () => {
    tableWrapperEl.scrollLeft = tableHscrollEl.scrollLeft;
  });
  window.addEventListener('resize', syncHscroll);
}

function syncHscroll() {
  const wrapper = tableWrapperEl;
  if (wrapper.scrollWidth > wrapper.clientWidth + 1) {
    tableHscrollTrackEl.style.width = wrapper.scrollWidth + 'px';
    tableHscrollEl.style.display = 'block';
  } else {
    tableHscrollEl.style.display = 'none';
  }
}

// ── 可調欄寬（colgroup 方案，拖曳只改 <col> 寬度，rAF 節流）──
const COL_MIN = 120;   // 最小欄寬 px
const COL_MAX = 640;   // 最大欄寬 px
const COLW_KEY_PREFIX = 'cq_colw_';
let activeCols = [];   // 目前表格各欄的 <col> 元素（對應 fields）
let customColsOn = false; // 是否已啟用固定欄寬（使用者調整過）
let resizeSession = null; // 進行中的拖曳 { index, startX, startW }

function colwKey() { return COLW_KEY_PREFIX + (currentActivityId || 'default'); }
function loadColWidths() {
  try {
    const raw = localStorage.getItem(colwKey());
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveColWidths(map) {
  try { localStorage.setItem(colwKey(), JSON.stringify(map)); } catch (e) {}
}
function clampColW(w) { return Math.max(COL_MIN, Math.min(COL_MAX, Math.round(w))); }

// 建立 colgroup；若已有儲存寬度則套用並啟用 fixed 排版
function buildColgroup(fields) {
  let cg = tableEl.querySelector('colgroup');
  if (!cg) { cg = document.createElement('colgroup'); tableEl.insertBefore(cg, tableEl.firstChild); }
  cg.innerHTML = '';
  activeCols = [];
  const saved = loadColWidths();
  customColsOn = fields.some(f => saved[f]);
  tableEl.classList.toggle('fixed-cols', customColsOn);
  fields.forEach(f => {
    const col = document.createElement('col');
    if (saved[f]) col.style.width = saved[f] + 'px';
    cg.appendChild(col);
    activeCols.push(col);
  });
  if (customColsOn) syncTableWidth();
}

// 首次拖曳：把所有欄目前的實際寬度快照進 colgroup，切換 fixed 排版
function enableFixedCols(fields) {
  const ths = [...tableHeadEl.querySelectorAll('th')];
  const saved = loadColWidths();
  fields.forEach((f, i) => {
    if (!saved[f]) saved[f] = Math.round(ths[i].getBoundingClientRect().width);
  });
  saveColWidths(saved);
  customColsOn = true;
  tableEl.classList.add('fixed-cols');
  activeCols.forEach((col, i) => {
    if (!col.style.width && saved[fields[i]]) col.style.width = saved[fields[i]] + 'px';
  });
  syncTableWidth();
}

// 表格寬度 = 各欄寬度總和（fixed-cols 下精準，不讓 max-content 內容撐開）
function syncTableWidth() {
  const total = activeCols.reduce((sum, col) => sum + (parseFloat(col.style.width) || 0), 0);
  tableEl.style.width = (total > 0 ? total : '') + (total > 0 ? 'px' : '');
}

function startColResize(e, i) {
  e.preventDefault();
  e.stopPropagation();
  if (e.button !== 0) return;
  if (!customColsOn) enableFixedCols(currentFields);
  resizeSession = { index: i, startX: e.clientX, startW: parseFloat(activeCols[i].style.width) };
  tableEl.classList.add('col-resizing');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', onColResizeMove);
  window.addEventListener('pointerup', endColResize);
  window.addEventListener('pointercancel', endColResize);
}

let resizeRaf = null;
function onColResizeMove(e) {
  const session = resizeSession;
  if (!session) return;
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    const w = clampColW(session.startW + (e.clientX - session.startX));
    activeCols[session.index].style.width = w + 'px';
    const saved = loadColWidths();
    saved[currentFields[session.index]] = w;
    saveColWidths(saved);
    syncTableWidth();
    syncHscroll();
  });
}
function endColResize() {
  if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = null; }
  resizeSession = null;
  tableEl.classList.remove('col-resizing');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', onColResizeMove);
  window.removeEventListener('pointerup', endColResize);
  window.removeEventListener('pointercancel', endColResize);
}


// 欄位少（<5）：左右雙欄名單卡片
function renderCardList(fields, rows) {
  cardListEl.style.display = 'grid';
  cardListEl.innerHTML = '';

  // 排序藥丸列
  const sortRow = document.createElement('div');
  sortRow.className = 'card-sort-row';
  const sortLabel = document.createElement('span');
  sortLabel.className = 'card-sort-label';
  sortLabel.textContent = '排序：';
  sortRow.appendChild(sortLabel);
  fields.forEach(f => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'card-sort-pill' + (sortState.field === f ? ' active' : '');
    const arrow = sortState.field === f ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
    pill.textContent = f + arrow;
    pill.title = '點擊排序';
    pill.addEventListener('click', () => handleSort(f));
    sortRow.appendChild(pill);
  });
  cardListEl.appendChild(sortRow);

  rows.forEach(row => {
    const card = document.createElement('article');
    card.className = 'name-card';
    // 第一個欄位作為卡片標題
    const title = document.createElement('h3');
    title.className = 'name-card-title';
    title.textContent = row[0] ?? '';
    card.appendChild(title);
    fields.slice(1).forEach((f, i) => {
      const item = document.createElement('dl');
      item.className = 'name-card-item';
      const dt = document.createElement('dt');
      dt.textContent = f;
      const dd = document.createElement('dd');
      dd.textContent = row[i + 1] ?? '';
      item.appendChild(dt);
      item.appendChild(dd);
      card.appendChild(item);
    });
    cardListEl.appendChild(card);
  });
}

// 訪客點標題排序：依欄位切換升/降，再點同欄反轉方向
function handleSort(field) {
  if (sortState.field === field) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.field = field;
    sortState.dir = 'asc';
  }
  sortState.userTouched = true;
  saveSortMemory();
  renderTable();
}

// C：記住訪客最後的排序（localStorage，依活動區分）
function saveSortMemory() {
  if (!currentActivityId) return;
  const key = 'sort_mem_' + currentActivityId;
  try {
    localStorage.setItem(key, JSON.stringify({ field: sortState.field, dir: sortState.dir }));
  } catch (e) { /* localStorage 不可用時略過 */ }
}

function loadSortMemory() {
  if (!currentActivityId) return null;
  try {
    const raw = localStorage.getItem('sort_mem_' + currentActivityId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// 若訪客尚未手動排序：優先套用記憶的排序，其次後台設定的預設排序
function applyDefaultSortIfNeeded() {
  if (sortState.userTouched) return;
  const fields = currentData.fields || [];

  // C：記憶優先（訪客上次的選擇）
  const mem = loadSortMemory();
  if (mem && mem.field && fields.includes(mem.field)) {
    sortState = { field: mem.field, dir: mem.dir === 'desc' ? 'desc' : 'asc', userTouched: false };
    return;
  }

  const df = activityInfo?.defaultSortField || '';
  const dir = activityInfo?.defaultSortDir === 'desc' ? 'desc' : 'asc';
  if (df && fields.includes(df)) {
    sortState = { field: df, dir, userTouched: false };
  } else {
    sortState = { field: '', dir: 'asc', userTouched: false };
  }
}

function renderTableEmpty(msg) {
  emptyStateEl.textContent = msg;
  emptyStateEl.style.display = 'block';
  tableWrapperEl.style.display = 'none';
  cardListEl.style.display = 'none';
  tableHscrollEl.style.display = 'none';
  resultCountEl.textContent = '';
  currentData = { fields: [], rows: [] };
  btnExportCsv.style.display = 'none';
  btnPrintRoster.style.display = 'none';
  searchBarEl.style.display = 'none';
}

// 匯出目前分類（含關鍵字過濾）為 CSV，首列為標題（活動名稱＋分類名稱＋時間）
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
  const actName = activityInfo?.name || '名冊';
  const catName = currentCategory || '全部';
  const now = new Date().toLocaleString('zh-TW', { hour12: false });
  const lines = [];
  // 標題列（活動名稱｜分類｜匯出時間）
  lines.push([esc(actName), esc(catName), esc(now)].join(','));
  lines.push('');
  lines.push(fields.map(esc).join(','));
  filteredRows.forEach(r => lines.push(r.map(esc).join(',')));
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM 讓 Excel 正確辨識 UTF-8

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const catPart = currentCategory ? `_${currentCategory}` : '_全部';
  a.href = url;
  a.download = `${actName}${catPart}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 列印名冊：開啟乾淨的列印視窗（有格線、標題），管理者可分批印各分類紙本或存 PDF
function printRoster() {
  const { fields, rows } = currentData;
  const filteredRows = getFilteredRows();
  if (filteredRows.length === 0) {
    alert('目前沒有可列印的資料');
    return;
  }
  const escHtml = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const actName = activityInfo?.name || '名冊';
  const catName = currentCategory || '全部';
  const now = new Date().toLocaleString('zh-TW', { hour12: false });

  const thead = '<thead><tr>' + fields.map(f => `<th>${escHtml(f)}</th>`).join('') + '</tr></thead>';
  const tbody = '<tbody>' + filteredRows.map(r =>
    '<tr>' + r.map(c => `<td>${escHtml(c)}</td>`).join('') + '</tr>'
  ).join('') + '</tbody>';

  // 不用 noopener：它會讓 window.open 回傳 null，導致無法寫入與列印
  const win = window.open('', '_blank');
  if (!win) { alert('請允許彈出視窗以列印名冊'); return; }
  win.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${escHtml(actName)} ${escHtml(catName)} 名冊</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif; color: #222; padding: 24px; }
  @page { size: A4 landscape; margin: 12mm; }
  .print-head { margin-bottom: 12px; }
  .print-head h1 { font-size: 22px; margin-bottom: 4px; }
  .print-head .sub { font-size: 13px; color: #444; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #444; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-all; }
  thead th { background: #f0efe9; position: sticky; top: 0; }
  thead { display: table-header-group; } /* 跨頁重複表頭 */
  tr { break-inside: avoid; }
  @media print {
    .no-print { display: none; }
    body { padding: 0; }
  }
</style></head><body>
  <div class="print-head">
    <h1>${escHtml(actName)}　${escHtml(catName)}名冊</h1>
    <div class="sub">匯出時間：${escHtml(now)}　｜　共 ${filteredRows.length} 筆</div>
  </div>
  <table>${thead}${tbody}</table>
  <div class="no-print" style="margin-top:14px; font-size:12px; color:#888;">
    提示：請在列印對話框選擇「另存為 PDF」即可輸出 PDF 檔；紙張建議選 A4 橫向。
  </div>
</body></html>`);
  win.document.close();
  win.focus();
  // 等字型/渲染穩定後再呼叫列印
  setTimeout(() => { try { win.print(); } catch (e) {} }, 250);
}

// 關鍵字篩選
function setupSearch() {
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    // C：記憶搜尋字詞
    if (currentActivityId) {
      try { localStorage.setItem('search_mem_' + currentActivityId, searchInput.value); } catch (e) {}
    }
    debounceTimer = setTimeout(() => renderTable(), 120);
  });

  // 分類搜尋：只影響分類籤的本地顯示
  categorySearchInput.addEventListener('input', () => {
    categoryFilter = categorySearchInput.value;
    renderCategoryTabs();
  });
}

// C：還原訪客上次的搜尋字詞
function restoreSearchMemory() {
  if (!currentActivityId) return;
  try {
    const mem = localStorage.getItem('search_mem_' + currentActivityId);
    searchInput.value = mem || '';
  } catch (e) {}
}

// 關鍵字篩選 + 排序（renderTable 與 exportCsv 共用，確保 CSV 跟隨排序）
function getFilteredRows() {
  const keyword = searchInput.value.trim().toLowerCase();
  let rows = currentData.rows;
  if (keyword) {
    rows = rows.filter(row =>
      row.some(cell => String(cell).toLowerCase().includes(keyword))
    );
  }
  return sortRows(rows);
}

// 依目前排序狀態排序（使用自然排序：數字優先、中文依 locale 比較）
function sortRows(rows) {
  const { field, dir } = sortState;
  if (!field) return rows;
  const fields = currentData.fields || [];
  const idx = fields.indexOf(field);
  if (idx < 0) return rows;
  const factor = dir === 'desc' ? -1 : 1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const va = a[idx];
    const vb = b[idx];
    const sa = va == null ? '' : String(va).trim();
    const sb = vb == null ? '' : String(vb).trim();
    // 兩者皆為數字字串 → 數值比較（避免 10 < 2）
    if (sa !== '' && sb !== '' && !isNaN(sa) && !isNaN(sb)) {
      return (Number(sa) - Number(sb)) * factor;
    }
    return sa.localeCompare(sb, 'zh-TW', { numeric: true }) * factor;
  });
  return sorted;
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
  cardListEl.style.display = 'none';
  tableHscrollEl.style.display = 'none';
  searchBarEl.style.display = 'none';
}

// Modal 事件
function setupModalEvents() {
  document.getElementById('pwdModalConfirm').addEventListener('click', confirmUnlock);
  document.getElementById('pwdModalCancel').addEventListener('click', () => pwdModal.close());
  document.getElementById('pwdModalClose').addEventListener('click', () => pwdModal.close());
  categoryPwdInput.addEventListener('keydown', e => e.key === 'Enter' && confirmUnlock());
  document.getElementById('keyModalConfirm').addEventListener('click', confirmActivityKey);
  document.getElementById('keyModalCancel').addEventListener('click', () => keyModal.close());
  document.getElementById('keyModalClose').addEventListener('click', () => keyModal.close());
  document.getElementById('activityKeyInput').addEventListener('keydown', e => e.key === 'Enter' && confirmActivityKey());
  btnCopyLink.addEventListener('click', copyCategoryLink);
  btnExportCsv.addEventListener('click', exportCsv);
btnPrintRoster.addEventListener('click', printRoster);
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 啟動
document.addEventListener('DOMContentLoaded', init);
