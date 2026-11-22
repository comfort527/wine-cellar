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
  data: null, etag: null, keys: null, keysSha: null, session: null,
  filter: null, search: '', view: 'list', 
  editing: null, stock: null, photo: null, localPhotos: new Map(),
  sort: 'loc', drawer: null, newPhotos: [], pendKeep: [], pendNew: [], jt: 'cal', js: {q: '', type: '', when: 'all', hi: false}, jm: {q: '', group: 'recent'},
  busy: 0, lastPoll: 0, syncedAt: null, rawFallback: false, auditPage: 1, auditWine: '', audit: []
};
S.view = 'grid';
try { S.view = localStorage.getItem('cellarView') === 'list' ? 'list' : 'grid'; S.sort = localStorage.getItem('cellarSort') || 'loc'; } catch {}

/* ---------- 小工具 ---------- */
let toastTimer;
function toast(m) { $('toast').textContent = m; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function notice(m, bad) { const n = $('notice'); n.textContent = m || ''; n.hidden = !m; n.classList.toggle('bad', !!bad); }
function showErr(id, m) { const e = $(id); e.textContent = m || ''; e.hidden = !m; if (m) e.scrollIntoView({block: 'nearest'}); }  // 手機的按鈕固定在底部，錯誤訊息要捲到看得見
function showDialog(id) { document.querySelectorAll('.ferr').forEach(e => e.hidden = true); $(id).showModal(); }
/* 關閉視窗時先播收回動畫：動畫由 CSS 的 dialog.closing 決定，沒有動畫（例如系統設定減少動態效果）就直接關。
   收回途中又要打開同一個視窗時，取消關閉、維持開啟。 */
const dlgClose = HTMLDialogElement.prototype.close, dlgShow = HTMLDialogElement.prototype.showModal;
const isClosing = d => d.classList.contains('closing'), dlgStack = [];   // dlgStack：視窗打開的先後順序
HTMLDialogElement.prototype.showModal = function () {
  if (this.open && isClosing(this)) { this.classList.remove('closing'); navLater(this); return; }
  // 從底部列切換：同一瞬間換成新視窗（外框直接出現、底部列直接搬過來、舊視窗同時收掉），只讓裡面的內容淡入，
  // 不會有新舊兩個視窗疊在一起、也不會露出後面的首頁
  const from = S.swapFrom; S.swapFrom = null;
  if (from) this.classList.add('swap');
  dlgShow.call(this);
  const i = dlgStack.indexOf(this); if (i >= 0) dlgStack.splice(i, 1); dlgStack.push(this);
  if (!from) return navLater(this);
  if (isNavDlg(this)) navInto(this);
  from.classList.remove('closing', 'hero', 'has-nav', 'swap'); if (from.open) dlgClose.call(from);   // swap 留到關閉時才拿掉：中途拿掉會讓升起動畫重播
};
HTMLDialogElement.prototype.close = function (v) {
  if (!this.open || isClosing(this)) return;
  if (this.classList.contains('has-nav')) navOut();
  const before = getComputedStyle(this).animationName;
  if (this.id === 'drawer') heroClose();
  this.classList.add('closing');
  const cs = getComputedStyle(this);
  if (cs.animationName === 'none' || cs.animationName === before || !parseFloat(cs.animationDuration)) { this.classList.remove('closing', 'hero'); return dlgClose.call(this, v); }
  const done = () => { clearTimeout(timer); this.removeEventListener('animationend', onEnd); if (!isClosing(this)) return; this.classList.remove('closing', 'hero'); dlgClose.call(this, v); };
  const onEnd = e => { if (e.target === this) done(); };
  this.addEventListener('animationend', onEnd);
  const timer = setTimeout(done, 450);
  this.finishClose = done;
};
/* 底部列跟著「日誌、待入櫃、管理」：這三個是底部列的目的地，視窗開著時把底部列搬進視窗裡
   （showModal 開的視窗外面都按不到），關掉時搬回原位。視窗升起的動畫跑完才搬進去，免得底部列跟著視窗移動 */
const NAV_DLG = {journalView: 'journal', pendModal: 'pend', adminModal: 'admin', wineModal: 'add'};
// 新增酒款的視窗也是底部列的目的地；但從詳細資料按「編輯」打開時不算（那時沿用一般視窗）
const isNavDlg = d => !!NAV_DLG[d.id] && (d.id !== 'wineModal' || d.dataset.mode === 'new');
let navSlot = null;   // 底部列原本的位置
const navWanted = () => matchMedia(PHONE_MQ + ', ' + TABLET_MQ).matches;
function navMark(key) { document.querySelectorAll('#bnav [data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === (key || 'home'))); }
function navInto(d) {
  const n = $('bnav'); if (!n || !d.open || isClosing(d) || !navWanted()) return;
  if (!navSlot) { navSlot = document.createComment('底部列原位'); n.before(navSlot); }
  const prev = n.closest('dialog'); if (prev && prev !== d) prev.classList.remove('has-nav');
  if (n.parentElement !== d) d.append(n);
  d.classList.add('has-nav'); navMark(NAV_DLG[d.id]);
}
function navOut() {
  const n = $('bnav'); if (!n || !navSlot) return;
  const d = n.closest('dialog'); if (d) d.classList.remove('has-nav');
  n.style.transform = ''; n.style.transition = '';
  if (n.previousSibling !== navSlot) navSlot.after(n);
  navMark(null);
}
/* 手機直放：底部列的「搜尋」。點下去底部列變成搜尋列，把清單上方那個搜尋框（同一個 #search）搬進來、鍵盤跳出 */
let sbSlot = null;
const searching = () => document.body.classList.contains('searching');
function enterSearch() {
  if (!matchMedia(PHONE_MQ + ', ' + TABLET_MQ).matches) return;   // 手機直放與 iPad
  // 視窗開著時輸入框拿不到焦點：先立刻關掉所有視窗（不播動畫），再在同一個點擊裡 focus，iPhone 才會跳出鍵盤
  navOut();
  document.querySelectorAll('dialog[open]').forEach(d => { d.classList.remove('closing', 'hero', 'swap', 'has-nav'); dlgClose.call(d); });
  const lab = $('search').closest('label');
  if (!sbSlot) { sbSlot = document.createComment('搜尋框原位'); lab.before(sbSlot); }
  $('sbField').prepend(lab);
  document.body.classList.add('searching');
  $('search').focus({preventScroll: true});
  sbCount(); sbPlace();
  document.querySelector('.ledger').scrollIntoView({block: 'start'});
}
function exitSearch(clear) {
  if (!searching()) return;
  document.body.classList.remove('searching');
  if (sbSlot) sbSlot.after($('search').closest('label'));
  $('sbar').style.transform = $('sbar').style.bottom = '';
  $('search').blur();
  if (clear) { S.search = ''; $('search').value = ''; render(); }
}
function sbCount() { if ($('sbCount')) $('sbCount').textContent = searching() && S.search.trim() ? `找到 ${S.searchHits || 0} 款` : ''; }
// 鍵盤跳出時，畫面可見的範圍變矮：把搜尋列往上推到鍵盤上方
function sbPlace() {
  const vv = window.visualViewport; if (!vv) { $('sbar').style.transform = $('sbar').style.bottom = ''; return; }
  const sb = $('sbar'), off = searching() ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  // 鍵盤打開時：搜尋列直接貼在鍵盤（含 iPhone 鍵盤上方的系統工具列）上方 6px，不再多留底部安全區的空隙。
  // 只用鍵盤高度來放，不去量搜尋列的位置（iPhone 回報的位置跟一般瀏覽器不同，量了會算錯）
  sb.style.transform = ''; sb.style.bottom = off ? `${off + 6}px` : '';
}
window.visualViewport?.addEventListener('resize', sbPlace);
window.visualViewport?.addEventListener('scroll', sbPlace);
function qaClose() { $('qa').classList.remove('open'); $('qaBtn').setAttribute('aria-expanded', 'false'); }
function navLater(d) {
  if (!isNavDlg(d) || !navWanted()) return;
  const go = () => navInto(d), an = getComputedStyle(d).animationName;
  if (!an || an === 'none') return go();
  const h = e => { if (e.target === d) { d.removeEventListener('animationend', h); go(); } };
  d.addEventListener('animationend', h); setTimeout(go, 400);
}
document.addEventListener('close', e => { if (!(e.target instanceof HTMLDialogElement)) return; e.target.classList.remove('swap'); if (e.target.classList.contains('has-nav')) navOut(); }, true);
// Esc／返回鍵：也走收回動畫；上一個視窗還在收回時又按一次，就直接收完並關下一個
document.addEventListener('cancel', e => {
  const d = e.target; if (!(d instanceof HTMLDialogElement)) return;
  e.preventDefault();
  if (!isClosing(d)) return d.close();
  d.finishClose?.();
  [...dlgStack].reverse().find(x => x.open && !isClosing(x))?.close();
}, true);
function fail(m) { const e = new Error(m); e.user = true; throw e; }
function msgOf(e) { return e?.user ? e.message : '操作未完成，請稍後再試。'; }
/* 身分（存在裝置設定裡的代號不變，只改顯示名稱）：
   admin＝工程人員：全部功能，含管理裝置密碼、新增／刪除人員、更換權杖
   editor＝管理員：除了上面三項以外都可以
   user＝使用者：只能對已建好的酒款出庫、移動，拍照放進待入櫃，記錄飲酒日誌（只能改、刪自己的紀錄）
   沒登入的訪客：只看得到酒窖 */
const ROLE_NAMES = {user: '使用者', editor: '管理員', admin: '工程人員'};
const roleName = r => ROLE_NAMES[r] || '管理員';
const canUse = () => !!S.session;                                  // 有登入
const canEdit = () => !!S.session && S.session.role !== 'user';    // 管理員以上
const mine = by => !!S.session && by === S.session.label;          // 是不是自己記的
const canModEntry = e => canEdit() || mine(e.by);                  // 可以改、刪、評分這筆飲酒紀錄
/* iPad：761–1180px，或觸控螢幕寬到 1400px（iPad Pro 橫放）。橫放時改成左右雙欄 */
const TABLET_MQ = '(min-width:761px) and (max-width:1180px) and (min-height:600px), (min-width:761px) and (max-width:1400px) and (min-height:600px) and (pointer:coarse)';
const DESK_MQ = '(min-width:1181px) and (pointer:fine), (min-width:1401px)';
const PHL_MQ = '(orientation:landscape) and (max-height:500px) and (max-width:1000px)'; // 手機橫放
const PHONE_MQ = '(max-width:760px) and (orientation:portrait), (max-width:760px) and (min-height:501px)'; // 手機直式
const SPLIT_MQ = '(min-width:761px) and (max-width:1180px) and (min-height:600px) and (orientation:landscape), (min-width:761px) and (max-width:1400px) and (min-height:600px) and (pointer:coarse) and (orientation:landscape)';
/* 版本檢查：手機或瀏覽器可能留著舊的 style.css，新程式配舊樣式會讓酒櫃畫不出來。不一致就重新載入樣式。 */
const APP_VER = '20261122b';
(function ensureCss() {
  const cur = getComputedStyle(document.documentElement).getPropertyValue('--ver').replace(/["'\s]/g, '');
  if (cur === APP_VER) return;
  const link = document.getElementById('mainCss') || document.querySelector('link[rel=stylesheet][href*="style.css"]');
  if (link) link.href = 'style.css?v=' + APP_VER + '&t=' + Date.now();
})();
const isEng = () => S.session?.role === 'admin';   // 工程人員
const canDel = () => ['admin', 'editor'].includes(S.session?.role);   // 刪除櫃位／層位、刪除已喝完紀錄：工程人員與管理員
const wines = () => S.data ? Object.entries(S.data.wines).map(([wineId, w]) => ({...w, wineId})).sort((a, b) => a.wineId < b.wineId ? -1 : 1) : [];
const active = () => wines().filter(w => w.status !== 'archived');
const byId = id => { const w = S.data?.wines[id]; return w ? {...w, wineId: id} : null; };
const total = w => (w.locations || []).reduce((a, l) => a + (Number(l.quantity) || 0), 0);
const nameOf = v => !v ? '—' : String(v).includes('@') ? String(v).split('@')[0] : String(v);
const locText = ls => (ls || []).map(l => `${l.cabinet}/${l.shelf}×${l.quantity}`).join('、') || '無';
const PB = CFG.photoBase || '';   // Cloudflare 照片空間；空白＝照片仍放 GitHub
const encPath = path => path.split('/').map(encodeURIComponent).join('/');
const ghRawBase = () => `${CFG.rawBase}/${CFG.owner}/${CFG.repo}/${CFG.dataBranch}`;
const fileUrl = path => S.localPhotos.get(path) || `${PB || ghRawBase()}/${encPath(path)}`;
// Cloudflare 讀不到的照片（還沒搬過去的舊照片）自動改從 GitHub 讀
document.addEventListener('error', e => {
  const t = e.target; if (!PB || t.tagName !== 'IMG' || t.dataset.fb || !t.src.startsWith(PB + '/')) return;
  t.dataset.fb = '1'; t.src = ghRawBase() + t.src.slice(PB.length);
}, true);
async function fetchPhoto(path) {   // 取得照片內容：Cloudflare 優先，讀不到改 GitHub
  if (S.localPhotos.has(path)) return fetch(S.localPhotos.get(path));
  if (PB) { try { const r = await fetch(`${PB}/${encPath(path)}`); if (r.ok) return r; } catch {} }
  return fetch(`${ghRawBase()}/${encPath(path)}`);
}
async function r2Send(method, path, body) {
  let r;
  try { r = await fetch(`${PB}/${encPath(path)}`, {method, body, headers: {'Authorization': 'Bearer ' + S.session.token, ...(body ? {'Content-Type': 'image/jpeg'} : {})}}); }
  catch { fail('連不上照片空間（Cloudflare），請檢查網路後再試。'); }
  if (r.status === 403) fail('照片空間拒絕這台裝置，請工程人員確認權杖。');
  return r;
}
const photoUrl = w => w.photo ? fileUrl(w.photo) : '';
const thumbUrl = w => w.thumb ? fileUrl(w.thumb) : photoUrl(w);
const MAX_PHOTOS = 4;
const photosOf = w => Array.isArray(w?.photos) && w.photos.length ? w.photos : (w?.photo ? [{photo: w.photo, thumb: w.thumb || ''}] : []);
function setPhotos(cur, list) { cur.photos = list; cur.photo = list[0]?.photo || ''; cur.thumb = list[0]?.thumb || ''; }

/* ---------- 共用小工具 ---------- */
// 寫入酒款時記下修改者、時間並遞增版本號（版本號用來偵測同時編輯）
function touch(cur, who, t = now()) { cur.updatedAt = t; cur.updatedBy = who; cur.revision = (cur.revision || 0) + 1; return t; }
const wineOf = (d, id) => d.wines[id] || fail('這款酒已不存在。');
// 在照片清單找某張照片的位置，找不到就報錯
function photoIndex(list, path, msg = '這張照片已不存在。') { const i = list.findIndex(p => p.photo === path); if (i < 0) fail(msg); return i; }
const fmtMB = mb => mb < 10 ? mb.toFixed(1) : Math.round(mb);
// 刪除鍵：第一次點只變成「確定刪除？」，4 秒內再點才真的刪。回傳 true 代表這次只是提醒
function armDelete(btn) {
  if (btn.dataset.confirm === '1') return false;
  btn.dataset.confirm = '1'; btn.textContent = '確定刪除？';
  setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; } }, 4000);
  return true;
}
// 照片輪播的左右箭頭。回傳 true 代表已處理
function galleryNav(e) {
  const gn = e.target.closest('[data-gnav]'); if (!gn) return false;
  const sl = gn.parentElement.querySelector('.slides'); sl.scrollBy({left: Number(gn.dataset.gnav) * sl.clientWidth, behavior: 'smooth'});
  return true;
}
// 用鍵盤 Enter／空白鍵啟動非按鈕元素（卡片、縮圖）
function onKeyActivate(el, selector, fn) {
  el.addEventListener('keydown', e => { const t = e.target.closest(selector); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); fn(t); } });
}
// 新增照片時的縮圖（第一張標「封面」，右上角 × 移除）
const thumbHtml = (src, i, attr) => `<span class="nthumb"><img src="${src}" alt="照片 ${i + 1}">${i === 0 ? '<em>封面</em>' : ''}<button type="button" ${attr} aria-label="移除這張">×</button></span>`;
// 逐張壓縮；讀不到的照片顯示錯誤並略過，其餘交給 onEach
async function compressEach(files, errId, onEach) {
  for (const f of files) {
    let ph; try { ph = await compress(f); } catch (err) { showErr(errId, err?.user ? err.message : '有一張圖片無法讀取，請換一張。'); continue; }
    await onEach(ph);
  }
}
// 從某個位置出庫：扣瓶數、記一筆出庫、全部出完就移入歷史酒單。出庫與飲酒日誌共用
function takeOut(d, id, {cabinet, shelf, qty, out}, who, hint) {
  const cur = wineOf(d, id);
  const l = (cur.locations || []).find(x => x.cabinet === cabinet && x.shelf === shelf);
  if (!l || l.quantity <= 0) fail(`這個位置已沒有庫存，${hint}`);
  if (l.quantity < qty) fail(`此位置只剩 ${l.quantity} 瓶，${hint}`);
  const old = l.quantity; l.quantity -= qty;
  const t = touch(cur, who);
  cur.outs = [...(cur.outs || []), {...out, qty, cabinet, shelf, by: who, at: t}];
  const archived = cur.locations.every(x => !x.quantity);
  if (archived) { cur.status = 'archived'; cur.archivedAt = t; cur.archivedBy = who; }
  return {old, left: l.quantity, archived, name: cur.wineName};
}
// 表單送出：擋掉瀏覽器預設的送出，執行 fn，錯誤顯示在 errId
const onSubmit = (formId, errId, fn) => $(formId).addEventListener('submit', e => { e.preventDefault(); submit(formId, errId, fn); });
// 日期要是 YYYY-MM-DD 而且不晚於今天；label 例如「出庫」→「請填寫出庫日期」
function checkDate(date, label = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail(`請填寫${label}日期。`);
  if (date > today()) fail(`${label}日期不能晚於今天。`);
}
function checkQty(qty) { if (!Number.isInteger(qty) || qty < 1) fail('瓶數必須是 1 以上的整數。'); }
// 依日期（同一天再依建立時間）由新到舊
const byNewest = (a, b) => ((b.date || '') + (b.at || '')).localeCompare((a.date || '') + (a.at || ''));
// 新酒款編號：現有最大的 W### 加一
const nextWineId = d => 'W' + String(Object.keys(d.wines).reduce((m, k) => /^W\d+$/.test(k) ? Math.max(m, Number(k.slice(1))) : m, 0) + 1).padStart(3, '0');
// 還沒有資料檔時的空白內容；GitHub 偶爾回傳比手上還舊的版本
const emptyData = () => ({schema: 1, rev: 0, catalog: {cabinets: [], shelves: []}, wines: {}});
const isOlder = json => !!S.data && (json.rev || 0) < (S.data.rev || 0);
// 某一櫃某一層目前有幾瓶（list 是要計算的酒款）
function bottlesAt(list, cab, sh) { let n = 0; for (const w of list) for (const l of w.locations || []) if (l.cabinet === cab && l.shelf === sh) n += l.quantity || 0; return n; }
const pendingOf = (d, id, msg) => (d.pending || []).find(x => x.id === id) || fail(msg);
const takeOutMsg = (id, x, {type, cabinet, shelf, qty, date, note}) =>
  `出庫 ${id} ${x.name}（${type}）：${cabinet}/${shelf} ${x.old}→${x.left}（−${qty}）${x.archived ? '，全部出清' : ''}\n\n日期：${date}\n類型：${type}${note ? '\n說明：' + note : ''}`;
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
  const json = res ? res.json : emptyData();
  if (isOlder(json)) return false; // GitHub 偶爾回舊版本，忽略
  S.data = json; S.etag = res?.etag || null;
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
      const base = cur ? cur.json : emptyData();
      if (isOlder(base)) { await sleep(800 * (i + 1)); continue; }
      const draft = structuredClone(base);
      const result = fn(draft);
      draft.rev = (base.rev || 0) + 1; if (!quiet) draft.updatedAt = now();
      const title = typeof message === 'function' ? message(result, draft) : message;
      const r = await putFile(CFG.dataPath, jsonBytes(draft), cur?.sha, `${title}\n\n操作者：${S.session.label}`);
      if (r.ok) { S.data = draft; S.etag = null; S.syncedAt = now(); render(); return result; }
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
  exitSearch(true);
  S.session = null;
  try { localStorage.removeItem('cellarSession'); sessionStorage.removeItem('cellarSession'); } catch {}
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (!silent) toast('已登出，目前為瀏覽模式。');
  render();
}

