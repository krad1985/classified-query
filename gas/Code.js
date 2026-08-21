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
        result = handleListActivities(e.parameter);
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
      case 'unit_login':
        result = handleUnitLogin(e.parameter);
        break;
      case 'listUnitsPublic':
        result = handleListUnitsPublic(e.parameter);
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
      case 'createUnit':
        result = handleCreateUnit(e.parameter);
        break;
      case 'listUnits':
        result = handleListUnits(e.parameter);
        break;
      case 'deleteUnit':
        result = handleDeleteUnit(e.parameter);
        break;
      case 'setUnitPassword':
        result = handleSetUnitPassword(e.parameter);
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
 * 取得活動列表
 * - 無 unit 參數：只回傳「公開」活動（unit 為空），token 為全域 publicToken
 * - 有 unit 參數：需驗證 unitToken（單位專屬），回傳該單位活動
 */
function handleListActivities(params) {
  const index = getConfigIndex();
  const unitId = params.unit || '';
  const unitToken = params.unitToken || '';

  if (!unitId) {
    // 公開活動
    const activities = index.activityIds
      .map(id => getActivityById(id))
      .filter(a => a && !a.unit)
      .map(a => ({ id: a.id, name: a.name }));
    return { ok: true, activities, publicToken: index.publicToken || '' };
  }

  // 單位活動：驗證單位專屬 token
  const unit = getUnitById(unitId);
  if (!unit) return { ok: false, error: '找不到該單位' };
  if (!unit.token || unit.token !== unitToken) {
    return { ok: false, code: 'NEED_UNIT_TOKEN', error: '單位 Token 驗證失敗' };
  }
  const activities = index.activityIds
    .map(id => getActivityById(id))
    .filter(a => a && a.unit === unitId)
    .map(a => ({ id: a.id, name: a.name }));
  return { ok: true, activities, publicToken: unit.token || '' };
}

/**
 * 取得單一活動的資訊：顯示欄位、分類清單（含鎖定標記，但不含密碼）
 */
/**
 * 活動存取驗證：
 * 1. token 必須匹配（全域公開 token 或單位 token）
 * 2. 活動 accessKey 非空白時，key 必須相符（否則回傳 NEED_KEY）
 * 回傳 { ok, error, code, activity } 或拋出
 */
function authorizeActivity(params, activity) {
  const index = getConfigIndex();
  const token = params.token || '';
  const key = params.key || '';

  // token 驗證：全域 or 該單位 token
  const unitToken = activity.unit ? (getUnitById(activity.unit)?.token || '') : '';
  const validToken = activity.unit ? unitToken : (index.publicToken || '');
  if (validToken && token !== validToken) {
    return { ok: false, code: 'BAD_TOKEN', error: 'Token 驗證失敗' };
  }

  // 活動金鑰：accessKey 非空白時需 key 相符；空白則僅顯示隔離
  const accessKey = activity.accessKey || '';
  if (accessKey && key !== accessKey) {
    return { ok: false, code: 'NEED_KEY', error: '此活動需輸入存取金鑰' };
  }
  return { ok: true, activity };
}

function handleGetActivityInfo(params) {
  const actId = params.act;
  if (!actId) return { ok: false, error: '缺少活動 ID' };

  const activity = getActivityById(actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  const auth = authorizeActivity(params, activity);
  if (!auth.ok) return { ok: false, code: auth.code || undefined, error: auth.error };

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
      displayFields: activity.displayFields || [],
      defaultSortField: activity.defaultSortField || '',
      defaultSortDir: activity.defaultSortDir || 'asc',
      unit: activity.unit || '',
      recColWidths: computeRecColWidths(data.headers, data.rawRows, activity.displayFields || [])
    },
    categories: categories.map(c => ({
      name: c.name,
      count: c.count,
      locked: !!protectedSet[c.name]
    }))
  };
}

/**
 * 依實際填寫內容估算各顯示欄位的建議欄寬（px）
 * - 字寬估算：CJK/全形字元記 2 單位、其餘記 1 單位，1 單位 ≈ 7.5px
 * - 取第 4 長的內容為基準，避免少數離峰超長資料把欄寬撐爆
 * - 同時考慮欄位標題長度（標題最多貢獻 20 單位）
 * - 夾在 120–640px（與前端 COL_MIN/COL_MAX 一致）
 */
