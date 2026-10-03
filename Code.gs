/**
 * 舞蹈教室報到系統 — Google Apps Script 後端
 * @OnlyCurrentDoc  （只存取這一份試算表，不要求存取全部試算表）
 * 綁定在 Google Sheet 上（擴充功能 > Apps Script），貼上後先執行 setup()
 *
 * 指令碼屬性（專案設定 > 指令碼屬性）需手動填：
 *   LINE_CHANNEL_ACCESS_TOKEN  Messaging API 的 Channel access token
 *   LINE_LOGIN_CHANNEL_ID      LINE Login channel 的 Channel ID（LIFF 所屬）
 *   LIFF_ID                    LIFF ID
 *   SITE_URL                   網頁所在網址（GitHub Pages），圖文選單圖片從這裡讀
 * setup() 會自動產生：WEBHOOK_KEY、QR_SECRET
 */

const TZ = 'Asia/Taipei';

const SHEETS = {
  '系統設定': ['設定項目', '設定值', '說明'],
  '選單': ['順序', '名稱', '圖示', '功能代碼', '啟用'],
  '學生名冊': ['學生ID', '姓名', '生日', '電話', '綁定碼', '狀態', '備註', '建立時間'],
  '家長綁定': ['LINE_userId', 'LINE名稱', '學生ID', '關係', '綁定時間', '狀態'],
  '管理員': ['LINE_userId', '姓名', '角色', '啟用'],
  '課程': ['課程ID', '課程名稱', '老師', '星期', '開始時間', '結束時間', '教室', '扣堂數', '人數上限', '狀態'],
  '選課': ['學生ID', '課程ID', '加入日期', '狀態'],
  '課表場次': ['場次ID', '課程ID', '日期', '開始時間', '結束時間', '狀態', '備註'],
  '方案': ['方案ID', '方案名稱', '堂數', '價格', '有效天數', '啟用'],
  '上課卡': ['卡ID', '學生ID', '方案名稱', '總堂數', '剩餘堂數', '購買日', '到期日', '狀態'],
  '儲值紀錄': ['紀錄ID', '時間', '學生ID', '方案名稱', '堂數', '金額', '付款方式', '經手人', '卡ID', '備註'],
  '出席紀錄': ['紀錄ID', '場次ID', '學生ID', '狀態', '報到方式', '時間', '扣堂數', '卡ID', '操作者', '備註'],
  '請假紀錄': ['請假ID', '學生ID', '場次ID', '原因', '申請時間', '申請人', '狀態', '申請人userId'],
  '影片': ['影片ID', '標題', '課程ID', '學生ID', '日期', '連結', '狀態']
};

const SAMPLE = {
  '系統設定': [
    ['教室名稱', '章魚老師舞蹈教室', '顯示在 LINE 與網頁上的名稱'],
    ['報到開放分鐘前', '30', '上課前幾分鐘開放線上報到'],
    ['報到截止分鐘後', '30', '上課後幾分鐘內仍可線上報到'],
    ['QR更新秒數', '60', '教室報到 QR Code 多久換一次（防止轉傳）'],
    ['無堂數可線上報到', '否', '是：沒有可用上課卡也能線上報到（不扣堂）'],
    ['僅限選課學生報到', '否', '是：只有「選課」分頁內的學生可線上報到該課'],
    ['請假截止小時', '2', '上課前幾小時內不可線上請假'],
    ['請假需審核', '否', '是：請假需後台核准才生效'],
    ['請假扣堂', '否', '是：請假也扣堂'],
    ['缺席扣堂', '是', '是：未請假缺席（場次結算時）扣堂'],
    ['產生場次週數', '4', '自動產生未來幾週的課表場次'],
    ['課表顯示天數', '28', '家長端課表顯示未來幾天'],
    ['低堂數門檻', '2', '剩餘堂數小於等於此數字時提醒'],
    ['儲值推播', '是', '儲值後推播通知家長（會消耗 LINE 推播則數）'],
    ['報到推播', '否', '報到後推播通知家長（會消耗 LINE 推播則數）'],
    ['低堂數推播', '是', '堂數不足時推播通知家長（會消耗 LINE 推播則數）']
  ],
  '選單': [
    ['1', '線上報到', '✅', 'checkin', '是'],
    ['2', '上課卡', '🎫', 'card', '是'],
    ['3', '出席紀錄', '📋', 'attendance', '是'],
    ['4', '課表', '📅', 'schedule', '是'],
    ['5', '請假', '📝', 'leave', '是'],
    ['6', '影片', '🎬', 'video', '是'],
    ['7', '綁定學生', '🔗', 'bind', '是']
  ],
  '方案': [
    ['P01', '單堂', '1', '500', '30', '是'],
    ['P02', '10堂卡', '10', '4500', '90', '是'],
    ['P03', '20堂卡', '20', '8000', '180', '是']
  ],
  '課程': [
    ['C01', '（範例）兒童街舞初級', '王老師', '三', '19:00', '20:00', 'A教室', '1', '15', '啟用'],
    ['C02', '（範例）芭蕾基礎', '林老師', '六', '10:00', '11:30', 'B教室', '1', '12', '啟用']
  ]
};

/* ============================== 基礎工具 ============================== */

let _ss = null;
const _tb = {};
function ss() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet()); }
function sh(name) {
  const s = ss().getSheetByName(name);
  if (!s) throw new Error('找不到分頁：' + name + '（請先執行 setup）');
  return s;
}
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function pad(n, len) { return ('0000000000' + n).slice(-len); }
function now() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function uid(prefix) { return prefix + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + pad(Math.floor(Math.random() * 1000), 3); }
function nd(s) { // 日期正規化成 yyyy-MM-dd
  const m = String(s || '').trim().match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  return m ? m[1] + '-' + pad(m[2], 2) + '-' + pad(m[3], 2) : String(s || '').trim();
}
function nt(s) { // 時間正規化成 HH:mm
  const m = String(s || '').trim().match(/(\d{1,2}):(\d{2})/);
  return m ? pad(m[1], 2) + ':' + m[2] : '';
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  return Utilities.formatDate(new Date(d.getTime() + n * 86400000), TZ, 'yyyy-MM-dd');
}
function toDate(dateStr, timeStr) { return new Date(nd(dateStr) + 'T' + (nt(timeStr) || '00:00') + ':00+08:00'); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function sha(s) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }

