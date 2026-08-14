/**
 * 分類查詢系統 - GAS 後端
 * 提供：活動列表、分類（區域/教室）過濾、分類密碼鎖、管理設定
 * 部署：Web App -> 執行身分「我」，存取權「任何人」
 *
 * 每個活動可設定：
 *  - categoryField：分類欄位（例如「區域」「教室」）
 *  - displayFields：顯示欄位（白名單）
 *  - protectedCategories：{ 分類名稱: 密碼 }，鎖住的分類需密碼才能查看
 */

const PROP_ACTIVITIES = 'ACTIVITIES_CONFIG';
const PROP_ADMIN_HASH = 'ADMIN_PWD_HASH';
const PROP_ADMIN_SALT = 'ADMIN_PWD_SALT';
const CACHE_PREFIX = 'CLASSIFIED_V2_DATA_';
const CACHE_TTL = 60; // 秒

/**
 * 主進入點
 */
function doGet(e) {
  const action = e?.parameter?.action || 'listActivities';
  const token = e?.parameter?.token || '';

  let result;
  try {
    switch (action) {
      case 'listActivities':
        result = handleListActivities();
        break;
      case 'getActivityInfo':
        result = handleGetActivityInfo(e.parameter);
        break;
      case 'getList':
        result = handleGetList(e.parameter);
        break;
      case 'testConnection':
        result = handleTestConnection(e.parameter);
        break;
      case 'getCategoryValues':
        result = handleGetCategoryValues(e.parameter);
        break;
      case 'admin_login':
        result = handleAdminLogin(e.parameter);
        break;
      case 'getConfig':
        result = handleGetConfig(e.parameter);
        break;
      case 'saveActivity':
        result = handleSaveActivity(e.parameter);
        break;
      case 'deleteActivity':
        result = handleDeleteActivity(e.parameter);
        break;
      case 'generateCategoryPassword':
        result = handleGenerateCategoryPassword(e.parameter);
        break;
      case 'changePassword':
        result = handleChangePassword(e.parameter);
        break;
      default:
        result = { ok: false, error: '未知的 action: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 取得所有活動基本資訊（供查詢頁分頁籤用）
 */
function handleListActivities() {
  const config = getActivitiesConfig();
  const list = config.activities.map(a => ({ id: a.id, name: a.name }));
  return { ok: true, activities: list, publicToken: config.publicToken || '' };
}

/**
 * 取得單一活動的資訊：顯示欄位、分類清單（含鎖定標記，但不含密碼）
 */
function handleGetActivityInfo(params) {
  const actId = params.act;
  const token = params.token || '';

  if (!actId) return { ok: false, error: '缺少活動 ID' };

  const config = getActivitiesConfig();
  const activity = config.activities.find(a => a.id === actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  const validToken = config.publicToken || '';
  if (validToken && token !== validToken) {
    return { ok: false, error: 'Token 驗證失敗' };
  }

  // 讀取試算表取得分類清單
  const data = readSpreadsheetData(activity);
  if (!data.ok) return data;

  const categories = collectCategories(data.rawRows, activity.categoryField);
  const protectedSet = activity.protectedCategories || {};

  return {
    ok: true,
    activity: {
      id: activity.id,
      name: activity.name,
      categoryField: activity.categoryField || '',
      displayFields: activity.displayFields || []
    },
    categories: categories.map(c => ({
      name: c.name,
      count: c.count,
      locked: !!protectedSet[c.name]
    }))
  };
}

/**
 * 取得指定活動的報名名單（依分類過濾 + 密碼驗證）
 * params: act, token, cat, pwd
 */
function handleGetList(params) {
  const actId = params.act;
  const token = params.token || '';
  const cat = params.cat || '';
  const pwd = params.pwd || '';

  if (!actId) return { ok: false, error: '缺少活動 ID' };

  const config = getActivitiesConfig();
  const activity = config.activities.find(a => a.id === actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  const validToken = config.publicToken || '';
  if (validToken && token !== validToken) {
    return { ok: false, error: 'Token 驗證失敗' };
  }

  const categoryField = activity.categoryField;
  const protectedSet = activity.protectedCategories || {};

  // 若指定分類且該分類被鎖定，需驗證密碼
  if (cat && protectedSet[cat] && protectedSet[cat] !== pwd) {
    return { ok: false, code: 'NEED_PWD', error: '此分類已鎖定，需輸入正確密碼' };
  }

  // 快取
  const cacheKey = CACHE_PREFIX + actId + '_' + cat;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const data = readSpreadsheetData(activity);
  if (!data.ok) return data;

  // 過濾分類
  let rows = data.rawRows;
  if (cat) {
    rows = rows.filter(r => String(r[categoryField] ?? '') === cat);
  } else {
    // 未指定分類時：僅回傳「未鎖定分類」的列，避免洩漏鎖定資料
    rows = rows.filter(r => {
      const c = String(r[categoryField] ?? '');
      return !(protectedSet[c]);
    });
  }

  // 只取白名單欄位（rawRows 為以欄位名為 key 的物件）
  const projected = rows.map(row => {
    return (activity.displayFields || []).map(f => {
      const i = data.headers.indexOf(f);
      return i >= 0 ? row[data.headers[i]] : null;
    });
  });

  const result = {
    ok: true,
    name: activity.name,
    fields: activity.displayFields || [],
    rows: projected,
    updatedAt: new Date().toISOString()
  };

  cache.put(cacheKey, JSON.stringify(result), CACHE_TTL);
  return result;
}

/**
 * 測試試算表連線並回傳欄位清單（含分類欄位建議用下拉）
 */
function handleTestConnection(params) {
  const url = params.url;
  const pwd = params.pwd || '';

  if (!verifyAdminPassword(pwd)) {
    return { ok: false, error: '管理密碼錯誤' };
  }
  if (!url) return { ok: false, error: '缺少試算表網址' };

  const sheetId = extractSheetId(url);
  if (!sheetId) return { ok: false, error: '無法從網址解析試算表 ID' };

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheets()[0];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    return { ok: true, fields: headers.filter(h => h), sheetName: sheet.getName() };
  } catch (err) {
    const msg = err.toString();
    if (msg.includes('permission') || msg.includes('權限') || msg.includes('找不到')) {
      return { ok: false, error: '無法存取試算表，請確認已分享給 krad1985@gmail.com（編輯者或檢視者皆可）' };
    }
    return { ok: false, error: msg };
  }
}

/**
 * 取得分類欄位的唯一值（需管理密碼）
 */
function handleGetCategoryValues(params) {
  if (!verifyAdminPassword(params.pwd)) {
    return { ok: false, error: '管理密碼錯誤' };
  }
  const url = params.url;
  const field = params.field;
  if (!url) return { ok: false, error: '缺少試算表網址' };
  if (!field) return { ok: false, error: '缺少分類欄位' };

  const sheetId = extractSheetId(url);
  if (!sheetId) return { ok: false, error: '無法從網址解析試算表 ID' };

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheets()[0];
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) return { ok: true, values: [] };

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const idx = headers.indexOf(field);
    if (idx < 0) return { ok: true, values: [] };

    const data = sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues().flat();
    const set = {};
    data.forEach(v => {
      const s = String(v).trim();
      if (s) set[s] = true;
    });
    const values = Object.keys(set).sort((a, b) => a.localeCompare(b, 'zh-TW'));
    return { ok: true, values };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
}

/**
 * 管理員登入驗證（首次登入自動設定密碼）
 */
function handleAdminLogin(params) {
  const pwd = params.pwd || '';
  const storedHash = PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_HASH);
  const storedSalt = PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_SALT);

  if (!storedHash || !storedSalt) {
    const salt = generateSalt();
    const hash = hashPassword(pwd, salt);
    const props = PropertiesService.getScriptProperties();
    props.setProperty(PROP_ADMIN_HASH, hash);
    props.setProperty(PROP_ADMIN_SALT, salt);
    return { ok: true, firstTime: true, message: '首次登入，管理密碼已設定' };
  }

  const valid = verifyPassword(pwd, storedHash, storedSalt);
  return { ok: valid, firstTime: false };
}

/**
 * 取得完整設定（需管理密碼）
 */
function handleGetConfig(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };
  const config = getActivitiesConfig();
  return {
    ok: true,
    config: { activities: config.activities, publicToken: config.publicToken || '' }
  };
}

/**
 * 儲存/更新活動設定（需管理密碼）
 */
function handleSaveActivity(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const config = getActivitiesConfig();
  const activityData = JSON.parse(params.data || '{}');

  // 確保分類密碼欄位存在
  activityData.protectedCategories = activityData.protectedCategories || {};

  if (!activityData.id) {
    activityData.id = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    config.activities.push(activityData);
  } else {
    const idx = config.activities.findIndex(a => a.id === activityData.id);
    if (idx >= 0) config.activities[idx] = activityData;
  }

  saveActivitiesConfig(config);
  clearActivityCache(activityData.id);
  return { ok: true, id: activityData.id };
}

/**
 * 刪除活動（需管理密碼）
 */
function handleDeleteActivity(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const id = params.id;
  if (!id) return { ok: false, error: '缺少活動 ID' };

  const config = getActivitiesConfig();
  config.activities = config.activities.filter(a => a.id !== id);
  saveActivitiesConfig(config);
  clearActivityCache(id);
  return { ok: true };
}

/**
 * 生成分類密碼（需管理密碼）並回存
 */
function handleGenerateCategoryPassword(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const actId = params.act;
  const cat = params.cat;
  if (!actId || !cat) return { ok: false, error: '缺少活動或分類' };

  const config = getActivitiesConfig();
  const activity = config.activities.find(a => a.id === actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  activity.protectedCategories = activity.protectedCategories || {};
  const password = generateCategoryPassword();
  activity.protectedCategories[cat] = password;

  saveActivitiesConfig(config);
  clearActivityCache(actId);
  return { ok: true, password, cat };
}

/**
 * 變更管理密碼（需舊密碼）
 */
function handleChangePassword(params) {
  if (!verifyAdminPassword(params.oldPwd)) return { ok: false, error: '舊密碼錯誤' };

  const newPwd = params.newPwd || '';
  if (newPwd.length < 6) return { ok: false, error: '新密碼至少 6 碼' };

  const salt = generateSalt();
  const hash = hashPassword(newPwd, salt);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_ADMIN_HASH, hash);
  props.setProperty(PROP_ADMIN_SALT, salt);
  return { ok: true };
}

/* ===== 內部工具函式 ===== */

function getActivitiesConfig() {
  const props = PropertiesService.getScriptProperties();
  const json = props.getProperty(PROP_ACTIVITIES);
  if (json) return JSON.parse(json);
  return { activities: [], publicToken: generatePublicToken() };
}

function saveActivitiesConfig(config) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_ACTIVITIES, JSON.stringify(config));
}

