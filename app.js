/* =======================================================================
   兔子的缝纫空间  ·  前端逻辑
   纯前端 + localStorage 持久化，无需后端即可运行
   ======================================================================= */
'use strict';

/* ---------- 工具函数 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtMoney = (n) => '¥' + (Number(n) || 0).toFixed(2);
const fmtMin = (m) => {
  m = Math.round(m);
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h}时${mm}分` : `${mm}分`;
};
const fmtHMS = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const starStr = (n) => { n = Math.max(0, Math.min(5, n | 0)); return '★'.repeat(n) + '☆'.repeat(5 - n); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthStr = (d) => d.slice(0, 7);
// 打开外部链接：优先新标签页；若被沙箱 iframe 拦截则回退到顶层窗口跳转
function openExternal(url) {
  if (!url) return;
  copyLink(url);
}
// 复制链接到剪贴板（兼容非安全上下文 / 旧浏览器），成功给提示
function copyLink(url) {
  const done = () => toast('链接已复制，去浏览器粘贴打开吧 🔗');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { done(); return; }
  } catch (_) {}
  toast('复制失败，请长按链接手动复制');
}

/* ---------- 平台 ---------- */
const PLATFORMS = ['拼多多', '淘宝', '小红书', '1688'];

/* ---------- 数据层 ---------- */
const KEY = 'bunny_sewing_space_v1';
// 图片版本号：更换默认素材图（兔子 / 缝纫机）后递增，强制各端重新下载、避免浏览器缓存旧图
const IMG_VER = '?v=5';

/* ---------- IndexedDB 持久层（容量远大于 localStorage，约数百 MB～GB） ---------- */
const DB_NAME = 'bunny_sewing_space_db';
const DB_STORE = 'kv';
function openDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
function idbGet(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined);
    } catch (_) { resolve(undefined); }
  });
}
function idbSet(db, key, val) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    } catch (e) { reject(e); }
  });
}
function idbDel(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
    } catch (_) { resolve(); }
  });
}

/* ---------- 云端同步（Supabase，可选） ---------- */
// 在此填入你的 Supabase 项目 URL 与 anon public key 即可开启多端同步；留空则退回本机 IndexedDB
const SUPABASE_URL = 'https://ofednqykufgydghiuapz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_y0dCvlt6PvHBy6HR8lUbHg_ehKdT2H9';
let CLOUD = !!(SUPABASE_URL && SUPABASE_ANON); // 运行时开关，登录页可选“仅本机”
let _sb = null, _sbLoading = null;
let SBUser = null; // 当前登录用户（用于同步状态展示）
let SBToken = null; // 缓存当前会话 access_token，供“关页面自动同步”在页面卸载时构造鉴权头（无需再异步获取）
let _tokenCached = false; // registerSessionCache 幂等标志
function registerSessionCache(sb) {
  if (_tokenCached || !sb || !sb.auth) return;
  _tokenCached = true;
  try {
    sb.auth.onAuthStateChange((_event, session) => { SBToken = (session && session.access_token) ? session.access_token : null; });
  } catch (_) {}
}
async function sbClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON) return null;
  if (_sb) return _sb;
  if (!_sbLoading) {
    _sbLoading = (async () => {
      if (!window.supabase) {
        // 优先加载本地打包的 UMD 库（避免外链被拦 / ESM 误加载）；失败再回退 CDN UMD
        await loadScript('supabase.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'));
      }
      if (!window.supabase) throw new Error('Supabase 库加载失败');
      return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { persistSession: true });
    })().catch(e => { console.error(e); toast('云端库加载失败：' + e.message); throw e; });
  }
  _sb = await _sbLoading;
  return _sb;
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('脚本加载失败: ' + src));
    document.head.appendChild(s);
  });
}

const DEFAULT_STATE = () => ({
  rabbit: { cans: 0, rewards: 0, checkIn: null, checkOut: null, checkDate: '', sessions: [], pausedAt: null, pausedTotal: 0, sewName: '' },
  machine: { name: '瓜瓜小王', image: '' },
  fabrics: [], notions: [], tutorials: [], works: [],
});

// 判断一份 state 是否为“全新空数据”（无任何作品/布料/记录）——用于登录时决定本机/云端优先级
function isEmptyState(s) {
  s = s || {};
  const arrLen = (s.works || []).length + (s.fabrics || []).length + (s.notions || []).length + (s.tutorials || []).length;
  const r = s.rabbit || {};
  const hasCheck = !!(r.checkIn) || (Number(r.cans) || 0) > 0 || (Array.isArray(r.sessions) && r.sessions.length > 0);
  return arrLen === 0 && !hasCheck;
}

const Store = {
  state: DEFAULT_STATE(),
  _dbp: null,
  _cloudLoaded: false, // 只有成功从云端读取过数据，才允许写回云端（防止空状态覆盖）
  _updatedAt: null, // 最近一次成功落库（云端/本机）的时间戳，用于实时同步的版本判断
  _lastCloudSync: null, // 最近一次成功写入云端的时间戳，用于状态栏展示“上次同步时间”
  _db() {
    if (!this._dbp) this._dbp = openDB();
    return this._dbp;
  },
  // 读取本机数据（IndexedDB 与 localStorage 各取一份，按 updatedAt 取较新者；兼容旧版裸 state）
  // 返回 { state, updatedAt }
  async _readLocal() {
    let db = null;
    try { db = await this._db(); } catch (_) {}
    let idbRaw = null, lsRaw = null;
    if (db) idbRaw = await idbGet(db, KEY);
    try { const ls = localStorage.getItem(KEY); if (ls != null) lsRaw = JSON.parse(ls); } catch (_) {}
    const pick = (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.state && typeof raw.state === 'object') return { state: raw.state, updatedAt: raw.updatedAt || null };
      return { state: raw, updatedAt: null }; // 旧版裸 state
    };
    const a = pick(idbRaw), b = pick(lsRaw);
    const ta = a && a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b && b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    const best = (ta >= tb) ? a : b;
    // 把较新的一份回写到另一侧，统一两处本机存储
    if (best && db && ta < tb) { try { await idbSet(db, KEY, { state: best.state, updatedAt: best.updatedAt }); } catch (_) {} }
    if (!best) return { state: null, updatedAt: null };
    return { state: best.state, updatedAt: best.updatedAt };
  },
  // 写入本机数据（含时间戳）：先同步写 localStorage（reload/切后台前必定落库，即时兜底），
  // 再异步写 IndexedDB（主存储，容量大可存作品图）。云端 upsert 失败/未完成时本机仍可救回数据。
  async _persistLocal(ts) {
    const updatedAt = ts || this._updatedAt || new Date().toISOString();
    const payload = { state: this.state, updatedAt };
    try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch (_) {} // 同步兜底：绝不因异步事务被刷新打断而丢失
    let db = null;
    try { db = await this._db(); } catch (_) {}
    if (db) {
      try { await idbSet(db, KEY, payload); Store._warnedQuota = false; }
      catch (e) {
        const q = String(e && e.name).includes('Quota') || String(e && e.name).includes('quota');
        if (q && !Store._warnedQuota) { Store._warnedQuota = true; toast('⚠️ 本地空间已满，请删除一些带图条目后重试'); }
      }
    }
  },
  async load() {
    if (CLOUD) {
      const sb = await sbClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { this.state = DEFAULT_STATE(); return; }
      this._cloudLoaded = true; // 已确认为有效云端账号，后续保存可写回云端
      const { data } = await sb.from('sewing_state').select('data, updated_at').eq('user_id', user.id).maybeSingle();
      const cloud = (data && data.data && typeof data.data === 'object') ? data.data : null;
      const cloudTs = (data && data.updated_at) ? new Date(data.updated_at).getTime() : 0;
      const local = await this._readLocal();
      const localValid = local.state && typeof local.state === 'object' && !isEmptyState(local.state);
      const localTs = (local.updatedAt) ? new Date(local.updatedAt).getTime() : 0;
      if (cloud && !isEmptyState(cloud) && cloudTs >= localTs) {
        // 云端数据较新或一致：以云端为准
        try { this.state = Object.assign(DEFAULT_STATE(), cloud); this._lastLoad = 'cloud'; this._updatedAt = (data && data.updated_at) || this._updatedAt; Store._lastCloudSync = (data && data.updated_at) || Store._lastCloudSync; }
        catch (_) { this.seed(); this._lastLoad = 'seed'; }
        // 同步把云端最新写回本机，保证离线/弱网时本机也是最新
        try { await this._persistLocal(this._updatedAt); } catch (_) {}
      }
      else if (localValid) {
        // 本机比云端新（多为上次云端 upsert 失败/页面关闭未完成）：以本机为准并写回云端
        this.state = Object.assign(DEFAULT_STATE(), local.state);
        this._lastLoad = 'local-restored';
        this.save();
      }
      else {
        // 云端和本机都为空：不要写回云端，避免把云端固化成空行导致其他设备数据被覆盖
        this.seed();
        this._lastLoad = cloud ? 'cloud-empty' : 'new';
      }
      this.normalize();
      this.ensureDaily();
      setupRealtime(sb, user.id);
      return;
    }
    // 非云端：本机优先
    const local = await this._readLocal();
    if (local.state) { try { this.state = Object.assign(DEFAULT_STATE(), local.state); } catch (_) { this.seed(); } }
    else this.seed();
    this.normalize();
    this.ensureDaily();
  },
  // 将旧版单列售卖记录统一为多条售卖记录数组
  normalize() {
    (this.state.works || []).forEach(w => {
      if (w.sale) {
        w.sales = (w.sale.sold)
          ? [{ date: w.sale.date || todayStr(), buyer: w.sale.buyer || '', price: Number(w.sale.price) || 0, qty: 1 }]
          : [];
        delete w.sale;
      }
      if (!Array.isArray(w.sales)) w.sales = [];
      if (!Array.isArray(w.uses)) w.uses = []; // 自用记录：每次自己使用作品记一条
      w.type = w.type || 'self'; // 旧数据/未标记的作品统一归入“自用”模块
      w.fabric = w.fabric || '';
      if (typeof w.fabricId === 'undefined') w.fabricId = '';
      // 旧作品用文字布料名，尝试关联到布料模块中的布料
      if (w.fabric && !w.fabricId) {
        const f = this.state.fabrics.find(x => x.name === w.fabric);
        if (f) w.fabricId = f.id;
      }
      w.durationMin = Number(w.durationMin) || 0;
      w.date = w.date || '';
      w.difficulty = Number(w.difficulty) || 0;
      w.like = Number(w.like) || 0;
    });
    // 老数据可能没有 machine 字段，补默认（image 留空，渲染时自动加版本号获取最新图）
    if (!this.state.machine) this.state.machine = { name: '瓜瓜小王', image: '' };
    if (!this.state.machine.name) this.state.machine.name = '瓜瓜小王';
    if (typeof this.state.machine.image !== 'string') this.state.machine.image = '';
    // 老版本把默认图存成了裸 'machine.png'，清掉让它渲染时带上版本号重新拉取
    if (this.state.machine.image === 'machine.png') this.state.machine.image = '';
  },
  save() {
    const ts = new Date().toISOString();
    this._updatedAt = ts; // 记录本次写入时间，实时同步据此判断新旧
    if (CLOUD) {
      if (!this._cloudLoaded) return; // 尚未成功从云端加载，禁止用空状态覆盖云端数据
      // 1) 先写本机兜底（同步持久化，刷新/弱网/切后台也不丢）
      this._persistLocal(ts).catch(() => {});
      // 2) 再 upsert 云端
      sbClient().then(async (sb) => {
        if (!sb) return;
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        try { await sb.from('sewing_state').upsert({ user_id: user.id, data: this.state, updated_at: ts }); Store._lastCloudSync = ts; flashSynced(); }
        catch (_) { toast('⚠️ 云端保存失败，已保留在本机，请检查网络后重试'); }
      });
      return;
    }
    // 非云端：仅本机
    this._persistLocal(ts).catch(() => {});
  },
  seed() {
    // 首次进入 / 云端空：保持空白初始状态，不再预置任何示例数据（避免与用户真实数据混淆）
    this.state = DEFAULT_STATE();
  },
  // 跨天时重置当日打卡状态
  ensureDaily() {
    const r = this.state.rabbit;
    if (r.checkDate !== todayStr()) {
      r.checkIn = null; r.checkOut = null; r.checkDate = todayStr();
    }
  },
  async reset() { const db = await this._db(); if (db) await idbDel(db, KEY); else localStorage.removeItem(KEY); this.seed(); this.ensureDaily(); },
};