function headers(name) {
  const s = sh(name);
  return s.getRange(1, 1, 1, s.getLastColumn()).getDisplayValues()[0].map(function (h) { return h.trim(); });
}
function table(name) {
  if (_tb[name]) return _tb[name];
  const v = sh(name).getDataRange().getDisplayValues();
  const h = v[0].map(function (x) { return x.trim(); });
  const rows = [];
  for (let i = 1; i < v.length; i++) {
    if (v[i].join('') === '') continue;
    const o = { _row: i + 1 };
    h.forEach(function (k, j) { if (k) o[k] = String(v[i][j]).trim(); });
    rows.push(o);
  }
  return (_tb[name] = rows);
}
function insertMany(name, list) {
  if (!list.length) return;
  const s = sh(name), h = headers(name);
  const data = list.map(function (o) { return h.map(function (k) { return o[k] === undefined || o[k] === null ? '' : String(o[k]); }); });
  s.getRange(s.getLastRow() + 1, 1, data.length, h.length).setNumberFormat('@').setValues(data);
  delete _tb[name];
}
function insert(name, obj) { insertMany(name, [obj]); }
function update(name, row, patch) {
  const s = sh(name), h = headers(name);
  const rg = s.getRange(row, 1, 1, h.length);
  const cur = rg.getDisplayValues()[0];
  h.forEach(function (k, j) { if (patch[k] !== undefined) cur[j] = String(patch[k]); });
  rg.setNumberFormat('@').setValues([cur]);
  delete _tb[name];
}
function find(name, key, val) { return table(name).filter(function (r) { return r[key] === val; })[0] || null; }

function cfg(key, def) {
  const r = find('系統設定', '設定項目', key);
  return r && r['設定值'] !== '' ? r['設定值'] : (def === undefined ? '' : def);
}
function cfgOn(key) { return cfg(key, '否') === '是'; }
function cfgNum(key, def) { const n = Number(cfg(key, def)); return isNaN(n) ? def : n; }

/* ============================== 進入點 ============================== */

function doGet() { return json({ ok: true, msg: '舞蹈教室報到系統運作中' }); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* ignore */ }
  if (body.events) { // LINE Webhook
    if (!prop('WEBHOOK_KEY') || e.parameter.key !== prop('WEBHOOK_KEY')) return json({ ok: false });
    handleWebhook(body.events);
    return json({ ok: true });
  }
  return json(handleApi(body));
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

const WRITE = { 'bind': 1, 'leave': 1, 'checkin': 1, 'a.addStudent': 1, 'a.topup': 1, 'a.mark': 1, 'a.close': 1, 'a.reviewLeave': 1, 'a.genSessions': 1 };

