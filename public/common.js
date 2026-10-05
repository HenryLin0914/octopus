// 家長端與後台共用：登入、API 呼叫、小工具
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const dAdd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dDay = d => new Date(d + 'T00:00:00Z').getUTCDay();
const dLabel = d => d.slice(5).replace('-', '/') + '（' + WD[dDay(d)] + '）';

function toast(m, bad) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = m; t.className = bad ? 'bad show' : 'show';
  clearTimeout(toast.h); toast.h = setTimeout(() => t.className = '', 3000);
}
let _busy = 0;
function loading(on) {
  let l = $('#load');
  if (!l) { l = document.createElement('div'); l.id = 'load'; l.innerHTML = '<span></span>'; document.body.appendChild(l); }
  _busy = Math.max(0, _busy + (on ? 1 : -1)); l.className = _busy ? 'show' : '';
}

const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 私密模式 */ } } };
let TOKEN = store.get('octo_token');
const DEV_USER = CONFIG.DEV ? new URLSearchParams(location.search).get('dev') : null;

async function raw(body) {
  const r = await fetch(CONFIG.API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '發生錯誤');
  return j.data;
}
async function login() {
  if (DEV_USER) { TOKEN = (await raw({ action: 'devLogin', userId: DEV_USER, name: DEV_USER })).token; return; }
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); await new Promise(() => {}); }
  try { TOKEN = (await raw({ action: 'login', idToken: liff.getIDToken(), prev: store.get('octo_prev') || store.get('octo_token') || undefined })).token; store.set('octo_token', TOKEN); store.set('octo_prev', null); }
  catch (e) {
    if (e.message !== 'AUTH') throw e;
    if (liff.isInClient()) throw new Error('登入已過期，請關閉後重新開啟');
    liff.logout(); liff.login({ redirectUri: location.href }); await new Promise(() => {});
  }
}
/** 啟動：初始化 LIFF 並確保已登入 */
async function boot() {
  if (!DEV_USER) await liff.init({ liffId: CONFIG.LIFF_ID });
  if (!TOKEN || DEV_USER) await login();
}
async function api(action, data, quiet) {
  if (!quiet) loading(true);
  try {
    try { return await raw({ action, token: TOKEN, ...(data || {}) }); }
    catch (e) {
      if (e.message !== 'AUTH') throw e;
      if (TOKEN) store.set('octo_prev', TOKEN); // 留著舊憑證：換官方帳號後，伺服器用它把舊 ID 的資料轉到新 ID
      TOKEN = null; store.set('octo_token', null);
      await login();
      return await raw({ action, token: TOKEN, ...(data || {}) });
    }
  } finally { if (!quiet) loading(false); }
}
function openUrl(url) {
  if (!/^https?:\/\//.test(url)) return;
  if (window.liff && !DEV_USER && liff.isInClient()) liff.openWindow({ url, external: true }); else window.open(url, '_blank', 'noopener');
}