function generatePublicToken() {
  return 'pub_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function generateCategoryPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 6; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

function clearActivityCache(actId) {
  CacheService.getScriptCache().removeAll();
}

function verifyAdminPassword(pwd) {
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty(PROP_ADMIN_HASH);
  const salt = props.getProperty(PROP_ADMIN_SALT);
  if (!hash || !salt) return false;
  return verifyPassword(pwd, hash, salt);
}

function hashPassword(pwd, salt) {
  const input = pwd + ':' + salt;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return bytesToHex(digest);
}

function verifyPassword(pwd, hash, salt) {
  return hashPassword(pwd, salt) === hash;
}

function generateSalt() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Math.random().toString(36) + Date.now());
  return bytesToHex(bytes).slice(0, 16);
}

function bytesToHex(bytes) {
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function extractSheetId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

/** 暫時函式：預設管理密碼為 cyccadmin */
function setDefaultAdminPassword() {
  const pwd = 'cyccadmin';
  const salt = generateSalt();
  const hash = hashPassword(pwd, salt);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_ADMIN_HASH, hash);
  props.setProperty(PROP_ADMIN_SALT, salt);
  return '管理密碼已設定為 cyccadmin';
}

/**
 * 讀取試算表，回傳 headers 與 rawRows（所有列、原始欄位）
 */
function readSpreadsheetData(activity) {
  try {
    const ss = SpreadsheetApp.openById(activity.sheetId);
    let sheet;
    if (activity.sheetName) {
      sheet = ss.getSheetByName(activity.sheetName);
      if (!sheet) return { ok: false, error: '找不到指定工作表：' + activity.sheetName };
    } else {
      sheet = ss.getSheets()[0];
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, headers: [], rawRows: [] };

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    const rawRows = data
      .filter(row => row.some(cell => String(cell).trim() !== '')) // 略過全空白列
      .map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
      });

    return { ok: true, headers, rawRows };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
}

/**
 * 收集某欄位的所有唯一值與數量
 */
function collectCategories(rows, field) {
  const map = {};
  rows.forEach(r => {
    const v = String(r[field] ?? '').trim();
    if (!v) return;
    map[v] = (map[v] || 0) + 1;
  });
  return Object.entries(map).map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
}