function estimateTextUnits(text) {
  let u = 0;
  for (const ch of String(text)) {
    u += ch.codePointAt(0) > 0x2E7F ? 2 : 1;
  }
  return u;
}

function computeRecColWidths(headers, rawRows, fields) {
  const UNIT_PX = 7.5;
  const PADDING_PX = 40;
  const MIN_W = 120;
  const MAX_W = 640;
  const rec = {};
  if (!fields || !fields.length) return rec;
  fields.forEach(f => {
    if (headers.indexOf(f) < 0) return;
    const lens = [];
    rawRows.forEach(row => {
      const v = row[f];
      if (v === null || v === undefined) return;
      const s = String(v).trim();
      if (s === '') return;
      lens.push(estimateTextUnits(s));
    });
    lens.sort(function(a, b) { return b - a; });
    const base = lens.length > 3 ? lens[3] : (lens[0] || 0);
    const headerUnits = Math.min(estimateTextUnits(f), 20);
    const units = Math.max(base, headerUnits);
    rec[f] = Math.max(MIN_W, Math.min(MAX_W, Math.round(units * UNIT_PX + PADDING_PX)));
  });
  return rec;
}

/**
 * 取得指定活動的報名名單（依分類過濾 + 密碼驗證）
 * params: act, token, cat, pwd
 */
