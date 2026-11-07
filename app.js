'use strict';
/* 紅酒收藏管理：資料存在公開 GitHub repo 的 data 分支。
   瀏覽免登入；管理時用「裝置密碼」解開加密存放的 GitHub 權杖，再透過 GitHub API 寫入。 */
const CFG = window.CELLAR_CONFIG;
const API = CFG.apiBase.replace(/\/$/, '');
const REPO = `/repos/${encodeURIComponent(CFG.owner)}/${encodeURIComponent(CFG.repo)}`;
const PBKDF2_ITER = 600000;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = v => v ? new Date(v).toLocaleString('zh-TW', {hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
const fmtPrice = v => (v === null || v === undefined || v === '') ? '—' : 'NT$ ' + Number(v).toLocaleString('zh-TW');
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();
const FIELDS = [['wineName','酒名'],['wineryRegion','酒莊／產區'],['vintage','年份'],['entryDate','入庫日期'],['volume','容量'],['source','來源'],['referencePrice','參考價格'],['origin','產地'],['drinkWindow','適飲期'],['grapeNotes','葡萄品種／備註']];

const S = {
  data: null, sha: null, etag: null, keys: null, keysSha: null, session: null,
  filter: null, search: '', view: 'list', 
  editing: null, stock: null, photo: null, photoBlob: null, newPhotoBlob: null, localPhotos: new Map(),
  sort: 'loc', drawer: null,
  busy: 0, lastPoll: 0, syncedAt: null, rawFallback: false, auditPage: 1, auditWine: '', audit: []
};
try { S.view = localStorage.getItem('cellarView') === 'grid' ? 'grid' : 'list'; S.sort = localStorage.getItem('cellarSort') || 'loc'; } catch {}

/* ---------- 小工具 ---------- */
let toastTimer;
function toast(m) { $('toast').textContent = m; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function notice(m, bad) { const n = $('notice'); n.textContent = m || ''; n.hidden = !m; n.classList.toggle('bad', !!bad); }
function showErr(id, m) { const e = $(id); e.textContent = m || ''; e.hidden = !m; }
function showDialog(id) { document.querySelectorAll('.ferr').forEach(e => e.hidden = true); $(id).showModal(); }
function fail(m) { const e = new Error(m); e.user = true; throw e; }
function msgOf(e) { return e?.user ? e.message : '操作未完成，請稍後再試。'; }
const canEdit = () => !!S.session;
const isAdmin = () => S.session?.role === 'admin';
const wines = () => S.data ? Object.entries(S.data.wines).map(([wineId, w]) => ({...w, wineId})).sort((a, b) => a.wineId < b.wineId ? -1 : 1) : [];
const active = () => wines().filter(w => w.status !== 'archived');
const byId = id => { const w = S.data?.wines[id]; return w ? {...w, wineId: id} : null; };
const total = w => (w.locations || []).reduce((a, l) => a + (Number(l.quantity) || 0), 0);
const nameOf = v => !v ? '—' : String(v).includes('@') ? String(v).split('@')[0] : String(v);
const siteUrl = () => location.origin + location.pathname;
const wineUrl = id => siteUrl() + '#' + id;
const locText = ls => (ls || []).map(l => `${l.cabinet}/${l.shelf}×${l.quantity}`).join('、') || '無';
const photoUrl = w => !w.photo ? '' : S.localPhotos.get(w.photo) || `${CFG.rawBase}/${CFG.owner}/${CFG.repo}/${CFG.dataBranch}/${w.photo.split('/').map(encodeURIComponent).join('/')}`;
function b64e(bytes) { let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function b64d(s) { return Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0)); }

/* ---------- GitHub API ---------- */
async function gh(path, {method = 'GET', body, headers = {}, auth = true, raw = false} = {}) {
  const h = {'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers};
  const token = auth === true ? S.session?.token : auth || null;
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
  try { return await fetch(API + path, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: ctl.signal}); }
  catch { fail('連不上 GitHub，請檢查網路後再試。'); }
  finally { clearTimeout(t); }
}
function authProblem(r) {
  if (r.status === 401) { if (S.session) { logout(true); } fail('權杖已失效或到期，請管理員在「裝置密碼」更換權杖。'); }
  if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') fail('GitHub 暫時限制存取次數，請過幾分鐘再試。');
  if (r.status === 403) fail('權杖沒有寫入這個 repo 的權限。請管理員確認權杖的 Contents 權限為 Read and write。');
}
/* 讀取 data 分支上的 JSON。回傳 {json, sha, etag}；304 回傳 'same'；檔案不存在回傳 null。 */
async function readJson(path, {etag = null, auth = true} = {}) {
  const r = await gh(`${REPO}/contents/${path}?ref=${encodeURIComponent(CFG.dataBranch)}`, {auth, headers: etag ? {'If-None-Match': etag} : {}});
  if (r.status === 304) return 'same';
  if (r.status === 404) return null;
  if (!r.ok) { if (!auth || !S.session) { const e = new Error('api'); e.status = r.status; throw e; } authProblem(r); fail('讀取資料失敗（' + r.status + '）。'); }
  const meta = await r.json();
  let content = meta.content;
  if (!content || meta.encoding === 'none') {
    const b = await gh(`${REPO}/git/blobs/${meta.sha}`, {auth});
    if (!b.ok) fail('讀取資料失敗。');
    content = (await b.json()).content;
  }
  return {json: JSON.parse(dec.decode(b64d(content))), sha: meta.sha, etag: r.headers.get('etag')};
}
async function readRaw(path) {
  const r = await fetch(`${CFG.rawBase}/${CFG.owner}/${CFG.repo}/${CFG.dataBranch}/${path}?t=${Date.now()}`, {cache: 'no-store'});
  if (r.status === 404) return null;
  if (!r.ok) fail('讀取資料失敗。');
  return {json: await r.json(), sha: null, etag: null};
}
/* 寫入檔案到 data 分支，產生一筆 commit。sha 不符時回傳 {conflict:true}。 */
async function putFile(path, bytes, sha, message, token) {
  const body = {message, content: b64e(bytes), branch: CFG.dataBranch};
  if (sha) body.sha = sha;
  const r = await gh(`${REPO}/contents/${path}`, {method: 'PUT', body, auth: token || true});
  if (r.ok) { const j = await r.json(); return {ok: true, sha: j.content?.sha}; }
  if (r.status === 409) return {conflict: true};
  if (r.status === 422) { const j = await r.json().catch(() => ({})); if (/sha/i.test(j.message || '')) return {conflict: true}; fail('GitHub 拒絕這次寫入：' + (j.message || r.status)); }
  if (r.status === 404) fail(`找不到 repo ${CFG.owner}/${CFG.repo} 或 ${CFG.dataBranch} 分支，請管理員確認設定。`);
  authProblem(r);
  fail('寫入失敗（' + r.status + '）。');
}
const jsonBytes = obj => enc.encode(JSON.stringify(obj, null, 1) + '\n');

/* 讀取酒款資料。管理模式用權杖讀（即時）；訪客先用公開 API，被限流時改讀 raw 檔（可能延遲數分鐘）。 */
async function loadData(force) {
  let res;
  try {
    if (S.session || !S.rawFallback) res = await readJson(CFG.dataPath, {etag: force ? null : S.etag, auth: !!S.session});
    else res = await readRaw(CFG.dataPath);
  } catch (e) {
    if (e.user) throw e;
    S.rawFallback = true; res = await readRaw(CFG.dataPath);
  }
  S.syncedAt = now();
  if (res === 'same') return false;
  const json = res ? res.json : {schema: 1, rev: 0, catalog: {cabinets: [], shelves: []}, wines: {}};
  if (S.data && (json.rev || 0) < (S.data.rev || 0)) return false; // GitHub 偶爾回舊版本，忽略
  S.data = json; S.sha = res?.sha || null; S.etag = res?.etag || null;
  return true;
}
async function loadKeys() {
  let res;
  try { res = await readJson(CFG.keysPath, {auth: !!S.session}); }
  catch (e) { if (e.user) throw e; res = await readRaw(CFG.keysPath); }
  S.keys = res ? res.json : null; S.keysSha = res?.sha || null;
}

/* 寫入：每次都讀最新版本、套用變更、帶 sha 寫回；有人同時修改就自動重試。 */
async function mutate(fn, message) {
  if (!S.session) fail('請先登入管理。');
  S.busy++;
  try {
    for (let i = 0; i < 4; i++) {
      const cur = await readJson(CFG.dataPath);
      const base = cur ? cur.json : {schema: 1, rev: 0, catalog: {cabinets: [], shelves: []}, wines: {}};
      if (S.data && (base.rev || 0) < (S.data.rev || 0)) { await sleep(800 * (i + 1)); continue; }
      const draft = structuredClone(base);
      const result = fn(draft);
      draft.rev = (base.rev || 0) + 1; draft.updatedAt = now();
      const title = typeof message === 'function' ? message(result, draft) : message;
      const r = await putFile(CFG.dataPath, jsonBytes(draft), cur?.sha, `${title}\n\n操作者：${S.session.label}`);
      if (r.ok) { S.data = draft; S.sha = r.sha; S.etag = null; S.syncedAt = now(); render(); return result; }
      await sleep(500 * (i + 1));
    }
    fail('同時有其他人在修改，請再試一次。');
  } finally { S.busy--; }
}

/* ---------- 裝置密碼（加密） ---------- */
async function pwKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(key, bytes) { const iv = crypto.getRandomValues(new Uint8Array(12)); return {iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, bytes))}; }
async function open_(key, o) { return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: b64d(o.iv)}, key, b64d(o.ct))); }
async function makeSlot(label, role, pass, dataKey) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapped = await seal(await pwKey(pass, salt, PBKDF2_ITER), dataKey);
  return {id: crypto.randomUUID(), label, role, salt: b64e(salt), ...wrapped, createdAt: now()};
}
function checkPass(p, p2) {
  if (p.length < 10) fail('密碼至少要 10 個字元。');
  if (p2 !== undefined && p !== p2) fail('兩次輸入的密碼不一樣。');
}
async function checkToken(token) {
  const r = await gh(REPO, {auth: token});
  if (r.status === 401) fail('權杖無效或已到期。');
  if (r.status === 404) fail(`這個權杖看不到 ${CFG.owner}/${CFG.repo}，請確認權杖授權了這個 repo。`);
  if (!r.ok) fail('無法驗證權杖（' + r.status + '）。');
}
async function saveKeys(keys, message, token) {
  for (let i = 0; i < 3; i++) {
    const r = await putFile(CFG.keysPath, jsonBytes(keys), S.keysSha, `${message}\n\n操作者：${S.session?.label || keys.slots[0]?.label || '初始設定'}`, token);
    if (r.ok) { S.keys = keys; S.keysSha = r.sha; return; }
    await loadKeys(); fail('裝置密碼剛被其他人修改，請重新操作一次。');
  }
}