/* ---------- 重複的 HTML 結構：在 HTML 只寫內容，這裡展開成完整結構（啟動前先執行） ---------- */
// 線條圖示（24×24，筆畫用目前文字顏色）。底部列、上方列、管理選單共用
const ICONS = {
  home: '<path d="M10 2h4v5c0 1.6 3 2.6 3 6v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-8c0-3.4 3-4.4 3-6V2z"/><path d="M7 14h10"/>',
  journal: '<path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v18M12 8h4M12 12h4"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  pend: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  admin: '<path d="M4 7h9M18 7h2M4 17h2M11 17h9"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="8.5" cy="17" r="2.3"/>',
  lib: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  outs: '<path d="M7 3h10v4a5 5 0 0 1-10 0V3z"/><path d="M12 12v8M8 21h8"/>',
  audit: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  loc: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M5 9h14M5 15h14"/>',
  ai: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 15v5M16.5 17.5h5"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M13.5 9.5l2 2"/>',
  export: '<path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5M12 4v11M8 11l4 4 4-4"/>',
  storage: '<path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  logout: '<path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9"/>',
};
const icon = name => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
function expandTemplates(root = document) {
  const take = (el, ...names) => names.map(n => { const v = el.getAttribute(n); el.removeAttribute(n); return v; });
  // 對話框標題列：<dialog aria-labelledby="xTitle" data-title="標題">
  for (const d of root.querySelectorAll('dialog[data-title]')) {
    const [title] = take(d, 'data-title');
    d.insertAdjacentHTML('afterbegin', `<div class="dh"><h2 id="${d.getAttribute('aria-labelledby')}">${title}</h2><button data-close aria-label="關閉">×</button></div>`);
  }
  // 拍照／從相簿選擇：<div class="photo-in" data-picker="f">，data-single 表示相簿只能選一張
  for (const el of root.querySelectorAll('[data-picker]')) {
    const single = el.hasAttribute('data-single'), [id] = take(el, 'data-picker', 'data-single');
    el.innerHTML = `<label>📷 拍照<input type="file" id="${id}_camera" accept="image/*" capture="environment"></label><label>從相簿選擇${single ? '' : '（可多選）'}<input type="file" id="${id}_gallery" accept="image/*"${single ? '' : ' multiple'}></label>`;
  }
  // 搜尋框：放大鏡＋輸入框＋清除鍵
  for (const el of root.querySelectorAll('label.search[data-input]')) {
    const [id, ph, label, clear, clearLabel] = take(el, 'data-input', 'data-ph', 'data-label', 'data-clear', 'data-clear-label');
    el.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4"/></svg><input id="${id}" type="search" placeholder="${ph}" aria-label="${label}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" data-1p-ignore data-lpignore="true"><button type="button" id="${clear}" aria-label="${clearLabel}">×</button>`;
  }
  // 圖示：<i data-icon="home"></i>
  for (const el of root.querySelectorAll('i[data-icon]')) { const [name] = take(el, 'data-icon'); el.setAttribute('aria-hidden', 'true'); el.innerHTML = icon(name); }
  // 管理選單項目：圖示、標題、說明
  for (const el of root.querySelectorAll('.mi[data-t]')) {
    const [ic, t, sub, subId] = take(el, 'data-ic', 'data-t', 'data-s', 'data-sub-id');
    el.innerHTML = `<span class="ic">${icon(ic)}</span><span class="mt"><b>${t}</b><small${subId ? ` id="${subId}"` : ''}>${sub}</small></span><span class="go">›</span>`;
  }
}