/* ---------- 统计计算 ---------- */
function computeStats() {
  const s = Store.state;
  const sessions = s.rabbit.sessions;
  const inMonth = (d) => d != null && monthStr(d) === monthStr(todayStr());
  const todayP = (d) => d === todayStr();
  const minOf = (pred) => sessions.filter(pred).reduce((a, x) => a + x.minutes, 0);
  const expOf = (pred) => [...s.fabrics, ...s.notions].filter(pred).reduce((a, x) => a + (Number(x.price) || 0), 0);
  const allSales = () => s.works.flatMap(w => w.sales || []);
  const incOf = (pred) => allSales().filter(e => e.date != null && pred(e.date)).reduce((a, e) => a + (Number(e.price) || 0) * (Number(e.qty) || 1), 0);

  return {
    today: { min: minOf(x => todayP(x.date)), exp: expOf(x => todayP(x.date)), inc: incOf(x => todayP(x.date)) },
    month: { min: minOf(x => inMonth(x.date)), exp: expOf(x => inMonth(x.date)), inc: incOf(x => inMonth(x.date)) },
    all:   { min: minOf(() => true),         exp: expOf(() => true),         inc: incOf(() => true) },
  };
}

/* ---------- 物料 / 作品汇总 ---------- */
function totalFabricExpense() { return Store.state.fabrics.reduce((a, x) => a + (Number(x.price) || 0), 0); }
function totalNotionExpense() { return Store.state.notions.reduce((a, x) => a + (Number(x.price) || 0), 0); }
function totalWorkIncome() {
  return Store.state.works.flatMap(w => w.sales || []).reduce((a, e) => a + (Number(e.price) || 0) * (Number(e.qty) || 1), 0);
}

/* ---------- 全局状态（UI） ---------- */
let current = 'home';
let currentWorkTab = 'self'; // 作品模块顶部切换：'self' 自用 / 'sell' 售卖
let workFilter = 'all'; // 自用模块内筛选：'all' 全部 / 'self' 自用中 / 'gift' 已赠出 / 'unused' 未使用
let statRange = 'today'; // today | month : all
let fabricFilter = { material: '', color: '', style: '' };
let notionFilter = { category: '' };
let liveTimer = null;

/* ---------- 渲染入口 ---------- */
const workspace = $('#workspace');
function render() {
  const map = { home: renderHome, fabric: renderFabric, notion: renderNotion, work: renderWork, tutorial: renderTutorial, inspiration: renderInspiration };
  workspace.innerHTML = (map[current] || renderHome)();
  bindSection();
  const total = Store.state.rabbit.cans + Store.state.rabbit.rewards;
  $('#sideCans').textContent = total;
  const tc = $('#topCans'); if (tc) tc.textContent = total;
  window.scrollTo(0, 0);
}

let _docBound = false;
function bindSection() {
  // 点击委托绑定到 document（导航按钮在侧边栏，不在 workspace 内）
  if (_docBound) return;
  _docBound = true;
  document.addEventListener('click', (e) => {
    // 外部链接跳转：兼容被沙箱 iframe 拦截的 target=_blank
    const jump = e.target.closest('[data-jump]');
    if (jump) { e.preventDefault(); openExternal(jump.dataset.jump); return; }

    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    ({
      nav: () => { current = t.dataset.target; $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.target === current)); render(); },
      'sew-start': () => openSewNameModal(),
      'sew-start-confirm': () => { const n = ($('#mSewName') || {}).value?.trim() || '未命名作品'; closeModal(); startSewing(n); },
      'sew-pause': pauseSewing,
      'sew-resume': resumeSewing,
      'sew-end': endSewing,
      'sew-resume-cancel': () => { const r = Store.state.rabbit; r.checkOut = null; Store.save(); startLiveTimer(); closeModal(); render(); toast('继续缝纫 ⏱'); },
      'star': () => {
        const wrap = t.closest('.stars'); if (!wrap) return;
        const val = Number(t.dataset.val);
        wrap.querySelectorAll('.star').forEach(s => s.classList.toggle('on', Number(s.dataset.val) <= val));
        const inp = wrap.parentElement.querySelector('input[type=hidden]');
        if (inp) inp.value = val;
      },
      'insp-draw': () => drawInspiration(t.dataset.type),
      'fabric-add': () => openFabricModal(),
      'fabric-edit': () => openFabricModal(t.dataset.id),
      'fabric-del': () => delItem('fabrics', t.dataset.id),
      'notion-add': () => openNotionModal(),
      'notion-edit': () => openNotionModal(t.dataset.id),
      'notion-del': () => delItem('notions', t.dataset.id),
      'fabric-used': () => toggleUsed('fabrics', t.dataset.id),
      'notion-used': () => toggleUsed('notions', t.dataset.id),
      'tutorial-add': () => openTutorialModal(),
      'tutorial-check': () => tutorialCheck(t.dataset.id),
      'tutorial-edit': () => openTutorialModal(t.dataset.id),
      'tutorial-del': () => delItem('tutorials', t.dataset.id),
      'work-add': () => openWorkModal(),
      'work-del': () => delItem('works', t.dataset.id),
      'work-sale': () => openSaleModal(t.dataset.id),
      'work-record': () => openRecordChooser(t.dataset.id),
      'work-edit': () => openWorkModal({ editId: t.dataset.id }),
      'work-tab': () => { currentWorkTab = t.dataset.tab; render(); },
      'work-filter': () => { workFilter = (workFilter === t.dataset.f) ? 'all' : t.dataset.f; render(); },
      'sale-add': () => saleAdd(t.dataset.id),
      'sale-del': () => saleDel(t.dataset.id, Number(t.dataset.idx)),
      'use-add': () => useAdd(t.dataset.id),
      'use-del': () => useDel(t.dataset.id, Number(t.dataset.idx)),
      'choose-self': () => openUseModal(t.dataset.id),
      'choose-gift': () => openSaleModal(t.dataset.id),
      'stat-range': () => { statRange = t.dataset.range; render(); },
      // 云端登录
      'cloud-signin': async () => {
        const sb = await sbClient(); if (!sb) return toast('云端库未就绪，请刷新页面后重试');
        const email = ($('#loginEmail') || {}).value?.trim();
        const pwd = ($('#loginPwd') || {}).value;
        if (!email || !pwd) return toast('请输入邮箱和密码');
        try {
          const { error } = await sb.auth.signInWithPassword({ email, password: pwd });
          if (error) return toast('登录失败：' + error.message);
          await afterLogin(sb);
        } catch (e) {
          toast('登录出错：' + (e && e.message ? e.message : e));
        }
      },
      'cloud-signup': async () => {
        const sb = await sbClient(); if (!sb) return toast('云端库未就绪，请刷新页面后重试');
        const email = ($('#loginEmail') || {}).value?.trim();
        const pwd = ($('#loginPwd') || {}).value;
        if (!email || !pwd) return toast('请输入邮箱和密码');
        if (pwd.length < 6) return toast('密码至少 6 位');
        try {
          const { data, error } = await sb.auth.signUp({ email, password: pwd });
          if (error) {
            if (/rate limit/i.test(error.message)) {
              return toast('注册被邮件限流拦截：请到 Supabase 后台 Authentication→Email 关闭「启用欢迎邮件」，再重试（无需等待）');
            }
            return toast('注册失败：' + error.message);
          }
          if (data.session) await afterLogin(sb);
          else toast('注册成功！请到邮箱点击验证链接，随后用同一邮箱密码登录');
        } catch (e) {
          toast('注册出错：' + (e && e.message ? e.message : e));
        }
      },
      'cloud-local': () => {
        CLOUD = false; SBUser = null;
        const m = $('#loginMask'); if (m) m.hidden = true;
        Store.load().then(finishBoot);
      },
      'cloud-signout': () => switchAccount(false),
      'cloud-sync': () => forceCloudSync(),
      // 左上角头像：点击弹出账号菜单
      'avatar-menu': () => openAvatarMenu(t),
      'avatar-switch': () => switchAccount(true),
      'avatar-signout': () => switchAccount(false),
      'avatar-export': () => exportData(),
      'avatar-import': () => importData(),
    }[a] || (() => {}))();
  });
}

/* ============================ 主页 ============================ */
function renderHome() {
  const r = Store.state.rabbit;
  const machine = Store.state.machine;
  const st = computeStats();
  const liveMin = liveTimer != null ? Math.floor((Date.now() - r.checkIn) / 60000) : null;

  const statBlock = (title, icon, data) => `
    <div class="stat-block">
      <h2>${icon} ${title}</h2>
      <div class="stat-tabs">
        <button class="stat-tab ${statRange === 'today' ? 'active' : ''}" data-action="stat-range" data-range="today">今日</button>
        <button class="stat-tab ${statRange === 'month' ? 'active' : ''}" data-action="stat-range" data-range="month">本月</button>
        <button class="stat-tab ${statRange === 'all' ? 'active' : ''}" data-action="stat-range" data-range="all">全部</button>
      </div>
      <div class="stat-cards">
        ${title.includes('时长') ? `
          <div class="stat-mini"><div class="v">${fmtMin(data.min)}</div><div class="k">总时长</div></div>
          <div class="stat-mini"><div class="v">${Math.floor(data.min / 30)}</div><div class="k">可换胡萝卜</div></div>
          <div class="stat-mini"><div class="v">${Math.round(data.min / 60 * 10) / 10}</div><div class="k">折合小时</div></div>
        ` : `
          <div class="stat-mini"><div class="v expense">${fmtMoney(data.exp)}</div><div class="k">布料采购支出</div></div>
          <div class="stat-mini"><div class="v income">${fmtMoney(data.inc)}</div><div class="k">作品收入</div></div>
          <div class="stat-mini"><div class="v ${data.inc - data.exp >= 0 ? 'income' : 'expense'}">${fmtMoney(data.inc - data.exp)}</div><div class="k">净收支</div></div>
        `}
      </div>
    </div>`;

  return `
  <div class="home-grid">
    <!-- 左上：缝纫机 + 兔兔 并排（缝纫机在前） -->
    <div class="home-row">
      <!-- 缝纫机 -->
      <div class="panel machine-card">
        <img class="machine-emoji" src="${esc(machine.image || ('machine.png' + IMG_VER))}" alt="缝纫机" />
        <h2 style="justify-content:center">${esc(machine.name || '瓜瓜小王')}</h2>
        <div class="sew-timer ${r.checkIn && !r.checkOut ? 'running' : ''}">
          ${r.checkIn && !r.checkOut ? `
            <div class="sew-time" id="liveTime">${fmtHMS(sewElapsedMs())}</div>
            <div class="sew-status">🧵 缝纫进行中 · 今天正在制作：<b>${esc(r.sewName || '未命名')}</b></div>
            <div class="sew-actions">
              ${r.pausedAt ? `<button class="btn green small" data-action="sew-resume">▶ 继续缝纫</button>` : `<button class="btn ghost small" data-action="sew-pause">⏸ 暂停</button>`}
              <button class="btn small" data-action="sew-end">⏹ 结束缝纫</button>
            </div>
          ` : `
            ${!r.checkOut ? `<div class="sew-hint-inline">今天也来缝一点吧 ♡</div>` : ''}
            <div class="sew-label">今日缝纫时间</div>
            <div class="sew-time">--:--:--</div>
            ${r.checkOut ? `<div class="sew-status">本次缝纫已结束，记得保存作品哦</div>` : ''}
            <button class="btn green sew-start-btn" data-action="sew-start">▶ 开始缝纫</button>
          `}
        </div>
      </div>

      <!-- 宠物兔兔 -->
      <div class="panel rabbit-card">
        <img class="rabbit-emoji" src="rabbit.png${IMG_VER}" alt="瓜织织" />
        <h2 style="justify-content:center">瓜织织</h2>
        <div class="rabbit-stats">
          <div><div class="num">🥕 ${r.cans}</div><div class="lbl">胡萝卜</div></div>
          <div><div class="num">⭐ ${r.rewards}</div><div class="lbl">收入奖励</div></div>
        </div>
        <p class="hint" style="font-size:11px;color:var(--ink-soft);margin-top:8px">每缝纫 30 分钟换 1 根胡萝卜</p>
      </div>
    </div>

    <!-- 右：统计 -->
    <div>
      <div class="panel">
        <h2>📊 数据统计</h2>
        ${statBlock('⏱️ 工作时长', '⏱️', st[statRange])}
        ${statBlock('💰 收支统计', '💰', st[statRange])}
      </div>
    </div>
  </div>`;
}