/* ---------- 登入狀態 ---------- */
function saveSession(s, remember) {
  S.session = s;
  const v = JSON.stringify(s);
  try { localStorage.removeItem('cellarSession'); sessionStorage.removeItem('cellarSession'); (remember ? localStorage : sessionStorage).setItem('cellarSession', v); localStorage.setItem('cellarSlot', s.slotId); } catch {}
}
function restoreSession() {
  try { const v = localStorage.getItem('cellarSession') || sessionStorage.getItem('cellarSession'); if (v) S.session = JSON.parse(v); } catch {}
}
function logout(silent) {
  S.session = null;
  try { localStorage.removeItem('cellarSession'); sessionStorage.removeItem('cellarSession'); } catch {}
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (!silent) toast('已登出，目前為瀏覽模式。');
  render();
}

/* ---------- 啟動 ---------- */
start();
async function start() {
  if (!CFG.owner || CFG.owner === 'YOUR_GITHUB_ACCOUNT') { notice('尚未設定資料 repo：請在 config.js 填入 GitHub 帳號與 repo 名稱。', true); render(); return; }
  $('repoName').textContent = `${CFG.owner}/${CFG.repo}`;
  $('repoName').href = `https://github.com/${CFG.owner}/${CFG.repo}/commits/${CFG.dataBranch}`;
  $('repoLink').href = `https://github.com/${CFG.owner}/${CFG.repo}/commits/${CFG.dataBranch}`;
  restoreSession();
  wire();
  try {
    await loadKeys();
    if (S.session && !S.keys?.slots?.some(s => s.id === S.session.slotId)) { logout(true); notice('這台裝置的密碼已被刪除，請重新登入。', true); }
    await loadData(true);
    notice(S.rawFallback ? 'GitHub 暫時限制訪客讀取次數，畫面可能慢幾分鐘才更新；登入管理後即時同步。' : '');
  } catch (e) { notice(msgOf(e), true); }
  render();
  readHash();
  setInterval(poll, 5000);
  setInterval(renderSync, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });
}
async function poll(force) {
  if (document.hidden || S.busy || !S.data) return;
  const every = (S.session ? CFG.pollSecondsEditor : CFG.pollSecondsViewer) * 1000;
  if (!force && Date.now() - S.lastPoll < every) return;
  S.lastPoll = Date.now();
  try { if (await loadData(false)) render(); else renderSync(); } catch {}
}
function readHash() {
  const m = /^#(W\d{3,}|H\d{3,})$/.exec(location.hash);
  if (m && byId(m[1])) openDrawer(m[1], true);
  else if (!m && $('drawer').open) $('drawer').close();
}
addEventListener('hashchange', readHash);