function handleApi(b) {
  try {
    const user = verifyIdToken(b.idToken);
    const fn = API[b.action];
    if (!fn) throw new Error('未知的操作：' + b.action);
    if (String(b.action).indexOf('a.') === 0) user.admin = assertAdmin(user);
    const lock = WRITE[b.action] ? LockService.getScriptLock() : null;
    if (lock) lock.waitLock(20000);
    try { return { ok: true, data: fn(b, user) }; }
    finally { if (lock) lock.releaseLock(); }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ============================== 身分驗證 ============================== */

function verifyIdToken(idToken) {
  if (!idToken) throw new Error('AUTH');
  const cache = CacheService.getScriptCache();
  const key = 'tk_' + sha(idToken);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LINE_LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('AUTH');
  const d = JSON.parse(res.getContentText());
  const u = { userId: d.sub, name: d.name || '' };
  cache.put(key, JSON.stringify(u), 600);
  return u;
}
function adminOf(userId) {
  return table('管理員').filter(function (r) { return r['LINE_userId'] === userId && r['啟用'] === '是'; })[0] || null;
}
function assertAdmin(user) {
  const a = adminOf(user.userId);
  if (!a) throw new Error('沒有後台權限');
  return a;
}
function kidsOf(userId) {
  const ids = table('家長綁定').filter(function (r) { return r['LINE_userId'] === userId && r['狀態'] === '啟用'; })
    .map(function (r) { return r['學生ID']; });
  return table('學生名冊').filter(function (s) { return ids.indexOf(s['學生ID']) >= 0 && s['狀態'] !== '停用'; });
}
function assertOwns(user, studentId) {
  if (!kidsOf(user.userId).some(function (s) { return s['學生ID'] === studentId; })) throw new Error('您尚未綁定這位學生');
}
function parentsOf(studentId) {
  return table('家長綁定').filter(function (r) { return r['學生ID'] === studentId && r['狀態'] === '啟用'; })
    .map(function (r) { return r['LINE_userId']; });
}

/* ============================== 商業邏輯 ============================== */

/** 一張上課卡可多位學生共用：「學生ID」欄用逗號分隔，例 S0001,S0002 */
function cardIds(c) { return String(c['學生ID'] || '').split(/[,，、;\s]+/).filter(function (x) { return x; }); }
function cardHas(c, studentId) { return cardIds(c).indexOf(studentId) >= 0; }
function validCards(studentId) {
  const t = today();
  return table('上課卡').filter(function (c) {
    return cardHas(c, studentId) && c['狀態'] === '啟用' && Number(c['剩餘堂數']) > 0 &&
      (!c['到期日'] || nd(c['到期日']) >= t);
  }).sort(function (a, b) { return (nd(a['到期日']) || '9999') < (nd(b['到期日']) || '9999') ? -1 : 1; });
}
function totalRemain(studentId) {
  return validCards(studentId).reduce(function (n, c) { return n + Number(c['剩餘堂數']); }, 0);
}
function pickCard(studentId, need) {
  return validCards(studentId).filter(function (c) { return Number(c['剩餘堂數']) >= need; })[0] || null;
}
function shouldDeduct(status) {
  if (status === '出席') return true;
  if (status === '請假') return cfgOn('請假扣堂');
  if (status === '缺席') return cfgOn('缺席扣堂');
  return false;
}
function sessionInfo(sess) {
  const c = find('課程', '課程ID', sess['課程ID']) || {};
  return {
    sessionId: sess['場次ID'], courseId: sess['課程ID'], course: c['課程名稱'] || sess['課程ID'],
    teacher: c['老師'] || '', room: c['教室'] || '', date: nd(sess['日期']),
    start: nt(sess['開始時間']), end: nt(sess['結束時間']), status: sess['狀態'] || '正常'
  };
}
function activeRecord(sessionId, studentId) {
  return table('出席紀錄').filter(function (r) {
    return r['場次ID'] === sessionId && r['學生ID'] === studentId && r['狀態'] !== '取消';
  })[0] || null;
}

/** 寫入出席狀態（出席/請假/缺席/取消），自動處理扣堂與退堂 */
function recordAttendance(sess, studentId, status, method, operator) {
  const course = find('課程', '課程ID', sess['課程ID']) || {};
  const old = activeRecord(sess['場次ID'], studentId);
  if (old && old['狀態'] === status) return { dup: true, status: status, deduct: 0, remain: totalRemain(studentId) };
  if (old) { // 取消舊紀錄並退堂
    if (Number(old['扣堂數']) > 0 && old['卡ID']) {
      const oc = find('上課卡', '卡ID', old['卡ID']);
      if (oc) update('上課卡', oc._row, { '剩餘堂數': Number(oc['剩餘堂數']) + Number(old['扣堂數']), '狀態': oc['狀態'] === '用完' ? '啟用' : oc['狀態'] });
    }
    update('出席紀錄', old._row, { '狀態': '取消', '備註': (old['備註'] ? old['備註'] + '；' : '') + '原為' + old['狀態'] + '，' + now() + ' 由 ' + operator + ' 變更' });
  }
  if (status === '取消') return { status: '取消', deduct: 0, remain: totalRemain(studentId) };

  let deduct = 0, cardId = '', note = '';
  const need = shouldDeduct(status) ? (Number(course['扣堂數']) || 1) : 0;
  if (need > 0) {
    const card = pickCard(studentId, need);
    if (card) {
      const left = Number(card['剩餘堂數']) - need;
      update('上課卡', card._row, { '剩餘堂數': left, '狀態': left <= 0 ? '用完' : '啟用' });
      deduct = need; cardId = card['卡ID'];
    } else {
      note = '無可用上課卡，未扣堂';
    }
  }
  insert('出席紀錄', {
    '紀錄ID': uid('A'), '場次ID': sess['場次ID'], '學生ID': studentId, '狀態': status, '報到方式': method,
    '時間': now(), '扣堂數': deduct, '卡ID': cardId, '操作者': operator, '備註': note
  });
  const remain = totalRemain(studentId);
  notifyAfterAttendance(sess, studentId, status, deduct, remain);
  return { status: status, deduct: deduct, remain: remain, note: note };
}

function notifyAfterAttendance(sess, studentId, status, deduct, remain) {
  try {
    const stu = find('學生名冊', '學生ID', studentId) || {};
    const name = stu['姓名'] || studentId;
    const info = sessionInfo(sess);
    const low = deduct > 0 && cfgOn('低堂數推播') && remain <= cfgNum('低堂數門檻', 2);
    let msg = null;
    if (status === '出席' && cfgOn('報到推播')) {
      msg = flexMsg('✅ ' + name + ' 已報到｜剩餘 ' + remain + ' 堂', [flexBubble({
        color: C_BRAND, title: '報到成功', name: name,
        rows: [['課程', info.course], ['時間', info.date + ' ' + info.start], ['教室', info.room]],
        big: { label: '剩餘堂數', value: remain, unit: '堂', color: low ? C_WARN : C_BRAND },
        note: low ? '堂數即將用完，請記得儲值' : '', btn: ['查看出席紀錄', 'attendance']
      })]);
    } else if (low) {
      msg = flexMsg('🔔 ' + name + ' 剩餘 ' + remain + ' 堂，請記得儲值', [flexBubble({
        color: C_WARN, title: '堂數即將用完', name: name,
        rows: [['提醒', '請記得到櫃檯儲值']],
        big: { label: '剩餘堂數', value: remain, unit: '堂' }, btn: ['查看上課卡', 'card']
      })]);
    }
    if (msg) pushMsg(parentsOf(studentId), msg);
  } catch (err) { console.error(err); }
}

function qrToken(sessionId, offset) {
  const win = cfgNum('QR更新秒數', 60);
  const idx = Math.floor(Date.now() / 1000 / win) + (offset || 0);
  return hex(Utilities.computeHmacSha256Signature(sessionId + '|' + idx, prop('QR_SECRET'))).slice(0, 10);
}
function liffUrl(page, extra) {
  return 'https://liff.line.me/' + prop('LIFF_ID') + '?page=' + page + (extra || '');
}

function generateSessions() {
  const weeks = cfgNum('產生場次週數', 4);
  const exist = {};
  table('課表場次').forEach(function (s) { exist[s['場次ID']] = 1; });
  const map = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '7': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '0': 0 };
  const rows = [];
  const t = today();
  table('課程').filter(function (c) { return c['狀態'] !== '停用'; }).forEach(function (c) {
    const days = {};
    String(c['星期']).split('').forEach(function (ch) { if (map[ch] !== undefined) days[map[ch]] = 1; });
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(t, i);
      const wd = Number(Utilities.formatDate(new Date(d + 'T12:00:00+08:00'), TZ, 'u')) % 7;
      if (!days[wd]) continue;
      const id = c['課程ID'] + '-' + d.replace(/-/g, '');
      if (exist[id]) continue;
      exist[id] = 1;
      rows.push({ '場次ID': id, '課程ID': c['課程ID'], '日期': d, '開始時間': nt(c['開始時間']), '結束時間': nt(c['結束時間']), '狀態': '正常', '備註': '' });
    }
  });
  rows.sort(function (a, b) { return (a['日期'] + a['開始時間']) < (b['日期'] + b['開始時間']) ? -1 : 1; });
  insertMany('課表場次', rows);
  return rows.length;
}

function expireCards() {
  const t = today();
  table('上課卡').filter(function (c) { return c['狀態'] === '啟用' && c['到期日'] && nd(c['到期日']) < t; })
    .forEach(function (c) { update('上課卡', c._row, { '狀態': '過期' }); });
}

/** 每日排程：補場次、將過期卡標記 */
function dailyJob() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { generateSessions(); expireCards(); } finally { lock.releaseLock(); }
}

/* ============================== API ============================== */