function randomTutorial(exceptId) {
  const list = Store.state.tutorials.filter(t => t.id !== exceptId);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function openSewNameModal() {
  openModal(`
    <h2>🧵 开始缝纫</h2>
    <p class="hint">给今天要做的作品起个名字吧～</p>
    <div class="field"><label>作品名称</label><input id="mSewName" placeholder="如：帆布收纳包" autocomplete="off" /></div>
    <div class="modal-actions">
      <button class="btn ghost" data-mclose>取消</button>
      <button class="btn" data-action="sew-start-confirm">开始缝纫 ▶</button>
    </div>
  `);
  setTimeout(() => { const e = $('#mSewName'); if (e) e.focus(); }, 60);
}
function startSewing(name) {
  const r = Store.state.rabbit;
  r.checkIn = Date.now(); r.checkOut = null; r.pausedAt = null; r.pausedTotal = 0;
  r.sewName = name || '未命名作品'; r.checkDate = todayStr();
  Store.save(); startLiveTimer(); toast('开始缝纫啦，加油 🧵'); render();
}
function pauseSewing() {
  const r = Store.state.rabbit;
  if (!r.checkIn || r.checkOut || r.pausedAt) return;
  r.pausedAt = Date.now(); stopLiveTimer(); Store.save(); render();
}
function resumeSewing() {
  const r = Store.state.rabbit;
  if (!r.pausedAt) return;
  r.pausedTotal = (r.pausedTotal || 0) + (Date.now() - r.pausedAt);
  r.pausedAt = null; Store.save(); startLiveTimer(); render();
}
function endSewing() {
  const r = Store.state.rabbit;
  if (!r.checkIn || r.checkOut) return;
  r.checkOut = Date.now(); stopLiveTimer(); Store.save(); render();
  openWorkModal({ fromSew: true });
}
function sewElapsedMs() {
  const r = Store.state.rabbit;
  if (!r.checkIn) return 0;
  const end = r.checkOut || Date.now();
  const paused = (r.pausedTotal || 0) + (r.pausedAt ? Date.now() - r.pausedAt : 0);
  return Math.max(0, end - r.checkIn - paused);
}
function startLiveTimer() {
  stopLiveTimer();
  liveTimer = setInterval(() => {
    const el = $('#liveTime');
    if (el && Store.state.rabbit.checkIn && !Store.state.rabbit.checkOut) el.textContent = fmtHMS(sewElapsedMs());
  }, 1000);
}
function stopLiveTimer() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

function drawInspiration() {
  // 主页灵感抽取 -> 刷新主页的抽取卡片
  render();
  toast('换了一个新灵感 ✨');
}

/* ============================ 布料 ============================ */
function renderFabric() {
  const s = Store.state;
  const materials = [...new Set(s.fabrics.map(f => f.material))].filter(Boolean);
  const colors = [...new Set(s.fabrics.map(f => f.color))].filter(Boolean);
  const styles = [...new Set(s.fabrics.map(f => f.style))].filter(Boolean);
  const list = s.fabrics.filter(f =>
    (!fabricFilter.material || f.material === fabricFilter.material) &&
    (!fabricFilter.color || f.color === fabricFilter.color) &&
    (!fabricFilter.style || f.style === fabricFilter.style)
  ).sort((a, b) => (a.usedUp ? 1 : 0) - (b.usedUp ? 1 : 0));

  const opt = (arr, v) => ['<option value="">全部</option>', ...arr.map(x => `<option value="${esc(x)}" ${v === x ? 'selected' : ''}>${esc(x)}</option>`)].join('');

  const cards = list.length ? list.map(f => `
    <div class="card ${f.usedUp ? 'used-up' : ''}">
      <div class="card-img">${f.image ? `<img src="${f.image}"/>` : '🧵'}</div>
      <div class="card-body">
        <h3>${esc(f.name)}</h3>
        <div class="spec-highlight">
          <span class="sh-size">📏 ${esc(f.size) || '—'}</span>
          <span class="sh-price">${fmtMoney(f.price)}</span>
        </div>
        <div class="tag-row">
          <span class="tag">${esc(f.material)}</span>
          <span class="tag">${esc(f.color)}</span>
          <span class="tag alt">${esc(f.style)}</span>
        </div>
        <div class="card-meta">渠道：${esc(f.channel) || '—'}${f.link ? `<br><a href="${esc(f.link)}" target="_blank" rel="noopener noreferrer" data-jump="${esc(f.link)}" title="点击复制链接" style="color:var(--pink-deep);cursor:pointer">复制购买链接 🔗</a>` : ''}</div>
        <div class="card-actions">
          <button class="btn ghost small ${f.usedUp ? 'is-used' : ''}" data-action="fabric-used" data-id="${f.id}">${f.usedUp ? '已用完' : '用完'}</button>
          <button class="btn ghost small" data-action="fabric-edit" data-id="${f.id}">编辑</button>
          <button class="del-x" data-action="fabric-del" data-id="${f.id}">删除</button>
        </div>
      </div>
    </div>`).join('') : emptyState('🧵', '还没有布料，点右上角添加吧');

  return `
  <div class="sum-bar exp"><span class="lbl">💸 布料总支出</span><span class="val">${fmtMoney(totalFabricExpense())}</span></div>
  <div class="section-head">
    <button class="btn" data-action="fabric-add">＋ 添加布料</button>
  </div>
  <div class="filter-bar">
    <div class="fgroup"><label>材质</label><select id="fMaterial">${opt(materials, fabricFilter.material)}</select></div>
    <div class="fgroup"><label>颜色</label><select id="fColor">${opt(colors, fabricFilter.color)}</select></div>
    <div class="fgroup"><label>风格</label><select id="fStyle">${opt(styles, fabricFilter.style)}</select></div>
    <button class="btn ghost small" id="fClear">清除筛选</button>
  </div>
  <div class="grid">${cards}</div>`;
}

/* ============================ 辅料 ============================ */
function renderNotion() {
  const s = Store.state;
  const cats = [...new Set(s.notions.map(n => n.category))].filter(Boolean);
  const list = s.notions.filter(n => (!notionFilter.category || n.category === notionFilter.category))
    .sort((a, b) => (a.usedUp ? 1 : 0) - (b.usedUp ? 1 : 0));
  const opt = (arr, v) => ['<option value="">全部</option>', ...arr.map(x => `<option value="${esc(x)}" ${v === x ? 'selected' : ''}>${esc(x)}</option>`)].join('');

  const cards = list.length ? list.map(n => `
    <div class="card ${n.usedUp ? 'used-up' : ''}">
      <div class="card-img">${n.image ? `<img src="${n.image}"/>` : '📎'}</div>
      <div class="card-body">
        <h3>${esc(n.name)} <span class="price">${fmtMoney(n.price)}</span></h3>
        <div class="tag-row"><span class="tag">${esc(n.category)}</span><span class="tag alt">×${n.count}</span></div>
        <div class="card-meta">尺寸：${esc(n.size)}<br>渠道：${esc(n.channel) || '—'}${n.link ? `<br><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" data-jump="${esc(n.link)}" title="点击复制链接" style="color:var(--pink-deep);cursor:pointer">复制购买链接 🔗</a>` : ''}</div>
        <div class="card-actions">
          <button class="btn ghost small ${n.usedUp ? 'is-used' : ''}" data-action="notion-used" data-id="${n.id}">${n.usedUp ? '已用完' : '用完'}</button>
          <button class="btn ghost small" data-action="notion-edit" data-id="${n.id}">编辑</button>
          <button class="del-x" data-action="notion-del" data-id="${n.id}">删除</button>
        </div>
      </div>
    </div>`).join('') : emptyState('📎', '还没有辅料，点右上角添加吧');

  return `
  <div class="sum-bar exp"><span class="lbl">💸 辅料总支出</span><span class="val">${fmtMoney(totalNotionExpense())}</span></div>
  <div class="section-head">
    <button class="btn" data-action="notion-add">＋ 添加辅料</button>
  </div>
  <div class="filter-bar">
    <div class="fgroup"><label>类别</label><select id="nCat">${opt(cats, notionFilter.category)}</select></div>
    <button class="btn ghost small" id="nClear">清除筛选</button>
  </div>
  <div class="grid">${cards}</div>`;
}

/* ============================ 教程 ============================ */
function renderTutorial() {
  const s = Store.state;
  const cards = s.tutorials.length ? s.tutorials.map(t => {
    const wk = t.workId ? s.works.find(w => w.id === t.workId) : null;
    const workOpts = ['<option value="">关联作品…</option>', ...s.works.map(w => `<option value="${w.id}" ${t.workId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`)].join('');
    return `
    <div class="card">
      <div class="card-img">${t.image ? `<img src="${t.image}"/>` : (t.type === '视频' ? '🎬' : '📒')}</div>
      <div class="card-body">
        <h3>${esc(t.title)} ${t.checked ? '<span class="sale-flag sold">已打卡</span>' : ''}</h3>
        <div class="tag-row"><span class="tag">${esc(t.type)}</span><span class="tag alt">${esc(t.platform)}</span></div>
        <div class="card-meta">${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener noreferrer" data-jump="${esc(t.link)}" title="点击复制链接" style="color:var(--pink-deep);cursor:pointer">复制链接 🔗</a>` : '暂无链接'}</div>
        <div class="field" style="margin:10px 0 0">
          <select class="linkWork" data-id="${t.id}" style="width:100%">${workOpts}</select>
        </div>
        ${wk ? `<div class="link-badge">🔗 已关联：${esc(wk.name)}</div>` : ''}
        <div class="card-actions">
          <button class="btn green small" data-action="tutorial-check" data-id="${t.id}">${t.checked ? '取消打卡' : '打卡'}</button>
          <button class="btn ghost small" data-action="tutorial-edit" data-id="${t.id}">编辑</button>
          <button class="del-x" data-action="tutorial-del" data-id="${t.id}">删除</button>
        </div>
      </div>
    </div>`;
  }).join('') : emptyState('📚', '还没有教程，粘贴小红书 / 抖音链接添加吧');

  return `
  <div class="section-head">
    <button class="btn" data-action="tutorial-add">＋ 添加教程</button>
  </div>
  <div class="grid">${cards}</div>`;
}

/* ============================ 作品 ============================ */
function renderWork() {
  const s = Store.state;
  const isSell = currentWorkTab === 'sell';
  let list = s.works.filter(w => (w.type || 'self') === (isSell ? 'sell' : 'self'));
  if (!isSell && workFilter !== 'all') {
    list = list.filter(w => {
      const gifted = (w.sales || []).length > 0;
      const used = (w.uses || []).length > 0;
      if (workFilter === 'gift') return gifted;
      if (workFilter === 'self') return !gifted && used;
      if (workFilter === 'unused') return !gifted && !used;
      return true;
    });
  }
  const cards = list.length ? list.map(w => {
    const t = w.tutorialId ? s.tutorials.find(x => x.id === w.tutorialId) : null;
    const recs = w.sales || [];
    const soldCount = recs.length;
    const income = recs.reduce((a, e) => a + (Number(e.price) || 0) * (Number(e.qty) || 1), 0);
    const isS = (w.type || 'self') === 'sell';
    return `
    <div class="card">
      <div class="card-img">${w.image ? `<img src="${w.image}"/>` : (isS ? '💰' : '🎀')}</div>
      <div class="card-body">
        <h3>${esc(w.name)} ${isS && w.price ? `<span class="price">${fmtMoney(w.price)}</span>` : ''}</h3>
        ${w.fabric ? `<div class="card-meta">🧵 使用布料：${esc(w.fabric)}</div>` : ''}
        <div class="card-meta">📅 ${esc(w.date || '—')}</div>
        <div class="card-meta">⏱ ${w.durationMin ? fmtMin(w.durationMin) : '—'}</div>
        ${w.difficulty ? `<div class="card-meta stars-static">✂️ 难度 ${starStr(w.difficulty)}</div>` : ''}
        ${w.like ? `<div class="card-meta stars-static">❤️ 喜欢 ${starStr(w.like)}</div>` : ''}
        ${isS
          ? (soldCount
              ? `<div class="tag-row"><span class="sale-flag sold">已售 ${soldCount} 件</span><span class="sale-flag">共 ${fmtMoney(income)}</span></div>`
              : `<div class="tag-row"><span class="sale-flag unsold">未售出</span></div>`)
          : `<div class="tag-row">${soldCount
              ? `<span class="sale-flag sold">🎁 已赠出</span>`
              : ((w.uses || []).length
                  ? `<span class="sale-flag selfuse">🏠 自用中</span>`
                  : `<span class="sale-flag unsold">📦 未使用</span>`)}</div>`}
        ${t ? `<div class="link-badge">📚 关联教程：${esc(t.title)}</div>` : ''}
        <div class="card-actions">
          ${!isS ? `<button class="btn small ${soldCount || (w.uses || []).length ? 'recorded' : ''}" data-action="work-record" data-id="${w.id}">${soldCount ? '已赠' : (w.uses || []).length ? '已用' : '用赠'}</button>` : ''}
          ${isS ? `<button class="btn small" data-action="work-sale" data-id="${w.id}">售卖</button>` : ''}
          <button class="btn ghost small" data-action="work-edit" data-id="${w.id}">编辑</button>
          <button class="del-x" data-action="work-del" data-id="${w.id}">删除</button>
        </div>
      </div>
    </div>`;
  }).join('') : emptyState(isSell ? '💰' : '🎀', isSell ? '还没有售卖作品，点上面添加吧' : '还没有自用作品，去做第一个吧');

  const sumHtml = isSell
    ? `<div class="sum-bar inc"><span class="lbl">💰 售卖总收入</span><span class="val">${fmtMoney(totalWorkIncome())}</span></div>`
    : (() => { const selfAll = s.works.filter(w => (w.type || 'self') === 'self'); const gifted = selfAll.filter(w => (w.sales || []).length > 0).length; return `<div class="sum-bar gift"><span class="lbl">🏠 全部 / 🎁 已赠出</span><span class="val">${selfAll.length} 件 / ${gifted} 件</span></div>`; })();

  return `
  <div class="stat-tabs" style="margin-bottom:14px">
    <button class="stat-tab ${!isSell ? 'active' : ''}" data-action="work-tab" data-tab="self">🏠 自用</button>
    <button class="stat-tab ${isSell ? 'active' : ''}" data-action="work-tab" data-tab="sell">💰 售卖</button>
  </div>
  ${sumHtml}
  <div class="section-head">
    <button class="btn" data-action="work-add">＋ 添加${isSell ? '售卖作品' : '作品'}</button>
  </div>
  ${!isSell ? `
  <div class="work-filter">
    <button class="wf-btn ${workFilter === 'self' ? 'on' : ''}" data-action="work-filter" data-f="self">自用</button>
    <button class="wf-btn ${workFilter === 'gift' ? 'on' : ''}" data-action="work-filter" data-f="gift">赠出</button>
    <button class="wf-btn ${workFilter === 'unused' ? 'on' : ''}" data-action="work-filter" data-f="unused">未用</button>
  </div>` : ''}
  <div class="grid">${cards}</div>`;
}

/* ============================ 灵感 ============================ */
function renderInspiration() {
  const s = Store.state;
  // 配色灵感：基于现有布料/辅料颜色给出推荐
  const colors = [...new Set([
    ...s.fabrics.map(f => f.color).filter(Boolean),
    ...s.notions.map(n => n.color).filter(Boolean),
  ])];
  const palette = buildPalette(colors);

  const inspWork = randomTutorial();

  const swatches = palette.map(c => `<div class="swatch" style="background:${c.hex}"><span>${esc(c.name)}</span></div>`).join('');

  return `
  <div class="home-grid">
    <div class="panel draw-card">
      <h2 style="justify-content:center">🎀 作品灵感</h2>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:12px">从教程库随机抽取一个灵感，不想要就换一个</p>
      ${inspWork ? `
        <div class="draw-thumb">${inspWork.image ? `<img src="${inspWork.image}"/>` : '📚'}</div>
        <div class="draw-title">${esc(inspWork.title)}</div>
        <div class="draw-meta">${inspWork.type} · ${esc(inspWork.platform)}</div>
      ` : '<div class="empty"><div class="big">📭</div>暂无教程可抽取</div>'}
      <button class="btn ghost small" data-action="insp-draw" data-type="work">🎲 换一个灵感</button>
    </div>

    <div class="panel">
      <h2>🎨 配色灵感</h2>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">基于你现有的${colors.length ? colors.length + '种' : '（暂无）'}布料/辅料颜色智能推荐</p>
      ${palette.length ? `
        <div class="palette-row">${swatches}</div>
        <div class="palette-names">${palette.map(c => esc(c.name)).join(' · ')}</div>
        <div style="text-align:center;margin-top:14px"><button class="btn ghost small" data-action="insp-draw" data-type="color">🎨 换一组配色</button></div>
      ` : '<div class="empty"><div class="big">🌈</div>先去布料/辅料添加带颜色的材料吧</div>'}
    </div>
  </div>`;
}

// 简易配色推荐：从已有颜色 + 协调色生成
const COLOR_HEX = {
  '奶油白': '#fdf6ec', '樱花粉': '#ffc4d6', '薄荷绿': '#b8e6cf', '雾霾蓝': '#aacbe3',
  '鹅黄': '#ffe9a8', '薰衣草紫': '#d9c2f0', '焦糖棕': '#c79a6b', '复古红': '#d96b6b',
  '米白': '#f5efe6', '天蓝': '#bfe3f2', '奶绿': '#cfe8c2', '灰粉': '#e9c9d4',
};
function buildPalette(colors) {
  const base = (colors[Math.floor(Math.random() * colors.length)] || '樱花粉');
  const pick = (n) => {
    const pool = Object.keys(COLOR_HEX).filter(c => c !== base);
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  };
  const names = [base, ...pick(3)];
  return names.map(n => ({ name: n, hex: COLOR_HEX[n] || '#ffd3e3' }));
}

/* ---------- 空状态 ---------- */
function emptyState(icon, text) {
  return `<div class="empty" style="grid-column:1/-1"><div class="big">${icon}</div>${text}</div>`;
}

/* ============================ 弹窗 ============================ */
const mask = $('#modalMask'), box = $('#modalBox');
function openModal(html) { box.innerHTML = html; mask.hidden = false; bindModal(); }
function closeModal() { mask.hidden = true; box.innerHTML = ''; }
mask.onclick = (e) => { if (e.target === mask) closeModal(); };

/* ---------- 上传后裁剪（横版 4:3） ---------- */
function openCropper(src, cb) {
  const overlay = document.createElement('div');
  overlay.className = 'cropper-overlay';
  overlay.innerHTML = `
    <div class="cropper-panel">
      <div class="cropper-title">调整裁剪范围 <small>横版 4:3</small></div>
      <div class="cropper-stage" id="cropStage">
        <img id="cropImg" src="${src}" alt="裁剪图"/>
        <div class="cropper-grid"></div>
      </div>
      <div class="cropper-zoom">
        <span>🔍</span>
        <input type="range" id="cropZoom" min="1" max="3" step="0.01" value="1"/>
      </div>
      <div class="cropper-tip">拖动图片调整位置，滑动缩放裁剪范围</div>
      <div class="cropper-actions">
        <button class="btn ghost" id="cropCancel">取消</button>
        <button class="btn" id="cropOk">确认裁剪</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('#cropStage');
  const img = overlay.querySelector('#cropImg');
  const zoom = overlay.querySelector('#cropZoom');
  const STAGE_W = stage.clientWidth, STAGE_H = stage.clientHeight;
  if (!STAGE_W || !STAGE_H) { overlay.remove(); cb(src); return; }
  let iw = 0, ih = 0, coverScale = 1, s = 1, panX = 0, panY = 0;

  function clamp() {
    const eff = s * coverScale;
    const dw = iw * eff, dh = ih * eff;
    let left = (STAGE_W - dw) / 2 + panX;
    let top = (STAGE_H - dh) / 2 + panY;
    const minLeft = STAGE_W - dw, minTop = STAGE_H - dh;
    if (left > 0) left = 0; if (left < minLeft) left = minLeft;
    if (top > 0) top = 0; if (top < minTop) top = minTop;
    return { eff, left, top, dw, dh };
  }
  function render() {
    const { eff, left, top } = clamp();
    img.style.width = iw + 'px';
    img.style.height = ih + 'px';
    img.style.transformOrigin = '0 0';
    img.style.transform = `translate(${left}px, ${top}px) scale(${eff})`;
  }
  img.onload = () => {
    iw = img.naturalWidth; ih = img.naturalHeight;
    coverScale = Math.max(STAGE_W / iw, STAGE_H / ih);
    s = 1; panX = 0; panY = 0; render();
  };
  img.onerror = () => { overlay.remove(); cb(src); };

  zoom.addEventListener('input', () => { s = parseFloat(zoom.value) || 1; render(); });

  let dragging = false, lastX = 0, lastY = 0;
  img.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panX += e.clientX - lastX; panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY; render();
  });
  const endDrag = () => { dragging = false; };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  overlay.querySelector('#cropCancel').onclick = () => overlay.remove();
  overlay.querySelector('#cropOk').onclick = () => {
    const { eff, left, top } = clamp();
    const sx = -left / eff, sy = -top / eff, sw = STAGE_W / eff, sh = STAGE_H / eff;
    const OUT_W = 800, OUT_H = 600;
    const out = document.createElement('canvas');
    out.width = OUT_W; out.height = OUT_H;
    out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H);
    let data;
    try { data = out.toDataURL('image/jpeg', 0.82); }
    catch (_) { data = src; }
    overlay.remove();
    cb(data);
  };
}

function bindModal() {
  $$('[data-mclose]', box).forEach(b => b.onclick = closeModal);
  $$('[data-msave]', box).forEach(b => b.onclick = () => (modalSave[b.dataset.msave] || (() => {}))());
  // 图片上传：纯手动，仅存为预览图，不读取/识别图片内容；上传后弹出 4:3 横版裁剪
  const fileInput = $('#mFile', box);
  if (fileInput) fileInput.onchange = () => {
    const f = fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      openCropper(reader.result, (data) => {
        const preview = $('#mPreview', box);
        if (preview) { preview.src = data; preview.hidden = false; }
        const imgInput = $('#mImage', box);
        if (imgInput) imgInput.value = data;
      });
    };
    reader.readAsDataURL(f);
  };
  // 规格行增删（同一条链接多颜色/规格）
  const refreshDel = () => {
    const rows = $$('.spec-row', box);
    rows.forEach(r => { const d = $('.spec-del', r); if (d) d.style.display = rows.length > 1 ? '' : 'none'; });
  };
  refreshDel();
  box.onclick = (e) => {
    const add = e.target.closest('#addSpec');
    if (add) {
      const list = $('#specList', box);
      if (list) list.insertAdjacentHTML('beforeend', add.dataset.spec === 'notion' ? notionSpecRow() : fabricSpecRow());
      refreshDel();
    } else if (e.target.closest('.spec-del')) {
      const row = e.target.closest('.spec-row');
      if (row && $$('.spec-row', box).length > 1) row.remove();
      refreshDel();
    }
  };
}

