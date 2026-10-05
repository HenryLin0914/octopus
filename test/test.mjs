// 後端流程測試：node --no-warnings test/test.mjs
import crypto from 'node:crypto';
import { createApp, today, addDays } from '../server/app.js';
const pushes = [];
const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_CHANNEL_SECRET: 'sec', LINE_LOGIN_CHANNEL_ID: 'x', LIFF_ID: 'LIFF', SETUP_CODE: 'setup123' };
const app = createApp({ dataDir: ':memory:', env, publicDir: './public',
  verifyIdToken: async t => { if (t.startsWith('bad')) throw new Error('AUTH'); return { userId: 'U' + crypto.createHash('md5').update(t).digest('hex'), name: t }; },
  lineFetch: async (url, init) => { pushes.push({ url, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null }); return { ok: true, json: async () => ({ richMenuId: 'rm1' }), text: async () => '' }; } });
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const tokens = {};
const call = async (who, action, d = {}) => { if (!tokens[who]) tokens[who] = (await app.api({ action: 'login', idToken: who })).data.token; const r = await app.api({ action, token: tokens[who], ...d }); await app.flush(); return r; };
const hhmm = d => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(11, 16);
let r;

ok((await app.api({ action: 'login', idToken: 'bad' })).error === 'AUTH', '無效 LINE token 被拒');
ok((await app.api({ action: 'init', token: 'x.y' })).error === 'AUTH', '偽造 session 被拒');
ok(/權限/.test((await call('mom', 'a.students')).error), '非管理員不可用後台');
ok(/安裝碼/.test((await call('mom', 'a.claim', { code: 'nope' })).error), '安裝碼錯誤不可成為管理員');
ok((await call('boss', 'a.claim', { code: 'setup123' })).ok, '用安裝碼成為第一位管理員');
ok(/已有管理員/.test((await call('mom', 'a.claim', { code: 'setup123' })).error), '已有管理員後安裝碼失效');
ok((await call('teacher', 'a.apply')).ok && (await call('teacher', 'a.status')).data.isAdmin === false, '老師申請後待開通');
const teacherId = (await call('teacher', 'a.status')).data.userId;
ok((await call('boss', 'a.adminSave', { userId: teacherId, name: '王老師', role: 'teacher', active: true })).ok, '管理員開通老師');
ok(/僅限管理員/.test((await call('teacher', 'a.topup', { studentId: 'S0001', planId: 'P02' })).error), '老師不能儲值');

// 課程與排課
r = await call('boss', 'a.courseSave', { name: '兒童街舞', teacher: '王老師', weekdays: [3, 6], start: '19:00', end: '20:00', room: 'A', capacity: 15, color: '#1971C2' });
ok(r.ok && r.data.id === 'C01' && r.data.added === 16, '新增課程並自動排出 8 週 16 堂（' + JSON.stringify(r.data) + '）');
r = await call('boss', 'a.courseSave', { id: 'C01', name: '兒童街舞', teacher: '王老師', weekdays: [3], start: '18:30', end: '19:30', room: 'A' });
const ss = app.all("SELECT * FROM sessions WHERE course_id='C01'");
ok(ss.length === 8 && ss.every(s => s.start === '18:30'), '改課程時間／星期，未來場次同步更新為 8 堂 18:30');
ok(/時間不正確/.test((await call('boss', 'a.courseSave', { name: 'x', weekdays: [1], start: '20:00', end: '19:00' })).error), '結束早於開始被拒');

// 學生、綁定
r = await call('boss', 'a.studentSave', { name: '小明', birthday: '2018-01-02', courses: ['C01'] }); const sid = r.data.id, code = r.data.code;
ok(sid === 'S0001' && /^\d{6}$/.test(code), '新增學生 ' + JSON.stringify(r.data));
ok(!(await call('mom', 'bind', { code: '0' })).ok, '錯誤綁定碼被拒');
ok((await call('mom', 'bind', { code })).data.name === '小明' && (await call('dad', 'bind', { code })).ok, '父母都綁定');
ok((await call('mom', 'bind', { code })).data.already === true, '重複綁定不重複寫入');
ok(/尚未綁定/.test((await call('stranger', 'card', { studentId: sid })).error), '未綁定者不可查他人');

// 儲值與通知
r = await call('boss', 'a.topup', { studentId: sid, planId: 'P02' }); ok(r.data.remain === 10, '儲值 10 堂');
let last = pushes[pushes.length - 1];
ok(/multicast/.test(last.url) && last.body.to.length === 2 && last.body.messages[0].contents.header.contents[1].text === '儲值成功', '儲值 Flex 通知兩位家長');

// 手動加課 + 線上報到
const st = new Date(Date.now() + 10 * 60000);
r = await call('boss', 'a.sessionSave', { courseId: 'C01', date: today(), start: hhmm(st), end: hhmm(new Date(st.getTime() + 3600e3 > new Date(today() + 'T23:59:00+08:00').getTime() ? st.getTime() + 60000 : st.getTime() + 3600e3)) });
const T1 = r.data && r.data.id; ok(r.ok && T1, '手動加課');
ok(/過期/.test((await call('mom', 'checkin', { studentId: sid, sessionId: T1, qr: 'zzz' })).error), '錯誤 QR 被拒');
r = await call('boss', 'a.qr', { sessionId: T1 }); const tk = new URL(r.data.url).searchParams.get('t');
ok(/liff\.line\.me\/LIFF\?page=checkin&sid=/.test(r.data.url) && tk === app.qrToken(T1), 'QR 網址正確');
const pb = pushes.length; r = await call('mom', 'checkin', { studentId: sid, sessionId: T1, qr: tk });
ok(r.ok && r.data.remain === 9 && r.data.deduct === 1, '線上報到扣 1 堂 → 9');
ok(pushes.length === pb + 1 && pushes[pb].body.messages[0].contents.header.contents[1].text === '報到成功', '報到 Flex 通知');
ok((await call('dad', 'checkin', { studentId: sid, sessionId: T1, qr: tk })).data.dup, '重複報到不重複扣');
ok((await call('teacher', 'a.mark', { sessionId: T1, studentId: sid, status: '請假' })).data.remain === 10, '老師改請假退堂 → 10');
ok((await call('boss', 'a.mark', { sessionId: T1, studentId: sid, status: '缺席' })).data.remain === 9, '改缺席扣堂 → 9');
ok((await call('boss', 'a.mark', { sessionId: T1, studentId: sid, status: '取消' })).data.remain === 10, '取消退堂 → 10');
r = await call('boss', 'a.roster', { sessionId: T1 }); ok(r.data.list.length === 1 && r.data.list[0].status === '', '點名單顯示未到');
ok((await call('boss', 'a.close', { sessionId: T1 })).data.absent === 1 && (await call('mom', 'card', { studentId: sid })).data.remain === 9, '結算記缺席並扣堂 → 9');
ok(/不能刪除/.test((await call('boss', 'a.sessionDelete', { id: T1 })).error), '有紀錄的場次不能刪');

// 請假
r = await call('mom', 'schedule', { studentId: sid }); const can = r.data.upcoming.filter(u => u.canLeave);
ok(can.length > 0, '有可請假場次 ' + can.length);
const pl = pushes.length; r = await call('mom', 'leave', { studentId: sid, sessionId: can[can.length - 1].sessionId, reason: '生病' });
ok(r.data.status === '已登記' && pushes.length === pl + 2 && pushes[pl].body.messages[0].contents.header.contents[1].text === '已收到請假' && pushes[pl + 1].body.to.length === 2, '請假即登記，通知家長與兩位管理員');
ok(/已有紀錄/.test((await call('mom', 'leave', { studentId: sid, sessionId: can[can.length - 1].sessionId })).error) && (await call('mom', 'card', { studentId: sid })).data.remain === 9, '不可重複請假且不扣堂');
r = await call('mom', 'attendance', { studentId: sid }); ok(r.data.count['缺席'] === 1 && r.data.count['請假'] === 1, '出席統計 ' + JSON.stringify(r.data.count));