const API = {

  /* ---------- 家長端 ---------- */

  'init': function (b, user) {
    return {
      studio: cfg('教室名稱', '舞蹈教室'),
      userId: user.userId,
      name: user.name,
      isAdmin: !!adminOf(user.userId),
      menu: table('選單').filter(function (m) { return m['啟用'] === '是'; })
        .sort(function (a, b2) { return Number(a['順序']) - Number(b2['順序']); })
        .map(function (m) { return { name: m['名稱'], icon: m['圖示'], code: m['功能代碼'] }; }),
      students: kidsOf(user.userId).map(function (s) { return { id: s['學生ID'], name: s['姓名'], remain: totalRemain(s['學生ID']) }; }),
      lowAt: cfgNum('低堂數門檻', 2)
    };
  },

  'bind': function (b, user) {
    const code = String(b.code || '').trim();
    if (!code) throw new Error('請輸入綁定碼');
    const stu = table('學生名冊').filter(function (s) { return s['綁定碼'] === code && s['狀態'] !== '停用'; })[0];
    if (!stu) throw new Error('綁定碼不正確，請向教室確認');
    const dup = table('家長綁定').filter(function (r) { return r['LINE_userId'] === user.userId && r['學生ID'] === stu['學生ID'] && r['狀態'] === '啟用'; })[0];
    if (dup) return { name: stu['姓名'], already: true };
    insert('家長綁定', { 'LINE_userId': user.userId, 'LINE名稱': user.name, '學生ID': stu['學生ID'], '關係': b.relation || '', '綁定時間': now(), '狀態': '啟用' });
    return { name: stu['姓名'] };
  },

  'card': function (b, user) {
    assertOwns(user, b.studentId);
    const names = {};
    table('學生名冊').forEach(function (s) { names[s['學生ID']] = s['姓名']; });
    const cards = table('上課卡').filter(function (c) { return cardHas(c, b.studentId); })
      .map(function (c) {
        const shared = cardIds(c).filter(function (id) { return id !== b.studentId; }).map(function (id) { return names[id] || id; });
        return { id: c['卡ID'], plan: c['方案名稱'], total: c['總堂數'], remain: c['剩餘堂數'], buy: nd(c['購買日']), expire: nd(c['到期日']), status: c['狀態'], shared: shared };
      })
      .reverse();
    const topups = table('儲值紀錄').filter(function (r) { return r['學生ID'] === b.studentId; }).slice(-10).reverse()
      .map(function (r) { return { time: r['時間'], plan: r['方案名稱'], lessons: r['堂數'], amount: r['金額'] }; });
    return { remain: totalRemain(b.studentId), cards: cards, topups: topups };
  },

  'attendance': function (b, user) {
    assertOwns(user, b.studentId);
    const sess = {};
    table('課表場次').forEach(function (s) { sess[s['場次ID']] = s; });
    const list = table('出席紀錄').filter(function (r) { return r['學生ID'] === b.studentId && r['狀態'] !== '取消' && sess[r['場次ID']]; })
      .map(function (r) {
        const i = sessionInfo(sess[r['場次ID']]);
        return { date: i.date, start: i.start, course: i.course, status: r['狀態'], deduct: r['扣堂數'], method: r['報到方式'], time: r['時間'] };
      })
      .sort(function (x, y) { return (x.date + x.start) < (y.date + y.start) ? 1 : -1; })
      .slice(0, 60);
    const count = { '出席': 0, '請假': 0, '缺席': 0 };
    list.forEach(function (r) { if (count[r.status] !== undefined) count[r.status]++; });
    return { list: list, count: count };
  },

  'schedule': function (b, user) {
    assertOwns(user, b.studentId);
    const mine = table('選課').filter(function (r) { return r['學生ID'] === b.studentId && r['狀態'] !== '停用'; }).map(function (r) { return r['課程ID']; });
    const t = today(), end = addDays(t, cfgNum('課表顯示天數', 28));
    const cutoff = cfgNum('請假截止小時', 2) * 3600000;
    const pending = {};
    table('請假紀錄').forEach(function (l) { if (l['學生ID'] === b.studentId && l['狀態'] === '待審核') pending[l['場次ID']] = 1; });
    const upcoming = table('課表場次')
      .filter(function (s) { const d = nd(s['日期']); return d >= t && d <= end && (!mine.length || mine.indexOf(s['課程ID']) >= 0); })
      .map(function (s) {
        const i = sessionInfo(s);
        const rec = activeRecord(i.sessionId, b.studentId);
        i.my = rec ? rec['狀態'] : (pending[i.sessionId] ? '請假待審核' : '');
        i.canLeave = !i.my && i.status === '正常' && (toDate(i.date, i.start).getTime() - Date.now() > cutoff);
        return i;
      })
      .sort(function (x, y) { return (x.date + x.start) < (y.date + y.start) ? -1 : 1; });
    const courses = table('課程').filter(function (c) { return c['狀態'] !== '停用'; }).map(function (c) {
      return { id: c['課程ID'], name: c['課程名稱'], teacher: c['老師'], day: c['星期'], start: nt(c['開始時間']), end: nt(c['結束時間']), room: c['教室'], enrolled: mine.indexOf(c['課程ID']) >= 0 };
    });
    return { upcoming: upcoming, courses: courses, enrolledOnly: mine.length > 0 };
  },

  'leave': function (b, user) {
    assertOwns(user, b.studentId);
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到這堂課');
    if ((sess['狀態'] || '正常') !== '正常') throw new Error('這堂課已' + sess['狀態'] + '，無法請假');
    if (toDate(sess['日期'], sess['開始時間']).getTime() - Date.now() <= cfgNum('請假截止小時', 2) * 3600000) {
      throw new Error('已超過線上請假時間（上課前 ' + cfgNum('請假截止小時', 2) + ' 小時），請直接聯絡教室');
    }
    if (activeRecord(b.sessionId, b.studentId)) throw new Error('這堂課已有紀錄，無法重複請假');
    const dup = table('請假紀錄').filter(function (l) { return l['學生ID'] === b.studentId && l['場次ID'] === b.sessionId && l['狀態'] === '待審核'; })[0];
    if (dup) throw new Error('這堂課已送出請假申請');
    const review = cfgOn('請假需審核');
    insert('請假紀錄', { '請假ID': uid('L'), '學生ID': b.studentId, '場次ID': b.sessionId, '原因': String(b.reason || '').slice(0, 200), '申請時間': now(), '申請人': user.name, '狀態': review ? '待審核' : '已核准', '申請人userId': user.userId });
    if (!review) recordAttendance(sess, b.studentId, '請假', '線上請假', user.name || '家長');
    return { status: review ? '待審核' : '已核准' };
  },

  'leaves': function (b, user) {
    assertOwns(user, b.studentId);
    const sess = {};
    table('課表場次').forEach(function (s) { sess[s['場次ID']] = s; });
    return table('請假紀錄').filter(function (l) { return l['學生ID'] === b.studentId && sess[l['場次ID']]; }).slice(-30).reverse()
      .map(function (l) { const i = sessionInfo(sess[l['場次ID']]); return { date: i.date, start: i.start, course: i.course, reason: l['原因'], status: l['狀態'], applied: l['申請時間'] }; });
  },

  'videos': function (b, user) {
    assertOwns(user, b.studentId);
    const mine = table('選課').filter(function (r) { return r['學生ID'] === b.studentId && r['狀態'] !== '停用'; }).map(function (r) { return r['課程ID']; });
    const cname = {};
    table('課程').forEach(function (c) { cname[c['課程ID']] = c['課程名稱']; });
    return table('影片').filter(function (v) {
      if (v['狀態'] === '停用' || !v['連結']) return false;
      if (v['學生ID']) return v['學生ID'] === b.studentId;
      if (v['課程ID']) return mine.indexOf(v['課程ID']) >= 0;
      return true;
    }).map(function (v) { return { title: v['標題'], course: cname[v['課程ID']] || '', date: nd(v['日期']), url: v['連結'] }; })
      .sort(function (x, y) { return x.date < y.date ? 1 : -1; });
  },

  'checkinInfo': function (b) {
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到這堂課');
    return sessionInfo(sess);
  },

  'checkin': function (b, user) {
    assertOwns(user, b.studentId);
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到這堂課');
    if (b.token !== qrToken(b.sessionId, 0) && b.token !== qrToken(b.sessionId, -1)) throw new Error('QR Code 已過期，請重新掃描教室的報到 QR Code');
    if ((sess['狀態'] || '正常') !== '正常') throw new Error('這堂課已' + sess['狀態']);
    const start = toDate(sess['日期'], sess['開始時間']).getTime(), n = Date.now();
    if (n < start - cfgNum('報到開放分鐘前', 30) * 60000) throw new Error('尚未開放報到（上課前 ' + cfgNum('報到開放分鐘前', 30) + ' 分鐘開放）');
    if (n > start + cfgNum('報到截止分鐘後', 30) * 60000) throw new Error('已超過線上報到時間，請洽櫃檯');
    if (cfgOn('僅限選課學生報到')) {
      const ok = table('選課').some(function (r) { return r['學生ID'] === b.studentId && r['課程ID'] === sess['課程ID'] && r['狀態'] !== '停用'; });
      if (!ok) throw new Error('這位學生未報名此課程，請洽櫃檯');
    }
    const old = activeRecord(b.sessionId, b.studentId);
    if (old && old['狀態'] === '出席') return { dup: true, remain: totalRemain(b.studentId), info: sessionInfo(sess) };
    const course = find('課程', '課程ID', sess['課程ID']) || {};
    if (!cfgOn('無堂數可線上報到') && !pickCard(b.studentId, Number(course['扣堂數']) || 1)) throw new Error('上課卡堂數不足，請先至櫃檯儲值');
    const r = recordAttendance(sess, b.studentId, '出席', 'LINE線上', user.name || '家長');
    r.info = sessionInfo(sess);
    return r;
  },

  /* ---------- 後台 ---------- */

  'a.students': function () {
    const bound = {};
    table('家長綁定').forEach(function (r) { if (r['狀態'] === '啟用') bound[r['學生ID']] = (bound[r['學生ID']] || 0) + 1; });
    // 家人：同一位家長綁定的其他學生，或曾共用同一張上課卡的學生（儲值時可勾選共用）
    const fam = {};
    const link = function (ids) { ids.forEach(function (a) { ids.forEach(function (c) { if (a !== c) { (fam[a] = fam[a] || {})[c] = 1; } }); }); };
    const byParent = {};
    table('家長綁定').forEach(function (r) { if (r['狀態'] === '啟用') (byParent[r['LINE_userId']] = byParent[r['LINE_userId']] || []).push(r['學生ID']); });
    Object.keys(byParent).forEach(function (k) { link(byParent[k]); });
    table('上課卡').forEach(function (c) { link(cardIds(c)); });
    return table('學生名冊').map(function (s) {
      return { id: s['學生ID'], name: s['姓名'], birthday: nd(s['生日']), phone: s['電話'], code: s['綁定碼'], status: s['狀態'], note: s['備註'], remain: totalRemain(s['學生ID']), bound: bound[s['學生ID']] || 0, family: Object.keys(fam[s['學生ID']] || {}) };
    });
  },

  'a.addStudent': function (b) {
    const name = String(b.name || '').trim();
    if (!name) throw new Error('請輸入姓名');
    let max = 0;
    const codes = {};
    table('學生名冊').forEach(function (s) { const n = Number(String(s['學生ID']).replace(/\D/g, '')); if (n > max) max = n; codes[s['綁定碼']] = 1; });
    let code;
    do { code = pad(Math.floor(Math.random() * 1000000), 6); } while (codes[code]);
    const id = 'S' + pad(max + 1, 4);
    insert('學生名冊', { '學生ID': id, '姓名': name, '生日': nd(b.birthday), '電話': b.phone || '', '綁定碼': code, '狀態': '在學', '備註': b.note || '', '建立時間': now() });
    if (b.courseId) insert('選課', { '學生ID': id, '課程ID': b.courseId, '加入日期': today(), '狀態': '啟用' });
    return { id: id, code: code };
  },

  'a.meta': function () {
    return {
      plans: table('方案').filter(function (p) { return p['啟用'] === '是'; }).map(function (p) { return { id: p['方案ID'], name: p['方案名稱'], lessons: p['堂數'], price: p['價格'], days: p['有效天數'] }; }),
      courses: table('課程').filter(function (c) { return c['狀態'] !== '停用'; }).map(function (c) { return { id: c['課程ID'], name: c['課程名稱'] }; }),
      today: today()
    };
  },

  'a.topup': function (b, user) {
    const stu = find('學生名冊', '學生ID', b.studentId);
    if (!stu) throw new Error('找不到學生');
    const plan = find('方案', '方案ID', b.planId);
    if (!plan) throw new Error('找不到方案');
    const lessons = Number(b.lessons) > 0 ? Number(b.lessons) : Number(plan['堂數']);
    const price = b.price !== undefined && b.price !== '' ? Number(b.price) : Number(plan['價格']);
    if (!(lessons > 0)) throw new Error('堂數不正確');
    const t = today();
    const expire = Number(plan['有效天數']) > 0 ? addDays(t, Number(plan['有效天數'])) : '';
    const owners = [b.studentId];
    (b.shareIds || []).forEach(function (id) {
      if (owners.indexOf(id) >= 0) return;
      if (!find('學生名冊', '學生ID', id)) throw new Error('找不到共用學生：' + id);
      owners.push(id);
    });
    const cardId = uid('K');
    insert('上課卡', { '卡ID': cardId, '學生ID': owners.join(','), '方案名稱': plan['方案名稱'], '總堂數': lessons, '剩餘堂數': lessons, '購買日': t, '到期日': expire, '狀態': '啟用' });
    insert('儲值紀錄', { '紀錄ID': uid('T'), '時間': now(), '學生ID': b.studentId, '方案名稱': plan['方案名稱'], '堂數': lessons, '金額': price, '付款方式': b.pay || '現金', '經手人': user.admin['姓名'] || user.name, '卡ID': cardId, '備註': b.note || '' });
    const remain = totalRemain(b.studentId);
    if (cfgOn('儲值推播')) {
      const to = [];
      owners.forEach(function (id) { parentsOf(id).forEach(function (u) { to.push(u); }); });
      const who = owners.map(function (id) { return (find('學生名冊', '學生ID', id) || {})['姓名'] || id; }).join('、');
      pushMsg(to, flexMsg('🎫 儲值成功｜' + who + ' 目前剩餘 ' + remain + ' 堂', [flexBubble({
        color: C_OK, title: '儲值成功', name: who + (owners.length > 1 ? '（共用）' : ''),
        rows: [['方案', plan['方案名稱']], ['堂數', lessons + ' 堂'], ['金額', price + ' 元'], ['到期日', expire]],
        big: { label: '目前剩餘', value: remain, unit: '堂' }, btn: ['查看上課卡', 'card']
      })]));
    }
    return { remain: remain, expire: expire, shared: owners.length - 1 };
  },

  'a.sessions': function (b) {
    const d = nd(b.date) || today();
    const cnt = {};
    table('出席紀錄').forEach(function (r) { if (r['狀態'] === '出席') cnt[r['場次ID']] = (cnt[r['場次ID']] || 0) + 1; });
    return table('課表場次').filter(function (s) { return nd(s['日期']) === d; })
      .map(function (s) { const i = sessionInfo(s); i.present = cnt[i.sessionId] || 0; return i; })
      .sort(function (x, y) { return x.start < y.start ? -1 : 1; });
  },

  'a.roster': function (b) {
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到場次');
    const ids = [];
    table('選課').forEach(function (r) { if (r['課程ID'] === sess['課程ID'] && r['狀態'] !== '停用' && ids.indexOf(r['學生ID']) < 0) ids.push(r['學生ID']); });
    const recs = {};
    table('出席紀錄').forEach(function (r) {
      if (r['場次ID'] === b.sessionId && r['狀態'] !== '取消') { recs[r['學生ID']] = r; if (ids.indexOf(r['學生ID']) < 0) ids.push(r['學生ID']); }
    });
    const list = [];
    ids.forEach(function (id) {
      const s = find('學生名冊', '學生ID', id);
      if (!s || s['狀態'] === '停用') return;
      const r = recs[id];
      list.push({ id: id, name: s['姓名'], status: r ? r['狀態'] : '', method: r ? r['報到方式'] : '', note: r ? r['備註'] : '', remain: totalRemain(id) });
    });
    return { info: sessionInfo(sess), list: list };
  },

  'a.mark': function (b, user) {
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到場次');
    if (!find('學生名冊', '學生ID', b.studentId)) throw new Error('找不到學生');
    if (['出席', '請假', '缺席', '取消'].indexOf(b.status) < 0) throw new Error('狀態不正確');
    return recordAttendance(sess, b.studentId, b.status, '後台', user.admin['姓名'] || user.name);
  },

  'a.close': function (b, user) {
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到場次');
    let n = 0;
    table('選課').filter(function (r) { return r['課程ID'] === sess['課程ID'] && r['狀態'] !== '停用'; })
      .map(function (r) { return r['學生ID']; })
      .forEach(function (id) {
        const s = find('學生名冊', '學生ID', id);
        if (!s || s['狀態'] === '停用' || activeRecord(b.sessionId, id)) return;
        recordAttendance(sess, id, '缺席', '結算', user.admin['姓名'] || user.name);
        n++;
      });
    update('課表場次', sess._row, { '狀態': '已結算' });
    return { absent: n };
  },

  'a.qr': function (b) {
    const sess = find('課表場次', '場次ID', b.sessionId);
    if (!sess) throw new Error('找不到場次');
    const win = cfgNum('QR更新秒數', 60);
    return { url: liffUrl('checkin', '&sid=' + encodeURIComponent(b.sessionId) + '&t=' + qrToken(b.sessionId, 0)), refresh: Math.max(10, Math.floor(win / 2)) };
  },

  'a.leaves': function () {
    const sess = {};
    table('課表場次').forEach(function (s) { sess[s['場次ID']] = s; });
    const t = today();
    return table('請假紀錄').filter(function (l) { return sess[l['場次ID']] && (l['狀態'] === '待審核' || nd(sess[l['場次ID']]['日期']) >= t); })
      .map(function (l) {
        const i = sessionInfo(sess[l['場次ID']]);
        const s = find('學生名冊', '學生ID', l['學生ID']) || {};
        return { id: l['請假ID'], student: s['姓名'] || l['學生ID'], date: i.date, start: i.start, course: i.course, reason: l['原因'], status: l['狀態'], applied: l['申請時間'], by: l['申請人'] };
      })
      .sort(function (x, y) { return (x.date + x.start) < (y.date + y.start) ? -1 : 1; });
  },

  'a.reviewLeave': function (b, user) {
    const l = find('請假紀錄', '請假ID', b.id);
    if (!l) throw new Error('找不到請假單');
    if (l['狀態'] !== '待審核') throw new Error('這筆請假已處理過');
    const sess = find('課表場次', '場次ID', l['場次ID']);
    const approve = !!b.approve;
    update('請假紀錄', l._row, { '狀態': approve ? '已核准' : '已駁回' });
    if (approve && sess) recordAttendance(sess, l['學生ID'], '請假', '線上請假', user.admin['姓名'] || user.name);
    if (l['申請人userId'] && sess) {
      const i = sessionInfo(sess), s = find('學生名冊', '學生ID', l['學生ID']) || {};
      pushMsg([l['申請人userId']], flexMsg((approve ? '✅ 請假已核准' : '❌ 請假未核准') + '｜' + (s['姓名'] || '') + ' ' + i.date + ' ' + i.course, [flexBubble({
        color: approve ? C_OK : C_BAD, title: approve ? '請假已核准' : '請假未核准', name: s['姓名'] || '',
        rows: [['課程', i.course], ['時間', i.date + ' ' + i.start]],
        note: approve ? '' : '如有疑問請聯絡教室', btn: ['查看請假紀錄', 'leave']
      })]));
    }
    return { status: approve ? '已核准' : '已駁回' };
  },

  'a.genSessions': function () { return { added: generateSessions() }; }
};