const modalSave = {
  fabric() {
    const v = readForm();
    if (!v.name) return toast('请填写布料名称');
    const rows = $$('.spec-row', box).map(r => ({
      color: $('.spec-color', r)?.value.trim() || '',
      material: $('.spec-material', r)?.value.trim() || '',
      size: $('.spec-size', r)?.value.trim() || '',
      price: $('.spec-price', r)?.value.trim() || '',
    }));
    // 编辑已有布料：直接更新单条记录
    if (v.editId) {
      const f = Store.state.fabrics.find(x => x.id === v.editId);
      if (!f) return;
      const sp = rows[0] || {};
      Object.assign(f, {
        name: v.name, image: v.image || f.image, material: sp.material, color: sp.color,
        style: v.style, size: sp.size, price: sp.price, channel: v.channel, link: v.link,
        usedUp: !!f.usedUp,
      });
      Store.save(); closeModal(); toast('布料已修改 🧵'); render();
      return;
    }
    const valid = rows.filter(r => r.color || r.material || r.size || r.price);
    const list = valid.length ? valid : [rows[0] || { color: '', material: '', size: '', price: '' }];
    list.forEach(sp => {
      Store.state.fabrics.unshift({ id: uid(), name: v.name, image: v.image, material: sp.material, color: sp.color, style: v.style, size: sp.size, price: sp.price, channel: v.channel, link: v.link, date: todayStr(), usedUp: false });
    });
    Store.save(); closeModal(); toast(`已添加 ${list.length} 条布料 🧵`); render();
  },
  notion() {
    const v = readForm();
    if (!v.name) return toast('请填写辅料名称');
    const rows = $$('.spec-row', box).map(r => ({
      color: $('.spec-color', r)?.value.trim() || '',
      count: $('.spec-count', r)?.value.trim() || 1,
      size: $('.spec-size', r)?.value.trim() || '',
      price: $('.spec-price', r)?.value.trim() || '',
    }));
    // 编辑已有辅料：直接更新单条记录，保留已用完状态
    if (v.editId) {
      const n = Store.state.notions.find(x => x.id === v.editId);
      if (!n) return;
      const sp = rows[0] || {};
      Object.assign(n, {
        name: v.name, image: v.image || n.image, category: v.category, count: sp.count,
        size: sp.size, price: sp.price, channel: v.channel, link: v.link, usedUp: !!n.usedUp,
      });
      Store.save(); closeModal(); toast('辅料已修改 📎'); render();
      return;
    }
    const valid = rows.filter(r => r.color || r.size || r.price);
    const list = valid.length ? valid : [rows[0] || { color: '', count: 1, size: '', price: '' }];
    list.forEach(sp => {
      Store.state.notions.unshift({ id: uid(), name: v.name, image: v.image, category: v.category, count: sp.count, size: sp.size, price: sp.price, channel: v.channel, link: v.link, date: todayStr(), usedUp: false });
    });
    Store.save(); closeModal(); toast(`已添加 ${list.length} 条辅料 📎`); render();
  },
  tutorial() {
    const v = readForm();
    if (!v.name) return toast('请填写教程标题');
    if (v.editId) {
      const t = Store.state.tutorials.find(x => x.id === v.editId);
      if (t) Object.assign(t, { title: v.name, type: v.type, platform: v.platform, link: v.link, image: v.image || t.image });
    } else {
      Store.state.tutorials.unshift({ id: uid(), title: v.name, type: v.type, platform: v.platform, link: v.link, image: v.image, workId: '', checked: false, date: todayStr() });
    }
    Store.save(); closeModal(); toast(v.editId ? '教程已更新 📚' : '教程已添加 📚'); render();
  },
  work() {
    const v = readForm();
    if (!v.name) return toast('请填写作品名称');
    const fabricId = v.fabricId || '';
    const fabObj = fabricId ? Store.state.fabrics.find(f => f.id === fabricId) : null;
    const fabric = fabObj ? fabObj.name : '';
    const durationMin = Number(v.duration) || 0;
    const date = v.date || todayStr();
    const difficulty = Number(v.difficulty) || 0;
    const like = Number(v.like) || 0;
    const price = Number(v.price) || 0;
    const image = v.image || '';
    const tutorialId = v.tutorialId || '';
    if (v.editId) {
      const w = Store.state.works.find(x => x.id === v.editId);
      if (w) Object.assign(w, { name: v.name, image, fabric, fabricId, durationMin, date, difficulty, like, price, tutorialId });
      Store.save(); closeModal(); toast('作品已更新 🎀'); render();
      return;
    }
    Store.state.works.unshift({ id: uid(), name: v.name, image, fabric, fabricId, durationMin, date, difficulty, like, price, tutorialId, sales: [], uses: [], type: (v.fromSew ? 'self' : currentWorkTab) });
    if (v.fromSew) {
      const r = Store.state.rabbit;
      const cans = Math.floor(durationMin / 30);
      r.cans += cans;
      r.sessions.push({ id: uid(), date, start: Number(v.sewStart) || r.checkIn, end: Number(v.sewEnd) || r.checkOut, minutes: durationMin, cans });
      r.checkIn = null; r.checkOut = null; r.pausedAt = null; r.pausedTotal = 0; r.sewName = '';
      if (r.checkDate !== todayStr()) r.checkDate = todayStr();
      Store.save(); closeModal();
      if (cans > 0) confetti();
      toast(`作品已保存！缝纫 ${fmtMin(durationMin)}，获得 ${cans} 根胡萝卜 🥕`);
      render();
    } else {
      Store.save(); closeModal(); toast('作品已保存 🎀'); render();
    }
  },
  sale() {
    // 售卖情况改为多条记录，保存按钮仅关闭；新增/删除在 sale-add / sale-del 中即时落库
    closeModal(); render();
  },
};
// 在售卖/赠出弹窗内新增一条记录。售卖作品：日期·买家·价格·数量；自用作品：日期·友人·数量·备注
function saleAdd(id) {
  const w = Store.state.works.find(x => x.id === id);
  if (!w) return;
  const isS = (w.type || 'self') === 'sell';
  const date = ($('#mDate', box)?.value.trim()) || todayStr();
  const buyer = ($('#mBuyer', box)?.value.trim()) || '';
  const price = ($('#mSalePrice', box)?.value.trim()) || '';
  const qty = ($('#mQty', box)?.value.trim()) || '1';
  const note = ($('#mNote', box)?.value.trim()) || '';
  if (isS) { if (!price && !buyer) return toast('请至少填写价格或买家'); }
  else { if (!buyer && !note) return toast('请至少填写友人或备注'); }
  w.sales = w.sales || [];
  w.sales.push({ date, buyer, price: Number(price) || 0, qty: Number(qty) || 1, note });
  Store.save();
  render();
  toast(isS ? '已添加一条售卖记录 💰' : '已添加一条赠出记录 🎁');
  openSaleModal(id);
}
function saleDel(id, idx) {
  const w = Store.state.works.find(x => x.id === id);
  if (!w || !w.sales) return;
  w.sales.splice(idx, 1);
  Store.save();
  render();
  openSaleModal(id);
}
function readForm() {
  const g = (id) => { const e = $('#' + id, box); return e ? e.value.trim() : ''; };
  return {
    name: g('mName'), image: g('mImage'), material: g('mMaterial'), color: g('mColor'),
    style: g('mStyle'), size: g('mSize'), price: g('mPrice'), channel: g('mChannel'),
    link: g('mLink'), category: g('mCategory'), count: g('mCount'), type: g('mType'),
    platform: g('mPlatform'), tutorialId: g('mTutorial'), editId: g('mEditId'),
    saleId: g('mSaleId'), salePrice: g('mSalePrice'), buyer: g('mBuyer'),
    fabricId: g('mFabric'), difficulty: g('mDifficulty'), like: g('mLike'),
    duration: g('mDuration'), date: g('mDate'), fromSew: g('mFromSew'),
    sewStart: g('mSewStart'), sewEnd: g('mSewEnd'),
  };
}