// 共用卡
const b1 = (await call('boss', 'a.studentSave', { name: '哥哥' })).data.id, b2 = (await call('boss', 'a.studentSave', { name: '妹妹' })).data.id;
r = await call('boss', 'a.topup', { studentId: b1, planId: 'P02', shareIds: [b2] }); ok(r.data.shared === 1 && r.data.remain === 10, '共用卡儲值');
const T3 = (await call('boss', 'a.sessionSave', { courseId: 'C01', date: today(), start: '06:00', end: '07:00' })).data.id;
ok((await call('boss', 'a.mark', { sessionId: T3, studentId: b1, status: '出席' })).data.remain === 9 && (await call('boss', 'a.mark', { sessionId: T3, studentId: b2, status: '出席' })).data.remain === 8, '兄妹扣同一張卡 → 8');
r = await call('boss', 'a.students'); ok(r.data.find(x => x.id === b1).family.includes(b2) && r.data.find(x => x.id === sid).remain === 9, '名冊顯示家人，他人卡不受影響');
r = await call('boss', 'a.student', { id: b1 }); const cardId = r.data.cards[0].id;
ok((await call('boss', 'a.cardSave', { id: cardId, remain: 20, expire: addDays(today(), 60) })).ok && (await call('boss', 'a.student', { id: b2 })).data.remain === 20, '手動調整卡片堂數');

// 其他後台功能
ok((await call('boss', 'a.settingSave', { key: '報到推播', value: '否' })).data.value === '否' && /數字/.test((await call('boss', 'a.settingSave', { key: '低堂數門檻', value: 'x' })).error), '設定可改且會驗證');
ok((await call('boss', 'a.planSave', { name: '30堂卡', lessons: 30, price: 11000, validDays: 365 })).ok && (await call('boss', 'a.plans')).data.length === 4, '新增方案');
ok((await call('boss', 'a.videoSave', { title: '成果發表', url: 'https://youtu.be/x', courseId: 'C01' })).ok && (await call('mom', 'videos', { studentId: sid })).data.length === 1 && (await call('boss', 'a.videoSave', { title: 'bad', url: 'javascript:1' })).ok === false, '影片：班級可見，非 http 連結被拒');
r = await call('boss', 'a.overview'); ok(r.data.sessions.length >= 2 && r.data.stats.students === 3 && r.data.stats.monthIncome === 9000, '總覽 ' + JSON.stringify(r.data.stats));
r = await call('boss', 'a.week', { start: today() }); ok(r.data.sessions.length >= 2 && r.data.sessions.every(s => 'present' in s && s.color), '週課表');
r = await call('boss', 'a.export', { table: 'students' }); ok(r.data.csv.split('\n').length === 4 && /小明/.test(r.data.csv), '匯出 CSV');
ok(/自己/.test((await call('boss', 'a.adminSave', { userId: (await call('boss', 'a.status')).data.userId, role: 'teacher', active: true })).error), '不能降自己的權限');
r = await call('boss', 'a.studentImport', { rows: [{ name: '甲' }, { name: '乙', phone: '0912' }, { name: '' }], courseId: 'C01' }); ok(r.data.added === 2, '批次匯入 2 位');
ok((await call('boss', 'a.unbind', { userId: (await call('dad', 'init')).data.userId, studentId: sid })).data.removed === 1 && (await call('dad', 'init')).data.students.length === 0, '解除綁定');

{ // 帳務：明細、更正、作廢
  const z = (await call('boss', 'a.studentSave', { name: '帳務生' })).data.id;
  let g = (await call('boss', 'a.ledger', {})).data; const n0 = g.rows.length, t0 = g.total;
  ok(n0 >= 2 && t0 === g.rows.reduce((n, x) => n + x.amount, 0) && g.months[0] === g.month && g.rows.some(x => (x.names || '').includes('、')), '帳務明細與合計');
  ok(/僅限管理員/.test((await call('teacher', 'a.ledger', {})).error), '老師不能看帳務');
  await call('boss', 'a.topup', { studentId: z, planId: 'P01' });
  g = (await call('boss', 'a.ledger', {})).data; const row = g.rows.find(x => x.student_id === z);
  ok(g.total === t0 + 500 && row.card_remain === 1, '儲值進帳');
  await call('boss', 'a.topupSave', { id: row.id, amount: 450, pay: '轉帳', note: '折扣' });
  g = (await call('boss', 'a.ledger', {})).data; ok(g.total === t0 + 450 && g.rows.find(x => x.id === row.id).pay === '轉帳', '更正儲值金額');
  await call('boss', 'a.topupSave', { id: row.id, void: true });
  g = (await call('boss', 'a.ledger', {})).data;
  ok(g.total === t0 && g.rows.length === n0 && (await call('boss', 'a.students', {})).data.find(q => q.id === z).remain === 0, '作廢儲值會停用上課卡');
}

{ // 影片：YouTube 連結、LINE 查閱、通知
  const { ytId } = await import('../server/app.js');
  ok(['https://youtu.be/dQw4w9WgXcQ?si=x', 'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/live/dQw4w9WgXcQ'].every(u => ytId(u) === 'dQw4w9WgXcQ') && ytId('https://drive.google.com/x') === '', '解析各種 YouTube 網址');
  ok((await call('boss', 'a.videoInfo', { url: 'https://youtu.be/dQw4w9WgXcQ' })).data.yt === 'dQw4w9WgXcQ', '貼上連結取得影片資訊');
  const p0 = pushes.length;
  r = await call('boss', 'a.videoSave', { title: '個人練習', url: 'youtu.be/dQw4w9WgXcQ', studentId: sid, notify: true });
  const m = pushes[pushes.length - 1].body;
  ok(r.data.notified === 1 && pushes.length === p0 + 1 && m.messages[0].contents.hero.url.includes('dQw4w9WgXcQ') && m.messages[0].contents.footer.contents[0].action.uri === 'https://youtu.be/dQw4w9WgXcQ', '新影片通知家長（含縮圖）');
  const mine = (await call('mom', 'videos', { studentId: sid })).data;
  ok(mine.length === 2 && mine.some(v => v.yt === 'dQw4w9WgXcQ' && v.personal), '家長端看得到班級與個人影片');
  ok((await call('boss', 'a.videoSave', { title: 'x', url: 'https://youtu.be/dQw4w9WgXcQ', studentId: 'S9999' })).ok === false, '指定不存在的學生被拒');
  const vb = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: '影片' }, source: { userId: (await call('mom', 'init')).data.userId } }] });
  const n = pushes.length; await app.webhook(vb, crypto.createHmac('sha256', 'sec').update(vb).digest('base64'));
  ok(pushes.length === n + 1 && pushes[n].body.messages[0].contents.type === 'carousel' && pushes[n].body.messages[0].contents.contents.length === 2, 'LINE 輸入「影片」回覆影片卡片');
}

{ // LINE 關鍵字：課表、請假
  const uid = (await call('mom', 'init')).data.userId;
  for (const [w, title] of [['課表', '近期課表'], ['我要請假', '請假'], ['出席', '最近出席紀錄']]) {
    const bd = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: w }, source: { userId: uid } }] });
    const n = pushes.length; await app.webhook(bd, crypto.createHmac('sha256', 'sec').update(bd).digest('base64'));
    const c = pushes[n] && pushes[n].body.messages[0].contents, b0 = c && (c.type === 'carousel' ? c.contents[0] : c);
    ok(b0 && b0.header.contents[1].text === title, 'LINE 輸入「' + w + '」回覆' + title);
  }
}

{ // 出席總表
  const g = (await call('teacher', 'a.attendance', {})).data, sum = g.students.reduce((n, x) => n + x.total, 0);
  ok(g.rows.length > 0 && g.total.total === sum && g.total.total === g.total.出席 + g.total.請假 + g.total.缺席 && g.months[0] >= g.month, '出席總表合計一致（老師可看）');
  const one = (await call('boss', 'a.attendance', { studentId: sid })).data;
  ok(one.rows.length > 0 && one.rows.every(x => x.sid === sid) && one.students.length === 1 && one.students[0].rate >= 0, '出席總表可依學生篩選');
  ok((await call('boss', 'a.attendance', { month: '2000-01' })).data.total.rate === null, '沒有紀錄的月份出席率為空');
}