/* ============================== LINE Bot ============================== */

function lineFetch(path, payload) {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return;
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) console.error('LINE ' + path + ' ' + res.getResponseCode() + ' ' + res.getContentText());
}
function reply(replyToken, messages) { lineFetch('reply', { replyToken: replyToken, messages: messages }); }
function pushMsg(userIds, message) {
  const to = userIds.filter(function (u, i) { return u && userIds.indexOf(u) === i; });
  if (!to.length) return;
  lineFetch('multicast', { to: to, messages: [message] });
}

/* ---------- Flex 訊息卡片 ---------- */
const C_BRAND = '#D6336C', C_OK = '#2B8A3E', C_WARN = '#E67700', C_BAD = '#C92A2A', C_INK = '#3B2430', C_SUB = '#A8798A';

/** 卡片：o = { color, title, name, rows:[[標籤,內容]], big:{label,value,unit,color}, note, btn:[文字, LIFF頁] } */
function flexBubble(o) {
  const body = [];
  if (o.name) body.push({ type: 'text', text: String(o.name), weight: 'bold', size: 'xl', color: C_INK, wrap: true });
  (o.rows || []).forEach(function (r) {
    if (r[1] === '' || r[1] === null || r[1] === undefined) return;
    body.push({ type: 'box', layout: 'baseline', spacing: 'md', contents: [
      { type: 'text', text: String(r[0]), size: 'sm', color: C_SUB, flex: 2 },
      { type: 'text', text: String(r[1]), size: 'sm', color: C_INK, flex: 5, wrap: true }
    ] });
  });
  if (o.big) {
    body.push({ type: 'separator', margin: 'lg' });
    body.push({ type: 'box', layout: 'baseline', margin: 'lg', contents: [
      { type: 'text', text: String(o.big.label), size: 'sm', color: C_SUB, flex: 1 },
      { type: 'text', text: String(o.big.value), size: '3xl', weight: 'bold', color: o.big.color || o.color, flex: 0 },
      { type: 'text', text: String(o.big.unit || ' '), size: 'sm', color: C_SUB, flex: 0, margin: 'sm' }
    ] });
  }
  if (o.note) body.push({ type: 'text', text: String(o.note), size: 'xs', color: C_WARN, wrap: true, margin: 'md' });
  if (!body.length) body.push({ type: 'text', text: String(o.title), size: 'sm', color: C_SUB });
  const bubble = {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: o.color, paddingAll: 'lg', contents: [
      { type: 'text', text: cfg('教室名稱', '舞蹈教室'), size: 'xs', color: '#FFFFFFCC' },
      { type: 'text', text: String(o.title), size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }
    ] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body }
  };
  if (o.btn && prop('LIFF_ID')) {
    bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [
      { type: 'button', style: 'link', height: 'sm', color: o.color, action: { type: 'uri', label: o.btn[0], uri: liffUrl(o.btn[1]) } }
    ] };
  }
  return bubble;
}
function flexMsg(alt, bubbles) {
  return { type: 'flex', altText: String(alt).slice(0, 400), contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles.slice(0, 12) } };
}
function textMsg(t) { return { type: 'text', text: t }; }