function platformOptions(sel) {
  return PLATFORMS.map(p => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');
}

/* 规格/颜色明细行：一个链接可对应多个颜色、尺寸、价格 */
function fabricSpecRow(sp = {}) {
  return `<div class="spec-row">
    <div class="field-row">
      <div class="field"><input class="spec-color" placeholder="颜色" value="${esc(sp.color || '')}"></div>
      <div class="field"><input class="spec-material" placeholder="材质" value="${esc(sp.material || '')}"></div>
      <div class="field"><input class="spec-size" placeholder="尺寸" value="${esc(sp.size || '')}"></div>
      <div class="field"><input class="spec-price" type="number" placeholder="价格" value="${esc(sp.price || '')}"></div>
      <button class="btn ghost small spec-del" type="button" title="删除该规格">✕</button>
    </div>
  </div>`;
}
function notionSpecRow(sp = {}) {
  return `<div class="spec-row">
    <div class="field-row">
      <div class="field"><input class="spec-color" placeholder="颜色/规格" value="${esc(sp.color || '')}"></div>
      <div class="field"><input class="spec-count" type="number" placeholder="数量" value="${esc(sp.count || 1)}"></div>
      <div class="field"><input class="spec-size" placeholder="尺寸" value="${esc(sp.size || '')}"></div>
      <div class="field"><input class="spec-price" type="number" placeholder="价格" value="${esc(sp.price || '')}"></div>
      <button class="btn ghost small spec-del" type="button" title="删除该行">✕</button>
    </div>
  </div>`;
}

function openFabricModal(editId) {
  const f = editId ? Store.state.fabrics.find(x => x.id === editId) : null;
  const imgHtml = f && f.image
    ? `<img id="mPreview" class="preview-img" src="${f.image}"/>`
    : `<img id="mPreview" class="preview-img" hidden />`;
  openModal(`
    <h2>🧵 ${f ? '编辑布料' : '添加布料'}</h2>
    <input id="mEditId" type="hidden" value="${editId || ''}" />
    <div class="upload-box">
      <label class="file-drop" for="mFile">📷 上传布料图片（点击选择 / 拍照）</label>
      <input id="mFile" type="file" accept="image/*" hidden />
      ${imgHtml}
      <input id="mImage" type="hidden" value="${f && f.image ? f.image : ''}" />
    </div>
    <div class="field"><label>名称 *</label><input id="mName" value="${f ? esc(f.name) : ''}" placeholder="如：樱花粉雪纺" /></div>
    <div class="field-row">
      <div class="field"><label>风格</label><input id="mStyle" value="${f ? esc(f.style) : ''}" placeholder="日系 / 法式 …" /></div>
      <div class="field"><label>购买渠道</label><select id="mChannel">${platformOptions(f ? f.channel : '')}</select></div>
    </div>
    <div class="field"><label>购买链接（选填，仅记录用）</label><input id="mLink" value="${f ? esc(f.link || '') : ''}" placeholder="粘贴购买链接，仅作记录，不会自动识别" /></div>
    <div class="section-sub">颜色 / 规格明细 <span class="muted">同一种布料的不同颜色、尺寸各加一行，保存时各生成一条</span></div>
    <div id="specList">${f ? fabricSpecRow({ color: f.color, material: f.material, size: f.size, price: f.price }) : fabricSpecRow()}</div>
    ${f ? '' : `<button class="btn ghost small" id="addSpec" data-spec="fabric" type="button" style="margin-top:8px">＋ 添加颜色/规格</button>`}
    <div class="modal-actions"><button class="btn ghost" data-mclose>取消</button><button class="btn" data-msave="fabric">${f ? '保存修改' : '保存布料'}</button></div>
  `);
}

function openNotionModal(editId) {
  const n = editId ? Store.state.notions.find(x => x.id === editId) : null;
  const imgHtml = n && n.image
    ? `<img id="mPreview" class="preview-img" src="${n.image}"/>`
    : `<img id="mPreview" class="preview-img" hidden />`;
  openModal(`
    <h2>📎 ${n ? '编辑辅料' : '添加辅料'}</h2>
    <input id="mEditId" type="hidden" value="${editId || ''}" />
    <div class="upload-box">
      <label class="file-drop" for="mFile">📷 上传辅料图片（点击选择 / 拍照）</label>
      <input id="mFile" type="file" accept="image/*" hidden />
      ${imgHtml}
      <input id="mImage" type="hidden" value="${n && n.image ? n.image : ''}" />
    </div>
    <div class="field"><label>名称 *</label><input id="mName" value="${n ? esc(n.name) : ''}" placeholder="如：珍珠扣" /></div>
    <div class="field-row">
      <div class="field"><label>类别</label><input id="mCategory" value="${n ? esc(n.category) : ''}" placeholder="扣子 / 拉链 / 花边 …" /></div>
      <div class="field"><label>购买渠道</label><select id="mChannel">${platformOptions(n ? n.channel : '')}</select></div>
    </div>
    <div class="field"><label>购买链接（选填，仅记录用）</label><input id="mLink" value="${n ? esc(n.link || '') : ''}" placeholder="粘贴购买链接，仅作记录，不会自动识别" /></div>
    <div class="section-sub">规格明细 <span class="muted">不同颜色 / 尺寸的辅料各加一行，保存时各生成一条</span></div>
    <div id="specList">${n ? notionSpecRow({ color: n.color, count: n.count, size: n.size, price: n.price }) : notionSpecRow()}</div>
    <button class="btn ghost small" id="addSpec" data-spec="notion" type="button" style="margin-top:8px">＋ 添加规格</button>
    <div class="modal-actions"><button class="btn ghost" data-mclose>取消</button><button class="btn" data-msave="notion">${n ? '保存修改' : '保存辅料'}</button></div>
  `);
}

function openTutorialModal(editId) {
  const t = editId ? Store.state.tutorials.find(x => x.id === editId) : null;
  const opt = (arr, sel) => arr.map(o => `<option ${sel === o ? 'selected' : ''}>${o}</option>`).join('');
  openModal(`
    <h2>📚 ${t ? '编辑教程' : '添加教程'}</h2>
    <input id="mEditId" type="hidden" value="${editId || ''}" />
    <div class="field"><label>标题 *</label><input id="mName" value="${t ? esc(t.title) : ''}" placeholder="如：新手零钱包教程" /></div>
    <div class="field-row">
      <div class="field"><label>类型</label>
        <select id="mType">${opt(['图文', '视频'], t && t.type)}</select>
      </div>
      <div class="field"><label>平台</label>
        <select id="mPlatform">${opt(['小红书', '抖音'], t && t.platform)}</select>
      </div>
    </div>
    <div class="field"><label>链接（小红书 / 抖音 分享链接，仅作记录）</label><input id="mLink" value="${t ? esc(t.link || '') : ''}" placeholder="https://v.douyin.com/... 或 xiaohongshu 链接" /></div>
    <div class="field"><label>封面图（手动上传）</label>
      <label class="file-drop" for="mFile">📷 上传封面</label>
      <input id="mFile" type="file" accept="image/*" hidden />
      <img id="mPreview" class="preview-img" src="${t && t.image ? t.image : ''}" ${t && t.image ? '' : 'hidden'} />
      <input id="mImage" type="hidden" value="${t && t.image ? t.image : ''}" />
    </div>
    <div class="modal-actions"><button class="btn ghost" data-mclose>取消</button><button class="btn" data-msave="tutorial">${t ? '保存修改' : '保存教程'}</button></div>
  `);
}

function openWorkModal(opts = {}) {
  const editId = typeof opts === 'object' ? opts.editId || null : opts || null;
  const fromSew = !!(typeof opts === 'object' && opts.fromSew);
  const w = editId ? Store.state.works.find(x => x.id === editId) : null;
  const r = Store.state.rabbit;
  const name = w ? w.name : (fromSew ? (r.sewName || '') : '');
  const durationMin = w ? (w.durationMin || 0) : (fromSew ? Math.round(sewElapsedMs() / 60000) : 0);
  const date = w ? (w.date || '') : (fromSew ? new Date(r.checkIn).toISOString().slice(0, 10) : todayStr());
  const difficulty = w ? (w.difficulty || 0) : 0;
  const like = w ? (w.like || 0) : 0;
  const price = w ? (w.price || 0) : 0;
  const image = w ? (w.image || '') : '';
  const tutOpts = ['<option value="">不关联</option>', ...Store.state.tutorials.map(t => `<option value="${t.id}" ${w && w.tutorialId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`)].join('');
  const fabOpts = ['<option value="">不关联</option>', ...Store.state.fabrics.map(f => {
    const desc = [f.material, f.color].filter(Boolean).join(' · ');
    return `<option value="${f.id}" ${w && w.fabricId === f.id ? 'selected' : ''}>${esc(f.name)}${desc ? '（' + esc(desc) + '）' : ''}</option>`;
  })].join('');
  const starRow = (label, key, val) => `
    <div class="field"><label>${label}</label>
      <div class="stars" data-star="${key}">${[1, 2, 3, 4, 5].map(i => `<span class="star ${i <= val ? 'on' : ''}" data-action="star" data-star="${key}" data-val="${i}">★</span>`).join('')}</div>
      <input id="m${key[0].toUpperCase() + key.slice(1)}" type="hidden" value="${val}" />
    </div>`;
  openModal(`
    <h2>🎀 ${editId ? '编辑作品' : (fromSew ? '保存本次作品' : '添加作品')}</h2>
    ${editId ? `<input id="mEditId" type="hidden" value="${editId}" />` : ''}
    ${fromSew ? `<input id="mFromSew" type="hidden" value="1" /><input id="mSewStart" type="hidden" value="${r.checkIn}" /><input id="mSewEnd" type="hidden" value="${r.checkOut}" />` : ''}
    <div class="field"><label>作品名称 *</label><input id="mName" value="${esc(name)}" placeholder="如：草莓零钱包" autocomplete="off" /></div>
    <div class="field"><label>📷 作品图片</label>
      <label class="file-drop" for="mFile">上传作品图</label>
      <input id="mFile" type="file" accept="image/*" hidden />
      <img id="mPreview" class="preview-img" ${image ? `src="${image}"` : 'hidden'} />
      <input id="mImage" type="hidden" value="${esc(image)}" />
    </div>
    <div class="field"><label>🧵 使用布料</label><select id="mFabric">${fabOpts}</select></div>
    <div class="field-row">
      <div class="field"><label>📅 制作日期</label><div class="ro-val">${date || '—'}</div></div>
      <div class="field"><label>⏱ 缝纫用时</label><input id="mDuration" type="number" min="0" step="1" value="${durationMin}" placeholder="分钟" /></div>
    </div>
    ${starRow('✂️ 难度', 'difficulty', difficulty)}
    ${starRow('❤️ 喜欢程度', 'like', like)}
    <div class="field-row">
      <div class="field"><label>定价 ¥</label><input id="mPrice" type="number" value="${price}" placeholder="0.00" /></div>
      <div class="field"><label>关联教程</label><select id="mTutorial">${tutOpts}</select></div>
    </div>
    <div class="modal-actions">
      ${fromSew
        ? `<button class="btn ghost" data-action="sew-resume-cancel">再缝会儿</button><button class="btn" data-msave="work">保存作品 🎀</button>`
        : `<button class="btn ghost" data-mclose>取消</button><button class="btn" data-msave="work">${editId ? '保存修改' : '保存作品'}</button>`}
    </div>
  `);
  setTimeout(() => { const e = $('#mName'); if (e) e.focus(); }, 60);
}

function openSaleModal(id) {
  const w = Store.state.works.find(x => x.id === id);
  const isS = (w.type || 'self') === 'sell';
  const sales = w.sales || [];
  const total = sales.reduce((a, e) => a + (Number(e.price) || 0) * (Number(e.qty) || 1), 0);
  const list = sales.length ? sales.map((e, i) => `
    <div class="sale-item">
      <div class="sale-cells ${isS ? '' : 'gift'}">
        <span class="sc date">${esc(e.date || '—')}</span>
        <span class="sc buyer">${esc(e.buyer || '—')}</span>
        ${isS ? `<span class="sc price">${fmtMoney(e.price)}</span><span class="sc qty">×${Number(e.qty) || 1}</span>` : ''}
        ${!isS && e.note ? `<span class="sc note">📝 ${esc(e.note)}</span>` : ''}
      </div>
      <button class="btn ghost small sale-del2" data-action="sale-del" data-id="${id}" data-idx="${i}" type="button" title="删除">✕</button>
    </div>`).join('')
    : `<p class="hint" style="margin:6px 0">${isS ? '还没有售卖记录' : '还没有赠出记录'}，下面添加一条吧～</p>`;
  openModal(`
    <h2>${isS ? '💰 售卖情况' : '🎁 赠出记录'} · ${esc(w.name)}</h2>
    <input id="mSaleId" type="hidden" value="${id}" />
    <div class="sale-summary">共 ${sales.length} 条记录${isS ? ' · 合计 ' + fmtMoney(total) : ''}</div>
    ${list}
    <div class="section-sub" style="margin-top:14px">＋ 添加一条${isS ? '售卖记录' : '赠出记录'} <span class="muted">${isS ? '顺序：日期 · 买家 · 价格 · 数量' : '顺序：日期 · 友人 · 备注'}</span></div>
    <div class="field-row">
      <div class="field"><label>日期</label><input id="mDate" type="date" value="${todayStr()}" /></div>
      <div class="field"><label>${isS ? '买家' : '友人'}</label><input id="mBuyer" placeholder="${isS ? '如：小鹿' : '如：好友小鹿'}" /></div>
    </div>
    ${isS ? `
    <div class="field-row">
      <div class="field"><label>价格 ¥</label><input id="mSalePrice" type="number" placeholder="0.00" /></div>
      <div class="field"><label>数量</label><input id="mQty" type="number" value="1" placeholder="1" /></div>
      <button class="btn small" data-action="sale-add" data-id="${id}" type="button" style="align-self:flex-end;margin-bottom:2px">添加</button>
    </div>` : `
    <div class="field"><label>备注</label><input id="mNote" placeholder="如：生日礼物送给小鹿" /></div>
    <div class="field-row">
      <div class="field"><label>数量</label><input id="mQty" type="number" value="1" placeholder="1" /></div>
      <button class="btn small" data-action="sale-add" data-id="${id}" type="button" style="align-self:flex-end;margin-bottom:2px">添加</button>
    </div>`}
    <div class="modal-actions"><button class="btn" data-mclose>完成</button></div>
  `);
}

/* ---------- 自用记录（自用模块每张作品记每次自己使用） ---------- */
function useAdd(id) {
  const w = Store.state.works.find(x => x.id === id);
  if (!w) return;
  const date = ($('#mDate', box)?.value.trim()) || todayStr();
  const scene = ($('#mUseScene', box)?.value.trim()) || '';
  const note = ($('#mUseNote', box)?.value.trim()) || '';
  if (!scene && !note) return toast('请至少填写用途或备注');
  w.uses = w.uses || [];
  w.uses.push({ date, scene, note });
  Store.save();
  render();
  toast('已添加一条自用记录 🏠');
  openUseModal(id);
}
function useDel(id, idx) {
  const w = Store.state.works.find(x => x.id === id);
  if (!w || !w.uses) return;
  w.uses.splice(idx, 1);
  Store.save();
  render();
  openUseModal(id);
}
function openUseModal(id) {
  const w = Store.state.works.find(x => x.id === id);
  const uses = w.uses || [];
  const list = uses.length ? uses.map((e, i) => `
    <div class="sale-item">
      <div class="sale-cells gift">
        <span class="sc date">${esc(e.date || '—')}</span>
        <span class="sc buyer">${esc(e.scene || '—')}</span>
        ${e.note ? `<span class="sc note">📝 ${esc(e.note)}</span>` : ''}
      </div>
      <button class="btn ghost small sale-del2" data-action="use-del" data-id="${id}" data-idx="${i}" type="button" title="删除">✕</button>
    </div>`).join('')
    : `<p class="hint" style="margin:6px 0">还没有自用记录，下面添加一条吧～</p>`;
  openModal(`
    <h2>🏠 自用记录 · ${esc(w.name)}</h2>
    <input id="mSaleId" type="hidden" value="${id}" />
    <div class="sale-summary">共 ${uses.length} 条记录</div>
    ${list}
    <div class="section-sub" style="margin-top:14px">＋ 添加一条自用记录 <span class="muted">顺序：日期 · 用途/场景 · 备注</span></div>
    <div class="field-row">
      <div class="field"><label>日期</label><input id="mDate" type="date" value="${todayStr()}" /></div>
      <div class="field"><label>用途 / 场景</label><input id="mUseScene" placeholder="如：日常背 / 参加聚会" /></div>
    </div>
    <div class="field"><label>备注</label><input id="mUseNote" placeholder="如：搭配蓝色连衣裙" /></div>
    <div class="modal-actions" style="justify-content:flex-end">
      <button class="btn small" data-action="use-add" data-id="${id}" type="button">添加</button>
      <button class="btn ghost" data-mclose>完成</button>
    </div>
  `);
}

/* ---------- 用/赠 选择弹窗（自用卡点“用/赠”先选类型，再跳对应表单） ---------- */
function openRecordChooser(id) {
  const w = Store.state.works.find(x => x.id === id);
  openModal(`
    <h2>记录用途 · ${esc(w ? w.name : '')}</h2>
    <p class="hint" style="margin:4px 0 14px">这件作品是你自己用，还是送给别人？</p>
    <div class="record-choose">
      <button class="btn big" data-action="choose-self" data-id="${id}" type="button">🏠 自用</button>
      <button class="btn big" data-action="choose-gift" data-id="${id}" type="button">🎁 赠出</button>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-mclose>取消</button></div>
  `);
}

/* ---------- 删除 ---------- */
function delItem(coll, id) {
  Store.state[coll] = Store.state[coll].filter(x => x.id !== id);
  Store.save(); render(); toast('已删除');
}

/* ---------- 标记已用完 ---------- */
function toggleUsed(coll, id) {
  const item = Store.state[coll].find(x => x.id === id);
  if (!item) return;
  item.usedUp = !item.usedUp;
  Store.save(); render();
  toast(item.usedUp ? '已标记为用完 🧺' : '已恢复库存');
}

/* ---------- 教程打卡 / 关联 ---------- */
function tutorialCheck(id) {
  const t = Store.state.tutorials.find(x => x.id === id);
  if (!t) return;
  t.checked = !t.checked;
  // 打卡则给兔兔加时间奖励
  if (t.checked) { Store.state.rabbit.cans += 1; confetti(); toast('制作打卡 +1 根胡萝卜 🥕'); }
  else { Store.state.rabbit.cans = Math.max(0, Store.state.rabbit.cans - 1); }
  Store.save(); render();
}
// 教程关联作品（select 变化）
workspace.addEventListener('change', (e) => {
  const sel = e.target.closest('.linkWork');
  if (sel) {
    const t = Store.state.tutorials.find(x => x.id === sel.dataset.id);
    if (t) { t.workId = sel.value; Store.save(); toast('已关联作品'); }
  }
  // 布料筛选
  if (e.target.id === 'fMaterial') { fabricFilter.material = e.target.value; render(); }
  if (e.target.id === 'fColor') { fabricFilter.color = e.target.value; render(); }
  if (e.target.id === 'fStyle') { fabricFilter.style = e.target.value; render(); }
  if (e.target.id === 'nCat') { notionFilter.category = e.target.value; render(); }
});
workspace.addEventListener('click', (e) => {
  if (e.target.id === 'fClear') { fabricFilter = { material: '', color: '', style: '' }; render(); }
  if (e.target.id === 'nClear') { notionFilter = { category: '' }; render(); }
});

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 2200);
}
// 给 Promise 加超时，避免云端请求挂起导致界面永久卡死
function withTimeout(p, ms, msg) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || '操作超时')), ms)),
  ]);
}

