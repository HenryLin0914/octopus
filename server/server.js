// HTTP 入口：靜態檔、/api、/webhook、/api/health
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, now } from './app.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const app = createApp({ publicDir: PUBLIC });
setInterval(() => { try { app.maintenance(); } catch (e) { console.error('maintenance', e.message); } }, 3600e3).unref();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, version: process.env.GIT_SHA || 'dev', time: now() }));
    if (url.pathname === '/api' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* 空白或格式錯誤 */ }
      return send(res, 200, JSON.stringify(await app.api(body)), undefined, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const ok = await app.webhook(await readBody(req), req.headers['x-line-signature']);
      return send(res, ok ? 200 : 401, JSON.stringify({ ok }));
    }
    if (url.pathname === '/config.js') { // 前端只需要 LIFF ID，後端網址同源
      return send(res, 200, 'const CONFIG = ' + JSON.stringify({ API: '/api', LIFF_ID: process.env.LIFF_ID || '', DEV: process.env.DEV_LOGIN === '1' }) + ';', TYPES['.js'], { 'Cache-Control': 'no-cache' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"ok":false}');
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    send(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(file), TYPES[ext] || 'application/octet-stream', { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  } catch (e) {
    console.error(e);
    send(res, 500, '{"ok":false,"error":"伺服器錯誤"}');
  }
}).listen(PORT, () => console.log('舞蹈教室報到系統已啟動，連接埠 ' + PORT));