/* ---------- 畫面 ---------- */
const shelfNo = s => { const m = /\d+/.exec(s || ''); return m ? Number(m[0]) : 999; };
const isWhite = w => /白酒|white|riesling|sauvignon blanc|chardonnay/i.test(`${w.grapeNotes} ${w.wineName}`);
function renderSync() {
  const el = $('sync'), every = (S.session ? CFG.pollSecondsEditor : CFG.pollSecondsViewer) * 1000;
  const age = S.syncedAt ? Date.now() - new Date(S.syncedAt).getTime() : Infinity;
  el.classList.toggle('live', age < every * 2 + 10000);
  el.classList.toggle('stale', age >= every * 2 + 10000 && age !== Infinity);
  $('syncText').textContent = !S.syncedAt ? '讀取中' : S.rawFallback && !S.session ? '可能延遲幾分鐘' : `已同步 ${new Date(S.syncedAt).toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'})}`;
  el.title = S.session ? `每 ${CFG.pollSecondsEditor} 秒自動同步` : `每 ${CFG.pollSecondsViewer} 秒自動同步`;
}
function render() {
  const setup = !!S.data && !S.keys;
  $('whoPill').innerHTML = S.session ? `<b>${esc(S.session.label)}</b> · ${isAdmin() ? '管理員' : '編輯者'}` : '訪客瀏覽';
  $('loginBtn').hidden = !!S.session || (!S.keys && !setup);
  $('loginBtn').textContent = setup ? '初始設定' : '管理登入';
  $('logoutBtn').hidden = !S.session;
  $('adminBtn').hidden = !S.session;
  $('addBtn').hidden = !canEdit();
  $('fab').hidden = !canEdit();
  $('viewList').classList.toggle('on', S.view !== 'grid'); $('viewList').setAttribute('aria-pressed', S.view !== 'grid');
  $('viewGrid').classList.toggle('on', S.view === 'grid'); $('viewGrid').setAttribute('aria-pressed', S.view === 'grid');
  $('sortSel').value = S.sort;
  renderSync();
  const list = active();
  // 總覽
  $('sumBottles').textContent = S.data ? list.reduce((a, w) => a + total(w), 0) : '—';
  $('sumWines').textContent = S.data ? list.length + ' 款' : '—';
  const years = list.map(w => Number(w.vintage)).filter(y => y > 1800);
  $('sumOldest').textContent = years.length ? Math.min(...years) : '—';
  const origins = new Set(list.map(w => (w.origin || '').split(/[,，]/)[0].trim()).filter(Boolean));
  $('sumOrigins').textContent = origins.size ? origins.size + ' 國' : '—';
  const last = S.data?.updatedAt || wines().reduce((m, w) => w.updatedAt > m ? w.updatedAt : m, '');
  $('lastMod').innerHTML = last ? `${new Date(last).toLocaleDateString('zh-TW', {month: 'numeric', day: 'numeric'})} <small>${new Date(last).toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'})}</small>` : '—';
  renderMap(list);
  renderList(list);
  if ($('drawer').open && S.drawer) renderDrawer();
}
function renderMap(list) {
  const cabs = new Map();
  for (const c of S.data?.catalog?.cabinets || []) cabs.set(c, new Map());
  for (const w of list) for (const l of w.locations || []) {
    if (!cabs.has(l.cabinet)) cabs.set(l.cabinet, new Map());
    const sh = cabs.get(l.cabinet), cur = sh.get(l.shelf) || {red: 0, white: 0, wines: 0};
    if (l.quantity > 0) { cur[isWhite(w) ? 'white' : 'red'] += l.quantity; cur.wines++; }
    sh.set(l.shelf, cur);
  }
  const html = [...cabs].filter(([, sh]) => sh.size).map(([cab, sh]) => {
    const sum = [...sh.values()].reduce((a, s) => a + s.red + s.white, 0);
    const on = S.filter?.cabinet === cab;
    const shelves = [...sh].sort((a, b) => shelfNo(a[0]) - shelfNo(b[0])).map(([name, s]) => {
      const n = s.red + s.white, cap = 28, red = Math.min(s.red, cap), white = Math.min(s.white, cap - red);
      const dots = '<i></i>'.repeat(red) + '<i class="w"></i>'.repeat(white) + (n > cap ? `<em>+${n - cap}</em>` : '');
      const sel = on && S.filter.shelf === name;
      return `<button class="shelf ${sel ? 'on' : ''} ${n ? '' : 'zero'}" data-cab="${esc(cab)}" data-shelf="${esc(name)}" aria-pressed="${sel}" aria-label="${esc(cab)} ${esc(name)}：${n} 瓶，${s.wines} 款"><span class="no">${shelfNo(name) < 999 ? shelfNo(name) : esc(name)}</span><span class="dots">${dots}</span><span class="c">${n}</span></button>`;
    }).join('');
    return `<div class="cab ${on && !S.filter.shelf ? 'on' : ''}"><button class="cab-h" data-cab="${esc(cab)}" aria-pressed="${on && !S.filter.shelf}"><b>${esc(cab)}</b><span>${sum} 瓶 · ${sh.size} 層</span></button>${shelves}</div>`;
  }).join('');
  $('map').innerHTML = html ? html + '' : '<p class="hint">還沒有存放位置。</p>';
  if (html && !$('mapLegend')) $('map').insertAdjacentHTML('afterend', '<div class="map-legend" id="mapLegend"><span><i style="background:var(--dot)"></i>紅酒</span><span><i style="background:var(--glass)"></i>白酒</span></div>');
}
function sortWines(rows) {
  const k = S.sort;
  const firstLoc = w => { const l = (w.locations || []).find(x => x.quantity > 0) || {}; return [l.cabinet || '', shelfNo(l.shelf)]; };
  return rows.sort((a, b) => {
    if (k === 'vintage') return (Number(a.vintage) || 9999) - (Number(b.vintage) || 9999) || a.wineId.localeCompare(b.wineId);
    if (k === 'qty') return total(b) - total(a) || a.wineId.localeCompare(b.wineId);
    if (k === 'name') return a.wineName.localeCompare(b.wineName, 'en');
    if (k === 'loc') { const [ca, sa] = firstLoc(a), [cb, sb] = firstLoc(b); return ca.localeCompare(cb) || sa - sb || a.wineId.localeCompare(b.wineId); }
    return a.wineId.localeCompare(b.wineId);
  });
}
function renderList(list) {
  $('filterBar').hidden = !S.filter;
  if (S.filter) $('filterText').textContent = `只顯示 ${S.filter.cabinet}${S.filter.shelf ? ' · ' + S.filter.shelf : ''}`;
  const q = S.search.trim().toLowerCase();
  const rows = sortWines(list.filter(w => {
    if (S.filter && !(w.locations || []).some(l => l.quantity > 0 && l.cabinet === S.filter.cabinet && (!S.filter.shelf || l.shelf === S.filter.shelf))) return false;
    if (!q) return true;
    return [w.wineId, ...FIELDS.map(f => w[f[0]]), ...(w.locations || []).map(l => l.cabinet + ' ' + l.shelf)].join(' ').toLowerCase().includes(q);
  }));
  $('countText').textContent = S.data ? (rows.length === list.length ? `共 ${list.length} 款` : `${rows.length} / ${list.length} 款`) : '';
  const el = $('list');
  el.className = 'rows' + (S.view === 'grid' ? ' grid' : '');
  el.innerHTML = rows.map(w => S.view === 'grid' ? cardHtml(w) : rowHtml(w)).join('');
  el.hidden = !rows.length;
  const empty = $('empty');
  empty.hidden = !!rows.length;
  if (rows.length) return;
  if (!S.data) empty.innerHTML = '<h3>讀取中</h3><p>連上 GitHub 後，這裡會列出每一款酒。</p>';
  else if (!list.length) empty.innerHTML = canEdit() ? '<h3>酒窖還是空的</h3><p>按「＋ 新增酒款」登記第一瓶。</p>' : '<h3>酒窖還是空的</h3>';
  else empty.innerHTML = '<h3>沒有符合的酒款</h3><p>換個關鍵字，或按「顯示全部」。</p>';
}
function vinHtml(w) { const v = String(w.vintage || '').trim(); return /^\d{4}$/.test(v) ? `<span class="vin">${v}</span>` : `<span class="vin nv">${esc(v || 'NV')}</span>`; }
function rowHtml(w) {
  const t = total(w);
  const locs = (w.locations || []).filter(l => l.quantity > 0).map(l => `<span>${esc(l.cabinet)} · ${esc(l.shelf)}${(w.locations || []).filter(x => x.quantity > 0).length > 1 ? ` ×${l.quantity}` : ''}</span>`).join('');
  return `<button class="row" data-open="${esc(w.wineId)}">
   ${vinHtml(w)}
   <span class="nm"><b>${esc(w.wineName)}</b><span>${esc(w.wineryRegion || '')}${w.wineryRegion && w.origin ? ' · ' : ''}${esc(w.origin || '')}</span></span>
   <span class="lc">${locs || '<span>無庫存</span>'}</span>
   <span class="qt">${t}<small>${esc(w.volume || '瓶')}</small></span></button>`;
}
function cardHtml(w) {
  const p = photoUrl(w);
  return `<button class="card" data-open="${esc(w.wineId)}">${p ? `<img class="ph" src="${esc(p)}" alt="${esc(w.wineName)}" loading="lazy">` : `<span class="ph">${esc(w.vintage || 'NV')}</span>`}<span class="cb"><b>${esc(w.wineName)}</b><span>${esc(w.wineryRegion || '')}</span><span>${esc(w.vintage || 'NV')} · ${total(w)} 瓶</span></span></button>`;
}