/* ---------- 礼花 ---------- */
function confetti() {
  const cv = $('#confetti'), ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#ff8fbf', '#ffb6d5', '#e9d8f5', '#ffd3e3', '#7bd99a'];
  const parts = Array.from({ length: 120 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height,
    r: 4 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
    vy: 2 + Math.random() * 4, vx: -2 + Math.random() * 4, rot: Math.random() * 6, vr: -0.2 + Math.random() * 0.4,
  }));
  let frames = 0;
  (function loop() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6); ctx.restore();
    });
    frames++;
    if (frames < 160) requestAnimationFrame(loop); else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------- 云端登录 / 实时同步 ---------- */
let _rtChannel = null;
function setupRealtime(sb, userId) {
  try {
    if (_rtChannel) sb.removeChannel(_rtChannel);
    _rtChannel = sb.channel('sewing_state:' + userId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewing_state', filter: 'user_id=eq.' + userId },
        (payload) => {
          const row = payload.new;
          const d = row && row.data;
          if (!d) return;
          // 版本判断：云端推送的不是更新的版本时忽略，避免旧快照覆盖本机新编辑
          const incoming = row.updated_at ? new Date(row.updated_at).getTime() : 0;
          const local = Store._updatedAt ? new Date(Store._updatedAt).getTime() : 0;
          if (incoming && local && incoming <= local) return;
          Store.state = Object.assign(DEFAULT_STATE(), d);
          Store.normalize();
          if (row.updated_at) Store._updatedAt = row.updated_at;
          Store._persistLocal(row.updated_at).catch(() => {}); // 云端推送后同步本机，保持两端一致
          render();
        })
      .subscribe();
  } catch (_) {}
}