function menuFlex(title) {
  const items = table('選單').filter(function (m) { return m['啟用'] === '是'; })
    .sort(function (a, b) { return Number(a['順序']) - Number(b['順序']); });
  return {
    type: 'flex', altText: cfg('教室名稱', '舞蹈教室') + ' 功能選單',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: cfg('教室名稱', '舞蹈教室'), weight: 'bold', size: 'lg' },
          { type: 'text', text: title || '請選擇功能', size: 'sm', color: '#888888', wrap: true }
        ].concat(items.map(function (m) {
          return { type: 'button', style: m['功能代碼'] === 'checkin' ? 'primary' : 'secondary', height: 'sm', action: { type: 'uri', label: (m['圖示'] + ' ' + m['名稱']).slice(0, 20), uri: liffUrl(m['功能代碼']) } };
        }))
      }
    }
  };
}

function handleWebhook(events) {
  events.forEach(function (ev) {
    try {
      if (ev.type === 'follow') { reply(ev.replyToken, [menuFlex('歡迎加入！請先點「綁定學生」，輸入教室提供的綁定碼。')]); return; }
      if (ev.type !== 'message' || ev.message.type !== 'text') return;
      const t = ev.message.text.trim();
      const kids = kidsOf(ev.source.userId);
      if (!kids.length) { reply(ev.replyToken, [menuFlex('您尚未綁定學生，請點「綁定學生」並輸入教室提供的綁定碼。')]); return; }
      if (/堂數|上課卡|剩|餘額/.test(t)) {
        reply(ev.replyToken, [flexMsg(kids.map(function (s) { return s['姓名'] + ' 剩餘 ' + totalRemain(s['學生ID']) + ' 堂'; }).join('、'), kids.map(function (s) {
          const remain = totalRemain(s['學生ID']);
          return flexBubble({
            color: C_BRAND, title: '上課卡', name: s['姓名'],
            rows: validCards(s['學生ID']).map(function (c) { return [c['方案名稱'], c['剩餘堂數'] + ' / ' + c['總堂數'] + ' 堂' + (c['到期日'] ? '｜到期 ' + nd(c['到期日']) : '')]; }),
            big: { label: '剩餘堂數', value: remain, unit: '堂', color: remain <= cfgNum('低堂數門檻', 2) ? C_WARN : C_BRAND },
            note: remain <= 0 ? '目前沒有可用的上課卡' : '', btn: ['查看上課卡', 'card']
          });
        }))]);
        return;
      }
      if (/出席|出缺|紀錄/.test(t)) {
        const sess = {};
        table('課表場次').forEach(function (s) { sess[s['場次ID']] = s; });
        reply(ev.replyToken, [flexMsg('最近出席紀錄', kids.map(function (s) {
          const rs = table('出席紀錄').filter(function (r) { return r['學生ID'] === s['學生ID'] && r['狀態'] !== '取消' && sess[r['場次ID']]; })
            .map(function (r) { const i = sessionInfo(sess[r['場次ID']]); return { k: i.date + i.start, row: [i.date.slice(5), i.course + '｜' + r['狀態']] }; })
            .sort(function (x, y) { return x.k < y.k ? 1 : -1; }).slice(0, 5);
          return flexBubble({
            color: C_BRAND, title: '最近出席紀錄', name: s['姓名'],
            rows: rs.map(function (r) { return r.row; }), note: rs.length ? '' : '尚無紀錄', btn: ['查看完整紀錄', 'attendance']
          });
        }))]);
        return;
      }
      reply(ev.replyToken, [menuFlex()]);
    } catch (err) { console.error(err); }
  });
}

