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
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = v => v ? v.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (m, y, mo, d) => `${y}/${Number(mo)}/${Number(d)}`) : '—';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();
const FIELDS = [['wineName','酒名'],['wineryRegion','酒莊／產區'],['vintage','年份'],['entryDate','入庫日期'],['volume','容量'],['source','來源'],['referencePrice','參考價格'],['origin','產地'],['drinkWindow','適飲期'],['grapeNotes','葡萄品種／備註']];

const S = {
  data: null, sha: null, etag: null, keys: null, keysSha: null, session: null,
  filter: null, search: '', view: 'list', 
  editing: null, stock: null, photo: null, photoBlob: null, newPhotoBlob: null, localPhotos: new Map(),
  sort: 'loc', drawer: null, newPhotos: [], pendKeep: [], pendNew: [], jt: 'cal', js: {q: '', type: '', when: 'all', hi: false}, jm: {q: '', sort: 'freq', group: 'all'},
  busy: 0, lastPoll: 0, syncedAt: null, rawFallback: false, auditPage: 1, auditWine: '', audit: []
};
S.view = 'grid';
try { S.view = localStorage.getItem('cellarView') === 'list' ? 'list' : 'grid'; S.sort = localStorage.getItem('cellarSort') || 'loc'; } catch {}

/* ---------- 小工具 ---------- */
let toastTimer;
function toast(m) { $('toast').textContent = m; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function notice(m, bad) { const n = $('notice'); n.textContent = m || ''; n.hidden = !m; n.classList.toggle('bad', !!bad); }
function showErr(id, m) { const e = $(id); e.textContent = m || ''; e.hidden = !m; }
function showDialog(id) { document.querySelectorAll('.ferr').forEach(e => e.hidden = true); $(id).showModal(); }
function fail(m) { const e = new Error(m); e.user = true; throw e; }
function msgOf(e) { return e?.user ? e.message : '操作未完成，請稍後再試。'; }
const canEdit = () => !!S.session;
/* iPad：761–1180px，或觸控螢幕寬到 1400px（iPad Pro 橫放）。橫放時改成左右雙欄 */
const TABLET_MQ = '(min-width:761px) and (max-width:1180px) and (min-height:600px), (min-width:761px) and (max-width:1400px) and (min-height:600px) and (pointer:coarse)';
const DESK_MQ = '(min-width:1181px) and (pointer:fine), (min-width:1401px)';
const SPLIT_MQ = '(min-width:761px) and (max-width:1180px) and (min-height:600px) and (orientation:landscape), (min-width:761px) and (max-width:1400px) and (min-height:600px) and (pointer:coarse) and (orientation:landscape)';
/* 版本檢查：手機或瀏覽器可能留著舊的 style.css，新程式配舊樣式會讓酒櫃畫不出來。不一致就重新載入樣式。 */
const APP_VER = '20261113h';
(function ensureCss() {
  const cur = getComputedStyle(document.documentElement).getPropertyValue('--ver').replace(/["'\s]/g, '');
  if (cur === APP_VER) return;
  const link = document.getElementById('mainCss') || document.querySelector('link[rel=stylesheet][href*="style.css"]');
  if (link) link.href = 'style.css?v=' + APP_VER + '&t=' + Date.now();
})();
const isAdmin = () => S.session?.role === 'admin';
const wines = () => S.data ? Object.entries(S.data.wines).map(([wineId, w]) => ({...w, wineId})).sort((a, b) => a.wineId < b.wineId ? -1 : 1) : [];
const active = () => wines().filter(w => w.status !== 'archived');
const byId = id => { const w = S.data?.wines[id]; return w ? {...w, wineId: id} : null; };
const total = w => (w.locations || []).reduce((a, l) => a + (Number(l.quantity) || 0), 0);
const nameOf = v => !v ? '—' : String(v).includes('@') ? String(v).split('@')[0] : String(v);
const siteUrl = () => location.origin + location.pathname;
const wineUrl = id => siteUrl() + '#' + id;
const locText = ls => (ls || []).map(l => `${l.cabinet}/${l.shelf}×${l.quantity}`).join('、') || '無';
const fileUrl = path => S.localPhotos.get(path) || `${CFG.rawBase}/${CFG.owner}/${CFG.repo}/${CFG.dataBranch}/${path.split('/').map(encodeURIComponent).join('/')}`;
const photoUrl = w => w.photo ? fileUrl(w.photo) : '';
const thumbUrl = w => w.thumb ? fileUrl(w.thumb) : photoUrl(w);
const MAX_PHOTOS = 4;
const photosOf = w => Array.isArray(w?.photos) && w.photos.length ? w.photos : (w?.photo ? [{photo: w.photo, thumb: w.thumb || ''}] : []);
function setPhotos(cur, list) { cur.photos = list; cur.photo = list[0]?.photo || ''; cur.thumb = list[0]?.thumb || ''; }
const sdots = n => n > 1 ? `<span class="sdots" aria-hidden="true">${Array.from({length: n}, (_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</span>` : '';
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
  let sure = true;
  try { res = await readJson(CFG.keysPath, {auth: !!S.session}); }
  catch (e) { if (e.user) throw e; res = await readRaw(CFG.keysPath); sure = !!res; } // raw 檔可能是舊快取，讀不到不代表沒設定
  S.keys = res ? res.json : null; S.keysSha = res?.sha || null; S.keysSure = sure;
}

/* 寫入：每次都讀最新版本、套用變更、帶 sha 寫回；有人同時修改就自動重試。 */
async function mutate(fn, message, {quiet = false} = {}) {
  if (!S.session) fail('請先登入管理。');
  S.busy++;
  try {
    for (let i = 0; i < 4; i++) {
      const cur = await readJson(CFG.dataPath);
      const base = cur ? cur.json : {schema: 1, rev: 0, catalog: {cabinets: [], shelves: []}, wines: {}};
      if (S.data && (base.rev || 0) < (S.data.rev || 0)) { await sleep(800 * (i + 1)); continue; }
      const draft = structuredClone(base);
      const result = fn(draft);
      draft.rev = (base.rev || 0) + 1; if (!quiet) draft.updatedAt = now();
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
  scheduleAiExpiry();
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
    if (S.session && (S.keys || S.keysSure) && !S.keys?.slots?.some(s => s.id === S.session.slotId)) { logout(true); notice('這台裝置的密碼已被刪除，請重新登入。', true); }
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
const countryOf = w => (w.origin || '').split(/[,，/]/)[0].trim() || '未填產地';
const shelfNo = s => { const m = /\d+/.exec(s || ''); return m ? Number(m[0]) : 999; };
// 編輯表單有選紅酒／白酒就照選的；沒選過的舊資料才看酒名與備註的關鍵字判斷
const isWhite = w => w.color ? w.color === 'white' : /白酒|white|riesling|sauvignon blanc|chardonnay/i.test(`${w.grapeNotes} ${w.wineName}`);
const colorName = w => isWhite(w) ? '白酒' : '紅酒';
function renderSync() {
  const el = $('sync'), every = (S.session ? CFG.pollSecondsEditor : CFG.pollSecondsViewer) * 1000;
  const age = S.syncedAt ? Date.now() - new Date(S.syncedAt).getTime() : Infinity;
  el.classList.toggle('live', age < every * 2 + 10000);
  el.classList.toggle('stale', age >= every * 2 + 10000 && age !== Infinity);
  $('syncText').textContent = !S.syncedAt ? '讀取中' : S.rawFallback && !S.session ? '可能延遲幾分鐘' : `已同步 ${new Date(S.syncedAt).toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'})}`;
  el.title = S.session ? `每 ${CFG.pollSecondsEditor} 秒自動同步` : `每 ${CFG.pollSecondsViewer} 秒自動同步`;
}
function render() {
  const setup = !!S.data && !S.keys && S.keysSure;
  $('whoPill').innerHTML = S.session ? `<b>${esc(S.session.label)}</b> · ${isAdmin() ? '管理員' : '編輯者'}` : '訪客瀏覽';
  $('loginBtn').hidden = !!S.session || !S.data;
  $('loginBtn').textContent = setup ? '初始設定' : '管理登入';
  $('logoutBtn').hidden = !S.session;
  $('adminBtn').hidden = !S.session;
  $('addBtn').hidden = !canEdit();
  $('fab').hidden = !canEdit();
  // 手機底部導覽列：訪客只有 酒窖／日誌／登入
  const pn = (S.data?.pending || []).length;
  $('bnAdd').hidden = $('bnPend').hidden = !canEdit(); $('bnAdmin').hidden = !S.session; $('bnLogin').hidden = !!S.session || !S.data;
  $('bnLoginT').textContent = setup ? '設定' : '登入';
  $('bnPendN').hidden = !pn; $('bnPendN').textContent = pn;
  $('tnAdd').hidden = $('tnPend').hidden = !canEdit(); $('tnAdmin').hidden = !S.session;
  $('tnPendN').hidden = !pn; $('tnPendN').textContent = pn;
  $('bnav').dataset.n = document.querySelectorAll('#bnav button:not([hidden])').length;
  $('admWho').textContent = S.session ? `目前是「${S.session.label}」` : '';
  $('viewList').classList.toggle('on', S.view !== 'grid'); $('viewList').setAttribute('aria-pressed', S.view !== 'grid');
  $('viewGrid').classList.toggle('on', S.view === 'grid'); $('viewGrid').setAttribute('aria-pressed', S.view === 'grid');
  $('sortSel').value = S.sort;
  renderSync();
  const list = active();
  // 總覽
  $('sumBottles').textContent = S.data ? list.reduce((a, w) => a + total(w), 0) : '—';
  $('sumWines').textContent = S.data ? list.length + ' 款' : '—';
  const origins = new Set(list.map(countryOf).filter(o => o !== '未填產地'));
  if (S.data) { const ym = today().slice(0, 7); $('sumJournal').innerHTML = `${sumQty(journalEntries().filter(e => (e.date || '').startsWith(ym)))} <small>瓶／本月</small>`; }
  $('sumOrigins').textContent = origins.size ? origins.size + ' 國' : '—';
  renderMap(list);
  renderList(list);
  if ($('drawer').open && S.drawer) renderDrawer();
  if ($('journalView').open || ($('adminModal').open && !$('tab-outs').hidden)) renderHistory();
  if ($('adminModal').open && !$('tab-lib').hidden) renderMem();
  if ($('memModal').open) renderMemDetail();
  renderPending();
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
  const all = [...cabs].filter(([, sh]) => sh.size);
  // 電腦版櫃子 3 個以上：先顯示全部櫃子的縮圖總覽，點進去才看完整酒櫃
  const overview = all.length >= 3 && matchMedia(DESK_MQ).matches;
  if (!overview || !all.some(([c]) => c === S.cabOpen)) S.cabOpen = overview ? null : S.cabOpen;
  if (overview && !S.cabOpen) {
    $('map').classList.add('mini-mode');
    $('map').innerHTML = all.map(([cab, sh]) => miniCabHtml(cab, sh)).join('');
    if (!$('mapLegend')) $('map').insertAdjacentHTML('afterend', '<div class="map-legend" id="mapLegend"><span><i class="lg-r"></i>紅酒</span><span><i class="lg-w"></i>白酒</span></div>');
    return;
  }
  $('map').classList.remove('mini-mode');
  const back = overview ? `<button type="button" class="cab-back" data-cabback>‹ 全部 ${all.length} 個櫃子</button>` : '';
  const html = back + all.filter(([cab]) => !overview || cab === S.cabOpen).map(([cab, sh]) => {
    const sum = [...sh.values()].reduce((a, s) => a + s.red + s.white, 0);
    const on = S.filter?.cabinet === cab;
    const shelves = [...sh].sort((a, b) => shelfNo(a[0]) - shelfNo(b[0])).map(([name, s]) => {
      const n = s.red + s.white;
      const sel = on && S.filter.shelf === name;
      return `<button class="fr-shelf ${sel ? 'on' : ''} ${n ? '' : 'zero'}" data-cab="${esc(cab)}" data-shelf="${esc(name)}" aria-pressed="${sel}" aria-label="${esc(cab)} ${esc(name)}：${n} 瓶，${s.wines} 款"><span class="fr-btl" data-r="${s.red}" data-w="${s.white}"></span><span class="fr-rail"><b>${shelfNo(name) < 999 ? shelfNo(name) : esc(name)}</b><em>${n} 瓶${(f => f === null ? '' : f ? ` <span class="cap-pill ok">可再放 ${f}</span>` : ' <span class="cap-pill full">已滿</span>')(freeAt(cab, name, n))}</em></span></button>`;
    }).join('');
    const frees = [...sh].map(([nm, x]) => freeAt(cab, nm, x.red + x.white)).filter(f => f !== null), freeSum = frees.reduce((a, f) => a + f, 0);
    return `<div class="fridge ${on && !S.filter.shelf ? 'on' : ''}"><button class="fr-top" data-cab="${esc(cab)}" aria-pressed="${on && !S.filter.shelf}" aria-label="${esc(cab)}：${sum} 瓶，${sh.size} 層${frees.length ? `，空位 ${freeSum}` : ''}"><span class="fr-name">${esc(cab)}</span><span class="fr-led">${sum}</span><span class="fr-sub">${frees.length ? `<span class="cap-top ${freeSum ? '' : 'full'}">${freeSum ? `空位 <b>${freeSum}</b>` : '已滿'}</span>` : `${sh.size} 層`}</span></button><div class="fr-door"><div class="fr-in">${shelves}</div></div><span class="fr-feet"></span></div>`;
  }).join('');
  $('map').innerHTML = html ? html + '' : '<p class="hint">還沒有存放位置。</p>';
  fillBottles();
  if (html && !$('mapLegend')) $('map').insertAdjacentHTML('afterend', '<div class="map-legend" id="mapLegend"><span><i class="lg-r"></i>紅酒</span><span><i class="lg-w"></i>白酒</span></div>');
}
function miniCabHtml(cab, sh) {
  const rows = [...sh].sort((a, b) => shelfNo(a[0]) - shelfNo(b[0])).map(([name, s]) => ({name, ...s, n: s.red + s.white, free: freeAt(cab, name, s.red + s.white)}));
  const scale = Math.max(1, ...rows.map(r => r.n + (r.free || 0)));
  const sum = rows.reduce((a, r) => a + r.n, 0), frees = rows.filter(r => r.free !== null), freeSum = frees.reduce((a, r) => a + r.free, 0);
  const on = S.filter?.cabinet === cab;
  const bars = rows.map(r => {
    const sel = on && S.filter.shelf === r.name;
    return `<button type="button" class="sb ${sel ? 'on' : ''}" data-cab="${esc(cab)}" data-shelf="${esc(r.name)}" aria-pressed="${sel}" aria-label="${esc(cab)} ${esc(r.name)}：${r.n} 瓶${r.free !== null ? `，可再放 ${r.free}` : ''}"><span class="sn">${shelfNo(r.name) < 999 ? shelfNo(r.name) : esc(r.name)}</span><span class="bar"><i class="r" style="width:${r.red / scale * 100}%"></i><i class="w" style="width:${r.white / scale * 100}%"></i>${r.free ? `<i class="f" style="width:${r.free / scale * 100}%"></i>` : ''}</span><span class="sc">${r.n}${r.free === 0 ? '<em class="full">滿</em>' : ''}</span></button>`;
  }).join('');
  return `<div class="mc ${on ? 'on' : ''}"><button type="button" class="mc-h" data-cabopen="${esc(cab)}" aria-label="打開 ${esc(cab)}：${sum} 瓶"><span class="mc-n">${esc(cab)}</span><span class="mc-led">${sum}</span></button>${bars}<button type="button" class="mc-f" data-cabopen="${esc(cab)}"><span>${rows.length} 層・看整櫃 ›</span>${frees.length ? `<em>${freeSum ? `空位 ${freeSum}` : '已滿'}</em>` : ''}</button></div>`;
}
/* ---------- 各層容量：存「現有＋還可放」，空位＝容量−目前瓶數，出入庫後自動更新 ---------- */
const capOf = (cab, sh) => { const v = S.data?.capacity?.[cab]?.[sh]; return Number.isFinite(v) ? v : null; };
function qtyAt(cab, sh) { let n = 0; for (const w of active()) for (const l of w.locations || []) if (l.cabinet === cab && l.shelf === sh) n += l.quantity || 0; return n; }
const freeAt = (cab, sh, n) => { const c = capOf(cab, sh); return c === null ? null : Math.max(0, c - n); };
/* 每層最多畫兩排：下排排滿，上排少一瓶、疊在兩瓶之間；放不下的以「+n」表示，紅白依比例 */
function fillBottles() {
  for (const el of document.querySelectorAll('#map .fr-btl')) {
    const red = Number(el.dataset.r) || 0, white = Number(el.dataset.w) || 0, n = red + white, cs = getComputedStyle(el);
    const bs = parseFloat(cs.getPropertyValue('--bs')) || 30, gap = parseFloat(cs.getPropertyValue('--gap')) || 3;
    const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const perRow = Math.max(1, Math.floor((width + gap) / (bs + gap))), cap = perRow * 2 - 1;
    const show = n > cap ? cap - 1 : n;   // 放不下時，最後一格改放「+n」
    let wh = white, r = red;
    if (n > cap) { wh = white ? Math.min(white, Math.max(1, Math.round(show * white / n))) : 0; r = show - wh; }
    const key = `${r}|${wh}|${n}`; if (el.dataset.k === key) continue; el.dataset.k = key;
    el.innerHTML = '<i></i>'.repeat(r) + '<i class="w"></i>'.repeat(wh) + (n > show ? `<b class="fr-more" title="還有 ${n - show} 瓶">+${n - show}</b>` : '');
  }
}
function sortWines(rows) {
  const k = S.sort;
  const firstLoc = w => { const l = (w.locations || []).find(x => x.quantity > 0) || {}; return [l.cabinet || '', shelfNo(l.shelf)]; };
  return rows.sort((a, b) => {
    if (k === 'prio') return prioOf(b) - prioOf(a) || (Number(a.vintage) || 9999) - (Number(b.vintage) || 9999) || a.wineId.localeCompare(b.wineId);
    if (k === 'vintage-desc') { const va = Number(a.vintage) || 0, vb = Number(b.vintage) || 0; return vb - va || a.wineId.localeCompare(b.wineId); }
    if (k === 'vintage') return (Number(a.vintage) || 9999) - (Number(b.vintage) || 9999) || a.wineId.localeCompare(b.wineId);
    if (k === 'qty') return total(b) - total(a) || a.wineId.localeCompare(b.wineId);
    if (k === 'name') return a.wineName.localeCompare(b.wineName, 'en');
    if (k === 'loc') { const [ca, sa] = firstLoc(a), [cb, sb] = firstLoc(b); return ca.localeCompare(cb) || sa - sb || a.wineId.localeCompare(b.wineId); }
    return a.wineId.localeCompare(b.wineId);
  });
}
function renderList(list) {
  $('filterBar').hidden = !S.filter;
  if (S.filter) $('filterText').textContent = S.filter.origin ? `只顯示產地：${S.filter.origin}` : `只顯示 ${S.filter.cabinet}${S.filter.shelf ? ' · ' + S.filter.shelf : ''}`;
  const q = S.search.trim().toLowerCase();
  const rows = sortWines(list.filter(w => {
    if (S.filter?.origin && countryOf(w) !== S.filter.origin) return false;
    if (S.filter?.cabinet && !(w.locations || []).some(l => l.quantity > 0 && l.cabinet === S.filter.cabinet && (!S.filter.shelf || l.shelf === S.filter.shelf))) return false;
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
/* 篩選某櫃／某層時，卡片與清單顯示「這層／這櫃」的瓶數，總數另外標示 */
function hereQty(w) {
  const f = S.filter; if (!f?.cabinet) return null;
  return (w.locations || []).filter(l => l.quantity > 0 && l.cabinet === f.cabinet && (!f.shelf || l.shelf === f.shelf)).reduce((a, l) => a + l.quantity, 0);
}
const hereWord = () => S.filter?.shelf ? '這層' : '這櫃';
function rowHtml(w) {
  const t = total(w), h = hereQty(w), part = h !== null && h !== t;
  const locs = (w.locations || []).filter(l => l.quantity > 0).map(l => `<span>${esc(l.cabinet)} · ${esc(l.shelf)}${(w.locations || []).filter(x => x.quantity > 0).length > 1 ? ` ×${l.quantity}` : ''}</span>`).join('');
  return `<button class="row" data-open="${esc(w.wineId)}">
   ${vinHtml(w)}
   <span class="nm"><b>${esc(w.wineName)}${prioOf(w) ? ' ' + pdots(prioOf(w), 'sm') : ''}</b><span>${esc(w.wineryRegion || '')}${w.wineryRegion && w.origin ? ' · ' : ''}${esc(w.origin || '')}</span></span>
   <span class="lc">${locs || '<span>無庫存</span>'}</span>
   <span class="qt">${part ? h : t}<small>${part ? `${hereWord()}・全部共 ${t} 瓶` : esc(w.volume || '瓶')}</small></span></button>`;
}
const prioOf = w => Math.max(0, Math.min(4, Number(w.priority) || 0));
const pdots = (n, cls = '') => `<span class="pdots ${cls}" role="img" aria-label="${n ? `飲用優先 ${n}／4` : '未設飲用優先'}">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}">${cls.includes('num') ? i : ''}</i>`).join('')}</span>`;
function cardHtml(w) {
  const ps = photosOf(w);
  let media;
  if (ps.length > 1) media = `<span class="slides">${ps.map((p, i) => `<img class="ph" src="${esc(fileUrl(p.thumb || p.photo))}" alt="${esc(w.wineName)} ${i + 1}" loading="lazy" draggable="false">`).join('')}</span>${sdots(ps.length)}`;
  else if (ps.length) media = `<img class="ph" src="${esc(thumbUrl(w))}" alt="${esc(w.wineName)}" loading="lazy">`;
  else media = `<span class="ph">${esc(w.vintage || 'NV')}</span>`;
  return `<div class="card ${isWhite(w) ? 'white' : 'red'}" role="button" tabindex="0" data-open="${esc(w.wineId)}"><span class="phbox ${ps.length ? 'photo' : ''}">${media}${pdots(prioOf(w))}</span><span class="cb"><b>${esc(w.wineName)}</b><span class="prod">${esc(w.wineryRegion || '')}</span>${(() => { const t = total(w), h = hereQty(w); return h !== null && h !== t ? `<span class="here">${hereWord()} <strong class="hn">${h}</strong> 瓶</span><span class="tot">${esc(w.vintage || 'NV')}・共 ${t} 瓶</span>` : `<span>${esc(w.vintage || 'NV')} · ${t} 瓶</span>`; })()}</span></div>`;
}

/* ---------- 詳細資料抽屜 ---------- */
function openDrawer(id, fromHash) {
  if (!byId(id)) return;
  S.drawer = id; renderDrawer();
  if (!$('drawer').open) { $('drawer').showModal(); $('drawer').focus({preventScroll: true}); }
  if (!fromHash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}
function closeDrawer() { if ($('drawer').open) $('drawer').close(); }
function outsHtml(w) {
  const outs = (w.outs || []).map(o => ({...o, kind: 'out'})), moves = (w.moves || []).map(m => ({...m, kind: 'move'})), ins = (w.ins || []).map(x => ({...x, kind: 'in'}));
  const all = [...outs, ...moves, ...ins].sort((a, b) => ((b.date || '') + (b.at || '')).localeCompare((a.date || '') + (a.at || '')));
  if (!all.length) return '';
  const outQty = outs.reduce((a, o) => a + (Number(o.qty) || 0), 0);
  const sumText = [ins.length ? `入庫 ${ins.length} 次` : '', outs.length ? `出庫 ${outs.length} 次、${outQty} 瓶` : '', moves.length ? `移動 ${moves.length} 次` : ''].filter(Boolean).join('；');
  const row = e => e.kind === 'in' ? `<div class="out in"><span class="d">${fmtDate(e.date)}</span><span class="q">+${e.qty}</span><span class="r"><b>入庫${e.note ? '　' + esc(e.note) : ''}</b><small>${esc(e.cabinet)} · ${esc(e.shelf)} · ${esc(nameOf(e.by))}</small></span></div>` : e.kind === 'out'
    ? `<div class="out"><span class="d">${fmtDate(e.date)}</span><span class="q">−${e.qty}</span><span class="r"><b>${esc(e.type ? e.type + (e.reason ? '　' + e.reason : '') : e.reason)}</b><small>${esc(e.cabinet)} · ${esc(e.shelf)} · ${esc(nameOf(e.by))}</small></span></div>`
    : `<div class="out mv"><span class="d">${fmtDate(e.date)}</span><span class="q">⇄${e.qty}</span><span class="r"><b>${esc(e.from.cabinet)} · ${esc(e.from.shelf)} → ${esc(e.to.cabinet)} · ${esc(e.to.shelf)}</b><small>移動${e.note ? ' · ' + esc(e.note) : ''} · ${esc(nameOf(e.by))}</small></span></div>`;
  return `<section class="dw-outs"><h3>庫存紀錄 <span class="hint">${sumText}</span></h3>${all.map(row).join('')}</section>`;
}
function galleryHtml(w) {
  const ps = photosOf(w); if (!ps.length) return '';
  const imgs = ps.map((p, i) => `<img src="${esc(fileUrl(p.photo))}" alt="${esc(w.wineName)} 照片 ${i + 1}／${ps.length}" ${i ? 'loading="lazy"' : ''} draggable="false">`).join('');
  return `<div class="gal"><div class="slides">${imgs}</div>${ps.length > 1 ? `<button type="button" class="gnav prev" data-gnav="-1" aria-label="上一張">‹</button><button type="button" class="gnav next" data-gnav="1" aria-label="下一張">›</button>${sdots(ps.length)}` : ''}</div>`;
}
function renderDrawer() {
  const w = byId(S.drawer); if (!w) { closeDrawer(); return; }
  const p = photoUrl(w), ed = canEdit(), t = total(w), archived = w.status === 'archived';
  const facts = `<div><dt>紅酒／白酒</dt><dd>${colorName(w)}</dd></div>` + [['wineryRegion', '酒莊／產區'], ['origin', '產地'], ['volume', '容量'], ['source', '來源'], ['referencePrice', '參考價格'], ['entryDate', '入庫日期'], ['drinkWindow', '適飲期']]
    .map(([k, l]) => `<div><dt>${l}</dt><dd>${k === 'referencePrice' ? fmtPrice(w[k]) : esc(w[k] || '—')}</dd></div>`).join('');
  const locs = (w.locations || []).map(l => `<div class="dw-loc ${S.filter?.cabinet === l.cabinet && (!S.filter.shelf || S.filter.shelf === l.shelf) ? 'here' : ''}"><span class="where">${esc(l.cabinet)} <small>· ${esc(l.shelf)}</small></span><span class="n">${l.quantity}</span></div>`).join('');
  const prevSl = $('drawerBody').querySelector('.slides'), keep = S.drawerShown === S.drawer && prevSl ? prevSl.scrollLeft : 0;
  S.drawerShown = S.drawer;
  $('drawerBody').innerHTML = `
   <div class="dw-top"><span class="id">${archived ? '已出清' : esc(w.volume || '')}</span><button class="x" data-dwclose aria-label="關閉">×</button></div>
   <div class="dw">
    <div class="dw-head"><span class="vin">${esc(w.vintage || 'NV')}</span><h2 id="dwName">${esc(w.wineName)}</h2>${w.wineryRegion ? `<p>${esc(w.wineryRegion)}</p>` : ''}</div>
    ${galleryHtml(w)}
    <div class="dw-stock"><div class="sum"><span>目前庫存</span><b>${t} <small style="font-size:22px">瓶</small></b></div>${locs || '<div class="dw-loc"><span class="where hint">沒有存放位置</span></div>'}</div>
    <div class="dw-prio"><span class="lbl">飲用優先</span>${ed ? `<span class="pdots big" role="group" aria-label="設定飲用優先">${[1, 2, 3, 4].map(i => `<button class="${i <= prioOf(w) ? 'on' : ''}" data-prio="${i}" aria-label="優先 ${i}" aria-pressed="${i === prioOf(w)}">${i}</button>`).join('')}</span>` : pdots(prioOf(w), 'big num')}<span class="hint">${prioOf(w) ? `${prioOf(w)}／4` : '未設定'}${ed ? '　點數字設定等級，4 最優先；再點一次取消' : ''}</span></div>
    <div class="dw-act">${ed ? `${archived ? '' : `<button class="primary" data-stockany="${esc(w.wineId)}" ${t ? '' : 'disabled'}>出庫</button><button class="primary" data-moveany="${esc(w.wineId)}" ${t ? '' : 'disabled'}>移動</button>`}<button class="primary" data-edit="${esc(w.wineId)}">編輯</button><button data-photo="${esc(w.wineId)}">照片（${photosOf(w).length}/${MAX_PHOTOS}）</button>` : ''}${ed ? `<button data-log="${esc(w.wineId)}">異動紀錄</button>` : ''}</div>
    ${ed ? (archived ? '<p class="hint" style="margin:0">這款酒已全部出庫。要補回庫存，請按「編輯」填入瓶數，它會回到目前酒款。</p>' : '') : '<p class="hint" style="margin:0">登入管理後可以出庫、移動與編輯這款酒。</p>'}
    <dl class="dw-facts">${facts}${w.grapeNotes ? `<div class="wide"><dt>葡萄品種／備註</dt><dd class="note">${esc(w.grapeNotes)}</dd></div>` : ''}</dl>
    ${outsHtml(w)}
    <div class="dw-meta">${w.createdAt ? `建立 ${fmtTime(w.createdAt)}（${esc(nameOf(w.createdBy))}）<br>` : ''}最後修改 ${fmtTime(w.updatedAt)}（${esc(nameOf(w.updatedBy))}）${archived ? `<br>出清 ${fmtTime(w.archivedAt)}（${esc(nameOf(w.archivedBy))}）` : ''}</div>
   </div>`;
  if (keep) { const sl = $('drawerBody').querySelector('.slides'); if (sl) { sl.scrollLeft = keep; sl.dispatchEvent(new Event('scroll')); } }
}

/* ---------- 事件 ---------- */
function wire() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('search').addEventListener('input', e => { S.search = e.target.value; render(); });
  $('clearSearch').addEventListener('click', () => { S.search = ''; $('search').value = ''; render(); });
  $('clearFilter').addEventListener('click', () => { S.filter = null; render(); });
  $('factWines').addEventListener('click', () => { S.filter = null; S.search = ''; $('search').value = ''; closeDrawer(); render(); toLedger(); });
  $('factOrigins').addEventListener('click', openOrigins);
  $('factJournal').addEventListener('click', () => { showDialog('journalView'); renderHistory(); });
  $('jTabs').addEventListener('click', e => { const b = e.target.closest('[data-jt]'); if (b) switchJTab(b.dataset.jt); });
  const chipGroup = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fn(b); renderJTab(); } });
  chipGroup('js_type', b => { S.js.type = b.dataset.v; });
  chipGroup('js_when', b => { if (b.hasAttribute('data-hi')) S.js.hi = !S.js.hi; else S.js.when = b.dataset.v; });
  chipGroup('jm_sort', b => { S.jm.sort = b.dataset.v; renderMem(); });
  chipGroup('jm_group', b => { S.jm.group = b.dataset.v; renderMem(); });
  $('js_q').addEventListener('input', e => { S.js.q = e.target.value; renderJSearch(); });
  $('jm_q').addEventListener('input', e => { S.jm.q = e.target.value; renderMem(); });
  $('js_clear').addEventListener('click', () => { $('js_q').value = S.js.q = ''; renderJSearch(); });
  $('jm_clear').addEventListener('click', () => { $('jm_q').value = S.jm.q = ''; renderMem(); });
  for (const id of ['js_list', 'jm_list']) {
    $(id).addEventListener('click', e => { const m = e.target.closest('[data-mem]'); if (m) openMem(m.dataset.mem); });
    $(id).addEventListener('keydown', e => { const m = e.target.closest('[data-mem]'); if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMem(m.dataset.mem); } });
  }
  $('memBody').addEventListener('click', e => {
    const gn = e.target.closest('[data-gnav]'); if (gn) { const sl = gn.parentElement.querySelector('.slides'); sl.scrollBy({left: Number(gn.dataset.gnav) * sl.clientWidth, behavior: 'smooth'}); return; }
    const rb = e.target.closest('[data-rebuy]'); if (rb) return rebuy(rb.dataset.rebuy);
    const op = e.target.closest('[data-memopen]'); if (op) { $('memModal').close(); openDrawer(op.dataset.memopen); }
  });
  for (const id of ['f_vintage', 'f_wineName', 'f_wineryRegion']) $(id).addEventListener('input', renderRebuyNote);
  $('originList').addEventListener('click', e => {
    const b = e.target.closest('[data-origin]'); if (!b) return;
    S.filter = b.dataset.origin ? {origin: b.dataset.origin} : null; S.search = ''; $('search').value = '';
    $('originModal').close(); render(); toLedger();
  });
  $('sortSel').addEventListener('change', e => { S.sort = e.target.value; try { localStorage.setItem('cellarSort', S.sort); } catch {} render(); });
  $('reloadBtn').addEventListener('click', async () => { try { await loadData(true); render(); toast('已同步。'); } catch (e) { toast(msgOf(e)); } });
  $('viewList').addEventListener('click', () => setView('list'));
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('homeLink').addEventListener('click', e => { e.preventDefault(); S.filter = null; S.search = ''; $('search').value = ''; closeDrawer(); scrollTo({top: 0, behavior: 'smooth'}); render(); });
  $('loginBtn').addEventListener('click', async () => {
    try { await loadKeys(); } catch (e) { return toast(msgOf(e)); }
    render();
    if (S.keys) openLogin();
    else if (S.keysSure) showDialog('setupModal');
    else toast('暫時讀不到裝置設定，請稍後再試。');
  });
  $('logoutBtn').addEventListener('click', () => logout());
  $('addBtn').addEventListener('click', () => openWineForm(null));
  $('fab').addEventListener('click', () => openWineForm(null));
  $('adminBtn').addEventListener('click', () => openAdmin());
  $('admMenu').addEventListener('click', e => { if (e.target.closest('[data-act=logout]')) return logout(); const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); });
  const onNav = e => {
    const b = e.target.closest('[data-nav]'); if (!b) return;
    const n = b.dataset.nav;
    if (n === 'home') { S.filter = null; S.cabOpen = null; S.search = ''; if ($('search')) $('search').value = ''; render(); window.scrollTo({top: 0, behavior: 'smooth'}); }
    else if (n === 'journal') $('factJournal').click();
    else if (n === 'add') openWineForm(null);
    else if (n === 'pend') $('factPend').click();
    else if (n === 'admin') openAdmin();
    else if (n === 'login') $('loginBtn').click();
  };
  matchMedia(DESK_MQ).addEventListener('change', () => render());
  $('bnav').addEventListener('click', onNav); $('tnav').addEventListener('click', onNav);
  $('admBack').addEventListener('click', adminMenu);
  matchMedia('(min-width: 761px)').addEventListener('change', () => { if (!$('adminModal').open) return; const cur = ADMIN_TABS.find(t => !$('tab-' + t).hidden); if (admWide()) switchTab(cur || 'lib'); else if (cur) switchTab(cur); });
  $('factPend').addEventListener('click', () => { showDialog('pendModal'); showErr('pendErr', ''); renderPendStrip(); renderPending(); });
  $('exportBtn').addEventListener('click', exportCsv);
  let fbRaf = 0; window.addEventListener('resize', () => { cancelAnimationFrame(fbRaf); fbRaf = requestAnimationFrame(fillBottles); });
  $('map').addEventListener('click', e => {
    const op = e.target.closest('[data-cabopen]');
    if (op) { S.cabOpen = op.dataset.cabopen; S.filter = {cabinet: S.cabOpen, shelf: ''}; render(); return; }
    if (e.target.closest('[data-cabback]')) { S.cabOpen = null; if (S.filter?.cabinet) S.filter = null; render(); return; }
    const b = e.target.closest('[data-cab]'); if (!b) return;
    const next = {cabinet: b.dataset.cab, shelf: b.dataset.shelf || ''};
    S.filter = S.filter && S.filter.cabinet === next.cabinet && S.filter.shelf === next.shelf ? null : next;
    render();
    // 手機與 iPad 直放：酒款在下方，捲過去；iPad 橫放雙欄時右邊直接更新，不捲動
    if (S.filter && matchMedia(TABLET_MQ).matches ? !matchMedia(SPLIT_MQ).matches : S.filter && matchMedia('(max-width:760px)').matches) document.querySelector('.ledger').scrollIntoView({behavior: 'smooth'});
  });
  $('list').addEventListener('click', e => {
    const o = e.target.closest('[data-open]'); if (!o) return;
    openDrawer(o.dataset.open);
  });
  $('list').addEventListener('keydown', e => { const o = e.target.closest('div[data-open]'); if (o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(o.dataset.open); } });
  // 照片輪播：捲動時更新小圓點
  document.addEventListener('scroll', e => {
    const sl = e.target; if (!sl.classList || !sl.classList.contains('slides')) return;
    const i = Math.round(sl.scrollLeft / Math.max(1, sl.clientWidth));
    sl.parentElement.querySelectorAll('.sdots i').forEach((d, k) => d.classList.toggle('on', k === i));
  }, true);
  const dw = $('drawer');
  dw.addEventListener('close', () => { S.drawer = null; if (/^#[WH]\d+$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); });
  dw.addEventListener('click', e => {
    if (e.target === dw) return closeDrawer();
    if (e.target.closest('[data-dwclose]')) return closeDrawer();
    const st = e.target.closest('[data-stock]'); if (st) return openStock(st.dataset.stock, st.dataset.cab, st.dataset.shelf);
    const sa = e.target.closest('[data-stockany]'); if (sa) return openStock(sa.dataset.stockany);
    const mv = e.target.closest('[data-move]'); if (mv) return openMove(mv.dataset.move, mv.dataset.cab, mv.dataset.shelf);
    const ma = e.target.closest('[data-moveany]'); if (ma) return openMove(ma.dataset.moveany);
    const pr = e.target.closest('[data-prio]'); if (pr) return setPriority(S.drawer, Number(pr.dataset.prio));
    const ed = e.target.closest('[data-edit]'); if (ed) return openWineForm(byId(ed.dataset.edit));
    const gn = e.target.closest('[data-gnav]'); if (gn) { const sl = gn.parentElement.querySelector('.slides'); sl.scrollBy({left: Number(gn.dataset.gnav) * sl.clientWidth, behavior: 'smooth'}); return; }
    const ph = e.target.closest('[data-photo]'); if (ph) return openPhoto(byId(ph.dataset.photo));
    const lg = e.target.closest('[data-log]'); if (lg) { showDialog('adminModal'); switchTab('audit', true); loadAudit(lg.dataset.log, 1); checkStorage(); }
  });
  $('f_volumeChoice').addEventListener('change', e => { $('f_volumeOther').hidden = e.target.value !== '__other__'; });
  $('f_sourceChoice').addEventListener('change', e => { $('f_sourceOther').hidden = e.target.value !== '__other__'; });
  $('addLoc').addEventListener('click', () => addLocRow());
  $('locInputs').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.loc-ed').remove(); });
  for (const id of ['f_camera', 'f_gallery']) $(id).addEventListener('change', async e => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - S.pendKeep.length - S.newPhotos.length); e.target.value = '';
    showErr('wineErr', '');
    for (const f of files) { try { S.newPhotos.push(await compress(f)); } catch (err) { showErr('wineErr', err?.user ? err.message : '有一張圖片無法讀取，請換一張。'); } }
    renderNewStrip();
  });
  $('f_strip').addEventListener('click', e => {
    const b = e.target.closest('[data-nrm]'); if (b) { S.newPhotos.splice(Number(b.dataset.nrm), 1); renderNewStrip(); }
    const k = e.target.closest('[data-krm]'); if (k) { S.pendKeep.splice(Number(k.dataset.krm), 1); renderNewStrip(); }
  });
  for (const id of ['q_camera', 'q_gallery']) $(id).addEventListener('change', async e => {
    const files = [...e.target.files], room = MAX_PHOTOS - S.pendNew.length; e.target.value = '';
    showErr('pendErr', files.length > room ? `每瓶最多 ${MAX_PHOTOS} 張，只加入前 ${room} 張。` : '');
    for (const f of files.slice(0, room)) { try { S.pendNew.push(await compress(f)); renderPendStrip(); } catch (err) { showErr('pendErr', err?.user ? err.message : '有一張圖片無法讀取，請換一張。'); } }
    renderPendStrip();
  });
  $('q_strip').addEventListener('click', e => { const b = e.target.closest('[data-qrm]'); if (b) { S.pendNew.splice(Number(b.dataset.qrm), 1); renderPendStrip(); } });
  $('q_save').addEventListener('click', savePending);
  $('pendList').addEventListener('click', e => {
    const ed = e.target.closest('[data-pedit]'); if (ed) return editPending(ed.dataset.pedit);
    const d = e.target.closest('[data-pdelq]'); if (d) return deletePending(d);
    const rm = e.target.closest('[data-pprm]'); if (rm) return removePendPhoto(rm.closest('[data-pid]').dataset.pid, rm.dataset.pprm);
  });
  $('aiForm').addEventListener('submit', e => { e.preventDefault(); submit('aiForm', 'aiErr', saveAiSettings); });
  $('ai_provider').addEventListener('change', () => { $('ai_modelBox').hidden = true; $('ai_key').value = ''; showErr('aiErr', ''); });
  $('ai_model').addEventListener('change', () => { const c = getAI(); if (c) { c.model = $('ai_model').value; setAI(c); setAIPref({provider: c.provider, model: c.model}); renderAiSettings(); } });
  $('aiRemove').addEventListener('click', () => { if (!confirm('移除這台裝置上的 AI 金鑰？「智慧辨識」按鈕會隱藏。')) return; setAI(null); renderAiSettings(); toast('已移除 AI 金鑰。'); });
  $('aiBtn').addEventListener('click', aiRecognize);
  setTimeout(() => { sweepAI(); scheduleAiExpiry(); });  // 等整個程式載入完再執行
  for (const id of ['f_wineName', 'f_wineryRegion', 'f_vintage', 'f_origin', 'f_grapeNotes', 'f_volumeChoice', 'f_volumeOther']) $(id).addEventListener('input', e => e.target.classList.remove('ai-filled', 'ai-guess'));
  $('pendList').addEventListener('change', e => {
    const inp = e.target.closest('[data-padd]'); if (!inp) return;
    const files = [...inp.files]; inp.value = ''; addPendPhotos(inp.closest('[data-pid]').dataset.pid, files);
  });
  $('p_camera').addEventListener('change', e => addPhotos(e.target.files));
  $('p_gallery').addEventListener('change', e => addPhotos(e.target.files));
  setupPhotoDrag();
  $('pgrid').addEventListener('click', e => { const c = e.target.closest('[data-pcover]'); if (c) return coverPhoto(c.dataset.pcover); const d = e.target.closest('[data-pdel]'); if (d) return deletePhoto(d); });
  $('loginForm').addEventListener('submit', e => { e.preventDefault(); submit('loginForm', 'loginErr', doLogin); });
  $('setupForm').addEventListener('submit', e => { e.preventDefault(); submit('setupForm', 'setupErr', doSetup); });
  $('wineForm').addEventListener('submit', e => { e.preventDefault(); submit('wineForm', 'wineErr', saveWine); });
  $('stockForm').addEventListener('submit', e => { e.preventDefault(); submit('stockForm', 'stockErr', saveStock); });
  $('moveForm').addEventListener('submit', e => { e.preventDefault(); submit('moveForm', 'moveErr', saveMove); });
  document.querySelectorAll('input[name=s_type]').forEach(r => r.addEventListener('change', () => { $('s_reasonLbl').textContent = r.value === '其他' ? '說明 *' : '說明（選填）'; }));
  $('locForm').addEventListener('submit', e => { e.preventDefault(); submit('locForm', 'locErr', saveCatalog); });
  $('capForm').addEventListener('submit', e => { e.preventDefault(); submit('capForm', 'capErr', saveCapacity); });
  $('slotForm').addEventListener('submit', e => { e.preventDefault(); submit('slotForm', 'keysErr', addSlot); });
  $('tokenForm').addEventListener('submit', e => { e.preventDefault(); submit('tokenForm', 'keysErr', changeToken); });
  $('moreAudit').addEventListener('click', () => loadAudit(S.auditWine, S.auditPage + 1));
  $('cabChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeCatalog('cabinets', b.dataset.rm); });
  $('shelfChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeCatalog('shelves', b.dataset.rm); });
  const openHist = e => { const h = e.target.closest('[data-hist]'); if (!h || (e.type === 'keydown' && e.key !== 'Enter')) return; h.closest('dialog')?.close(); openDrawer(h.dataset.hist); };
  for (const id of ['histList', 'histGone']) { $(id).addEventListener('click', openHist); $(id).addEventListener('keydown', openHist); }
  $('jPrev').addEventListener('click', () => shiftMonth(-1));
  $('jNext').addEventListener('click', () => shiftMonth(1));
  $('jCal').addEventListener('click', e => { const b = e.target.closest('[data-jday]'); if (b && !b.disabled) { S.jDay = b.dataset.jday; renderJournal(); } });
  $('jAdd').addEventListener('click', () => openJournal());
  $('jDayList').addEventListener('click', e => {
    const r = e.target.closest('[data-rate]'); if (r) { e.stopPropagation(); return setRating(r.dataset.key, Number(r.dataset.rate)); }
    const ed = e.target.closest('[data-jedit]'); if (ed) return openJournal(ed.dataset.jedit);
    const dl = e.target.closest('[data-jdel]'); if (dl) return deleteJournal(dl);
    openHist(e);
  });
  $('jDayList').addEventListener('keydown', e => { if (!e.target.closest('button')) openHist(e); });
  $('journalForm').addEventListener('submit', e => { e.preventDefault(); submit('journalForm', 'journalErr', saveJournal); });
  document.querySelectorAll('input[name=j_src]').forEach(r => r.addEventListener('change', () => { S.jf = {src: '', cab: '', shelf: '', wineId: '', miss: false}; showErr('journalErr', ''); syncJournalForm(); }));
  $('j_pick').addEventListener('click', journalPick);
  $('j_pick').addEventListener('keydown', e => { const v = e.target.closest('[data-jview]'); if (v && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); openViewer(v.dataset.jview); } });
  $('viewerBody').addEventListener('click', e => { const gn = e.target.closest('[data-gnav]'); if (gn) { const sl = gn.parentElement.querySelector('.slides'); sl.scrollBy({left: Number(gn.dataset.gnav) * sl.clientWidth, behavior: 'smooth'}); } }); $('j_path').addEventListener('click', journalPick);
  $('j_missBtn').addEventListener('click', startMissing);
  $('j_left').addEventListener('input', syncJournalForm);
  $('j_stars').addEventListener('click', e => { const b = e.target.closest('[data-jstar]'); if (b) { const n = Number(b.dataset.jstar); S.jRating = S.jRating === n ? 0 : n; syncJournalForm(); } });
  for (const id of ['j_camera', 'j_gallery']) $(id).addEventListener('change', e => pickPhoto(e.target.files[0], 'j_preview', b => S.jPhoto = b, 'journalErr'));
  $('h_year').addEventListener('change', e => { S.histYear = e.target.value; renderHistory(); });
  $('h_types').addEventListener('click', e => { const b = e.target.closest('[data-htype]'); if (b) { S.histType = b.dataset.htype; renderHistory(); } });
  $('slotList').addEventListener('click', e => { const b = e.target.closest('[data-delslot]'); if (b) deleteSlot(b); });
}
function toLedger() { document.querySelector('.ledger').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); }
function openOrigins() {
  const groups = new Map();
  for (const w of active()) { const c = countryOf(w), g = groups.get(c) || {wines: 0, bottles: 0}; g.wines++; g.bottles += total(w); groups.set(c, g); }
  const rows = [...groups].sort((a, b) => (a[0] === '未填產地') - (b[0] === '未填產地') || b[1].bottles - a[1].bottles || a[0].localeCompare(b[0]));
  const cur = S.filter?.origin;
  $('originList').innerHTML = `<button class="origin ${cur ? '' : 'on'}" data-origin=""><b>全部產地</b><span>${active().length} 款</span><span>${active().reduce((a, w) => a + total(w), 0)} 瓶</span></button>` +
    rows.map(([c, g]) => `<button class="origin ${cur === c ? 'on' : ''}" data-origin="${esc(c)}"><b>${esc(c)}</b><span>${g.wines} 款</span><span>${g.bottles} 瓶</span></button>`).join('');
  showDialog('originModal');
}
function setView(v) { S.view = v; try { localStorage.setItem('cellarView', v); } catch {} render(); }
async function submit(formId, errId, fn) {
  const form = $(formId); if (form.dataset.busy) return; form.dataset.busy = '1';
  const btns = [...form.querySelectorAll('button')]; btns.forEach(b => b.disabled = true); showErr(errId, '');
  try { await fn(); } catch (e) { showErr(errId, msgOf(e)); if (!e.user) console.error(e); }
  finally { delete form.dataset.busy; btns.forEach(b => b.disabled = false); }
}
const ADMIN_TABS = ['lib', 'outs', 'audit', 'loc', 'ai', 'keys', 'export', 'storage'];
const admWide = () => matchMedia('(min-width: 761px)').matches;
function adminMenu() {  // 手機：回到分組清單
  $('admBody').dataset.view = 'menu'; $('adminTitle').textContent = '管理'; $('admBack').hidden = true;
  $('keysTab').hidden = !isAdmin();
  document.querySelectorAll('#admMenu [data-tab]').forEach(b => b.classList.remove('on'));
}
function openAdmin(name) {
  showDialog('adminModal');
  if (name || admWide()) switchTab(name || 'lib'); else adminMenu();
  checkStorage();
}
function switchTab(name, noLoad) {
  document.querySelectorAll('#admMenu [data-tab]').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  for (const t of ADMIN_TABS) $('tab-' + t).hidden = t !== name;
  $('admBody').dataset.view = 'page'; $('admBack').hidden = admWide();
  const label = document.querySelector(`#admMenu [data-tab="${name}"] b`)?.textContent || '';
  $('adminTitle').textContent = admWide() ? (label ? `管理 › ${label}` : '管理') : label || '管理';
  $('admMain').scrollTop = 0;
  $('keysTab').hidden = !isAdmin();
  if (name === 'loc') renderAdmin();
  if (name === 'outs') renderHistory();
  if (name === 'keys') renderSlots();
  if (name === 'ai') renderAiSettings();
  if (name === 'lib') renderMem();
  if (name === 'audit' && !noLoad) loadAudit('', 1);
}

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
  if (S.keys) { $('setupModal').close(); render(); openLogin(); toast('已經完成過初始設定，請選擇裝置並輸入密碼登入。'); return; }
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
/* 櫃位／層位一律用下拉選單：選項來自「管理 → 櫃位／層位」與目前資料裡用過的名稱 */
const byShelf = (a, b) => shelfNo(a) - shelfNo(b) || a.localeCompare(b);
function shelvesOf(cab) {  // 這個櫃子用過的層位（含已出清、出庫與移動紀錄）
  const set = new Set();
  for (const w of wines()) {
    for (const l of w.locations || []) if (l.cabinet === cab && l.shelf) set.add(l.shelf);
    for (const o of w.outs || []) if (o.cabinet === cab && o.shelf) set.add(o.shelf);
    for (const m of w.moves || []) for (const x of [m.from, m.to]) if (x?.cabinet === cab && x.shelf) set.add(x.shelf);
  }
  return [...set].sort(byShelf);
}
function cabOptionsHtml(val) {
  const names = locOptions('cabinets'); if (val && !names.includes(val)) names.push(val);
  return `<option value="">${names.length ? '請選擇櫃位' : '尚無櫃位（請到 管理 → 櫃位／層位 新增）'}</option>` + names.map(n => `<option value="${esc(n)}" ${n === val ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function shelfOptionsHtml(cab, val) {
  if (!cab) return '<option value="">先選櫃位</option>';
  const here = shelvesOf(cab), other = locOptions('shelves').filter(n => !here.includes(n)).sort(byShelf);
  if (val && !here.includes(val) && !other.includes(val)) here.push(val);
  const opt = n => `<option value="${esc(n)}" ${n === val ? 'selected' : ''}>${esc(n)}</option>`;
  if (!here.length && !other.length) return '<option value="">尚無層位（請到 管理 → 櫃位／層位 新增）</option>';
  return '<option value="">請選擇層位</option>' + (here.length && other.length ? `<optgroup label="這個櫃子的層位">${here.map(opt).join('')}</optgroup><optgroup label="其他層位">${other.map(opt).join('')}</optgroup>` : [...here, ...other].map(opt).join(''));
}
function fillLocPair(cabEl, shelfEl, cab = '', shelf = '') {
  cabEl.innerHTML = cabOptionsHtml(cab); shelfEl.innerHTML = shelfOptionsHtml(cab, shelf);
  if (!cabEl.dataset.bound) { cabEl.dataset.bound = '1'; cabEl.addEventListener('change', () => { shelfEl.innerHTML = shelfOptionsHtml(cabEl.value, shelfEl.value); }); }
}
function ensureLists() {
  let c = $('cabList'), s = $('shelfList');
  if (!c) { c = document.createElement('datalist'); c.id = 'cabList'; document.body.append(c); s = document.createElement('datalist'); s.id = 'shelfList'; document.body.append(s); }
  c.innerHTML = locOptions('cabinets').map(n => `<option value="${esc(n)}">`).join('');
  s.innerHTML = locOptions('shelves').map(n => `<option value="${esc(n)}">`).join('');
}
function addLocRow(l = {cabinet: '', shelf: '', quantity: 1}) {
  const i = $('locInputs').children.length + '_' + Math.random().toString(36).slice(2, 6);
  const row = document.createElement('div'); row.className = 'loc-ed';
  row.innerHTML = `<div class="field"><label for="lc${i}">櫃位</label><select id="lc${i}" data-k="cabinet"></select></div><div class="field"><label for="ls${i}">層位</label><select id="ls${i}" data-k="shelf"></select></div><div class="field"><label for="lq${i}">瓶數</label><input id="lq${i}" type="number" min="0" step="1" inputmode="numeric" data-k="quantity" value="${Number(l.quantity) || 0}"></div><button type="button" data-rm aria-label="移除位置">×</button>`;
  $('locInputs').append(row);
  fillLocPair(row.querySelector('[data-k=cabinet]'), row.querySelector('[data-k=shelf]'), l.cabinet, l.shelf);
}
function setChoice(selId, otherId, value, fallback) {
  const v = value || fallback, sel = $(selId);
  const std = [...sel.options].some(o => o.value === v && o.value !== '__other__');
  sel.value = std ? v : '__other__'; $(otherId).hidden = std; $(otherId).value = std ? '' : v;
}
function renderNewStrip() {
  const el = $('f_strip'); if (!el) return;
  const keep = S.pendKeep || [], n = keep.length;
  el.innerHTML = keep.map((ph, i) => `<span class="nthumb"><img src="${esc(fileUrl(ph.thumb || ph.photo))}" alt="照片 ${i + 1}">${i === 0 ? '<em>封面</em>' : ''}<button type="button" data-krm="${i}" aria-label="移除這張">×</button></span>`).join('')
    + (S.newPhotos || []).map((ph, i) => `<span class="nthumb"><img src="${URL.createObjectURL(ph.thumb)}" alt="照片 ${n + i + 1}">${n + i === 0 ? '<em>封面</em>' : ''}<button type="button" data-nrm="${i}" aria-label="移除這張">×</button></span>`).join('');
  const full = n + (S.newPhotos || []).length >= MAX_PHOTOS;
  document.querySelectorAll('#newPhotoField .photo-in label').forEach(l => l.hidden = full);
  renderAiRow();
}
function openWineForm(w, pend, rb) {
  document.querySelectorAll('#wineForm .ai-filled, #wineForm .ai-guess').forEach(el => el.classList.remove('ai-filled', 'ai-guess'));
  $('aiMsg').textContent = '';
  S.editing = w; S.fromPend = !w && pend || null; S.rebuy = !w && !pend && rb || null;
  S.pendKeep = S.fromPend ? S.fromPend.photos.slice() : S.rebuy ? (S.rebuy.kind === 'cellar' ? photosOf(S.rebuy.w).slice() : S.rebuy.photoRec ? [S.rebuy.photoRec] : []) : [];
  S.newPhotos = []; renderNewStrip(); ensureLists();
  $('wineTitle').textContent = w ? '編輯酒款' : S.fromPend ? '補資料並加入酒櫃' : S.rebuy ? '再買一次' : '新增紅酒';
  for (const [k] of FIELDS) { const el = $('f_' + k); if (el) el.value = w?.[k] ?? ''; }
  setChoice('f_volumeChoice', 'f_volumeOther', w?.volume, '750ml');
  setChoice('f_sourceChoice', 'f_sourceOther', w?.source, '');
  const col = w && isWhite(w) ? 'white' : 'red';
  document.querySelectorAll('input[name=f_color]').forEach(r => r.checked = r.value === col);
  $('locInputs').replaceChildren(); (w?.locations?.length ? w.locations : [{cabinet: '', shelf: '', quantity: 1}]).forEach(addLocRow);
  $('locHint').hidden = !w; $('locLbl').textContent = w ? '存放位置與瓶數' : '存放位置與初始瓶數';
  $('newPhotoField').hidden = !!w; $('f_camera').value = ''; $('f_gallery').value = '';
  document.querySelectorAll('#wineForm .rb-filled, #wineForm .rb-check').forEach(el => el.classList.remove('rb-filled', 'rb-check'));
  if (S.rebuy) {
    const src = S.rebuy.kind === 'cellar' ? S.rebuy.w : {wineName: S.rebuy.name, vintage: S.rebuy.vintage};
    for (const k of ['wineName', 'wineryRegion', 'vintage', 'origin', 'drinkWindow', 'grapeNotes', 'referencePrice']) { const el = $('f_' + k); if (el && src[k] != null && src[k] !== '') { el.value = src[k]; el.classList.add('rb-filled'); } }
    if (src.volume) setChoice('f_volumeChoice', 'f_volumeOther', src.volume, '750ml');
    if (src.source) setChoice('f_sourceChoice', 'f_sourceOther', src.source, '');
    if (S.rebuy.kind === 'cellar') { const col = isWhite(src) ? 'white' : 'red'; document.querySelectorAll('input[name=f_color]').forEach(r => r.checked = r.value === col); }
    $('f_entryDate').value = today();
    $('f_vintage').classList.add('rb-check'); document.querySelectorAll('#locInputs select, #locInputs [data-k=quantity]').forEach(el => el.classList.add('rb-check'));
    renderNewStrip();
  }
  renderRebuyNote();
  showDialog('wineModal');
}
function readWineForm() {
  const r = {};
  for (const [k] of FIELDS) { if (k === 'volume' || k === 'source' || k === 'referencePrice') continue; r[k] = $('f_' + k).value.trim(); }
  r.volume = ($('f_volumeChoice').value === '__other__' ? $('f_volumeOther').value : $('f_volumeChoice').value).trim();
  r.source = ($('f_sourceChoice').value === '__other__' ? $('f_sourceOther').value : $('f_sourceChoice').value).trim();
  r.color = document.querySelector('input[name=f_color]:checked')?.value === 'white' ? 'white' : 'red';
  const price = $('f_referencePrice').value.trim(); r.referencePrice = price === '' ? null : Number(price);
  if (!r.wineName) fail('請填寫酒名。');
  if (r.referencePrice !== null && (!Number.isFinite(r.referencePrice) || r.referencePrice < 0)) fail('參考價格格式不正確。');
  const seen = new Set(); r.locations = [];
  for (const row of $('locInputs').children) {
    const g = k => row.querySelector(`[data-k="${k}"]`).value.trim();
    const cabinet = g('cabinet'), shelf = g('shelf'), quantity = Number(g('quantity'));
    if (!cabinet && !shelf) continue;
    if (!cabinet || !shelf) fail('每個位置都要選擇櫃位與層位。');
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
      if (isWhite(cur) !== (r.color === 'white')) changes.push(`紅酒／白酒：${colorName(cur)} → ${r.color === 'white' ? '白酒' : '紅酒'}`);
      if (JSON.stringify(cur.locations || []) !== JSON.stringify(r.locations)) changes.push(`位置：${locText(cur.locations)} → ${locText(r.locations)}`);
      return changes;
    }, changes => `編輯 ${id} ${r.wineName}${changes.length ? '' : '（無變更）'}${changes.length ? '\n\n' + changes.join('\n') : ''}`);
    $('wineModal').close(); toast('已更新「' + r.wineName + '」。');
  } else {
    const target = S.rebuy ? rebuyTarget() : null;
    if (target) return mergeRebuy(target, r, who);
    const src = S.fromPend, photos = S.pendKeep.slice();
    for (const ph of S.newPhotos) photos.push(await uploadPhoto(ph, 'new'));
    const photo = photos[0]?.photo || '', thumb = photos[0]?.thumb || '';
    const id = await mutate(d => {
      if (src) { const i = (d.pending || []).findIndex(x => x.id === src.id); if (i < 0) fail('這瓶已被其他人加入酒櫃或刪除，請關閉後重新整理。'); d.pending.splice(i, 1); }
      const n = Object.keys(d.wines).reduce((m, k) => /^W\d+$/.test(k) ? Math.max(m, Number(k.slice(1))) : m, 0) + 1;
      const wid = 'W' + String(n).padStart(3, '0'), t = now();
      d.wines[wid] = {...r, photo, thumb, photos, status: total(r) > 0 ? 'active' : 'archived', createdAt: t, createdBy: who, updatedAt: t, updatedBy: who, revision: 1};
      return wid;
    }, wid => `新增 ${wid} ${r.wineName}${src ? '（由待入櫃加入）' : ''}\n\n位置：${locText(r.locations)}`);
    S.fromPend = null; S.pendKeep = []; S.rebuy = null;
    if (src) { const kept = new Set(photos.map(p => p.photo)), drop = src.photos.filter(p => !kept.has(p.photo)); if (drop.length) deleteFiles(drop.flatMap(p => [p.photo, p.thumb]), id).then(checkStorage); }
    $('wineModal').close(); openDrawer(id); toast('已新增「' + r.wineName + '」。');
  }
}

/* 同一年份再買：把瓶數加到原本那款，並記一筆入庫 */
async function mergeRebuy(target, r, who) {
  const add = r.locations.filter(l => l.quantity > 0);
  if (!add.length) fail('請選擇存放位置並填寫瓶數。');
  const id = target.wineId, n = add.reduce((a, l) => a + l.quantity, 0), date = r.entryDate || today();
  const fresh = [];
  for (const ph of S.newPhotos) fresh.push(await uploadPhoto(ph, id));
  const res = await mutate(d => {
    const cur = d.wines[id]; if (!cur) fail('原本的酒款已不存在，請重新整理。');
    const before = (cur.locations || []).reduce((a, l) => a + (l.quantity || 0), 0), t = now();
    cur.locations = cur.locations || [];
    for (const l of add) { const ex = cur.locations.find(x => x.cabinet === l.cabinet && x.shelf === l.shelf); if (ex) ex.quantity += l.quantity; else cur.locations.push({...l}); }
    cur.ins = [...(cur.ins || []), ...add.map(l => ({date, qty: l.quantity, cabinet: l.cabinet, shelf: l.shelf, note: '再買一次', by: who, at: t}))];
    if (fresh.length) { const list = photosOf(cur).slice(); for (const p of fresh) if (list.length < MAX_PHOTOS) list.push(p); setPhotos(cur, list); }
    cur.status = 'active'; delete cur.archivedAt; delete cur.archivedBy;
    cur.updatedAt = t; cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
    return {before, after: before + n};
  }, x => `再買入庫 ${id} ${target.wineName}${target.vintage ? ' ' + target.vintage : ''}：+${n} 瓶（庫存 ${x.before} → ${x.after}）\n\n位置：${add.map(l => `${l.cabinet}/${l.shelf}+${l.quantity}`).join('、')}`);
  S.rebuy = null; S.pendKeep = [];
  $('wineModal').close(); openDrawer(id); toast(`已加到原本的「${target.wineName}${target.vintage ? ' ' + target.vintage : ''}」，庫存 ${res.before} → ${res.after} 瓶。`);
}

/* ---------- 出庫 ---------- */
function locPicker(el, name, legend, w, cab, shelf) {
  const locs = (w.locations || []).map((l, i) => ({...l, i})).filter(l => l.quantity > 0);
  let pick = locs.find(l => l.cabinet === cab && l.shelf === shelf) || locs[0];
  el.innerHTML = `<legend>${legend}</legend>` + locs.map(l => `<label><input type="radio" name="${name}" value="${l.i}" ${l === pick ? 'checked' : ''}><span><b>${esc(l.cabinet)} · ${esc(l.shelf)}</b><em>${l.quantity} 瓶</em></span></label>`).join('');
}
const pickedLoc = (name, w) => { const v = document.querySelector(`input[name=${name}]:checked`)?.value; return v === undefined ? null : w.locations?.[Number(v)]; };
function openStock(id, cab, shelf) {
  const w = byId(id); if (!w) return; S.stock = w;
  $('stockWine').textContent = [w.wineName, w.vintage].filter(Boolean).join('　');
  locPicker($('s_loc'), 's_locr', '選擇位置', w, cab, shelf);
  $('s_reason').value = ''; $('s_qty').value = '1'; $('s_date').value = today(); $('s_date').max = today();
  document.querySelectorAll('input[name=s_type]').forEach(r => r.checked = false); $('s_reasonLbl').textContent = '說明（選填）';
  showDialog('stockModal');
}
async function saveStock() {
  const id = S.stock.wineId, picked = pickedLoc('s_locr', S.stock) || {}, {cabinet, shelf} = picked, qty = Number($('s_qty').value), reason = $('s_reason').value.trim(), date = $('s_date').value, type = document.querySelector('input[name=s_type]:checked')?.value || '', who = S.session.label;
  if (!cabinet) fail('請選擇目前有庫存的位置。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('請填寫出庫日期。');
  if (date > today()) fail('出庫日期不能晚於今天。');
  if (date < '1990-01-01') fail('出庫日期不正確，請重新選擇。');
  if (!type) fail('請選擇出庫類型：自飲、聚餐、送禮或其他。');
  if (type === '其他' && !reason) fail('選「其他」時請填寫說明。');
  if (!Number.isInteger(qty) || qty < 1) fail('瓶數必須是 1 以上的整數。');
  const res = await mutate(d => {
    const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
    const l = (cur.locations || []).find(x => x.cabinet === cabinet && x.shelf === shelf);
    if (!l || l.quantity <= 0) fail('這個位置已沒有庫存，沒有扣除任何瓶數。');
    if (l.quantity < qty) fail(`此位置只剩 ${l.quantity} 瓶，沒有扣除任何瓶數。`);
    const old = l.quantity; l.quantity -= qty;
    const t = now(); cur.updatedAt = t; cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
    cur.outs = [...(cur.outs || []), {date, type, qty, cabinet, shelf, reason, by: who, at: t}];
    const archived = cur.locations.every(x => !x.quantity);
    if (archived) { cur.status = 'archived'; cur.archivedAt = t; cur.archivedBy = who; }
    return {old, left: l.quantity, archived, name: cur.wineName};
  }, x => `出庫 ${id} ${x.name}（${type}）：${cabinet}/${shelf} ${x.old}→${x.left}（−${qty}）${x.archived ? '，全部出清' : ''}\n\n日期：${date}\n類型：${type}${reason ? '\n說明：' + reason : ''}`);
  $('stockModal').close();
  toast(res.archived ? `「${res.name}」已全部出庫，移入歷史酒單。` : `${fmtDate(date)} ${type}出庫 ${qty} 瓶，${cabinet} / ${shelf} 剩 ${res.left} 瓶。`);
}

/* ---------- 飲用優先 ---------- */
async function setPriority(id, n) {
  const w = byId(id); if (!w || !canEdit() || S.prioBusy) return;
  const next = n === prioOf(w) ? 0 : n;
  S.prioBusy = true; document.querySelectorAll('#drawer [data-prio]').forEach(b => b.disabled = true);
  try {
    await mutate(d => {
      const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
      const old = prioOf(cur);
      if (next) cur.priority = next; else delete cur.priority;
      return old;
    }, old => `飲用優先 ${id} ${w.wineName}：${old} → ${next}`, {quiet: true});
    toast(next ? `「${w.wineName}」設為飲用優先 ${next}。` : `已取消「${w.wineName}」的飲用優先。`);
  } catch (e) { toast(msgOf(e)); }
  finally { S.prioBusy = false; if ($('drawer').open) renderDrawer(); }
}

/* ---------- 移動位置 ---------- */
function openMove(id, cab, shelf) {
  const w = byId(id); if (!w) return; S.move = w; ensureLists();
  $('moveWine').textContent = [w.wineName, w.vintage].filter(Boolean).join('　');
  locPicker($('m_from'), 'm_fromr', '從哪裡移出', w, cab, shelf);
  fillLocPair($('m_cab'), $('m_shelf')); $('m_qty').value = '1'; $('m_note').value = '';
  $('m_date').value = today(); $('m_date').max = today();
  showDialog('moveModal');
}
async function saveMove() {
  const id = S.move.wineId, from = pickedLoc('m_fromr', S.move);
  const to = {cabinet: $('m_cab').value.trim(), shelf: $('m_shelf').value.trim()};
  const qty = Number($('m_qty').value), date = $('m_date').value, note = $('m_note').value.trim(), who = S.session.label;
  if (!from) fail('請選擇要從哪個位置移出。');
  if (!to.cabinet || !to.shelf) fail('請選擇要移到的櫃位和層位。');
  if (to.cabinet === from.cabinet && to.shelf === from.shelf) fail('新位置和原位置相同。');
  if (!Number.isInteger(qty) || qty < 1) fail('瓶數必須是 1 以上的整數。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('請填寫日期。');
  if (date > today()) fail('日期不能晚於今天。');
  const res = await mutate(d => {
    const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
    const locs = cur.locations || [];
    const src = locs.find(x => x.cabinet === from.cabinet && x.shelf === from.shelf);
    if (!src || src.quantity <= 0) fail('原位置已沒有庫存，請重新整理。');
    if (src.quantity < qty) fail(`原位置只剩 ${src.quantity} 瓶。`);
    src.quantity -= qty;
    let dst = locs.find(x => x.cabinet === to.cabinet && x.shelf === to.shelf);
    if (dst) dst.quantity += qty; else { dst = {cabinet: to.cabinet, shelf: to.shelf, quantity: qty}; locs.push(dst); }
    cur.locations = locs.filter(x => x.quantity > 0 || x === dst);
    const t = now(); cur.updatedAt = t; cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
    cur.moves = [...(cur.moves || []), {date, qty, from: {cabinet: from.cabinet, shelf: from.shelf}, to, note, by: who, at: t}];
    d.catalog = d.catalog || {cabinets: [], shelves: []};
    if (!d.catalog.cabinets.includes(to.cabinet)) d.catalog.cabinets.push(to.cabinet);
    if (!d.catalog.shelves.includes(to.shelf)) d.catalog.shelves.push(to.shelf);
    return {name: cur.wineName, now: dst.quantity};
  }, x => `移動 ${id} ${x.name}：${from.cabinet}/${from.shelf} → ${to.cabinet}/${to.shelf}（×${qty}）\n\n日期：${date}${note ? '\n備註：' + note : ''}`);
  $('moveModal').close();
  toast(`已移動 ${qty} 瓶到 ${to.cabinet} / ${to.shelf}（那裡現有 ${res.now} 瓶）。`);
}

/* ---------- 照片 ---------- */
/* 照片：大圖壓到 200 KB 以內（長邊 1280→1024→800px、品質 82%→52%），超過 400 KB 拒絕；另存 480px 縮圖給照片模式。 */
const PHOTO = {target: 200 * 1024, max: 400 * 1024, sizes: [1280, 1024, 800], qualities: [.82, .72, .62, .52], thumb: 480, thumbTarget: 25 * 1024, thumbQs: [.6, .5, .4, .3]};
const kb = n => Math.round(n / 1024) + ' KB';
function pickPhoto(file, previewId, set, errId) {
  if (!file) return; showErr(errId, '');
  const img = $(previewId); img.hidden = true;
  compress(file).then(ph => { set(ph); img.src = URL.createObjectURL(ph.full); img.hidden = false; img.title = `壓縮後 ${kb(ph.full.size)}`; })
    .catch(e => { set(null); showErr(errId, e?.user ? e.message : '無法讀取這張圖片，請換一張。'); });
}
function loadImage(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
function encode(img, longSide, q) {
  const s = Math.min(1, longSide / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', q));
}
async function compress(file) {
  const img = await loadImage(file);
  try {
    let best = null;
    search: for (const size of PHOTO.sizes) for (const q of PHOTO.qualities) {
      const b = await encode(img, size, q);
      if (!best || b.size < best.size) best = b;
      if (b.size <= PHOTO.target) { best = b; break search; }
    }
    if (best.size > PHOTO.max) fail(`這張照片壓縮後仍有 ${kb(best.size)}，超過上限 ${kb(PHOTO.max)}，請換一張或裁切後再試。`);
    // 縮圖也以大小為準（iPhone Safari 的品質參數換算不同，固定品質會偏大）
    let thumb = null;
    for (const q of PHOTO.thumbQs) { const t = await encode(img, PHOTO.thumb, q); if (!thumb || t.size < thumb.size) thumb = t; if (t.size <= PHOTO.thumbTarget) { thumb = t; break; } }
    return {full: best, thumb};
  } finally { URL.revokeObjectURL(img.src); }
}
async function uploadPhoto(ph, id) {
  const base = `${CFG.imageDir}/${id}-${Date.now()}`, who = `\n\n操作者：${S.session.label}`;
  const full = await putFile(`${base}.jpg`, new Uint8Array(await ph.full.arrayBuffer()), null, `照片 ${id}（${kb(ph.full.size)}）${who}`);
  if (!full.ok) fail('照片上傳失敗，請再試一次。');
  const thumb = await putFile(`${base}-t.jpg`, new Uint8Array(await ph.thumb.arrayBuffer()), null, `縮圖 ${id}（${kb(ph.thumb.size)}）${who}`);
  S.localPhotos.set(`${base}.jpg`, URL.createObjectURL(ph.full));
  if (thumb.ok) S.localPhotos.set(`${base}-t.jpg`, URL.createObjectURL(ph.thumb));
  return {photo: `${base}.jpg`, thumb: thumb.ok ? `${base}-t.jpg` : ''};
}
/* ---------- 智慧辨識：每位編輯者用自己的 AI 金鑰，只存在這台裝置 ---------- */
const AI_NAMES = {claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI'};
const AI_FIELDS = ['wineName', 'wineryRegion', 'vintage', 'origin', 'volume', 'grapeNotes', 'color'];
const AI_PROMPT = `These photos show ONE wine bottle (front and/or back label). Read the labels and reply with JSON only, using exactly these keys:
wineName: the wine's name as printed, keeping the original language and accents (include a cuvée or classification such as "Grand Cru Classé" if it is part of the name);
wineryRegion: the producer / château, then "/" and the appellation or region if printed (for example "Mazzei/Chianti Classico Riserva DOCG");
vintage: the 4-digit year, "NV" for non-vintage, or "" if not visible;
origin: the country in English (for example France, Italy, Spain, Germany, United States, Australia, Chile);
volume: bottle size such as "750ml", "375ml" or "1500ml" if visible, else "";
grapeNotes: the grape variety or varieties if printed; if not printed but you are confident from the appellation, give them and include "grapeNotes" in uncertain;
color: "red" or "white" (rosé, sparkling and sweet white wines count as "white"), or "unknown";
uncertain: an array of the key names you inferred or could not read clearly.
Use "" for anything you cannot determine. Never invent a producer, name or year.`;
const AI_SCHEMA = {type: 'object', additionalProperties: false, required: [...AI_FIELDS, 'uncertain'],
  properties: {wineName: {type: 'string'}, wineryRegion: {type: 'string'}, vintage: {type: 'string'}, origin: {type: 'string'}, volume: {type: 'string'}, grapeNotes: {type: 'string'},
    color: {type: 'string', enum: ['red', 'white', 'unknown']}, uncertain: {type: 'array', items: {type: 'string', enum: AI_FIELDS}}}};
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/* 金鑰只在本機保留 30 分鐘（從儲存那一刻算），時間到自動清除，要用再重新輸入。登出不提早清除 */
const AI_TTL = 30 * 60 * 1000;
const aiStoreKey = () => S.session ? 'cellarAI:' + S.session.slotId : '';
const aiPrefKey = () => S.session ? 'cellarAIpref:' + S.session.slotId : '';  // 只記服務與模型，不含金鑰
function sweepAI() {  // 清掉這台裝置上所有已過期（或舊版沒有期限）的金鑰
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('cellarAI:')) { let c = null; try { c = JSON.parse(localStorage.getItem(k)); } catch {} if (!c?.expiresAt || c.expiresAt <= Date.now()) localStorage.removeItem(k); } } catch {}
}
function getAI() { sweepAI(); try { const k = aiStoreKey(); return k ? JSON.parse(localStorage.getItem(k) || 'null') : null; } catch { return null; } }
function setAI(cfg) { try { const k = aiStoreKey(); if (!k) return; if (cfg) localStorage.setItem(k, JSON.stringify(cfg)); else localStorage.removeItem(k); } catch {} scheduleAiExpiry(); }
function getAIPref() { try { return JSON.parse(localStorage.getItem(aiPrefKey()) || 'null'); } catch { return null; } }
function setAIPref(p) { try { if (aiPrefKey()) localStorage.setItem(aiPrefKey(), JSON.stringify(p)); } catch {} }
let aiTimer = 0;
function scheduleAiExpiry() {  // 時間一到就把按鈕藏起來、更新設定頁
  clearTimeout(aiTimer); const c = (() => { try { return JSON.parse(localStorage.getItem(aiStoreKey()) || 'null'); } catch { return null; } })();
  const onExpire = () => { sweepAI(); if (!$('tab-ai').hidden) renderAiSettings(); if ($('wineModal').open) renderAiRow(); };
  if (c?.expiresAt) aiTimer = setTimeout(onExpire, Math.max(0, c.expiresAt - Date.now()) + 500);
}
const hhmm = t => new Date(t).toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'});
let anthropicMod = null;
async function claudeClient(key) {
  // 官方 SDK（已打包放在 vendor/，不依賴外部 CDN）；只有用 Claude 的編輯者按下時才載入
  anthropicMod = anthropicMod || (await import('./vendor/anthropic-sdk-1.3.0.js')).default;
  return new anthropicMod({apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1});
}
function aiError(e) {
  const st = e?.status;
  if (anthropicMod && e instanceof anthropicMod.APIConnectionError) return '連不到 AI 服務，請檢查網路後再試。';
  if (st === 401 || st === 403) return '金鑰無效或沒有權限，請到「管理 → 智慧辨識」重新確認。';
  if (st === 429) return '已達使用上限或次數限制，請稍後再試，或檢查 AI 帳號的額度。';
  if (st === 404) return '找不到這個模型，請到「管理 → 智慧辨識」改選其他模型。';
  if (e?.user) return e.message;
  if (e instanceof TypeError) return '連不到 AI 服務，請檢查網路後再試。';
  return 'AI 服務發生錯誤' + (st ? `（${st}）` : '') + '，請稍後再試。';
}
async function aiFetch(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { const err = new Error('http'); err.status = r.status; try { err.detail = await r.text(); } catch {} throw err; }
  return r.json();
}
/* 驗證金鑰：向該服務讀取可用模型清單，讀得到就代表金鑰可用 */
async function aiListModels(provider, key) {
  if (provider === 'claude') {
    const client = await claudeClient(key), ids = [];
    for await (const m of client.models.list({limit: 100})) ids.push(m.id);
    const pick = CLAUDE_MODELS.filter(id => ids.includes(id));
    return pick.length ? pick : ids.filter(id => /^claude-/.test(id));
  }
  if (provider === 'gemini') {
    const j = await aiFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {headers: {'x-goog-api-key': key}});
    return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/embed|tts|audio|image-generation|live/i.test(m.name)).map(m => m.name).sort().reverse();
  }
  const j = await aiFetch('https://api.openai.com/v1/models', {headers: {Authorization: 'Bearer ' + key}});
  return (j.data || []).map(m => m.id).filter(id => /^(gpt-|o\d)/.test(id) && !/audio|realtime|tts|transcribe|search|image|instruct|embedding/i.test(id)).sort().reverse();
}
async function saveAiSettings() {
  const provider = $('ai_provider').value, key = $('ai_key').value.trim(), old = getAI();
  const useKey = key || (old && old.provider === provider ? old.key : '');
  if (!useKey) fail('請貼上 API 金鑰。');
  $('aiSave').textContent = '驗證中…';
  try {
    let models;
    try { models = await aiListModels(provider, useKey); } catch (e) { fail(aiError(e)); }
    if (!models.length) fail('這把金鑰讀不到可用的模型，請確認帳號已開通 API。');
    const pref = getAIPref(), model = old && old.provider === provider && models.includes(old.model) ? old.model : pref && pref.provider === provider && models.includes(pref.model) ? pref.model : models[0];
    setAI({provider, key: useKey, model, models, ok: true, checkedAt: now(), expiresAt: Date.now() + AI_TTL});
    setAIPref({provider, model});
    $('ai_key').value = ''; renderAiSettings(); toast(`${AI_NAMES[provider]} 金鑰驗證成功，30 分鐘內「新增紅酒」可使用智慧辨識。`);
  } finally { $('aiSave').textContent = '驗證並儲存'; }
}
function renderAiSettings() {
  const c = getAI();
  $('aiWho').textContent = S.session?.label || '';
  const left = c?.expiresAt ? Math.max(1, Math.ceil((c.expiresAt - Date.now()) / 60000)) : 0, pref = getAIPref();
  $('aiStatus').innerHTML = c?.ok ? `<b>✅ 已啟用</b>　${AI_NAMES[c.provider]} · ${esc(c.model.replace(/^models\//, ''))} · 金鑰 ••••${esc(c.key.slice(-4))}<br><span class="ai-left">還剩約 ${left} 分鐘，${hhmm(c.expiresAt)} 自動從這台裝置清除</span>` : `<b>尚未輸入金鑰</b>　「新增紅酒」不會顯示智慧辨識。${pref ? `<br><span class="ai-left">上次用的是 ${AI_NAMES[pref.provider]}，重新貼上金鑰即可</span>` : ''}`;
  $('aiStatus').classList.toggle('on', !!c?.ok);
  if (c) $('ai_provider').value = c.provider; else if (pref && !$('ai_key').value) $('ai_provider').value = pref.provider;
  $('ai_key').placeholder = c?.ok ? '已儲存；要更換才需重新貼上' : '貼上這家服務的 API 金鑰';
  $('ai_modelBox').hidden = !c?.ok;
  if (c?.ok) $('ai_model').innerHTML = (c.models || [c.model]).map(m => `<option value="${esc(m)}" ${m === c.model ? 'selected' : ''}>${esc(m.replace(/^models\//, ''))}</option>`).join('');
  $('aiRemove').hidden = !c;
}
function renderAiRow() {
  const c = getAI(), n = (S.pendKeep || []).length + (S.newPhotos || []).length, show = !!c?.ok && !S.editing && canEdit();
  $('aiRow').hidden = !show; if (!show) return;
  $('aiBtn').disabled = !n || !!S.aiBusy;
  if (!S.aiBusy && !$('aiMsg').dataset.keep) $('aiMsg').textContent = n ? `用 ${AI_NAMES[c.provider]} 讀這 ${n} 張照片，自動填入表單裡的空白欄位` : '先加入酒標照片，再按智慧辨識';
}
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
async function aiImages() {
  const blobs = [];
  for (const ph of S.pendKeep || []) { try { const r = await fetch(fileUrl(ph.photo)); if (r.ok) blobs.push(await r.blob()); } catch {} }
  for (const ph of S.newPhotos || []) blobs.push(ph.full);
  return Promise.all(blobs.slice(0, MAX_PHOTOS).map(async b => ({type: /^image\//.test(b.type) ? b.type : 'image/jpeg', b64: await blobToB64(b)})));
}
async function aiCall(c, imgs) {
  if (c.provider === 'claude') {
    const client = await claudeClient(c.key);
    const req = {model: c.model, max_tokens: 16000, output_config: {effort: 'low', format: {type: 'json_schema', schema: AI_SCHEMA}},
      messages: [{role: 'user', content: [...imgs.map(i => ({type: 'image', source: {type: 'base64', media_type: i.type, data: i.b64}})), {type: 'text', text: AI_PROMPT}]}]};
    // 遇到安全分類器婉拒時，由伺服器自動改用替代模型重試（Haiku 沒有這個機制）
    if (/opus|sonnet/.test(c.model)) Object.assign(req, {betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
    const res = await client.beta.messages.create(req);
    if (res.stop_reason === 'refusal') fail('AI 婉拒辨識這組照片，請換張照片再試。');
    if (res.stop_reason === 'max_tokens') fail('AI 回覆不完整，請再試一次。');
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (c.provider === 'gemini') {
    const j = await aiFetch(`https://generativelanguage.googleapis.com/v1beta/${c.model}:generateContent`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': c.key},
      body: JSON.stringify({contents: [{role: 'user', parts: [...imgs.map(i => ({inline_data: {mime_type: i.type, data: i.b64}})), {text: AI_PROMPT}]}], generationConfig: {responseMimeType: 'application/json'}})});
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }
  const j = await aiFetch('https://api.openai.com/v1/chat/completions', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key},
    body: JSON.stringify({model: c.model, response_format: {type: 'json_object'}, messages: [{role: 'user', content: [{type: 'text', text: AI_PROMPT}, ...imgs.map(i => ({type: 'image_url', image_url: {url: `data:${i.type};base64,${i.b64}`}}))]}]})});
  return j.choices?.[0]?.message?.content || '';
}
function aiParse(text) {
  const m = String(text).match(/\{[\s\S]*\}/); if (!m) fail('AI 沒有回傳可用的資料，請再試一次。');
  let o; try { o = JSON.parse(m[0]); } catch { fail('AI 回傳的格式不正確，請再試一次。'); }
  const str = v => typeof v === 'string' ? v.trim() : '';
  return {wineName: str(o.wineName), wineryRegion: str(o.wineryRegion), vintage: str(o.vintage), origin: str(o.origin), grapeNotes: str(o.grapeNotes),
    volume: str(o.volume).replace(/\s+/g, '').replace(/ML$/i, 'ml').replace(/^(\d+(?:\.\d+)?)l$/i, (x, n) => Math.round(Number(n) * 1000) + 'ml'),
    color: ['red', 'white'].includes(o.color) ? o.color : '', uncertain: Array.isArray(o.uncertain) ? o.uncertain.filter(k => AI_FIELDS.includes(k)) : []};
}
async function aiRecognize() {
  const c = getAI();
  if (!c?.ok) { renderAiRow(); showErr('wineErr', 'AI 金鑰已超過 30 分鐘、自動清除了。要再用請到「管理 → 智慧辨識」重新貼上。'); return; }
  if (S.aiBusy) return;
  S.aiBusy = true; delete $('aiMsg').dataset.keep; renderAiRow(); $('aiBtn').textContent = '✨ 辨識中…'; $('aiMsg').textContent = '照片傳送中，約需幾秒到十幾秒'; showErr('wineErr', '');
  try {
    const imgs = await aiImages(); if (!imgs.length) fail('讀不到照片，請重新加入後再試。');
    let text; try { text = await aiCall(c, imgs); } catch (e) { fail(aiError(e)); }
    const r = aiParse(text), filled = [];
    const put = (k, el) => { if (!r[k] || el.value.trim()) return; el.value = r[k]; el.classList.add('ai-filled'); el.classList.toggle('ai-guess', r.uncertain.includes(k)); filled.push(k); };
    for (const k of ['wineName', 'wineryRegion', 'vintage', 'origin', 'grapeNotes']) put(k, $('f_' + k));
    if (r.volume) { setChoice('f_volumeChoice', 'f_volumeOther', r.volume, '750ml'); const el = $('f_volumeOther').hidden ? $('f_volumeChoice') : $('f_volumeOther'); el.classList.add('ai-filled'); el.classList.toggle('ai-guess', r.uncertain.includes('volume')); filled.push('volume'); }
    if (r.color) { document.querySelectorAll('input[name=f_color]').forEach(x => x.checked = x.value === r.color); filled.push('color'); }
    const guess = filled.filter(k => r.uncertain.includes(k)).length;
    $('aiMsg').dataset.keep = '1';
    $('aiMsg').textContent = filled.length ? `已填入 ${filled.length} 項，請逐欄確認${guess ? `；虛線框的 ${guess} 欄是推測` : ''}。已有內容的欄位不會被覆蓋。` : '沒有讀到可填入的資料（或欄位都已有內容），請換張更清楚的酒標照片。';
    $('f_wineName').scrollIntoView({block: 'center', behavior: 'smooth'});
  } catch (e) { $('aiMsg').dataset.keep = '1'; $('aiMsg').textContent = ''; showErr('wineErr', e?.user ? e.message : aiError(e)); if (!e?.user) console.error(e); }
  finally { S.aiBusy = false; $('aiBtn').textContent = '✨ 智慧辨識'; renderAiRow(); }
}

/* ---------- 待入櫃：先拍照，資料之後補 ---------- */
function renderPendStrip() {
  const n = S.pendNew.length;
  $('q_strip').innerHTML = S.pendNew.map((ph, i) => `<span class="nthumb"><img src="${URL.createObjectURL(ph.thumb)}" alt="照片 ${i + 1}">${i === 0 ? '<em>封面</em>' : ''}<button type="button" data-qrm="${i}" aria-label="移除這張">×</button></span>`).join('');
  $('q_add').querySelectorAll('label').forEach(l => l.hidden = n >= MAX_PHOTOS);
  $('q_save').hidden = !n; $('q_save').textContent = S.pendSaving ? '上傳中…' : `存入待入櫃（${n} 張）`;
}
function renderPending() {
  const list = S.data?.pending || [], n = list.length;
  $('factPend').hidden = !S.session;
  $('sumPend').innerHTML = `${n} <small>瓶</small>` + (n ? `<span class="pend-mini">${list.filter(p => p.photos?.length).slice(-3).reverse().map(p => `<img src="${esc(fileUrl(p.photos[0].thumb || p.photos[0].photo))}" alt="">`).join('')}</span>` : '');
  if (!$('pendModal').open) return;
  const html = n ? list.slice().reverse().map(p => {
    const busy = S.pendAdding === p.id, room = MAX_PHOTOS - p.photos.length, one = p.photos.length < 2;
    return `<article class="pend" data-pid="${esc(p.id)}">
    <div class="pend-ph">${p.photos.map((ph, i) => `<span class="pth"><a href="${esc(fileUrl(ph.photo))}" target="_blank" rel="noopener"><img src="${esc(fileUrl(ph.thumb || ph.photo))}" alt="第 ${i + 1} 張" loading="lazy"></a>${i === 0 ? '<em>封面</em>' : ''}${one || busy ? '' : `<button type="button" data-pprm="${esc(ph.photo)}" aria-label="移除第 ${i + 1} 張">×</button>`}</span>`).join('')}</div>
    <div class="pend-add">${busy ? '<span class="hint">上傳中…</span>' : room > 0 ? `<label>📷 加拍<input type="file" accept="image/*" capture="environment" data-padd></label><label>從相簿加入<input type="file" accept="image/*" multiple data-padd></label>` : ''}<span class="hint">${p.photos.length}／${MAX_PHOTOS} 張</span></div>
    <p class="pend-meta">${esc(p.by || '')}・${fmtTime(p.at)}</p>
    <div class="pend-act"><button type="button" class="primary" data-pedit="${esc(p.id)}" ${busy ? 'disabled' : ''}>編輯並加入酒櫃</button><button type="button" class="danger" data-pdelq="${esc(p.id)}" ${busy ? 'disabled' : ''}>刪除</button></div>
  </article>`;
  }).join('') : '<p class="hint pend-empty">目前沒有待入櫃的酒。</p>';
  // 內容沒變就不重畫：避免定時同步把正在開啟的相機／相簿選擇器換掉
  if (html !== S.pendHtml || !$('pendList').firstChild) { S.pendHtml = html; $('pendList').innerHTML = html; }
}
/* 待入櫃的酒之後再補拍第 2、3、4 張 */
async function addPendPhotos(id, fileList) {
  const files = [...fileList], item = (S.data?.pending || []).find(x => x.id === id);
  if (!item || !files.length || S.pendAdding) return;
  const room = MAX_PHOTOS - item.photos.length, who = S.session.label;
  showErr('pendErr', files.length > room ? `每瓶最多 ${MAX_PHOTOS} 張，只加入前 ${room} 張。` : '');
  if (room <= 0) return;
  S.pendAdding = id; renderPending();
  const up = [];
  try {
    for (const f of files.slice(0, room)) {
      let ph; try { ph = await compress(f); } catch (err) { showErr('pendErr', err?.user ? err.message : '有一張圖片無法讀取，請換一張。'); continue; }
      up.push(await uploadPhoto(ph, 'pending'));
    }
    if (!up.length) return;
    const extra = await mutate(d => {
      const cur = (d.pending || []).find(x => x.id === id); if (!cur) fail('這瓶已被其他人加入酒櫃或刪除。');
      const fit = up.slice(0, MAX_PHOTOS - cur.photos.length); cur.photos.push(...fit);
      return up.slice(fit.length);
    }, `待入櫃：加入照片（${up.length} 張）`);
    if (extra.length) deleteFiles(extra.flatMap(p => [p.photo, p.thumb]), '待入櫃');
    toast(`已加入 ${up.length - extra.length} 張照片。`);
  } catch (e) { showErr('pendErr', msgOf(e)); if (up.length && !(S.data?.pending || []).some(x => x.photos.some(p => p.photo === up[0].photo))) deleteFiles(up.flatMap(p => [p.photo, p.thumb]), '待入櫃'); }
  finally { S.pendAdding = null; renderPending(); checkStorage(); }
}
async function removePendPhoto(id, path) {
  if (S.pendAdding) return;
  showErr('pendErr', '');
  try {
    const gone = await mutate(d => {
      const cur = (d.pending || []).find(x => x.id === id); if (!cur) fail('這瓶已不存在。');
      if (cur.photos.length < 2) fail('至少要留一張照片；整瓶不要請按「刪除」。');
      const i = cur.photos.findIndex(p => p.photo === path); if (i < 0) fail('這張照片已不存在。');
      return cur.photos.splice(i, 1)[0];
    }, '待入櫃：移除一張照片');
    deleteFiles([gone.photo, gone.thumb], '待入櫃').then(checkStorage);
    toast('已移除這張照片。');
  } catch (e) { showErr('pendErr', msgOf(e)); }
  renderPending();
}
async function savePending() {
  if (!S.pendNew.length || S.pendSaving) return;
  const who = S.session.label; S.pendSaving = true; $('q_save').disabled = true; renderPendStrip(); showErr('pendErr', '');
  try {
    const photos = [];
    for (const ph of S.pendNew) photos.push(await uploadPhoto(ph, 'pending'));
    await mutate(d => { d.pending = d.pending || []; d.pending.push({id: crypto.randomUUID(), photos, by: who, at: now()}); }, `待入櫃：新增一瓶（${photos.length} 張照片）`);
    S.pendNew = []; toast('已存入待入櫃，之後再補資料。');
  } catch (e) { showErr('pendErr', msgOf(e)); }
  finally { S.pendSaving = false; $('q_save').disabled = false; renderPendStrip(); renderPending(); checkStorage(); }
}
function editPending(id) {
  const p = (S.data?.pending || []).find(x => x.id === id); if (!p) return;
  $('pendModal').close(); openWineForm(null, p);
}
async function deletePending(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定刪除？'; setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; } }, 4000); return; }
  const id = btn.dataset.pdelq; btn.disabled = true; showErr('pendErr', '');
  try {
    const gone = await mutate(d => { const i = (d.pending || []).findIndex(x => x.id === id); if (i < 0) fail('這筆已不存在。'); return d.pending.splice(i, 1)[0]; }, g => `刪除待入櫃（${g.photos.length} 張照片）`);
    toast('已刪除。');
    deleteFiles(gone.photos.flatMap(p => [p.photo, p.thumb]), '待入櫃').then(checkStorage);
  } catch (e) { showErr('pendErr', msgOf(e)); }
  renderPending();
}
/* 換照片後刪掉舊檔（git 歷史仍保留，但資料夾保持整齊）。失敗不影響使用。 */
function usedPaths() {  // 目前資料仍在用的照片檔（再買一次會讓兩款酒共用照片）
  const u = new Set(), add = (...ps) => ps.forEach(p => p && u.add(p));
  for (const w of Object.values(S.data?.wines || {})) { add(w.photo, w.thumb); for (const p of w.photos || []) add(p.photo, p.thumb); }
  for (const p of S.data?.pending || []) for (const x of p.photos || []) add(x.photo, x.thumb);
  for (const j of S.data?.journal || []) add(j.photo, j.thumb);
  return u;
}
async function deleteFiles(paths, id) {
  const used = usedPaths();
  for (const path of paths.filter(p => p && !used.has(p))) {
    try {
      const r = await gh(`${REPO}/contents/${path}?ref=${encodeURIComponent(CFG.dataBranch)}`);
      if (!r.ok) continue;
      const {sha} = await r.json();
      await gh(`${REPO}/contents/${path}`, {method: 'DELETE', body: {message: `刪除舊照片 ${id}\n\n操作者：${S.session.label}`, sha, branch: CFG.dataBranch}});
    } catch {}
  }
}
function openPhoto(w) { if (!w) return; S.photo = w.wineId; showErr('photoErr', ''); renderPhotoMgr(); showDialog('photoModal'); }
function renderPhotoMgr() {
  const w = byId(S.photo); if (!w) return;
  const ps = photosOf(w);
  $('photoWine').textContent = [w.wineName, w.vintage].filter(Boolean).join('　');
  const dis = S.pMoving ? 'disabled' : '';
  $('pDragHint').hidden = ps.length < 2;
  $('pgrid').innerHTML = ps.map((p, i) => `<div class="ptile" data-path="${esc(p.photo)}"><span class="pimg"><img src="${esc(fileUrl(p.thumb || p.photo))}" alt="第 ${i + 1} 張" draggable="false"><span class="pno">${i === 0 ? '1 封面' : i + 1}</span></span><div class="pbtns">
    ${i === 0 ? '<span class="cover">封面</span>' : `<button type="button" class="small" data-pcover="${esc(p.photo)}" ${dis}>設為封面</button>`}
    <button type="button" class="small danger" data-pdel="${esc(p.photo)}" ${dis}>刪除</button></div></div>`).join('') || '<p class="hint">還沒有照片。</p>';
  const full = ps.length >= MAX_PHOTOS;
  $('pAdd').hidden = full || !!S.pBusy;
  $('pCount').textContent = S.pBusy ? `上傳中…（${S.pBusy}）` : `${ps.length}／${MAX_PHOTOS} 張${full ? '，已達上限；要換照片請先刪除一張。' : ''}`;
}
async function addPhotos(fileList) {
  const id = S.photo, w = byId(id); if (!w || S.pBusy) return;
  const picked = [...fileList], room = MAX_PHOTOS - photosOf(w).length, files = picked.slice(0, room), who = S.session.label;
  $('p_camera').value = ''; $('p_gallery').value = '';
  if (!files.length) return;
  showErr('photoErr', picked.length > room ? `最多 ${MAX_PHOTOS} 張，只加入前 ${room} 張。` : '');
  let done = 0;
  try {
    for (const f of files) {
      S.pBusy = `${done + 1}/${files.length}`; renderPhotoMgr();
      const up = await uploadPhoto(await compress(f), id);
      await mutate(d => {
        const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
        const list = photosOf(cur).slice(); if (list.length >= MAX_PHOTOS) fail(`最多 ${MAX_PHOTOS} 張照片。`);
        list.push({photo: up.photo, thumb: up.thumb}); setPhotos(cur, list);
        cur.updatedAt = now(); cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
        return list.length;
      }, n => `新增照片 ${id} ${w.wineName}（${n}/${MAX_PHOTOS}）`);
      done++;
    }
    toast(`已加入 ${done} 張照片。`);
  } catch (e) { showErr('photoErr', msgOf(e)); }
  finally { S.pBusy = null; renderPhotoMgr(); checkStorage(); }
}
/* 長按（手機）或按住（滑鼠）照片拖動排序 */
function setupPhotoDrag() {
  const grid = $('pgrid'), dlg = $('photoModal'), tiles = () => [...grid.querySelectorAll('.ptile')];
  let st = null, raf = 0;
  const renumber = () => tiles().forEach((t, i) => { const n = t.querySelector('.pno'); if (n) n.textContent = i === 0 ? '1 封面' : i + 1; });
  const cancel = () => { if (st) clearTimeout(st.timer); st = null; };
  function begin(x, y) {
    if (!st || st.active) return;
    st.active = true;
    const r = st.tile.getBoundingClientRect();
    st.dx = x - r.left; st.dy = y - r.top;
    const g = st.tile.cloneNode(true); g.classList.add('pghost'); g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
    dlg.append(g); st.ghost = g; st.tile.classList.add('pdragging'); grid.classList.add('sorting');
    place(x, y); navigator.vibrate?.(15);
  }
  function place(x, y) { st.x = x; st.y = y; st.ghost.style.transform = `translate(${x - st.dx}px, ${y - st.dy}px)`; }
  function autoScroll() {
    if (!st?.active) return;
    const r = dlg.getBoundingClientRect(), edge = 70;
    if (st.y < r.top + edge) dlg.scrollTop -= 12; else if (st.y > r.bottom - edge) dlg.scrollTop += 12;
    over(st.x, st.y); raf = requestAnimationFrame(autoScroll);
  }
  function over(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('#pgrid .ptile');
    if (!el || el === st.tile) return;
    const ts = tiles(), from = ts.indexOf(st.tile), to = ts.indexOf(el);
    grid.insertBefore(st.tile, from < to ? el.nextSibling : el); renumber();
  }
  grid.addEventListener('contextmenu', e => { if (e.target.closest('.pimg')) e.preventDefault(); });
  grid.addEventListener('pointerdown', e => {
    const img = e.target.closest('.pimg');
    if (!img || e.button > 0 || S.pMoving || S.pBusy || !canEdit() || tiles().length < 2) return;
    st = {tile: img.closest('.ptile'), x0: e.clientX, y0: e.clientY, active: false, mouse: e.pointerType === 'mouse', start: tiles().map(t => t.dataset.path)};
    if (st.mouse) e.preventDefault();
    else st.timer = setTimeout(() => { begin(st.x0, st.y0); raf = requestAnimationFrame(autoScroll); }, 450);
  });
  grid.addEventListener('touchmove', e => { if (st?.active) e.preventDefault(); }, {passive: false});
  window.addEventListener('pointermove', e => {
    if (!st) return;
    const dist = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
    if (!st.active) {
      if (st.mouse && dist > 6) { begin(e.clientX, e.clientY); raf = requestAnimationFrame(autoScroll); }
      else if (!st.mouse && dist > 10) cancel();   // 手指一開始就移動：當成捲動
      return;
    }
    e.preventDefault(); place(e.clientX, e.clientY); over(e.clientX, e.clientY);
  }, {passive: false});
  const end = () => {
    if (!st) return;
    clearTimeout(st.timer); cancelAnimationFrame(raf);
    if (st.active) {
      st.ghost.remove(); st.tile.classList.remove('pdragging'); grid.classList.remove('sorting');
      const order = tiles().map(t => t.dataset.path);
      if (order.join('|') !== st.start.join('|')) saveOrder(order);
    }
    st = null;
  };
  window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
}
async function saveOrder(order) {
  const id = S.photo, w = byId(id);
  S.pMoving = true; renderPhotoMgrButtonsOnly();
  try {
    await mutate(d => {
      const cur = d.wines[id]; const list = photosOf(cur);
      const sorted = order.map(p => list.find(x => x.photo === p)).filter(Boolean).concat(list.filter(x => !order.includes(x.photo)));
      setPhotos(cur, sorted);
    }, `調整照片順序 ${id} ${w.wineName}`, {quiet: true});
    toast('已更新照片順序。');
  } catch (e) { showErr('photoErr', msgOf(e)); }
  finally { S.pMoving = false; renderPhotoMgr(); }
}
function renderPhotoMgrButtonsOnly() { document.querySelectorAll('#pgrid button').forEach(b => b.disabled = true); }
async function coverPhoto(path) {
  const id = S.photo, w = byId(id);
  try {
    await mutate(d => {
      const cur = d.wines[id]; const list = photosOf(cur).slice(); const i = list.findIndex(p => p.photo === path); if (i < 0) fail('找不到這張照片，請重新整理。');
      list.unshift(...list.splice(i, 1)); setPhotos(cur, list);
    }, `更換封面照片 ${id} ${w.wineName}`, {quiet: true});
    toast('已設為封面。');
  } catch (e) { showErr('photoErr', msgOf(e)); }
  renderPhotoMgr();
}
async function deletePhoto(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定刪除？'; setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; } }, 4000); return; }
  const id = S.photo, w = byId(id), path = btn.dataset.pdel, who = S.session.label;
  try {
    const gone = await mutate(d => {
      const cur = d.wines[id]; const list = photosOf(cur).slice(); const i = list.findIndex(p => p.photo === path); if (i < 0) fail('這張照片已不存在。');
      const [rm] = list.splice(i, 1); setPhotos(cur, list); cur.updatedAt = now(); cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1;
      return rm;
    }, `刪除照片 ${id} ${w.wineName}`);
    toast('已刪除照片。');
    deleteFiles([gone.photo, gone.thumb], id).then(checkStorage);
  } catch (e) { showErr('photoErr', msgOf(e)); }
  renderPhotoMgr();
}

/* ---------- 儲存空間 ---------- */
const STORAGE_LIMIT_MB = 500;
async function checkStorage() {
  try {
    const r = await gh(REPO); if (!r.ok) return null;
    const mb = (await r.json()).size / 1024, pct = mb / STORAGE_LIMIT_MB;
    S.storage = {mb, pct};
    const el = $('storageBar');
    if (el) {
      el.hidden = false; el.classList.toggle('warn', pct >= .8);
      el.querySelector('.fill').style.width = Math.min(100, pct * 100).toFixed(1) + '%';
      el.querySelector('.txt').textContent = `儲存空間 ${mb < 10 ? mb.toFixed(1) : Math.round(mb)}／${STORAGE_LIMIT_MB} MB${pct >= .8 ? '　快滿了，請少換照片' : ''}`;
      const sub = $('storageSub'); if (sub) sub.textContent = `已用 ${mb < 10 ? mb.toFixed(1) : Math.round(mb)}／${STORAGE_LIMIT_MB} MB${pct >= .8 ? '・快滿了' : ''}`;
    }
    return S.storage;
  } catch { return null; }
}

/* ---------- CSV ---------- */
function exportCsv() {
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['資料類型', ...FIELDS.map(f => f[1]), '紅酒／白酒', '櫃位', '層位', '瓶數', '飲用優先', '最後修改者', '最後修改時間'].join(',')];
  for (const w of wines()) {
    const type = w.status === 'archived' ? '歷史酒單' : '目前酒款';
    const locs = w.locations?.length ? w.locations : [{cabinet: '', shelf: '', quantity: 0}];
    for (const l of locs) lines.push([type, ...FIELDS.map(f => w[f[0]]), colorName(w), l.cabinet, l.shelf, l.quantity, prioOf(w), nameOf(w.updatedBy), w.updatedAt].map(cell).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  a.download = `wine-cellar-${today()}.csv`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 管理 ---------- */
function renderCapForm() {
  const cabs = locOptions('cabinets').map(cab => {
    const shs = new Set(shelvesOf(cab)); for (const sh of Object.keys(S.data?.capacity?.[cab] || {})) shs.add(sh);
    return [cab, [...shs].sort(byShelf)];
  }).filter(([, shs]) => shs.length);
  $('capList').innerHTML = cabs.map(([cab, shs]) => {
    const tot = shs.reduce((a, sh) => a + (freeAt(cab, sh, qtyAt(cab, sh)) ?? 0), 0), any = shs.some(sh => capOf(cab, sh) !== null);
    return `<div class="capcab"><div class="capcab-h">${esc(cab)}<span>${any ? `共可再放 ${tot} 瓶` : '尚未填寫'}</span></div>${shs.map(sh => {
      const n = qtyAt(cab, sh), f = freeAt(cab, sh, n);
      return `<div class="caprow"><span class="cl"><b>${esc(sh)}</b><small>現有 ${n} 瓶</small></span><label class="cf">還可放 <input type="number" min="0" max="999" step="1" inputmode="numeric" data-capcab="${esc(cab)}" data-capsh="${esc(sh)}" value="${f ?? ''}" placeholder="—"> 瓶</label></div>`;
    }).join('')}</div>`;
  }).join('') || '<p class="hint">還沒有存放位置。</p>';
}
async function saveCapacity() {
  const rows = [...document.querySelectorAll('#capList [data-capcab]')].map(i => ({cab: i.dataset.capcab, sh: i.dataset.capsh, v: i.value.trim()}));
  for (const r of rows) if (r.v !== '' && (!/^\d+$/.test(r.v) || Number(r.v) > 999)) fail(`${r.cab} ${r.sh}：還可放的瓶數要是 0 以上的整數。`);
  const changes = await mutate(d => {
    d.capacity = d.capacity || {}; const out = [];
    const cnt = (cab, sh) => { let n = 0; for (const w of Object.values(d.wines)) if (w.status !== 'archived') for (const l of w.locations || []) if (l.cabinet === cab && l.shelf === sh) n += l.quantity || 0; return n; };
    for (const r of rows) {
      const old = d.capacity[r.cab]?.[r.sh];
      if (r.v === '') { if (old !== undefined) { delete d.capacity[r.cab][r.sh]; out.push(`${r.cab} ${r.sh}：不顯示空位`); } continue; }
      const cap = cnt(r.cab, r.sh) + Number(r.v);
      if (old !== cap) { (d.capacity[r.cab] = d.capacity[r.cab] || {})[r.sh] = cap; out.push(`${r.cab} ${r.sh}：還可放 ${r.v} 瓶（容量 ${cap}）`); }
    }
    for (const c of Object.keys(d.capacity)) if (!Object.keys(d.capacity[c]).length) delete d.capacity[c];
    return out;
  }, out => `設定各層空位${out.length ? '' : '（無變更）'}${out.length ? '\n\n' + out.join('\n') : ''}`);
  renderCapForm(); toast(changes.length ? `已更新 ${changes.length} 層的空位。` : '沒有變更。');
}
function renderAdmin() {
  renderCapForm();
  const cat = S.data?.catalog || {cabinets: [], shelves: []};
  const chip = n => `<span class="chip">${esc(n)}<button data-rm="${esc(n)}" aria-label="移除 ${esc(n)}">×</button></span>`;
  $('cabChips').innerHTML = cat.cabinets.map(chip).join('') || '<span class="hint">尚未建立。</span>';
  $('shelfChips').innerHTML = cat.shelves.map(chip).join('') || '<span class="hint">尚未建立。</span>';
  renderHistory();
}
const OUT_TYPES = ['自飲', '聚餐', '送禮', '其他'];

/* ---------- 飲酒日誌「回憶」（依場合找飲用紀錄）與 管理「搜尋」（所有登錄過的酒、飲用紀錄、再買一次） ---------- */
const OCC_CLASS = {'自飲': 'self', '聚餐': 'dine', '送禮': 'gift', '其他': 'other'};
const occBadge = e => e.kind === 'ext' ? '<span class="occ ext">非酒窖</span>' : `<span class="occ ${OCC_CLASS[e.type] || 'other'}">${esc(e.type)}</span>`;
const roStars = n => n ? `<span class="rostar" aria-label="評分 ${n}／5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '';
const normKey = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const mdDate = d => d ? d.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2') : '';
function drinkEvents() {  // 所有飲用（含送禮）與非酒窖紀錄
  const out = [];
  for (const w of wines()) for (const o of w.outs || []) {
    const type = OUT_TYPES.includes(o.type) ? o.type : '其他';
    out.push({kind: 'cellar', mem: 'w:' + w.wineId, wineId: w.wineId, date: o.date || '', at: o.at || '', name: w.wineName, vintage: w.vintage || '', winery: w.wineryRegion || '',
      qty: Number(o.qty) || 1, type, note: o.reason || '', where: [o.cabinet, o.shelf].filter(Boolean).join(' · '), rating: Number(o.rating) || 0, photo: thumbUrl(w)});
  }
  for (const j of S.data?.journal || []) out.push({kind: 'ext', mem: 'x:' + normKey(j.name) + '|' + normKey(j.vintage), date: j.date || '', at: j.at || '', name: j.name, vintage: j.vintage || '', winery: '',
    qty: Number(j.qty) || 1, type: '', note: j.note || '', who: j.who || '', where: '', rating: Number(j.rating) || 0, photo: j.thumb ? fileUrl(j.thumb) : j.photo ? fileUrl(j.photo) : '', j});
  return out.sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
}
function switchJTab(t) {
  S.jt = t;
  document.querySelectorAll('#jTabs [data-jt]').forEach(b => { b.classList.toggle('on', b.dataset.jt === t); b.setAttribute('aria-selected', b.dataset.jt === t); });
  $('jtCal').hidden = t !== 'cal'; $('jtSearch').hidden = t !== 'search';
  renderJTab();
}
function renderJTab() { if (S.jt === 'search') renderJSearch(); }
const setChips = (id, pick) => document.querySelectorAll(`#${id} button`).forEach(b => { const on = pick(b); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
function renderJSearch() {
  const f = S.js, q = normKey(f.q), t = today();
  setChips('js_type', b => b.dataset.v === f.type); setChips('js_when', b => b.hasAttribute('data-hi') ? f.hi : b.dataset.v === f.when);
  const d3 = new Date(); d3.setMonth(d3.getMonth() - 3);
  const since = f.when === 'year' ? t.slice(0, 4) + '-01-01' : f.when === '3m' ? `${d3.getFullYear()}-${String(d3.getMonth() + 1).padStart(2, '0')}-${String(d3.getDate()).padStart(2, '0')}` : '';
  const list = drinkEvents().filter(e => (!since || e.date >= since) && (!f.type || (f.type === 'ext' ? e.kind === 'ext' : e.type === f.type)) && (!f.hi || e.rating >= 4)
    && (!q || normKey([e.name, e.vintage, e.winery, e.type, e.note, e.who, e.where, e.kind === 'ext' ? '非酒窖' : '酒窖'].join(' ')).includes(q)));
  $('js_sum').innerHTML = list.length ? `找到 <b>${list.length}</b> 筆・共 <b>${sumQty(list)}</b> 瓶${f.type === '送禮' ? '（送出）' : ''}` : '';
  let html = '', month = '';
  for (const e of list) {
    const m = (e.date || '').slice(0, 7); if (m !== month) { month = m; const [yy, mm] = m.split('-'); html += `<div class="rdate">${yy ? `${yy} 年 ${Number(mm)} 月` : '日期不明'}</div>`; }
    const ph = e.photo ? `<img class="ph" src="${esc(e.photo)}" alt="" loading="lazy">` : `<span class="ph">${esc(e.vintage || 'NV')}</span>`;
    html += `<div class="entry srch" data-mem="${esc(e.mem)}" role="button" tabindex="0">${ph}<div class="eb"><div class="t">${esc(e.name)}${e.vintage ? ` <span class="v">${esc(e.vintage)}</span>` : ''}</div>`
      + `<div class="m">${occBadge(e)}${fmtDate(e.date)}・${e.qty} 瓶${e.where ? '・' + esc(e.where) : ''}${e.who ? '・' + esc(e.who) : ''}</div>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}${roStars(e.rating)}</div></div>`;
  }
  $('js_list').innerHTML = html || `<p class="hint">${drinkEvents().length ? '沒有符合的紀錄，換個關鍵字或條件試試。' : '還沒有任何飲用紀錄。出庫或在日曆「＋紀錄」後，就會出現在這裡。'}</p>`;
}
function memItems() {
  const by = {}; for (const e of drinkEvents()) (by[e.mem] = by[e.mem] || []).push(e);
  const stat = (it, es = []) => {
    const drinks = es.filter(e => e.type !== '送禮'), rated = es.filter(e => e.rating), byType = {};
    for (const e of es) { const k = e.kind === 'ext' ? '非酒窖' : e.type; byType[k] = (byType[k] || 0) + 1; }
    return Object.assign(it, {events: es, count: drinks.length, qty: sumQty(drinks), gifts: es.length - drinks.length, byType, avg: rated.length ? rated.reduce((a, e) => a + e.rating, 0) / rated.length : 0, last: es[0] || null});
  };
  const items = wines().map(w => stat({key: 'w:' + w.wineId, kind: 'cellar', w, name: w.wineName, vintage: w.vintage || '', winery: w.wineryRegion || '', origin: w.origin || '', photo: thumbUrl(w), stock: w.status === 'archived' ? 0 : total(w)}, by['w:' + w.wineId]));
  for (const [k, es] of Object.entries(by)) if (k.startsWith('x:')) {
    const withPh = es.find(e => e.j?.photo);
    items.push(stat({key: k, kind: 'ext', name: es[0].name, vintage: es[0].vintage, winery: '', origin: '', photo: es.find(e => e.photo)?.photo || '', photoRec: withPh ? {photo: withPh.j.photo, thumb: withPh.j.thumb || ''} : null, stock: null, j: es[0].j}, es));
  }
  return items;
}
function memLine(it) {
  const parts = [];
  if (it.winery) parts.push(esc(it.winery));
  if (it.count) { const kinds = Object.entries(it.byType).filter(([k]) => k !== '送禮').map(([k, n]) => `${k} ${n}`); parts.push(`喝過 ${it.count} 次${kinds.length > 1 ? `（${kinds.join('、')}）` : ''}`); }
  if (it.gifts) parts.push(`送禮 ${it.gifts} 次`);
  if (it.avg) parts.push(`★${it.avg.toFixed(1)}`);
  if (!it.events.length) parts.push('還沒有飲用紀錄');
  return parts.join('・');
}
const stockBadge = it => it.kind === 'ext' ? '<span class="stock none">不在酒窖</span>' : it.stock > 0 ? `<span class="stock">庫存 ${it.stock} 瓶</span>` : '<span class="stock none">已喝完</span>';
function renderMem() {
  const f = S.jm, q = normKey(f.q);
  setChips('jm_sort', b => b.dataset.v === f.sort); setChips('jm_group', b => b.dataset.v === f.group);
  const ld = it => it.last ? it.last.date + it.last.at : '';
  let list = memItems().filter(it => (f.group === 'all' || (f.group === 'have' ? it.kind === 'cellar' && it.stock > 0 : !(it.kind === 'cellar' && it.stock > 0)))
    && (!q || normKey([it.name, it.vintage, it.winery, it.origin].join(' ')).includes(q)));
  const byName = (a, b) => a.name.localeCompare(b.name, 'en') || String(a.vintage).localeCompare(String(b.vintage));
  list.sort(f.sort === 'name' ? byName : f.sort === 'recent' ? (a, b) => ld(b).localeCompare(ld(a)) || byName(a, b)
    : f.sort === 'rating' ? (a, b) => b.avg - a.avg || b.count - a.count || byName(a, b) : (a, b) => b.count - a.count || b.events.length - a.events.length || ld(b).localeCompare(ld(a)) || byName(a, b));
  $('jm_sum').innerHTML = `所有登錄過的酒（酒窖的、喝完的、別人帶來的）都在這裡，${q || f.group !== 'all' ? '符合' : '共'} <b>${list.length}</b> 款`;
  $('jm_list').innerHTML = list.map(it => {
    const ph = it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : `<span class="ph">${esc(it.vintage || 'NV')}</span>`;
    const last = it.last ? `最近 ${mdDate(it.last.date)} ${esc(it.last.kind === 'ext' ? '非酒窖' : it.last.type)}${it.last.note ? ' ' + esc(it.last.note) : ''}` : '';
    return `<div class="lib" data-mem="${esc(it.key)}" role="button" tabindex="0">${ph}<div><div class="t">${esc(it.name)}${it.vintage ? ` <span class="v">${esc(it.vintage)}</span>` : ''}</div><div class="s">${memLine(it)}${last ? '<br>' + last : ''}　${stockBadge(it)}</div></div></div>`;
  }).join('') || '<p class="hint">沒有符合的酒款。</p>';
}
function openMem(key) { S.memKey = key; renderMemDetail(); if (!$('memModal').open) showDialog('memModal'); }
function renderMemDetail() {
  const it = memItems().find(i => i.key === S.memKey); if (!it) { $('memModal').close(); return; }
  $('memTitle').textContent = [it.name, it.vintage].filter(Boolean).join(' ');
  const w = it.w, gal = it.kind === 'cellar' ? galleryHtml(w) : it.photoRec ? `<div class="gal"><div class="slides"><img src="${esc(fileUrl(it.photoRec.photo))}" alt="${esc(it.name)}"></div></div>` : '';
  const fact = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  const facts = it.kind === 'cellar'
    ? fact('酒莊／產區', esc(w.wineryRegion)) + fact('產地', esc(w.origin)) + fact('容量', esc([w.volume, colorName(w)].filter(Boolean).join('・'))) + fact('參考價格', w.referencePrice != null && w.referencePrice !== '' ? fmtPrice(w.referencePrice) : '') + fact('來源', esc(w.source))
      + fact('目前庫存', it.stock > 0 ? `<b>${it.stock} 瓶</b>（${(w.locations || []).filter(l => l.quantity > 0).map(l => `${esc(l.shelf)} ${l.quantity}`).join('、')}）` : '已喝完')
    : fact('來源', '非酒窖') + fact('最近一次', esc([fmtDate(it.last?.date), it.last?.who].filter(Boolean).join('・')));
  const tl = it.events.map(e => `<div><b>${fmtDate(e.date)}</b>　${occBadge(e)}${e.note ? esc(e.note) + '・' : ''}${e.qty} 瓶 ${roStars(e.rating)}</div>`).join('');
  $('memBody').innerHTML = `${gal}<dl class="mfacts">${facts}</dl>
    <div class="mstats"><div><b>${it.count}</b><span>喝過次數</span></div><div><b>${it.qty}</b><span>共喝幾瓶</span></div><div><b>${it.avg ? '★' + it.avg.toFixed(1) : '—'}</b><span>平均評分</span></div></div>
    <h4 class="mh">飲用紀錄${it.gifts ? `<span class="hint">（含送禮 ${it.gifts} 次）</span>` : ''}</h4>${tl ? `<div class="tl">${tl}</div>` : '<p class="hint">還沒有飲用紀錄。</p>'}
    ${canEdit() || (it.kind === 'cellar' && it.stock > 0) ? `<div class="buy">${canEdit() ? `<button type="button" class="primary" data-rebuy="${esc(it.key)}">🛒 再買一次</button>` : ''}${it.kind === 'cellar' && it.stock > 0 ? `<button type="button" data-memopen="${esc(w.wineId)}">看庫存</button>` : ''}</div>` : ''}
    ${canEdit() ? '<p class="hint">「再買一次」會打開新增紅酒，帶入這款酒的資料與照片，只需確認年份、位置與瓶數；同一年份會直接加到原本那款。</p>' : ''}`;
}
/* 再買一次：帶入資料與照片（沿用原本的照片檔，不重複上傳） */
function rebuy(key) {
  const it = memItems().find(i => i.key === key); if (!it || !canEdit()) return;
  $('memModal').close(); openWineForm(null, null, it);
}
function rebuyTarget() {  // 同酒名、同酒莊、同年份的既有酒款（含已喝完）
  const n = normKey($('f_wineName').value), r = normKey($('f_wineryRegion').value), v = normKey($('f_vintage').value);
  if (!n) return null;
  const same = wines().filter(w => normKey(w.wineName) === n && normKey(w.wineryRegion) === r && normKey(w.vintage) === v);
  return same.find(w => w.status !== 'archived') || same[0] || null;
}
function renderRebuyNote() {
  const el = $('rebuyNote'); if (!S.rebuy) { el.hidden = true; return; }
  const t = rebuyTarget(); el.hidden = false;
  const from = [S.rebuy.name, S.rebuy.vintage].filter(Boolean).join(' ');
  el.innerHTML = `✅ 已套用「${esc(from)}」的資料${S.pendKeep.length ? `與 ${S.pendKeep.length} 張照片` : ''}。請確認<b>年份</b>、<b>存放位置</b>和<b>瓶數</b>。<br>`
    + (t ? `<span class="rb-merge">這個年份已有「${esc([t.wineName, t.vintage].filter(Boolean).join(' '))}」（${t.status === 'archived' ? '已喝完' : `庫存 ${total(t)} 瓶`}），儲存時會把瓶數加到原本那款。</span>` : '<span class="rb-new">年份不同，儲存時會新增一款酒（沿用資料與照片）。</span>');
}

/* ---------- 飲酒日誌：日曆＋當天紀錄（酒窖出庫自飲／聚餐／其他＋外來的酒） ---------- */
const WEEK = '日一二三四五六';
function journalEntries() {
  const out = [];
  for (const w of wines()) for (const o of w.outs || []) {
    const type = OUT_TYPES.includes(o.type) ? o.type : '其他';
    if (type === '送禮') continue;
    out.push({kind: 'cellar', key: `o|${w.wineId}|${o.at || ''}`, wineId: w.wineId, at: o.at || '', date: o.date, name: w.wineName, vintage: w.vintage,
      qty: Number(o.qty) || 1, type, note: o.reason || '', where: [o.cabinet, o.shelf].filter(Boolean).join(' · '), rating: Number(o.rating) || 0, photo: thumbUrl(w)});
  }
  for (const j of S.data?.journal || []) out.push({kind: 'ext', key: `j|${j.id}`, id: j.id, at: j.at || '', date: j.date, name: j.name, vintage: j.vintage,
    qty: Number(j.qty) || 1, source: j.source, who: j.who || '', note: j.note || '', rating: Number(j.rating) || 0, photo: j.thumb ? fileUrl(j.thumb) : j.photo ? fileUrl(j.photo) : ''});
  return out;
}
const sumQty = list => list.reduce((a, e) => a + e.qty, 0);
function starsHtml(e) {
  const ed = canEdit();
  return `<span class="stars" ${ed ? 'role="group"' : 'role="img"'} aria-label="評分 ${e.rating}／5">${[1, 2, 3, 4, 5].map(i => ed
    ? `<button type="button" class="${i <= e.rating ? 'on' : ''}" data-rate="${i}" data-key="${esc(e.key)}" aria-label="${i} 顆星">★</button>`
    : `<i class="${i <= e.rating ? 'on' : ''}">★</i>`).join('')}</span>`;
}
function entryHtml(e) {
  const ph = e.photo ? `<img class="ph" src="${esc(e.photo)}" alt="" loading="lazy">` : `<span class="ph">${esc(e.vintage || 'NV')}</span>`;
  const meta = e.kind === 'cellar'
    ? `<span class="badge c">酒窖</span>${esc(e.type)} · ${e.qty} 瓶${e.where ? ' · ' + esc(e.where) : ''}`
    : `<span class="badge e">非酒窖${e.source && e.source !== '非酒窖' ? ' · ' + esc(e.source) : ''}</span>${e.qty} 瓶${e.who ? ' · ' + esc(e.who) : ''}`;
  const tools = e.kind === 'ext' && canEdit() ? `<span class="etools"><button type="button" class="small" data-jedit="${esc(e.id)}">編輯</button><button type="button" class="small danger" data-jdel="${esc(e.id)}">刪除</button></span>` : '';
  const open = e.kind === 'cellar' ? `data-hist="${esc(e.wineId)}" role="button" tabindex="0"` : '';
  return `<div class="entry ${e.kind}" ${open}>${ph}<div class="eb"><div class="t">${esc(e.name)}${e.vintage ? ` <span class="v">${esc(e.vintage)}</span>` : ''}</div><div class="m">${meta}</div>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}<div class="erow">${starsHtml(e)}${tools}</div></div></div>`;
}
function renderJournal() {
  if (!$('jCal')) return;
  const t = today(), all = journalEntries();
  if (!S.jMonth) S.jMonth = t.slice(0, 7);
  if (!S.jDay || !S.jDay.startsWith(S.jMonth)) S.jDay = S.jMonth === t.slice(0, 7) ? t : S.jMonth + '-01';
  const [y, m] = S.jMonth.split('-').map(Number);
  $('jTitle').textContent = `${y} 年 ${m} 月`;
  const inMonth = all.filter(e => (e.date || '').startsWith(S.jMonth));
  $('jSum').innerHTML = `<span>本月 <b>${sumQty(inMonth)}</b> 瓶</span><span><i class="d-c"></i>酒窖 <b>${sumQty(inMonth.filter(e => e.kind === 'cellar'))}</b></span><span><i class="d-e"></i>非酒窖 <b>${sumQty(inMonth.filter(e => e.kind === 'ext'))}</b></span>`;
  const byDay = {};
  for (const e of inMonth) (byDay[e.date] = byDay[e.date] || []).push(e);
  let html = [...WEEK].map((d, i) => `<div class="wd ${i === 0 ? 'sun' : ''}">${d}</div>`).join('');
  for (let i = 0; i < new Date(y, m - 1, 1).getDay(); i++) html += '<span class="day blank" aria-hidden="true"></span>';
  for (let d = 1, n = new Date(y, m, 0).getDate(); d <= n; d++) {
    const key = `${S.jMonth}-${String(d).padStart(2, '0')}`, es = byDay[key] || [];
    const dots = es.slice(0, 4).map(e => `<i class="${e.kind === 'cellar' ? 'd-c' : 'd-e'}"></i>`).join('') + (es.length > 4 ? '<em>+</em>' : '');
    html += `<button type="button" class="day ${es.length ? 'has' : ''} ${key === S.jDay ? 'sel' : ''} ${key === t ? 'today' : ''}" data-jday="${key}" ${key > t ? 'disabled' : ''} aria-label="${m} 月 ${d} 日${es.length ? `，${sumQty(es)} 瓶` : ''}" aria-pressed="${key === S.jDay}">${d}<span class="dots">${dots}</span></button>`;
  }
  $('jCal').innerHTML = html;
  $('jNext').disabled = S.jMonth >= t.slice(0, 7);
  const dd = new Date(S.jDay + 'T00:00:00'), list = (byDay[S.jDay] || []).sort((a, b) => a.at.localeCompare(b.at));
  $('jDayTitle').textContent = `${dd.getMonth() + 1} 月 ${dd.getDate()} 日（星期${WEEK[dd.getDay()]}）`;
  $('jDayCount').textContent = list.length ? `${sumQty(list)} 瓶` : '';
  $('jDayList').innerHTML = list.map(entryHtml).join('') || '<div class="empty-day">這天沒有紀錄。</div>';
  $('jAdd').hidden = !canEdit() || S.jDay > t;
}
function shiftMonth(n) {
  const [y, m] = S.jMonth.split('-').map(Number), d = new Date(y, m - 1 + n, 1);
  S.jMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; S.jDay = null; renderJournal();
}
async function setRating(key, n) {
  if (!canEdit() || S.rateBusy) return;
  const e = journalEntries().find(x => x.key === key); if (!e) return;
  const next = n === e.rating ? 0 : n;
  S.rateBusy = true;
  try {
    await mutate(d => {
      const rec = e.kind === 'cellar' ? (d.wines[e.wineId]?.outs || []).find(o => (o.at || '') === e.at) : (d.journal || []).find(j => j.id === e.id);
      if (!rec) fail('找不到這筆紀錄，請重新整理。');
      if (next) rec.rating = next; else delete rec.rating;
    }, `評分 ${e.wineId || ''} ${e.name}：${next} 顆星`, {quiet: true});
  } catch (err) { toast(msgOf(err)); }
  finally { S.rateBusy = false; renderJournal(); }
}
function openJournal(editId) {
  if (!canEdit()) return;
  ensureLists(); S.jEdit = editId || null; S.jPhoto = null;
  S.jf = {src: '', cab: '', shelf: '', wineId: '', miss: false};
  const j = editId ? (S.data.journal || []).find(x => x.id === editId) : null;
  $('jFormTitle').textContent = j ? '編輯紀錄' : '紀錄';
  $('j_srcSet').hidden = !!j;
  document.querySelectorAll('input[name=j_src]').forEach(r => r.checked = !!j && r.value === 'ext');
  document.querySelectorAll('input[name=j_type]').forEach(r => r.checked = false);
  $('j_date').value = j?.date || S.jDay || today(); $('j_date').max = today();
  $('j_name').value = j?.name || ''; $('j_vintage').value = j?.vintage || ''; $('j_qty').value = j?.qty || 1; $('j_qty').removeAttribute('max');
  $('j_note').value = j?.note || ''; S.jRating = Number(j?.rating) || 0;
  $('j_mname').value = ''; $('j_mvintage').value = ''; $('j_left').value = '0'; fillLocPair($('j_cab'), $('j_shelf'));
  $('j_preview').hidden = true; $('j_camera').value = ''; $('j_gallery').value = '';
  syncJournalForm(); showDialog('journalModal');
}
function stockAt() {
  const out = [];
  for (const w of active()) (w.locations || []).forEach(l => { if (l.quantity > 0) out.push({w, l}); });
  return out;
}
function renderPicker() {
  const f = S.jf, all = stockAt();
  if (f.miss) {
    $('j_path').innerHTML = `<button type="button" data-jstep="back">‹ 回到點選酒窖的酒</button>`;
    $('j_pick').innerHTML = '';
    $('j_missBtn').hidden = true; $('j_miss').hidden = false;
    return;
  }
  $('j_missBtn').hidden = false; $('j_miss').hidden = true;
  const crumb = (step, label, on) => `<button type="button" data-jstep="${step}" class="${on ? 'on' : ''}">${esc(label)}</button>`;
  const sel = f.wineId ? byId(f.wineId) : null;
  $('j_path').innerHTML = [crumb('cab', f.cab || '① 選櫃位', !f.cab), f.cab ? crumb('shelf', f.shelf || '② 選層位', !f.shelf) : '', f.shelf ? crumb('wine', sel ? sel.wineName : '③ 選酒', !f.wineId) : ''].filter(Boolean).join('<span class="sep">›</span>');
  // 有照片的酒：點縮圖可放大，左右滑動看全部照片
  const thumb = w => { const u = thumbUrl(w), n = photosOf(w).length; return u ? `<span class="pthumb-v" data-jview="${esc(w.wineId)}" role="button" tabindex="0" aria-label="查看「${esc(w.wineName)}」的 ${n} 張照片"><img class="pthumb" src="${esc(u)}" alt="" loading="lazy"><i class="pcount">🔍${n > 1 ? ' ' + n : ''}</i></span>` : `<span class="pthumb">${esc(w.vintage || 'NV')}</span>`; };
  const card = (attr, title, sub, n, w) => `<button type="button" class="pcard ${w ? 'withimg' : ''}" ${attr}>${w ? thumb(w) : ''}<span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span><em>${n} 瓶</em></button>`;
  let html = '';
  if (!f.cab) {
    const m = new Map(); for (const {l} of all) m.set(l.cabinet, (m.get(l.cabinet) || 0) + l.quantity);
    html = [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => card(`data-jcab="${esc(c)}"`, esc(c), '', n)).join('');
  } else if (!f.shelf) {
    const m = new Map(); for (const {l} of all) if (l.cabinet === f.cab) m.set(l.shelf, (m.get(l.shelf) || 0) + l.quantity);
    html = [...m].sort((a, b) => shelfNo(a[0]) - shelfNo(b[0])).map(([sh, n]) => card(`data-jshelf="${esc(sh)}"`, esc(sh), '', n)).join('');
  } else if (!f.wineId) {
    html = all.filter(({l}) => l.cabinet === f.cab && l.shelf === f.shelf).sort((a, b) => a.w.wineName.localeCompare(b.w.wineName, 'en'))
      .map(({w, l}) => card(`data-jwine="${esc(w.wineId)}"`, esc(w.wineName), esc([w.vintage, w.wineryRegion].filter(Boolean).join(' · ')), l.quantity, w)).join('');
  } else {
    const l = (sel.locations || []).find(x => x.cabinet === f.cab && x.shelf === f.shelf);
    html = `<div class="pcard chosen withimg">${thumb(sel)}<span><b>${esc(sel.wineName)}${sel.vintage ? ' <span class="v">' + esc(sel.vintage) + '</span>' : ''}</b><small>${esc(f.cab)} · ${esc(f.shelf)}</small></span><em>${l ? l.quantity : 0} 瓶</em></div>`;
  }
  $('j_pick').innerHTML = html || '<p class="hint">這裡沒有庫存。</p>';
}
function syncJournalForm() {
  const src = document.querySelector('input[name=j_src]:checked')?.value || '';
  S.jf.src = src;
  const f = S.jf, cellar = src === 'cellar';
  $('j_cellarBox').hidden = !cellar; $('j_extBox').hidden = src !== 'ext';
  if (cellar) renderPicker();
  const ready = src === 'ext' || (cellar && (f.wineId || f.miss));
  $('j_common').hidden = !ready;
  $('j_typeSet').hidden = !cellar;
  $('j_photoF').hidden = cellar && !f.miss;
  if (cellar && f.wineId) {
    const l = (byId(f.wineId)?.locations || []).find(x => x.cabinet === f.cab && x.shelf === f.shelf);
    if (l) $('j_qty').max = l.quantity;
  } else $('j_qty').removeAttribute('max');
  document.querySelectorAll('#j_stars [data-jstar]').forEach(b => { b.classList.toggle('on', Number(b.dataset.jstar) <= S.jRating); b.setAttribute('aria-pressed', Number(b.dataset.jstar) === S.jRating); });
}
/* 看照片：飲酒日誌選酒時確認是哪一瓶 */
function openViewer(id) {
  const w = byId(id); if (!w || !photosOf(w).length) return;
  const n = photosOf(w).length;
  $('viewerTitle').textContent = [w.wineName, w.vintage].filter(Boolean).join('　');
  $('viewerBody').innerHTML = galleryHtml(w) + `<p class="hint viewer-hint">${n > 1 ? `共 ${n} 張，左右滑動查看` : '只有 1 張照片'}</p>`;
  showDialog('viewerModal');
}
function journalPick(e) {
  const v = e.target.closest('[data-jview]'); if (v) { e.preventDefault(); return openViewer(v.dataset.jview); }
  const f = S.jf, t = e.target.closest('button'); if (!t) return;
  if (t.dataset.jcab !== undefined) { f.cab = t.dataset.jcab; f.shelf = ''; f.wineId = ''; }
  else if (t.dataset.jshelf !== undefined) { f.shelf = t.dataset.jshelf; f.wineId = ''; }
  else if (t.dataset.jwine !== undefined) { f.wineId = t.dataset.jwine; $('j_qty').value = 1; }
  else if (t.dataset.jstep === 'cab') { f.cab = ''; f.shelf = ''; f.wineId = ''; }
  else if (t.dataset.jstep === 'shelf') { f.shelf = ''; f.wineId = ''; }
  else if (t.dataset.jstep === 'wine') { f.wineId = ''; }
  else if (t.dataset.jstep === 'back') { f.miss = false; }
  else return;
  showErr('journalErr', '');
  syncJournalForm();
  $('j_path').scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
}
function startMissing() {
  const f = S.jf; f.miss = true; f.wineId = '';
  fillLocPair($('j_cab'), $('j_shelf'), f.cab || '', f.shelf || '');
  syncJournalForm(); $('j_mname').focus();
}
async function saveJournal() {
  const f = S.jf, src = f.src, me = S.session.label;
  const date = $('j_date').value, qty = Number($('j_qty').value), note = $('j_note').value.trim(), rating = S.jRating || 0;
  const type = document.querySelector('input[name=j_type]:checked')?.value || '';
  if (!src) fail('請先選擇「酒窖」或「非酒窖」。');
  if (src === 'cellar' && !f.wineId && !f.miss) fail('請依序點選櫃位、層位和酒；找不到的話按「補登一筆」。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('請填寫日期。');
  if (date > today()) fail('日期不能晚於今天。');
  if (!Number.isInteger(qty) || qty < 1) fail('瓶數必須是 1 以上的整數。');
  if (src === 'cellar' && !type) fail('請選擇類型：自飲、聚餐或其他。');
  const stamp = rating ? {rating} : {};
  if (src === 'cellar' && f.wineId) {
    const id = f.wineId, cabinet = f.cab, shelf = f.shelf;
    const res = await mutate(d => {
      const cur = d.wines[id]; if (!cur) fail('這款酒已不存在。');
      const l = (cur.locations || []).find(x => x.cabinet === cabinet && x.shelf === shelf);
      if (!l || l.quantity <= 0) fail('這個位置已沒有庫存，請重新點選。');
      if (l.quantity < qty) fail(`這個位置只剩 ${l.quantity} 瓶。`);
      const old = l.quantity; l.quantity -= qty;
      const t = now(); cur.updatedAt = t; cur.updatedBy = me; cur.revision = (cur.revision || 0) + 1;
      cur.outs = [...(cur.outs || []), {date, type, qty, cabinet, shelf, reason: note, ...stamp, by: me, at: t}];
      const archived = cur.locations.every(x => !x.quantity);
      if (archived) { cur.status = 'archived'; cur.archivedAt = t; cur.archivedBy = me; }
      return {old, left: l.quantity, archived, name: cur.wineName};
    }, x => `出庫 ${id} ${x.name}（${type}）：${cabinet}/${shelf} ${x.old}→${x.left}（−${qty}）${x.archived ? '，全部出清' : ''}\n\n日期：${date}\n類型：${type}${note ? '\n說明：' + note : ''}`);
    toast(res.archived ? `已紀錄，「${res.name}」已全部喝完。` : `已紀錄，${cabinet} · ${shelf} 還有 ${res.left} 瓶。`);
  } else if (src === 'cellar') {
    const name = $('j_mname').value.trim(), vintage = $('j_mvintage').value.trim();
    const left = Number($('j_left').value || 0), cab = $('j_cab').value.trim(), shelf = $('j_shelf').value.trim();
    if (!name) fail('請填寫酒名。');
    if (!Number.isInteger(left) || left < 0) fail('剩下的瓶數必須是 0 以上的整數。');
    if (!cab || !shelf) fail('請選擇這瓶酒原本的櫃位和層位。');
    let photo = '', thumb = '';
    if (S.jPhoto) ({photo, thumb} = await uploadPhoto(S.jPhoto, 'new'));
    await mutate(d => {
      const n = Object.keys(d.wines).reduce((mx, k) => /^W\d+$/.test(k) ? Math.max(mx, Number(k.slice(1))) : mx, 0) + 1;
      const id = 'W' + String(n).padStart(3, '0'), t = now();
      d.wines[id] = {wineName: name, wineryRegion: '', vintage, entryDate: '', volume: '750ml', source: '', referencePrice: null, origin: '', drinkWindow: '', grapeNotes: '飲用時補登',
        photo, thumb, status: left > 0 ? 'active' : 'archived', locations: left > 0 ? [{cabinet: cab, shelf, quantity: left}] : [],
        outs: [{date, type, qty, cabinet: cab, shelf, reason: note, ...stamp, by: me, at: t}],
        createdAt: t, createdBy: me, updatedAt: t, updatedBy: me, revision: 1, ...(left > 0 ? {} : {archivedAt: t, archivedBy: me})};
      d.catalog = d.catalog || {cabinets: [], shelves: []};
      if (!d.catalog.cabinets.includes(cab)) d.catalog.cabinets.push(cab);
      if (!d.catalog.shelves.includes(shelf)) d.catalog.shelves.push(shelf);
      return id;
    }, id => `補登並出庫 ${id} ${name}（${type}）：${cab}/${shelf} 喝掉 ${qty} 瓶，剩 ${left} 瓶\n\n日期：${date}${note ? '\n說明：' + note : ''}`);
    toast(left > 0 ? `已補登「${name}」並紀錄，酒窖還有 ${left} 瓶。` : `已補登「${name}」並紀錄。`);
  } else {
    const name = $('j_name').value.trim(), vintage = $('j_vintage').value.trim();
    if (!name) fail('請填寫酒名。');
    let photo = '', thumb = '';
    if (S.jPhoto) ({photo, thumb} = await uploadPhoto(S.jPhoto, 'J'));
    const editId = S.jEdit;
    await mutate(d => {
      d.journal = d.journal || [];
      const fields = {date, name, vintage, qty, note};
      if (editId) {
        const j = d.journal.find(x => x.id === editId); if (!j) fail('這筆紀錄已不存在。');
        Object.assign(j, fields);
        if (rating) j.rating = rating; else delete j.rating;
        if (photo) { j.photo = photo; j.thumb = thumb; }
      } else d.journal.push({id: crypto.randomUUID(), ...fields, source: '非酒窖', ...stamp, photo, thumb, by: me, at: now()});
    }, `${editId ? '編輯' : '新增'}飲酒紀錄 ${name}（非酒窖）\n\n日期：${date}`);
    toast(editId ? '已更新紀錄。' : `已紀錄「${name}」。`);
  }
  S.jMonth = date.slice(0, 7); S.jDay = date;
  $('journalModal').close(); renderHistory();
}
async function deleteJournal(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定刪除？'; setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; } }, 4000); return; }
  const id = btn.dataset.jdel, j = (S.data.journal || []).find(x => x.id === id); if (!j) return;
  try {
    await mutate(d => { d.journal = (d.journal || []).filter(x => x.id !== id); }, `刪除飲酒紀錄 ${j.name}\n\n日期：${j.date}`);
    toast('已刪除這筆飲酒紀錄。');
  } catch (e) { toast(msgOf(e)); }
  renderJournal();
}
function renderHistory() {
  renderJournal();
  if ($('journalView').open) renderJTab();
  const all = [];
  for (const w of wines()) for (const o of w.outs || []) all.push({...o, wineId: w.wineId, wineName: w.wineName, vintage: w.vintage, gone: w.status === 'archived'});
  all.sort((a, b) => ((b.date || '') + (b.at || '')).localeCompare((a.date || '') + (a.at || '')));
  const years = [...new Set(all.map(o => (o.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (S.histYear && !years.includes(S.histYear)) S.histYear = '';
  $('h_year').innerHTML = `<option value="">全部年份</option>` + years.map(y => `<option value="${y}" ${y === S.histYear ? 'selected' : ''}>${y} 年</option>`).join('');
  document.querySelectorAll('#h_types [data-htype]').forEach(b => b.classList.toggle('on', b.dataset.htype === (S.histType || '')));
  const typeOf = o => OUT_TYPES.includes(o.type) ? o.type : '其他';
  const inYear = all.filter(o => !S.histYear || (o.date || '').startsWith(S.histYear));
  const rows = inYear.filter(o => !S.histType || typeOf(o) === S.histType);
  const bottles = list => list.reduce((a, o) => a + (Number(o.qty) || 0), 0);
  const byType = OUT_TYPES.map(t => [t, bottles(inYear.filter(o => typeOf(o) === t))]).filter(([, n]) => n);
  $('histSum').innerHTML = inYear.length
    ? `<b>${S.histYear ? S.histYear + ' 年' : '全部'}：出庫 ${inYear.length} 次、${bottles(inYear)} 瓶</b>${byType.length ? `<span>${byType.map(([t, n]) => `<em>${t} ${n} 瓶</em>`).join('')}</span>` : ''}`
    : '';
  $('histList').innerHTML = rows.map(o => `<div class="hrow ho" data-hist="${esc(o.wineId)}" role="button" tabindex="0">
    <span class="d">${fmtDate(o.date)}</span><span class="q">−${o.qty}</span>
    <span class="r"><b>${esc(o.wineName)}${o.vintage ? ' <span class="v">' + esc(o.vintage) + '</span>' : ''}</b><small>${esc([o.type, o.reason].filter(Boolean).join(' · ') || '—')} · ${esc(o.cabinet)} · ${esc(o.shelf)} · ${esc(nameOf(o.by))}</small></span>
    ${o.gone ? '<span class="gone">已出清</span>' : ''}</div>`).join('')
    || `<p class="hint">${all.length ? '沒有符合條件的出庫紀錄。' : '還沒有出庫紀錄。之後每次出庫都會列在這裡。'}</p>`;
  const gone = wines().filter(w => w.status === 'archived').sort((a, b) => (b.archivedAt || '') > (a.archivedAt || '') ? 1 : -1);
  $('histGone').innerHTML = gone.map(w => `<div class="hrow" data-hist="${esc(w.wineId)}" role="button" tabindex="0"><span><b>${esc(w.wineName)}</b> ${esc(w.vintage || '')} <span class="hint">${esc(w.wineryRegion || '')}</span></span><span class="hint">出清於 ${fmtTime(w.archivedAt)}（${esc(nameOf(w.archivedBy))}）</span></div>`).join('') || '<p class="hint">還沒有出清的酒款。</p>';
}
/* 指定不顯示在異動紀錄的 commit（2026/11/9 測試待入櫃的 7 筆）。資料與 git 歷史都不受影響 */
const HIDDEN_AUDIT = new Set([
  '3ae55159de6a6c6a54213dfe3839442ec2403c1c', 'ca6ae983dab79f213631e5cc9fbb86431db97dcb', 'fb96f4b05855427310356af794b4e7c2651261b3',
  '47b8dcbea26af0ec7d39669cc0a81b0010f97781', '2baadb54eccd3cbb3ecc0d1cd90291c13f93fd3f', '778bab6f35b900e8bbeebf92a03c0a7d659dff90',
  '0884154c4c8311188772164f21f21e90b6b0e79a',
]);
async function loadAudit(wineId, page) {
  S.auditLoadedFor = wineId;
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
        if (/^(飲用優先|評分|調整照片順序|更換封面照片) /.test(c.commit.message) || HIDDEN_AUDIT.has(c.sha)) continue;
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