function showLogin() {
  setupAvatar(); // 确保未登录时头像也已挂载、可点击
  const m = $('#loginMask');
  if (m) { m.hidden = false; return; }
  const el = document.createElement('div');
  el.id = 'loginMask';
  el.className = 'modal-mask';
  el.innerHTML = `
    <div class="login-card">
      <h2>🐰 兔子的缝纫空间</h2>
      <p class="hint">登录后，数据在手机 / 电脑间自动同步并云端保存（不登录则仅本机保存）。<br><b>找回旧数据请使用当初保存数据时登录的同一邮箱。</b></p>
      <input id="loginEmail" type="email" placeholder="邮箱" autocomplete="username" />
      <input id="loginPwd" type="password" placeholder="密码（6 位以上）" autocomplete="current-password" />
      <button class="btn" data-action="cloud-signin">登录</button>
      <button class="btn ghost" data-action="cloud-signup">注册新账号</button>
      <button class="btn ghost small" data-action="cloud-local" style="margin-top:10px">仅本机使用（不登录）</button>
    </div>`;
  document.body.appendChild(el);
}

function finishBoot() {
  document.body.classList.toggle('cloud-on', CLOUD);
  if (Store.state.rabbit.checkIn && !Store.state.rabbit.checkOut) startLiveTimer();
  setupAvatar();
  render();
  renderSyncStatus();
  // 离开/切后台/关页面时自动同步一次云端，进一步降低“关站前没存上”的丢失风险
  if (CLOUD && SBUser && SBUser.id && Store._cloudLoaded) {
    document.removeEventListener('visibilitychange', _onHidden);
    window.removeEventListener('pagehide', _onPageHide);
    document.addEventListener('visibilitychange', _onHidden);
    window.addEventListener('pagehide', _onPageHide);
  }
}
// 离页自动同步的监听器（保留引用以便去重注册）
function _onHidden() { if (document.visibilityState === 'hidden') syncOnExit(false); }
function _onPageHide() { syncOnExit(true); }