{ // 開課期間
  const { addDays, today } = await import('../server/app.js');
  const t0 = today(), from = addDays(t0, 7), to = addDays(t0, 34);
  r = await call('boss', 'a.courseSave', { name: '期間班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '10:00', dateFrom: from, dateTo: to });
  const cid = r.data.id; let ss = (await call('boss', 'a.export', { table: 'sessions' })).data.csv.split('\n').filter(l => l.includes(cid + '-'));
  ok(r.data.upcoming === 28 && ss.length === 28, '有期間的課程只排期間內的堂數 ' + r.data.upcoming);
  r = await call('boss', 'a.courseSave', { id: cid, name: '期間班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '10:00', dateFrom: from, dateTo: addDays(from, 6) });
  ok(r.data.upcoming === 7, '縮短期間會移除多出來的堂數');
  r = await call('boss', 'a.courseSave', { id: cid, name: '期間班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '10:00', dateFrom: from, dateTo: addDays(from, 100) });
  ok(r.data.upcoming === 101, '期間超過 8 週也一次排完');
  ok(/不能早於/.test((await call('boss', 'a.courseSave', { id: cid, name: '期間班', weekdays: [1], start: '09:00', end: '10:00', dateFrom: to, dateTo: from })).error), '結束早於開始被拒');
  await call('boss', 'a.courseSave', { id: cid, name: '期間班', weekdays: [1], start: '09:00', end: '10:00', status: '停用' });
  ok((await call('boss', 'a.week', { start: t0, days: 42 })).data.sessions.every(x => x.courseId !== cid), '月曆查詢 42 天、停開課程不再出現');
}

{ // 開課期間含過去日期：過去的堂數也要排出來
  const { addDays, today } = await import('../server/app.js');
  const t0 = today();
  r = await call('boss', 'a.courseSave', { name: '回溯班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '10:00', dateFrom: addDays(t0, -20), dateTo: addDays(t0, 9) });
  ok(r.data.past === 20 && r.data.upcoming === 10, '期間含過去日期時補排過去堂數 ' + JSON.stringify(r.data));
  const w = (await call('boss', 'a.week', { start: addDays(t0, -20), days: 30 })).data.sessions.filter(x => x.courseId === r.data.id);
  ok(w.length === 30 && w[0].seq === 1 && w[0].total === 30 && w[29].seq === 30 && w[0].past === true && w[29].past === false, '場次帶出第幾堂／共幾堂');
  r = await call('boss', 'a.courseSave', { id: r.data.id, name: '回溯班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '10:00', dateFrom: addDays(t0, -5), dateTo: addDays(t0, 9) });
  ok(r.data.past === 5, '開課日期往後改，期間外未點名的過去堂數會移除');
  await call('boss', 'a.courseSave', { id: r.data.id, name: '回溯班', weekdays: [1], start: '09:00', end: '10:00', status: '停用' });
}

{ // 停課／調課通知、整天停課順延、衝堂、續開、補課、家長月曆與老師備註
  const { addDays, today } = await import('../server/app.js');
  const t0 = today(), d1 = addDays(t0, 3), wd = new Date(d1 + 'T12:00:00+08:00').getUTCDay();
  const A1 = (await call('boss', 'a.courseSave', { name: '甲班', teacher: '章魚', room: 'R1', weekdays: [wd], start: '11:00', end: '12:00', dateFrom: t0, dateTo: addDays(t0, 30) })).data;
  const kid = (await call('boss', 'a.studentSave', { name: '通知生', courses: [A1.id] })).data;
  await call('mom', 'bind', { code: kid.code, relation: '母親' });
  const ses = () => call('boss', 'a.week', { start: t0, days: 60 }).then(x => x.data.sessions.filter(q => q.courseId === A1.id));
  let L = await ses(); const n0 = L.length, s1 = L[0];
  // 衝堂
  r = await call('boss', 'a.courseSave', { name: '乙班', teacher: '別人', room: 'R1', weekdays: [wd], start: '11:30', end: '12:30', dateFrom: t0, dateTo: addDays(t0, 30) });
  ok(r.ok === false && /^CONFLICT:/.test(r.error) && /甲班/.test(r.error) && /同教室 R1/.test(r.error) && (await call('boss', 'a.meta')).data.courses.every(c => c.name !== '乙班'), '課程衝堂會先警告且不儲存');
  r = await call('boss', 'a.courseSave', { name: '乙班', teacher: '別人', room: 'R1', weekdays: [wd], start: '11:30', end: '12:30', dateFrom: t0, dateTo: addDays(t0, 30), force: true });
  ok(r.ok && r.data.id, '確認後可強制儲存'); const B1 = r.data.id;
  await call('boss', 'a.courseSave', { id: B1, name: '乙班', weekdays: [wd], start: '11:30', end: '12:30', status: '停用' });
  // 調課通知＋老師備註
  let p0 = pushes.length;
  r = await call('boss', 'a.sessionSave', { id: s1.sessionId, date: s1.date, start: '13:00', end: '14:00', teacher: '', room: '', status: '正常', note: '請帶室內鞋', notify: true });
  let m = pushes[pushes.length - 1].body.messages[0];
  ok(r.data.kind === '調課' && r.data.notified === 1 && pushes.length === p0 + 1 && m.contents.header.contents[1].text === '調課通知' && JSON.stringify(m).includes('請帶室內鞋') && JSON.stringify(m).includes('原時間'), '調課會通知家長並附老師備註');
  // 停課＋順延
  r = await call('boss', 'a.sessionSave', { id: s1.sessionId, date: s1.date, start: '13:00', end: '14:00', status: '停課', note: '颱風', notify: true, postpone: true });
  L = await ses(); m = pushes[pushes.length - 1].body.messages[0];
  ok(r.data.kind === '停課' && r.data.postponed && L.length === n0 + 1 && L.filter(q => q.status !== '停課').length === n0 && m.contents.header.contents[1].text === '停課通知', '停課順延：整期堂數不變並通知家長');
  // 整天停課
  const s2 = L.find(q => q.status === '正常');
  r = await call('boss', 'a.dayOff', { date: s2.date, reason: '國定假日', notify: true });
  ok(r.data.stopped >= 1 && r.data.notified >= 1 && (await ses()).find(q => q.sessionId === s2.sessionId).status === '停課' && /僅限管理員/.test((await call('teacher', 'a.dayOff', { date: s2.date })).error), '整天停課（僅管理員）');
  // 家長月曆與備註
  const sc = (await call('mom', 'schedule', { studentId: kid.id, month: s1.date.slice(0, 7) })).data;
  ok(sc.monthSessions.some(q => q.sessionId === s1.sessionId && q.status === '停課' && q.note === '颱風') && sc.month === s1.date.slice(0, 7), '家長月曆看得到停課與老師備註');
  // 補課
  const s3 = (await ses()).find(q => q.status === '正常');
  await call('boss', 'a.mark', { sessionId: s3.sessionId, studentId: kid.id, status: '請假' });
  const opt = (await call('teacher', 'a.makeupOptions', { studentId: kid.id, fromSessionId: s3.sessionId })).data;
  const tgt = opt.find(q => !q.own) || opt[0]; p0 = pushes.length;
  r = await call('teacher', 'a.makeupSave', { studentId: kid.id, sessionId: tgt.sessionId, fromSessionId: s3.sessionId, notify: true });
  const ro = (await call('boss', 'a.roster', { sessionId: tgt.sessionId })).data.list.find(q => q.id === kid.id);
  const fromRo = (await call('boss', 'a.roster', { sessionId: s3.sessionId })).data.list.find(q => q.id === kid.id);
  ok(opt.length > 0 && r.data.notified === 1 && pushes.length === p0 + 1 && ro && ro.makeup && fromRo.makeupAt && (await call('mom', 'schedule', { studentId: kid.id, month: tgt.date.slice(0, 7) })).data.monthSessions.some(q => q.sessionId === tgt.sessionId && q.makeup), '補課：出現在點名單與家長課表，並通知家長');
  ok((await call('boss', 'a.leaves')).data.some(q => q.sid === kid.id && q.makeup), '請假清單顯示已安排補課');
  ok((await call('boss', 'a.makeupDelete', { studentId: kid.id, sessionId: tgt.sessionId })).data.removed === 1, '取消補課');
  // 續開下一期
  r = await call('boss', 'a.courseSave', { name: '甲班（第二期）', teacher: '章魚', room: 'R1', weekdays: [wd], start: '11:00', end: '12:00', dateFrom: addDays(t0, 60), dateTo: addDays(t0, 90), copyStudentsFrom: A1.id });
  ok(r.data.copied === 1 && (await call('boss', 'a.student', { id: kid.id })).data.courses.includes(r.data.id), '續開下一期會帶入原班學生');
  for (const id of [A1.id, r.data.id]) await call('boss', 'a.courseSave', { id, name: 'x', weekdays: [wd], start: '11:00', end: '12:00', status: '停用' });
  await call('boss', 'a.unbind', { userId: (await call('mom', 'init')).data.userId, studentId: kid.id });
}

{ // 家庭：兄弟姊妹一次綁定、共用卡用量
  const k1 = (await call('boss', 'a.studentSave', { name: '大寶' })).data, k2 = (await call('boss', 'a.studentSave', { name: '二寶', familyWith: k1.id })).data, k3 = (await call('boss', 'a.studentSave', { name: '三寶' })).data;
  let L = (await call('boss', 'a.students')).data;
  ok(L.find(x => x.id === k1.id).family.includes(k2.id) && L.find(x => x.id === k2.id).family.includes(k1.id) && !L.find(x => x.id === k3.id).family.length, '新增學生時可指定兄弟姊妹');
  r = await call('fam', 'bind', { code: k1.code, relation: '父親' });
  ok(r.data.also.join() === '二寶' && (await call('fam', 'init')).data.students.length === 2, '輸入一位的綁定碼，兄弟姊妹一起綁定');
  r = await call('fam', 'bind', { code: k3.code, relation: '父親' });
  ok((await call('boss', 'a.student', { id: k3.id })).data.family.length === 2, '同一位家長再綁第三位，自動併入同一家庭');
  await call('boss', 'a.topup', { studentId: k1.id, planId: 'P02', price: 4500, shareIds: [k2.id] });
  const i2 = (await call('fam', 'init')).data.students;
  ok(i2.find(x => x.id === k1.id).sharedWith.join() === '二寶' && i2.find(x => x.id === k1.id).remain === 10 && i2.find(x => x.id === k3.id).remain === 0, '家長首頁資料帶出共用對象');
  r = await call('boss', 'a.familySave', { studentId: k3.id, memberIds: [] });
  L = (await call('boss', 'a.students')).data;
  ok(!L.find(x => x.id === k3.id).family.length && L.find(x => x.id === k1.id).family.join() === k2.id && L.find(x => x.id === k1.id).shared, '可把學生移出家庭');
  const k4 = (await call('boss', 'a.studentSave', { name: '四寶' })).data;
  r = await call('boss', 'a.familySave', { studentId: k4.id, memberIds: [k1.id, k2.id], syncParents: true });
  ok(r.data.family.length === 2 && r.data.bound === 1 && (await call('fam', 'init')).data.students.some(x => x.id === k4.id), '加入家庭時幫已綁定的家長補綁');
  const uidF = (await call('fam', 'init')).data.userId;
  for (const k of [k1, k2, k3, k4]) await call('boss', 'a.unbind', { userId: uidF, studentId: k.id });
}

{ // 刪除一堂課（不會被自動排回來）、單次課程
  const { addDays, today } = await import('../server/app.js');
  const t0 = today();
  const c = (await call('boss', 'a.courseSave', { name: '刪除測試班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '07:00', end: '08:00', dateFrom: t0, dateTo: addDays(t0, 9) })).data;
  const ses = () => call('boss', 'a.week', { start: t0, days: 20 }).then(x => x.data.sessions.filter(q => q.courseId === c.id));
  const L = await ses();
  r = await call('boss', 'a.sessionDelete', { id: L[3].sessionId });
  await call('boss', 'a.genSessions'); app.maintenance();
  ok(r.data.deleted && (await ses()).length === L.length - 1 && !(await ses()).some(q => q.sessionId === L[3].sessionId), '刪除固定場次後不會被自動排回來');
  const kid = (await call('boss', 'a.studentSave', { name: '單次生' })).data;
  r = await call('boss', 'a.sessionSave', { date: addDays(t0, 5), start: '15:00', end: '17:00', newCourse: { name: '週末工作坊', teacher: '客座老師', room: 'B', studentIds: [kid.id] } });
  const meta = (await call('boss', 'a.meta')).data.courses.find(q => q.name === '週末工作坊');
  const ro = (await call('boss', 'a.roster', { sessionId: r.data.id })).data;
  ok(r.ok && meta && meta.weekdays === '' && ro.info.teacher === '客座老師' && ro.list.length === 1 && (await call('boss', 'a.week', { start: t0, days: 60 })).data.sessions.filter(q => q.courseId === meta.id).length === 1, '加課可建立單次課程（不每週重複）並排入學生');
  ok((await call('boss', 'a.courseSave', { id: meta.id, name: '週末工作坊2', weekdays: [], start: '15:00', end: '17:00' })).ok, '單次課程可改名');
  await call('boss', 'a.sessionDelete', { id: r.data.id });
  ok(!(await call('boss', 'a.meta')).data.courses.some(q => q.id === meta.id), '刪除單次課程的那一堂，課程一併移除');
  r = await call('boss', 'a.courseDelete', { id: c.id });
  ok(r.data.deleted && !(await call('boss', 'a.meta')).data.courses.some(q => q.id === c.id) && /不能刪除/.test((await call('boss', 'a.courseDelete', { id: 'C01' })).error), '沒有出席紀錄的課程可刪除，有紀錄的不行');
}

{ // 家長課表：課程介紹與課程影片數
  r = await call('boss', 'a.courseSave', { id: 'C01', name: '兒童街舞', weekdays: [3], start: '18:30', end: '19:30', intro: '適合 6–10 歲，從基本律動開始。' });
  const sc = (await call('mom', 'schedule', { studentId: sid })).data;
  ok(sc.info.C01 && sc.info.C01.intro.includes('6–10 歲') && sc.info.C01.videos === 1 && 'botId' in (await call('mom', 'init')).data, '家長課表帶出課程介紹與影片數');
}

{ // 一般聊天不回選單；諮詢回覆已收到並通知管理員
  const uidM = (await call('mom', 'init')).data.userId;
  const say = async text => { const bd = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text }, source: { userId: uidM } }] }); const n = pushes.length; await app.webhook(bd, crypto.createHmac('sha256', 'sec').update(bd).digest('base64')); return pushes.slice(n); };
  ok((await say('老師好，今天會晚 10 分鐘到')).length === 0, '一般聊天訊息不自動回覆');
  let p = await say('您好，我想詢問「Hit Hop 10/05（一）19:00」');
  ok(p.length === 2 && /reply/.test(p[0].url) && /已收到/.test(p[0].body.messages[0].text) && /multicast/.test(p[1].url) && p[1].body.messages[0].contents.header.contents[1].text === '家長諮詢', '諮詢：回覆已收到並通知管理員');
  p = await say('您好，我想詢問「另一堂課」');
  ok(p.length === 1 && /multicast/.test(p[0].url), '10 分鐘內再次諮詢不重複回覆，但仍通知管理員');
  ok((await say('選單')).length === 1, '傳「選單」才回功能選單');
}

{ // 課程固定名單、全部出席
  const { addDays, today } = await import('../server/app.js');
  const t0 = today();
  const c = (await call('boss', 'a.courseSave', { name: '名單班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '06:30', dateFrom: t0, dateTo: addDays(t0, 3) })).data;
  const ks = []; for (const n of ['甲生', '乙生', '丙生']) ks.push((await call('boss', 'a.studentSave', { name: n })).data.id);
  r = await call('boss', 'a.courseStudents', { courseId: c.id, studentIds: ks });
  ok(r.data.added === 3 && (await call('boss', 'a.courseStudents', { courseId: c.id })).data.ids.length === 3 && /僅限管理員/.test((await call('teacher', 'a.courseStudents', { courseId: c.id, studentIds: [] })).error), '設定課程固定名單');
  const sidX = (await call('boss', 'a.week', { start: t0, days: 2 })).data.sessions.find(q => q.courseId === c.id).sessionId;
  await call('boss', 'a.mark', { sessionId: sidX, studentId: ks[0], status: '請假' });
  r = await call('teacher', 'a.markAll', { sessionId: sidX });
  const ro = (await call('boss', 'a.roster', { sessionId: sidX })).data.list;
  ok(r.data.marked === 2 && ro.filter(x => x.status === '出席').length === 2 && ro.find(x => x.id === ks[0]).status === '請假' && ro.every(x => x.fixed), '全部出席不會覆蓋已請假的學生');
  const extra = []; for (const n of ['丁生', '戊生']) extra.push((await call('boss', 'a.studentSave', { name: n })).data.id);
  r = await call('boss', 'a.markMany', { sessionId: sidX, studentIds: extra, addToRoster: true });
  const ro2 = (await call('boss', 'a.roster', { sessionId: sidX })).data.list;
  ok(r.data.marked === 2 && r.data.added === 2 && r.data.noCard === 2 && extra.every(id => ro2.find(x => x.id === id && x.status === '出席' && x.fixed)), '多選學生一次報到並加入固定名單');
  r = await call('teacher', 'a.markMany', { sessionId: sidX, studentIds: [ks[0]], addToRoster: true });
  ok(r.data.marked === 1 && r.data.added === 0, '老師可多選報到，但不能改固定名單');
  await call('boss', 'a.courseStudents', { courseId: c.id, studentIds: ks });
  await call('boss', 'a.mark', { sessionId: sidX, studentId: ks[0], status: '請假' });
  r = await call('boss', 'a.courseStudents', { courseId: c.id, studentIds: [ks[0]] });
  ok(r.data.removed === 2 && (await call('boss', 'a.roster', { sessionId: sidX })).data.list.length === 5, '移出名單後，已點名的紀錄仍保留在該堂點名單');
  await call('boss', 'a.courseSave', { id: c.id, name: 'x', weekdays: [1], start: '06:00', end: '06:30', status: '停用' });
}

{ // 家長課表顯示全部課程與線上報名
  const { addDays, today } = await import('../server/app.js');
  const t0 = today();
  const c = (await call('boss', 'a.courseSave', { name: '報名班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '05:00', end: '05:30', dateFrom: t0, dateTo: addDays(t0, 10), capacity: 1 })).data;
  let sc = (await call('mom', 'schedule', { studentId: sid, month: '' })).data;
  ok(sc.courses.some(q => q.id === c.id && q.canSignup && !q.enrolled) && sc.upcoming.some(q => q.courseId === c.id && !q.mine && !q.canLeave) && sc.upcoming.some(q => q.mine) && sc.monthSessions.some(q => q.courseId === c.id), '家長課表列出全部課程，未參加的可報名、不能請假');
  let p0 = pushes.length;
  r = await call('mom', 'signup', { studentId: sid, courseId: c.id });
  ok(r.data.status === '待審核' && pushes.length === p0 + 1 && /重複|已經送出/.test((await call('mom', 'signup', { studentId: sid, courseId: c.id })).error) && (await call('mom', 'schedule', { studentId: sid })).data.info[c.id].pending, '報名需審核：建立申請並通知管理員');
  const g = (await call('boss', 'a.signups')).data;
  p0 = pushes.length; r = await call('boss', 'a.signupSave', { id: g[0].id, approve: true });
  sc = (await call('mom', 'schedule', { studentId: sid })).data;
  ok(g.length === 1 && r.ok && pushes.length === p0 + 1 && sc.info[c.id].enrolled && sc.upcoming.some(q => q.courseId === c.id && q.mine && q.canLeave) && (await call('boss', 'a.overview')).data.signups === 0, '同意報名後加入名單並通知家長');
  const other = (await call('boss', 'a.studentSave', { name: '額滿生' })).data; await call('dad', 'bind', { code: other.code });
  ok(/額滿/.test((await call('dad', 'signup', { studentId: other.id, courseId: c.id })).error), '額滿不能報名');
  await call('boss', 'a.settingSave', { key: '報名需審核', value: '否' });
  await call('boss', 'a.courseSave', { id: c.id, name: '報名班', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '05:00', end: '05:30', capacity: 0 });
  r = await call('dad', 'signup', { studentId: other.id, courseId: c.id });
  ok(r.data.status === '已加入' && (await call('boss', 'a.courseStudents', { courseId: c.id })).data.ids.includes(other.id), '不需審核時直接加入名單');
  await call('boss', 'a.settingSave', { key: '報名需審核', value: '是' });
  await call('boss', 'a.unbind', { userId: (await call('dad', 'init')).data.userId, studentId: other.id });
  await call('boss', 'a.courseDelete', { id: c.id });
}

{ // 教室租借
  const { addDays, today } = await import('../server/app.js');
  const d1 = addDays(today(), 3), wd = new Date(d1 + 'T12:00:00+08:00').getUTCDay();
  r = await call('boss', 'a.roomSave', { name: 'A教室', capacity: 20, price: 400, unit: 60, intro: '鏡面、木地板', open: { [wd]: [['09:00', '12:00'], ['14:00', '18:00']] } });
  const rid = r.data.id;
  ok(r.ok && /僅限管理員/.test((await call('teacher', 'a.roomSave', { name: 'x' })).error), '建立可租借教室（僅管理員）');
  await call('boss', 'a.rentTagSave', { name: '已付款', color: '#2B8A3E' });
  const tag = (await call('boss', 'a.rent')).data.tags[0];
  let info = (await call('guest', 'rentInfo')).data;
  ok(info.open && info.rooms.length === 1 && info.rooms[0].days.join() === String(wd) && (await call('guest', 'init')).data.students.length === 0, '未綁定學生的訪客也能看到租借資訊');
  let sl = (await call('guest', 'rentSlots', { roomId: rid, date: d1 })).data.slots;
  ok(sl.length === 7 && sl.every(x => x.free) && sl[0].start === '09:00' && sl[3].start === '14:00', '依開放時段切出可預約格子');
  ok(/連續/.test((await call('guest', 'rentBook', { roomId: rid, date: d1, start: '11:00', end: '15:00', name: '阿明', phone: '0912345678' })).error) && /姓名與聯絡電話/.test((await call('guest', 'rentBook', { roomId: rid, date: d1, start: '09:00', end: '10:00', name: '', phone: '' })).error), '跨過未開放時段或缺資料會被擋');
  let p0 = pushes.length;
  r = await call('guest', 'rentBook', { roomId: rid, date: d1, start: '14:00', end: '16:00', name: '阿明', phone: '0912-345-678', people: 6, purpose: '排舞' });
  const bid = r.data.id;
  ok(r.data.status === '待確認' && r.data.amount === 800 && pushes.length === p0 + 1 && pushes[p0].body.messages[0].contents.header.contents[1].text === '教室租借申請', '送出租借申請並通知管理員');
  sl = (await call('guest2', 'rentSlots', { roomId: rid, date: d1 })).data.slots;
  ok(sl.filter(x => !x.free).map(x => x.start).join() === '14:00,15:00' && /被預約走/.test((await call('guest2', 'rentBook', { roomId: rid, date: d1, start: '15:00', end: '17:00', name: '小華', phone: '0922333444' })).error), '已被預約的時段不能再約');
  p0 = pushes.length; r = await call('boss', 'a.bookingSave', { id: bid, status: '已確認', tags: [tag.id], note: '現場收款' });
  let bk = (await call('boss', 'a.rent')).data.bookings.find(x => x.id === bid);
  ok(r.data.notified === 1 && pushes.length === p0 + 1 && pushes[p0].body.messages[0].contents.header.contents[1].text === '預約已確認' && bk.status === '已確認' && bk.tags[0] === tag.id && (await call('guest', 'rentInfo')).data.mine[0].status === '已確認', '管理員確認並貼標籤，通知預約人');
  r = await call('boss', 'a.bookingSave', { roomId: rid, date: d1, start: '15:00', end: '17:00', name: '舞團保留', status: '已確認' });
  ok(r.ok === false && /^CONFLICT:/.test(r.error) && (await call('boss', 'a.bookingSave', { roomId: rid, date: d1, start: '16:00', end: '18:00', name: '舞團保留', status: '已確認' })).ok, '管理員手動保留：與既有預約重疊會警告');
  // 排在同名教室的課會占用時段
  const c = (await call('boss', 'a.courseSave', { name: '租借衝突班', room: 'A教室', weekdays: [wd], start: '09:00', end: '10:30', dateFrom: today(), dateTo: addDays(today(), 7), force: true })).data;
  sl = (await call('guest2', 'rentSlots', { roomId: rid, date: d1 })).data.slots;
  ok(sl.find(x => x.start === '09:00').why === '上課' && !sl.find(x => x.start === '10:00').free && sl.find(x => x.start === '11:00').free, '同教室有課的時段自動不開放');
  r = await call('boss', 'a.sessionSave', { date: d1, start: '16:30', end: '17:30', newCourse: { name: '撞租借的課', room: 'A教室' } });
  ok(r.ok === false && /^CONFLICT:/.test(r.error) && /已被租借：舞團保留/.test(r.error) && !(await call('boss', 'a.meta')).data.courses.some(q => q.name === '撞租借的課'), '排課時提醒教室已被租借');
  r = await call('boss', 'a.courseSave', { name: '撞租借的固定課', room: 'A教室', weekdays: [wd], start: '14:30', end: '15:30', dateFrom: today(), dateTo: addDays(today(), 7) });
  ok(r.ok === false && /已被租借：阿明/.test(r.error), '開固定課程時也會檢查租借');
  { // 沒填教室的課也會擋租借；確認租借時檢查課程；規則存檔回報重疊的課
    const dX = addDays(d1, 7);
    r = await call('boss', 'a.bookingSave', { roomId: rid, date: dX, start: '09:00', end: '12:00', name: '待確認的人', status: '待確認' }); const pend = r.data.id;
    r = await call('boss', 'a.sessionSave', { date: dX, start: '10:00', end: '11:00', newCourse: { name: '沒填教室的特約課' } });
    ok(r.ok === false && /已被租借：待確認的人/.test(r.error), '沒填教室的課：排課時也會提醒租借');
    r = await call('boss', 'a.sessionSave', { date: dX, start: '10:00', end: '11:00', newCourse: { name: '沒填教室的特約課' }, force: true }); const sx = r.data.id;
    ok((await call('boss', 'a.rentSlots', { roomId: rid, date: dX })).data.busy.some(x => x.why === '上課' && /未指定教室/.test(x.who)), '沒填教室的課會占用租借時段');
    const row = (await call('boss', 'a.rent')).data.bookings.find(x => x.id === pend);
    r = await call('boss', 'a.bookingSave', { id: pend, status: '已確認' });
    ok(/上課（沒填教室的特約課/.test(row.conflict) && r.ok === false && /^CONFLICT:/.test(r.error) && /上課/.test(r.error), '確認租借時檢查是否撞到課程，清單上也會標示');
    r = await call('boss', 'a.ruleSave', { roomId: rid, from: dX, to: dX, weekdays: [0, 1, 2, 3, 4, 5, 6], ranges: [['10:00', '11:00']] });
    ok(r.data.classes === 1 && /特約課/.test(r.data.sample[0]) && (await call('boss', 'a.roomCal', { roomId: rid, month: dX.slice(0, 7) })).data.days.find(x => x.date === dX).busy.some(k => k.why === '上課'), '設定開放規則時回報重疊的課，月曆帶出當天占用明細');
    const rl = (await call('boss', 'a.roomCal', { roomId: rid, month: dX.slice(0, 7) })).data.rules.find(x => x.from === dX);
    await call('boss', 'a.ruleDelete', { id: rl.id }); await call('boss', 'a.sessionDelete', { id: sx }); await call('boss', 'a.bookingSave', { id: pend, status: '已取消' });
  }
  await call('boss', 'a.rentBlockSave', { roomId: '', date: d1, start: '', end: '', note: '整修' });
  ok((await call('guest2', 'rentSlots', { roomId: rid, date: d1 })).data.slots.every(x => !x.free), '管理員可關閉整天');
  { // 開放規則（星期＋期間＋時段）與單日調整
    const d2 = addDays(d1, 1), wd2 = new Date(d2 + 'T12:00:00+08:00').getUTCDay(), d9 = addDays(d2, 7), n = async x => (await call('guest2', 'rentSlots', { roomId: rid, date: x })).data.slots.length;
    ok(await n(d2) === 0, '沒有規則的日子沒有時段');
    await call('boss', 'a.ruleSave', { roomId: rid, weekdays: [wd2], ranges: [['10:00', '12:00']] });
    let cal = (await call('boss', 'a.roomCal', { roomId: rid, month: d2.slice(0, 7) })).data, rule = cal.rules.find(x => x.weekdays.join() === String(wd2));
    ok(rule && !rule.from && !rule.to && await n(d2) === 2 && await n(d9) === 2 && cal.days.find(x => x.date === d2).rules[0] === rule.id && (await call('boss', 'a.rent')).data.rooms[0].rules.length === 2, '持續的每週規則');
    await call('boss', 'a.ruleSave', { roomId: rid, from: d2, to: d2, weekdays: [0, 1, 2, 3, 4, 5, 6], ranges: [['11:00', '14:00']] });
    ok(await n(d2) === 4 && await n(d9) === 2, '有期間的規則只在期間內生效，時段和其他規則加在一起');
    await call('boss', 'a.ruleSave', { id: rule.id, roomId: rid, weekdays: [wd2], ranges: [['10:00', '11:00']] });
    ok(await n(d9) === 1 && (await call('boss', 'a.roomCal', { roomId: rid, month: d9.slice(0, 7) })).data.rules.find(x => x.id === rule.id).ranges[0][1] === '11:00', '規則可以再打開修改');
    await call('boss', 'a.roomHours', { roomId: rid, date: d9, scope: 'date', ranges: [] });
    ok(await n(d9) === 0 && await n(d2) === 4 && (await call('boss', 'a.roomCal', { roomId: rid, month: d9.slice(0, 7) })).data.days.find(x => x.date === d9).custom, '單日設為不開放，不影響規則');
    await call('boss', 'a.roomHours', { roomId: rid, date: d9, scope: 'reset' });
    ok(await n(d9) === 1, '取消單日調整後回到規則');
    ok(/至少選一個開放/.test((await call('boss', 'a.ruleSave', { roomId: rid, weekdays: [1], ranges: [] })).error) && /不能早於/.test((await call('boss', 'a.ruleSave', { roomId: rid, weekdays: [1], from: d9, to: d2, ranges: [['09:00', '10:00']] })).error), '規則驗證');
    const extra = (await call('boss', 'a.roomCal', { roomId: rid, month: d2.slice(0, 7) })).data.rules.find(x => x.from === d2);
    await call('boss', 'a.ruleDelete', { id: extra.id });
    ok(await n(d2) === 1, '刪除規則');
    await call('boss', 'a.roomSave', { id: rid, name: 'A教室', price: 400, capacity: 20 });
    ok(await n(d2) === 1 && (await call('guest2', 'rentInfo')).data.rooms[0].dates.includes(d2), '編輯教室基本資料不會清掉開放規則');
  }
  p0 = pushes.length; r = await call('guest', 'rentCancel', { id: bid });
  ok(r.ok && pushes.length === p0 + 1 && (await call('boss', 'a.rent')).data.bookings.find(x => x.id === bid).status === '已取消' && (await call('guest2', 'rentCancel', { id: bid })).ok === false, '預約人可取消自己的預約並通知管理員');
  ok(/未完成的預約/.test((await call('boss', 'a.roomDelete', { id: rid })).error), '還有預約的教室不能刪除');
  await call('boss', 'a.courseDelete', { id: c.id });
  await call('boss', 'a.roomSave', { id: rid, name: 'A教室', status: '關閉' });
}

{ // 圖文選單：多頁、換頁、自訂格子、回覆內容
  let mn = (await call('boss', 'a.menu')).data;
  ok(mn.pages.length === 2 && mn.pages[0].cells.length === 6 && mn.pages[0].cells[2].type === 'url' && mn.pages[1].cells.every(c => c.type === 'fn') && /僅限管理員/.test((await call('teacher', 'a.menu')).error), '預設帶入原選單六格與教室功能頁');
  ok(mn.pages.every(p => !p.image) && mn.pages[0].cells[0].icon === 'info' && mn.pages[1].cells[0].icon === 'qr' && mn.pages[1].cells[0].hl === true && mn.theme === 'pink', '預設頁面由系統繪製，帶圖示與小字');
  ok((await call('boss', 'a.menuTheme', { theme: 'warm' })).ok && (await call('boss', 'a.menu')).data.theme === 'warm' && !(await call('boss', 'a.menuTheme', { theme: 'x' })).ok, '可切換選單配色');
  const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 7)]).toString('base64');
  ok(/只能上傳/.test((await call('boss', 'a.upload', { data: Buffer.from('hello world').toString('base64') })).error), '只接受圖片與 PDF');
  await call('boss', 'a.upload', { data: jpg.slice(0, 2000), part: { id: 'u1', i: 0, n: 2 } });
  r = await call('boss', 'a.upload', { data: jpg.slice(2000), part: { id: 'u1', i: 1, n: 2 } });
  ok(r.data.ext === 'jpg' && r.data.size === 3004, '分段上傳後組合'); const f1 = r.data.path, f2 = (await call('boss', 'a.upload', { data: jpg })).data.path;
  r = await call('boss', 'a.replySave', { name: '租借方式及須知', keywords: '租借方式及須知，怎麼租', text: '每小時 400 元，請提前預約。', images: ['https://x.test/files/a.jpg'], buttons: [{ label: '下載場地須知', url: 'https://x.test/files/rule.pdf' }] });
  const rid = r.data.id; ok(!(await call('boss', 'a.replySave', { name: 'x', text: 't', buttons: [{ label: '壞的', url: 'javascript:1' }] })).ok, '非 https 連結會被拒絕'); mn = (await call('boss', 'a.menu')).data;
  ok(mn.replies[0].buttons.length === 1 && mn.replies[0].keywords === '租借方式及須知,怎麼租', '建立回覆內容（不合法的連結被濾掉）');
  const p1 = mn.pages[0];
  ok(/https/.test((await call('boss', 'a.menuPageSave', { ...p1, cells: [{ type: 'url', value: 'ftp://x' }] })).error), '連結格式檢查');
  await call('boss', 'a.menuPageSave', { ...p1, image: f1, cells: p1.cells.map((c, i) => i ? c : { label: '租借方式及須知', type: 'reply', value: rid }) });
  const n0 = pushes.length;
  r = await call('boss', 'a.menuPublish', { images: { [p1.id]: f1, [mn.pages[1].id]: f2 } });
  const made = pushes.slice(n0).filter(x => /\/v2\/bot\/richmenu$/.test(x.url)).map(x => x.body), sw = made[0].areas.filter(a => a.action.type === 'richmenuswitch');
  ok(r.ok && r.data.pages === 2 && made.length === 2 && made[0].areas.length === 7 && sw.length === 2 && sw[0].bounds.y === 1484 && made[0].areas[0].action.type === 'postback' && made[0].areas[0].bounds.x === 150 && made[0].areas[1].action.type === 'message'
    && made[1].areas.filter(a => a.action.type === 'uri').length === 8 && pushes.slice(n0).some(x => /user\/all\/richmenu\//.test(x.url)) && pushes.slice(n0).filter(x => /richmenu\/alias$/.test(x.url)).length === 2 && (await call('boss', 'a.menu')).data.publishedAt, '發布兩頁選單：格子動作、上一頁／下一頁、預設選單');
  const uidM = (await call('mom', 'init')).data.userId, sign = bd => crypto.createHmac('sha256', 'sec').update(bd).digest('base64');
  let bd = JSON.stringify({ events: [{ type: 'postback', replyToken: 'r', postback: { data: 'reply:' + rid }, source: { userId: uidM } }] }), n1 = pushes.length; await app.webhook(bd, sign(bd));
  let ms = pushes[n1] && pushes[n1].body.messages;
  ok(ms && ms.length === 2 && ms[0].type === 'image' && ms[1].type === 'flex' && ms[1].contents.footer.contents[0].action.uri.endsWith('rule.pdf'), '點選單回覆圖片與檔案按鈕');
  bd = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: '怎麼租' }, source: { userId: 'Ustranger' } }] }); n1 = pushes.length; await app.webhook(bd, sign(bd));
  ok(pushes.length === n1 + 1 && pushes[n1].body.messages[0].type === 'image', '輸入關鍵字也會回覆（未綁定的人也可以）');
  bd = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: '課程資訊' }, source: { userId: uidM } }] }); n1 = pushes.length; await app.webhook(bd, sign(bd));
  ok(pushes.length === n1, '選單「傳送文字」的格子，系統不重複回覆');
  ok(/還有格子在用/.test((await call('boss', 'a.replyDelete', { id: rid })).error), '使用中的回覆內容不能刪');
  await call('boss', 'a.menuPageMove', { id: p1.id, dir: 1 });
  ok((await call('boss', 'a.menu')).data.pages[1].id === p1.id && (await call('boss', 'a.menuUnpublish')).ok && !(await call('boss', 'a.menu')).data.publishedAt, '調整頁面順序、停用選單');
}

// Webhook
const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: '剩幾堂' }, source: { userId: (await call('mom', 'init')).data.userId } }] });
const sig = crypto.createHmac('sha256', 'sec').update(body).digest('base64');
ok((await app.webhook(body, 'wrong')) === false, 'Webhook 簽章錯誤被拒');
const pw = pushes.length; ok((await app.webhook(body, sig)) === true && pushes.length === pw + 1 && /剩餘 9 堂/.test(pushes[pw].body.messages[0].altText), 'Webhook 回覆堂數卡片');
const walk = o => { if (o && typeof o === 'object') { if (o.type === 'text' && (typeof o.text !== 'string' || !o.text.length)) throw new Error('empty'); Object.values(o).forEach(walk); } };
let bad = ''; try { pushes.forEach(p => p.body && p.body.messages && p.body.messages.forEach(walk)); } catch (e) { bad = e.message; } ok(!bad, '所有 Flex 文字非空');
{ // 上課卡限定課程：一張卡可上多門課，扣堂只扣適用的卡
  const cs = (await call('boss', 'a.meta')).data.courses, [cA, cB, cC] = [0, 1, 2].map(n => cs[n] ? cs[n].id : (cs[0].id));
  const c2 = (await call('boss', 'a.courseSave', { name: '限定測試甲', weekdays: [1, 2, 3, 4, 5, 6, 0], start: '06:00', end: '06:30', teacher: 'T' })).data.id, c3 = (await call('boss', 'a.courseSave', { name: '限定測試乙', weekdays: [1, 2, 3, 4, 5, 6, 0], start: '07:00', end: '07:30', teacher: 'T' })).data.id;
  const sid = (await call('boss', 'a.studentSave', { name: '限定生', courses: [c2, c3] })).data.id;
  ok((await call('boss', 'a.planSave', { name: '甲班卡', lessons: 5, price: 2000, validDays: 30, courses: [c2, 'nope'] })).ok, '方案可設定適用課程');
  const plans = (await call('boss', 'a.plans')).data, pA = plans.find(p => p.name === '甲班卡');
  ok(pA.courses === c2 && pA.scope === '限定測試甲' && plans[0].scope === '全部課程', '方案顯示適用課程，沒設定＝全部課程');
  await call('boss', 'a.topup', { studentId: sid, planId: pA.id, price: 2000 });
  const day = (await call('boss', 'a.meta')).data.today, wk = (await call('boss', 'a.week', { start: day, days: 7 })).data.sessions, s2 = wk.find(x => x.courseId === c2).sessionId, s3 = wk.find(x => x.courseId === c3).sessionId;
  r = await call('boss', 'a.mark', { sessionId: s3, studentId: sid, status: '出席' });
  ok(r.data.deduct === 0 && /沒有適用這門課/.test(r.data.note) && r.data.remain === 0, '卡片不適用的課不扣堂並提示');
  let ro = (await call('boss', 'a.roster', { sessionId: s3 })).data.list.find(x => x.id === sid);
  ok(ro.remain === 0 && ro.other === 5 && !ro.cards.length, '點名單顯示這門課沒有適用的卡');
  r = await call('boss', 'a.mark', { sessionId: s2, studentId: sid, status: '出席' });
  ok(r.data.deduct === 1 && r.data.remain === 4, '適用的課正常扣堂');
  await call('boss', 'a.topup', { studentId: sid, planId: plans[0].id, lessons: 3, price: 100, expire: day, courses: [c2, c3] }); // 今天到期 → 比甲班卡早到期
  const cards = (await call('boss', 'a.student', { id: sid })).data.cards, kMulti = cards.find(c => c.courses.split(',').length === 2), kA = cards.find(c => c.courses === c2);
  ok(kMulti && kMulti.scope === '限定測試甲、限定測試乙', '一張卡可適用多門課');
  await call('boss', 'a.mark', { sessionId: s2, studentId: sid, status: '取消' });
  r = await call('boss', 'a.mark', { sessionId: s2, studentId: sid, status: '出席' });
  ro = (await call('boss', 'a.roster', { sessionId: s2 })).data.list.find(x => x.id === sid);
  ok(ro.cardId === kMulti.id && ro.cards.length === 2 && ro.remain === 7, '多張適用時先扣最快到期的那張');
  ok((await call('boss', 'a.attCard', { sessionId: s2, studentId: sid, cardId: kA.id })).ok && (await call('boss', 'a.roster', { sessionId: s2 })).data.list.find(x => x.id === sid).cardId === kA.id, '可改扣另一張卡');
  const after = (await call('boss', 'a.student', { id: sid })).data.cards;
  ok(after.find(c => c.id === kMulti.id).remain === 3 && after.find(c => c.id === kA.id).remain === 4, '改扣後原卡退回、新卡扣除');
  ok(/不適用/.test((await call('boss', 'a.attCard', { sessionId: s2, studentId: sid, cardId: 'nope' })).error) && /僅限管理員/.test((await call('teacher', 'a.attCard', { sessionId: s2, studentId: sid, cardId: kA.id })).error), '不能改扣不適用的卡，老師不能換卡');
  await call('boss', 'a.cardSave', { id: kA.id, remain: 4, expire: '', courses: [] });
  ok((await call('boss', 'a.student', { id: sid })).data.cards.find(c => c.id === kA.id).scope === '全部課程', '可把卡改回全部課程通用');
  await call('boss', 'a.courseSave', { id: c2, name: '限定測試甲', weekdays: [1], start: '06:00', end: '06:30', status: '停開' }); await call('boss', 'a.courseSave', { id: c3, name: '限定測試乙', weekdays: [1], start: '07:00', end: '07:30', status: '停開' });
  await call('boss', 'a.studentSave', { id: sid, name: '限定生', status: '停用', courses: [] });
}
{ // 教室清單與課程同步
  const m0 = (await call('boss', 'a.meta')).data, rm = (await call('boss', 'a.rent')).data.rooms[0];
  ok(Array.isArray(m0.rooms) && m0.rooms.includes(rm.name) && m0.teachers.length > 0 && m0.teachers.every(t => t.name && t.color), '後台取得教室清單與老師名單（既有課程的老師自動帶入）');
  const th = (await call('boss', 'a.teacherSave', { name: '測試老師甲' })).data, tc = (await call('boss', 'a.courseSave', { name: '老師同步', weekdays: [1], start: '04:00', end: '04:30', teacher: '測試老師甲' })).data.id;
  ok(!(await call('boss', 'a.teacherSave', { name: '測試老師甲' })).ok && /僅限管理員/.test((await call('teacher', 'a.teacherSave', { name: 'x' })).error), '老師不能重名，只有管理員能管理');
  await call('boss', 'a.teacherSave', { id: th.id, name: '測試老師乙', title: 'K-POP', intro: '教學八年', photo: '/files/abc.jpg', images: ['/files/a1.jpg', 'http://bad'], works: [{ label: '成果發表', url: 'https://youtu.be/x' }] });
  const tp = (await call('boss', 'a.meta')).data.teachers.find(t => t.id === th.id);
  ok(tp.title === 'K-POP' && tp.photo === '/files/abc.jpg' && tp.images.length === 1 && tp.works[0].label === '成果發表' && !(await call('boss', 'a.teacherSave', { id: th.id, name: '測試老師乙', works: [{ label: 'x', url: 'javascript:1' }] })).ok, '老師可設定照片、專長、介紹與作品');
  { const kid = (await call('mom', 'init')).data.students[0].id, sc = (await call('mom', 'schedule', { studentId: kid })).data; ok(sc.teachers['測試老師乙'] && sc.teachers['測試老師乙'].intro === '教學八年' && !('color' in sc.teachers['測試老師乙']), '家長課表可取得有填介紹的老師資料'); }
  ok((await call('boss', 'a.meta')).data.courses.find(c => c.id === tc).teacher === '測試老師乙' && /停用/.test((await call('boss', 'a.teacherDelete', { id: th.id })).error), '老師改名時課程一起更新，還有課程時不能刪除');
  await call('boss', 'a.courseSave', { name: '自動加入', id: tc, weekdays: [1], start: '04:00', end: '04:30', teacher: '臨時新老師' });
  ok((await call('boss', 'a.meta')).data.teachers.some(t => t.name === '臨時新老師') && (await call('boss', 'a.teacherDelete', { id: th.id })).ok, '課程填了新名字會自動進名單；沒課程的老師可刪除');
  await call('boss', 'a.courseDelete', { id: tc });
  const cid = (await call('boss', 'a.courseSave', { name: '同步測試', weekdays: [1], start: '05:00', end: '05:30', room: rm.name })).data.id;
  await call('boss', 'a.roomSave', { id: rm.id, name: rm.name + '改', capacity: rm.capacity, price: rm.price, unit: rm.unit, intro: rm.intro, status: rm.status });
  ok((await call('boss', 'a.meta')).data.courses.find(c => c.id === cid).room === rm.name + '改', '教室改名時課程一起更新');
  await call('boss', 'a.roomSave', { id: rm.id, name: rm.name, capacity: rm.capacity, price: rm.price, unit: rm.unit, intro: rm.intro, status: rm.status });
  await call('boss', 'a.courseDelete', { id: cid });
}
{ // 上線前清除測試資料
  const before = (await call('boss', 'a.resetInfo')).data, stu = (await call('boss', 'a.students')).data.length;
  ok(before.groups.find(g => g.key === 'money').count > 0 && /僅限管理員/.test((await call('teacher', 'a.resetData', { groups: ['money'], confirm: '清除' })).error) && !(await call('boss', 'a.resetData', { groups: ['money'], confirm: 'x' })).ok, '清除資料需管理員且要輸入確認字');
  r = await call('boss', 'a.resetData', { groups: ['money'], confirm: '清除' });
  const after = (await call('boss', 'a.resetInfo')).data;
  ok(r.ok && r.data.removed > 0 && after.groups.find(g => g.key === 'money').count === 0 && after.groups.find(g => g.key === 'attend').count === before.groups.find(g => g.key === 'attend').count && after.keep.students === before.keep.students && (await call('boss', 'a.students')).data.length === stu && after.keep.courses === before.keep.courses, '只清帳務：學生、課程、出席紀錄都還在');
  ok((await call('boss', 'a.resetData', { groups: ['attend', 'signup', 'rent'], confirm: '清除' })).ok && (await call('boss', 'a.resetInfo')).data.groups.every(g => g.count === 0), '可再清除出席、報名、租借');
}
console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS'); process.exit(fail ? 1 : 0);
