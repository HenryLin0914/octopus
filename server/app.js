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
  '請假通知管理員': ['是', '家長線上請假後通知管理員與老師', 'bool']
};
const PLANS = [['P01', '單堂', 1, 500, 30], ['P02', '10堂卡', 10, 4500, 90], ['P03', '20堂卡', 20, 8000, 180]];
const COLORS = ['#D6336C', '#1971C2', '#2B8A3E', '#E67700', '#7048E8', '#0C8599', '#C2255C', '#5C940D'];

const OWNER_ONLY = new Set(['a.studentSave', 'a.enroll', 'a.unbind', 'a.topup', 'a.cardSave', 'a.courseSave', 'a.sessionSave', 'a.sessionDelete', 'a.genSessions',
  'a.videoSave', 'a.videoDelete', 'a.planSave', 'a.settingSave', 'a.adminSave', 'a.richmenu', 'a.export', 'a.student', 'a.videos', 'a.plans', 'a.settings', 'a.admins', 'a.cards']);
const ASYNC = new Set(['a.richmenu']);

export function createApp(opts = {}) {
  const env = opts.env || process.env;
  const dataDir = opts.dataDir || env.DATA_DIR || './data';
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'octopus.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA);
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
  const pushMsg = (userIds, message) => { const to = [...new Set(userIds.filter(Boolean))]; if (to.length) outbox.push({ to, messages: [message] }); };
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
      date: s.date, start: s.start, end: s.end, status: s.status || '正常', note: s.note || '', manual: !!s.manual, deduct: c.deduct || 1, capacity: c.capacity || 0 };
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
  function generateSessions() {
    const weeks = cfgNum('產生場次週數', 8), t = today();
    let n = 0;
    all("SELECT * FROM courses WHERE status='啟用'").forEach(c => {
      const days = courseDays(c);
      for (let i = 0; i < weeks * 7; i++) {
        const d = addDays(t, i);
        if (!days.includes(weekday(d))) continue;
        const r = run('INSERT OR IGNORE INTO sessions(id,course_id,date,start,end,teacher,room,status,manual) VALUES(?,?,?,?,?,?,?,?,0)', c.id + '-' + d.replace(/-/g, ''), c.id, d, c.start, c.end, '', '', '正常');
        n += Number(r.changes);
      }
    });
    return n;
  }
  /** 課程時間或星期變動後：未來、未點名、非手動調整的場次跟著更新 */
  function syncCourseSessions(c) {
    const t = today(), days = courseDays(c);
    all("SELECT s.* FROM sessions s WHERE s.course_id=? AND s.date>=? AND s.manual=0 AND s.status='正常' AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.session_id=s.id AND a.status<>'取消')", c.id, t).forEach(s => {
      if (c.status !== '啟用' || !days.includes(weekday(s.date))) run('DELETE FROM sessions WHERE id=?', s.id);
      else run('UPDATE sessions SET start=?, end=? WHERE id=?', c.start, c.end, s.id);
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
  const studentBrief = s => ({ id: s.id, name: s.name, remain: totalRemain(s.id) });

  /* ============================== API ============================== */
  const API = {
    /* ---------- 家長端 ---------- */
    init(b, user) {
      return { studio: cfg('教室名稱', '舞蹈教室'), userId: user.userId, name: user.name, isAdmin: !!adminOf(user.userId), students: kidsOf(user.userId).map(studentBrief), lowAt: cfgNum('低堂數門檻', 2) };
    },
    bind(b, user) {
      const code = str(b.code, 10);
      if (!code) throw new Error('請輸入綁定碼');
      const stu = get("SELECT * FROM students WHERE bind_code=? AND status<>'停用'", code);
      if (!stu) throw new Error('綁定碼不正確，請向教室確認');
      const r = run('INSERT OR IGNORE INTO bindings(user_id,line_name,student_id,relation,created_at) VALUES(?,?,?,?,?)', user.userId, user.name, stu.id, str(b.relation, 20), now());
      return { name: stu.name, already: Number(r.changes) === 0 };
    },
    card(b, user) {
      assertOwns(user, b.studentId);
      const cards = all('SELECT c.* FROM cards c JOIN card_students cs ON cs.card_id=c.id WHERE cs.student_id=? ORDER BY c.bought DESC, c.id DESC', b.studentId).map(c => ({
        id: c.id, plan: c.plan_name, total: c.total, remain: c.remain, buy: c.bought, expire: c.expire, status: c.status,
        shared: all('SELECT s.name FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=? AND cs.student_id<>?', c.id, b.studentId).map(r => r.name) }));
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
      const t = today(), end = addDays(t, cfgNum('課表顯示天數', 28)), cutoff = cfgNum('請假截止小時', 2) * 3600e3;
      const upcoming = all('SELECT * FROM sessions WHERE date>=? AND date<=? ORDER BY date,start', t, end).filter(s => !mine.length || mine.includes(s.course_id)).map(s => {
        const i = sessionInfo(s), rec = activeRecord(s.id, b.studentId);
        i.my = rec ? rec.status : '';
        i.canLeave = !i.my && i.status === '正常' && toDate(i.date, i.start).getTime() - Date.now() > cutoff;
        return i;
      });
      const wd = '日一二三四五六';
      const courses = all("SELECT * FROM courses WHERE status='啟用' ORDER BY start").map(c => ({ id: c.id, name: c.name, teacher: c.teacher, day: courseDays(c).map(d => wd[d]).join('、'), start: c.start, end: c.end, room: c.room, enrolled: mine.includes(c.id) }));
      return { upcoming, courses, enrolledOnly: mine.length > 0 };
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
    leaves(b, user) {
      assertOwns(user, b.studentId);
      return all('SELECT l.reason,l.status,l.applied_at applied,s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id LEFT JOIN courses c ON c.id=s.course_id WHERE l.student_id=? ORDER BY l.applied_at DESC LIMIT 30', b.studentId);
    },
    videos(b, user) {
      assertOwns(user, b.studentId);
      return all("SELECT v.title,v.date,v.url,COALESCE(c.name,'') course FROM videos v LEFT JOIN courses c ON c.id=v.course_id WHERE v.status='啟用' AND v.url<>'' AND (v.student_id=? OR (v.student_id='' AND (v.course_id='' OR v.course_id IN (SELECT course_id FROM enrollments WHERE student_id=?)))) ORDER BY v.date DESC", b.studentId, b.studentId);
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
        low: lowList,
        expiring: all("SELECT c.id,c.plan_name plan,c.remain,c.expire,(SELECT GROUP_CONCAT(s.name,'、') FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=c.id) names FROM cards c WHERE c.status='啟用' AND c.remain>0 AND c.expire<>'' AND c.expire>=? AND c.expire<=? ORDER BY c.expire LIMIT 12", today(), soon),
        leaves: all('SELECT st.name student,l.reason,s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id JOIN students st ON st.id=l.student_id LEFT JOIN courses c ON c.id=s.course_id WHERE s.date>=? ORDER BY s.date,s.start LIMIT 12', today())
      };
    },
    'a.week'(b) {
      const start = nd(b.start) || today(), end = addDays(start, (Number(b.days) || 7) - 1);
      const sessions = all('SELECT * FROM sessions WHERE date>=? AND date<=? ORDER BY date,start', start, end).map(s => {
        const i = sessionInfo(s);
        const cnt = Object.fromEntries(all("SELECT status, COUNT(*) n FROM attendance WHERE session_id=? AND status<>'取消' GROUP BY status", s.id).map(r => [r.status, r.n]));
        i.present = cnt['出席'] || 0; i.leave = cnt['請假'] || 0; i.absent = cnt['缺席'] || 0;
        i.enrolled = get("SELECT COUNT(*) n FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.course_id=? AND st.status='在學'", s.course_id).n;
        return i;
      });
      return { start, end, sessions };
    },
    'a.roster'(b) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      const ids = all("SELECT e.student_id id FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.course_id=? AND s.status<>'停用' ORDER BY s.name", sess.course_id).map(r => r.id);
      all("SELECT DISTINCT student_id id FROM attendance WHERE session_id=? AND status<>'取消'", b.sessionId).forEach(r => { if (!ids.includes(r.id)) ids.push(r.id); });
      const list = ids.map(id => { const s = student(id), r = activeRecord(b.sessionId, id); return s && { id, name: s.name, status: r ? r.status : '', method: r ? r.method : '', note: r ? r.note : '', remain: totalRemain(id) }; }).filter(Boolean);
      return { info: sessionInfo(sess), list };
    },
    'a.mark'(b, user) {
      const sess = sessRow(b.sessionId);
      if (!sess) throw new Error('找不到場次');
      if (!student(b.studentId)) throw new Error('找不到學生');
      if (!['出席', '請假', '缺席', '取消'].includes(b.status)) throw new Error('狀態不正確');
      return recordAttendance(sess, b.studentId, b.status, '後台', user.admin.name || user.name);
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
        family: all('SELECT DISTINCT student_id id FROM bindings WHERE student_id<>? AND user_id IN (SELECT user_id FROM bindings WHERE student_id=?) UNION SELECT DISTINCT student_id FROM card_students WHERE student_id<>? AND card_id IN (SELECT card_id FROM card_students WHERE student_id=?)', s.id, s.id, s.id, s.id).map(r => r.id) }));
    },
    'a.leaves'() {
      return all('SELECT l.id,st.name student,l.reason,l.status,l.applied_at applied,l.by_name by,s.date,s.start,COALESCE(c.name,s.course_id) course FROM leaves l JOIN sessions s ON s.id=l.session_id JOIN students st ON st.id=l.student_id LEFT JOIN courses c ON c.id=s.course_id WHERE s.date>=? ORDER BY s.date,s.start LIMIT 200', addDays(today(), -30));
    },

    /* ---------- 後台：僅管理員 ---------- */
    'a.student'(b) {
      const s = student(b.id);
      if (!s) throw new Error('找不到學生');
      return { info: { id: s.id, name: s.name, birthday: s.birthday, phone: s.phone, code: s.bind_code, status: s.status, note: s.note }, remain: totalRemain(s.id),
        courses: all('SELECT course_id FROM enrollments WHERE student_id=?', s.id).map(r => r.course_id),
        parents: all('SELECT user_id userId,line_name name,relation,created_at at FROM bindings WHERE student_id=?', s.id),
        cards: all('SELECT c.* FROM cards c JOIN card_students cs ON cs.card_id=c.id WHERE cs.student_id=? ORDER BY c.bought DESC, c.id DESC', s.id).map(c => ({ ...c, students: all('SELECT s.id,s.name FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=?', c.id) })),
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
      }
      return { ok: true };
    },
    'a.courseSave'(b) {
      const name = str(b.name, 60), start = nt(b.start), end = nt(b.end);
      if (!name) throw new Error('請輸入課程名稱');
      if (!start || !end || end <= start) throw new Error('上課時間不正確');
      const weekdays = [...new Set((b.weekdays || []).map(Number).filter(n => n >= 0 && n <= 6))].sort().join('');
      if (!weekdays) throw new Error('請至少選一天上課日');
      const id = b.id || nextId('courses', 'C', 2);
      const vals = [name, str(b.teacher, 40), weekdays, start, end, str(b.room, 40), Math.max(1, Math.floor(Number(b.deduct)) || 1), Math.max(0, Math.floor(Number(b.capacity)) || 0), COLORS.includes(b.color) ? b.color : COLORS[0], b.status === '停用' ? '停用' : '啟用'];
      if (b.id) { if (!get('SELECT 1 x FROM courses WHERE id=?', id)) throw new Error('找不到課程'); run('UPDATE courses SET name=?,teacher=?,weekdays=?,start=?,end=?,room=?,deduct=?,capacity=?,color=?,status=? WHERE id=?', ...vals, id); }
      else run('INSERT INTO courses(name,teacher,weekdays,start,end,room,deduct,capacity,color,status,id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...vals, id);
      syncCourseSessions(get('SELECT * FROM courses WHERE id=?', id));
      return { id, added: generateSessions() };
    },
    /** 單一場次：新增加課（manual）、調整時間／代課老師／教室、停課或恢復 */
    'a.sessionSave'(b) {
      const date = nd(b.date), start = nt(b.start), end = nt(b.end);
      if (!date || !start || !end || end <= start) throw new Error('日期或時間不正確');
      const status = ['正常', '停課', '已結算'].includes(b.status) ? b.status : '正常';
      if (b.id) {
        if (!sessRow(b.id)) throw new Error('找不到場次');
        run('UPDATE sessions SET date=?,start=?,end=?,teacher=?,room=?,status=?,note=?,manual=1 WHERE id=?', date, start, end, str(b.teacher, 40), str(b.room, 40), status, str(b.note), b.id);
        return { id: b.id };
      }
      if (!get('SELECT 1 x FROM courses WHERE id=?', b.courseId)) throw new Error('請選擇課程');
      const id = uid('X');
      run('INSERT INTO sessions(id,course_id,date,start,end,teacher,room,status,note,manual) VALUES(?,?,?,?,?,?,?,?,?,1)', id, b.courseId, date, start, end, str(b.teacher, 40), str(b.room, 40), status, str(b.note));
      return { id };
    },
    'a.sessionDelete'(b) {
      if (get("SELECT 1 x FROM attendance WHERE session_id=? AND status<>'取消'", b.id)) throw new Error('這堂課已有出席紀錄，不能刪除，請改用「停課」');
      const s = sessRow(b.id);
      if (s && !String(s.id).startsWith('X')) { run("UPDATE sessions SET status='停課', manual=1 WHERE id=?", b.id); return { cancelled: true }; }
      run('DELETE FROM sessions WHERE id=?', b.id);
      return { deleted: true };
    },
    'a.genSessions'() { return { added: generateSessions() }; },
    'a.cards'() {
      return all("SELECT c.*, (SELECT GROUP_CONCAT(s.name,'、') FROM card_students cs JOIN students s ON s.id=cs.student_id WHERE cs.card_id=c.id) names FROM cards c ORDER BY c.bought DESC, c.id DESC LIMIT 300");
    },
    'a.videos'() { return all('SELECT * FROM videos ORDER BY date DESC, id DESC'); },
    'a.videoSave'(b) {
      const title = str(b.title, 80), url = str(b.url, 500);
      if (!title || !/^https?:\/\//.test(url)) throw new Error('請輸入標題與正確的連結');
      const v = [title, str(b.courseId, 20), str(b.studentId, 20), nd(b.date) || today(), url, b.status === '停用' ? '停用' : '啟用'];
      if (b.id) run('UPDATE videos SET title=?,course_id=?,student_id=?,date=?,url=?,status=? WHERE id=?', ...v, b.id);
      else run('INSERT INTO videos(title,course_id,student_id,date,url,status,id) VALUES(?,?,?,?,?,?,?)', ...v, uid('V'));
      return { ok: true };
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
      const W = 2500, H = 1686, cw = 833, ch = 843;
      const cells = [['checkin', '線上報到'], ['card', '上課卡'], ['attendance', '出席紀錄'], ['schedule', '課表'], ['leave', '請假'], ['video', '影片']];
      const areas = cells.map((c, i) => ({ bounds: { x: (i % 3) * cw, y: Math.floor(i / 3) * ch, width: i % 3 === 2 ? W - 2 * cw : cw, height: ch }, action: { type: 'uri', label: c[1], uri: liffUrl(c[0]) } }));
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
    const items = [['線上報到', 'checkin'], ['上課卡', 'card'], ['出席紀錄', 'attendance'], ['課表', 'schedule'], ['請假', 'leave'], ['影片', 'video'], ['綁定學生', 'bind']];
    return { type: 'flex', altText: cfg('教室名稱', '舞蹈教室') + ' 功能選單', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: cfg('教室名稱', '舞蹈教室'), weight: 'bold', size: 'lg' },
      { type: 'text', text: title || '請選擇功能', size: 'sm', color: '#888888', wrap: true },
      ...items.map(m => ({ type: 'button', style: m[1] === 'checkin' ? 'primary' : 'secondary', color: m[1] === 'checkin' ? C.BRAND : undefined, height: 'sm', action: { type: 'uri', label: m[0], uri: liffUrl(m[1]) } }))] } } };
  }
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
        if (!kids.length) { await reply([menuFlex('您尚未綁定學生，請點「綁定學生」並輸入教室提供的綁定碼。')]); continue; }
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
        await reply([menuFlex()]);
      } catch (e) { console.error('webhook', e.message); }
    }
    return true;
  }

  maintenance();
  return { api, webhook, db, maintenance, qrToken, flush: () => flush(), all, get, run };
}