/* ---------- 同步状态指示（侧边栏 + 移动端顶栏） ---------- */
function maskEmail(e) {
  if (!e) return '';
  const i = e.indexOf('@');
  if (i <= 1) return e;
  return e[0] + '***' + e.slice(i);
}
function fmtSync(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSyncShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderSyncStatus() {
  const s = document.getElementById('syncStatus');
  const t = document.getElementById('topSync');
  const signout = document.querySelector('.side-signout');
  let html = '', cls = '', top = '';
  if (CLOUD && SBUser && SBUser.email) {
    cls = 'on';
    const last = fmtSync(Store._lastCloudSync);
    html = '<span class="dot"></span><div class="sync-txt"><b>已同步云端</b><small>' + maskEmail(SBUser.email) + '</small><small class="sync-last">上次同步：' + last + '</small></div><button class="sync-btn" type="button" data-action="cloud-sync">↻ 同步</button>';
    top = '☁️ ' + fmtSyncShort(Store._lastCloudSync) + ' 已同步';
    if (signout) signout.hidden = false;
  } else if (CLOUD) {
    cls = 'off';
    html = '<span class="dot"></span><div class="sync-txt"><b>云端未登录</b><small>点左上角登录以同步</small></div>';
    if (signout) signout.hidden = true;
  } else {
    cls = 'local';
    html = '<span class="dot"></span><div class="sync-txt"><b>仅本机保存</b><small>未开启云同步</small></div>';
    if (signout) signout.hidden = true;
  }
  if (s) { s.className = 'sync-status ' + cls; s.innerHTML = html; }
  if (t) { t.className = 'top-sync ' + cls; t.textContent = top; }
}
async function forceCloudSync() {
  if (!(CLOUD && SBUser)) return toast('请先登录云端后再同步');
  if (!Store._cloudLoaded) return toast('云端尚未就绪，请稍候或刷新重试');
  const sb = await sbClient();
  if (!sb) return toast('⚠️ 云端库未就绪');
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return toast('请先登录云端');
  const ts = new Date().toISOString();
  try {
    await sb.from('sewing_state').upsert({ user_id: user.id, data: Store.state, updated_at: ts });
    Store._updatedAt = ts; Store._lastCloudSync = ts;
    flashSynced(); renderSyncStatus();
    toast('已同步到云端 ☁️ ' + fmtSync(ts));
  } catch (e) {
    toast('⚠️ 云端保存失败，已保留在本机，请检查网络后重试');
  }
}
// 离开页面（切后台/锁屏/关站/刷新）时自动再推一次云端，覆盖“最后一次改动后立刻关页面、云端 upsert 尚未完成”的丢失窗口。
// keepalive=true 用于 pagehide：页面正在卸载，靠 keepalive 保证请求发出，但浏览器限制单请求 ≤64KB，超大体积时跳过（下次打开 load() 会按本机较新自动写回云端兜底）；
// keepalive=false 用于 visibilitychange→hidden：页面仍在后台存活，用普通 fetch 完整推送（含大体积数据）。
async function syncOnExit(keepalive) {
  if (!(CLOUD && SBUser && SBUser.id && Store._cloudLoaded)) return;
  if (!SBToken) return;
  if (isEmptyState(Store.state)) return; // 空状态绝不写回云端，防止在 load 未完成等异常下误清空真实数据
  if (!Store._updatedAt) return; // 本机从未改动，无内容可同步
  // 本机已与云端一致（_updatedAt <= _lastCloudSync）则跳过，避免无谓请求；
  // _lastCloudSync 为空（首次登录/未记录过同步时间）但本机有改动时仍推送，以建立同步基线
  if (Store._lastCloudSync && new Date(Store._updatedAt).getTime() <= new Date(Store._lastCloudSync).getTime()) return;
  const ts = new Date().toISOString();
  const payload = { user_id: SBUser.id, data: Store.state, updated_at: ts };
  const body = JSON.stringify([payload]);
  if (keepalive && body.length > 60000) return; // 超出 keepalive 上限，跳过；下次打开时 load() 会按本地较新自动写回云端
  try {
    await fetch(SUPABASE_URL + '/rest/v1/sewing_state', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SBToken,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body,
      keepalive: !!keepalive
    });
  } catch (_) {}
}
function flashSynced() {
  const s = document.getElementById('syncStatus');
  if (!s) return;
  s.classList.add('just-saved');
  clearTimeout(flashSynced._t);
  flashSynced._t = setTimeout(() => s.classList.remove('just-saved'), 1200);
}

/* ---------- 左上角头像菜单（切换账号 / 退出登录） ---------- */
function setupAvatar() {
  // 桌面侧栏 logo + 移动端顶栏 logo 都可点击，作为账号入口
  const bl = document.getElementById('brandLogo');
  if (bl) {
    bl.innerHTML = '<img class="brand-avatar" src="rabbit.png' + IMG_VER + '" alt="兔兔" />';
    bl.setAttribute('data-action', 'avatar-menu');
  }
  const tb = document.getElementById('topbarBunny');
  if (tb) {
    tb.innerHTML = '<img class="brand-avatar small" src="rabbit.png' + IMG_VER + '" alt="兔兔" />';
    tb.setAttribute('data-action', 'avatar-menu');
  }
}
function openAvatarMenu(trigger) {
  closeAvatarMenu();
  const menu = document.createElement('div');
  menu.id = 'avatarMenu';
  menu.className = 'avatar-menu';
  let body;
  if (CLOUD && SBUser && SBUser.email) {
    body = `
      <div class="am-user">
        <div class="am-avatar">🐰</div>
        <div class="am-info"><small>当前账号</small><b>${esc(maskEmail(SBUser.email))}</b></div>
      </div>
      <button class="am-item" data-action="cloud-sync">☁️ 立即同步云端</button>
      <button class="am-item" data-action="avatar-export">📤 导出备份</button>
      <button class="am-item" data-action="avatar-import">📥 导入备份</button>
      <button class="am-item" data-action="avatar-switch">🔄 切换账号</button>
      <button class="am-item danger" data-action="avatar-signout">🚪 退出登录</button>`;
  } else {
    body = `
      <button class="am-item" data-action="avatar-export">📤 导出备份</button>
      <button class="am-item" data-action="avatar-import">📥 导入备份</button>
      <button class="am-item" data-action="avatar-switch">🔑 登录 / 注册</button>`;
  }
  menu.innerHTML = body;
  document.body.appendChild(menu);
  const r = (trigger || document.getElementById('brandLogo')).getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 8) + 'px';
  if (window.innerWidth <= 768) {
    menu.style.right = '12px';
    menu.style.left = 'auto';
  } else {
    menu.style.left = Math.round(r.left) + 'px';
  }
  // 点击菜单外部时关闭（捕获阶段，确保早于其它委托逻辑）
  setTimeout(() => document.addEventListener('click', avatarOutside, true), 0);
}
function avatarOutside(e) {
  const m = document.getElementById('avatarMenu');
  if (!m) return;
  if (!m.contains(e.target) && !e.target.closest('[data-action="avatar-menu"]')) closeAvatarMenu();
}
function closeAvatarMenu() {
  const m = document.getElementById('avatarMenu');
  if (m) m.remove();
  document.removeEventListener('click', avatarOutside, true);
}
async function switchAccount(isSwitch) {
  const sb = CLOUD ? (await sbClient().catch(() => null)) : null;
  if (sb) {
    try { await sb.auth.signOut(); } catch (_) {}
    if (_rtChannel && sb) { try { sb.removeChannel(_rtChannel); } catch (_) {} _rtChannel = null; }
  }
  CLOUD = false; SBUser = null; Store._cloudLoaded = false; SBToken = null;
  closeAvatarMenu();
  showLogin();
  renderSyncStatus();
  toast(isSwitch ? '已退出，请登录其他账号 🐰' : '已退出登录');
}

// 导出当前数据为 JSON 备份文件（用户自己掌握的一份副本，云端/本机无论哪边出问题都能恢复）
function exportData() {
  closeAvatarMenu();
  try {
    const payload = {
      __app: 'bunny_sewing_space',
      __exportedAt: new Date().toISOString(),
      state: Store.state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = url;
    a.download = 'bunny_sewing_backup_' + stamp + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出备份文件 📤 请保存在手机/电脑里');
  } catch (e) {
    toast('导出失败：' + (e && e.message ? e.message : e));
  }
}

// 从 JSON 备份文件导入数据（覆盖当前全部数据）
function importData() {
  closeAvatarMenu();
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const obj = parsed && parsed.state ? parsed.state : parsed; // 兼容“纯 state”与“带元信息”两种格式
        if (!obj || !Array.isArray(obj.works)) throw new Error('文件格式不正确（缺少 works 列表）');
        if (!confirm('导入会用备份文件覆盖当前所有数据，确定继续？\n（导入后建议立刻做一次云端保存）')) return;
        Store.state = Object.assign(DEFAULT_STATE(), obj);
        Store.normalize();
        Store.save();
        if (CLOUD) Store._cloudLoaded = true; // 导入后允许写回云端
        render(); renderSyncStatus();
        toast('已导入备份 ✅');
      } catch (e) {
        toast('导入失败：' + (e && e.message ? e.message : e));
      }
    };
    reader.onerror = () => toast('读取文件失败');
    reader.readAsText(f);
  };
  inp.click();
}

async function afterLogin(sb) {
  CLOUD = true; // 能进入 afterLogin 即代表已登录云端，恢复云端开关（退出登录时会临时置 false）
  let user;
  try {
    const { data: { user: u } } = await sb.auth.getUser();
    user = u;
  } catch (e) {
    // 拿不到登录用户：退回本机模式，至少能进主页，绝不卡死
    CLOUD = false; SBUser = null; Store._cloudLoaded = false;
    try { await Store.load(); } catch (_) {}
    finishBoot();
    return toast('登录状态校验失败，已切换本机模式：' + (e && e.message ? e.message : e));
  }
  if (!user) { showLogin(); return; }
  SBUser = user;
  registerSessionCache(sb);
  try { const { data: { session } } = await sb.auth.getSession(); SBToken = (session && session.access_token) || null; } catch (_) {}
  $('#loginMask') && ($('#loginMask').hidden = true);
  try {
    await withTimeout(Store.load(), 12000, '读取云端数据超时');
  } catch (e) {
    // 云端读取失败（含超时/网络）：不写回云端、退回本机数据，确保能进主页
    console.warn('[afterLogin] 云端读取失败，回退本机模式：', e);
    CLOUD = false; SBUser = null; Store._cloudLoaded = false;
    try { await Store.load(); } catch (_) {}
    finishBoot();
    return toast('云端数据读取失败，已用本机数据进入（未同步）：' + (e && e.message ? e.message : e));
  }
  // 登录后给出明确的数据来源反馈，便于排查“看不到数据”的原因
  const src = Store._lastLoad;
  if (src === 'cloud') toast('已从云端同步数据 ☁️');
  else if (src === 'local-restored') toast('已从本机恢复数据并同步到云端 ☁️');
  else if (src === 'new' || src === 'cloud-empty') toast('当前账号云端和本机都还没有数据——请确认是否用了当初保存数据时登录的邮箱 🐰');
  else if (src === 'seed') toast('云端数据读取异常，已用本机状态');
  finishBoot();
}

/* ---------- 启动 ---------- */
async function boot() {
  bindSection(); // 先绑定全局点击委托，确保登录浮层的按钮可用（无论是否已登录）
  renderSyncStatus(); // 先给侧边栏一个初始状态（未登录/本地）
  if (!CLOUD) {
    try { await withTimeout(Store.load(), 12000, '读取本机数据超时'); } catch (e) { console.warn('[boot] 本机读取失败：', e); }
    finishBoot();
    return;
  }
  const sb = await sbClient();
  const { data: { session } } = await sb.auth.getSession();
  registerSessionCache(sb);
  SBToken = (session && session.access_token) || null;
  if (!session) { showLogin(); return; }
  const { data: { user } } = await sb.auth.getUser();
  SBUser = user || null;
  try { await withTimeout(Store.load(), 12000, '读取云端数据超时'); }
  catch (e) {
    console.warn('[boot] 云端读取失败，回退本机模式：', e);
    CLOUD = false; SBUser = null; Store._cloudLoaded = false;
    try { await Store.load(); } catch (_) {}
  }
  const src = Store._lastLoad;
  if (src === 'cloud') toast('已从云端同步数据 ☁️');
  else if (src === 'local-restored') toast('已从本机恢复数据并同步到云端 ☁️');
  else if (src === 'new' || src === 'cloud-empty') toast('当前账号云端和本机都还没有数据——请确认是否用了当初保存数据时登录的邮箱 🐰');
  else if (src === 'seed') toast('云端数据读取异常，已用本机状态');
  finishBoot();
}
boot();
