// 酒窖照片小程式（Cloudflare Worker）
// 看照片：任何人都可以（跟現在一樣）。上傳、刪除：要帶酒窖裝置的 GitHub 權杖，而且這個權杖要能寫入 comfort527/wine-cellar。
// 需要的設定：R2 繫結，變數名稱 PHOTOS。
const REPO = 'comfort527/wine-cellar';
const ORIGINS = ['https://comfort527.github.io'];
const MAX_BYTES = 5 * 1024 * 1024;
const okKey = k => /^images\/[\w.-]+\.(jpe?g|png|webp)$/i.test(k) && !k.includes('..');
const seen = new Map(); // 權杖驗證結果暫存 10 分鐘，不用每張照片都問 GitHub

function cors(req) {
  const o = req.headers.get('Origin') || '';
  const allow = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return allow ? {'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin'} : {'Vary': 'Origin'};
}
const reply = (req, body, status = 200, extra = {}) => new Response(body, {status, headers: {...cors(req), ...extra}});

async function allowed(req) {
  const m = (req.headers.get('Authorization') || '').match(/^(?:Bearer|token)\s+(\S+)$/i);
  if (!m) return false;
  const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1])))].map(b => b.toString(16).padStart(2, '0')).join('');
  const hit = seen.get(id);
  if (hit && hit.until > Date.now()) return hit.ok;
  const r = await fetch(`https://api.github.com/repos/${REPO}`, {headers: {'Authorization': 'Bearer ' + m[1], 'Accept': 'application/vnd.github+json', 'User-Agent': 'wine-cellar-photos'}});
  const ok = r.ok && !!(await r.json()).permissions?.push;
  seen.set(id, {ok, until: Date.now() + (ok ? 600000 : 60000)});
  return ok;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), key = decodeURIComponent(url.pathname.slice(1));
    if (req.method === 'OPTIONS') return reply(req, null, 204);
    if (!key) return reply(req, 'ok', 200, {'Content-Type': 'text/plain; charset=utf-8'});
    if (!okKey(key)) return reply(req, 'not found', 404);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const obj = await env.PHOTOS.get(key);
      if (!obj) return reply(req, 'not found', 404, {'Cache-Control': 'no-store'});
      // 檔名每次上傳都不同（含時間），內容不會變，可以讓手機與 Cloudflare 長期記住
      return reply(req, req.method === 'HEAD' ? null : obj.body, 200, {'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Content-Length': String(obj.size), 'ETag': obj.httpEtag, 'Cache-Control': 'public, max-age=31536000, immutable'});
    }
    if (req.method === 'PUT' || req.method === 'DELETE') {
      if (!(await allowed(req))) return reply(req, 'forbidden', 403);
      if (req.method === 'DELETE') { await env.PHOTOS.delete(key); return reply(req, 'deleted'); }
      const len = Number(req.headers.get('Content-Length') || 0);
      if (len > MAX_BYTES) return reply(req, 'too large', 413);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_BYTES) return reply(req, 'bad size', 400);
      await env.PHOTOS.put(key, buf, {httpMetadata: {contentType: req.headers.get('Content-Type') || 'image/jpeg'}});
      return reply(req, 'saved', 201);
    }
    return reply(req, 'method not allowed', 405, {'Allow': 'GET, HEAD, PUT, DELETE, OPTIONS'});
  },
};