function handleGetList(params) {
  const actId = params.act;
  const cat = params.cat || '';
  const pwd = params.pwd || '';

  if (!actId) return { ok: false, error: '缺少活動 ID' };

  const activity = getActivityById(actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  const auth = authorizeActivity(params, activity);
  if (!auth.ok) return { ok: false, code: auth.code, error: auth.error };

  const categoryField = activity.categoryField;
  const protectedSet = activity.protectedCategories || {};

  // 若指定分類且該分類被鎖定，需驗證密碼
  if (cat && protectedSet[cat] && protectedSet[cat] !== pwd) {
    return { ok: false, code: 'NEED_PWD', error: '此分類已鎖定，需輸入正確密碼' };
  }

  // 快取（key 含 cacheVersion，變更設定後世代遞增使舊快取失效）
  const cacheKey = CACHE_PREFIX + actId + '_v' + (activity.cacheVersion || 0) + '_' + cat;
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

  try {
    cache.put(cacheKey, JSON.stringify(result), CACHE_TTL);
  } catch (e) {
    // 資料過大（>100KB）無法寫入 CacheService 時略過，功能不受影響
  }
  return result;
}

/**
 * 後台權限驗證：回傳 { role: 'admin' } 或 { role: 'unit', unit }
 * 優先判別單位管理員（unit + unitPwd），其次總管理員（pwd）
 */
function resolveAdminAuth(params) {
  if (params.unit && params.unitPwd) {
    const unit = getUnitById(params.unit);
    if (unit && verifyUnitAdminPassword(unit, params.unitPwd)) {
      return { role: 'unit', unit };
    }
    return null;
  }
  if (verifyAdminPassword(params.pwd)) return { role: 'admin' };
  return null;
}

/**
 * 測試試算表連線並回傳欄位清單（含分類欄位建議用下拉）
 */
function handleTestConnection(params) {
  const url = params.url;
  if (!resolveAdminAuth(params)) {
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
 * 取得分類欄位的唯一值（需管理權限）
 */
function handleGetCategoryValues(params) {
  if (!resolveAdminAuth(params)) {
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
 * 單位管理員登入驗證
 */
function handleUnitLogin(params) {
  const unitId = params.unit || '';
  const pwd = params.pwd || '';
  if (!unitId) return { ok: false, error: '缺少單位 ID' };
  const unit = getUnitById(unitId);
  if (!unit) return { ok: false, error: '找不到該單位' };
  if (!verifyUnitAdminPassword(unit, pwd)) return { ok: false, error: '單位管理密碼錯誤' };
  return { ok: true, unit: { id: unit.id, name: unit.name, token: unit.token || '' } };
}

/**
 * 驗證單位管理員密碼
 */
function verifyUnitAdminPassword(unit, pwd) {
  if (!unit || !unit.adminHash || !unit.adminSalt) return false;
  return verifyPassword(pwd || '', unit.adminHash, unit.adminSalt);
}

/**
 * 取得設定（依權限）
 * - 總管理員：所有活動 + 所有單位 + 全域 publicToken
 * - 單位管理員：該單位活動（不洩漏其他單位）
 */
function handleGetConfig(params) {
  // 單位管理員優先（unitPwd 需配對 unit）
  if (params.unit && params.unitPwd) {
    const unit = getUnitById(params.unit);
    if (!unit) return { ok: false, error: '找不到該單位' };
    if (!verifyUnitAdminPassword(unit, params.unitPwd)) return { ok: false, error: '單位管理密碼錯誤' };
    const activities = getAllActivities().filter(a => a.unit === unit.id);
    return {
      ok: true,
      role: 'unit',
      unit: { id: unit.id, name: unit.name, token: unit.token || '' },
      config: { activities, units: [{ id: unit.id, name: unit.name, token: unit.token || '' }] }
    };
  }

  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const index = getConfigIndex();
  const units = index.units.map(id => getUnitById(id)).filter(u => u);
  const allActivities = getAllActivities();
  return {
    ok: true,
    role: 'admin',
    config: {
      activities: allActivities,
      units: units.map(u => ({
        id: u.id,
        name: u.name,
        token: u.token || '',
        activityCount: allActivities.filter(a => a.unit === u.id).length
      })),
      publicToken: index.publicToken || ''
    }
  };
}

/**
 * 建立單位（總管理員限定）
 * 單位管理員密碼由總管理員設定；產生單位專屬 token 供查詢頁隔離驗證
 */
function handleCreateUnit(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };
  const name = (params.name || '').trim();
  const unitAdminPwd = params.unitAdminPwd || '';
  if (!name) return { ok: false, error: '請輸入單位名稱' };
  if (unitAdminPwd.length < 6) return { ok: false, error: '單位管理密碼至少 6 碼' };

  const unitId = 'unit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const salt = generateSalt();
  const unit = {
    id: unitId,
    name,
    adminHash: hashPassword(unitAdminPwd, salt),
    adminSalt: salt,
    token: generatePublicToken()
  };
  saveUnitRecord(unit);

  const index = getConfigIndex();
  index.units.push(unitId);
  saveConfigIndex(index);

  return { ok: true, id: unitId, name, token: unit.token };
}

/**
 * 公開列出單位（不需密碼）：供後台登入頁的下拉選單使用
 * 僅回傳 id/name，不含 token 等敏感資訊
 */
function handleListUnitsPublic(params) {
  const index = getConfigIndex();
  const units = index.units.map(id => getUnitById(id)).filter(u => u);
  return {
    ok: true,
    units: units.map(u => ({ id: u.id, name: u.name }))
  };
}

/**
 * 列出單位（總管理員限定）
 */
function handleListUnits(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };
  const index = getConfigIndex();
  const units = index.units.map(id => getUnitById(id)).filter(u => u);
  return {
    ok: true,
    units: units.map(u => ({ id: u.id, name: u.name, token: u.token || '', activityCount: getAllActivities().filter(a => a.unit === u.id).length }))
  };
}

/**
 * 刪除單位（總管理員限定）——僅允許刪除無活動的單位
 */
function handleDeleteUnit(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };
  const unitId = params.id;
  if (!unitId) return { ok: false, error: '缺少單位 ID' };
  const unit = getUnitById(unitId);
  if (!unit) return { ok: false, error: '找不到該單位' };

  const hasActivities = getAllActivities().some(a => a.unit === unitId);
  if (hasActivities) return { ok: false, error: '該單位尚有活動，請先刪除或移轉活動' };

  deleteUnitRecord(unitId);
  const index = getConfigIndex();
  index.units = index.units.filter(u => u !== unitId);
  saveConfigIndex(index);
  return { ok: true };
}

/**
 * 重設單位管理密碼（總管理員限定）
 */
function handleSetUnitPassword(params) {
  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };
  const unitId = params.id;
  const newPwd = params.newPwd || '';
  if (!unitId) return { ok: false, error: '缺少單位 ID' };
  if (newPwd.length < 6) return { ok: false, error: '新密碼至少 6 碼' };

  const unit = getUnitById(unitId);
  if (!unit) return { ok: false, error: '找不到該單位' };

  const salt = generateSalt();
  unit.adminHash = hashPassword(newPwd, salt);
  unit.adminSalt = salt;
  saveUnitRecord(unit);
  return { ok: true };
}

/**
 * 儲存/更新活動設定
 * - 總管理員：可設任意 unit / 金鑰
 * - 單位管理員：僅能存取自己單位的活動；unit 鎖定為自己的單位
 */
function handleSaveActivity(params) {
  // 單位管理員優先
  if (params.unit && params.unitPwd) {
    const unit = getUnitById(params.unit);
    if (!unit) return { ok: false, error: '找不到該單位' };
    if (!verifyUnitAdminPassword(unit, params.unitPwd)) return { ok: false, error: '單位管理密碼錯誤' };

    const activityData = JSON.parse(params.data || '{}');
    // 鎖定 unit 為自己的單位
    activityData.unit = unit.id;
    // 單位管理員不能設定存取金鑰以外的欄位限制？仍可設 accessKey（單位的公開金鑰由總管理員控管）
    activityData.protectedCategories = activityData.protectedCategories || {};
    activityData.cacheVersion = (activityData.cacheVersion || 0) + 1;

    if (!activityData.id) {
      activityData.id = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      saveActivityRecord(activityData);
      const index = getConfigIndex();
      index.activityIds.push(activityData.id);
      saveConfigIndex(index);
    } else {
      // 更新：確保編輯的是自己單位的活動
      const existing = getActivityById(activityData.id);
      if (!existing) return { ok: false, error: '找不到該活動' };
      if (existing.unit !== unit.id) return { ok: false, error: '不可編輯其他單位的活動' };
      saveActivityRecord(activityData);
    }
    return { ok: true, id: activityData.id };
  }

  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const activityData = JSON.parse(params.data || '{}');
  activityData.protectedCategories = activityData.protectedCategories || {};
  activityData.cacheVersion = (activityData.cacheVersion || 0) + 1;

  if (!activityData.id) {
    activityData.id = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    saveActivityRecord(activityData);
    const index = getConfigIndex();
    index.activityIds.push(activityData.id);
    saveConfigIndex(index);
  } else {
    saveActivityRecord(activityData);
  }

  return { ok: true, id: activityData.id };
}

/**
 * 刪除活動
 * - 總管理員：可刪任何
 * - 單位管理員：僅能刪自己單位的活動
 */
function handleDeleteActivity(params) {
  if (params.unit && params.unitPwd) {
    const unit = getUnitById(params.unit);
    if (!unit) return { ok: false, error: '找不到該單位' };
    if (!verifyUnitAdminPassword(unit, params.unitPwd)) return { ok: false, error: '單位管理密碼錯誤' };

    const id = params.id;
    if (!id) return { ok: false, error: '缺少活動 ID' };
    const existing = getActivityById(id);
    if (!existing) return { ok: false, error: '找不到該活動' };
    if (existing.unit !== unit.id) return { ok: false, error: '不可刪除其他單位的活動' };

    deleteActivityRecord(id);
    const index = getConfigIndex();
    index.activityIds = index.activityIds.filter(a => a !== id);
    saveConfigIndex(index);
    return { ok: true };
  }

  if (!verifyAdminPassword(params.pwd)) return { ok: false, error: '管理密碼錯誤' };

  const id = params.id;
  if (!id) return { ok: false, error: '缺少活動 ID' };

  deleteActivityRecord(id);
  const index = getConfigIndex();
  index.activityIds = index.activityIds.filter(a => a !== id);
  saveConfigIndex(index);
  return { ok: true };
}

/**
 * 生成分類密碼（總管理員或該單位管理員）並回存
 */
function handleGenerateCategoryPassword(params) {
  const actId = params.act;
  const cat = params.cat;
  if (!actId || !cat) return { ok: false, error: '缺少活動或分類' };

  const activity = getActivityById(actId);
  if (!activity) return { ok: false, error: '找不到該活動' };

  // 單位管理員：驗證屬於自己單位
  if (params.unit && params.unitPwd) {
    const unit = getUnitById(params.unit);
    if (!unit) return { ok: false, error: '找不到該單位' };
    if (!verifyUnitAdminPassword(unit, params.unitPwd)) return { ok: false, error: '單位管理密碼錯誤' };
    if (activity.unit !== unit.id) return { ok: false, error: '不可編輯其他單位的活動' };
  } else if (!verifyAdminPassword(params.pwd)) {
    return { ok: false, error: '管理密碼錯誤' };
  }

  activity.protectedCategories = activity.protectedCategories || {};
  const password = generateCategoryPassword();
  activity.protectedCategories[cat] = password;
  activity.cacheVersion = (activity.cacheVersion || 0) + 1;

  saveActivityRecord(activity);
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

// 分 key 儲存架構：
//   ACTIVITIES_INDEX  → { publicToken, units: [unitId], activityIds: [actId] }   (索引，很小)
//   ACT_<id>          → 單一活動完整設定（欄位/分類鎖/金鑰/unit）
//   UNIT_<id>         → 單一單位：{ id, name, adminHash, adminSalt }
// 避免單一 Script Property 超過 9KB / 總量 500KB，且讀寫只動到單一活動

function getConfigIndex() {
  const props = PropertiesService.getScriptProperties();
  const json = props.getProperty(PROP_ACTIVITIES);
  if (json) {
    // 舊格式（單一 property 存整個 config）→ 遷移為分 key 儲存
    try {
      const legacy = JSON.parse(json);
      if (legacy.activities || legacy.publicToken) {
        const index = { publicToken: legacy.publicToken || '', units: [], activityIds: [] };
        (legacy.activities || []).forEach(a => {
          if (a.id) {
            props.setProperty('ACT_' + a.id, JSON.stringify(a));
            index.activityIds.push(a.id);
          }
        });
        // 移除舊 property，避免重複遷移
        props.deleteProperty(PROP_ACTIVITIES);
        props.setProperty('ACTIVITIES_INDEX', JSON.stringify(index));
        return index;
      }
    } catch (e) {
      // 忽略解析錯誤，走新結構
    }
  }
  const idxJson = props.getProperty('ACTIVITIES_INDEX');
  if (idxJson) {
    try { return JSON.parse(idxJson); } catch (e) { /* 破損則重建 */ }
  }
  return { publicToken: generatePublicToken(), units: [], activityIds: [] };
}

function saveConfigIndex(index) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ACTIVITIES_INDEX', JSON.stringify(index));
}

function getActivityById(actId) {
  const props = PropertiesService.getScriptProperties();
  const json = props.getProperty('ACT_' + actId);
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

function saveActivityRecord(act) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ACT_' + act.id, JSON.stringify(act));
}

function deleteActivityRecord(actId) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('ACT_' + actId);
}