/* ---------- 詳細資料抽屜 ---------- */
function openDrawer(id, fromHash) {
  if (!byId(id)) return;
  S.drawer = id; renderDrawer();
  if (!$('drawer').open) $('drawer').showModal();
  if (!fromHash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}
function closeDrawer() { if ($('drawer').open) $('drawer').close(); }
function renderDrawer() {
  const w = byId(S.drawer); if (!w) { closeDrawer(); return; }
  const p = photoUrl(w), ed = canEdit(), t = total(w), archived = w.status === 'archived';
  const facts = [['wineryRegion', '酒莊／產區'], ['origin', '產地'], ['volume', '容量'], ['source', '來源'], ['referencePrice', '參考價格'], ['entryDate', '入庫日期'], ['drinkWindow', '適飲期']]
    .map(([k, l]) => `<div><dt>${l}</dt><dd>${k === 'referencePrice' ? fmtPrice(w[k]) : esc(w[k] || '—')}</dd></div>`).join('');
  const locs = (w.locations || []).map(l => `<div class="dw-loc"><span class="where">${esc(l.cabinet)} <small>· ${esc(l.shelf)}</small></span><span class="n">${l.quantity}</span>${ed && l.quantity > 0 ? `<button class="small" data-stock="${esc(w.wineId)}" data-cab="${esc(l.cabinet)}" data-shelf="${esc(l.shelf)}">出庫</button>` : '<span></span>'}</div>`).join('');
  $('drawerBody').innerHTML = `
   <div class="dw-top"><span class="id">${archived ? '已出清' : esc(w.volume || '')}</span><button class="x" data-dwclose aria-label="關閉">×</button></div>
   <div class="dw">
    <div class="dw-head"><span class="vin">${esc(w.vintage || 'NV')}</span><h2 id="dwName">${esc(w.wineName)}</h2>${w.wineryRegion ? `<p>${esc(w.wineryRegion)}</p>` : ''}</div>
    ${p ? `<img class="dw-photo" src="${esc(p)}" alt="${esc(w.wineName)} 酒標照片">` : ''}
    <div class="dw-stock"><div class="sum"><span>目前庫存</span><b>${t} <small style="font-size:15px">瓶</small></b></div>${locs || '<div class="dw-loc"><span class="where hint">沒有存放位置</span></div>'}</div>
    <div class="dw-act">${ed ? `${archived ? '' : `<button class="primary" data-stockany="${esc(w.wineId)}" ${t ? '' : 'disabled'}>出庫</button>`}<button class="primary" data-edit="${esc(w.wineId)}">編輯</button><button data-photo="${esc(w.wineId)}">${p ? '更換照片' : '加照片'}</button>` : ''}<button data-copy="${esc(w.wineId)}">複製連結</button>${ed ? `<button data-log="${esc(w.wineId)}">異動紀錄</button>` : ''}</div>
    ${ed ? (archived ? '<p class="hint" style="margin:0">這款酒已全部出庫。要補回庫存，請按「編輯」填入瓶數，它會回到目前酒款。</p>' : '') : '<p class="hint" style="margin:0">登入管理後可以出庫與編輯這款酒。</p>'}
    <dl class="dw-facts">${facts}${w.grapeNotes ? `<div class="wide"><dt>葡萄品種／備註</dt><dd class="note">${esc(w.grapeNotes)}</dd></div>` : ''}</dl>
    <div class="dw-meta">${w.createdAt ? `建立 ${fmtTime(w.createdAt)}（${esc(nameOf(w.createdBy))}）<br>` : ''}最後修改 ${fmtTime(w.updatedAt)}（${esc(nameOf(w.updatedBy))}）${archived ? `<br>出清 ${fmtTime(w.archivedAt)}（${esc(nameOf(w.archivedBy))}）` : ''}</div>
   </div>`;
}

/* ---------- 事件 ---------- */
function wire() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('search').addEventListener('input', e => { S.search = e.target.value; render(); });
  $('clearSearch').addEventListener('click', () => { S.search = ''; $('search').value = ''; render(); });
  $('clearFilter').addEventListener('click', () => { S.filter = null; render(); });
  $('sortSel').addEventListener('change', e => { S.sort = e.target.value; try { localStorage.setItem('cellarSort', S.sort); } catch {} render(); });
  $('reloadBtn').addEventListener('click', async () => { try { await loadData(true); render(); toast('已同步。'); } catch (e) { toast(msgOf(e)); } });
  $('viewList').addEventListener('click', () => setView('list'));
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('homeLink').addEventListener('click', e => { e.preventDefault(); S.filter = null; S.search = ''; $('search').value = ''; closeDrawer(); scrollTo({top: 0, behavior: 'smooth'}); render(); });
  $('loginBtn').addEventListener('click', () => S.keys ? openLogin() : showDialog('setupModal'));
  $('logoutBtn').addEventListener('click', () => logout());
  $('addBtn').addEventListener('click', () => openWineForm(null));
  $('fab').addEventListener('click', () => openWineForm(null));
  $('adminBtn').addEventListener('click', () => { showDialog('adminModal'); switchTab('audit'); loadAudit('', 1); });
  $('exportBtn').addEventListener('click', exportCsv);
  $('map').addEventListener('click', e => {
    const b = e.target.closest('[data-cab]'); if (!b) return;
    const next = {cabinet: b.dataset.cab, shelf: b.dataset.shelf || ''};
    S.filter = S.filter && S.filter.cabinet === next.cabinet && S.filter.shelf === next.shelf ? null : next;
    render();
    if (S.filter && matchMedia('(max-width:760px)').matches) document.querySelector('.ledger').scrollIntoView({behavior: 'smooth'});
  });
  $('list').addEventListener('click', e => {
    const o = e.target.closest('[data-open]'); if (!o) return;
    openDrawer(o.dataset.open);
  });
  const dw = $('drawer');
  dw.addEventListener('close', () => { S.drawer = null; if (/^#[WH]\d+$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); });
  dw.addEventListener('click', e => {
    if (e.target === dw) return closeDrawer();
    if (e.target.closest('[data-dwclose]')) return closeDrawer();
    const st = e.target.closest('[data-stock]'); if (st) return openStock(st.dataset.stock, st.dataset.cab, st.dataset.shelf);
    const sa = e.target.closest('[data-stockany]'); if (sa) return openStock(sa.dataset.stockany);
    const ed = e.target.closest('[data-edit]'); if (ed) return openWineForm(byId(ed.dataset.edit));
    const ph = e.target.closest('[data-photo]'); if (ph) return openPhoto(byId(ph.dataset.photo));
    const cp = e.target.closest('[data-copy]'); if (cp) return copyLink(cp.dataset.copy);
    const lg = e.target.closest('[data-log]'); if (lg) { showDialog('adminModal'); switchTab('audit'); loadAudit(lg.dataset.log, 1); }
  });
  $('f_volumeChoice').addEventListener('change', e => { $('f_volumeOther').hidden = e.target.value !== '__other__'; });
  $('f_sourceChoice').addEventListener('change', e => { $('f_sourceOther').hidden = e.target.value !== '__other__'; });
  $('addLoc').addEventListener('click', () => addLocRow());
  $('locInputs').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.loc-ed').remove(); });
  for (const id of ['f_camera', 'f_gallery']) $(id).addEventListener('change', e => pickPhoto(e.target.files[0], 'f_preview', b => S.newPhotoBlob = b, 'wineErr'));
  for (const id of ['p_camera', 'p_gallery']) $(id).addEventListener('change', e => pickPhoto(e.target.files[0], 'p_preview', b => { S.photoBlob = b; $('photoSave').disabled = !b; }, 'photoErr'));
  $('loginForm').addEventListener('submit', e => { e.preventDefault(); submit('loginForm', 'loginErr', doLogin); });
  $('setupForm').addEventListener('submit', e => { e.preventDefault(); submit('setupForm', 'setupErr', doSetup); });
  $('wineForm').addEventListener('submit', e => { e.preventDefault(); submit('wineForm', 'wineErr', saveWine); });
  $('stockForm').addEventListener('submit', e => { e.preventDefault(); submit('stockForm', 'stockErr', saveStock); });
  $('photoForm').addEventListener('submit', e => { e.preventDefault(); submit('photoForm', 'photoErr', savePhoto); });
  $('locForm').addEventListener('submit', e => { e.preventDefault(); submit('locForm', 'locErr', saveCatalog); });
  $('slotForm').addEventListener('submit', e => { e.preventDefault(); submit('slotForm', 'keysErr', addSlot); });
  $('tokenForm').addEventListener('submit', e => { e.preventDefault(); submit('tokenForm', 'keysErr', changeToken); });
  $('moreAudit').addEventListener('click', () => loadAudit(S.auditWine, S.auditPage + 1));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('cabChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeCatalog('cabinets', b.dataset.rm); });
  $('shelfChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeCatalog('shelves', b.dataset.rm); });
  const openHist = e => { const h = e.target.closest('[data-hist]'); if (!h || (e.type === 'keydown' && e.key !== 'Enter')) return; $('adminModal').close(); openDrawer(h.dataset.hist); };
  $('histList').addEventListener('click', openHist); $('histList').addEventListener('keydown', openHist);
  $('slotList').addEventListener('click', e => { const b = e.target.closest('[data-delslot]'); if (b) deleteSlot(b); });
}
function setView(v) { S.view = v; try { localStorage.setItem('cellarView', v); } catch {} render(); }
async function submit(formId, errId, fn) {
  const form = $(formId); if (form.dataset.busy) return; form.dataset.busy = '1';
  const btns = [...form.querySelectorAll('button')]; btns.forEach(b => b.disabled = true); showErr(errId, '');
  try { await fn(); } catch (e) { showErr(errId, msgOf(e)); if (!e.user) console.error(e); }
  finally { delete form.dataset.busy; btns.forEach(b => b.disabled = false); if (formId === 'photoForm') $('photoSave').disabled = !S.photoBlob; }
}
function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['audit', 'hist', 'loc', 'keys']) $('tab-' + t).hidden = t !== name;
  $('keysTab').hidden = !isAdmin();
  if (name === 'hist' || name === 'loc') renderAdmin();
  if (name === 'keys') renderSlots();
}
async function copyLink(id) { const url = wineUrl(id); try { await navigator.clipboard.writeText(url); toast('已複製「' + (byId(id)?.wineName || '') + '」的連結。'); } catch { toast(url); } }

/* ---------- 登入與初始設定 ---------- */
function openLogin() {
  let last = ''; try { last = localStorage.getItem('cellarSlot') || ''; } catch {}
  const sel = $('g_slot');
  sel.innerHTML = (S.keys?.slots || []).map(s => `<option value="${esc(s.id)}">${esc(s.label)}（${s.role === 'admin' ? '管理員' : '編輯者'}）</option>`).join('');
  if (last && S.keys.slots.some(s => s.id === last)) sel.value = last;
  $('g_pass').value = '';
  showDialog('loginModal'); $('g_pass').focus();
}
async function doLogin() {
  await loadKeys();
  const slot = S.keys?.slots?.find(s => s.id === $('g_slot').value);
  if (!slot) fail('找不到這台裝置，請重新整理網頁。');
  const pass = $('g_pass').value;
  if (!pass) fail('請輸入密碼。');
  let dataKey;
  try { dataKey = await open_(await pwKey(pass, b64d(slot.salt), S.keys.iterations || PBKDF2_ITER), slot); }
  catch { fail('密碼不正確。'); }
  const token = dec.decode(await open_(await aesKey(dataKey), S.keys.token));
  await checkToken(token);
  saveSession({token, dataKey: b64e(dataKey), slotId: slot.id, label: slot.label, role: slot.role}, $('g_remember').checked);
  $('loginModal').close(); render();
  await loadData(true); render();
  toast(`${slot.label} 已登入，可以開始管理。`);
}
async function doSetup() {
  const token = $('u_token').value.trim(), label = $('u_label').value.trim(), pass = $('u_pass').value;
  if (!token) fail('請貼上 GitHub 權杖。');
  if (!label) fail('請填寫裝置名稱。');
  checkPass(pass, $('u_pass2').value);
  await loadKeys();
  if (S.keys) fail('已經完成過初始設定，請改用「管理登入」。');
  await checkToken(token);
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const keys = {schema: 1, iterations: PBKDF2_ITER, token: await seal(await aesKey(dataKey), enc.encode(token)), slots: [await makeSlot(label, 'admin', pass, dataKey)]};
  await saveKeys(keys, '初始設定：建立管理員裝置 ' + label, token);
  saveSession({token, dataKey: b64e(dataKey), slotId: keys.slots[0].id, label, role: 'admin'}, true);
  $('setupModal').close(); $('u_token').value = ''; render();
  await loadData(true); render();
  toast('設定完成。可在「管理 → 裝置密碼」替其他裝置設定密碼。');
}
function renderSlots() {
  const slots = S.keys?.slots || [];
  $('slotList').innerHTML = slots.map(s => `<div class="slot"><span><b>${esc(s.label)}</b><span class="role ${s.role === 'admin' ? 'admin' : ''}">${s.role === 'admin' ? '管理員' : '編輯者'}</span>${s.id === S.session?.slotId ? ' <span class="hint">（目前這台）</span>' : ''}<br><span class="hint">建立於 ${fmtTime(s.createdAt)}</span></span><button class="small danger" data-delslot="${esc(s.id)}">刪除</button></div>`).join('') || '<p class="hint">沒有裝置。</p>';
}
async function addSlot() {
  if (!isAdmin()) fail('只有管理員可以新增裝置。');
  const label = $('k_label').value.trim(), role = $('k_role').value, pass = $('k_pass').value;
  if (!label) fail('請填寫裝置名稱。');
  checkPass(pass);
  await loadKeys();
  if (S.keys.slots.some(s => s.label === label)) fail('已有同名裝置，請換個名稱。');
  const keys = structuredClone(S.keys);
  keys.slots.push(await makeSlot(label, role, pass, b64d(S.session.dataKey)));
  await saveKeys(keys, `新增裝置 ${label}（${role === 'admin' ? '管理員' : '編輯者'}）`);
  $('k_label').value = ''; $('k_pass').value = ''; renderSlots();
  toast(`已新增 ${label}。請把密碼告訴使用那台裝置的人。`);
}
async function deleteSlot(btn) {
  if (!isAdmin()) return;
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定刪除？'; setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; } }, 4000); return; }
  showErr('keysErr', '');
  try {
    await loadKeys();
    const target = S.keys.slots.find(s => s.id === btn.dataset.delslot); if (!target) return renderSlots();
    if (target.role === 'admin' && S.keys.slots.filter(s => s.role === 'admin').length <= 1) fail('不能刪除最後一位管理員。');
    const keys = structuredClone(S.keys); keys.slots = keys.slots.filter(s => s.id !== target.id);
    await saveKeys(keys, '刪除裝置 ' + target.label);
    renderSlots(); toast(`已刪除 ${target.label}。如果那台裝置遺失，建議也更換 GitHub 權杖。`);
    if (target.id === S.session.slotId) logout();
  } catch (e) { showErr('keysErr', msgOf(e)); }
}
async function changeToken() {
  if (!isAdmin()) fail('只有管理員可以更換權杖。');
  const token = $('t_token').value.trim(); if (!token) fail('請貼上新權杖。');
  await checkToken(token);
  await loadKeys();
  const keys = structuredClone(S.keys);
  keys.token = await seal(await aesKey(b64d(S.session.dataKey)), enc.encode(token));
  await saveKeys(keys, '更換 GitHub 權杖', token);
  const remember = (() => { try { return !!localStorage.getItem('cellarSession'); } catch { return false; } })();
  saveSession({...S.session, token}, remember);
  $('t_token').value = '';
  toast('已更換權杖。舊權杖可以在 GitHub 刪除了。');
}

/* ---------- 新增／編輯酒款 ---------- */
function locOptions(kind) { const names = new Set(S.data?.catalog?.[kind] || []); for (const w of wines()) for (const l of w.locations || []) names.add(kind === 'cabinets' ? l.cabinet : l.shelf); return [...names].filter(Boolean).sort(); }
function ensureLists() {
  let c = $('cabList'), s = $('shelfList');
  if (!c) { c = document.createElement('datalist'); c.id = 'cabList'; document.body.append(c); s = document.createElement('datalist'); s.id = 'shelfList'; document.body.append(s); }
  c.innerHTML = locOptions('cabinets').map(n => `<option value="${esc(n)}">`).join('');
  s.innerHTML = locOptions('shelves').map(n => `<option value="${esc(n)}">`).join('');
}
function addLocRow(l = {cabinet: '', shelf: '', quantity: 1}) {
  const i = $('locInputs').children.length + '_' + Math.random().toString(36).slice(2, 6);
  const row = document.createElement('div'); row.className = 'loc-ed';
  row.innerHTML = `<div class="field"><label for="lc${i}">櫃位</label><input id="lc${i}" list="cabList" data-k="cabinet" maxlength="80" value="${esc(l.cabinet)}"></div><div class="field"><label for="ls${i}">層位</label><input id="ls${i}" list="shelfList" data-k="shelf" maxlength="80" value="${esc(l.shelf)}"></div><div class="field"><label for="lq${i}">瓶數</label><input id="lq${i}" type="number" min="0" step="1" inputmode="numeric" data-k="quantity" value="${Number(l.quantity) || 0}"></div><button type="button" data-rm aria-label="移除位置">×</button>`;
  $('locInputs').append(row);
}
function setChoice(selId, otherId, value, fallback) {
  const v = value || fallback, sel = $(selId);
  const std = [...sel.options].some(o => o.value === v && o.value !== '__other__');
  sel.value = std ? v : '__other__'; $(otherId).hidden = std; $(otherId).value = std ? '' : v;
}
function openWineForm(w) {
  S.editing = w; S.newPhotoBlob = null; ensureLists();
  $('wineTitle').textContent = w ? '編輯酒款' : '新增紅酒';
  for (const [k] of FIELDS) { const el = $('f_' + k); if (el) el.value = w?.[k] ?? ''; }
  setChoice('f_volumeChoice', 'f_volumeOther', w?.volume, '750ml');
  setChoice('f_sourceChoice', 'f_sourceOther', w?.source, '');
  $('locInputs').replaceChildren(); (w?.locations?.length ? w.locations : [{cabinet: '', shelf: '', quantity: 1}]).forEach(addLocRow);
  $('locHint').hidden = !w; $('locLbl').textContent = w ? '存放位置與瓶數' : '存放位置與初始瓶數';
  $('newPhotoField').hidden = !!w; $('f_preview').hidden = true; $('f_camera').value = ''; $('f_gallery').value = '';
  showDialog('wineModal');
}
function readWineForm() {
  const r = {};
  for (const [k] of FIELDS) { if (k === 'volume' || k === 'source' || k === 'referencePrice') continue; r[k] = $('f_' + k).value.trim(); }
  r.volume = ($('f_volumeChoice').value === '__other__' ? $('f_volumeOther').value : $('f_volumeChoice').value).trim();
  r.source = ($('f_sourceChoice').value === '__other__' ? $('f_sourceOther').value : $('f_sourceChoice').value).trim();
  const price = $('f_referencePrice').value.trim(); r.referencePrice = price === '' ? null : Number(price);
  if (!r.wineName) fail('請填寫酒名。');
  if (r.referencePrice !== null && (!Number.isFinite(r.referencePrice) || r.referencePrice < 0)) fail('參考價格格式不正確。');
  const seen = new Set(); r.locations = [];
  for (const row of $('locInputs').children) {
    const g = k => row.querySelector(`[data-k="${k}"]`).value.trim();
    const cabinet = g('cabinet'), shelf = g('shelf'), quantity = Number(g('quantity'));
    if (!cabinet && !shelf) continue;
    if (!cabinet || !shelf) fail('每個位置都要填櫃位與層位。');
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000) fail('瓶數必須是 0 以上的整數。');
    const key = cabinet + '\u0000' + shelf; if (seen.has(key)) fail('同一位置不可重複。'); seen.add(key);
    r.locations.push({cabinet, shelf, quantity});
  }
  return r;
}
async function saveWine() {
  const r = readWineForm(), who = S.session.label;
  if (S.editing) {
    const id = S.editing.wineId, rev = S.editing.revision || 0;
    await mutate(d => {
      const cur = d.wines[id]; if (!cur) fail('這款酒已不存在，請重新整理。');
      if ((cur.revision || 0) !== rev) fail('資料已被其他人更新。請關閉視窗重新查看，再套用你的修改。');
      const t = now(), next = {...cur, ...r, updatedAt: t, updatedBy: who, revision: rev + 1};
      if (total(r) > 0) { next.status = 'active'; delete next.archivedAt; delete next.archivedBy; }
      else if (cur.status !== 'archived') { next.status = 'archived'; next.archivedAt = t; next.archivedBy = who; }
      d.wines[id] = next;
      const changes = [];
      for (const [k, label] of FIELDS) if (String(cur[k] ?? '') !== String(r[k] ?? '')) changes.push(`${label}：${cur[k] ?? '—'} → ${r[k] ?? '—'}`);
      if (JSON.stringify(cur.locations || []) !== JSON.stringify(r.locations)) changes.push(`位置：${locText(cur.locations)} → ${locText(r.locations)}`);
      return changes;
    }, changes => `編輯 ${id} ${r.wineName}${changes.length ? '' : '（無變更）'}${changes.length ? '\n\n' + changes.join('\n') : ''}`);
    $('wineModal').close(); toast('已更新「' + r.wineName + '」。');
  } else {
    let photo = '';
    if (S.newPhotoBlob) photo = await uploadPhoto(S.newPhotoBlob, 'new');
    const id = await mutate(d => {
      const n = Object.keys(d.wines).reduce((m, k) => /^W\d+$/.test(k) ? Math.max(m, Number(k.slice(1))) : m, 0) + 1;
      const wid = 'W' + String(n).padStart(3, '0'), t = now();
      d.wines[wid] = {...r, photo, status: total(r) > 0 ? 'active' : 'archived', createdAt: t, createdBy: who, updatedAt: t, updatedBy: who, revision: 1};
      return wid;
    }, wid => `新增 ${wid} ${r.wineName}\n\n位置：${locText(r.locations)}`);
    $('wineModal').close(); openDrawer(id); toast('已新增「' + r.wineName + '」。');
  }
}

/* ---------- 出庫 ---------- */
function openStock(id, cab, shelf) {
  const w = byId(id); if (!w) return; S.stock = w;
  $('stockWine').textContent = [w.wineName, w.vintage].filter(Boolean).join('　');
  const sel = $('s_loc');
  sel.innerHTML = (w.locations || []).map((l, i) => l.quantity > 0 ? `<option value="${i}">${esc(l.cabinet)} / ${esc(l.shelf)}（目前 ${l.quantity} 瓶）</option>` : '').join('');
  if (cab) { const i = w.locations.findIndex(l => l.cabinet === cab && l.shelf === shelf); if (i >= 0) sel.value = String(i); }
  $('s_reason').value = ''; $('s_qty').value = '1';
  showDialog('stockModal'); $('s_reason').focus();
}
async function saveStock() {
  const id = S.stock.wineId, picked = S.stock.locations?.[Number($('s_loc').value)] || {}, {cabinet, shelf} = picked, qty = Number($('s_qty').value), reason = $('s_reason').value.trim(), who = S.session.label;
  if (!cabinet) fail('請選擇目前有庫存的位置。');
  if (!reason) fail('請填寫出庫原因。');
  if (!Number.isInteger(qty) || qty < 1) fail('瓶數必須是 1 以上的整數。');
  const res = await mutate(d => {
    const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
    const l = (cur.locations || []).find(x => x.cabinet === cabinet && x.shelf === shelf);
    if (!l || l.quantity <= 0) fail('這個位置已沒有庫存，沒有扣除任何瓶數。');
    if (l.quantity < qty) fail(`此位置只剩 ${l.quantity} 瓶，沒有扣除任何瓶數。`);
    const old = l.quantity; l.quantity -= qty;
    const t = now(); cur.updatedAt = t; cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
    const archived = cur.locations.every(x => !x.quantity);
    if (archived) { cur.status = 'archived'; cur.archivedAt = t; cur.archivedBy = who; }
    return {old, left: l.quantity, archived, name: cur.wineName};
  }, x => `出庫 ${id} ${x.name}：${cabinet}/${shelf} ${x.old}→${x.left}（−${qty}）${x.archived ? '，全部出清' : ''}\n\n原因：${reason}`);
  $('stockModal').close();
  toast(res.archived ? `「${res.name}」已全部出庫，移入歷史酒單。` : `已出庫 ${qty} 瓶，${cabinet} / ${shelf} 剩 ${res.left} 瓶。`);
}

/* ---------- 照片 ---------- */
function pickPhoto(file, previewId, set, errId) {
  if (!file) return; showErr(errId, '');
  compress(file).then(blob => { set(blob); const img = $(previewId); img.src = URL.createObjectURL(blob); img.hidden = false; }).catch(() => { set(null); showErr(errId, '無法讀取這張圖片，請換一張。'); });
}
function compress(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(), 'image/jpeg', .82); URL.revokeObjectURL(img.src);
    };
    img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}