/* ---------- 啟動 ---------- */
expandTemplates();
start();
async function start() {
  if (!CFG.owner || CFG.owner === 'YOUR_GITHUB_ACCOUNT') { notice('尚未設定資料 repo：請在 config.js 填入 GitHub 帳號與 repo 名稱。', true); render(); return; }
  restoreSession();
  wire();
  try {
    await loadKeys();
    syncSlot(true);
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
  if (S.session && (force || Date.now() - (S.keysAt || 0) > 60000)) { S.keysAt = Date.now(); try { await loadKeys(); syncSlot(); } catch {} }
  try { if (await loadData(false)) render(); else renderSync(); } catch {}
}
const remembered = () => { try { return !!localStorage.getItem('cellarSession'); } catch { return false; } };
/* 這台裝置在裝置設定裡的狀態：被刪除就登出；身分被工程人員改了就套用新身分 */
function syncSlot(startup) {
  if (!S.session || !(S.keys || S.keysSure)) return;
  const slot = S.keys?.slots?.find(x => x.id === S.session.slotId);
  if (!slot) { logout(true); notice('這台裝置的密碼已被刪除，請重新登入。', true); return; }
  if (slot.role === S.session.role) return;
  saveSession({...S.session, role: slot.role}, remembered());
  if (startup) return;
  if ($('adminModal').open) { const cur = ADMIN_TABS.find(t => !$('tab-' + t).hidden); if (admWide() || cur) switchTab(cur && tabOK(cur) ? cur : 'lib'); else adminMenu(); }
  render(); toast(`你的身分已改為「${roleName(slot.role)}」。`);
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
// 編輯表單有選酒種就照選的；沒選過的舊資料才看酒名與備註的關鍵字判斷（只分紅、白）
/* 酒種：[代號, 名稱, 酒櫃圖瓶底的 class]。存在 w.color；沒選過的舊資料只看關鍵字分紅、白 */
const KINDS = [['red', '紅酒', ''], ['white', '白酒', 'w'], ['sweet', '甜酒／貴腐', 's'], ['sake', '清酒', 'k']];
const KIND_IDS = KINDS.map(k => k[0]);
const kindOf = w => KIND_IDS.includes(w.color) ? w.color : /白酒|white|riesling|sauvignon blanc|chardonnay/i.test(`${w.grapeNotes} ${w.wineName}`) ? 'white' : 'red';
const kindName = k => (KINDS.find(x => x[0] === k) || KINDS[0])[1];
const colorName = w => kindName(kindOf(w));
const emptyCount = () => Object.fromEntries(KIND_IDS.map(k => [k, 0]));
const countSum = c => KIND_IDS.reduce((a, k) => a + (c[k] || 0), 0);
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
  $('whoPill').innerHTML = S.session ? `<b>${esc(S.session.label)}</b> · ${roleName(S.session.role)}` : '訪客瀏覽';
  $('loginBtn').hidden = !!S.session || !S.data;
  $('loginBtn').textContent = setup ? '初始設定' : '管理登入';
  $('logoutBtn').hidden = !S.session;
  $('adminBtn').hidden = !S.session;
  $('addBtn').hidden = !canEdit();
  $('fab').hidden = !canEdit();
  // 手機底部導覽列：訪客只有 酒窖／日誌／登入
  const pn = (S.data?.pending || []).length;
  $('bnAdd').hidden = !canEdit(); $('bnPend').hidden = !canUse(); $('bnAdmin').hidden = !S.session; $('bnLogin').hidden = !!S.session || !S.data;
  // 訪客只看得到酒窖：飲酒日誌也要登入
  for (const b of document.querySelectorAll('#bnav [data-nav=journal], #tnav [data-nav=journal]')) b.hidden = !S.session;
  $('factJournal').hidden = !S.session;
  $('bnLoginT').textContent = setup ? '設定' : '登入';
  $('bnPendN').hidden = !pn; $('bnPendN').textContent = pn;
  // 右下角的圓形快速按鈕（新增、待入櫃）：有登入才出現；使用者只有待入櫃
  $('qa').hidden = !canUse(); $('qaAdd').hidden = !canEdit(); $('bnav').classList.toggle('has-qa', canUse());
  $('qaN').hidden = !pn; $('qaN').textContent = pn;
  if ($('qa').hidden) qaClose();
  $('tnAdd').hidden = !canEdit(); $('tnPend').hidden = !canUse(); $('tnAdmin').hidden = !S.session;
  $('tnPendN').hidden = !pn; $('tnPendN').textContent = pn;
  $('bnav').dataset.n = document.querySelectorAll('#bnav button:not([hidden])').length;
  sbCount();
  $('admWho').textContent = S.session ? `目前是「${S.session.label}」` : '';
  $('viewList').classList.toggle('on', S.view !== 'grid'); $('viewList').setAttribute('aria-pressed', S.view !== 'grid');
  $('viewGrid').classList.toggle('on', S.view === 'grid'); $('viewGrid').setAttribute('aria-pressed', S.view === 'grid');
  $('sortSel').value = S.sort;
  renderSync();
  const list = active();
  // 總覽
  setNum($('sumBottles'), S.data ? list.reduce((a, w) => a + total(w), 0) : '—');
  $('sumWines').textContent = S.data ? list.length + ' 款' : '—';
  const origins = new Set(list.map(countryOf).filter(o => o !== '未填產地'));
  if (S.data) { const ym = today().slice(0, 7); $('sumJournal').innerHTML = `${sumQty(journalEntries().filter(e => (e.date || '').startsWith(ym)))} <small>瓶／本月</small>`; }
  $('sumOrigins').textContent = origins.size ? origins.size + ' 國' : '—';
  // 篩選條件換了（或第一次有資料）：酒卡依序淡入、選到的那一層亮一下
  const fk = JSON.stringify(S.filter), fchg = !!S.data && S.fk !== fk; if (S.data) S.fk = fk;
  renderMap(list);
  if (fchg) $('map').querySelector('.fr-shelf.on, .fridge.on')?.classList.add('lit');
  renderList(list, fchg);
  if (S.data) document.body.classList.remove('loading');
  if ($('drawer').open && S.drawer) renderDrawer();
  if ($('journalView').open || ($('adminModal').open && !$('tab-outs').hidden)) renderHistory();
  if ($('adminModal').open && !$('tab-lib').hidden) renderMem();
  if ($('memModal').open) renderMemDetail();
  renderPending();
}
// 一個櫃子的各層，依層號排序
const shelfEntries = sh => [...sh].sort((a, b) => shelfNo(a[0]) - shelfNo(b[0]));
function renderMap(list) {
  const cabs = new Map();
  for (const c of S.data?.catalog?.cabinets || []) cabs.set(c, new Map());
  for (const w of list) for (const l of w.locations || []) {
    if (!cabs.has(l.cabinet)) cabs.set(l.cabinet, new Map());
    const sh = cabs.get(l.cabinet), cur = sh.get(l.shelf) || {...emptyCount(), wines: 0};
    if (l.quantity > 0) { cur[kindOf(w)] += l.quantity; cur.wines++; }
    sh.set(l.shelf, cur);
  }
  const all = [...cabs].filter(([, sh]) => sh.size);
  // 電腦版櫃子 3 個以上：先顯示全部櫃子的縮圖總覽，點進去才看完整酒櫃
  const overview = all.length >= 3 && matchMedia(DESK_MQ).matches;
  if (!overview || !all.some(([c]) => c === S.cabOpen)) S.cabOpen = overview ? null : S.cabOpen;
  if (overview && !S.cabOpen) {
    $('map').classList.add('mini-mode');
    $('map').innerHTML = all.map(([cab, sh]) => miniCabHtml(cab, sh)).join('');
    renderLegend(all);
    return;
  }
  $('map').classList.remove('mini-mode');
  const back = overview ? `<button type="button" class="cab-back" data-cabback>‹ 全部 ${all.length} 個櫃子</button>` : '';
  const html = back + all.filter(([cab]) => !overview || cab === S.cabOpen).map(([cab, sh]) => {
    const sum = [...sh.values()].reduce((a, s) => a + countSum(s), 0);
    const on = S.filter?.cabinet === cab;
    const shelves = shelfEntries(sh).map(([name, s]) => {
      const n = countSum(s);
      const sel = on && S.filter.shelf === name;
      return `<button class="fr-shelf ${sel ? 'on' : ''} ${n ? '' : 'zero'}" data-cab="${esc(cab)}" data-shelf="${esc(name)}" aria-pressed="${sel}" aria-label="${esc(cab)} ${esc(name)}：${n} 瓶，${s.wines} 款"><span class="fr-btl" data-n="${KIND_IDS.map(k => s[k] || 0).join(',')}"></span><span class="fr-rail"><b>${shelfNo(name) < 999 ? shelfNo(name) : esc(name)}</b><em>${n} 瓶${(f => f === null ? '' : f ? ` <span class="cap-pill ok">可再放 ${f}</span>` : ' <span class="cap-pill full">已滿</span>')(freeAt(cab, name, n))}</em></span></button>`;
    }).join('');
    const frees = [...sh].map(([nm, x]) => freeAt(cab, nm, countSum(x))).filter(f => f !== null), freeSum = frees.reduce((a, f) => a + f, 0);
    return `<div class="fridge ${on && !S.filter.shelf ? 'on' : ''}"><button class="fr-top" data-cab="${esc(cab)}" aria-pressed="${on && !S.filter.shelf}" aria-label="${esc(cab)}：${sum} 瓶，${sh.size} 層${frees.length ? `，空位 ${freeSum}` : ''}"><span class="fr-name">${esc(cab)}</span><span class="fr-led">${sum}</span><span class="fr-sub">${frees.length ? `<span class="cap-top ${freeSum ? '' : 'full'}">${freeSum ? `空位 <b>${freeSum}</b>` : '已滿'}</span>` : `${sh.size} 層`}</span></button><div class="fr-door"><div class="fr-in">${shelves}</div></div><span class="fr-feet"></span></div>`;
  }).join('');
  $('map').innerHTML = html ? html + '' : '<p class="hint">還沒有存放位置。</p>';
  fillBottles(true);
  if (html) renderLegend(all);
}
// 酒櫃下方的圖例：紅酒、白酒一定列；甜酒／貴腐、清酒有放在酒櫃裡才列
function renderLegend(all) {
  const has = emptyCount(); for (const [, sh] of all) for (const s of sh.values()) for (const k of KIND_IDS) has[k] += s[k] || 0;
  const html = KINDS.filter(([k]) => k === 'red' || k === 'white' || has[k]).map(([k, n]) => `<span><i class="lg-${k}"></i>${n}</span>`).join('');
  if (!$('mapLegend')) $('map').insertAdjacentHTML('afterend', '<div class="map-legend" id="mapLegend"></div>');
  if ($('mapLegend').innerHTML !== html) $('mapLegend').innerHTML = html;
}
function miniCabHtml(cab, sh) {
  const rows = shelfEntries(sh).map(([name, s]) => ({name, ...s, n: countSum(s), free: freeAt(cab, name, countSum(s))}));
  const scale = Math.max(1, ...rows.map(r => r.n + (r.free || 0)));
  const sum = rows.reduce((a, r) => a + r.n, 0), frees = rows.filter(r => r.free !== null), freeSum = frees.reduce((a, r) => a + r.free, 0);
  const on = S.filter?.cabinet === cab;
  const bars = rows.map(r => {
    const sel = on && S.filter.shelf === r.name;
    return `<button type="button" class="sb ${sel ? 'on' : ''}" data-cab="${esc(cab)}" data-shelf="${esc(r.name)}" aria-pressed="${sel}" aria-label="${esc(cab)} ${esc(r.name)}：${r.n} 瓶${r.free !== null ? `，可再放 ${r.free}` : ''}"><span class="sn">${shelfNo(r.name) < 999 ? shelfNo(r.name) : esc(r.name)}</span><span class="bar">${KINDS.map(([k, , c]) => r[k] ? `<i class="${c || 'r'}" style="width:${r[k] / scale * 100}%"></i>` : '').join('')}${r.free ? `<i class="f" style="width:${r.free / scale * 100}%"></i>` : ''}</span><span class="sc">${r.n}${r.free === 0 ? '<em class="full">滿</em>' : ''}</span></button>`;
  }).join('');
  return `<div class="mc ${on ? 'on' : ''}"><button type="button" class="mc-h" data-cabopen="${esc(cab)}" aria-label="打開 ${esc(cab)}：${sum} 瓶"><span class="mc-n">${esc(cab)}</span><span class="mc-led">${sum}</span></button>${bars}<button type="button" class="mc-f" data-cabopen="${esc(cab)}"><span>${rows.length} 層・看整櫃 ›</span>${frees.length ? `<em>${freeSum ? `空位 ${freeSum}` : '已滿'}</em>` : ''}</button></div>`;
}
/* ---------- 各層容量：存「現有＋還可放」，空位＝容量−目前瓶數，出入庫後自動更新 ---------- */
const capOf = (cab, sh) => { const v = S.data?.capacity?.[cab]?.[sh]; return Number.isFinite(v) ? v : null; };
const qtyAt = (cab, sh) => bottlesAt(active(), cab, sh);
const freeAt = (cab, sh, n) => { const c = capOf(cab, sh); return c === null ? null : Math.max(0, c - n); };
/* 每層最多畫兩排：下排排滿，上排少一瓶、疊在兩瓶之間；放不下的以「+n」表示，紅白依比例 */
// 放不下時依比例分配要畫的瓶數：有的酒種至少畫 1 瓶，剩下的給比例最大的
function share(cnt, show) {
  const n = cnt.reduce((a, v) => a + v, 0), out = cnt.map(v => v ? Math.max(1, Math.floor(show * v / n)) : 0);
  let diff = show - out.reduce((a, v) => a + v, 0);
  const order = cnt.map((v, i) => [show * v / n - Math.floor(show * v / n), i]).filter(([, i]) => cnt[i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; diff > 0 && order.length; k = (k + 1) % order.length) { const i = order[k]; if (out[i] < cnt[i]) { out[i]++; diff--; } else if (order.every(j => out[j] >= cnt[j])) break; }
  while (diff < 0) { const i = out.indexOf(Math.max(...out)); out[i]--; diff++; }
  return out;
}
function fillBottles(fromRender) {
  // 手機上視窗蓋住酒櫃時先不播，等視窗關掉、看得到酒櫃時再播（見 wireMotion）
  const covered = fromRender === true && !!S.mapShown && motionOK() && mapCovered();
  const prev = fromRender === true && !covered ? S.mapShown : null, cur = new Map();
  for (const el of document.querySelectorAll('#map .fr-btl')) {
    const cnt = (el.dataset.n || '').split(',').map(Number).map(v => v || 0), n = cnt.reduce((a, v) => a + v, 0), cs = getComputedStyle(el);
    const bs = parseFloat(cs.getPropertyValue('--bs')) || 30, gap = parseFloat(cs.getPropertyValue('--gap')) || 3;
    const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const perRow = Math.max(1, Math.floor((width + gap) / (bs + gap))), cap = perRow * 2 - 1;
    const show = n > cap ? cap - 1 : n;   // 放不下時，最後一格改放「+n」
    const draw = n > cap ? share(cnt, show) : cnt;   // 每種酒畫幾瓶
    const sh = el.closest('.fr-shelf'), id = sh.dataset.cab + '\n' + sh.dataset.shelf, was = prev?.get(id);
    cur.set(id, {n, show});
    const key = `${draw.join('|')}|${n}`; if (el.dataset.k === key) continue; el.dataset.k = key;
    el.innerHTML = KINDS.map(([, , c], i) => (c ? `<i class="${c}"></i>` : '<i></i>').repeat(draw[i])).join('') + (n > show ? `<b class="fr-more" title="還有 ${n - show} 瓶">+${n - show}</b>` : '');
    // 出庫、入庫、移動後：這一層的瓶數跳一下，多出來的瓶子冒出來、少掉的瓶子淡出
    if (!was || was.n === n || !motionOK()) continue;
    sh.classList.add('chg');
    const bottles = el.querySelectorAll('i');
    if (show > was.show) [...bottles].slice(-Math.min(3, show - was.show)).forEach(b => b.classList.add('in'));
    else if (show < was.show) for (let k = Math.min(3, was.show - show); k > 0; k--) {
      const g = document.createElement('i'), top = KINDS[draw.indexOf(Math.max(...draw))]; g.className = 'ghost' + (top?.[2] ? ' ' + top[2] : '');
      g.addEventListener('animationend', () => g.remove()); setTimeout(() => g.remove(), 900);
      (el.querySelector('.fr-more') || {before: n2 => el.append(n2)}).before(g);
    }
  }
  if (covered) S.mapPending = true; else if (fromRender === true) S.mapShown = cur;
}
// 數字有變時跳一下（第一次填入不跳）
function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function setNum(el, v) {
  const t = String(v), old = el.textContent; el.textContent = t;
  if (old === t || !/^\d+$/.test(old) || !/^\d+$/.test(t)) return;
  if (motionOK() && mapCovered()) S.numPending = true; else replay(el, 'bump');
}
// 年份由舊到新（沒有年份的排最後），同年份依登錄先後
const oldestFirst = (a, b) => (Number(a.vintage) || 9999) - (Number(b.vintage) || 9999) || a.wineId.localeCompare(b.wineId);
function sortWines(rows) {
  const k = S.sort;
  const firstLoc = w => { const l = (w.locations || []).find(x => x.quantity > 0) || {}; return [l.cabinet || '', shelfNo(l.shelf)]; };
  return rows.sort((a, b) => {
    if (k === 'prio') return prioOf(b) - prioOf(a) || oldestFirst(a, b);
    if (k === 'vintage-desc') { const va = Number(a.vintage) || 0, vb = Number(b.vintage) || 0; return vb - va || a.wineId.localeCompare(b.wineId); }
    if (k === 'vintage') return oldestFirst(a, b);
    if (k === 'qty') return total(b) - total(a) || a.wineId.localeCompare(b.wineId);
    if (k === 'name') return a.wineName.localeCompare(b.wineName, 'en');
    if (k === 'loc') { const [ca, sa] = firstLoc(a), [cb, sb] = firstLoc(b); return ca.localeCompare(cb) || sa - sb || a.wineId.localeCompare(b.wineId); }
    return a.wineId.localeCompare(b.wineId);
  });
}
function renderList(list, stagger) {
  $('filterBar').hidden = !S.filter;
  if (S.filter) $('filterText').textContent = S.filter.kind ? `只顯示${kindName(S.filter.kind)}` : S.filter.origin ? `只顯示產地：${S.filter.origin}` : `只顯示 ${S.filter.cabinet}${S.filter.shelf ? ' · ' + S.filter.shelf : ''}`;
  const q = S.search.trim().toLowerCase();
  const rows = sortWines(list.filter(w => {
    if (S.filter?.kind && kindOf(w) !== S.filter.kind) return false;
    if (S.filter?.origin && countryOf(w) !== S.filter.origin) return false;
    if (S.filter?.cabinet && !(w.locations || []).some(l => l.quantity > 0 && l.cabinet === S.filter.cabinet && (!S.filter.shelf || l.shelf === S.filter.shelf))) return false;
    if (!q) return true;
    return [w.wineId, ...FIELDS.map(f => w[f[0]]), ...(w.locations || []).map(l => l.cabinet + ' ' + l.shelf)].join(' ').toLowerCase().includes(q);
  }));
  // 有輸入搜尋字時，也找所有登錄過的酒：已喝完的酒款、非酒窖的飲用紀錄（不篩選某櫃／某層時才列）
  const extra = q && S.data && !S.filter?.cabinet ? pastMatches(q) : [];
  S.searchHits = rows.length + extra.length;
  $('countText').textContent = !S.data ? '' : extra.length ? `${rows.length} / ${list.length} 款・另有 ${extra.length} 款已喝完／非酒窖` : rows.length === list.length ? `共 ${list.length} 款` : `${rows.length} / ${list.length} 款`;
  const el = $('list');
  el.className = 'rows' + (S.view === 'grid' ? ' grid' : '');
  // 依酒名、年份排序時混在一起排；其他排序（位置、瓶數、飲用優先）時排在後面
  const all = rows.map(w => ({w}));
  if (extra.length) {
    if (['name', 'vintage', 'vintage-desc'].includes(S.sort)) {
      const keyed = [...all, ...extra.map(x => ({x, w: x.w || {wineId: 'zz' + x.key, wineName: x.name, vintage: x.vintage}}))];
      const order = sortWines(keyed.map(k => k.w)); all.length = 0; all.push(...order.map(w => keyed.find(k => k.w === w)));
    } else all.push(...extra.map(x => ({x})));
  }
  el.innerHTML = all.map(({w, x}) => x ? (S.view === 'grid' ? pastCardHtml(x) : pastRowHtml(x)) : S.view === 'grid' ? cardHtml(w) : rowHtml(w)).join('');
  if (stagger) { el.classList.add('stagger'); [...el.children].slice(0, 12).forEach((c, i) => { c.style.animationDelay = i * 28 + 'ms'; }); }
  el.hidden = !all.length;
  const empty = $('empty');
  empty.hidden = !!all.length;
  if (all.length) return;
  if (!S.data) empty.innerHTML = '<h3>讀取中</h3><p>連上 GitHub 後，這裡會列出每一款酒。</p>';
  else if (!list.length) empty.innerHTML = canEdit() ? '<h3>酒窖還是空的</h3><p>按「＋ 新增酒款」登記第一瓶。</p>' : '<h3>酒窖還是空的</h3>';
  else empty.innerHTML = '<h3>沒有符合的酒款</h3><p>換個關鍵字，或按「顯示全部」。</p>';
}
/* 搜尋時一起列出的「已喝完／非酒窖」：已出清的酒款（點開看詳細資料），與非酒窖的飲用紀錄（點開看喝過幾次、再買一次） */
function pastMatches(q) {
  const out = [];
  for (const it of memItems()) {
    if (it.kind === 'cellar' && it.w.status !== 'archived') continue;
    if (it.kind === 'ext' && (S.filter?.kind || S.filter?.origin)) continue;
    if (it.kind === 'cellar') {
      const w = it.w;
      if (S.filter?.kind && kindOf(w) !== S.filter.kind) continue;
      if (S.filter?.origin && countryOf(w) !== S.filter.origin) continue;
      if (![w.wineId, ...FIELDS.map(f => w[f[0]])].join(' ').toLowerCase().includes(q)) continue;
    } else if (![it.name, it.vintage, ...it.events.map(e => [e.note, e.who, e.source].join(' '))].join(' ').toLowerCase().includes(q)) continue;
    out.push(it);
  }
  return out;
}
const pastTag = x => x.kind === 'ext' ? '非酒窖' : '已喝完';
const pastOpen = x => x.kind === 'ext' ? `data-mem="${esc(x.key)}"` : `data-open="${esc(x.w.wineId)}"`;
const pastSub = x => [x.vintage || 'NV', x.count ? `喝過 ${x.count} 次` : '', x.last?.date ? `最後 ${fmtDate(x.last.date)}` : ''].filter(Boolean).join(' · ');
function pastCardHtml(x) {
  const ph = x.photo ? `<img class="ph" src="${esc(x.photo)}" alt="${esc(x.name)}" loading="lazy">` : `<span class="ph">${esc(x.vintage || 'NV')}</span>`;
  return `<div class="card gone ${x.kind === 'ext' ? 'ext' : kindOf(x.w)}" role="button" tabindex="0" ${pastOpen(x)}><span class="phbox ${x.photo ? 'photo' : ''}">${ph}<em class="gtag">${pastTag(x)}</em>${x.w ? keepStamp(x.w) : ''}</span><span class="cb"><b>${esc(x.name)}</b><span class="prod">${esc(x.winery || '')}</span><span>${esc(pastSub(x))}</span></span></div>`;
}
function pastRowHtml(x) {
  return `<button class="row gone" ${pastOpen(x)}>
   ${x.kind === 'ext' ? `<span class="vin">${esc(x.vintage || 'NV')}</span>` : vinHtml(x.w, true)}
   <span class="nm"><b>${esc(x.name)}</b><span>${esc(x.winery || '')}${x.winery && x.origin ? ' · ' : ''}${esc(x.origin || '')}</span></span>
   <span class="lc"><span>${esc(pastSub(x))}</span></span>
   <span class="qt"><em class="gtag">${pastTag(x)}</em></span></button>`;
}
// 年份；清單模式前面加酒種圓點（紅酒紅點、白酒綠點、甜酒／貴腐橘點、清酒白點）
function vinHtml(w, dot) {
  const v = String(w.vintage || '').trim(), k = dot ? `<i class="kd kd-${kindOf(w)}" role="img" aria-label="${colorName(w)}"></i>` : '';
  return /^\d{4}$/.test(v) ? `<span class="vin">${k}${v}</span>` : `<span class="vin nv">${k}${esc(v || 'NV')}</span>`;
}
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
   ${vinHtml(w, true)}
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
  return `<div class="card ${kindOf(w)}" role="button" tabindex="0" data-open="${esc(w.wineId)}"><span class="phbox ${ps.length ? 'photo' : ''}">${media}${prioOf(w) ? pdots(prioOf(w)) : ''}${keepStamp(w)}</span><span class="cb"><b>${esc(w.wineName)}</b><span class="prod">${esc(w.wineryRegion || '')}</span>${(() => { const t = total(w), h = hereQty(w); return h !== null && h !== t ? `<span class="here">${hereWord()} <strong class="hn">${h}</strong> 瓶</span><span class="tot">${esc(w.vintage || 'NV')}・共 ${t} 瓶</span>` : `<span>${esc(w.vintage || 'NV')} · ${t} 瓶</span>`; })()}</span></div>`;
}

/* ---------- 詳細資料抽屜 ---------- */
function openDrawer(id, fromHash, card) {
  if (!byId(id)) return;
  const changed = S.drawer !== id || !$('drawer').open;
  S.drawer = id; renderDrawer();
  const fresh = !$('drawer').open;
  if (fresh || isClosing($('drawer'))) { $('drawer').showModal(); if (fresh) $('drawer').focus({preventScroll: true}); }
  if (changed) $('drawer').scrollTop = 0;
  if (fresh && card) heroOpen(card);
  if (!fromHash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}
function closeDrawer() { if ($('drawer').open) $('drawer').close(); }
function outsHtml(w) {
  const outs = (w.outs || []).map(o => ({...o, kind: 'out'})), moves = (w.moves || []).map(m => ({...m, kind: 'move'})), ins = (w.ins || []).map(x => ({...x, kind: 'in'}));
  const all = [...outs, ...moves, ...ins].sort(byNewest);
  if (!all.length) return '';
  const outQty = outs.reduce((a, o) => a + (Number(o.qty) || 0), 0);
  const sumText = [ins.length ? `入庫 ${ins.length} 次` : '', outs.length ? `出庫 ${outs.length} 次、${outQty} 瓶` : '', moves.length ? `移動 ${moves.length} 次` : ''].filter(Boolean).join('；');
  const row = e => e.kind === 'in' ? `<div class="out in"><span class="d">${fmtDate(e.date)}</span><span class="q">+${e.qty}</span><span class="r"><b>入庫${e.note ? '　' + esc(e.note) : ''}</b><small>${esc(e.cabinet)} · ${esc(e.shelf)} · ${esc(nameOf(e.by))}</small></span></div>` : e.kind === 'out'
    ? `<div class="out"><span class="d">${fmtDate(e.date)}</span><span class="q">−${e.qty}</span><span class="r"><b>${esc(e.type ? e.type + (e.reason ? '　' + e.reason : '') : e.reason)}</b><small>${esc(e.cabinet)} · ${esc(e.shelf)} · ${esc(nameOf(e.by))}</small></span></div>`
    : `<div class="out mv"><span class="d">${fmtDate(e.date)}</span><span class="q">⇄${e.qty}</span><span class="r"><b>${esc(e.from.cabinet)} · ${esc(e.from.shelf)} → ${esc(e.to.cabinet)} · ${esc(e.to.shelf)}</b><small>移動${e.note ? ' · ' + esc(e.note) : ''} · ${esc(nameOf(e.by))}</small></span></div>`;
  return `<section class="dw-outs"><h3>庫存紀錄 <span class="hint">${sumText}</span></h3>${all.map(row).join('')}</section>`;
}
/* 留存紀念：「葡萄品種／備註」裡有剛好「留存紀念」四個字時，照片上蓋金色「留存」戳記（畫在照片上面，照片檔不變） */
const isKeep = w => /留存紀念/.test(w?.grapeNotes || '');
const KEEP_STAMP = `<img class="keep-stamp" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23f6dc8c%22/%3E%3Cstop%20offset%3D%22.5%22%20stop-color%3D%22%23c8963a%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238a6018%22/%3E%3C/linearGradient%3E%3Cpath%20id%3D%22a%22%20d%3D%22M18%2C52%20A32%2C32%200%200%2C1%2082%2C52%22/%3E%3C/defs%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2246%22%20fill%3D%22url%28%23g%29%22%20stroke%3D%22%23ffffff66%22%20stroke-width%3D%222%22/%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2238%22%20fill%3D%22none%22%20stroke%3D%22%23ffffff99%22%20stroke-width%3D%221.2%22%20stroke-dasharray%3D%222%203%22/%3E%3Ctext%20font-size%3D%2210%22%20fill%3D%22%234a3208%22%20letter-spacing%3D%222%22%20font-weight%3D%22700%22%20font-family%3D%22Helvetica%2CArial%2Csans-serif%22%3E%3CtextPath%20href%3D%22%23a%22%20startOffset%3D%2250%25%22%20text-anchor%3D%22middle%22%3EMEMORY%3C/textPath%3E%3C/text%3E%3Ctext%20x%3D%2250%22%20y%3D%2266%22%20text-anchor%3D%22middle%22%20font-size%3D%2228%22%20font-weight%3D%22900%22%20fill%3D%22%233d2706%22%20font-family%3D%22PingFang%20TC%2CNoto%20Sans%20TC%2CMicrosoft%20JhengHei%2Csans-serif%22%3E%E7%95%99%E5%AD%98%3C/text%3E%3C/svg%3E" alt="留存紀念" draggable="false">`;
const keepStamp = w => isKeep(w) ? KEEP_STAMP : '';
const notesHtml = v => esc(v).replace(/留存紀念/g, '<mark class="keep-mark">留存紀念</mark>');
function galleryHtml(w) {
  const ps = photosOf(w); if (!ps.length) return '';
  const imgs = ps.map((p, i) => `<img src="${esc(fileUrl(p.photo))}" alt="${esc(w.wineName)} 照片 ${i + 1}／${ps.length}" ${i ? 'loading="lazy"' : ''} draggable="false">`).join('');
  return `<div class="gal"><div class="slides">${imgs}</div>${keepStamp(w)}${ps.length > 1 ? `<button type="button" class="gnav prev" data-gnav="-1" aria-label="上一張">‹</button><button type="button" class="gnav next" data-gnav="1" aria-label="下一張">›</button>${sdots(ps.length)}` : ''}</div>`;
}
function renderDrawer() {
  const w = byId(S.drawer); if (!w) { closeDrawer(); return; }
  const ed = canEdit(), use = canUse(), t = total(w), archived = w.status === 'archived';
  const facts = `<div><dt>酒種</dt><dd>${colorName(w)}</dd></div>` + [['wineryRegion', '酒莊／產區'], ['origin', '產地'], ['volume', '容量'], ['source', '來源'], ['referencePrice', '參考價格'], ['entryDate', '入庫日期'], ['drinkWindow', '適飲期']]
    .map(([k, l]) => `<div><dt>${l}</dt><dd>${k === 'referencePrice' ? fmtPrice(w[k]) : esc(w[k] || '—')}</dd></div>`).join('');
  const locs = (w.locations || []).map(l => `<div class="dw-loc ${S.filter?.cabinet === l.cabinet && (!S.filter.shelf || S.filter.shelf === l.shelf) ? 'here' : ''}"><span class="where">${esc(l.cabinet)} <small>· ${esc(l.shelf)}</small></span><span class="n">${l.quantity}</span></div>`).join('');
  const prevSl = $('drawerBody').querySelector('.slides'), keep = S.drawerShown === S.drawer && prevSl ? prevSl.scrollLeft : 0;
  S.drawerShown = S.drawer;
  $('drawerBody').innerHTML = `
   <div class="dw-top ${photosOf(w).length ? 'over' : ''}"><span class="id ${archived ? 'gone' : ''}">${archived ? '已出清' : esc(w.volume || '')}</span><button class="x" data-dwclose aria-label="關閉">×</button></div>
   <div class="dw ${photosOf(w).length ? '' : 'no-ph'}">
    <div class="dw-head"><span class="vin">${esc(w.vintage || 'NV')}</span><h2 id="dwName">${esc(w.wineName)}</h2>${w.wineryRegion ? `<p>${esc(w.wineryRegion)}</p>` : ''}</div>
    ${galleryHtml(w)}
    <div class="dw-stock"><div class="sum"><span>目前庫存</span><b>${t} <small style="font-size:22px">瓶</small></b></div>${locs || '<div class="dw-loc"><span class="where hint">沒有存放位置</span></div>'}</div>
    <div class="dw-prio"><span class="lbl">飲用優先</span>${ed ? `<span class="pdots big" role="group" aria-label="設定飲用優先">${[1, 2, 3, 4].map(i => `<button class="${i <= prioOf(w) ? 'on' : ''}" data-prio="${i}" aria-label="優先 ${i}" aria-pressed="${i === prioOf(w)}">${i}</button>`).join('')}</span>` : pdots(prioOf(w), 'big num')}<span class="hint">${prioOf(w) ? `${prioOf(w)}／4` : '未設定'}${ed ? '　點數字設定等級，4 最優先；再點一次取消' : ''}</span></div>
    <div class="dw-act">${use && !archived ? `<button class="primary" data-stockany="${esc(w.wineId)}" ${t ? '' : 'disabled'}>出庫</button><button class="primary" data-moveany="${esc(w.wineId)}" ${t ? '' : 'disabled'}>移動</button>` : ''}${ed ? `<button class="primary" data-edit="${esc(w.wineId)}">編輯</button><button data-photo="${esc(w.wineId)}">照片（${photosOf(w).length}/${MAX_PHOTOS}）</button><button data-log="${esc(w.wineId)}">異動紀錄</button>` : ''}</div>
    ${archived && canDel() ? `<div class="dw-del"><button type="button" class="danger" data-delwine="${esc(w.wineId)}">刪除這筆紀錄</button></div>` : ''}
    ${ed ? (archived ? '<p class="hint" style="margin:0">這款酒已全部出庫。要補回庫存，請按「編輯」填入瓶數，它會回到目前酒款。</p>' : '') : use ? (archived ? '<p class="hint" style="margin:0">這款酒已全部出庫。</p>' : '') : '<p class="hint" style="margin:0">登入後可以出庫與移動這款酒。</p>'}
    <dl class="dw-facts">${facts}${w.grapeNotes ? `<div class="wide"><dt>葡萄品種／備註</dt><dd class="note">${notesHtml(w.grapeNotes)}</dd></div>` : ''}</dl>
    ${use ? outsHtml(w) : ''}
    <div class="dw-meta">${w.createdAt ? `建立 ${fmtTime(w.createdAt)}（${esc(nameOf(w.createdBy))}）<br>` : ''}最後修改 ${fmtTime(w.updatedAt)}（${esc(nameOf(w.updatedBy))}）${archived ? `<br>出清 ${fmtTime(w.archivedAt)}（${esc(nameOf(w.archivedBy))}）` : ''}</div>
   </div>`;
  if (keep) { const sl = $('drawerBody').querySelector('.slides'); if (sl) { sl.scrollLeft = keep; sl.dispatchEvent(new Event('scroll')); } }
  if (S.dwQty && S.dwQty.id === w.wineId && S.dwQty.t !== t) replay($('drawerBody').querySelector('.dw-stock .sum b'), 'bump');
  S.dwQty = {id: w.wineId, t};
}

async function syncNow() { try { await loadData(true); render(); toast('已同步。'); } catch (e) { toast(msgOf(e)); } }

/* ---------- 手機動畫與手勢 ---------- */
const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// 酒櫃圖現在是不是被視窗蓋住：手機任何視窗都算；iPad 橫放與電腦是左右雙欄，右側的詳細資料不會蓋到左邊的酒櫃
const mapCovered = () => { const ds = [...document.querySelectorAll('dialog[open]')]; return ds.some(d => d.id !== 'drawer') || (ds.length > 0 && !matchMedia(SPLIT_MQ + ', ' + DESK_MQ).matches); };
/* 照片放大：點照片卡時，卡片上的照片飛到詳細資料的大照片位置；關閉時飛回卡片。
   飛行中的照片放在最上層（popover），瀏覽器不支援時維持一般的開關動畫。 */
const slideIdx = sl => sl ? Math.round(sl.scrollLeft / Math.max(1, sl.clientWidth)) : 0;
function heroFly(src, from, to, r0, r1) {
  const c = document.createElement('img'); c.className = 'hero-fly'; c.alt = ''; c.src = src; c.popover = 'manual';
  document.body.append(c); c.showPopover();
  const box = (r, rad) => ({left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: rad});
  const a = c.animate([box(from, r0), box(to, r1)], {duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards'});
  const end = () => c.remove(); setTimeout(end, 600);
  return a.finished.then(end, end);
}
// 大照片實際顯示的範圍：滿版裁切 (cover) 就是整個框；完整顯示 (contain) 則依照片比例置中
function heroBox(gal, img, ref) {
  const r = gal.getBoundingClientRect();
  if (getComputedStyle(img).objectFit !== 'contain' || !ref.naturalWidth) return {rect: r, radius: getComputedStyle(gal).borderRadius, fit: 'cover'};
  const k = ref.naturalWidth / ref.naturalHeight, w = k > r.width / r.height ? r.width : r.height * k, h = w / k;
  return {rect: {left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h}, radius: '0px', fit: 'contain'};
}
function heroPair() {
  const dw = $('drawer'), gal = dw.querySelector('.gal'), card = [...document.querySelectorAll('#list .card')].find(c => c.dataset.open === S.drawer);
  const box = card?.querySelector('.phbox.photo'); if (!gal || !box) return null;
  const ci = slideIdx(box.querySelector('.slides')), gi = slideIdx(gal.querySelector('.slides'));
  return ci === gi ? {gal, box, cimg: box.querySelectorAll('img')[ci], gimg: gal.querySelectorAll('img')[gi]} : null;
}
function heroOpen(card) {
  if (!motionOK() || !('popover' in HTMLElement.prototype) || !card.classList.contains('card')) return;
  const h = heroPair(); if (!h || !h.cimg?.complete || !h.cimg.naturalWidth) return;
  const dw = $('drawer'); dw.classList.add('hero');
  const to = heroBox(h.gal, h.gimg, h.cimg), src = h.cimg.currentSrc || h.cimg.src;
  h.gimg.style.backgroundImage = `url("${src}")`; h.gimg.style.backgroundPosition = 'center'; h.gimg.style.backgroundRepeat = 'no-repeat'; h.gimg.style.backgroundSize = to.fit;   // 大圖還沒載完時先墊縮圖
  h.gal.style.visibility = 'hidden';
  heroFly(src, h.box.getBoundingClientRect(), to.rect, '12px', to.radius)
    .then(() => { h.gal.style.visibility = ''; });
}
function heroClose() {
  const dw = $('drawer'); dw.classList.remove('hero');
  if (!motionOK() || !('popover' in HTMLElement.prototype) || dw.scrollTop > 40 || document.querySelector('dialog[open]:not(#drawer)')) return;
  const h = heroPair(); if (!h) return;
  const to = h.box.getBoundingClientRect(); if (to.top < 0 || to.bottom > innerHeight || !to.width) return;
  const from = heroBox(h.gal, h.gimg, h.gimg.naturalWidth ? h.gimg : h.cimg);
  dw.classList.add('hero'); h.gal.style.visibility = 'hidden';
  heroFly(h.gimg.complete && h.gimg.naturalWidth ? h.gimg.currentSrc || h.gimg.src : h.cimg.src, from.rect, to, from.radius, '12px');
}
function wireMotion() {
  // 從這個元素往上到 stop 為止，有沒有已經往下捲的區塊（有的話手指往下是在捲內容，不是拖視窗）
  const scrolled = (el, stop) => { for (; el && el !== stop.parentElement; el = el.parentElement) if (el.scrollTop > 0) return true; return false; };
  const ptr = document.createElement('div'); ptr.className = 'ptr'; ptr.setAttribute('aria-hidden', 'true'); ptr.innerHTML = '<i></i>'; document.body.append(ptr);
  let g = null;   // 進行中的手勢：{kind:'sheet'|'ptr', el, x, y, t, on, dy}
  document.addEventListener('touchstart', e => {
    g = null; if (e.touches.length !== 1) return;
    const t = e.target, p = e.touches[0], dlg = t.closest?.('dialog[open]');
    if (!t.closest || t.closest('input,textarea,select,#pgrid,#bnav,[data-nodrag]')) return;
    if (dlg) {
      // 視窗往下滑關閉：手機直放的底部視窗、iPad 與電腦（觸控螢幕）的中間視窗；從頂端橫槓／標題列拖，或內容已在最上面時往下拖。
      // iPad 與電腦的詳細資料在右側，改成往右滑關閉（照片輪播上不算，那是在換照片）
      const tablet = matchMedia('(min-width:761px)').matches && !matchMedia(PHL_MQ).matches;
      if ((!tablet && !matchMedia(PHONE_MQ).matches) || isClosing(dlg)) return;
      const r = dlg.getBoundingClientRect(), off = p.clientY - r.top;
      if (off < 0 || p.clientY > r.bottom || p.clientX < r.left || p.clientX > r.right) return;   // 點在視窗外的暗色區
      const base = {kind: 'sheet', el: dlg, x: p.clientX, y: p.clientY, t: e.timeStamp, on: false, dy: 0};
      if (tablet && dlg.id === 'drawer') { if (!t.closest('.slides')) g = {...base, axis: 'x'}; return; }
      const top = off < 56 || !!t.closest('.dh');
      if (top || !scrolled(t, dlg)) g = base;
    } else if (S.data && !S.ptrBusy && scrollY <= 0 && !scrolled(t, document.body)) {
      g = {kind: 'ptr', x: p.clientX, y: p.clientY, on: false, dy: 0};   // 在最上面往下拉：立即同步
    }
  }, {passive: true});
  document.addEventListener('touchmove', e => {
    if (!g) return;
    const p = e.touches[0], horiz = g.axis === 'x', dx = p.clientX - g.x, dy = p.clientY - g.y, main = horiz ? dx : dy, cross = horiz ? dy : dx;
    if (!g.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (main <= 0 || main < Math.abs(cross) * 1.3) { g = null; return; }
      g.on = true; g.x = p.clientX; g.y = p.clientY; g.t = e.timeStamp; if (g.kind === 'ptr') ptr.classList.add('show');
      return;
    }
    if (e.cancelable) e.preventDefault();
    g.dy = Math.max(0, main);   // 沿著關閉方向拖了多遠
    if (g.kind === 'sheet') { g.el.style.transition = 'none'; g.el.style.transform = `translate${horiz ? 'X' : 'Y'}(${g.dy}px)`; if (g.el.classList.contains('has-nav')) { const nv = $('bnav'); nv.style.transition = 'none'; nv.style.transform = `translate${horiz ? 'X' : 'Y'}(${-g.dy}px)`; } }
    else { const y = Math.min(96, g.dy * .5); ptr.style.transform = `translate(-50%,${y}px)`; ptr.firstChild.style.transform = `rotate(${y * 3.6}deg)`; ptr.classList.toggle('ready', y >= 64); }
  }, {passive: false});
  const end = e => {
    const cur = g; g = null; if (!cur || !cur.on) return;
    if (cur.kind === 'ptr') {
      const go = e.type === 'touchend' && cur.dy * .5 >= 64;
      ptr.style.transform = ''; ptr.firstChild.style.transform = ''; ptr.classList.remove('ready');
      if (!go) { ptr.classList.remove('show'); return; }
      ptr.classList.add('busy'); S.ptrBusy = true;
      syncNow().finally(() => { S.ptrBusy = false; ptr.classList.remove('show', 'busy'); });
      return;
    }
    const el = cur.el, v = cur.dy / Math.max(1, e.timeStamp - cur.t), close = e.type === 'touchend' && (cur.dy > 110 || (cur.dy > 36 && v > .6));
    const nv = el.classList.contains('has-nav') ? $('bnav') : null;
    const reset = () => { el.style.transition = ''; el.style.transform = ''; if (nv) { nv.style.transition = ''; nv.style.transform = ''; } };
    if (!close) { el.style.transition = 'transform .2s ease-out'; el.style.transform = ''; if (nv) { nv.style.transition = 'transform .2s ease-out'; nv.style.transform = ''; } setTimeout(reset, 220); return; }
    if (nv) navOut();
    const ax = cur.axis === 'x' ? 'X' : 'Y', far = ax === 'X' ? '110%' : `${innerHeight}px`;
    const a = el.animate([{transform: `translate${ax}(${cur.dy}px)`}, {transform: `translate${ax}(${far})`}], {duration: 170, easing: 'ease-in', fill: 'forwards'});
    const done = () => { if (el.open) dlgClose.call(el); el.classList.remove('hero'); a.cancel(); reset(); };
    a.finished.then(done, done);
  };
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  // 視窗都關掉後，補播剛才被蓋住的酒櫃與瓶數變化
  document.addEventListener('close', () => {
    if ((!S.mapPending && !S.numPending) || mapCovered()) return;
    if (S.mapPending) { S.mapPending = false; renderMap(active()); }
    if (S.numPending) { S.numPending = false; replay($('sumBottles'), 'bump'); }
  }, true);
}

/* ---------- 事件 ---------- */
function wire() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('search').addEventListener('input', e => { S.search = e.target.value; render(); });
  $('search').setAttribute('enterkeyhint', 'search');
  $('search').addEventListener('keydown', e => { if (e.key === 'Enter' && searching()) { e.preventDefault(); $('search').blur(); } });   // 按「搜尋」收起鍵盤看結果
  $('sbExit').addEventListener('click', () => exitSearch(true));
  matchMedia(PHONE_MQ + ', ' + TABLET_MQ).addEventListener('change', e => { if (!e.matches) exitSearch(false); });
  $('clearSearch').addEventListener('click', () => { S.search = ''; $('search').value = ''; render(); });
  $('clearFilter').addEventListener('click', () => { S.filter = null; render(); });
  $('factWines').addEventListener('click', openKinds);
  $('factOrigins').addEventListener('click', openOrigins);
  $('factJournal').addEventListener('click', () => { showDialog('journalView'); renderHistory(); });
  $('jTabs').addEventListener('click', e => { const b = e.target.closest('[data-jt]'); if (b) switchJTab(b.dataset.jt); });
  const chipGroup = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fn(b); renderJTab(); } });
  chipGroup('js_type', b => { S.js.type = b.dataset.v; });
  chipGroup('js_when', b => { if (b.hasAttribute('data-hi')) S.js.hi = !S.js.hi; else S.js.when = b.dataset.v; });
  chipGroup('jm_group', b => { S.jm.group = b.dataset.v; renderMem(); });
  $('js_q').addEventListener('input', e => { S.js.q = e.target.value; renderJSearch(); });
  $('jm_q').addEventListener('input', e => { S.jm.q = e.target.value; renderMem(); });
  $('js_clear').addEventListener('click', () => { $('js_q').value = S.js.q = ''; renderJSearch(); });
  $('jm_clear').addEventListener('click', () => { $('jm_q').value = S.jm.q = ''; renderMem(); });
  for (const id of ['js_list', 'jm_list']) {
    $(id).addEventListener('click', e => { const m = e.target.closest('[data-mem]'); if (m) openMem(m.dataset.mem); });
    onKeyActivate($(id), '[data-mem]', m => openMem(m.dataset.mem));
  }
  $('memBody').addEventListener('click', e => {
    if (galleryNav(e)) return;
    const rb = e.target.closest('[data-rebuy]'); if (rb) return rebuy(rb.dataset.rebuy);
    const op = e.target.closest('[data-memopen]'); if (op) { $('memModal').close(); openDrawer(op.dataset.memopen); }
  });
  for (const id of ['f_vintage', 'f_wineName', 'f_wineryRegion']) $(id).addEventListener('input', renderRebuyNote);
  $('kindList').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    exitSearch(false);
    S.filter = b.dataset.kind ? {kind: b.dataset.kind} : null; S.search = ''; $('search').value = '';
    $('kindModal').close(); closeDrawer(); render(); toLedger();
  });
  $('originList').addEventListener('click', e => {
    const b = e.target.closest('[data-origin]'); if (!b) return;
    exitSearch(false);
    S.filter = b.dataset.origin ? {origin: b.dataset.origin} : null; S.search = ''; $('search').value = '';
    $('originModal').close(); render(); toLedger();
  });
  $('sortSel').addEventListener('change', e => { S.sort = e.target.value; try { localStorage.setItem('cellarSort', S.sort); } catch {} render(); });
  $('reloadBtn').addEventListener('click', syncNow);
  wireMotion();
  $('viewList').addEventListener('click', () => setView('list'));
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('homeLink').addEventListener('click', e => { e.preventDefault(); exitSearch(false); S.filter = null; S.search = ''; $('search').value = ''; closeDrawer(); scrollTo({top: 0, behavior: 'smooth'}); render(); });
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
    if (n === 'search') return enterSearch();
    // 底部列在「日誌、待入櫃、管理」視窗裡時：按同一個不動作；按「酒窖」關掉所有視窗；按別的就先關掉目前這個再切換
    const cur = b.closest('dialog.has-nav');
    if (cur) {
      if (NAV_DLG[cur.id] === n) return;
      // 切換時舊視窗直接消失（不播往下收的動畫），新視窗淡入，像換分頁
      if (n === 'home') document.querySelectorAll('dialog[open]').forEach(d => d.close());
      else { if (!Object.values(NAV_DLG).includes(n)) navOut(); S.swapFrom = cur; }
    }
    if (n === 'home') { S.filter = null; S.cabOpen = null; S.search = ''; if ($('search')) $('search').value = ''; render(); window.scrollTo({top: 0, behavior: 'smooth'}); }
    else if (n === 'journal') { if (S.session) $('factJournal').click(); }
    else if (n === 'add') { if (canEdit()) openWineForm(null); }
    else if (n === 'pend') $('factPend').click();
    else if (n === 'admin') openAdmin();
    else if (n === 'login') $('loginBtn').click();
    S.swapFrom = null;
  };
  matchMedia(DESK_MQ).addEventListener('change', () => render());
  matchMedia(PHONE_MQ + ', ' + TABLET_MQ).addEventListener('change', () => { if (!navWanted()) navOut(); });
  $('bnav').addEventListener('click', onNav); $('tnav').addEventListener('click', onNav);
  // 右下角快速按鈕：點了往上展開「新增酒款」「待入櫃」；選一個就照底部列原本的動作做
  $('qaBtn').addEventListener('click', e => { e.stopPropagation(); const o = !$('qa').classList.contains('open'); $('qa').classList.toggle('open', o); $('qaBtn').setAttribute('aria-expanded', o); });
  $('qa').addEventListener('click', e => { const b = e.target.closest('[data-qa]'); if (!b) return; qaClose(); $(b.dataset.qa === 'add' ? 'bnAdd' : 'bnPend').click(); });
  // 選單開著時點其他地方：只收起選單，不觸發底下的東西（例如不會誤開酒款）
  document.addEventListener('click', e => { if ($('qa').classList.contains('open') && !e.target.closest('#qa')) { e.preventDefault(); e.stopPropagation(); qaClose(); } }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('qa').classList.contains('open')) qaClose(); });
  $('admBack').addEventListener('click', adminMenu);
  matchMedia('(min-width: 761px), ' + PHL_MQ).addEventListener('change', () => { if (!$('adminModal').open) return; const cur = ADMIN_TABS.find(t => !$('tab-' + t).hidden); if (admWide()) switchTab(cur || 'lib'); else if (cur) switchTab(cur); });
  $('factPend').addEventListener('click', () => { showDialog('pendModal'); showErr('pendErr', ''); renderPendStrip(); renderPending(); });
  $('exportBtn').addEventListener('click', exportCsv);
  $('migBtn').addEventListener('click', migratePhotos);
  $('exportXlsxBtn').addEventListener('click', exportXlsx);
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
    if (S.filter && matchMedia(TABLET_MQ).matches ? !matchMedia(SPLIT_MQ).matches : S.filter && matchMedia(PHONE_MQ).matches) document.querySelector('.ledger').scrollIntoView({behavior: 'smooth'});
  });
  $('list').addEventListener('click', e => {
    const m = e.target.closest('[data-mem]'); if (m) return openMem(m.dataset.mem);
    const o = e.target.closest('[data-open]'); if (!o) return;
    openDrawer(o.dataset.open, false, o);
  });
  onKeyActivate($('list'), 'div[data-open]', o => openDrawer(o.dataset.open));
  onKeyActivate($('list'), 'div[data-mem]', o => openMem(o.dataset.mem));
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
    if (galleryNav(e)) return;
    const ph = e.target.closest('[data-photo]'); if (ph) return openPhoto(byId(ph.dataset.photo));
    const dl = e.target.closest('[data-delwine]'); if (dl) { if (!confirmTap(dl, '再按一次確定刪除')) deleteWine(dl.dataset.delwine); return; }
    const lg = e.target.closest('[data-log]'); if (lg) { showDialog('adminModal'); switchTab('audit', true); loadAudit(lg.dataset.log, 1); checkStorage(); }
  });
  $('f_volumeChoice').addEventListener('change', e => { $('f_volumeOther').hidden = e.target.value !== '__other__'; });
  $('f_originChoice').addEventListener('change', e => { const o = e.target.value === '__other__'; $('f_originOther').hidden = !o; if (o) $('f_originOther').focus(); });
  $('f_sourceChoice').addEventListener('change', e => { $('f_sourceOther').hidden = e.target.value !== '__other__'; });
  $('addLoc').addEventListener('click', () => addLocRow());
  $('copyWineBtn').addEventListener('click', copyWine);
  $('locInputs').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.loc-ed').remove(); });
  for (const id of ['f_camera', 'f_gallery']) $(id).addEventListener('change', async e => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - S.pendKeep.length - S.newPhotos.length); e.target.value = '';
    showErr('wineErr', '');
    await compressEach(files, 'wineErr', ph => { S.newPhotos.push(ph); });
    renderNewStrip();
  });
  $('f_strip').addEventListener('click', e => {
    const b = e.target.closest('[data-nrm]'); if (b) { S.newPhotos.splice(Number(b.dataset.nrm), 1); renderNewStrip(); }
    const k = e.target.closest('[data-krm]'); if (k) { S.pendKeep.splice(Number(k.dataset.krm), 1); renderNewStrip(); }
  });
  for (const id of ['q_camera', 'q_gallery']) $(id).addEventListener('change', async e => {
    const files = [...e.target.files], room = MAX_PHOTOS - S.pendNew.length; e.target.value = '';
    showErr('pendErr', files.length > room ? `每瓶最多 ${MAX_PHOTOS} 張，只加入前 ${room} 張。` : '');
    await compressEach(files.slice(0, room), 'pendErr', ph => { S.pendNew.push(ph); renderPendStrip(); });
    renderPendStrip();
  });
  $('q_strip').addEventListener('click', e => { const b = e.target.closest('[data-qrm]'); if (b) { S.pendNew.splice(Number(b.dataset.qrm), 1); renderPendStrip(); } });
  $('q_save').addEventListener('click', savePending);
  $('q_qtyRow').addEventListener('click', e => { const b = e.target.closest('[data-qd]'); if (!b) return; S.pendQty = Math.max(1, (S.pendQty || 1) + Number(b.dataset.qd)); renderPendStrip(); });
  $('pendList').addEventListener('click', e => {
    const ed = e.target.closest('[data-pedit]'); if (ed) return editPending(ed.dataset.pedit);
    const d = e.target.closest('[data-pdelq]'); if (d) return deletePending(d);
    const rm = e.target.closest('[data-pprm]'); if (rm) return removePendPhoto(rm.closest('[data-pid]').dataset.pid, rm.dataset.pprm);
    const qd = e.target.closest('[data-pqd]'); if (qd) return setPendQty(qd.closest('[data-pid]').dataset.pid, Number(qd.dataset.pqd));
  });
  onSubmit('aiForm', 'aiErr', saveAiSettings);
  $('ai_provider').addEventListener('change', () => { $('ai_modelBox').hidden = true; $('ai_key').value = ''; showErr('aiErr', ''); });
  $('ai_model').addEventListener('change', () => { const c = getAI(); if (c) { c.model = $('ai_model').value; setAI(c); setAIPref({provider: c.provider, model: c.model}); renderAiSettings(); } });
  $('aiRemove').addEventListener('click', () => { if (!confirm('移除這台裝置上的 AI 金鑰？「智慧辨識」按鈕會隱藏。')) return; setAI(null); renderAiSettings(); toast('已移除 AI 金鑰。'); });
  $('aiBtn').addEventListener('click', aiRecognize);
  setTimeout(() => { sweepAI(); scheduleAiExpiry(); });  // 等整個程式載入完再執行
  const keepHint = () => { $('keepHint').hidden = !/留存紀念/.test($('f_grapeNotes').value); };
  $('f_grapeNotes').addEventListener('input', keepHint); $('wineModal').addEventListener('keepcheck', keepHint);
  for (const id of ['f_wineName', 'f_wineryRegion', 'f_vintage', 'f_originChoice', 'f_originOther', 'f_grapeNotes', 'f_volumeChoice', 'f_volumeOther']) $(id).addEventListener('input', e => e.target.classList.remove('ai-filled', 'ai-guess'));
  $('pendList').addEventListener('change', e => {
    const inp = e.target.closest('[data-padd]'); if (!inp) return;
    const files = [...inp.files]; inp.value = ''; addPendPhotos(inp.closest('[data-pid]').dataset.pid, files);
  });
  $('p_camera').addEventListener('change', e => addPhotos(e.target.files));
  $('p_gallery').addEventListener('change', e => addPhotos(e.target.files));
  setupPhotoDrag();
  $('pgrid').addEventListener('click', e => { const c = e.target.closest('[data-pcover]'); if (c) return coverPhoto(c.dataset.pcover); const d = e.target.closest('[data-pdel]'); if (d) return deletePhoto(d); });
  onSubmit('loginForm', 'loginErr', doLogin);
  onSubmit('setupForm', 'setupErr', doSetup);
  onSubmit('wineForm', 'wineErr', saveWine);
  onSubmit('stockForm', 'stockErr', saveStock);
  onSubmit('moveForm', 'moveErr', saveMove);
  document.querySelectorAll('input[name=s_type]').forEach(r => r.addEventListener('change', () => { $('s_reasonLbl').textContent = r.value === '其他' ? '說明 *' : '說明（選填）'; }));
  onSubmit('locForm', 'locErr', saveCatalog);
  onSubmit('capForm', 'capErr', saveCapacity);
  onSubmit('slotForm', 'keysErr', addSlot);
  onSubmit('tokenForm', 'keysErr', changeToken);
  $('moreAudit').addEventListener('click', () => loadAudit(S.auditWine, S.auditPage + 1));
  $('cabChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b && !confirmTap(b, '確定刪除？')) removeCatalog('cabinets', b.dataset.rm); });
  $('shelfChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeCatalog('shelves', b.dataset.rm); });
  $('locDelList').addEventListener('click', e => {
    const c = e.target.closest('[data-delcab]'); if (c && !c.disabled) { if (!confirmTap(c, '確定刪除整櫃？')) deleteLoc(c.dataset.delcab, ''); return; }
    const s = e.target.closest('[data-delsh]'); if (s && !s.disabled && !confirmTap(s, '確定？')) deleteLoc(s.dataset.cab, s.dataset.delsh);
  });
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
  onSubmit('journalForm', 'journalErr', saveJournal);
  document.querySelectorAll('input[name=j_src]').forEach(r => r.addEventListener('change', () => { S.jf = {src: '', cab: '', shelf: '', wineId: '', miss: false}; showErr('journalErr', ''); syncJournalForm(); }));
  $('j_pick').addEventListener('click', journalPick);
  onKeyActivate($('j_pick'), '[data-jview]', v => openViewer(v.dataset.jview));
  $('viewerBody').addEventListener('click', galleryNav); $('j_path').addEventListener('click', journalPick);
  $('j_missBtn').addEventListener('click', startMissing);
  $('j_left').addEventListener('input', syncJournalForm);
  $('j_stars').querySelectorAll('button').forEach((b, i) => b.style.setProperty('--i', i));
  $('j_stars').addEventListener('click', e => { const b = e.target.closest('[data-jstar]'); if (b) { const n = Number(b.dataset.jstar); S.jRating = S.jRating === n ? 0 : n; syncJournalForm(); starPop($('j_stars')); } });
  // 星星評分：滑鼠滑過時從左到右一顆一顆亮起、微微放大；移開恢復（手指點選時改用 starPop 依序跳一下）
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const b = e.target.closest?.('.stars button'); if (!b) return;
    const g = b.parentElement, btns = [...g.querySelectorAll('button')], n = btns.indexOf(b), prev = Number(g.dataset.hot ?? -1);
    btns.forEach((x, i) => { const on = i <= n; x.style.transitionDelay = on && i > prev ? `${(i - Math.max(prev, -1) - 1) * 45}ms` : '0ms'; x.classList.toggle('hot', on); });
    g.dataset.hot = n;
  });
  document.addEventListener('pointerout', e => {
    const g = e.target.closest?.('.stars'); if (!g || g.contains(e.relatedTarget)) return;
    g.querySelectorAll('button').forEach(x => { x.style.transitionDelay = '0ms'; x.classList.remove('hot'); });
    delete g.dataset.hot;
  });
  for (const id of ['j_camera', 'j_gallery']) $(id).addEventListener('change', e => pickPhoto(e.target.files[0], 'j_preview', b => S.jPhoto = b, 'journalErr'));
  $('h_year').addEventListener('change', e => { S.histYear = e.target.value; renderHistory(); });
  $('h_types').addEventListener('click', e => { const b = e.target.closest('[data-htype]'); if (b) { S.histType = b.dataset.htype; renderHistory(); } });
  $('slotList').addEventListener('click', e => { const b = e.target.closest('[data-delslot]'); if (b) deleteSlot(b); });
  $('slotList').addEventListener('change', e => { const r = e.target.closest('[data-roleslot]'); if (r) changeRole(r); });
}
function toLedger() { document.querySelector('.ledger').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); }
// 點總覽的「酒款」：依酒種分類（紅酒、白酒、甜酒／貴腐、清酒），點一種只看那一種
function openKinds() {
  const g = Object.fromEntries(KIND_IDS.map(k => [k, {wines: 0, bottles: 0}]));
  for (const w of active()) { const x = g[kindOf(w)]; x.wines++; x.bottles += total(w); }
  const cur = S.filter?.kind;
  $('kindList').innerHTML = `<button class="origin ${cur ? '' : 'on'}" data-kind=""><b>全部酒種</b><span>${active().length} 款</span><span>${active().reduce((a, w) => a + total(w), 0)} 瓶</span></button>` +
    KINDS.map(([k, n]) => `<button class="origin kind-${k} ${cur === k ? 'on' : ''}" data-kind="${k}"><b><i class="kdot"></i>${n}</b><span>${g[k].wines} 款</span><span>${g[k].bottles} 瓶</span></button>`).join('');
  showDialog('kindModal');
}
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
// 這個身分看得到哪些管理分頁：使用者只有搜尋與自己的紀錄；裝置密碼只有工程人員
const tabOK = t => !S.session ? false : S.session.role === 'user' ? ['lib', 'outs', 'audit'].includes(t) : t !== 'keys' || isEng();
function admMenuShow() {
  document.querySelectorAll('#admMenu [data-tab]').forEach(b => { b.hidden = !tabOK(b.dataset.tab); });
  document.querySelectorAll('#admMenu .adm-grp').forEach(g => { g.hidden = !g.querySelector('.mi:not([hidden])'); });
  const own = S.session?.role === 'user';
  document.querySelector('#admMenu [data-tab=lib] small').textContent = own ? '所有登錄過的酒・飲用紀錄' : '所有登錄過的酒・飲用紀錄・再買一次';
  document.querySelector('#admMenu [data-tab=outs] small').textContent = own ? '你自己記的出庫' : '自飲、聚餐、送禮與已出清的酒';
  document.querySelector('#admMenu [data-tab=audit] small').textContent = own ? '你自己做過的異動' : '誰在什麼時候改了什麼';
}
const admWide = () => matchMedia('(min-width: 761px), ' + PHL_MQ).matches;
function adminMenu() {  // 手機：回到分組清單
  $('admBody').dataset.view = 'menu'; $('adminTitle').textContent = '管理'; $('admBack').hidden = true;
  admMenuShow();
  document.querySelectorAll('#admMenu [data-tab]').forEach(b => b.classList.remove('on'));
}
function openAdmin(name) {
  showDialog('adminModal');
  if (name || admWide()) switchTab(name || 'lib'); else adminMenu();
  checkStorage();
}
function switchTab(name, noLoad) {
  if (!tabOK(name)) name = 'lib';
  admMenuShow();
  document.querySelectorAll('#admMenu [data-tab]').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  for (const t of ADMIN_TABS) $('tab-' + t).hidden = t !== name;
  $('admBody').dataset.view = 'page'; $('admBack').hidden = admWide();
  const label = document.querySelector(`#admMenu [data-tab="${name}"] b`)?.textContent || '';
  $('adminTitle').textContent = admWide() ? (label ? `管理 › ${label}` : '管理') : label || '管理';
  $('admMain').scrollTop = 0;
  if (name === 'loc') renderAdmin();
  if (name === 'outs') renderHistory();
  if (name === 'keys') renderSlots();
  if (name === 'ai') renderAiSettings();
  if (name === 'storage') $('migBox').hidden = !(PB && isEng());
  if (name === 'lib') renderMem();
  if (name === 'audit' && !noLoad) loadAudit('', 1);
}