function getUnitById(unitId) {
  const props = PropertiesService.getScriptProperties();
  const json = props.getProperty('UNIT_' + unitId);
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

function saveUnitRecord(unit) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('UNIT_' + unit.id, JSON.stringify(unit));
}

function deleteUnitRecord(unitId) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('UNIT_' + unitId);
}

// 取得所有活動（依索引）
function getAllActivities() {
  const index = getConfigIndex();
  return index.activityIds
    .map(id => getActivityById(id))
    .filter(a => a);
}

// 向後相容：listActivities 需回傳 { ok, activities, publicToken }
function getActivitiesConfig() {
  const index = getConfigIndex();
  return {
    activities: getAllActivities(),
    publicToken: index.publicToken,
    units: index.units.map(id => getUnitById(id)).filter(u => u)
  };
}

function saveActivitiesConfig(config) {
  // 向後相容寫入：拆解為分 key 儲存
  const index = getConfigIndex();
  const newIds = [];
  (config.activities || []).forEach(a => {
    if (!a.id) return;
    saveActivityRecord(a);
    newIds.push(a.id);
  });
  index.activityIds = newIds;
  if (config.publicToken) index.publicToken = config.publicToken;
  // units
  const unitIds = [];
  (config.units || []).forEach(u => {
    if (!u.id) return;
    saveUnitRecord(u);
    unitIds.push(u.id);
  });
  index.units = unitIds;
  saveConfigIndex(index);
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
