// 舞蹈教室報到系統 — 後端核心（Node + SQLite）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ============================== 時間工具（一律台北時間） ============================== */
const TZ_MS = 8 * 3600e3;
const iso = d => new Date(d.getTime() + TZ_MS).toISOString();
export const now = () => iso(new Date()).slice(0, 19).replace('T', ' ');
export const today = () => iso(new Date()).slice(0, 10);
export const addDays = (date, n) => iso(new Date(new Date(date + 'T12:00:00+08:00').getTime() + n * 86400e3)).slice(0, 10);
const weekday = date => new Date(date + 'T12:00:00+08:00').getUTCDay(); // 0=日
const toDate = (date, time) => new Date(date + 'T' + (time || '00:00') + ':00+08:00');
const nd = s => { const m = String(s || '').trim().match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
const nt = s => { const m = String(s || '').trim().match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
const uid = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/* ============================== 資料表 ============================== */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, note TEXT, kind TEXT, sort INTEGER);
CREATE TABLE IF NOT EXISTS admins(user_id TEXT PRIMARY KEY, name TEXT, role TEXT DEFAULT 'teacher', active INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY, name TEXT NOT NULL, birthday TEXT DEFAULT '', phone TEXT DEFAULT '', bind_code TEXT UNIQUE, status TEXT DEFAULT '在學', note TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS bindings(user_id TEXT, line_name TEXT, student_id TEXT, relation TEXT, created_at TEXT, PRIMARY KEY(user_id, student_id));
CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, name TEXT NOT NULL, teacher TEXT DEFAULT '', weekdays TEXT DEFAULT '', start TEXT, end TEXT, room TEXT DEFAULT '', deduct INTEGER DEFAULT 1, capacity INTEGER DEFAULT 0, color TEXT DEFAULT '#D6336C', status TEXT DEFAULT '啟用');
CREATE TABLE IF NOT EXISTS enrollments(student_id TEXT, course_id TEXT, joined TEXT, PRIMARY KEY(student_id, course_id));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, course_id TEXT, date TEXT, start TEXT, end TEXT, teacher TEXT DEFAULT '', room TEXT DEFAULT '', status TEXT DEFAULT '正常', note TEXT DEFAULT '', manual INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_sessions_date ON sessions(date);
CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, name TEXT, lessons INTEGER, price INTEGER, valid_days INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, plan_name TEXT, total INTEGER, remain INTEGER, bought TEXT, expire TEXT DEFAULT '', status TEXT DEFAULT '啟用');
CREATE TABLE IF NOT EXISTS card_students(card_id TEXT, student_id TEXT, PRIMARY KEY(card_id, student_id));
CREATE INDEX IF NOT EXISTS ix_cs_student ON card_students(student_id);
CREATE TABLE IF NOT EXISTS topups(id TEXT PRIMARY KEY, time TEXT, student_id TEXT, plan_name TEXT, lessons INTEGER, amount INTEGER, pay TEXT, operator TEXT, card_id TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS attendance(id TEXT PRIMARY KEY, session_id TEXT, student_id TEXT, status TEXT, method TEXT, time TEXT, deduct INTEGER DEFAULT 0, card_id TEXT DEFAULT '', operator TEXT, note TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_att_session ON attendance(session_id);
CREATE INDEX IF NOT EXISTS ix_att_student ON attendance(student_id);
CREATE TABLE IF NOT EXISTS leaves(id TEXT PRIMARY KEY, student_id TEXT, session_id TEXT, reason TEXT, applied_at TEXT, by_name TEXT, by_user TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, title TEXT, course_id TEXT DEFAULT '', student_id TEXT DEFAULT '', date TEXT, url TEXT, status TEXT DEFAULT '啟用');
`;

// [預設值, 說明, 類型]  類型：text / num / bool
const SETTINGS = {
  '教室名稱': ['章魚老師舞蹈教室', '顯示在 LINE 與網頁上的名稱', 'text'],
  '報到開放分鐘前': ['30', '上課前幾分鐘開放家長線上報到', 'num'],
  '報到截止分鐘後': ['30', '上課後幾分鐘內仍可線上報到', 'num'],
  'QR更新秒數': ['60', '教室報到 QR Code 多久換一次（防止轉傳）', 'num'],
  '無堂數可線上報到': ['否', '沒有可用上課卡也能線上報到（不扣堂）', 'bool'],
  '僅限選課學生報到': ['否', '只有已排入該課程的學生可線上報到', 'bool'],
  '請假截止小時': ['2', '上課前幾小時內不可線上請假', 'num'],
  '請假扣堂': ['否', '請假也扣堂', 'bool'],
  '缺席扣堂': ['是', '未請假缺席（場次結算時）扣堂', 'bool'],
  '產生場次週數': ['8', '依課程自動排出未來幾週的課表', 'num'],
  '課表顯示天數': ['28', '家長端課表顯示未來幾天', 'num'],
  '低堂數門檻': ['2', '剩餘堂數小於等於此數字時提醒', 'num'],
  '儲值推播': ['是', '儲值後通知家長', 'bool'],
  '報到推播': ['是', '報到後通知家長', 'bool'],
  '低堂數推播': ['是', '堂數不足時通知家長', 'bool'],
  '請假推播': ['是', '家長線上請假後，回覆「已收到請假」', 'bool'],
  '請假通知管理員': ['是', '家長線上請假後通知管理員與老師', 'bool'],
  '諮詢通知管理員': ['是', '家長從課表按「諮詢」留言時，用 LINE 通知管理員', 'bool'],
  '開放線上報名': ['是', '家長可在 LINE 課表對還沒參加的課程按「報名」', 'bool'],
  '報名需審核': ['是', '是＝管理員同意後才加入名單；否＝家長按下就直接加入', 'bool'],
  '開放教室租借': ['是', '外部使用者可在 LINE 預約開放的教室時段', 'bool'],
  '租借需確認': ['是', '是＝管理員確認後預約才成立；否＝送出就直接成立', 'bool'],
  '租借提前小時': ['12', '最晚要在使用前幾小時預約', 'num'],
  '租借可預約天數': ['30', '可以預約未來幾天內的時段', 'num'],
  '租借須知': ['請準時進場，結束時間前請復原場地、帶走垃圾。', '顯示在租借頁面與預約確認通知', 'text']
};
const PLANS = [['P01', '單堂', 1, 500, 30], ['P02', '10堂卡', 10, 4500, 90], ['P03', '20堂卡', 20, 8000, 180]];
const COLORS = ['#D6336C', '#1971C2', '#2B8A3E', '#E67700', '#7048E8', '#0C8599', '#C2255C', '#5C940D'];

const OWNER_ONLY = new Set(['a.studentSave', 'a.enroll', 'a.unbind', 'a.topup', 'a.cardSave', 'a.courseSave', 'a.sessionSave', 'a.sessionDelete', 'a.genSessions',
  'a.videoSave', 'a.videoDelete', 'a.planSave', 'a.settingSave', 'a.adminSave', 'a.richmenu', 'a.export', 'a.student', 'a.videos', 'a.plans', 'a.settings', 'a.admins', 'a.cards', 'a.ledger', 'a.topupSave', 'a.videoInfo', 'a.dayOff', 'a.familySave', 'a.courseDelete', 'a.courseStudents', 'a.signupSave', 'a.rent', 'a.roomSave', 'a.roomDelete', 'a.rentBlockSave', 'a.rentBlockDelete', 'a.rentTagSave', 'a.rentTagDelete', 'a.bookingSave', 'a.rentSlots', 'a.roomCal', 'a.roomHours']);
const ASYNC = new Set(['a.richmenu', 'a.videoInfo']);
/** 從各種 YouTube 網址取出影片 ID（watch、youtu.be、shorts、live、embed） */
export const ytId = url => { const m = String(url || '').match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/|v\/))([\w-]{11})(?![\w-])/); return m ? m[1] : ''; };

export function createApp(opts = {}) {
  const env = opts.env || process.env;
  const dataDir = opts.dataDir || env.DATA_DIR || './data';
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'octopus.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA);
  { // 舊資料庫補欄位：課程的開課期間
    const cols = db.prepare('PRAGMA table_info(courses)').all().map(c => c.name);
    if (!cols.includes('date_from')) db.exec("ALTER TABLE courses ADD COLUMN date_from TEXT DEFAULT ''");
    if (!cols.includes('date_to')) db.exec("ALTER TABLE courses ADD COLUMN date_to TEXT DEFAULT ''");
    if (!db.prepare('PRAGMA table_info(students)').all().some(c => c.name === 'family')) db.exec("ALTER TABLE students ADD COLUMN family TEXT DEFAULT ''");
    if (!cols.includes('intro')) db.exec("ALTER TABLE courses ADD COLUMN intro TEXT DEFAULT ''");
    db.exec("CREATE TABLE IF NOT EXISTS signups(id TEXT PRIMARY KEY, student_id TEXT, course_id TEXT, status TEXT, time TEXT, by_user TEXT, by_name TEXT, done_at TEXT DEFAULT '', done_by TEXT DEFAULT '')");
    db.exec(`CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER DEFAULT 0, price INTEGER DEFAULT 0, unit INTEGER DEFAULT 60, intro TEXT DEFAULT '', open TEXT DEFAULT '{}', status TEXT DEFAULT '開放', sort INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY, room_id TEXT, date TEXT, start TEXT, end TEXT, user_id TEXT DEFAULT '', line_name TEXT DEFAULT '', name TEXT DEFAULT '', phone TEXT DEFAULT '', purpose TEXT DEFAULT '', people INTEGER DEFAULT 0, status TEXT, amount INTEGER DEFAULT 0, tags TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT, by_admin TEXT DEFAULT '', decided_at TEXT DEFAULT '', decided_by TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS rent_blocks(id TEXT PRIMARY KEY, room_id TEXT DEFAULT '', date TEXT, start TEXT DEFAULT '', end TEXT DEFAULT '', note TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS room_dates(room_id TEXT, date TEXT, ranges TEXT DEFAULT '[]', PRIMARY KEY(room_id, date));
      CREATE TABLE IF NOT EXISTS rent_tags(id TEXT PRIMARY KEY, name TEXT, color TEXT, sort INTEGER DEFAULT 0);`);
    db.exec('CREATE TABLE IF NOT EXISTS session_skips(id TEXT PRIMARY KEY)'); // 已刪除的固定場次，不再自動排回來
    db.exec("CREATE TABLE IF NOT EXISTS makeups(id TEXT PRIMARY KEY, student_id TEXT, session_id TEXT, from_session_id TEXT DEFAULT '', created_at TEXT, by_name TEXT)");
  }
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  // 初始資料
  Object.entries(SETTINGS).forEach(([k, v], i) => run('INSERT OR IGNORE INTO settings(key,value,note,kind,sort) VALUES(?,?,?,?,?)', k, v[0], v[1], v[2], i));
  if (!get('SELECT 1 x FROM plans')) PLANS.forEach((p, i) => run('INSERT INTO plans(id,name,lessons,price,valid_days,active,sort) VALUES(?,?,?,?,?,1,?)', ...p, i));
  const meta = k => { let r = get('SELECT value FROM meta WHERE key=?', k); if (!r) { r = { value: crypto.randomBytes(32).toString('hex') }; run('INSERT INTO meta VALUES(?,?)', k, r.value); } return r.value; };
  const SECRET = meta('session_secret'), QR_SECRET = meta('qr_secret');

  const cfg = (k, d = '') => { const r = get('SELECT value FROM settings WHERE key=?', k); return r && r.value !== '' ? r.value : d; };
  const cfgOn = k => cfg(k, '否') === '是';
  const cfgNum = (k, d) => { const n = Number(cfg(k, d)); return isNaN(n) ? d : n; };
  const liffUrl = (page, extra = '') => 'https://liff.line.me/' + (env.LIFF_ID || '') + '?page=' + page + extra;

  /* ---------- LINE ---------- */
  const lineFetch = opts.lineFetch || (async (url, init) => fetch(url, init));
  const authHdr = () => ({ Authorization: 'Bearer ' + (env.LINE_CHANNEL_ACCESS_TOKEN || '') });
  async function lineMsg(pathname, payload) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
    try {
      const r = await lineFetch('https://api.line.me/v2/bot/message/' + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHdr() }, body: JSON.stringify(payload) });
      if (!r.ok) console.error('LINE', pathname, r.status, await r.text());
    } catch (e) { console.error('LINE', pathname, e.message); }
  }
  let outbox = [];
  const pushMsg = (userIds, message) => { const to = [...new Set(userIds.filter(Boolean))]; for (let i = 0; i < to.length; i += 500) outbox.push({ to: to.slice(i, i + 500), messages: [message] }); };
  const flush = () => { const o = outbox; outbox = []; return Promise.all(o.map(m => lineMsg('multicast', m))); };

  const verifyIdToken = opts.verifyIdToken || (async idToken => {
    const r = await lineFetch('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_LOGIN_CHANNEL_ID || '' }) });
    if (!r.ok) throw new Error('AUTH');
    const d = await r.json();
    return { userId: d.sub, name: d.name || '' };
  });
  const hmac = (s, key = SECRET) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const sign = o => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); return p + '.' + hmac(p); };
  const unsign = t => {
    const [p, s] = String(t || '').split('.');
    if (!p || !s || s.length !== hmac(p).length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(hmac(p)))) return null;
    try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? { userId: o.u, name: o.n } : null; } catch { return null; }
  };

  /* ---------- Flex 卡片 ---------- */
  const C = { BRAND: '#D6336C', OK: '#2B8A3E', WARN: '#E67700', INFO: '#1971C2', INK: '#3B2430', SUB: '#A8798A' };
  function flexBubble(o) {
    const body = [];
    if (o.name) body.push({ type: 'text', text: String(o.name), weight: 'bold', size: 'xl', color: C.INK, wrap: true });
    (o.rows || []).forEach(r => {
      if (r[1] === '' || r[1] == null) return;
      body.push({ type: 'box', layout: 'baseline', spacing: 'md', contents: [
        { type: 'text', text: String(r[0]), size: 'sm', color: C.SUB, flex: 2 },
        { type: 'text', text: String(r[1]), size: 'sm', color: C.INK, flex: 5, wrap: true }] });
    });
    if (o.big) {
      body.push({ type: 'separator', margin: 'lg' });
      body.push({ type: 'box', layout: 'baseline', margin: 'lg', contents: [
        { type: 'text', text: String(o.big.label), size: 'sm', color: C.SUB, flex: 1 },
        { type: 'text', text: String(o.big.value), size: '3xl', weight: 'bold', color: o.big.color || o.color, flex: 0 },
        { type: 'text', text: String(o.big.unit || ' '), size: 'sm', color: C.SUB, flex: 0, margin: 'sm' }] });
    }
    if (o.note) body.push({ type: 'text', text: String(o.note), size: 'xs', color: o.noteColor || C.WARN, wrap: true, margin: 'md' });
    if (!body.length) body.push({ type: 'text', text: String(o.title), size: 'sm', color: C.SUB });
    const bubble = { type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'vertical', backgroundColor: o.color, paddingAll: 'lg', contents: [
        { type: 'text', text: cfg('教室名稱', '舞蹈教室'), size: 'xs', color: '#FFFFFFCC' },
        { type: 'text', text: String(o.title), size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body } };
    if (o.btn && env.LIFF_ID) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [
      { type: 'button', style: 'link', height: 'sm', color: o.color, action: { type: 'uri', label: o.btn[0], uri: liffUrl(o.btn[1]) } }] };
    return bubble;
  }
  const flexMsg = (alt, bubbles) => ({ type: 'flex', altText: String(alt).slice(0, 400), contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles.slice(0, 12) } });

  /** 影片卡片：YouTube 影片附縮圖，點圖或按鈕直接觀看 */
  function videoBubble(v) {
    const yt = ytId(v.url), act = { type: 'uri', label: '觀看影片', uri: v.url };
    const bubble = { type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', action: act, contents: [
        { type: 'text', text: cfg('教室名稱', '舞蹈教室') + '｜影片', size: 'xs', color: C.SUB },
        { type: 'text', text: String(v.title || '影片'), weight: 'bold', size: 'md', color: C.INK, wrap: true, maxLines: 3 },
        { type: 'text', text: [v.date, v.who || v.course || '全部家長'].filter(Boolean).join('｜'), size: 'xs', color: C.SUB, wrap: true }] },
      footer: { type: 'box', layout: 'vertical', paddingAll: 'sm', contents: [{ type: 'button', style: 'primary', height: 'sm', color: C.BRAND, action: act }] } };
    if (yt) bubble.hero = { type: 'image', url: 'https://i.ytimg.com/vi/' + yt + '/hqdefault.jpg', size: 'full', aspectRatio: '16:9', aspectMode: 'cover', action: act };
    return bubble;
  }
  const videosFor = sid => all("SELECT v.id,v.title,v.date,v.url,v.course_id courseId,COALESCE(c.name,'') course,v.student_id personal FROM videos v LEFT JOIN courses c ON c.id=v.course_id WHERE v.status='啟用' AND v.url<>'' AND (v.student_id=? OR (v.student_id='' AND (v.course_id='' OR v.course_id IN (SELECT course_id FROM enrollments WHERE student_id=?)))) ORDER BY v.date DESC, v.id DESC", sid, sid).map(v => ({ ...v, yt: ytId(v.url) }));

  /* ---------- 共用查詢 ---------- */
  const adminOf = userId => get('SELECT * FROM admins WHERE user_id=? AND active=1', userId) || null;
  const kidsOf = userId => all("SELECT s.* FROM students s JOIN bindings b ON b.student_id=s.id WHERE b.user_id=? AND s.status<>'停用' ORDER BY s.id", userId);
  const assertOwns = (user, sid) => { if (!get("SELECT 1 x FROM bindings b JOIN students s ON s.id=b.student_id WHERE b.user_id=? AND b.student_id=? AND s.status<>'停用'", user.userId, sid)) throw new Error('您尚未綁定這位學生'); };
  const parentsOf = sid => all('SELECT user_id FROM bindings WHERE student_id=?', sid).map(r => r.user_id);
  const student = id => get('SELECT * FROM students WHERE id=?', id);
  const validCards = sid => all("SELECT c.* FROM cards c JOIN card_students cs ON cs.card_id=c.id WHERE cs.student_id=? AND c.status='啟用' AND c.remain>0 AND (c.expire='' OR c.expire>=?) ORDER BY CASE WHEN c.expire='' THEN '9999' ELSE c.expire END, c.bought", sid, today());
  const totalRemain = sid => validCards(sid).reduce((n, c) => n + c.remain, 0);
  const pickCard = (sid, need) => validCards(sid).find(c => c.remain >= need) || null;
  const shouldDeduct = st => st === '出席' ? true : st === '請假' ? cfgOn('請假扣堂') : st === '缺席' ? cfgOn('缺席扣堂') : false;
  const sessRow = id => get('SELECT * FROM sessions WHERE id=?', id);
  function sessionInfo(s) {
    const c = get('SELECT * FROM courses WHERE id=?', s.course_id) || {};
    return { sessionId: s.id, courseId: s.course_id, course: c.name || s.course_id, color: c.color || C.BRAND, teacher: s.teacher || c.teacher || '', room: s.room || c.room || '',
      date: s.date, start: s.start, end: s.end, status: s.status || '正常', note: s.note || '', manual: !!s.manual, deduct: c.deduct || 1, capacity: c.capacity || 0, term: !!c.date_to, rawTeacher: s.teacher || '', rawRoom: s.room || '' };
  }
  const activeRecord = (sessionId, sid) => get("SELECT * FROM attendance WHERE session_id=? AND student_id=? AND status<>'取消' ORDER BY time DESC", sessionId, sid) || null;
  const qrToken = (sessionId, offset = 0) => crypto.createHmac('sha256', QR_SECRET).update(sessionId + '|' + (Math.floor(Date.now() / 1000 / cfgNum('QR更新秒數', 60)) + offset)).digest('hex').slice(0, 10);

  /* ---------- 出席與扣堂 ---------- */
  function recordAttendance(sess, sid, status, method, operator, notify = true) {
    const info = sessionInfo(sess);
    const old = activeRecord(sess.id, sid);
    if (old && old.status === status) return { dup: true, status, deduct: 0, remain: totalRemain(sid) };
    if (old) {
      if (old.deduct > 0 && old.card_id) run("UPDATE cards SET remain=remain+?, status=CASE WHEN status='用完' THEN '啟用' ELSE status END WHERE id=?", old.deduct, old.card_id);
      run("UPDATE attendance SET status='取消', note=? WHERE id=?", (old.note ? old.note + '；' : '') + '原為' + old.status + '，' + now() + ' 由 ' + operator + ' 變更', old.id);
    }
    if (status === '取消') return { status, deduct: 0, remain: totalRemain(sid) };
    let deduct = 0, cardId = '', note = '';
    const need = shouldDeduct(status) ? info.deduct : 0;
    if (need > 0) {
      const card = pickCard(sid, need);
      if (card) { const left = card.remain - need; run('UPDATE cards SET remain=?, status=? WHERE id=?', left, left <= 0 ? '用完' : '啟用', card.id); deduct = need; cardId = card.id; }
      else note = '無可用上課卡，未扣堂';
    }
    run('INSERT INTO attendance(id,session_id,student_id,status,method,time,deduct,card_id,operator,note) VALUES(?,?,?,?,?,?,?,?,?,?)', uid('A'), sess.id, sid, status, method, now(), deduct, cardId, operator, note);
    const remain = totalRemain(sid);
    if (notify) notifyAttendance(info, sid, status, deduct, remain);
    return { status, deduct, remain, note };
  }
  function notifyAttendance(info, sid, status, deduct, remain) {
    const name = (student(sid) || {}).name || sid;
    const low = deduct > 0 && cfgOn('低堂數推播') && remain <= cfgNum('低堂數門檻', 2);
    let msg = null;
    if (status === '出席' && cfgOn('報到推播')) msg = flexMsg('✅ ' + name + ' 已報到｜剩餘 ' + remain + ' 堂', [flexBubble({
      color: C.BRAND, title: '報到成功', name, rows: [['課程', info.course], ['時間', info.date + ' ' + info.start], ['教室', info.room]],
      big: { label: '剩餘堂數', value: remain, unit: '堂', color: low ? C.WARN : C.BRAND }, note: low ? '堂數即將用完，請記得儲值' : '', btn: ['查看出席紀錄', 'attendance'] })]);
    else if (low) msg = flexMsg('🔔 ' + name + ' 剩餘 ' + remain + ' 堂，請記得儲值', [flexBubble({
      color: C.WARN, title: '堂數即將用完', name, rows: [['提醒', '請記得到櫃檯儲值']], big: { label: '剩餘堂數', value: remain, unit: '堂' }, btn: ['查看上課卡', 'card'] })]);
    if (msg) pushMsg(parentsOf(sid), msg);
  }
  const whenOf = s => s.date.slice(5).replace('-', '/') + '（' + '日一二三四五六'[weekday(s.date)] + '）' + s.start + '–' + s.end;
  /** 這堂課要通知的家長：排入該課程的學生＋安排到這堂補課的學生 */
  const sessionParents = s => [...new Set([...all("SELECT b.user_id FROM bindings b JOIN enrollments e ON e.student_id=b.student_id JOIN students st ON st.id=b.student_id WHERE e.course_id=? AND st.status<>'停用'", s.course_id),
    ...all('SELECT b.user_id FROM bindings b JOIN makeups m ON m.student_id=b.student_id WHERE m.session_id=?', s.id)].map(r => r.user_id))];
  /** 停課、調課、加課、復課、老師備註 → 通知家長。回傳通知人數 */
  function notifySession(kind, before, after) {
    const i = sessionInfo(after), to = sessionParents(after), o = before ? sessionInfo(before) : null;
    if (!to.length) return 0;
    const T = { 停課: ['停課通知', C.WARN, '⚠️'], 調課: ['調課通知', C.INFO, '🔄'], 加課: ['加課通知', C.OK, '➕'], 復課: ['恢復上課', C.OK, '✅'], 備註: ['老師的話', C.BRAND, '💬'] }[kind];
    const rows = kind === '調課' && o && (o.date !== i.date || o.start !== i.start || o.end !== i.end) ? [['原時間', whenOf(o)], ['新時間', whenOf(i)]] : [['時間', whenOf(i)]];
    if (kind !== '停課') { rows.push(['老師', i.teacher + (o && o.teacher !== i.teacher ? '（代課）' : '')]); rows.push(['教室', i.room]); }
    if (after.postponed) rows.push(['順延', '整期往後順延，最後一堂改到 ' + after.postponed.slice(5).replace('-', '/')]);
    pushMsg(to, flexMsg(T[2] + ' ' + T[0] + '｜' + i.course + ' ' + whenOf(kind === '調課' && o ? o : i), [flexBubble({ color: T[1], title: T[0], name: i.course, rows, note: i.note ? (kind === '停課' ? '原因：' : '老師備註：') + i.note : '', noteColor: C.INK, btn: ['查看課表', 'schedule'] })]));
    return to.length;
  }
  /** 同一時段、同教室或同老師的其他課 */
  function conflictsOf(s) {
    const me = sessionInfo(s);
    return all("SELECT * FROM sessions WHERE date=? AND id<>? AND status<>'停課' AND start<? AND end>?", s.date, s.id, s.end, s.start).map(o => {
      const i = sessionInfo(o), why = [me.room && me.room === i.room ? '同教室 ' + i.room : '', me.teacher && me.teacher === i.teacher ? '同老師 ' + i.teacher : ''].filter(Boolean).join('、');
      return why && o.course_id !== s.course_id ? { text: `${s.date.slice(5).replace('-', '/')}（${'日一二三四五六'[weekday(s.date)]}）${i.start}–${i.end}「${i.course}」${why}`, key: i.courseId + weekday(s.date) + why } : null;
    }).filter(Boolean).concat(rentHits(s, me));
  }
  /** 這堂課的教室在同一時間已被租借（待確認或已確認） */
  function rentHits(s, me) {
    const room = me.room && get('SELECT * FROM rooms WHERE name=?', me.room);
    if (!room) return [];
    return all("SELECT * FROM bookings WHERE room_id=? AND date=? AND status IN ('待確認','已確認') AND start<? AND end>?", room.id, s.date, s.end, s.start)
      .map(b => ({ text: `${s.date.slice(5).replace('-', '/')}（${'日一二三四五六'[weekday(s.date)]}）${b.start}–${b.end} ${room.name} 已被租借：${b.name}（${b.status}）`, key: 'rent' + b.id }));
  }
  const conflictError = list => { const seen = new Set(), out = []; list.forEach(c => { if (!seen.has(c.key)) { seen.add(c.key); out.push(c.text); } }); return new Error('CONFLICT:' + out.slice(0, 5).join('\n') + (out.length > 5 ? '\n…還有 ' + (out.length - 5) + ' 個時段' : '')); };
  /** 停課順延：把課程的結束日期延到下一個上課日，整期堂數不變 */
  function extendTerm(courseId) {
    const c = get('SELECT * FROM courses WHERE id=?', courseId), days = c ? courseDays(c) : [];
    if (!c || !c.date_to || !days.length) return '';
    const last = (get('SELECT MAX(date) d FROM sessions WHERE course_id=? AND manual=0', courseId) || {}).d || '';
    let d = last > c.date_to ? last : c.date_to;
    for (let i = 0; i < 14; i++) { d = addDays(d, 1); if (days.includes(weekday(d))) break; }
    run('UPDATE courses SET date_to=? WHERE id=?', d, courseId);
    generateSessions();
    return d;
  }

  /** 官方帳號的 ID（@xxxx），用來讓家長從網頁一鍵回到聊天室諮詢 */
  async function loadBotInfo() {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
    try { const r = await lineFetch('https://api.line.me/v2/bot/info', { headers: authHdr() }); const d = r.ok ? await r.json() : {};
      if (d.basicId) run("INSERT INTO meta VALUES('bot_basic_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", d.basicId); } catch (e) { console.error('bot info', e.message); }
  }

  function notifyLeave(info, sid, reason, byName) {
    const name = (student(sid) || {}).name || sid;
    const rows = [['課程', info.course], ['時間', info.date + ' ' + info.start], ['原因', reason], ['申請人', byName]];
    const parents = parentsOf(sid);
    if (cfgOn('請假推播')) pushMsg(parents, flexMsg('📝 已收到 ' + name + ' 的請假｜' + info.date + ' ' + info.course, [flexBubble({
      color: C.INFO, title: '已收到請假', name, rows, note: cfgOn('請假扣堂') ? '本次請假會扣堂' : '本次請假不扣堂', noteColor: C.SUB, btn: ['查看請假紀錄', 'leave'] })]));
    if (cfgOn('請假通知管理員')) pushMsg(all('SELECT user_id FROM admins WHERE active=1').map(r => r.user_id).filter(u => !parents.includes(u)),
      flexMsg('📝 請假通知｜' + name + ' ' + info.date + ' ' + info.course, [flexBubble({ color: C.INK, title: '學生請假通知', name, rows })]));
  }

  /* ---------- 排課 ---------- */
  const courseDays = c => String(c.weekdays || '').split('').map(Number).filter(n => n >= 0 && n <= 6);
  /** 依課程的開課期間排課：有結束日就一次排到結束日；沒有結束日則滾動排出未來幾週 */
  const courseRange = c => { const t = today(); return { from: c.date_from || t, to: c.date_to || addDays(t, cfgNum('產生場次週數', 8) * 7 - 1) }; };
  function generateSessions() {
    let n = 0;
    const skipped = new Set(all('SELECT id FROM session_skips').map(r => r.id));
    all("SELECT * FROM courses WHERE status='啟用' AND weekdays<>''").forEach(c => {
      const days = courseDays(c), { from, to } = courseRange(c);
      for (let d = from, i = 0; d <= to && i < 1100; d = addDays(d, 1), i++) {
        if (!days.includes(weekday(d))) continue;
        const sid = c.id + '-' + d.replace(/-/g, '');
        if (skipped.has(sid)) continue;
        const r = run('INSERT OR IGNORE INTO sessions(id,course_id,date,start,end,teacher,room,status,manual) VALUES(?,?,?,?,?,?,?,?,0)', sid, c.id, d, c.start, c.end, '', '', '正常');
        n += Number(r.changes);
      }
    });
    return n;
  }
  /** 課程時間、星期或期間變動後：未來、未點名、非手動調整的場次跟著更新 */
  function syncCourseSessions(c) {
    const t = today(), days = courseDays(c);
    all("SELECT s.* FROM sessions s WHERE s.course_id=? AND s.manual=0 AND s.status='正常' AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.session_id=s.id AND a.status<>'取消') AND NOT EXISTS(SELECT 1 FROM leaves l WHERE l.session_id=s.id)", c.id).forEach(s => {
      const outside = (c.date_from && s.date < c.date_from) || (c.date_to && s.date > c.date_to);
      if (outside || (s.date >= t && (c.status !== '啟用' || !days.includes(weekday(s.date))))) run('DELETE FROM sessions WHERE id=?', s.id);
      else if (s.date >= t) run('UPDATE sessions SET start=?, end=? WHERE id=?', c.start, c.end, s.id);
    });
  }
  function maintenance() {
    generateSessions();
    run("UPDATE cards SET status='過期' WHERE status='啟用' AND expire<>'' AND expire<?", today());
    if (dataDir !== ':memory:') {
      const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, today() + '.db');
      if (!fs.existsSync(f)) { db.exec("VACUUM INTO '" + f.replace(/'/g, "''") + "'"); fs.readdirSync(dir).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(dir, x))); }
    }
  }

  const nextId = (table, prefix, width) => { const r = get(`SELECT MAX(CAST(SUBSTR(id,${prefix.length + 1}) AS INTEGER)) m FROM ${table} WHERE id LIKE ?`, prefix + '%'); return prefix + String((r.m || 0) + 1).padStart(width, '0'); };
  const newBindCode = () => { let c; do { c = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (get('SELECT 1 x FROM students WHERE bind_code=?', c)); return c; };
  /* ---------- 教室租借 ---------- */
  const tm = t => +String(t).slice(0, 2) * 60 + +String(t).slice(3, 5), mt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const roomOpen = r => { try { const o = JSON.parse(r.open || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  /** 某一天的開放時段：有單日設定用單日的，否則用每週固定的 */
  const dayRanges = (room, date) => { const o = get('SELECT ranges FROM room_dates WHERE room_id=? AND date=?', room.id, date);
    if (o) { try { return JSON.parse(o.ranges) || []; } catch { return []; } } return roomOpen(room)[weekday(date)] || []; };
  const cleanRanges = list => { const ok = (list || []).map(x => [nt(x[0]), x[1] === '24:00' ? '24:00' : nt(x[1])]).filter(x => x[0] && x[1] && x[1] > x[0]).sort(), out = [];
    ok.forEach(r => { const l = out[out.length - 1]; if (l && r[0] <= l[1]) { if (r[1] > l[1]) l[1] = r[1]; } else out.push([...r]); }); return out; };
  const rentTags = () => all('SELECT * FROM rent_tags ORDER BY sort,id');
  /** 這間教室當天被占用的時段：別人的預約、管理員關閉的時段、排在這間教室的課 */
  function roomBusy(room, date, exceptId = '') {
    const out = all("SELECT * FROM bookings WHERE room_id=? AND date=? AND status IN ('待確認','已確認') AND id<>?", room.id, date, exceptId).map(b => [tm(b.start), tm(b.end), b.status === '已確認' ? '已被預約' : '有人預約中', b.name]);
    all("SELECT * FROM rent_blocks WHERE date=? AND (room_id='' OR room_id=?)", date, room.id).forEach(k => out.push(k.start ? [tm(k.start), tm(k.end), k.note || '不開放', ''] : [0, 1440, k.note || '不開放', '']));
    all("SELECT * FROM sessions WHERE date=? AND status<>'停課'", date).forEach(x => { const i = sessionInfo(x); if (i.room && i.room === room.name) out.push([tm(i.start), tm(i.end), '上課', i.course]); });
    return out;
  }
  /** 當天可預約的格子（依開放時段與最小單位切） */
  function roomSlots(room, date) {
    const unit = Math.max(15, room.unit || 60), busy = roomBusy(room, date), lim = Date.now() + cfgNum('租借提前小時', 12) * 3600e3;
    return dayRanges(room, date).flatMap(([a, z]) => { const out = [];
      for (let m = tm(a); m + unit <= tm(z) && m + unit <= 1440; m += unit) { const hit = busy.find(k => k[0] < m + unit && k[1] > m), late = toDate(date, mt(m)).getTime() < lim;
        out.push({ start: mt(m), end: mt(m + unit), free: !hit && !late, why: hit ? hit[2] : late ? '已截止' : '' }); }
      return out; });
  }
  const bookingView = b => { const r = get('SELECT * FROM rooms WHERE id=?', b.room_id) || {}; return { id: b.id, roomId: b.room_id, room: r.name || '（已刪除的教室）', date: b.date, start: b.start, end: b.end, status: b.status, amount: b.amount, name: b.name, phone: b.phone, purpose: b.purpose, people: b.people, createdAt: b.created_at }; };
  function notifyRenter(b, title, color, note) {
    if (!b.user_id) return 0;
    const v = bookingView(b);
    pushMsg([b.user_id], flexMsg('🏠 ' + title + '｜' + v.room + ' ' + whenOf(b), [flexBubble({ color, title, name: v.room, rows: [['時間', whenOf(b)], ['預約人', b.name], ['人數', b.people ? b.people + ' 人' : ''], ['費用', b.amount ? b.amount + ' 元' : '']], note, noteColor: C.INK, btn: ['查看我的預約', 'rent'] })]));
    return 1;
  }

  /* ---------- 家庭（兄弟姊妹）：共用上課卡、家長一次綁定 ---------- */
  const siblingsOf = sid => { const s = student(sid); return s && s.family ? all("SELECT * FROM students WHERE family=? AND id<>? AND status<>'停用' ORDER BY id", s.family, sid) : []; };
  /** 把幾位學生併成同一個家庭（沿用已有的家庭編號） */
  function linkFamily(ids) {
    ids = [...new Set(ids)].filter(student);
    if (ids.length < 2) return '';
    const fams = [...new Set(ids.map(id => student(id).family).filter(Boolean))];
    const fam = fams[0] || uid('F');
    fams.slice(1).forEach(f => run('UPDATE students SET family=? WHERE family=?', fam, f));
    ids.forEach(id => run('UPDATE students SET family=? WHERE id=?', fam, id));
    return fam;
  }
  if (!get("SELECT 1 x FROM meta WHERE key='family_backfill'")) { // 舊資料：共用上課卡或同一位家長綁定的學生，視為同一家庭
    all('SELECT card_id k, GROUP_CONCAT(student_id) ids FROM card_students GROUP BY card_id HAVING COUNT(*)>1').forEach(r => linkFamily(r.ids.split(',')));
    all('SELECT user_id k, GROUP_CONCAT(student_id) ids FROM bindings GROUP BY user_id HAVING COUNT(*)>1').forEach(r => linkFamily(r.ids.split(',')));
    run("INSERT OR IGNORE INTO meta VALUES('family_backfill','1')");
  }
  /** 上課卡共用時，每位學生各用了幾堂 */
  const cardUsage = cardId => all("SELECT st.name, SUM(a.deduct) n FROM attendance a JOIN students st ON st.id=a.student_id WHERE a.card_id=? AND a.status<>'取消' AND a.deduct>0 GROUP BY a.student_id ORDER BY st.id", cardId);
  const studentBrief = s => {
    const next = all("SELECT s.* FROM sessions s WHERE s.date>=? AND s.status='正常' AND (s.course_id IN (SELECT course_id FROM enrollments WHERE student_id=?) OR s.id IN (SELECT session_id FROM makeups WHERE student_id=?)) ORDER BY s.date,s.start LIMIT 6", today(), s.id, s.id)
      .find(x => toDate(x.date, x.end) > new Date() && !['請假'].includes((activeRecord(x.id, s.id) || {}).status));
    const ni = next ? sessionInfo(next) : null;
    return { id: s.id, name: s.name, remain: totalRemain(s.id),
      sharedWith: all("SELECT DISTINCT st.name FROM card_students a JOIN card_students o ON o.card_id=a.card_id AND o.student_id<>a.student_id JOIN cards c ON c.id=a.card_id JOIN students st ON st.id=o.student_id WHERE a.student_id=? AND c.status='啟用' AND c.remain>0", s.id).map(r => r.name),
      next: ni ? { date: ni.date, start: ni.start, course: ni.course } : null };
  };

  /* ============================== API ============================== */
  const API = {
    /* ---------- 家長端 ---------- */
    init(b, user) {
      return { studio: cfg('教室名稱', '舞蹈教室'), userId: user.userId, name: user.name, isAdmin: !!adminOf(user.userId), students: kidsOf(user.userId).map(studentBrief), lowAt: cfgNum('低堂數門檻', 2), botId: (get("SELECT value FROM meta WHERE key='bot_basic_id'") || {}).value || '' };
    },
    bind(b, user) {
      const code = str(b.code, 10);
      if (!code) throw new Error('請輸入綁定碼');
      const stu = get("SELECT * FROM students WHERE bind_code=? AND status<>'停用'", code);
      if (!stu) throw new Error('綁定碼不正確，請向教室確認');
      const add = x => Number(run('INSERT OR IGNORE INTO bindings(user_id,line_name,student_id,relation,created_at) VALUES(?,?,?,?,?)', user.userId, user.name, x.id, str(b.relation, 20), now()).changes);
      const fresh = add(stu), also = siblingsOf(stu.id).filter(add).map(x => x.name); // 同家庭的兄弟姊妹一起綁定
      linkFamily(kidsOf(user.userId).map(x => x.id)); // 同一位家長綁定的孩子，自動視為同一家庭
      return { id: stu.id, name: stu.name, already: !fresh && !also.length, also };
    },
    card(b, user) {
      assertOwns(user, b.studentId);
      const cards = all('SELECT c.* FROM cards c JOIN card_students cs ON cs.card_id=c.id WHERE cs.student_id=? ORDER BY c.bought DESC, c.id DESC', b.studentId).map(c => ({
        id: c.id, plan: c.plan_name, total: c.total, remain: c.remain, buy: c.bought, expire: c.expire, status: c.status,
        shared: all('SELECT s.name FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=? AND cs.student_id<>?', c.id, b.studentId).map(r => r.name), usage: cardUsage(c.id) }));
      const topups = all('SELECT time,plan_name plan,lessons,amount FROM topups WHERE student_id=? ORDER BY time DESC LIMIT 10', b.studentId);
      return { remain: totalRemain(b.studentId), cards, topups };
    },
    attendance(b, user) {
      assertOwns(user, b.studentId);
      const list = all("SELECT a.status,a.deduct,a.method,a.time,s.date,s.start,COALESCE(c.name,s.course_id) course FROM attendance a JOIN sessions s ON s.id=a.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE a.student_id=? AND a.status<>'取消' ORDER BY s.date DESC, s.start DESC LIMIT 60", b.studentId);
      const count = { '出席': 0, '請假': 0, '缺席': 0 };
      list.forEach(r => { if (count[r.status] !== undefined) count[r.status]++; });
      return { list, count };
    },
    schedule(b, user) {
      assertOwns(user, b.studentId);
      const mine = all('SELECT course_id FROM enrollments WHERE student_id=?', b.studentId).map(r => r.course_id);
      const mk = all('SELECT session_id id FROM makeups WHERE student_id=?', b.studentId).map(r => r.id);
      const pending = all("SELECT course_id FROM signups WHERE student_id=? AND status='待審核'", b.studentId).map(r => r.course_id);
      const t = today(), end = addDays(t, cfgNum('課表顯示天數', 28)), cutoff = cfgNum('請假截止小時', 2) * 3600e3, open = cfgOn('開放線上報名');
      const live = new Set(all("SELECT id FROM courses WHERE status='啟用'").map(r => r.id));
      const view = s => { // mine＝孩子有排入（或補課）；其他課只供瀏覽與報名
        const i = sessionInfo(s), rec = activeRecord(s.id, b.studentId);
        i.my = rec ? rec.status : '';
        i.makeup = mk.includes(s.id);
        i.mine = mine.includes(s.course_id) || i.makeup || !!rec;
        i.canLeave = i.mine && !i.my && i.status === '正常' && toDate(i.date, i.start).getTime() - Date.now() > cutoff;
        delete i.capacity; delete i.manual; delete i.rawTeacher; delete i.rawRoom; delete i.deduct;
        if (!i.mine) i.note = ''; // 老師備註只給這堂課的家長看
        return i;
      };
      const visible = s => mine.includes(s.course_id) || mk.includes(s.id) || live.has(s.course_id);
      const upcoming = all('SELECT * FROM sessions WHERE date>=? AND date<=? ORDER BY date,start', t, end).filter(visible).map(view);
      const wd = '日一二三四五六';
      const vids = {}; videosFor(b.studentId).forEach(v => { if (v.courseId) vids[v.courseId] = (vids[v.courseId] || 0) + 1; });
      const info = {}, addInfo = id => { if (info[id]) return info[id]; const c = get('SELECT * FROM courses WHERE id=?', id); if (!c) return null;
        const count = get("SELECT COUNT(*) n FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.course_id=? AND st.status='在學'", id).n;
        const next = get("SELECT date,start FROM sessions WHERE course_id=? AND status='正常' AND date>=? ORDER BY date,start", id, t);
        return (info[id] = { id, name: c.name, intro: c.intro || '', teacher: c.teacher, room: c.room, day: courseDays(c).map(d => wd[d]).join('、'), start: c.start, end: c.end, from: c.date_from || '', to: c.date_to || '', oneoff: c.weekdays === '', color: c.color, videos: vids[id] || 0,
          enrolled: mine.includes(id), pending: pending.includes(id), capacity: c.capacity || 0, count, full: c.capacity > 0 && count >= c.capacity, next: next ? next.date + ' ' + next.start : '',
          canSignup: open && c.status === '啟用' && !mine.includes(id) && !pending.includes(id) && !(c.capacity > 0 && count >= c.capacity) && !!next && !(c.date_to && c.date_to < t) }); };
      // 教室全部課程：固定課程（未結束）＋還沒上的單次課程
      const courses = all("SELECT * FROM courses WHERE status='啟用' ORDER BY weekdays='' , start").filter(c => !(c.date_to && c.date_to < t)).map(c => addInfo(c.id)).filter(Boolean);
      const out = { upcoming, courses, enrolledOnly: mine.length > 0, today: t, info, signupOpen: open, review: cfgOn('報名需審核') };
      upcoming.forEach(u => addInfo(u.courseId));
      if (b.month !== undefined) { // 月曆：整個月（含過去）的課
        out.month = /^\d{4}-\d{2}$/.test(b.month || '') ? b.month : t.slice(0, 7);
        out.monthSessions = all('SELECT * FROM sessions WHERE substr(date,1,7)=? ORDER BY date,start', out.month).filter(visible).map(view);
        out.monthSessions.forEach(u => addInfo(u.courseId));
      }
      return out;
    },
    /** 家長線上報名：需審核時先建立申請並通知管理員，否則直接加入名單 */
    signup(b, user) {
      assertOwns(user, b.studentId);
      if (!cfgOn('開放線上報名')) throw new Error('目前沒有開放線上報名，請直接聯絡教室');
      const c = get("SELECT * FROM courses WHERE id=? AND status='啟用'", b.courseId), stu = student(b.studentId);
      if (!c) throw new Error('找不到這門課');
      if (get('SELECT 1 x FROM enrollments WHERE student_id=? AND course_id=?', stu.id, c.id)) throw new Error(stu.name + ' 已經在這門課的名單上');
      if (get("SELECT 1 x FROM signups WHERE student_id=? AND course_id=? AND status='待審核'", stu.id, c.id)) throw new Error('已經送出報名，請等教室確認');
      const count = get("SELECT COUNT(*) n FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.course_id=? AND st.status='在學'", c.id).n;
      if (c.capacity > 0 && count >= c.capacity) throw new Error('這門課已額滿，請按「諮詢」聯絡教室');
      const review = cfgOn('報名需審核'), id = uid('G');
      run('INSERT INTO signups(id,student_id,course_id,status,time,by_user,by_name) VALUES(?,?,?,?,?,?,?)', id, stu.id, c.id, review ? '待審核' : '已加入', now(), user.userId, user.name);
      if (!review) run('INSERT INTO enrollments VALUES(?,?,?)', stu.id, c.id, today());
      const when = c.weekdays === '' ? (c.date_from || '').slice(5).replace('-', '/') + ' ' + c.start : '每週' + courseDays(c).map(d => '日一二三四五六'[d]).join('、') + ' ' + c.start + '–' + c.end;
      pushMsg(all("SELECT user_id FROM admins WHERE active=1 AND role='owner'").map(r => r.user_id), flexMsg('📝 線上報名｜' + stu.name + ' → ' + c.name, [flexBubble({ color: C.INFO, title: review ? '報名申請' : '新報名', name: stu.name,
        rows: [['課程', c.name], ['時間', when], ['申請人', user.name], ['剩餘堂數', totalRemain(stu.id) + ' 堂']], note: review ? '請到後台「總覽 → 報名申請」同意或婉拒。' : '已自動加入這門課的學生名單。', noteColor: C.SUB })]));
      return { status: review ? '待審核' : '已加入' };
    },
    leave(b, user) {
      assertOwns(user, b.studentId);
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到這堂課');
      if (sess.status !== '正常') throw new Error('這堂課已' + sess.status + '，無法請假');
      if (toDate(sess.date, sess.start).getTime() - Date.now() <= cfgNum('請假截止小時', 2) * 3600e3) throw new Error('已超過線上請假時間（上課前 ' + cfgNum('請假截止小時', 2) + ' 小時），請直接聯絡教室');
      if (activeRecord(b.sessionId, b.studentId)) throw new Error('這堂課已有紀錄，無法重複請假');
      const reason = str(b.reason);
      run('INSERT INTO leaves(id,student_id,session_id,reason,applied_at,by_name,by_user,status) VALUES(?,?,?,?,?,?,?,?)', uid('L'), b.studentId, b.sessionId, reason, now(), user.name, user.userId, '已登記');
      recordAttendance(sess, b.studentId, '請假', '線上請假', user.name || '家長', false);
      notifyLeave(sessionInfo(sess), b.studentId, reason, user.name || '家長');
      return { status: '已登記' };
    },
    /* ----- 教室租借（不需要綁定學生，加好友登入即可） ----- */
    rentInfo(b, user) {
      const days = cfgNum('租借可預約天數', 30);
      return { open: cfgOn('開放教室租借'), review: cfgOn('租借需確認'), rules: cfg('租借須知', ''), today: today(), lastDay: addDays(today(), days), advance: cfgNum('租借提前小時', 12),
        rooms: all("SELECT * FROM rooms WHERE status='開放' ORDER BY sort,id").map(r => ({ id: r.id, name: r.name, capacity: r.capacity, price: r.price, unit: r.unit, intro: r.intro, days: Object.keys(roomOpen(r)).filter(k => (roomOpen(r)[k] || []).length).map(Number),
          dates: [...Array(days + 1)].map((_, i) => addDays(today(), i)).filter(x => dayRanges(r, x).length) })),
        mine: all("SELECT * FROM bookings WHERE user_id=? AND date>=? ORDER BY date,start", user.userId, addDays(today(), -30)).map(bookingView), lastName: (get("SELECT name,phone FROM bookings WHERE user_id=? ORDER BY created_at DESC", user.userId) || {}) };
    },
    rentSlots(b) {
      const room = get("SELECT * FROM rooms WHERE id=? AND status='開放'", b.roomId), date = nd(b.date);
      if (!room || !date) throw new Error('找不到教室');
      if (date < today() || date > addDays(today(), cfgNum('租借可預約天數', 30))) return { slots: [], out: true };
      return { slots: roomSlots(room, date), unit: room.unit, price: room.price };
    },
    rentBook(b, user) {
      if (!cfgOn('開放教室租借')) throw new Error('目前沒有開放線上租借，請直接聯絡教室');
      const room = get("SELECT * FROM rooms WHERE id=? AND status='開放'", b.roomId), date = nd(b.date), start = nt(b.start), end = nt(b.end);
      if (!room || !date || !start || !end || end <= start) throw new Error('請選擇教室、日期與時段');
      if (date < today() || date > addDays(today(), cfgNum('租借可預約天數', 30))) throw new Error('這一天不開放預約');
      const name = str(b.name, 40), phone = str(b.phone, 30);
      if (!name || !/^[0-9+\-() ]{6,}$/.test(phone)) throw new Error('請填寫姓名與聯絡電話');
      const want = roomSlots(room, date).filter(k => k.start >= start && k.end <= end);
      if (!want.length || want[0].start !== start || want[want.length - 1].end !== end || want.some((k, i) => i && k.start !== want[i - 1].end)) throw new Error('請選擇開放時段內的連續時間');
      if (want.some(k => !k.free)) throw new Error('這個時段剛剛被預約走了，請重新選擇');
      if (get("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='待確認'", user.userId).n >= 5) throw new Error('您有太多待確認的預約，請等教室確認後再預約');
      const review = cfgOn('租借需確認'), id = uid('B'), amount = Math.round(room.price * (tm(end) - tm(start)) / 60);
      run('INSERT INTO bookings(id,room_id,date,start,end,user_id,line_name,name,phone,purpose,people,status,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, room.id, date, start, end, user.userId, user.name, name, phone, str(b.purpose, 200), Math.max(0, Math.floor(Number(b.people)) || 0), review ? '待確認' : '已確認', amount, now());
      const bk = get('SELECT * FROM bookings WHERE id=?', id);
      pushMsg(all("SELECT user_id FROM admins WHERE active=1 AND role='owner'").map(r => r.user_id), flexMsg('🏠 教室租借' + (review ? '申請' : '') + '｜' + room.name + ' ' + whenOf(bk), [flexBubble({ color: C.INFO, title: review ? '教室租借申請' : '新的教室預約', name: room.name,
        rows: [['時間', whenOf(bk)], ['預約人', name + '（' + phone + '）'], ['人數', bk.people ? bk.people + ' 人' : ''], ['用途', bk.purpose], ['費用', amount ? amount + ' 元' : '']], note: review ? '請到後台「租借」確認或婉拒。' : '已自動成立。', noteColor: C.SUB })]));
      if (!review) notifyRenter(bk, '預約成功', C.OK, cfg('租借須知', ''));
      return { id, status: bk.status, amount };
    },
    rentCancel(b, user) {
      const bk = get("SELECT * FROM bookings WHERE id=? AND user_id=?", b.id, user.userId);
      if (!bk || !['待確認', '已確認'].includes(bk.status)) throw new Error('這筆預約無法取消');
      if (toDate(bk.date, bk.start).getTime() < Date.now()) throw new Error('已經過了使用時間');
      run("UPDATE bookings SET status='已取消', decided_at=?, decided_by=? WHERE id=?", now(), '預約人取消', bk.id);
      pushMsg(all("SELECT user_id FROM admins WHERE active=1 AND role='owner'").map(r => r.user_id), flexMsg('🏠 租借取消｜' + bookingView(bk).room + ' ' + whenOf(bk), [flexBubble({ color: C.SUB, title: '預約人取消租借', name: bookingView(bk).room, rows: [['時間', whenOf(bk)], ['預約人', bk.name + '（' + bk.phone + '）']] })]));
      return { ok: true };
    },
    leaves(b, user) {
      assertOwns(user, b.studentId);
      return all('SELECT l.reason,l.status,l.applied_at applied,s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE l.student_id=? ORDER BY l.applied_at DESC LIMIT 30', b.studentId);
    },
    videos(b, user) {
      assertOwns(user, b.studentId);
      return videosFor(b.studentId);
    },
    checkinInfo(b) { const s = sessRow(b.sessionId); if (!s) throw new Error('找不到這堂課'); return sessionInfo(s); },
    checkin(b, user) {
      assertOwns(user, b.studentId);
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到這堂課');
      if (b.qr !== qrToken(b.sessionId, 0) && b.qr !== qrToken(b.sessionId, -1)) throw new Error('QR Code 已過期，請重新掃描教室的報到 QR Code');
      if (sess.status !== '正常') throw new Error('這堂課已' + sess.status);
      const start = toDate(sess.date, sess.start).getTime(), n = Date.now();
      if (n < start - cfgNum('報到開放分鐘前', 30) * 60000) throw new Error('尚未開放報到（上課前 ' + cfgNum('報到開放分鐘前', 30) + ' 分鐘開放）');
      if (n > start + cfgNum('報到截止分鐘後', 30) * 60000) throw new Error('已超過線上報到時間，請洽櫃檯');
      if (cfgOn('僅限選課學生報到') && !get('SELECT 1 x FROM enrollments WHERE student_id=? AND course_id=?', b.studentId, sess.course_id)) throw new Error('這位學生未報名此課程，請洽櫃檯');
      const info = sessionInfo(sess), old = activeRecord(b.sessionId, b.studentId);
      if (old && old.status === '出席') return { dup: true, remain: totalRemain(b.studentId), info };
      if (!cfgOn('無堂數可線上報到') && !pickCard(b.studentId, info.deduct)) throw new Error('上課卡堂數不足，請先至櫃檯儲值');
      return { ...recordAttendance(sess, b.studentId, '出席', 'LINE線上', user.name || '家長'), info };
    },

    /* ---------- 後台：共用 ---------- */
    'a.meta'(b, user) {
      return { studio: cfg('教室名稱', '舞蹈教室'), role: user.admin.role, name: user.admin.name || user.name, today: today(), liffId: env.LIFF_ID || '',
        plans: all('SELECT * FROM plans WHERE active=1 ORDER BY sort,id'), courses: all("SELECT * FROM courses ORDER BY status DESC, start, id"), colors: COLORS };
    },
    'a.overview'(b) {
      const d = nd(b.date) || today(), low = cfgNum('低堂數門檻', 2);
      const stus = all("SELECT * FROM students WHERE status='在學'");
      const lowList = stus.map(s => ({ id: s.id, name: s.name, remain: totalRemain(s.id) })).filter(s => s.remain <= low).sort((a, c) => a.remain - c.remain).slice(0, 12);
      const soon = addDays(today(), 14);
      return {
        date: d, sessions: API['a.week']({ start: d, days: 1 }).sessions,
        stats: { students: stus.length, weekSessions: get("SELECT COUNT(*) n FROM sessions WHERE date>=? AND date<=? AND status<>'停課'", today(), addDays(today(), 6)).n,
          unbound: get("SELECT COUNT(*) n FROM students s WHERE s.status='在學' AND NOT EXISTS(SELECT 1 FROM bindings b WHERE b.student_id=s.id)").n,
          monthIncome: get('SELECT COALESCE(SUM(amount),0) n FROM topups WHERE time>=?', today().slice(0, 7) + '-01').n },
        signups: get("SELECT COUNT(*) n FROM signups WHERE status='待審核'").n, rentPending: get("SELECT COUNT(*) n FROM bookings WHERE status='待確認'").n,
        low: lowList,
        expiring: all("SELECT c.id,c.plan_name plan,c.remain,c.expire,(SELECT GROUP_CONCAT(s.name,'、') FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=c.id) names FROM cards c WHERE c.status='啟用' AND c.remain>0 AND c.expire<>'' AND c.expire>=? AND c.expire<=? ORDER BY c.expire LIMIT 12", today(), soon),
        leaves: all('SELECT st.name student,l.reason,s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id JOIN students st ON st.id=l.student_id LEFT JOIN courses c ON c.id=s.course_id WHERE s.date>=? ORDER BY s.date,s.start LIMIT 12', today())
      };
    },
    'a.week'(b) {
      const terms = {}, termOf = id => terms[id] ??= !!(get('SELECT date_to FROM courses WHERE id=?', id) || {}).date_to;
      const start = nd(b.start) || today(), end = addDays(start, Math.min(62, Math.max(1, Number(b.days) || 7)) - 1);
      const sessions = all('SELECT * FROM sessions WHERE date>=? AND date<=? ORDER BY date,start', start, end).map(s => {
        const i = sessionInfo(s);
        const cnt = Object.fromEntries(all("SELECT status, COUNT(*) n FROM attendance WHERE session_id=? AND status<>'取消' GROUP BY status", s.id).map(r => [r.status, r.n]));
        i.present = cnt['出席'] || 0; i.leave = cnt['請假'] || 0; i.absent = cnt['缺席'] || 0;
        i.enrolled = get("SELECT COUNT(*) n FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.course_id=? AND st.status='在學'", s.course_id).n;
        i.past = s.date < today() || (s.date === today() && s.end <= now().slice(11, 16));
        i.unmarked = i.past && i.status === '正常' && i.enrolled > 0 && !(i.present + i.leave + i.absent);
        if (termOf(s.course_id)) { // 有結束日期的課程：這是整期的第幾堂
          i.total = get("SELECT COUNT(*) n FROM sessions WHERE course_id=? AND status<>'停課'", s.course_id).n;
          i.seq = s.status === '停課' ? 0 : get("SELECT COUNT(*) n FROM sessions WHERE course_id=? AND status<>'停課' AND (date<? OR (date=? AND start<=?))", s.course_id, s.date, s.date, s.start).n;
        }
        return i;
      });
      const rentals = all("SELECT b.id,b.date,b.start,b.end,b.name,b.status,r.name room FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.date>=? AND b.date<=? AND b.status IN ('待確認','已確認') ORDER BY b.date,b.start", start, end);
      return { start, end, sessions, rentals };
    },
    'a.roster'(b) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      const ids = all("SELECT e.student_id id FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=? AND s.status<>'停用' ORDER BY s.name", sess.course_id).map(r => r.id);
      const fixedN = ids.length;
      const mk = all('SELECT student_id id FROM makeups WHERE session_id=?', b.sessionId).map(r => r.id);
      mk.forEach(id => { if (!ids.includes(id)) ids.push(id); });
      all("SELECT DISTINCT student_id id FROM attendance WHERE session_id=? AND status<>'取消'", b.sessionId).forEach(r => { if (!ids.includes(r.id)) ids.push(r.id); });
      const list = ids.map(id => { const s = student(id), r = activeRecord(b.sessionId, id), m = get('SELECT s.date,s.start FROM makeups m JOIN sessions s ON s.id=m.session_id WHERE m.student_id=? AND m.from_session_id=?', id, b.sessionId);
        return s && { id, name: s.name, status: r ? r.status : '', method: r ? r.method : '', note: r ? r.note : '', remain: totalRemain(id), makeup: mk.includes(id), fixed: fixedN > ids.indexOf(id), makeupAt: m ? m.date.slice(5).replace('-', '/') + ' ' + m.start : '' }; }).filter(Boolean);
      return { info: sessionInfo(sess), list };
    },
    'a.mark'(b, user) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      if (!student(b.studentId)) throw new Error('找不到學生');
      if (!['出席', '請假', '缺席', '取消'].includes(b.status)) throw new Error('狀態不正確');
      return recordAttendance(sess, b.studentId, b.status, '後台', user.admin.name || user.name);
    },
    /** 全部出席：名單上還沒點名的學生（含補課）一次記為出席 */
    'a.markAll'(b, user) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      if (sess.status === '停課') throw new Error('這堂課已停課');
      const ids = API['a.roster']({ sessionId: sess.id }).list.filter(x => !x.status).map(x => x.id);
      ids.forEach(id => recordAttendance(sess, id, '出席', '後台', user.admin.name || user.name));
      return { marked: ids.length };
    },
    /** 多選學生一次報到；管理員可順便把他們加入這門課的固定名單 */
    'a.markMany'(b, user) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      if (sess.status === '停課') throw new Error('這堂課已停課');
      const ids = [...new Set((b.studentIds || []).filter(student))];
      if (!ids.length) throw new Error('請至少選一位學生');
      let noCard = 0, added = 0;
      ids.forEach(id => { const r = recordAttendance(sess, id, '出席', '後台', user.admin.name || user.name); if (!r.dup && !r.deduct) noCard++; });
      if (b.addToRoster && user.admin.role === 'owner') ids.forEach(id => { if (!get('SELECT 1 x FROM enrollments WHERE student_id=? AND course_id=?', id, sess.course_id)) { run('INSERT INTO enrollments VALUES(?,?,?)', id, sess.course_id, today()); added++; } });
      return { marked: ids.length, noCard, added };
    },
    /** 課程的固定學生名單（點名單、家長課表與請假都依這份名單） */
    'a.courseStudents'(b) {
      if (!get('SELECT 1 x FROM courses WHERE id=?', b.courseId)) throw new Error('找不到課程');
      if (!Array.isArray(b.studentIds)) return { ids: all("SELECT e.student_id id FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=? AND s.status<>'停用'", b.courseId).map(r => r.id) };
      const want = [...new Set(b.studentIds.filter(student))], old = all('SELECT student_id id FROM enrollments WHERE course_id=?', b.courseId).map(r => r.id);
      old.filter(id => !want.includes(id)).forEach(id => run('DELETE FROM enrollments WHERE course_id=? AND student_id=?', b.courseId, id));
      want.filter(id => !old.includes(id)).forEach(id => run('INSERT INTO enrollments VALUES(?,?,?)', id, b.courseId, today()));
      return { ids: want, added: want.filter(id => !old.includes(id)).length, removed: old.filter(id => !want.includes(id)).length };
    },
    'a.rent'(b) {
      const from = nd(b.from) || addDays(today(), -30);
      return { today: today(), tags: rentTags(), rooms: all('SELECT * FROM rooms ORDER BY sort,id').map(r => { const win = cfgNum('租借可預約天數', 30);
          return { ...r, open: roomOpen(r), window: win, openDays: [...Array(win + 1)].filter((_, i) => dayRanges(r, addDays(today(), i)).length).length,
            custom: all('SELECT date,ranges FROM room_dates WHERE room_id=? AND date>=? ORDER BY date', r.id, today()).map(x => { let g = []; try { g = JSON.parse(x.ranges) || []; } catch { /* 壞資料當作不開放 */ } return { date: x.date, ranges: g }; }) }; }),
        blocks: all('SELECT * FROM rent_blocks WHERE date>=? ORDER BY date,start', today()),
        bookings: all('SELECT * FROM bookings WHERE date>=? ORDER BY date,start LIMIT 800', from).map(k => ({ ...bookingView(k), lineName: k.line_name, online: !!k.user_id, tags: k.tags ? k.tags.split(',') : [], note: k.note, byAdmin: k.by_admin, decidedBy: k.decided_by })),
        pending: get("SELECT COUNT(*) n FROM bookings WHERE status='待確認'").n };
    },
    'a.rentSlots'(b) {
      const room = get('SELECT * FROM rooms WHERE id=?', b.roomId), date = nd(b.date);
      if (!room || !date) throw new Error('找不到教室');
      return { slots: roomSlots(room, date), busy: roomBusy(room, date, str(b.exceptId, 40)).map(k => ({ start: mt(k[0]), end: mt(Math.min(k[1], 1439)), why: k[2], who: k[3] })).sort((x, y) => x.start < y.start ? -1 : 1) };
    },
    'a.roomSave'(b) {
      const name = str(b.name, 40);
      if (!name) throw new Error('請輸入教室名稱');
      const old = b.id ? get('SELECT * FROM rooms WHERE id=?', b.id) : null, open = b.open === undefined && old ? roomOpen(old) : {};
      Object.entries(b.open || {}).forEach(([d, list]) => { const ok = cleanRanges(list); if (+d >= 0 && +d <= 6 && ok.length) open[+d] = ok; });
      const unit = [30, 60].includes(Number(b.unit)) ? Number(b.unit) : 60;
      const v = [name, Math.max(0, Math.floor(Number(b.capacity)) || 0), Math.max(0, Math.floor(Number(b.price)) || 0), unit, str(b.intro, 1000), JSON.stringify(open), b.status === '關閉' ? '關閉' : '開放'];
      const id = b.id || nextId('rooms', 'R', 2);
      if (b.id) { if (!get('SELECT 1 x FROM rooms WHERE id=?', id)) throw new Error('找不到教室'); run('UPDATE rooms SET name=?,capacity=?,price=?,unit=?,intro=?,open=?,status=? WHERE id=?', ...v, id); }
      else run('INSERT INTO rooms(name,capacity,price,unit,intro,open,status,id,sort) VALUES(?,?,?,?,?,?,?,?,?)', ...v, id, get('SELECT COUNT(*) n FROM rooms').n);
      return { id };
    },
    /** 月曆：這間教室某個月每天的開放時段、預約數與課程數 */
    'a.roomCal'(b) {
      const room = get('SELECT * FROM rooms WHERE id=?', b.roomId);
      if (!room) throw new Error('找不到教室');
      const month = /^\d{4}-\d{2}$/.test(b.month || '') ? b.month : today().slice(0, 7), days = [];
      const ov = new Set(all('SELECT date FROM room_dates WHERE room_id=? AND substr(date,1,7)=?', room.id, month).map(r => r.date));
      for (let d = month + '-01'; d.slice(0, 7) === month; d = addDays(d, 1)) {
        const busy = roomBusy(room, d);
        days.push({ date: d, ranges: dayRanges(room, d), custom: ov.has(d), booked: busy.filter(k => /預約/.test(k[2])).length, classes: busy.filter(k => k[2] === '上課').length, closed: busy.some(k => k[0] === 0 && k[1] === 1440) });
      }
      return { month, today: today(), room: { id: room.id, name: room.name, unit: room.unit, open: roomOpen(room) }, days };
    },
    /** 設定開放時段：scope=date 只改這一天；weekly 改成每週這個星期都這樣；reset 讓這一天回到每週固定 */
    'a.roomHours'(b) {
      const room = get('SELECT * FROM rooms WHERE id=?', b.roomId), date = nd(b.date);
      if (!room || !date) throw new Error('找不到教室或日期');
      const ranges = cleanRanges(b.ranges);
      let count = 1;
      if (b.scope === 'range') { // 一段日期（可只挑其中幾個星期幾）
        const from = nd(b.from), to = nd(b.to), wds = Array.isArray(b.weekdays) && b.weekdays.length ? b.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
        if (!from || !to || to < from) throw new Error('請選擇正確的起訖日期');
        if (to > addDays(from, 366)) throw new Error('一次最多設定一年');
        count = 0;
        for (let d = from; d <= to; d = addDays(d, 1)) if (wds.includes(weekday(d))) { run('INSERT INTO room_dates(room_id,date,ranges) VALUES(?,?,?) ON CONFLICT(room_id,date) DO UPDATE SET ranges=excluded.ranges', room.id, d, JSON.stringify(ranges)); count++; }
        return { ranges, count };
      }
      if (b.scope === 'reset') run('DELETE FROM room_dates WHERE room_id=? AND date=?', room.id, date);
      else if (b.scope === 'weekly') { const open = roomOpen(room), w = weekday(date);
        if (ranges.length) open[w] = ranges; else delete open[w];
        run('UPDATE rooms SET open=? WHERE id=?', JSON.stringify(open), room.id);
        all('SELECT date FROM room_dates WHERE room_id=? AND date>=?', room.id, today()).filter(r => weekday(r.date) === w).forEach(r => run('DELETE FROM room_dates WHERE room_id=? AND date=?', room.id, r.date)); // 之後同星期的單日設定一起回到新的固定時段
      } else run('INSERT INTO room_dates(room_id,date,ranges) VALUES(?,?,?) ON CONFLICT(room_id,date) DO UPDATE SET ranges=excluded.ranges', room.id, date, JSON.stringify(ranges));
      return { ranges: dayRanges(get('SELECT * FROM rooms WHERE id=?', room.id), date) };
    },
    'a.roomDelete'(b) {
      if (get("SELECT 1 x FROM bookings WHERE room_id=? AND status IN ('待確認','已確認') AND date>=?", b.id, today())) throw new Error('這間教室還有未完成的預約，請先處理或改成「關閉」');
      run('DELETE FROM rooms WHERE id=?', b.id); run('DELETE FROM rent_blocks WHERE room_id=?', b.id); run('DELETE FROM room_dates WHERE room_id=?', b.id);
      return { deleted: true };
    },
    'a.rentBlockSave'(b) {
      const date = nd(b.date), start = nt(b.start), end = nt(b.end);
      if (!date) throw new Error('請選擇日期');
      if ((start || end) && !(start && end && end > start)) throw new Error('時間不正確（整天不開放請兩格都留白）');
      const id = uid('K');
      run('INSERT INTO rent_blocks(id,room_id,date,start,end,note) VALUES(?,?,?,?,?,?)', id, str(b.roomId, 20), date, start, end, str(b.note, 60));
      return { id };
    },
    'a.rentBlockDelete'(b) { run('DELETE FROM rent_blocks WHERE id=?', b.id); return { ok: true }; },
    'a.rentTagSave'(b) {
      const name = str(b.name, 12);
      if (!name) throw new Error('請輸入標籤名稱');
      const color = COLORS.includes(b.color) ? b.color : COLORS[0];
      if (b.id) run('UPDATE rent_tags SET name=?, color=? WHERE id=?', name, color, b.id);
      else run('INSERT INTO rent_tags(id,name,color,sort) VALUES(?,?,?,?)', uid('T'), name, color, get('SELECT COUNT(*) n FROM rent_tags').n);
      return { ok: true };
    },
    'a.rentTagDelete'(b) {
      all("SELECT id,tags FROM bookings WHERE tags LIKE ?", '%' + b.id + '%').forEach(k => run('UPDATE bookings SET tags=? WHERE id=?', k.tags.split(',').filter(t => t !== b.id).join(','), k.id));
      run('DELETE FROM rent_tags WHERE id=?', b.id); return { ok: true };
    },
    /** 管理員新增／修改預約：可直接幫人保留、確認、婉拒、取消、貼標籤 */
    'a.bookingSave'(b, user) {
      const old = b.id ? get('SELECT * FROM bookings WHERE id=?', b.id) : null;
      if (b.id && !old) throw new Error('找不到這筆預約');
      const pick = (k, d) => b[k] !== undefined ? b[k] : d;
      const roomId = pick('roomId', old && old.room_id), date = nd(pick('date', old && old.date)), start = nt(pick('start', old && old.start)), end = nt(pick('end', old && old.end));
      const room = get('SELECT * FROM rooms WHERE id=?', roomId);
      if (!room || !date || !start || !end || end <= start) throw new Error('請選擇教室、日期與時間');
      const status = ['待確認', '已確認', '已婉拒', '已取消'].includes(b.status) ? b.status : old ? old.status : '已確認';
      const name = str(pick('name', old ? old.name : ''), 40);
      if (!name) throw new Error('請填寫預約人或用途名稱');
      if (['待確認', '已確認'].includes(status) && !b.force) { const hit = roomBusy(room, date, old ? old.id : '').filter(k => k[0] < tm(end) && k[1] > tm(start));
        if (hit.length) throw new Error('CONFLICT:' + hit.map(k => `${mt(k[0])}–${mt(Math.min(k[1], 1439))} ${k[2]}${k[3] ? '（' + k[3] + '）' : ''}`).join('\n')); }
      const valid = new Set(rentTags().map(t => t.id)), tags = Array.isArray(b.tags) ? b.tags.filter(t => valid.has(t)).join(',') : old ? old.tags : '';
      const amount = b.amount !== undefined && b.amount !== '' ? Math.max(0, Math.floor(Number(b.amount)) || 0) : old ? old.amount : Math.round(room.price * (tm(end) - tm(start)) / 60);
      const v = [room.id, date, start, end, name, str(pick('phone', old ? old.phone : ''), 30), str(pick('purpose', old ? old.purpose : ''), 200), Math.max(0, Math.floor(Number(pick('people', old ? old.people : 0))) || 0), status, amount, tags, str(pick('note', old ? old.note : ''), 300)];
      const id = old ? old.id : uid('B'), me = user.admin.name || user.name;
      if (old) run('UPDATE bookings SET room_id=?,date=?,start=?,end=?,name=?,phone=?,purpose=?,people=?,status=?,amount=?,tags=?,note=? WHERE id=?', ...v, id);
      else run('INSERT INTO bookings(room_id,date,start,end,name,phone,purpose,people,status,amount,tags,note,id,created_at,by_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...v, id, now(), me);
      const cur = get('SELECT * FROM bookings WHERE id=?', id);
      let notified = 0;
      if (old && old.status !== status) { run('UPDATE bookings SET decided_at=?, decided_by=? WHERE id=?', now(), me, id);
        if (b.notify !== false) notified = status === '已確認' ? notifyRenter(cur, '預約已確認', C.OK, cfg('租借須知', '')) : status === '已婉拒' ? notifyRenter(cur, '預約未成立', C.SUB, str(b.reason) || '這個時段無法出借，歡迎改約其他時間。') : status === '已取消' ? notifyRenter(cur, '預約已取消', C.WARN, str(b.reason) || '如有疑問請直接留言給我們。') : 0; }
      else if (old && b.notify !== false && status === '已確認' && (old.date !== date || old.start !== start || old.end !== end || old.room_id !== room.id)) notified = notifyRenter(cur, '預約時間已更改', C.INFO, '原時間：' + whenOf(old));
      return { id, status, notified };
    },
    'a.signups'() {
      return all("SELECT g.id,g.time,g.by_name by,g.student_id sid,st.name student,g.course_id courseId,c.name course,c.capacity FROM signups g JOIN students st ON st.id=g.student_id JOIN courses c ON c.id=g.course_id WHERE g.status='待審核' ORDER BY g.time")
        .map(g => ({ ...g, remain: totalRemain(g.sid), count: get("SELECT COUNT(*) n FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=? AND s.status='在學'", g.courseId).n }));
    },
    'a.signupSave'(b, user) {
      const g = get("SELECT * FROM signups WHERE id=? AND status='待審核'", b.id);
      if (!g) throw new Error('這筆報名已經處理過了');
      const stu = student(g.student_id), c = get('SELECT * FROM courses WHERE id=?', g.course_id);
      run('UPDATE signups SET status=?, done_at=?, done_by=? WHERE id=?', b.approve ? '已加入' : '已婉拒', now(), user.admin.name || user.name, g.id);
      if (b.approve && stu && c) run('INSERT OR IGNORE INTO enrollments VALUES(?,?,?)', stu.id, c.id, today());
      if (stu && c) pushMsg(parentsOf(stu.id), flexMsg((b.approve ? '✅ 報名成功｜' : '報名結果｜') + stu.name + ' ' + c.name, [flexBubble({ color: b.approve ? C.OK : C.SUB, title: b.approve ? '報名成功' : '報名未成功', name: stu.name,
        rows: [['課程', c.name], ['老師', c.teacher]], note: b.approve ? '已加入課程名單，可在課表查看上課時間與請假。' : (str(b.reason) || '這次沒有辦法安排，詳情請按課表上的「諮詢」聯絡我們。'), noteColor: C.INK, btn: ['查看課表', 'schedule'] })]));
      return { ok: true };
    },
    'a.close'(b, user) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      let n = 0;
      all("SELECT e.student_id id FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=? AND s.status='在學'", sess.course_id).forEach(r => {
        if (activeRecord(b.sessionId, r.id)) return;
        recordAttendance(sess, r.id, '缺席', '結算', user.admin.name || user.name); n++;
      });
      run("UPDATE sessions SET status='已結算' WHERE id=?", sess.id);
      return { absent: n };
    },
    'a.qr'(b) {
      if (!sessRow(b.sessionId)) throw new Error('找不到場次');
      return { url: liffUrl('checkin', '&sid=' + encodeURIComponent(b.sessionId) + '&t=' + qrToken(b.sessionId)), refresh: Math.max(10, Math.floor(cfgNum('QR更新秒數', 60) / 2)) };
    },
    'a.students'() {
      return all('SELECT * FROM students ORDER BY status, id').map(s => ({ id: s.id, name: s.name, birthday: s.birthday, phone: s.phone, code: s.bind_code, status: s.status, note: s.note, remain: totalRemain(s.id),
        bound: get('SELECT COUNT(*) n FROM bindings WHERE student_id=?', s.id).n, courses: all('SELECT course_id FROM enrollments WHERE student_id=?', s.id).map(r => r.course_id),
        family: siblingsOf(s.id).map(r => r.id), parents: all('SELECT line_name n, relation r FROM bindings WHERE student_id=?', s.id).map(r => (r.n || '家長') + (r.r ? '（' + r.r + '）' : '')),
        shared: !!get("SELECT 1 x FROM card_students a JOIN card_students o ON o.card_id=a.card_id AND o.student_id<>a.student_id JOIN cards c ON c.id=a.card_id WHERE a.student_id=? AND c.status='啟用' AND c.remain>0", s.id) }));
    },
    /** 出席總表：某月（可再依課程、學生篩選）的明細、統計與每位學生出席率 */
    'a.attendance'(b) {
      const month = /^\d{4}-\d{2}$/.test(b.month || '') ? b.month : today().slice(0, 7);
      const cond = ["a.status<>'取消'", 'substr(s.date,1,7)=?'], args = [month];
      if (b.courseId) { cond.push('s.course_id=?'); args.push(str(b.courseId, 20)); }
      if (b.studentId) { cond.push('a.student_id=?'); args.push(str(b.studentId, 20)); }
      const rows = all(`SELECT a.id,a.student_id sid,st.name student,a.status,a.deduct,a.method,a.operator,a.note,s.id sessionId,s.date,s.start,s.course_id courseId,COALESCE(c.name,s.course_id) course FROM attendance a JOIN sessions s ON s.id=a.session_id LEFT JOIN students st ON st.id=a.student_id LEFT JOIN courses c ON c.id=s.course_id WHERE ${cond.join(' AND ')} ORDER BY s.date DESC, s.start DESC, st.name`, ...args);
      const count = list => { const o = { 出席: 0, 請假: 0, 缺席: 0, deduct: 0 }; list.forEach(r => { if (r.status in o) o[r.status]++; o.deduct += r.deduct || 0; }); const n = o.出席 + o.請假 + o.缺席; return { ...o, total: n, rate: n ? Math.round(o.出席 / n * 100) : null }; };
      const by = new Map();
      rows.forEach(r => { if (!by.has(r.sid)) by.set(r.sid, []); by.get(r.sid).push(r); });
      return { month, total: count(rows), truncated: rows.length > 600, rows: rows.slice(0, 600),
        students: [...by].map(([id, list]) => ({ id, name: list[0].student || id, ...count(list) })).sort((x, y) => (x.rate ?? 101) - (y.rate ?? 101) || y.total - x.total),
        months: [...new Set([today().slice(0, 7), ...all("SELECT DISTINCT substr(s.date,1,7) m FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE a.status<>'取消' ORDER BY m DESC LIMIT 36").map(r => r.m)])].sort().reverse() };
    },
    'a.leaves'() { // 家長線上請假＋老師在點名單標的請假
      return all("SELECT a.id,a.student_id sid,a.session_id sessionId,(SELECT s2.date||' '||s2.start FROM makeups m JOIN sessions s2 ON s2.id=m.session_id WHERE m.student_id=a.student_id AND m.from_session_id=a.session_id) makeup,st.name student,COALESCE(l.reason,'') reason,'已登記' status,COALESCE(l.applied_at,a.time) applied,COALESCE(l.by_name,a.operator,'') by,s.date,s.start,COALESCE(c.name,s.course_id) course FROM attendance a JOIN sessions s ON s.id=a.session_id JOIN students st ON st.id=a.student_id LEFT JOIN leaves l ON l.student_id=a.student_id AND l.session_id=a.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE a.status='請假' AND s.date>=? GROUP BY a.id ORDER BY s.date,s.start LIMIT 300", addDays(today(), -30));
    },

    /* ---------- 後台：僅管理員 ---------- */
    'a.student'(b) {
      const s = student(b.id);
      if (!s) throw new Error('找不到學生');
      return { info: { id: s.id, name: s.name, birthday: s.birthday, phone: s.phone, code: s.bind_code, status: s.status, note: s.note }, remain: totalRemain(s.id),
        courses: all('SELECT course_id FROM enrollments WHERE student_id=?', s.id).map(r => r.course_id),
        parents: all('SELECT user_id userId,line_name name,relation,created_at at FROM bindings WHERE student_id=?', s.id).map(p => ({ ...p, kids: all('SELECT st.name FROM bindings b JOIN students st ON st.id=b.student_id WHERE b.user_id=? AND b.student_id<>?', p.userId, s.id).map(r => r.name) })),
        cards: all('SELECT c.* FROM cards c JOIN card_students cs ON cs.card_id=c.id WHERE cs.student_id=? ORDER BY c.bought DESC, c.id DESC', s.id).map(c => ({ ...c, students: all('SELECT s.id,s.name FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=?', c.id), usage: cardUsage(c.id) })),
        family: siblingsOf(s.id).map(x => ({ id: x.id, name: x.name, remain: totalRemain(x.id), bound: get('SELECT COUNT(*) n FROM bindings WHERE student_id=?', x.id).n })),
        topups: all('SELECT * FROM topups WHERE student_id=? ORDER BY time DESC LIMIT 20', s.id),
        attendance: all("SELECT a.status,a.deduct,a.method,a.time,s.date,s.start,COALESCE(c.name,s.course_id) course FROM attendance a JOIN sessions s ON s.id=a.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE a.student_id=? AND a.status<>'取消' ORDER BY s.date DESC, s.start DESC LIMIT 30", s.id) };
    },
    'a.studentSave'(b) {
      const name = str(b.name, 40);
      if (!name) throw new Error('請輸入姓名');
      let id = b.id;
      if (id) {
        if (!student(id)) throw new Error('找不到學生');
        run('UPDATE students SET name=?, birthday=?, phone=?, status=?, note=? WHERE id=?', name, nd(b.birthday), str(b.phone, 30), ['在學', '停用'].includes(b.status) ? b.status : '在學', str(b.note), id);
        if (b.regenCode) run('UPDATE students SET bind_code=? WHERE id=?', newBindCode(), id);
      } else {
        id = nextId('students', 'S', 4);
        run('INSERT INTO students(id,name,birthday,phone,bind_code,status,note,created_at) VALUES(?,?,?,?,?,?,?,?)', id, name, nd(b.birthday), str(b.phone, 30), newBindCode(), '在學', str(b.note), now());
      }
      if (Array.isArray(b.courses)) API['a.enroll']({ studentId: id, courseIds: b.courses });
      if (b.familyWith && student(b.familyWith)) linkFamily([id, b.familyWith]);
      return { id, code: student(id).bind_code };
    },
    /** 批次新增：b.rows = [{name, birthday, phone}] */
    'a.studentImport'(b) {
      const out = (b.rows || []).filter(r => str(r.name)).slice(0, 500).map(r => API['a.studentSave']({ name: r.name, birthday: r.birthday, phone: r.phone, courses: b.courseId ? [b.courseId] : undefined }));
      return { added: out.length };
    },
    'a.enroll'(b) {
      if (!student(b.studentId)) throw new Error('找不到學生');
      const ids = (b.courseIds || []).filter(id => get('SELECT 1 x FROM courses WHERE id=?', id));
      run('DELETE FROM enrollments WHERE student_id=?', b.studentId);
      ids.forEach(id => run('INSERT INTO enrollments VALUES(?,?,?)', b.studentId, id, today()));
      return { courses: ids };
    },
    /** 設定兄弟姊妹：memberIds 為同一家庭的其他學生（空陣列＝移出家庭） */
    'a.familySave'(b) {
      const me = student(b.studentId);
      if (!me) throw new Error('找不到學生');
      const want = [...new Set((b.memberIds || []).filter(id => id !== me.id && student(id)))];
      const old = me.family ? all('SELECT id FROM students WHERE family=? AND id<>?', me.family, me.id).map(r => r.id) : [];
      if (!want.length) run("UPDATE students SET family='' WHERE id=?", me.id); // 只把自己移出，其他兄弟姊妹維持
      else { old.filter(id => !want.includes(id)).forEach(id => run("UPDATE students SET family='' WHERE id=?", id)); linkFamily([me.id, ...want]); }
      const left = me.family ? all('SELECT id FROM students WHERE family=?', me.family) : [];
      if (left.length === 1) run("UPDATE students SET family='' WHERE id=?", left[0].id);
      let bound = 0; // 已綁定其中一位的家長，其他兄弟姊妹一起補綁
      if (b.syncParents && want.length) { const ids = [me.id, ...want];
        all(`SELECT DISTINCT user_id,line_name,relation FROM bindings WHERE student_id IN (${ids.map(() => '?').join(',')})`, ...ids).forEach(p => ids.forEach(id => { bound += Number(run('INSERT OR IGNORE INTO bindings(user_id,line_name,student_id,relation,created_at) VALUES(?,?,?,?,?)', p.user_id, p.line_name, id, p.relation, now()).changes); })); }
      return { family: siblingsOf(me.id).map(x => x.id), bound };
    },
    'a.unbind'(b) { return { removed: Number(run('DELETE FROM bindings WHERE user_id=? AND student_id=?', b.userId, b.studentId).changes) }; },
    'a.topup'(b, user) {
      const stu = student(b.studentId);
      if (!stu) throw new Error('找不到學生');
      const plan = get('SELECT * FROM plans WHERE id=?', b.planId);
      if (!plan) throw new Error('找不到方案');
      const lessons = Number(b.lessons) > 0 ? Math.floor(Number(b.lessons)) : plan.lessons;
      const price = b.price !== undefined && b.price !== '' ? Math.floor(Number(b.price)) || 0 : plan.price;
      const owners = [b.studentId];
      (b.shareIds || []).forEach(id => { if (owners.includes(id)) return; if (!student(id)) throw new Error('找不到共用學生：' + id); owners.push(id); });
      const t = today(), expire = nd(b.expire) || (plan.valid_days > 0 ? addDays(t, plan.valid_days) : ''), cardId = uid('K');
      run('INSERT INTO cards(id,plan_name,total,remain,bought,expire,status) VALUES(?,?,?,?,?,?,?)', cardId, plan.name, lessons, lessons, t, expire, '啟用');
      owners.forEach(id => run('INSERT INTO card_students VALUES(?,?)', cardId, id));
      linkFamily(owners);
      run('INSERT INTO topups(id,time,student_id,plan_name,lessons,amount,pay,operator,card_id,note) VALUES(?,?,?,?,?,?,?,?,?,?)', uid('T'), now(), b.studentId, plan.name, lessons, price, str(b.pay, 20) || '現金', user.admin.name || user.name, cardId, str(b.note));
      const remain = totalRemain(b.studentId);
      if (cfgOn('儲值推播')) {
        const who = owners.map(id => student(id).name).join('、');
        pushMsg(owners.flatMap(parentsOf), flexMsg('🎫 儲值成功｜' + who + ' 目前剩餘 ' + remain + ' 堂', [flexBubble({
          color: C.OK, title: '儲值成功', name: who + (owners.length > 1 ? '（共用）' : ''), rows: [['方案', plan.name], ['堂數', lessons + ' 堂'], ['金額', price + ' 元'], ['到期日', expire]],
          big: { label: '目前剩餘', value: remain, unit: '堂' }, btn: ['查看上課卡', 'card'] })]));
      }
      return { remain, expire, shared: owners.length - 1 };
    },
    'a.cardSave'(b) {
      const c = get('SELECT * FROM cards WHERE id=?', b.id);
      if (!c) throw new Error('找不到上課卡');
      const remain = Math.max(0, Math.floor(Number(b.remain)));
      if (isNaN(remain)) throw new Error('堂數不正確');
      const status = ['啟用', '停用'].includes(b.status) ? b.status : (remain <= 0 ? '用完' : '啟用');
      run('UPDATE cards SET remain=?, expire=?, status=? WHERE id=?', remain, nd(b.expire), status, b.id);
      if (Array.isArray(b.studentIds) && b.studentIds.length) {
        const ids = b.studentIds.filter(student);
        if (!ids.length) throw new Error('至少要有一位學生');
        run('DELETE FROM card_students WHERE card_id=?', b.id);
        ids.forEach(id => run('INSERT OR IGNORE INTO card_students VALUES(?,?)', b.id, id));
        linkFamily(ids);
      }
      return { ok: true };
    },
    'a.courseSave'(b) {
      const name = str(b.name, 60), start = nt(b.start), end = nt(b.end);
      if (!name) throw new Error('請輸入課程名稱');
      if (!start || !end || end <= start) throw new Error('上課時間不正確');
      const weekdays = [...new Set((b.weekdays || []).map(Number).filter(n => n >= 0 && n <= 6))].sort().join('');
      const oneoff = b.id && (get('SELECT weekdays w FROM courses WHERE id=?', b.id) || {}).w === '';
      if (!weekdays && !oneoff) throw new Error('請至少選一天上課日');
      const id = b.id || nextId('courses', 'C', 2);
      const vals = [name, str(b.teacher, 40), weekdays, start, end, str(b.room, 40), Math.max(1, Math.floor(Number(b.deduct)) || 1), Math.max(0, Math.floor(Number(b.capacity)) || 0), COLORS.includes(b.color) ? b.color : COLORS[0], b.status === '停用' ? '停用' : '啟用'];
      if (b.id) { if (!get('SELECT 1 x FROM courses WHERE id=?', id)) throw new Error('找不到課程'); run('UPDATE courses SET name=?,teacher=?,weekdays=?,start=?,end=?,room=?,deduct=?,capacity=?,color=?,status=? WHERE id=?', ...vals, id); }
      else run('INSERT INTO courses(name,teacher,weekdays,start,end,room,deduct,capacity,color,status,id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...vals, id);
      if (b.dateFrom !== undefined || b.dateTo !== undefined) {
        const df = nd(b.dateFrom), dt = nd(b.dateTo);
        if (df && dt && dt < df) throw new Error('結束日期不能早於開始日期');
        if (dt && dt > addDays(df || today(), 731)) throw new Error('開課期間最長兩年');
        if (df && df < addDays(today(), -731)) throw new Error('開課日期最多往前兩年');
        run('UPDATE courses SET date_from=?, date_to=? WHERE id=?', df, dt, id);
      }
      if (b.intro !== undefined) run('UPDATE courses SET intro=? WHERE id=?', str(b.intro, 2000), id);
      const c = get('SELECT * FROM courses WHERE id=?', id);
      syncCourseSessions(c);
      const added = generateSessions();
      let copied = 0;
      if (!b.id && b.copyStudentsFrom) all("SELECT e.student_id sid FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.course_id=? AND st.status='在學'", str(b.copyStudentsFrom, 20)).forEach(r => { run('INSERT INTO enrollments VALUES(?,?,?)', r.sid, id, today()); copied++; });
      if (c.status === '啟用' && !b.force) { const cf = all("SELECT * FROM sessions WHERE course_id=? AND date>=? AND status<>'停課' ORDER BY date LIMIT 400", id, today()).flatMap(conflictsOf); if (cf.length) throw conflictError(cf); }
      return { id, added, copied, upcoming: get("SELECT COUNT(*) n FROM sessions WHERE course_id=? AND date>=? AND status<>'停課'", id, today()).n,
        past: get("SELECT COUNT(*) n FROM sessions WHERE course_id=? AND date<? AND status<>'停課'", id, today()).n };
    },
    /** 單一場次：新增加課（manual）、調整時間／代課老師／教室、停課或恢復 */
    /** 刪除課程：沒有任何出席紀錄才能刪（有紀錄請改「停開」） */
    'a.courseDelete'(b) {
      if (!get('SELECT 1 x FROM courses WHERE id=?', b.id)) throw new Error('找不到課程');
      if (get("SELECT 1 x FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE s.course_id=? AND a.status IN ('出席','缺席')", b.id)) throw new Error('這門課已有出席紀錄，不能刪除，請改成「停開」');
      all('SELECT id FROM sessions WHERE course_id=?', b.id).forEach(x => { run('DELETE FROM attendance WHERE session_id=?', x.id); run('DELETE FROM leaves WHERE session_id=?', x.id); run('DELETE FROM makeups WHERE session_id=? OR from_session_id=?', x.id, x.id); });
      const n = Number(run('DELETE FROM sessions WHERE course_id=?', b.id).changes);
      run('DELETE FROM enrollments WHERE course_id=?', b.id); run('DELETE FROM session_skips WHERE id LIKE ?', b.id + '-%'); run('DELETE FROM courses WHERE id=?', b.id);
      return { deleted: true, sessions: n };
    },
    'a.sessionSave'(b) {
      const date = nd(b.date), start = nt(b.start), end = nt(b.end);
      if (!date || !start || !end || end <= start) throw new Error('日期或時間不正確');
      const status = ['正常', '停課', '已結算'].includes(b.status) ? b.status : '正常';
      const old = b.id ? sessRow(b.id) : null;
      let id = b.id;
      if (b.id) {
        if (!old) throw new Error('找不到場次');
        run('UPDATE sessions SET date=?,start=?,end=?,teacher=?,room=?,status=?,note=?,manual=1 WHERE id=?', date, start, end, str(b.teacher, 40), str(b.room, 40), status, str(b.note), b.id);
      } else {
        if (b.newCourse) { // 單次課程：只在這一天上，不會每週重複
          const name = str(b.newCourse.name, 60);
          if (!name) throw new Error('請輸入課程名稱');
          b.courseId = nextId('courses', 'C', 2);
          run("INSERT INTO courses(id,name,teacher,weekdays,start,end,room,deduct,capacity,color,status,date_from,date_to) VALUES(?,?,?,'',?,?,?,?,0,?,'啟用',?,?)", b.courseId, name, str(b.newCourse.teacher, 40), start, end, str(b.newCourse.room, 40),
            Math.max(0, Math.floor(Number(b.newCourse.deduct ?? 1)) || 0) || 1, COLORS.includes(b.newCourse.color) ? b.newCourse.color : COLORS[0], date, date);
          (b.newCourse.studentIds || []).filter(student).forEach(sid => run('INSERT INTO enrollments VALUES(?,?,?)', sid, b.courseId, today()));
          b.teacher = ''; b.room = '';
        }
        if (!get('SELECT 1 x FROM courses WHERE id=?', b.courseId)) throw new Error('請選擇課程');
        id = uid('X');
        run('INSERT INTO sessions(id,course_id,date,start,end,teacher,room,status,note,manual) VALUES(?,?,?,?,?,?,?,?,?,1)', id, b.courseId, date, start, end, str(b.teacher, 40), str(b.room, 40), status, str(b.note));
      }
      const cur = sessRow(id);
      if (status !== '停課' && !b.force) { const cf = conflictsOf(cur); if (cf.length) throw conflictError(cf); }
      const stopped = status === '停課' && (!old || old.status !== '停課');
      const postponed = stopped && b.postpone ? extendTerm(cur.course_id) : '';
      const kind = !old ? '加課' : stopped ? '停課' : old.status === '停課' && status !== '停課' ? '復課'
        : old.date !== date || old.start !== start || old.end !== end || old.teacher !== cur.teacher || old.room !== cur.room ? '調課' : (old.note || '') !== cur.note && cur.note ? '備註' : '';
      const notified = b.notify && kind ? notifySession(kind, old, { ...cur, postponed }) : 0;
      return { id, kind, notified, postponed };
    },
    /** 老師備註（老師也能寫），可順便通知家長 */
    'a.sessionNote'(b) {
      const old = sessRow(b.id);
      if (!old) throw new Error('找不到場次');
      run('UPDATE sessions SET note=? WHERE id=?', str(b.note, 300), b.id);
      const cur = sessRow(b.id);
      return { ok: true, notified: b.notify && cur.note ? notifySession('備註', old, cur) : 0 };
    },
    /** 整天停課（颱風假、國定假日）：當天還沒點名的課全部停課 */
    'a.dayOff'(b) {
      const date = nd(b.date);
      if (!date) throw new Error('日期不正確');
      const list = all("SELECT s.* FROM sessions s WHERE s.date=? AND s.status='正常' AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.session_id=s.id AND a.status IN ('出席','缺席'))", date);
      let notified = 0; const postponed = [];
      list.forEach(x => { const r = API['a.sessionSave']({ id: x.id, date: x.date, start: x.start, end: x.end, teacher: x.teacher, room: x.room, status: '停課', note: str(b.reason) || x.note, postpone: !!b.postpone, notify: !!b.notify, force: true }); notified += r.notified; if (r.postponed) postponed.push(r.postponed); });
      return { stopped: list.length, notified, postponed: postponed.length };
    },
    /** 補課：可安排的場次 */
    'a.makeupOptions'(b) {
      if (!student(b.studentId)) throw new Error('找不到學生');
      const mine = all('SELECT course_id FROM enrollments WHERE student_id=?', b.studentId).map(r => r.course_id);
      return all("SELECT * FROM sessions WHERE date>=? AND date<=? AND status='正常' ORDER BY date,start LIMIT 300", today(), addDays(today(), 60))
        .filter(x => x.id !== b.fromSessionId && !activeRecord(x.id, b.studentId) && !get('SELECT 1 x FROM makeups WHERE student_id=? AND session_id=?', b.studentId, x.id))
        .map(x => { const i = sessionInfo(x); return { sessionId: x.id, date: x.date, start: x.start, end: x.end, course: i.course, teacher: i.teacher, own: mine.includes(x.course_id) }; });
    },
    'a.makeupSave'(b, user) {
      const stu = student(b.studentId), sess = sessRow(b.sessionId);
      if (!stu || !sess) throw new Error('找不到學生或場次');
      if (sess.status !== '正常') throw new Error('這堂課已' + sess.status);
      if (get('SELECT 1 x FROM makeups WHERE student_id=? AND session_id=?', stu.id, sess.id)) throw new Error('已經安排過這堂補課');
      if (b.fromSessionId) run('DELETE FROM makeups WHERE student_id=? AND from_session_id=?', stu.id, b.fromSessionId);
      run('INSERT INTO makeups(id,student_id,session_id,from_session_id,created_at,by_name) VALUES(?,?,?,?,?,?)', uid('M'), stu.id, sess.id, str(b.fromSessionId, 40), now(), user.admin.name || user.name);
      const i = sessionInfo(sess), from = b.fromSessionId ? sessRow(b.fromSessionId) : null, to = parentsOf(stu.id);
      if (b.notify) pushMsg(to, flexMsg('📌 補課通知｜' + stu.name + ' ' + whenOf(i) + ' ' + i.course, [flexBubble({ color: C.INFO, title: '補課通知', name: stu.name,
        rows: [['補課時間', whenOf(i)], ['課程', i.course], ['老師', i.teacher], ['教室', i.room], ['原請假', from ? whenOf(from) + ' ' + sessionInfo(from).course : '']], note: i.note ? '老師備註：' + i.note : '', noteColor: C.INK, btn: ['查看課表', 'schedule'] })]));
      return { ok: true, notified: b.notify ? to.length : 0 };
    },
    'a.makeupDelete'(b) { return { removed: Number(run('DELETE FROM makeups WHERE student_id=? AND session_id=?', b.studentId, b.sessionId).changes) }; },
    'a.sessionDelete'(b) {
      const x = sessRow(b.id);
      if (!x) throw new Error('找不到場次');
      if (get("SELECT 1 x FROM attendance WHERE session_id=? AND status<>'取消' AND status<>'請假'", b.id)) throw new Error('這堂課已有出席紀錄，不能刪除。若是不上課請改用「停課」');
      const notified = b.notify && x.status !== '停課' ? notifySession('停課', x, { ...x, status: '停課', note: str(b.reason) || '這堂課已取消' }) : 0;
      run("UPDATE attendance SET status='取消' WHERE session_id=?", b.id); run('DELETE FROM leaves WHERE session_id=?', b.id); run('DELETE FROM makeups WHERE session_id=? OR from_session_id=?', b.id, b.id);
      run('DELETE FROM sessions WHERE id=?', b.id);
      if (!String(x.id).startsWith('X')) run('INSERT OR IGNORE INTO session_skips VALUES(?)', x.id); // 固定排課的場次：記下來，避免自動排回來
      const c = get('SELECT * FROM courses WHERE id=?', x.course_id); // 單次課程刪掉最後一堂，課程一起移除
      if (c && c.weekdays === '' && !get('SELECT 1 x FROM sessions WHERE course_id=?', c.id)) { run('DELETE FROM courses WHERE id=?', c.id); run('DELETE FROM enrollments WHERE course_id=?', c.id); }
      return { deleted: true, notified };
    },
    'a.genSessions'() { return { added: generateSessions() }; },
    /** 帳務：某月的儲值明細與統計 */
    'a.ledger'(b) {
      const month = /^\d{4}-\d{2}$/.test(b.month || '') ? b.month : today().slice(0, 7);
      const rows = all("SELECT t.*, s.name student, c.remain card_remain, c.total card_total, c.status card_status, c.expire card_expire, (SELECT GROUP_CONCAT(s2.name,'、') FROM card_students cs JOIN students s2 ON s2.id=cs.student_id WHERE cs.card_id=t.card_id) names FROM topups t LEFT JOIN students s ON s.id=t.student_id LEFT JOIN cards c ON c.id=t.card_id WHERE substr(t.time,1,7)=? ORDER BY t.time DESC", month);
      const byPay = {};
      rows.forEach(r => { byPay[r.pay || '其他'] = (byPay[r.pay || '其他'] || 0) + r.amount; });
      return { month, rows, total: rows.reduce((n, r) => n + r.amount, 0), lessons: rows.reduce((n, r) => n + r.lessons, 0), byPay,
        months: [...new Set([today().slice(0, 7), ...all('SELECT DISTINCT substr(time,1,7) m FROM topups ORDER BY m DESC LIMIT 36').map(r => r.m)])].sort().reverse() };
    },
    /** 更正或作廢一筆儲值（作廢會同時停用那張上課卡） */
    'a.topupSave'(b) {
      const t = get('SELECT * FROM topups WHERE id=?', b.id);
      if (!t) throw new Error('找不到這筆儲值');
      if (b.void) {
        run("UPDATE cards SET status='停用' WHERE id=?", t.card_id);
        run('DELETE FROM topups WHERE id=?', b.id);
        return { voided: true };
      }
      const amount = Math.floor(Number(b.amount));
      if (!(amount >= 0)) throw new Error('金額不正確');
      run('UPDATE topups SET amount=?, pay=?, note=? WHERE id=?', amount, str(b.pay, 20) || t.pay, str(b.note), b.id);
      return { ok: true };
    },
    'a.cards'() {
      return all("SELECT c.*, (SELECT GROUP_CONCAT(s.name,'、') FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=c.id) names FROM cards c ORDER BY (c.status='啟用') DESC, c.bought DESC, c.id DESC LIMIT 300");
    },
    'a.videos'() { return all('SELECT * FROM videos ORDER BY date DESC, id DESC').map(v => ({ ...v, yt: ytId(v.url) })); },
    /** 貼上連結時自動帶出 YouTube 標題（抓不到就回空字串） */
    async 'a.videoInfo'(b) {
      const url = str(b.url, 500), yt = ytId(url);
      if (!yt) return { yt: '', title: '' };
      let title = '';
      try { const r = await lineFetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + yt)); if (r.ok) title = str((await r.json()).title, 80); } catch { /* 私人影片或連不上 */ }
      return { yt, title };
    },
    'a.videoSave'(b) {
      let url = str(b.url, 500); const title = str(b.title, 80);
      if (url && !/^https?:\/\//i.test(url) && /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url)) url = 'https://' + url;
      if (!/^https?:\/\//.test(url)) throw new Error('請貼上正確的影片連結');
      if (!title) throw new Error('請輸入標題');
      const sid = str(b.studentId, 20), cid = sid ? '' : str(b.courseId, 20);
      if (sid && !student(sid)) throw new Error('找不到學生');
      if (cid && !get('SELECT 1 x FROM courses WHERE id=?', cid)) throw new Error('找不到課程');
      const v = [title, cid, sid, nd(b.date) || today(), url, b.status === '停用' ? '停用' : '啟用'];
      if (b.id) run('UPDATE videos SET title=?,course_id=?,student_id=?,date=?,url=?,status=? WHERE id=?', ...v, b.id);
      else run('INSERT INTO videos(title,course_id,student_id,date,url,status,id) VALUES(?,?,?,?,?,?,?)', ...v, uid('V'));
      let notified = 0;
      if (b.notify && v[5] === '啟用') {
        const to = [...new Set(sid ? parentsOf(sid) : cid ? all("SELECT b.user_id FROM bindings b JOIN enrollments e ON e.student_id=b.student_id JOIN students s ON s.id=b.student_id WHERE e.course_id=? AND s.status<>'停用'", cid).map(r => r.user_id) : all("SELECT b.user_id FROM bindings b JOIN students s ON s.id=b.student_id WHERE s.status<>'停用'").map(r => r.user_id))];
        notified = to.length;
        pushMsg(to, flexMsg('🎬 新影片｜' + title, [videoBubble({ title, url, date: v[3], who: sid ? student(sid).name : cid ? get('SELECT name FROM courses WHERE id=?', cid).name : '' })]));
      }
      return { ok: true, notified };
    },
    'a.videoDelete'(b) { run('DELETE FROM videos WHERE id=?', b.id); return { ok: true }; },
    'a.plans'() { return all('SELECT * FROM plans ORDER BY sort,id'); },
    'a.planSave'(b) {
      const name = str(b.name, 40), lessons = Math.floor(Number(b.lessons));
      if (!name || !(lessons > 0)) throw new Error('請輸入方案名稱與堂數');
      const v = [name, lessons, Math.max(0, Math.floor(Number(b.price)) || 0), Math.max(0, Math.floor(Number(b.validDays)) || 0), b.active === false || b.active === 0 ? 0 : 1];
      if (b.id) run('UPDATE plans SET name=?,lessons=?,price=?,valid_days=?,active=? WHERE id=?', ...v, b.id);
      else run('INSERT INTO plans(name,lessons,price,valid_days,active,id,sort) VALUES(?,?,?,?,?,?,99)', ...v, nextId('plans', 'P', 2));
      return { ok: true };
    },
    'a.settings'() { return all('SELECT key,value,note,kind FROM settings ORDER BY sort'); },
    'a.settingSave'(b) {
      const s = get('SELECT * FROM settings WHERE key=?', b.key);
      if (!s) throw new Error('沒有這個設定');
      let v = str(b.value, 100);
      if (s.kind === 'bool') v = v === '是' ? '是' : '否';
      if (s.kind === 'num') { if (!/^\d+$/.test(v)) throw new Error('請輸入數字'); }
      if (s.kind === 'text' && !v) throw new Error('不可空白');
      run('UPDATE settings SET value=? WHERE key=?', v, b.key);
      return { value: v };
    },
    'a.admins'() { return all('SELECT user_id userId,name,role,active,created_at at FROM admins ORDER BY active DESC, role, name'); },
    'a.adminSave'(b, user) {
      const id = str(b.userId, 40);
      if (!/^U[0-9a-f]{32}$/.test(id)) throw new Error('LINE user ID 格式不正確');
      const role = b.role === 'owner' ? 'owner' : 'teacher', active = b.active ? 1 : 0;
      if (id === user.userId && (role !== 'owner' || !active)) throw new Error('不能取消自己的管理員權限');
      if (b.remove) { if (id === user.userId) throw new Error('不能移除自己'); run('DELETE FROM admins WHERE user_id=?', id); return { ok: true }; }
      run('INSERT INTO admins(user_id,name,role,active,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, role=excluded.role, active=excluded.active', id, str(b.name, 40), role, active, now());
      return { ok: true };
    },
    'a.export'(b) {
      const T = { students: 'SELECT * FROM students', attendance: 'SELECT a.*,s.date,s.start,s.course_id FROM attendance a LEFT JOIN sessions s ON s.id=a.session_id', topups: 'SELECT * FROM topups', cards: "SELECT c.*,(SELECT GROUP_CONCAT(student_id) FROM card_students WHERE card_id=c.id) students FROM cards c", sessions: 'SELECT * FROM sessions', leaves: 'SELECT * FROM leaves', courses: 'SELECT * FROM courses', bindings: 'SELECT * FROM bindings' };
      if (!T[b.table]) throw new Error('沒有這個資料表');
      const rows = all(T[b.table]);
      const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const cols = rows.length ? Object.keys(rows[0]) : [];
      return { name: b.table + '-' + today() + '.csv', csv: '﻿' + [cols.join(',')].concat(rows.map(r => cols.map(k => esc(r[k])).join(','))).join('\n') };
    },
    async 'a.richmenu'() {
      if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LIFF_ID) throw new Error('伺服器尚未設定 LINE token 或 LIFF ID');
      const W = 2500, H = 1686, cw = 625, ch = 843;
      const cells = [['checkin', '線上報到'], ['card', '上課卡'], ['schedule', '課表'], ['leave', '請假'], ['attendance', '出席紀錄'], ['video', '影片'], ['rent', '教室租借'], ['bind', '綁定學生']];
      const areas = cells.map((c, i) => ({ bounds: { x: (i % 4) * cw, y: Math.floor(i / 4) * ch, width: cw, height: ch }, action: { type: 'uri', label: c[1], uri: liffUrl(c[0]) } }));
      const img = fs.readFileSync(path.join(opts.publicDir || './public', 'richmenu.jpg'));
      const r1 = await lineFetch('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHdr() }, body: JSON.stringify({ size: { width: W, height: H }, selected: true, name: cfg('教室名稱', '舞蹈教室'), chatBarText: '功能選單', areas }) });
      if (!r1.ok) throw new Error('建立圖文選單失敗：' + await r1.text());
      const id = (await r1.json()).richMenuId;
      const r2 = await lineFetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...authHdr() }, body: img });
      if (!r2.ok) throw new Error('上傳圖片失敗：' + await r2.text());
      const r3 = await lineFetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, { method: 'POST', headers: authHdr() });
      if (!r3.ok) throw new Error('設為預設選單失敗：' + await r3.text());
      const old = get("SELECT value FROM meta WHERE key='richmenu_id'");
      if (old && old.value !== id) await lineFetch('https://api.line.me/v2/bot/richmenu/' + old.value, { method: 'DELETE', headers: authHdr() });
      run("INSERT INTO meta VALUES('richmenu_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", id);
      return { id };
    }
  };

  /** 後台尚未開通時：第一位用安裝碼成為管理員；其他人送出申請，等管理員啟用 */
  function adminGate(b, user) {
    const hasOwner = !!get("SELECT 1 x FROM admins WHERE role='owner' AND active=1");
    if (b.action === 'a.claim') {
      if (hasOwner) throw new Error('已有管理員，請由管理員在後台為您開通');
      if (!env.SETUP_CODE || str(b.code, 64) !== env.SETUP_CODE) throw new Error('安裝碼不正確');
      run("INSERT INTO admins(user_id,name,role,active,created_at) VALUES(?,?,'owner',1,?) ON CONFLICT(user_id) DO UPDATE SET role='owner', active=1", user.userId, user.name, now());
      return { ok: true };
    }
    if (b.action === 'a.apply') {
      run("INSERT OR IGNORE INTO admins(user_id,name,role,active,created_at) VALUES(?,?,'teacher',0,?)", user.userId, user.name, now());
      return { ok: true };
    }
    if (b.action === 'a.status') {
      const me = get('SELECT * FROM admins WHERE user_id=?', user.userId);
      return { isAdmin: !!(me && me.active), applied: !!me, hasOwner, userId: user.userId, name: user.name, studio: cfg('教室名稱', '舞蹈教室') };
    }
    return undefined;
  }

  async function api(b) {
    b = b || {};
    try {
      if (b.action === 'login') { const u = await verifyIdToken(b.idToken); return { ok: true, data: { token: sign({ u: u.userId, n: u.name, exp: Date.now() + 30 * 86400e3 }) } }; }
      if (b.action === 'devLogin' && env.DEV_LOGIN === '1') return { ok: true, data: { token: sign({ u: str(b.userId, 40), n: str(b.name, 40), exp: Date.now() + 86400e3 }) } };
      const user = unsign(b.token);
      if (!user) throw new Error('AUTH');
      const gate = ['a.claim', 'a.apply', 'a.status'].includes(b.action);
      const fn = API[b.action];
      if (!fn && !gate) throw new Error('未知的操作');
      if (!gate && String(b.action).startsWith('a.')) {
        user.admin = adminOf(user.userId);
        if (!user.admin) throw new Error('沒有後台權限');
        if (user.admin.role !== 'owner' && (OWNER_ONLY.has(b.action) || b.action === 'a.studentImport')) throw new Error('此功能僅限管理員');
      }
      if (ASYNC.has(b.action)) return { ok: true, data: await fn(b, user) };
      let data;
      db.exec('BEGIN IMMEDIATE');
      try { data = gate ? adminGate(b, user) : fn(b, user); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); outbox = []; throw e; }
      flush();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /* ---------- LINE Webhook ---------- */
  function menuFlex(title) {
    const items = [['線上報到', 'checkin'], ['上課卡', 'card'], ['出席紀錄', 'attendance'], ['課表', 'schedule'], ['請假', 'leave'], ['影片', 'video'], ['教室租借', 'rent'], ['綁定學生', 'bind']];
    return { type: 'flex', altText: cfg('教室名稱', '舞蹈教室') + ' 功能選單', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: cfg('教室名稱', '舞蹈教室'), weight: 'bold', size: 'lg' },
      { type: 'text', text: title || '請選擇功能', size: 'sm', color: '#888888', wrap: true },
      ...items.map(m => ({ type: 'button', style: m[1] === 'checkin' ? 'primary' : 'secondary', color: m[1] === 'checkin' ? C.BRAND : undefined, height: 'sm', action: { type: 'uri', label: m[0], uri: liffUrl(m[1]) } }))] } } };
  }
  const askSeen = new Map(); // 諮詢的「已收到」回覆：同一人 10 分鐘內只回一次
  async function webhook(rawBody, signature) {
    const secret = env.LINE_CHANNEL_SECRET || '';
    const expect = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    if (!secret || !signature || signature.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expect))) return false;
    let events = [];
    try { events = JSON.parse(rawBody).events || []; } catch { return true; }
    for (const ev of events) {
      try {
        const reply = messages => lineMsg('reply', { replyToken: ev.replyToken, messages });
        if (ev.type === 'follow') { await reply([menuFlex('歡迎加入！請先點「綁定學生」，輸入教室提供的綁定碼。')]); continue; }
        if (ev.type !== 'message' || ev.message.type !== 'text') continue;
        const t = ev.message.text.trim(), kids = kidsOf(ev.source.userId);
        const isFn = /堂數|上課卡|剩|餘額|請假|課表|上課時間|出席|出缺|紀錄|影片|影音|video|youtube|報到|綁定/i.test(t), wantMenu = /^(選單|功能|功能選單|menu|help|\?|？)$/i.test(t);
        if (/^您好，我想詢問/.test(t)) { // 從課表按「諮詢」帶進來的訊息：回覆已收到，並通知管理員由真人回覆
          const last = askSeen.get(ev.source.userId) || 0; askSeen.set(ev.source.userId, Date.now());
          if (Date.now() - last > 10 * 60e3) await reply([{ type: 'text', text: '已收到您的訊息，老師看到後會盡快回覆您 🙏' }]);
          if (cfgOn('諮詢通知管理員')) { const who = (get('SELECT line_name n FROM bindings WHERE user_id=?', ev.source.userId) || {}).n || '', to = all("SELECT user_id FROM admins WHERE active=1 AND role='owner'").map(r => r.user_id).filter(u => u !== ev.source.userId);
            if (to.length) await lineMsg('multicast', { to, messages: [flexMsg('💬 家長諮詢｜' + t.slice(0, 60), [flexBubble({ color: C.INK, title: '家長諮詢', name: who || (kids.length ? kids.map(k => k.name).join('、') + ' 的家長' : '尚未綁定的訪客'), rows: [['學生', kids.map(k => k.name).join('、')], ['內容', t.slice(0, 300)]], note: '請到 LINE 官方帳號管理後台的聊天室回覆。', noteColor: C.SUB })])] }); }
          continue;
        }
        if (/租借|租教室|場地|借教室/.test(t)) { await reply([flexMsg('教室租借：點「我要租教室」選擇時段', [flexBubble({ color: C.INFO, title: '教室租借', note: cfgOn('開放教室租借') ? '可以線上查看開放時段並預約，送出後我們會盡快確認。' : '目前沒有開放線上租借，請直接留言給我們。', noteColor: C.INK, btn: ['我要租教室', 'rent'] })])]); continue; }
        if (!isFn && !wantMenu) continue; // 一般聊天：不自動回覆，留給真人回（下方已有圖文選單）
        if (!kids.length) { await reply([menuFlex('您尚未綁定學生，請點「綁定學生」並輸入教室提供的綁定碼。')]); continue; }
        if (/請假/.test(t)) {
          await reply([flexMsg('請假：請點「我要請假」選擇課程', kids.map(s => { const rs = all("SELECT s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE l.student_id=? AND l.status<>'取消' AND s.date>=? ORDER BY s.date,s.start LIMIT 5", s.id, today());
            return flexBubble({ color: C.WARN, title: '請假', name: s.name, rows: rs.map(r => [r.date.slice(5), r.start + ' ' + r.course + '｜已請假']), note: rs.length ? '' : '目前沒有已登記的請假。要請假請點下方按鈕，選擇課程即可。', noteColor: C.SUB, btn: ['我要請假', 'leave'] }); }))]);
          continue;
        }
        if (/課表|上課時間|課程|幾點/.test(t)) {
          const end = addDays(today(), 14);
          await reply([flexMsg('近期課表', kids.map(s => { const mine = all('SELECT course_id FROM enrollments WHERE student_id=?', s.id).map(r => r.course_id);
            const rs = all("SELECT s.*,COALESCE(c.name,s.course_id) course FROM sessions s LEFT JOIN courses c ON c.id=s.course_id WHERE s.date>=? AND s.date<=? AND s.status<>'已結算' ORDER BY s.date,s.start", today(), end).filter(x => !mine.length || mine.includes(x.course_id)).slice(0, 8);
            return flexBubble({ color: C.INFO, title: '近期課表', name: s.name, rows: rs.map(r => [r.date.slice(5) + '（' + '日一二三四五六'[new Date(r.date + 'T00:00:00Z').getUTCDay()] + '）', r.start + ' ' + r.course + (r.status === '停課' ? '｜停課' : '')]), note: rs.length ? '' : '未來兩週沒有課程', noteColor: C.SUB, btn: ['查看完整課表', 'schedule'] }); }))]);
          continue;
        }
        if (/堂數|上課卡|剩|餘額/.test(t)) {
          await reply([flexMsg(kids.map(s => s.name + ' 剩餘 ' + totalRemain(s.id) + ' 堂').join('、'), kids.map(s => { const remain = totalRemain(s.id); return flexBubble({
            color: C.BRAND, title: '上課卡', name: s.name, rows: validCards(s.id).map(c => [c.plan_name, c.remain + ' / ' + c.total + ' 堂' + (c.expire ? '｜到期 ' + c.expire : '')]),
            big: { label: '剩餘堂數', value: remain, unit: '堂', color: remain <= cfgNum('低堂數門檻', 2) ? C.WARN : C.BRAND }, note: remain <= 0 ? '目前沒有可用的上課卡' : '', btn: ['查看上課卡', 'card'] }); }))]);
          continue;
        }
        if (/出席|出缺|紀錄/.test(t)) {
          await reply([flexMsg('最近出席紀錄', kids.map(s => { const rs = all("SELECT a.status,s.date,COALESCE(c.name,s.course_id) course FROM attendance a JOIN sessions s ON s.id=a.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE a.student_id=? AND a.status<>'取消' ORDER BY s.date DESC,s.start DESC LIMIT 5", s.id);
            return flexBubble({ color: C.BRAND, title: '最近出席紀錄', name: s.name, rows: rs.map(r => [r.date.slice(5), r.course + '｜' + r.status]), note: rs.length ? '' : '尚無紀錄', btn: ['查看完整紀錄', 'attendance'] }); }))]);
          continue;
        }
        if (/影片|影音|視頻|video|youtube/i.test(t)) {
          const seen = new Set(), list = [];
          kids.forEach(s => videosFor(s.id).forEach(v => { if (!seen.has(v.id)) { seen.add(v.id); list.push({ ...v, who: v.personal ? s.name : '' }); } }));
          list.sort((a, b) => a.date < b.date ? 1 : -1);
          await reply([list.length ? flexMsg('🎬 影片｜' + list.slice(0, 3).map(v => v.title).join('、'), list.slice(0, 10).map(videoBubble))
            : flexMsg('目前沒有影片', [flexBubble({ color: C.BRAND, title: '影片', note: '目前還沒有影片，老師上傳後會通知您。', noteColor: C.SUB })])]);
          continue;
        }
        await reply([menuFlex()]);
      } catch (e) { console.error('webhook', e.message); }
    }
    return true;
  }

  maintenance();
  loadBotInfo();
  return { api, webhook, db, maintenance, qrToken, flush: () => flush(), all, get, run };
}