async function uploadPhoto(blob, id) {
  const path = `${CFG.imageDir}/${id}-${Date.now()}.jpg`;
  const r = await putFile(path, new Uint8Array(await blob.arrayBuffer()), null, `照片 ${id}\n\n操作者：${S.session.label}`);
  if (!r.ok) fail('照片上傳失敗，請再試一次。');
  S.localPhotos.set(path, URL.createObjectURL(blob));
  return path;
}
function openPhoto(w) { if (!w) return; S.photo = w; S.photoBlob = null; $('photoWine').textContent = [w.wineName, w.vintage].filter(Boolean).join('　'); $('p_preview').hidden = true; $('p_camera').value = ''; $('p_gallery').value = ''; $('photoSave').disabled = true; showDialog('photoModal'); }
async function savePhoto() {
  if (!S.photoBlob) fail('請先選擇照片。');
  const id = S.photo.wineId, path = await uploadPhoto(S.photoBlob, id), who = S.session.label;
  await mutate(d => {
    const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
    const had = !!cur.photo; cur.photo = path; cur.updatedAt = now(); cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1; return had;
  }, had => `${had ? '更換' : '新增'}照片 ${id} ${S.photo.wineName}`);
  $('photoModal').close(); toast('照片已儲存。');
}

/* ---------- CSV ---------- */
function exportCsv() {
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['資料類型', ...FIELDS.map(f => f[1]), '櫃位', '層位', '瓶數', '最後修改者', '最後修改時間'].join(',')];
  for (const w of wines()) {
    const type = w.status === 'archived' ? '歷史酒單' : '目前酒款';
    const locs = w.locations?.length ? w.locations : [{cabinet: '', shelf: '', quantity: 0}];
    for (const l of locs) lines.push([type, ...FIELDS.map(f => w[f[0]]), l.cabinet, l.shelf, l.quantity, nameOf(w.updatedBy), w.updatedAt].map(cell).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  a.download = `紅酒收藏-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 管理 ---------- */
function renderAdmin() {
  const cat = S.data?.catalog || {cabinets: [], shelves: []};
  const chip = n => `<span class="chip">${esc(n)}<button data-rm="${esc(n)}" aria-label="移除 ${esc(n)}">×</button></span>`;
  $('cabChips').innerHTML = cat.cabinets.map(chip).join('') || '<span class="hint">尚未建立。</span>';
  $('shelfChips').innerHTML = cat.shelves.map(chip).join('') || '<span class="hint">尚未建立。</span>';
  const hist = wines().filter(w => w.status === 'archived').sort((a, b) => (b.archivedAt || '') > (a.archivedAt || '') ? 1 : -1);
  $('histList').innerHTML = hist.map(w => `<div class="hrow" data-hist="${esc(w.wineId)}" role="button" tabindex="0"><span><b>${esc(w.wineName)}</b> ${esc(w.vintage || '')} <span class="hint">${esc(w.wineryRegion || '')}</span></span><span class="hint">出清於 ${fmtTime(w.archivedAt)}（${esc(nameOf(w.archivedBy))}）</span></div>`).join('') || '<p class="hint">還沒有出清的酒款。</p>';
}
async function loadAudit(wineId, page) {
  S.auditWine = wineId; S.auditPage = page;
  if (page === 1) S.audit = [];
  $('auditHint').textContent = wineId ? `「${byId(wineId)?.wineName || ''}」的異動紀錄，由新到舊。` : '每次異動都是一筆 GitHub commit，由新到舊。';
  $('auditList').innerHTML = page === 1 ? '<p class="hint">讀取中…</p>' : $('auditList').innerHTML;
  try {
    const pages = wineId ? [page, page + 1, page + 2] : [page];
    let more = false;
    for (const p of pages) {
      const r = await gh(`${REPO}/commits?sha=${encodeURIComponent(CFG.dataBranch)}&path=${encodeURIComponent(CFG.dataPath)}&per_page=50&page=${p}`);
      if (!r.ok) { authProblem(r); fail('讀取異動紀錄失敗。'); }
      const list = await r.json();
      for (const c of list) {
        if (wineId && !new RegExp('\\b' + wineId + '\\b').test(c.commit.message)) continue;
        S.audit.push(c);
      }
      more = list.length === 50; S.auditPage = p;
      if (!more) break;
    }
    $('moreAudit').hidden = !more;
    $('auditList').innerHTML = S.audit.map(c => {
      const lines = c.commit.message.split('\n').map(s => s.replace(/\b[WH]\d{3,}\b\s*/g, '').trim()).filter(Boolean);
      const op = lines.find(l => l.startsWith('操作者：'));
      const body = lines.slice(1).filter(l => l !== op);
      return `<div><span class="t">${fmtTime(c.commit.author?.date)}</span> · ${esc(op ? op.slice(4) : (c.author?.login || c.commit.author?.name || ''))}<br><b>${esc(lines[0] || '')}</b>${body.length ? '<br>' + body.map(esc).join('<br>') : ''}</div>`;
    }).join('') || '<p class="hint">尚無紀錄。</p>';
  } catch (e) { $('auditList').innerHTML = `<p class="hint">${esc(msgOf(e))}</p>`; }
}
async function saveCatalog() {
  const kind = $('l_type').value, name = $('l_name').value.trim(); if (!name) fail('請輸入名稱。');
  await mutate(d => {
    d.catalog = d.catalog || {cabinets: [], shelves: []};
    if (d.catalog[kind].includes(name)) fail('這個名稱已存在。');
    d.catalog[kind].push(name);
  }, `新增${kind === 'cabinets' ? '櫃位' : '層位'} ${name}`);
  $('l_name').value = ''; renderAdmin(); toast('已新增 ' + name + '。');
}
async function removeCatalog(kind, name) {
  showErr('locErr', '');
  try {
    await mutate(d => { d.catalog[kind] = d.catalog[kind].filter(n => n !== name); }, `移除${kind === 'cabinets' ? '櫃位' : '層位'} ${name}`);
    renderAdmin(); toast('已從清單移除 ' + name + '，既有酒款的位置不受影響。');
  } catch (e) { showErr('locErr', msgOf(e)); }
}