/* ============================== 圖文選單 ============================== */

/** 建立並套用 LINE 圖文選單（圖片取自 SITE_URL/richmenu.jpg，六格對應 LIFF 各頁） */
function setupRichMenu() {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN'), site = prop('SITE_URL');
  if (!token || !prop('LIFF_ID') || !site) throw new Error('請先在指令碼屬性填好 LINE_CHANNEL_ACCESS_TOKEN、LIFF_ID、SITE_URL');
  const W = 2500, H = 1686, cw = 833, ch = 843;
  const cells = [['checkin', '線上報到'], ['card', '上課卡'], ['attendance', '出席紀錄'], ['schedule', '課表'], ['leave', '請假'], ['video', '影片']];
  const areas = cells.map(function (c, i) {
    const col = i % 3, row = Math.floor(i / 3);
    return { bounds: { x: col * cw, y: row * ch, width: col === 2 ? W - 2 * cw : cw, height: ch }, action: { type: 'uri', label: c[1], uri: liffUrl(c[0]) } };
  });
  const auth = { Authorization: 'Bearer ' + token };
  const img = UrlFetchApp.fetch(site.replace(/\/+$/, '') + '/richmenu.jpg', { muteHttpExceptions: true });
  if (img.getResponseCode() !== 200) throw new Error('讀不到圖片：' + site + '/richmenu.jpg（' + img.getResponseCode() + '）');
  const r1 = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post', contentType: 'application/json', headers: auth, muteHttpExceptions: true,
    payload: JSON.stringify({ size: { width: W, height: H }, selected: true, name: cfg('教室名稱', '舞蹈教室'), chatBarText: '功能選單', areas: areas })
  });
  if (r1.getResponseCode() !== 200) throw new Error('建立圖文選單失敗：' + r1.getContentText());
  const id = JSON.parse(r1.getContentText()).richMenuId;
  const r2 = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', {
    method: 'post', contentType: 'image/jpeg', headers: auth, payload: img.getBlob().getBytes(), muteHttpExceptions: true
  });
  if (r2.getResponseCode() !== 200) throw new Error('上傳圖片失敗：' + r2.getContentText());
  const r3 = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, { method: 'post', headers: auth, muteHttpExceptions: true });
  if (r3.getResponseCode() !== 200) throw new Error('設為預設選單失敗：' + r3.getContentText());
  const p = PropertiesService.getScriptProperties(), old = p.getProperty('RICHMENU_ID');
  if (old && old !== id) UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + old, { method: 'delete', headers: auth, muteHttpExceptions: true });
  p.setProperty('RICHMENU_ID', id);
  Logger.log('圖文選單已套用：' + id);
  return id;
}
function menuRichMenu() {
  try { setupRichMenu(); SpreadsheetApp.getUi().alert('圖文選單已套用，請到 LINE 聊天室查看。'); }
  catch (e) { SpreadsheetApp.getUi().alert(String(e.message || e)); }
}