/* ---------- 登入與初始設定 ---------- */
function openLogin() {
  let last = ''; try { last = localStorage.getItem('cellarSlot') || ''; } catch {}
  const sel = $('g_slot');
  sel.innerHTML = (S.keys?.slots || []).map(s => `<option value="${esc(s.id)}">${esc(s.label)}（${roleName(s.role)}）</option>`).join('');
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
  const sel = s => `<select class="rolesel ${s.role === 'admin' ? 'admin' : s.role === 'user' ? 'user' : ''}" data-roleslot="${esc(s.id)}" aria-label="${esc(s.label)} 的身分">${Object.entries(ROLE_NAMES).map(([k, n]) => `<option value="${k}" ${k === (ROLE_NAMES[s.role] ? s.role : 'editor') ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  $('slotList').innerHTML = slots.map(s => `<div class="slot"><span><b>${esc(s.label)}</b>${isEng() ? sel(s) : `<span class="role ${s.role === 'admin' ? 'admin' : s.role === 'user' ? 'user' : ''}">${roleName(s.role)}</span>`}${s.id === S.session?.slotId ? ' <span class="hint">（目前這台）</span>' : ''}<br><span class="hint">建立於 ${fmtTime(s.createdAt)}${s.roleAt ? `・${fmtTime(s.roleAt)} 改為${roleName(s.role)}` : ''}</span></span><button class="small danger" data-delslot="${esc(s.id)}">刪除</button></div>`).join('') || '<p class="hint">沒有裝置。</p>';
}
async function addSlot() {
  if (!isEng()) fail('只有工程人員可以新增人員。');
  const label = $('k_label').value.trim(), role = $('k_role').value, pass = $('k_pass').value;
  if (!ROLE_NAMES[role]) fail('請選擇身分。');
  if (!label) fail('請填寫裝置名稱。');
  checkPass(pass);
  await loadKeys();
  if (S.keys.slots.some(s => s.label === label)) fail('已有同名裝置，請換個名稱。');
  const keys = structuredClone(S.keys);
  keys.slots.push(await makeSlot(label, role, pass, b64d(S.session.dataKey)));
  await saveKeys(keys, `新增裝置 ${label}（${roleName(role)}）`);
  $('k_label').value = ''; $('k_pass').value = ''; renderSlots();
  toast(`已新增 ${label}。請把密碼告訴使用那台裝置的人。`);
}
async function changeRole(sel) {
  if (!isEng()) return;
  const id = sel.dataset.roleslot, role = sel.value, cur = S.keys?.slots?.find(x => x.id === id);
  if (!cur || !ROLE_NAMES[role] || cur.role === role) return renderSlots();
  const self = id === S.session.slotId;
  if (!confirm(`把「${cur.label}」從「${roleName(cur.role)}」改成「${roleName(role)}」？${self && role !== 'admin' ? '\n\n這是你自己這台，改完後你就不能再管理裝置密碼。' : ''}`)) return renderSlots();
  showErr('keysErr', ''); sel.disabled = true;
  try {
    await loadKeys();
    const target = S.keys.slots.find(x => x.id === id); if (!target) fail('這台裝置已被刪除。');
    if (target.role === role) return renderSlots();
    if (target.role === 'admin' && role !== 'admin' && S.keys.slots.filter(x => x.role === 'admin').length <= 1) fail('至少要留一位工程人員。');
    const keys = structuredClone(S.keys), t = keys.slots.find(x => x.id === id), old = t.role;
    t.role = role; t.roleAt = now();
    await saveKeys(keys, `變更身分 ${t.label}：${roleName(old)} → ${roleName(role)}`);
    toast(`已把「${t.label}」改成「${roleName(role)}」。${self ? '' : '那台裝置下次開啟或一分鐘內會自動套用。'}`);
    if (self) syncSlot(); else renderSlots();
  } catch (e) { showErr('keysErr', msgOf(e)); renderSlots(); }
}
async function deleteSlot(btn) {
  if (!isEng()) return;
  if (armDelete(btn)) return;
  showErr('keysErr', '');
  try {
    await loadKeys();
    const target = S.keys.slots.find(s => s.id === btn.dataset.delslot); if (!target) return renderSlots();
    if (target.role === 'admin' && S.keys.slots.filter(s => s.role === 'admin').length <= 1) fail('不能刪除最後一位工程人員。');
    const keys = structuredClone(S.keys); keys.slots = keys.slots.filter(s => s.id !== target.id);
    await saveKeys(keys, '刪除裝置 ' + target.label);
    renderSlots(); toast(`已刪除 ${target.label}。如果那台裝置遺失，建議也更換 GitHub 權杖。`);
    if (target.id === S.session.slotId) logout();
  } catch (e) { showErr('keysErr', msgOf(e)); }
}
async function changeToken() {
  if (!isEng()) fail('只有工程人員可以更換權杖。');
  const token = $('t_token').value.trim(); if (!token) fail('請貼上新權杖。');
  await checkToken(token);
  await loadKeys();
  const keys = structuredClone(S.keys);
  keys.token = await seal(await aesKey(b64d(S.session.dataKey)), enc.encode(token));
  await saveKeys(keys, '更換 GitHub 權杖', token);
  const remember = remembered();
  saveSession({...S.session, token}, remember);
  $('t_token').value = '';
  toast('已更換權杖。舊權杖可以在 GitHub 刪除了。');
}

/* ---------- 新增／編輯酒款 ---------- */
/* 刪掉的櫃位／層位記在 catalog.removed（[{cabinet, shelf}]，shelf 空白＝整櫃）：出庫、移動的歷史裡還有這些名字，
   但選單與空位設定不再列出；之後若又有酒放進去，就會再出現 */
const isRemoved = (cab, sh) => (S.data?.catalog?.removed || []).some(r => r.cabinet === cab && (!r.shelf || r.shelf === sh));
const hasBottles = (cab, sh) => active().some(w => (w.locations || []).some(l => l.cabinet === cab && (!sh || l.shelf === sh) && l.quantity > 0));
function locOptions(kind) {
  const names = new Set(S.data?.catalog?.[kind] || []); for (const w of wines()) for (const l of w.locations || []) names.add(kind === 'cabinets' ? l.cabinet : l.shelf);
  return [...names].filter(n => n && (kind !== 'cabinets' || !isRemoved(n, '') || hasBottles(n, ''))).sort();
}
/* 櫃位／層位一律用下拉選單：選項來自「管理 → 櫃位／層位」與目前資料裡用過的名稱 */
const byShelf = (a, b) => shelfNo(a) - shelfNo(b) || a.localeCompare(b);
function shelvesOf(cab) {  // 這個櫃子用過的層位（含已出清、出庫與移動紀錄）
  const set = new Set();
  for (const w of wines()) {
    for (const l of w.locations || []) if (l.cabinet === cab && l.shelf) set.add(l.shelf);
    for (const o of w.outs || []) if (o.cabinet === cab && o.shelf) set.add(o.shelf);
    for (const m of w.moves || []) for (const x of [m.from, m.to]) if (x?.cabinet === cab && x.shelf) set.add(x.shelf);
  }
  return [...set].filter(sh => !isRemoved(cab, sh) || hasBottles(cab, sh)).sort(byShelf);
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
/* 產地：下拉選單，選項是資料裡用過的國家，款數多的排上面；最下面「其他」可自行輸入。
   舊資料若不是選單裡的名稱（例如「France,Bdx」），就顯示在「其他」欄位原樣保留 */
function originOptions() {
  const c = new Map(); for (const w of wines()) { const o = countryOf(w); if (o !== '未填產地') c.set(o, (c.get(o) || 0) + 1); }
  return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o]) => o);
}
function fillOrigin(v) {
  v = (v || '').trim();
  const opts = originOptions(), sel = $('f_originChoice'), std = !v || opts.includes(v);
  sel.innerHTML = `<option value="">請選擇產地</option>` + opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('') + '<option value="__other__">其他（自行輸入）</option>';
  sel.value = std ? v : '__other__'; $('f_originOther').hidden = std; $('f_originOther').value = std ? '' : v;
}
const readOrigin = () => ($('f_originChoice').value === '__other__' ? $('f_originOther').value : $('f_originChoice').value).trim();
const originEl = () => $('f_originOther').hidden ? $('f_originChoice') : $('f_originOther');
function setChoice(selId, otherId, value, fallback) {
  const v = value || fallback, sel = $(selId);
  const std = [...sel.options].some(o => o.value === v && o.value !== '__other__');
  sel.value = std ? v : '__other__'; $(otherId).hidden = std; $(otherId).value = std ? '' : v;
}
function renderNewStrip() {
  const el = $('f_strip'); if (!el) return;
  const keep = S.pendKeep || [], n = keep.length;
  el.innerHTML = keep.map((ph, i) => thumbHtml(esc(fileUrl(ph.thumb || ph.photo)), i, `data-krm="${i}"`)).join('')
    + (S.newPhotos || []).map((ph, i) => thumbHtml(URL.createObjectURL(ph.thumb), n + i, `data-nrm="${i}"`)).join('');
  const full = n + (S.newPhotos || []).length >= MAX_PHOTOS;
  document.querySelectorAll('#newPhotoField .photo-in label').forEach(l => l.hidden = full);
  renderAiRow();
}
function openWineForm(w, pend, rb) {
  if (!canEdit()) return;
  document.querySelectorAll('#wineForm .ai-filled, #wineForm .ai-guess').forEach(el => el.classList.remove('ai-filled', 'ai-guess'));
  $('aiMsg').textContent = '';
  S.editing = w; S.fromPend = !w && pend || null; S.rebuy = !w && !pend && rb || null;
  S.pendKeep = S.fromPend ? S.fromPend.photos.slice() : S.rebuy ? (S.rebuy.kind === 'cellar' ? photosOf(S.rebuy.w).slice() : S.rebuy.photoRec ? [S.rebuy.photoRec] : []) : [];
  S.newPhotos = []; renderNewStrip(); ensureLists();
  $('wineTitle').textContent = w ? '編輯酒款' : S.fromPend ? '補資料並加入酒櫃' : S.rebuy ? '再買一次' : '新增紅酒';
  for (const [k] of FIELDS) { const el = $('f_' + k); if (el) el.value = w?.[k] ?? ''; }
  setChoice('f_volumeChoice', 'f_volumeOther', w?.volume, '750ml');
  setChoice('f_sourceChoice', 'f_sourceOther', w?.source, '');
  const col = w ? kindOf(w) : 'red';
  document.querySelectorAll('input[name=f_color]').forEach(r => r.checked = r.value === col);
  fillOrigin(w?.origin);
  $('locInputs').replaceChildren(); (w?.locations?.length ? w.locations : [{cabinet: '', shelf: '', quantity: S.fromPend ? pendQty(S.fromPend) : 1}]).forEach(addLocRow);
  $('locHint').hidden = !w; $('locLbl').textContent = w ? '存放位置與瓶數' : '存放位置與初始瓶數';
  $('newPhotoField').hidden = !!w; $('f_camera').value = ''; $('f_gallery').value = '';
  document.querySelectorAll('#wineForm .rb-filled, #wineForm .rb-check').forEach(el => el.classList.remove('rb-filled', 'rb-check'));
  if (S.rebuy) {
    const src = S.rebuy.kind === 'cellar' ? S.rebuy.w : {wineName: S.rebuy.name, vintage: S.rebuy.vintage};
    for (const k of ['wineName', 'wineryRegion', 'vintage', 'drinkWindow', 'grapeNotes', 'referencePrice']) { const el = $('f_' + k); if (el && src[k] != null && src[k] !== '') { el.value = src[k]; el.classList.add('rb-filled'); } }
    if (src.origin) { fillOrigin(src.origin); originEl().classList.add('rb-filled'); }
    if (src.volume) setChoice('f_volumeChoice', 'f_volumeOther', src.volume, '750ml');
    if (src.source) setChoice('f_sourceChoice', 'f_sourceOther', src.source, '');
    if (S.rebuy.kind === 'cellar') { const col = kindOf(src); document.querySelectorAll('input[name=f_color]').forEach(r => r.checked = r.value === col); }
    $('f_entryDate').value = today();
    $('f_vintage').classList.add('rb-check'); document.querySelectorAll('#locInputs select, #locInputs [data-k=quantity]').forEach(el => el.classList.add('rb-check'));
    renderNewStrip();
  }
  renderRebuyNote();
  $('wineModal').dataset.mode = w ? 'edit' : 'new'; $('copyWineBtn').hidden = !w;
  $('wineModal').dispatchEvent(new Event('keepcheck'));
  showDialog('wineModal');
}
function readWineForm() {
  const r = {};
  for (const [k] of FIELDS) { if (k === 'volume' || k === 'source' || k === 'referencePrice' || k === 'origin') continue; r[k] = $('f_' + k).value.trim(); }
  r.origin = ($('f_originChoice').value === '__other__' ? $('f_originOther').value : $('f_originChoice').value).trim();
  r.volume = ($('f_volumeChoice').value === '__other__' ? $('f_volumeOther').value : $('f_volumeChoice').value).trim();
  r.source = ($('f_sourceChoice').value === '__other__' ? $('f_sourceOther').value : $('f_sourceChoice').value).trim();
  const ck = document.querySelector('input[name=f_color]:checked')?.value; r.color = KIND_IDS.includes(ck) ? ck : 'red';
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
      if (kindOf(cur) !== r.color) changes.push(`酒種：${colorName(cur)} → ${kindName(r.color)}`);
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
      const wid = nextWineId(d), t = now();
      d.wines[wid] = {...r, photo, thumb, photos, status: total(r) > 0 ? 'active' : 'archived', createdAt: t, createdBy: who, updatedAt: t, updatedBy: who, revision: 1};
      return wid;
    }, wid => `新增 ${wid} ${r.wineName}${src ? '（由待入櫃加入）' : ''}\n\n位置：${locText(r.locations)}`);
    S.fromPend = null; S.pendKeep = []; S.rebuy = null;
    if (src) { const kept = new Set(photos.map(p => p.photo)), drop = src.photos.filter(p => !kept.has(p.photo)); if (drop.length) deleteFiles(drop.flatMap(p => [p.photo, p.thumb]), id).then(checkStorage); }
    $('wineModal').close(); openDrawer(id); toast('已新增「' + r.wineName + '」。');
  }
}

