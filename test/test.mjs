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

// Webhook
const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', message: { type: 'text', text: '剩幾堂' }, source: { userId: (await call('mom', 'init')).data.userId } }] });
const sig = crypto.createHmac('sha256', 'sec').update(body).digest('base64');
ok((await app.webhook(body, 'wrong')) === false, 'Webhook 簽章錯誤被拒');
const pw = pushes.length; ok((await app.webhook(body, sig)) === true && pushes.length === pw + 1 && /剩餘 9 堂/.test(pushes[pw].body.messages[0].altText), 'Webhook 回覆堂數卡片');
const walk = o => { if (o && typeof o === 'object') { if (o.type === 'text' && (typeof o.text !== 'string' || !o.text.length)) throw new Error('empty'); Object.values(o).forEach(walk); } };
let bad = ''; try { pushes.forEach(p => p.body && p.body.messages && p.body.messages.forEach(walk)); } catch (e) { bad = e.message; } ok(!bad, '所有 Flex 文字非空');
console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS'); process.exit(fail ? 1 : 0);