/* ============================== 初始化 ============================== */

function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    let s = book.getSheetByName(name);
    const isNew = !s;
    if (isNew) s = book.insertSheet(name);
    const h = SHEETS[name];
    if (s.getMaxColumns() < h.length) s.insertColumnsAfter(s.getMaxColumns(), h.length - s.getMaxColumns());
    s.getRange(1, 1, s.getMaxRows(), s.getMaxColumns()).setNumberFormat('@');
    if (isNew || s.getLastRow() === 0) {
      s.getRange(1, 1, 1, h.length).setValues([h]);
      if (SAMPLE[name]) s.getRange(2, 1, SAMPLE[name].length, h.length).setValues(SAMPLE[name]);
    }
    s.getRange(1, 1, 1, h.length).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    s.setFrozenRows(1);
  });
  const def = book.getSheetByName('工作表1') || book.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(def);

  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('WEBHOOK_KEY')) p.setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));
  if (!p.getProperty('QR_SECRET')) p.setProperty('QR_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('初始化完成。Webhook 網址請用：<部署後的網頁應用程式網址>?key=' + p.getProperty('WEBHOOK_KEY'));
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(3).inTimezone(TZ).create();
}

function menuGenerate() {
  const n = generateSessions();
  SpreadsheetApp.getUi().alert('已新增 ' + n + ' 個場次');
}
function menuWebhook() {
  SpreadsheetApp.getUi().alert('Webhook 網址：\n<網頁應用程式網址>?key=' + prop('WEBHOOK_KEY'));
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('舞蹈教室')
    .addItem('① 初始化分頁', 'setup')
    .addItem('② 產生課表場次', 'menuGenerate')
    .addItem('③ 安裝每日自動排程', 'installTrigger')
    .addItem('④ 套用 LINE 圖文選單', 'menuRichMenu')
    .addItem('顯示 Webhook 金鑰', 'menuWebhook')
    .addToUi();
}