/* 編輯中按「複製」：用表單上目前的內容開一筆新酒款，除了櫃位與數量以外全部帶過去（照片沿用同一個檔案，不重複上傳） */
function copyWine() {
  const src = S.editing; if (!src || !canEdit()) return;
  const f = $('wineForm'), snap = [...f.querySelectorAll('input:not([type=file]):not([type=radio]), select, textarea')].filter(el => el.id && !el.closest('#locInputs')).map(el => [el.id, el.value]);
  const col = document.querySelector('input[name=f_color]:checked')?.value || kindOf(src), photos = photosOf(src).slice();
  dlgClose.call($('wineModal'));
  openWineForm(null);
  for (const [id, v] of snap) { const el = $(id); if (el) el.value = v; }
  for (const [c, o] of [['f_originChoice', 'f_originOther'], ['f_volumeChoice', 'f_volumeOther'], ['f_sourceChoice', 'f_sourceOther']]) $(o).hidden = $(c).value !== '__other__';
  document.querySelectorAll('input[name=f_color]').forEach(r => r.checked = r.value === col);
  $('f_entryDate').value = today();   // 入庫日期改填今天
  S.pendKeep = photos; renderNewStrip();
  $('wineTitle').textContent = '複製酒款';
  document.querySelectorAll('#locInputs select, #locInputs [data-k=quantity]').forEach(el => el.classList.add('rb-check'));
  $('wineModal').dispatchEvent(new Event('keepcheck'));
  toast('已複製，請選擇櫃位與數量後儲存。');
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
    touch(cur, who, t);
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
  checkDate(date, '出庫');
  if (date < '1990-01-01') fail('出庫日期不正確，請重新選擇。');
  if (!type) fail('請選擇出庫類型：自飲、聚餐、送禮或其他。');
  if (type === '其他' && !reason) fail('選「其他」時請填寫說明。');
  checkQty(qty);
  const res = await mutate(d => takeOut(d, id, {cabinet, shelf, qty, out: {date, type, reason}}, who, '沒有扣除任何瓶數。'),
    x => takeOutMsg(id, x, {type, cabinet, shelf, qty, date, note: reason}));
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
      const cur = wineOf(d, id);
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
  checkQty(qty);
  checkDate(date);
  const res = await mutate(d => {
    const cur = wineOf(d, id);
    const locs = cur.locations || [];
    const src = locs.find(x => x.cabinet === from.cabinet && x.shelf === from.shelf);
    if (!src || src.quantity <= 0) fail('原位置已沒有庫存，請重新整理。');
    if (src.quantity < qty) fail(`原位置只剩 ${src.quantity} 瓶。`);
    src.quantity -= qty;
    let dst = locs.find(x => x.cabinet === to.cabinet && x.shelf === to.shelf);
    if (dst) dst.quantity += qty; else { dst = {cabinet: to.cabinet, shelf: to.shelf, quantity: qty}; locs.push(dst); }
    cur.locations = locs.filter(x => x.quantity > 0 || x === dst);
    const t = touch(cur, who);
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
  let full, thumb;
  if (PB) {   // 照片放 Cloudflare
    full = {ok: (await r2Send('PUT', `${base}.jpg`, ph.full)).ok};
    if (!full.ok) fail('照片上傳失敗，請再試一次。');
    thumb = {ok: (await r2Send('PUT', `${base}-t.jpg`, ph.thumb).catch(() => ({ok: false}))).ok};
  } else {
    full = await putFile(`${base}.jpg`, new Uint8Array(await ph.full.arrayBuffer()), null, `照片 ${id}（${kb(ph.full.size)}）${who}`);
    if (!full.ok) fail('照片上傳失敗，請再試一次。');
    thumb = await putFile(`${base}-t.jpg`, new Uint8Array(await ph.thumb.arrayBuffer()), null, `縮圖 ${id}（${kb(ph.thumb.size)}）${who}`);
  }
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
color: "red"; "white" (rosé and sparkling count as "white"); "sweet" for dessert and botrytis wines (Sauternes, Tokaji Aszú, Beerenauslese, ice wine, Port and other sweet wines); "sake" for Japanese sake (nihonshu); or "unknown";
uncertain: an array of the key names you inferred or could not read clearly.
Use "" for anything you cannot determine. Never invent a producer, name or year.`;
const AI_SCHEMA = {type: 'object', additionalProperties: false, required: [...AI_FIELDS, 'uncertain'],
  properties: {wineName: {type: 'string'}, wineryRegion: {type: 'string'}, vintage: {type: 'string'}, origin: {type: 'string'}, volume: {type: 'string'}, grapeNotes: {type: 'string'},
    color: {type: 'string', enum: [...KIND_IDS, 'unknown']}, uncertain: {type: 'array', items: {type: 'string', enum: AI_FIELDS}}}};
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
  for (const ph of S.pendKeep || []) { try { const r = await fetchPhoto(ph.photo); if (r.ok) blobs.push(await r.blob()); } catch {} }
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
    color: KIND_IDS.includes(o.color) ? o.color : '', uncertain: Array.isArray(o.uncertain) ? o.uncertain.filter(k => AI_FIELDS.includes(k)) : []};
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
    for (const k of ['wineName', 'wineryRegion', 'vintage', 'grapeNotes']) put(k, $('f_' + k));
    if (r.origin && !readOrigin()) {   // 辨識出的國家：選單裡有就選它，沒有就選「其他」並填入
      const hit = [...$('f_originChoice').options].find(o => o.value !== '__other__' && o.value && o.value.toLowerCase() === r.origin.toLowerCase());
      fillOrigin(hit ? hit.value : r.origin); const el = originEl(); el.classList.add('ai-filled'); el.classList.toggle('ai-guess', r.uncertain.includes('origin')); filled.push('origin');
    }
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
  $('q_strip').innerHTML = S.pendNew.map((ph, i) => thumbHtml(URL.createObjectURL(ph.thumb), i, `data-qrm="${i}"`)).join('');
  $('q_add').querySelectorAll('label').forEach(l => l.hidden = n >= MAX_PHOTOS);
  $('q_save').hidden = !n; $('q_save').textContent = S.pendSaving ? '上傳中…' : `存入待入櫃（${n} 張）`;
  $('q_qtyRow').hidden = !n; $('q_qty').textContent = S.pendQty || 1;
}
function renderPending() {
  const list = S.data?.pending || [], n = list.reduce((a, p) => a + pendQty(p), 0);
  $('factPend').hidden = !S.session;
  $('sumPend').innerHTML = `${n} <small>瓶</small>` + (n ? `<span class="pend-mini">${list.filter(p => p.photos?.length).slice(-3).reverse().map(p => `<img src="${esc(fileUrl(p.photos[0].thumb || p.photos[0].photo))}" alt="">`).join('')}</span>` : '');
  if (!$('pendModal').open) return;
  const html = list.length ? list.slice().reverse().map(p => {
    const busy = S.pendAdding === p.id, room = MAX_PHOTOS - p.photos.length, ed = canEdit(), one = p.photos.length < 2 || !ed;
    return `<article class="pend" data-pid="${esc(p.id)}">
    <div class="pend-ph">${p.photos.map((ph, i) => `<span class="pth"><a href="${esc(fileUrl(ph.photo))}" target="_blank" rel="noopener"><img src="${esc(fileUrl(ph.thumb || ph.photo))}" alt="第 ${i + 1} 張" loading="lazy"></a>${i === 0 ? '<em>封面</em>' : ''}${one || busy ? '' : `<button type="button" data-pprm="${esc(ph.photo)}" aria-label="移除第 ${i + 1} 張">×</button>`}</span>`).join('')}</div>
    <div class="pend-add">${busy ? '<span class="hint">上傳中…</span>' : room > 0 && ed ? `<label>📷 加拍<input type="file" accept="image/*" capture="environment" data-padd></label><label>從相簿加入<input type="file" accept="image/*" multiple data-padd></label>` : ''}<span class="hint">${p.photos.length}／${MAX_PHOTOS} 張</span></div>
    <div class="qstep pend-qty"><span>數量</span>${ed && !busy ? `<button type="button" data-pqd="-1" ${pendQty(p) <= 1 ? 'disabled' : ''} aria-label="少一瓶">−</button>` : ''}<b>${pendQty(p)}</b>${ed && !busy ? '<button type="button" data-pqd="1" aria-label="多一瓶">＋</button>' : ''}<span>瓶</span></div>
    <p class="pend-meta">${esc(p.by || '')}・${fmtTime(p.at)}</p>
    ${ed ? `<div class="pend-act"><button type="button" class="primary" data-pedit="${esc(p.id)}" ${busy ? 'disabled' : ''}>編輯並加入酒櫃</button><button type="button" class="danger" data-pdelq="${esc(p.id)}" ${busy ? 'disabled' : ''}>刪除</button></div>` : ''}
  </article>`;
  }).join('') : '<p class="hint pend-empty">目前沒有待入櫃的酒。</p>';
  // 內容沒變就不重畫：避免定時同步把正在開啟的相機／相簿選擇器換掉
  if (html !== S.pendHtml || !$('pendList').firstChild) { S.pendHtml = html; $('pendList').innerHTML = html; }
}
const pendQty = p => Math.max(1, Math.round(Number(p?.qty) || 1));
/* 待入櫃：之後再改數量（管理員） */
async function setPendQty(id, delta) {
  if (!canEdit()) return;
  showErr('pendErr', '');
  try {
    await mutate(d => { const cur = pendingOf(d, id, '這瓶已被其他人加入酒櫃或刪除。'); cur.qty = Math.max(1, pendQty(cur) + delta); return cur.qty; }, q => `待入櫃：數量改為 ${q} 瓶`);
  } catch (e) { showErr('pendErr', msgOf(e)); }
  renderPending();
}
/* 待入櫃的酒之後再補拍第 2、3、4 張 */
async function addPendPhotos(id, fileList) {
  const files = [...fileList], item = (S.data?.pending || []).find(x => x.id === id);
  if (!item || !files.length || S.pendAdding || !canEdit()) return;
  const room = MAX_PHOTOS - item.photos.length;
  showErr('pendErr', files.length > room ? `每瓶最多 ${MAX_PHOTOS} 張，只加入前 ${room} 張。` : '');
  if (room <= 0) return;
  S.pendAdding = id; renderPending();
  const up = [];
  try {
    await compressEach(files.slice(0, room), 'pendErr', async ph => { up.push(await uploadPhoto(ph, 'pending')); });
    if (!up.length) return;
    const extra = await mutate(d => {
      const cur = pendingOf(d, id, '這瓶已被其他人加入酒櫃或刪除。');
      const fit = up.slice(0, MAX_PHOTOS - cur.photos.length); cur.photos.push(...fit);
      return up.slice(fit.length);
    }, `待入櫃：加入照片（${up.length} 張）`);
    if (extra.length) deleteFiles(extra.flatMap(p => [p.photo, p.thumb]), '待入櫃');
    toast(`已加入 ${up.length - extra.length} 張照片。`);
  } catch (e) { showErr('pendErr', msgOf(e)); if (up.length && !(S.data?.pending || []).some(x => x.photos.some(p => p.photo === up[0].photo))) deleteFiles(up.flatMap(p => [p.photo, p.thumb]), '待入櫃'); }
  finally { S.pendAdding = null; renderPending(); checkStorage(); }
}
async function removePendPhoto(id, path) {
  if (S.pendAdding || !canEdit()) return;
  showErr('pendErr', '');
  try {
    const gone = await mutate(d => {
      const cur = pendingOf(d, id, '這瓶已不存在。');
      if (cur.photos.length < 2) fail('至少要留一張照片；整瓶不要請按「刪除」。');
      return cur.photos.splice(photoIndex(cur.photos, path), 1)[0];
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
    const qty = S.pendQty || 1;
    await mutate(d => { d.pending = d.pending || []; d.pending.push({id: crypto.randomUUID(), photos, qty, by: who, at: now()}); }, `待入櫃：新增 ${qty} 瓶（${photos.length} 張照片）`);
    S.pendNew = []; S.pendQty = 1; toast('已存入待入櫃，之後再補資料。');
  } catch (e) { showErr('pendErr', msgOf(e)); }
  finally { S.pendSaving = false; $('q_save').disabled = false; renderPendStrip(); renderPending(); checkStorage(); }
}
function editPending(id) {
  if (!canEdit()) return;
  const p = (S.data?.pending || []).find(x => x.id === id); if (!p) return;
  $('pendModal').close(); openWineForm(null, p);
}
async function deletePending(btn) {
  if (!canEdit()) return;
  if (armDelete(btn)) return;
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
    if (PB) await r2Send('DELETE', path).catch(() => {});   // Cloudflare 上的照片
    try {   // GitHub 上的舊照片（搬家前上傳、留作備份的）
      const r = await gh(`${REPO}/contents/${path}?ref=${encodeURIComponent(CFG.dataBranch)}`);
      if (!r.ok) continue;
      const {sha} = await r.json();
      await gh(`${REPO}/contents/${path}`, {method: 'DELETE', body: {message: `刪除舊照片 ${id}\n\n操作者：${S.session.label}`, sha, branch: CFG.dataBranch}});
    } catch {}
  }
}
function openPhoto(w) { if (!w || !canEdit()) return; S.photo = w.wineId; showErr('photoErr', ''); renderPhotoMgr(); showDialog('photoModal'); }
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
        const cur = wineOf(d, id);
        const list = photosOf(cur).slice(); if (list.length >= MAX_PHOTOS) fail(`最多 ${MAX_PHOTOS} 張照片。`);
        list.push({photo: up.photo, thumb: up.thumb}); setPhotos(cur, list); touch(cur, who);
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
      const cur = wineOf(d, id), list = photosOf(cur).slice();
      list.unshift(...list.splice(photoIndex(list, path, '找不到這張照片，請重新整理。'), 1)); setPhotos(cur, list);
    }, `更換封面照片 ${id} ${w.wineName}`, {quiet: true});
    toast('已設為封面。');
  } catch (e) { showErr('photoErr', msgOf(e)); }
  renderPhotoMgr();
}
async function deletePhoto(btn) {
  if (armDelete(btn)) return;
  const id = S.photo, w = byId(id), path = btn.dataset.pdel, who = S.session.label;
  try {
    const gone = await mutate(d => {
      const cur = wineOf(d, id), list = photosOf(cur).slice();
      const [rm] = list.splice(photoIndex(list, path), 1); setPhotos(cur, list); touch(cur, who);
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
      el.querySelector('.txt').textContent = `儲存空間 ${fmtMB(mb)}／${STORAGE_LIMIT_MB} MB${pct >= .8 ? '　快滿了，請少換照片' : ''}`;
      const sub = $('storageSub'); if (sub) sub.textContent = `已用 ${fmtMB(mb)}／${STORAGE_LIMIT_MB} MB${pct >= .8 ? '・快滿了' : ''}`;
    }
    return S.storage;
  } catch { return null; }
}

/* 工程人員：把 GitHub 上的舊照片複製到 Cloudflare（已存在的跳過，可重複執行） */
async function migratePhotos() {
  if (!PB || !isEng() || S.migrating) return;
  const btn = $('migBtn'), msg = t => { $('migMsg').textContent = t; };
  S.migrating = true; btn.disabled = true; msg('讀取照片清單中…');
  try {
    const r = await gh(`${REPO}/git/trees/${encodeURIComponent(CFG.dataBranch)}?recursive=1`);
    if (!r.ok) fail('讀不到 GitHub 的照片清單（' + r.status + '）。');
    const files = (await r.json()).tree.filter(t => t.type === 'blob' && t.path.startsWith(CFG.imageDir + '/') && /\.(jpe?g|png|webp)$/i.test(t.path)).map(t => t.path);
    let done = 0, moved = 0, skip = 0, bad = [];
    const show = () => msg(`已處理 ${done}／${files.length} 張（搬過去 ${moved}、原本就有 ${skip}${bad.length ? `、失敗 ${bad.length}` : ''}）`);
    show();
    const one = async path => {
      try {
        const h = await fetch(`${PB}/${encPath(path)}`, {method: 'HEAD', cache: 'no-store'});
        if (h.ok) { skip++; return; }
        const g = await gh(`${REPO}/contents/${encPath(path)}?ref=${encodeURIComponent(CFG.dataBranch)}`, {raw: true});
        if (!g.ok) throw 0;
        const p = await r2Send('PUT', path, await g.blob());
        if (!p.ok) throw 0;
        moved++;
      } catch { bad.push(path); } finally { done++; show(); }
    };
    const queue = files.slice();
    await Promise.all(Array.from({length: 4}, async () => { while (queue.length) await one(queue.shift()); }));
    msg(bad.length ? `完成，但有 ${bad.length} 張沒搬成功，請再按一次重試。（共 ${files.length} 張：搬過去 ${moved}、原本就有 ${skip}）` : `全部完成！共 ${files.length} 張照片都在 Cloudflare 了（這次搬過去 ${moved} 張、原本就有 ${skip} 張）。`);
    if (!bad.length) toast('照片已全部搬到 Cloudflare。');
  } catch (e) { msg(msgOf(e)); }
  finally { S.migrating = false; btn.disabled = false; }
}

/* ---------- CSV ---------- */
function exportCsv() {
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['資料類型', ...FIELDS.map(f => f[1]), '酒種', '櫃位', '層位', '瓶數', '飲用優先', '最後修改者', '最後修改時間'].join(',')];
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

/* ---------- 匯出 Excel：照「敦南8樓」酒單的格式（依酒莊產區、依位置、曾經擁有三張表） ---------- */
// 地點：櫃名開頭是「8樓」的屬於「敦南8樓」，「行館」開頭的屬於「行館」；其他就用櫃名
const SITES = [['8樓', '敦南8樓'], ['行館', '行館']];
const siteOf = cab => { const s = SITES.find(([p]) => (cab || '').startsWith(p)); return s ? s[1] : cab || '其他'; };
// 位置代碼：櫃名去掉地點開頭與結尾的「櫃」字，後面接層號；只有一層的櫃子不接層號（8樓右LB櫃 第1層 → 右LB1；8樓外冰箱 → 外冰箱）
function locCode(cab, shelf) {
  const s = SITES.find(([p]) => (cab || '').startsWith(p)), base = (s ? cab.slice(s[0].length) : cab || '').replace(/櫃$/, '');
  const shelves = new Set(shelvesOf(cab)); for (const sh of Object.keys(S.data?.capacity?.[cab] || {})) shelves.add(sh);
  if (shelf) shelves.add(shelf);
  return shelves.size > 1 ? base + (shelfNo(shelf) < 999 ? shelfNo(shelf) : shelf || '') : base;
}
const xmlEsc = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = i => String.fromCharCode(65 + i);   // 0→A（只用到 A–M）
// 樣式編號（對應下面 styles.xml 的 cellXfs）
const XS = {title: 1, head: 2, hint: 3, text: 4, mid: 5, price: 6, cjkMid: 7, cjkLeft: 8};
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="176" formatCode="&quot;NT$&quot;#,##0_);\\(&quot;NT$&quot;#,##0\\)"/></numFmts>
<fonts count="6"><font><sz val="12"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="25"/><name val="微軟正黑體"/><family val="2"/><charset val="136"/></font><font><sz val="20"/><name val="Calibri"/><family val="2"/></font><font><sz val="20"/><name val="微軟正黑體"/><family val="2"/><charset val="136"/></font><font><sz val="16"/><name val="微軟正黑體"/><family val="2"/><charset val="136"/></font><font><b/><sz val="26"/><color rgb="FFFF0000"/><name val="BiauKaiTC Regular"/><family val="4"/><charset val="136"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" shrinkToFit="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" shrinkToFit="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="176" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" shrinkToFit="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
const XL_HEAD = ['Region', '酒莊/產區', '酒名', '年份', '容量', '數量', '參考價格', '來源', '位置', '其他備註/葡萄品種', '產地', '照片', '', '', ''];
const XL_HEAD_ST = XL_HEAD.map(() => XS.head);
const XL_DATA = 'BCDEFGHIJKLMNO';   // 有框線的欄（A 隱藏）；L～O＝照片 1～4，一張一格
// 縮圖：每一列酒都一樣高（有沒有照片都一樣），圖片置中放在各自的格子
const XL_PIC = {rowPt: 96, maxH: 86, maxW: 92, colPt: 104};
const XL_COLS = '<cols><col min="1" max="1" width="33.43" hidden="1" customWidth="1"/><col min="2" max="3" width="90.57" customWidth="1"/><col min="4" max="6" width="18.57" customWidth="1"/><col min="7" max="7" width="24" customWidth="1"/><col min="8" max="9" width="18.57" customWidth="1"/><col min="10" max="10" width="63.57" customWidth="1"/><col min="11" max="11" width="27" customWidth="1"/><col min="12" max="15" width="19" customWidth="1"/></cols>';
// 一格：數字、文字或公式
function xlCell(ref, v, st) {
  if (v && typeof v === 'object' && v.f) return `<c r="${ref}" s="${st}"><f>${xmlEsc(v.f)}</f><v>${v.v ?? ''}</v></c>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
  if (v === '' || v == null) return `<c r="${ref}" s="${st}"/>`;
  return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}
function xlRow(r, cells, ht = 33) { return `<row r="${r}" ht="${ht}" customHeight="1">${cells.map(([c, v, st]) => xlCell(c + r, v, st)).join('')}</row>`; }
// 一列酒：A 欄（Region，隱藏）留空
function xlWineRow(r, x) {
  const yr = /^\d{4}$/.test(String(x.w.vintage || '').trim()) ? Number(x.w.vintage) : String(x.w.vintage || '');
  const price = x.w.referencePrice == null || x.w.referencePrice === '' ? '' : Number.isFinite(Number(x.w.referencePrice)) ? Number(x.w.referencePrice) : String(x.w.referencePrice);
  return xlRow(r, [['A', '', 0], ['B', x.w.wineryRegion || '', XS.text], ['C', x.w.wineName || '', XS.text], ['D', yr, XS.mid], ['E', x.w.volume || '', XS.mid], ['F', x.qty, XS.mid],
    ['G', price, XS.price], ['H', x.w.source || '', XS.cjkMid], ['I', x.code, XS.mid], ['J', x.w.grapeNotes || '', XS.cjkLeft], ['K', x.w.origin || '', XS.cjkLeft], ['L', '', XS.mid], ['M', '', XS.mid], ['N', '', XS.mid], ['O', '', XS.mid]], XL_PIC.rowPt);
}
const xlBlank = r => xlRow(r, XL_DATA.split('').map(c => [c, '', 'BC'.includes(c) || 'JK'.includes(c) ? XS.text : XS.mid]), 30);
function xlSheet({title, hint, hintAt, blocks, sums, headRow}) {
  const rows = [], merges = [], pics = [];
  let r = 1;
  if (hint) { rows.push(xlRow(r, [[hintAt[0], hint, XS.hint], [hintAt[1], '', XS.hint]], 48.95)); merges.push(`${hintAt[0]}1:${hintAt[1]}1`); r++; }
  rows.push(xlRow(r, XL_DATA.split('').map((c, i) => [c, i ? '' : title, XS.title]))); merges.push(`B${r}:O${r}`); r++;
  rows.push(xlRow(r, XL_HEAD.map((h, i) => [colName(i), h, XL_HEAD_ST[i]]))); merges.push(`L${r}:O${r}`); r++;
  const first = r;
  blocks.forEach((list, bi) => {
    if (bi) { rows.push(xlBlank(r)); r++; }
    const start = r;
    for (const x of list) { rows.push(xlWineRow(r, x)); x.pics.forEach((pic, k) => pics.push({row: r, col: 11 + k, pic})); r++; }
    if (sums) { rows.push(xlRow(r, XL_DATA.split('').map(c => [c, c === 'F' ? {f: `SUM(F${start}:F${r - 1})`, v: list.reduce((a, x) => a + (Number(x.qty) || 0), 0)} : '', 'BC'.includes(c) || 'JK'.includes(c) ? XS.text : XS.mid]))); r++; }
  });
  const last = Math.max(r - 1, first), head = first - 1;
  return {last, head, pics, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:O${last}"/><sheetViews><sheetView zoomScale="60" zoomScaleNormal="60" workbookViewId="0"><pane ySplit="${head}" topLeftCell="A${head + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B${head + 1}" sqref="B${head + 1}"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="11" defaultRowHeight="30"/>${XL_COLS}<sheetData>${rows.join('')}</sheetData><autoFilter ref="A${head}:O${head}"/><mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells><printOptions horizontalCentered="1"/><pageMargins left="0" right="0" top="0" bottom="0" header="0" footer="0"/><pageSetup paperSize="9" fitToHeight="0" orientation="landscape"/><headerFooter><oddFooter>第 &amp;P 頁，共 &amp;N 頁</oddFooter></headerFooter>${pics.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`};
}
const byWinery = (a, b) => (a.w.wineryRegion || '').localeCompare(b.w.wineryRegion || '', 'en', {sensitivity: 'base'}) || (a.w.wineName || '').localeCompare(b.w.wineName || '', 'en', {sensitivity: 'base'}) || String(a.w.vintage || '').localeCompare(String(b.w.vintage || ''));
const byPlace = (a, b) => a.cab.localeCompare(b.cab) || shelfNo(a.shelf) - shelfNo(b.shelf) || byWinery(a, b);
async function buildWorkbook() {
  const d = new Date(), stamp = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  const sites = new Map(), site = n => { if (!sites.has(n)) sites.set(n, {now: [], gone: []}); return sites.get(n); };
  for (const w of active()) for (const l of w.locations || []) if (l.quantity > 0) site(siteOf(l.cabinet)).now.push({w, cab: l.cabinet, shelf: l.shelf, qty: Number(l.quantity) || 0, code: locCode(l.cabinet, l.shelf)});
  for (const w of wines().filter(x => x.status === 'archived')) {
    const outs = (w.outs || []).slice().sort(byNewest), lastOut = outs[0] || {}, loc = lastOut.cabinet ? lastOut : (w.locations || [])[0] || {};
    const qty = outs.reduce((a, o) => a + (Number(o.qty) || 0), 0);
    site(loc.cabinet ? siteOf(loc.cabinet) : SITES[0][1]).gone.push({w, cab: loc.cabinet || '', shelf: loc.shelf || '', qty: qty || '', code: loc.cabinet ? locCode(loc.cabinet, loc.shelf) : ''});
  }
  // 縮圖：每款酒的每一張照片（最多 4 張）都抓下來放進 Excel（同一張檔案只放一次）
  const media = new Map(), all = [...sites.values()].flatMap(v => [...v.now, ...v.gone]);
  const picPaths = w => photosOf(w).slice(0, MAX_PHOTOS).map(p => p.thumb || p.photo);
  const need = [...new Set(all.flatMap(x => picPaths(x.w)))];
  const queue = need.slice();
  await Promise.all(Array.from({length: 6}, async () => { while (queue.length) { const path = queue.shift(); try {
    const r = await fetchPhoto(path); if (!r.ok) continue;
    const blob = await r.blob(), bm = await createImageBitmap(blob), png = /png/.test(blob.type);
    media.set(path, {n: 0, ext: png ? 'png' : 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), w: bm.width, h: bm.height}); bm.close?.();
  } catch {} } }));
  let mi = 0; for (const path of need) if (media.has(path)) media.get(path).n = ++mi;
  for (const x of all) x.pics = picPaths(x.w).map(p => media.get(p)).filter(Boolean);
  const order = [...sites.keys()].sort((a, b) => (a === SITES[0][1] ? -1 : b === SITES[0][1] ? 1 : a.localeCompare(b)));
  const sheets = [];
  for (const n of order) {
    const {now, gone} = sites.get(n);
    const cabs = [...new Set(now.map(x => x.cab))].sort();
    const blocks = sort => cabs.map(c => now.filter(x => x.cab === c).sort(sort));
    if (now.length) {
      sheets.push({name: `${n}-依酒莊產區`, ...xlSheet({title: `${n}(${stamp}更新)`, hint: '  依酒莊/產區排序↓', hintAt: ['B', 'C'], blocks: blocks(byWinery), sums: true})});
      sheets.push({name: `${n}-依位置`, ...xlSheet({title: `${n}(${stamp}更新)`, hint: '依位置排序↓', hintAt: ['H', 'I'], blocks: blocks(byPlace), sums: true})});
    }
    if (gone.length) sheets.push({name: `${n}-曾經擁有`, ...xlSheet({title: `${n}(${stamp}更新)`, blocks: [gone.sort(byPlace)], sums: false})});
  }
  if (!sheets.length) fail('還沒有酒款可以匯出。');
  sheets.forEach(s => { s.name = s.name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31); });
  // 每張表一個 drawing：圖片固定在 L 欄那一格，置中、不隨欄寬縮放
  const EMU = 12700, drawings = sheets.map(s => {
    if (!s.pics.length) return null;
    const used = [...new Set(s.pics.map(p => p.pic.n))], rid = n => 'rId' + (used.indexOf(n) + 1);
    const anchors = s.pics.map(({row, col, pic}, k) => {
      const sc = Math.min(XL_PIC.maxH / pic.h, XL_PIC.maxW / pic.w), wPt = pic.w * sc, hPt = pic.h * sc;
      const cx = Math.round(wPt * EMU), cy = Math.round(hPt * EMU), ox = Math.round(Math.max(0, (XL_PIC.colPt - wPt) / 2) * EMU), oy = Math.round(Math.max(0, (XL_PIC.rowPt - hPt) / 2) * EMU);
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${ox}</xdr:colOff><xdr:row>${row - 1}</xdr:row><xdr:rowOff>${oy}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="照片 ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid(pic.n)}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join('');
    const ext = n => [...media.values()].find(m => m.n === n).ext;
    return {xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`,
      rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${used.map((n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.${ext(n)}"/>`).join('')}</Relationships>`};
  });
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>${drawings.map((g, i) => g ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '').join('')}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => { const q = `'${s.name.replace(/'/g, "''")}'`; return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEsc(q)}!$A$${s.head}:$O$${s.head}</definedName><definedName name="_xlnm.Print_Area" localSheetId="${i}">${xmlEsc(q)}!$B$1:$O$${s.last}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xmlEsc(q)}!$${s.head - 1}:$${s.head}</definedName>`; }).join('')}</definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', XLSX_STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
    ...drawings.flatMap((g, i) => g ? [[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`], [`xl/drawings/drawing${i + 1}.xml`, g.xml], [`xl/drawings/_rels/drawing${i + 1}.xml.rels`, g.rels]] : []),
    ...[...media.values()].filter(m => m.n).map(m => [`xl/media/image${m.n}.${m.ext}`, m.bytes]),
  ];
  return {zip: zipStore(files), sheets: sheets.map(s => s.name)};
}
// 最簡單的 zip（不壓縮）：xlsx 就是一包 XML
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const te = new TextEncoder(), parts = [], dir = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  for (const [name, text] of files) {
    const nb = te.encode(name), data = typeof text === 'string' ? te.encode(text) : text, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dt, true); c.setUint16(14, dd, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    dir.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const size = dir.reduce((a, p) => a + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...dir, new Uint8Array(e.buffer)], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function exportXlsx() {
  const btn = $('exportXlsxBtn'); if (btn.disabled) return;
  const label = btn.textContent; btn.disabled = true; btn.textContent = '準備照片中…';
  try {
    const {zip} = await buildWorkbook();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip); a.download = `wine-cellar-${today()}.xlsx`;   // 檔名用英文：有些瀏覽器遇到中文檔名會變成「download」
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(msgOf(e)); if (!e.user) console.error(e); }
  finally { btn.disabled = false; btn.textContent = label; }
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
    const cnt = (cab, sh) => bottlesAt(Object.values(d.wines).filter(w => w.status !== 'archived'), cab, sh);
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
  const eng = canDel(), chip = n => `<span class="chip">${esc(n)}${eng ? `<button data-rm="${esc(n)}" aria-label="移除 ${esc(n)}">×</button>` : ''}</span>`;
  $('cabChips').innerHTML = cat.cabinets.filter(c => !isRemoved(c, '')).map(chip).join('') || '<span class="hint">尚未建立。</span>';
  $('shelfChips').innerHTML = cat.shelves.map(chip).join('') || '<span class="hint">尚未建立。</span>';
  renderLocDel();
  renderHistory();
}
const OUT_TYPES = ['自飲', '聚餐', '送禮', '其他'];

/* ---------- 飲酒日誌「回憶」（依場合找飲用紀錄）與 管理「搜尋」（所有登錄過的酒、飲用紀錄、再買一次） ---------- */
const OCC_CLASS = {'自飲': 'self', '聚餐': 'dine', '送禮': 'gift', '其他': 'other'};
const occBadge = e => e.kind === 'ext' ? '<span class="occ ext">非酒窖</span>' : `<span class="occ ${OCC_CLASS[e.type] || 'other'}">${esc(e.type)}</span>`;
const roStars = n => n ? `<span class="rostar" aria-label="評分 ${n}／5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '';
const normKey = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const mdDate = d => d ? d.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2') : '';
function drinkEvents() {  // 回憶：所有飲用（含送禮）與非酒窖紀錄，由新到舊
  return drinkRecords().sort(byNewest);
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
    const ph = entryPhoto(e);
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
function memLine(it, noAvg) {
  const parts = [];
  if (it.winery) parts.push(esc(it.winery));
  if (it.count) { const kinds = Object.entries(it.byType).filter(([k]) => k !== '送禮').map(([k, n]) => `${k} ${n}`); parts.push(`喝過 ${it.count} 次${kinds.length > 1 ? `（${kinds.join('、')}）` : ''}`); }
  if (it.gifts) parts.push(`送禮 ${it.gifts} 次`);
  if (it.avg && !noAvg) parts.push(`★${it.avg.toFixed(1)}`);
  if (!it.events.length) parts.push('還沒有飲用紀錄');
  return parts.join('・');
}
const stockBadge = it => it.kind === 'ext' ? '<span class="stock none">不在酒窖</span>' : it.stock > 0 ? `<span class="stock">庫存 ${it.stock} 瓶</span>` : '<span class="stock none">已喝完</span>';
function renderMem() {
  const f = S.jm, q = normKey(f.q);
  setChips('jm_group', b => b.dataset.v === f.group);
  const ld = it => it.last ? it.last.date + it.last.at : '';
  const list = memItems().filter(it => (f.group !== 'gone' || !(it.kind === 'cellar' && it.stock > 0))
    && (!q || normKey([it.name, it.vintage, it.winery, it.origin].join(' ')).includes(q)));
  // 最近喝的排前面；沒喝過的排最後，依名稱
  list.sort((a, b) => ld(b).localeCompare(ld(a)) || a.name.localeCompare(b.name, 'en') || String(a.vintage).localeCompare(String(b.vintage)));
  $('jm_sum').innerHTML = `所有登錄過的酒（酒窖的、喝完的、別人帶來的）都在這裡，${q || f.group !== 'recent' ? '符合' : '共'} <b>${list.length}</b> 款`;
  $('jm_list').innerHTML = list.map(it => {
    const ph = it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : `<span class="ph">${esc(it.vintage || 'NV')}</span>`;
    const last = it.last ? `最近 ${mdDate(it.last.date)} ${esc(it.last.kind === 'ext' ? '非酒窖' : it.last.type)}${it.last.note ? ' ' + esc(it.last.note) : ''}` : '';
    return `<div class="lib" data-mem="${esc(it.key)}" role="button" tabindex="0"><span class="lph">${ph}${avgStars(it.avg)}</span><div><div class="t">${esc(it.name)}${it.vintage ? ` <span class="v">${esc(it.vintage)}</span>` : ''}</div><div class="s">${memLine(it, true)}${last ? '<br>' + last : ''}　${stockBadge(it)}</div></div></div>`;
  }).join('') || '<p class="hint">沒有符合的酒款。</p>';
}
// 照片下方的平均評分：金色星星依分數填滿（可到小數），旁邊標分數
const avgStars = a => a ? `<span class="lstars" aria-label="平均評分 ${a.toFixed(1)}／5"><span class="lsr" style="--r:${a.toFixed(2)}">★★★★★<b>★★★★★</b></span><em>${a.toFixed(1)}</em></span>` : '';
function openMem(key) { S.memKey = key; renderMemDetail(); if (!$('memModal').open || isClosing($('memModal'))) showDialog('memModal'); }
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
function journalEntries() {  // 日曆：送禮不算喝掉
  return drinkRecords().filter(e => e.type !== '送禮');
}
const sumQty = list => list.reduce((a, e) => a + e.qty, 0);
// 紀錄卡片左邊的照片；沒有照片就顯示年份
const entryPhoto = e => e.photo ? `<img class="ph" src="${esc(e.photo)}" alt="" loading="lazy">` : `<span class="ph">${esc(e.vintage || 'NV')}</span>`;
// 飲用紀錄：酒窖的每一筆出庫，加上非酒窖的紀錄。日曆與回憶共用
function drinkRecords() {
  const out = [];
  for (const w of wines()) for (const o of w.outs || []) out.push({kind: 'cellar', key: `o|${w.wineId}|${o.at || ''}`, mem: 'w:' + w.wineId, wineId: w.wineId,
    date: o.date || '', at: o.at || '', name: w.wineName, vintage: w.vintage || '', winery: w.wineryRegion || '', qty: Number(o.qty) || 1,
    type: OUT_TYPES.includes(o.type) ? o.type : '其他', note: o.reason || '', where: [o.cabinet, o.shelf].filter(Boolean).join(' · '), rating: Number(o.rating) || 0, photo: thumbUrl(w), by: o.by});
  for (const j of S.data?.journal || []) out.push({kind: 'ext', key: `j|${j.id}`, mem: 'x:' + normKey(j.name) + '|' + normKey(j.vintage), id: j.id,
    date: j.date || '', at: j.at || '', name: j.name, vintage: j.vintage || '', winery: '', qty: Number(j.qty) || 1, type: '', source: j.source,
    note: j.note || '', who: j.who || '', where: '', rating: Number(j.rating) || 0, photo: j.thumb ? fileUrl(j.thumb) : j.photo ? fileUrl(j.photo) : '', by: j.by, j});
  return out;
}
// 評分後：亮著的星星從左到右依序跳一下
function starPop(g) { if (!g) return; g.classList.remove('pop'); void g.offsetWidth; g.classList.add('pop'); setTimeout(() => g.classList.remove('pop'), 700); }
function starsHtml(e) {
  const ed = canModEntry(e);
  return `<span class="stars" ${ed ? 'role="group"' : 'role="img"'} aria-label="評分 ${e.rating}／5">${[1, 2, 3, 4, 5].map(i => ed
    ? `<button type="button" class="${i <= e.rating ? 'on' : ''}" style="--i:${i - 1}" data-rate="${i}" data-key="${esc(e.key)}" aria-label="${i} 顆星">★</button>`
    : `<i class="${i <= e.rating ? 'on' : ''}">★</i>`).join('')}</span>`;
}
function entryHtml(e) {
  const ph = entryPhoto(e);
  const meta = e.kind === 'cellar'
    ? `<span class="badge c">酒窖</span>${esc(e.type)} · ${e.qty} 瓶${e.where ? ' · ' + esc(e.where) : ''}`
    : `<span class="badge e">非酒窖${e.source && e.source !== '非酒窖' ? ' · ' + esc(e.source) : ''}</span>${e.qty} 瓶${e.who ? ' · ' + esc(e.who) : ''}`;
  const tools = e.kind === 'ext' && canModEntry(e) ? `<span class="etools"><button type="button" class="small" data-jedit="${esc(e.id)}">編輯</button><button type="button" class="small danger" data-jdel="${esc(e.id)}">刪除</button></span>` : '';
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
  $('jAdd').hidden = !canUse() || S.jDay > t;
}
function shiftMonth(n) {
  const [y, m] = S.jMonth.split('-').map(Number), d = new Date(y, m - 1 + n, 1);
  S.jMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; S.jDay = null; renderJournal();
}
async function setRating(key, n) {
  if (!canUse() || S.rateBusy) return;
  const e = journalEntries().find(x => x.key === key); if (!e || !canModEntry(e)) return;
  const next = n === e.rating ? 0 : n;
  S.rateBusy = true;
  try {
    await mutate(d => {
      const rec = e.kind === 'cellar' ? (d.wines[e.wineId]?.outs || []).find(o => (o.at || '') === e.at) : (d.journal || []).find(j => j.id === e.id);
      if (!rec) fail('找不到這筆紀錄，請重新整理。');
      if (next) rec.rating = next; else delete rec.rating;
    }, `評分 ${e.wineId || ''} ${e.name}：${next} 顆星`, {quiet: true});
  } catch (err) { toast(msgOf(err)); }
  finally {
    S.rateBusy = false; renderJournal();
    starPop([...document.querySelectorAll('[data-rate]')].find(b => b.dataset.key === key)?.closest('.stars'));
  }
}
function openJournal(editId) {
  if (!canUse()) return;
  const j = editId ? (S.data.journal || []).find(x => x.id === editId) : null;
  if (editId && (!j || !canModEntry(j))) return;
  ensureLists(); S.jEdit = editId || null; S.jPhoto = null;
  S.jf = {src: '', cab: '', shelf: '', wineId: '', miss: false};
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
  $('j_missBtn').hidden = !canEdit(); $('j_miss').hidden = true;   // 「酒窖裡找不到這瓶」會新建酒款，管理員以上才有
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
  if (!canEdit()) return;
  const f = S.jf; f.miss = true; f.wineId = '';
  fillLocPair($('j_cab'), $('j_shelf'), f.cab || '', f.shelf || '');
  syncJournalForm(); $('j_mname').focus();
}
async function saveJournal() {
  const f = S.jf, src = f.src, me = S.session.label;
  const date = $('j_date').value, qty = Number($('j_qty').value), note = $('j_note').value.trim(), rating = S.jRating || 0;
  const type = document.querySelector('input[name=j_type]:checked')?.value || '';
  if (!src) fail('請先選擇「酒窖」或「非酒窖」。');
  if (f.miss && !canEdit()) fail('補登新酒款需要管理員；可以改記成「非酒窖」。');
  if (src === 'cellar' && !f.wineId && !f.miss) fail(canEdit() ? '請依序點選櫃位、層位和酒；找不到的話按「補登一筆」。' : '請依序點選櫃位、層位和酒；酒窖裡找不到的話，可以改記成「非酒窖」。');
  checkDate(date);
  checkQty(qty);
  if (src === 'cellar' && !type) fail('請選擇類型：自飲、聚餐或其他。');
  const stamp = rating ? {rating} : {};
  if (src === 'cellar' && f.wineId) {
    const id = f.wineId, cabinet = f.cab, shelf = f.shelf;
    const res = await mutate(d => takeOut(d, id, {cabinet, shelf, qty, out: {date, type, reason: note, ...stamp}}, me, '請重新點選。'),
      x => takeOutMsg(id, x, {type, cabinet, shelf, qty, date, note}));
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
      const id = nextWineId(d), t = now();
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
  if (armDelete(btn)) return;
  const id = btn.dataset.jdel, j = (S.data.journal || []).find(x => x.id === id); if (!j || !canModEntry(j)) return;
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
  const own = !canEdit();   // 使用者只看自己記的出庫
  for (const w of wines()) for (const o of w.outs || []) if (!own || mine(o.by)) all.push({...o, wineId: w.wineId, wineName: w.wineName, vintage: w.vintage, gone: w.status === 'archived'});
  all.sort(byNewest);
  $('histIntro').textContent = own ? '你自己記的每一次出庫（含送禮），由新到舊。點一筆可以查看那款酒。' : '每一次出庫（含送禮）都記在這裡，由新到舊。點一筆可以查看那款酒。';
  $('histGoneBox').hidden = own;
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
  const own = !canEdit(), me = '操作者：' + (S.session?.label || '');   // 使用者只看自己做的異動
  $('auditHint').textContent = wineId ? `「${byId(wineId)?.wineName || ''}」的異動紀錄，由新到舊。` : own ? '你自己做過的異動，由新到舊。' : '';
  $('auditHint').hidden = !$('auditHint').textContent;
  $('auditList').innerHTML = page === 1 ? '<p class="hint">讀取中…</p>' : $('auditList').innerHTML;
  try {
    const pages = wineId || own ? [page, page + 1, page + 2] : [page];
    let more = false;
    for (const p of pages) {
      const r = await gh(`${REPO}/commits?sha=${encodeURIComponent(CFG.dataBranch)}&path=${encodeURIComponent(CFG.dataPath)}&per_page=50&page=${p}`);
      if (!r.ok) { authProblem(r); fail('讀取異動紀錄失敗。'); }
      const list = await r.json();
      for (const c of list) {
        if (/^(飲用優先|評分|調整照片順序|更換封面照片) /.test(c.commit.message) || HIDDEN_AUDIT.has(c.sha)) continue;
        if (wineId && !new RegExp('\\b' + wineId + '\\b').test(c.commit.message)) continue;
        if (own && !c.commit.message.split('\n').some(l => l.trim() === me)) continue;
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
    if (kind === 'cabinets' && d.catalog.removed) d.catalog.removed = d.catalog.removed.filter(r => r.cabinet !== name);
  }, `新增${kind === 'cabinets' ? '櫃位' : '層位'} ${name}`);
  $('l_name').value = ''; renderAdmin(); toast('已新增 ' + name + '。');
}
/* 工程人員、管理員：刪除某一櫃或某一櫃的某一層。裡面還有酒就不能刪（先移走或出庫） */
function renderLocDel() {
  const box = $('locDel'); box.hidden = !canDel(); if (box.hidden) return;
  const cabs = locOptions('cabinets').map(cab => {
    const shs = new Set(shelvesOf(cab)); for (const sh of Object.keys(S.data?.capacity?.[cab] || {})) shs.add(sh);
    return [cab, [...shs].sort(byShelf)];
  });
  $('locDelList').innerHTML = cabs.map(([cab, shs]) => {
    const n = shs.reduce((a, sh) => a + qtyAt(cab, sh), 0);
    const shelf = sh => { const q = qtyAt(cab, sh); return `<span class="chip ${q ? 'full' : ''}">${esc(sh)}<small>${q ? `${q} 瓶` : '空'}</small><button type="button" data-delsh="${esc(sh)}" data-cab="${esc(cab)}" ${q ? 'disabled title="還有酒，要先移走或出庫才能刪除"' : ''} aria-label="刪除 ${esc(cab)} ${esc(sh)}">×</button></span>`; };
    return `<div class="locdel"><div class="locdel-h"><b>${esc(cab)}</b><span class="hint">${n ? `${n} 瓶` : '空櫃'}</span><button type="button" class="small danger" data-delcab="${esc(cab)}" ${n ? 'disabled title="還有酒，要先移走或出庫才能刪除"' : ''}>刪除這一櫃</button></div><div class="chips">${shs.map(shelf).join('') || '<span class="hint">沒有層位。</span>'}</div></div>`;
  }).join('') || '<p class="hint">還沒有櫃位。</p>';
}
function confirmTap(btn, label) {   // 按第一次變成「確定刪除？」，4 秒內再按一次才執行
  if (btn.dataset.confirm === '1') return false;
  const orig = btn.textContent; btn.dataset.confirm = '1'; btn.textContent = label; btn.classList.add('arm');
  setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = orig; btn.classList.remove('arm'); } }, 4000);
  return true;
}
async function deleteLoc(cab, sh) {
  if (!canDel()) return;
  showErr('locErr', '');
  try {
    await mutate(d => {
      const left = Object.values(d.wines).filter(w => w.status !== 'archived').reduce((a, w) => a + (w.locations || []).filter(l => l.cabinet === cab && (!sh || l.shelf === sh)).reduce((b, l) => b + (Number(l.quantity) || 0), 0), 0);
      if (left) fail(`${cab}${sh ? ' ' + sh : ''} 還有 ${left} 瓶，要先移走或出庫才能刪除。`);
      for (const w of Object.values(d.wines)) if (w.locations) w.locations = w.locations.filter(l => !(l.cabinet === cab && (!sh || l.shelf === sh)));
      if (d.capacity?.[cab]) { if (sh) delete d.capacity[cab][sh]; else delete d.capacity[cab]; if (d.capacity[cab] && !Object.keys(d.capacity[cab]).length) delete d.capacity[cab]; }
      d.catalog = d.catalog || {cabinets: [], shelves: []};
      const rm = (d.catalog.removed || []).filter(r => r.cabinet !== cab || (sh && r.shelf !== sh));
      rm.push(sh ? {cabinet: cab, shelf: sh} : {cabinet: cab});
      d.catalog.removed = rm;
      if (!sh) d.catalog.cabinets = (d.catalog.cabinets || []).filter(n => n !== cab);
    }, sh ? `刪除層位 ${cab} ${sh}` : `刪除櫃位 ${cab}`);
    if (S.filter?.cabinet === cab && (!sh || S.filter.shelf === sh)) S.filter = null;
    if (!sh && S.cabOpen === cab) S.cabOpen = null;
    render(); renderAdmin(); toast(sh ? `已刪除 ${cab} 的 ${sh}。` : `已刪除 ${cab}。`);
  } catch (e) { showErr('locErr', msgOf(e)); }
}
/* 工程人員、管理員：刪除已喝完（已出清）的酒款紀錄。連同照片與這款酒的出庫／飲用紀錄一起移除；別款共用的照片會保留 */
async function deleteWine(id) {
  if (!canDel()) return;
  try {
    const gone = await mutate(d => {
      const cur = wineOf(d, id);
      if (cur.status !== 'archived' || total(cur) > 0) fail('這款酒還有庫存，只能刪除已喝完的紀錄。');
      delete d.wines[id];
      return cur;
    }, w => `刪除已喝完紀錄 ${id} ${w.wineName}`);
    closeDrawer(); render();
    if ($('adminModal').open) renderAdmin();
    toast(`已刪除「${[gone.wineName, gone.vintage].filter(Boolean).join(' ')}」的紀錄。`);
    const ps = photosOf(gone); if (ps.length) deleteFiles(ps.flatMap(p => [p.photo, p.thumb]), id).then(checkStorage);
  } catch (e) { toast(msgOf(e)); }
}
async function removeCatalog(kind, name) {
  if (!canDel()) return;
  if (kind === 'cabinets') return deleteLoc(name, '');
  showErr('locErr', '');
  try {
    await mutate(d => { d.catalog[kind] = d.catalog[kind].filter(n => n !== name); }, `移除${kind === 'cabinets' ? '櫃位' : '層位'} ${name}`);
    renderAdmin(); toast('已從清單移除 ' + name + '，既有酒款的位置不受影響。');
  } catch (e) { showErr('locErr', msgOf(e)); }
}
