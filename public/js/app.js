/* ============ JM Forum SPA (NodeSeek style) ============ */
(function () {
  'use strict';

  const state = { user: null, boards: [], tags: [] };
  const els = {
    pageRoot: document.getElementById('pageRoot'),
    pageLoading: document.getElementById('pageLoading'),
    navPills: document.getElementById('navPills'),
    authButtons: document.getElementById('authButtons'),
    userMenu: document.getElementById('userMenu'),
    userBtn: document.getElementById('userBtn'),
    userDropdown: document.getElementById('userDropdown'),
    currentAvatar: document.getElementById('currentAvatar'),
    userCoins: document.getElementById('userCoins'),
    profileLink: document.getElementById('profileLink'),
    logoutBtn: document.getElementById('logoutBtn'),
    menuToggle: document.getElementById('menuToggle'),
    mobileDrawer: document.getElementById('mobileDrawer'),
    overlay: document.getElementById('overlay'),
    navSearchForm: document.getElementById('navSearchForm'),
    navSearchInput: document.getElementById('navSearchInput'),
    checkinBtn: document.getElementById('checkinBtn'),
    checkinPanel: document.getElementById('checkinPanel'),
    checkinRankList: document.getElementById('checkinRankList'),
    sideBoardList: document.getElementById('sideBoardList'),
    sideTags: document.getElementById('sideTags'),
    sideUserCard: document.getElementById('sideUserCard'),
    adminLink: document.getElementById('adminLink'),
    darkToggle: document.getElementById('darkToggle'),
    bellBtn: document.getElementById('bellBtn'),
    bellDot: document.getElementById('bellDot'),
    bellDropdown: document.getElementById('bellDropdown'),
    dmBadge: document.getElementById('dmBadge'),
  };

  /* ---------- api ---------- */
  const apiCache = new Map();
  async function api(path, opts = {}) {
    const isGet = !opts.method || opts.method === 'GET';
    if (!isGet) apiCache.clear(); /* 写操作后缓存失效，保证数据新鲜 */
    else {
      const hit = apiCache.get(path);
      if (hit && Date.now() - hit.t < 20000) return hit.d;
    }
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (!res.ok) {
      let msg = res.statusText, extra = {};
      try { const j = await res.json(); msg = j.error || msg; extra = j; } catch (e) {}
      const err = new Error(msg);
      if (extra.needLevel) { err.needLevel = extra.needLevel; err.myLevel = extra.myLevel || 0; }
      throw err;
    }
    const d = await res.json();
    if (isGet) {
      apiCache.set(path, { t: Date.now(), d });
      if (apiCache.size > 80) apiCache.delete(apiCache.keys().next().value);
    }
    return d;
  }
  function prefetch(path) { api(path).catch(() => {}); }

  /* ---------- utils ---------- */
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(iso) {
    const d = new Date(iso), diff = Math.floor((Date.now() - d) / 1000);
    if (diff < 10) return '刚刚';
    if (diff < 60) return diff + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 31536000) return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  /* 完整日期时间（详情页/后台用） */
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('zh-CN') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.0$/, '').replace(/\.\d$/, '$&0').slice(0, 4).replace(/\.$/, '') + 'k';
    return String(n);
  }
  /* Toast 轻提示（替代部分 alert） */
  let toastTimer = null;
  function toast(msg, type = 'ok', ms = 2400) {
    let box = document.getElementById('toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastBox';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }
  /* 复制文本：优先 Clipboard API，失败回退 execCommand */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
      throw new Error('no-clipboard');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e2) { return false; }
    }
  }
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function avatar(u) { return (u && u.avatar) ? u.avatar : '/assets/logo.png'; }
  function isStaff(u) { return u && (u.role === 'admin' || u.role === 'owner'); }
  function isOwner(u) { return u && u.role === 'owner'; }
  /* 角色徽章（前台用户旁显示） */
  function roleTag(u) {
    if (!u || !u.role) return '';
    if (u.role === 'owner') return '<span class="role-tag owner">👑 站长</span>';
    if (u.role === 'admin') return '<span class="role-tag admin">🛡️ 管理员</span>';
    return '';
  }
  function roleName(r) { return r === 'owner' ? '站长' : r === 'admin' ? '管理员' : '成员'; }
  /* 公司避雷：星级渲染 + 避雷徽章（支持半星） */
  function stars(n, size) {
    const sz = size || 14;
    const v = Math.max(0, Math.min(5, Number(n) || 0));
    const full = Math.floor(v);
    const half = v - full >= 0.5;
    let s = '';
    for (let i = 1; i <= 5; i++) {
      if (i <= full) s += `<span style="color:#f59e0b;font-size:${sz}px">★</span>`;
      else if (half && i === full + 1) s += `<span style="color:#f59e0b;font-size:${sz}px">⯨</span>`;
      else s += `<span style="color:#d8e2da;font-size:${sz}px">★</span>`;
    }
    return s;
  }
  function companyBadge(c) {
    if (!c) return '';
    const map = {
      pending: ['#8aa096', '待评价'],
      ok: ['#3d6c45', '尚可'],
      careful: ['#d97706', '谨慎'],
      warn: ['#ea580c', '避雷'],
      danger: ['#dc2626', '强烈避雷'],
    };
    const [color, label] = map[c.level] || map.pending;
    return `<span class="comp-badge" style="color:${color};border-color:${color};background:${color}14">${label}</span>`;
  }
  /* v8 玩法：等级徽章 / 经验条 / 头衔 / 成就 */
  function levelTag(u, small) {
    if (!u || !u.level) return '';
    const size = small ? 11 : 12;
    return `<span class="lv-tag" style="font-size:${size}px" title="Lv.${u.level} ${esc(u.levelTitle || '')} · ${(u.exp || 0).toLocaleString()} 经验">Lv.${u.level} ${esc(u.levelTitle || '')}</span>`;
  }
  function titleTag(u) {
    if (!u || !u.title) return '';
    return `<span class="title-tag" title="头衔">${esc(u.title)}</span>`;
  }
  function badgeRow(u) {
    const list = u && u.badges && u.badges.length ? u.badges : [];
    if (!list.length) return '';
    return `<div class="badge-strip">${list.map(b => `<span class="user-badge">${esc(b)}</span>`).join('')}</div>`;
  }
  function expBar(u) {
    if (!u) return '';
    const pct = Math.max(0, Math.min(100, u.levelProgress ?? 0));
    const next = u.nextExp ? ` · 距 Lv.${(u.level || 1) + 1} 还差 ${((u.nextExp || 0) - (u.exp || 0)).toLocaleString()} 经验` : '';
    return `<div class="exp-bar" title="${(u.exp || 0).toLocaleString()} 经验${next}"><div class="exp-bar-fill" style="width:${pct}%"></div></div>`;
  }
  /* 公司风险标签 chips */
  function compTags(tags) {
    return (tags || []).map(t => `<span class="comp-tag">${esc(t)}</span>`).join('');
  }
  function boardById(id) { return state.boards.find(b => b.id === id); }
  function boardBySlug(slug) { return state.boards.find(b => b.slug === slug); }
  function escHtml(s) { return esc(s); } /* 历史别名，与 esc 等价 */
  function mdLinkify(s) {
    s = s.replace(/@([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})/g, '<a class="mention" href="/space/$1">@$1</a>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    return s;
  }
  /* 轻量 Markdown 渲染：先转义 HTML 防 XSS，再解析代码块/粗斜体/删除线/链接/引用/列表/标题 */
  function parseHtml(str) {
    const text = String(str ?? '');
    const blocks = [];
    const safe = text.replace(/```([\s\S]*?)```/g, (m, code) => { blocks.push(escHtml(code)); return `\u0000${blocks.length - 1}\u0000`; });
    let s = escHtml(safe);
    const inlines = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { inlines.push(c); return `\u0001${inlines.length - 1}\u0001`; });
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^~])~~([^~\n]+)~~/g, '$1<del>$2</del>');
    s = mdLinkify(s);
    s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => `<code>${inlines[+i]}</code>`);
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<pre class="code-block"><code>${blocks[+i]}</code></pre>`);
    const lines = s.split('\n');
    let html = '', inList = false;
    lines.forEach(line => {
      const quote = line.match(/^&gt; ?(.*)$/);
      const list = line.match(/^[-*] (.+)$/);
      if (quote) {
        if (inList) { html += '</ul>'; inList = false; }
        html += `<blockquote>${quote[1]}</blockquote>`;
      } else if (list) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${list[1]}</li>`;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += line + '\n';
      }
    });
    if (inList) html += '</ul>';
    html = html
      .replace(/^#{1,3} (.+)$/gm, '<p class="md-h"><strong>$1</strong></p>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/^\s*<p>/m, '')
      .replace(/<p>\s*$/, '')
      .replace(/\n/g, '<br>');
    return html || '<br>';
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ---------- components ---------- */
  function postRowHtml(t) {
    const bd = t.board;
    const stripe = bd ? `<span class="bd-stripe" style="background:${esc(bd.color)}"></span>` : '';
    const badge = bd ? `<span class="badge badge-bd" style="background:${esc(bd.color)}">${esc(bd.name)}</span>` : '';
    const pin = t.pinned ? '<span class="badge badge-pin">置顶</span>' : '';
    const rec = t.recommended ? '<span class="badge badge-rec">推荐阅读</span>' : '';
    const price = t.price ? `<span class="badge badge-price">¥ ${t.price}</span>` : '';
    const lock = (t.minLevel || 1) > 1 ? `<span class="badge badge-lock" title="LV${t.minLevel} 及以上可见">🔒 LV${t.minLevel}</span>` : '';
    const closed = t.closed ? '<span class="badge badge-closed">只读</span>' : '';
    const tags = (t.tags || []).map(x => `<a class="tag-chip tag-link" href="/tag/${encodeURIComponent(x)}">${esc(x)}</a>`).join('');
    const last = t.lastReply ? `
      <span class="sep">·</span> 最后回复 <a href="/space/${esc(t.lastReply.username)}">${esc(t.lastReply.name)}</a>
      <span class="sep">·</span> ${fmtTime(t.lastReply.at)}
    ` : '';
    return `
      <div class="post-row">
        ${stripe}
        <div class="post-row-head">
          <a href="/space/${esc(t.author.username)}"><img src="${esc(avatar(t.author))}" alt="" loading="lazy"></a>
          <div class="prh-id">
            <a class="prh-name" href="/space/${esc(t.author.username)}">${esc(t.author.name)}</a>${roleTag(t.author)}
            <span class="prh-time">${fmtTime(t.createdAt)}</span>
          </div>
          ${bd ? `<a class="prh-board badge badge-bd" style="background:${esc(bd.color)}" href="/?board=${esc(bd.slug)}">${esc(bd.name)}</a>` : ''}
        </div>
        <div class="post-row-main">
          <a class="post-row-title" href="/post/${esc(t.slug)}">${badge}${pin}${rec}${price}${lock}${closed}${esc(t.title)}</a>
          <div class="post-row-tags">${tags}</div>
          <div class="post-row-meta">
            <a href="/space/${esc(t.author.username)}">${esc(t.author.name)}</a>${roleTag(t.author)}
            <span class="sep">·</span> ${fmtTime(t.createdAt)}
            ${last}
          </div>
        </div>
        <div class="post-row-stats">
          <span class="stat-line stat-views"><span class="stat-ic">👁</span> <span class="v">${fmtNum(t.viewCount)}</span><span class="stat-lbl">阅读</span></span>
          <span class="stat-sep">/</span>
          <span class="stat-line stat-comments"><span class="stat-ic">💬</span> <span class="v">${fmtNum(t.replyCount)}</span><span class="stat-lbl">回复</span></span>
        </div>
      </div>
    `;
  }

  function postListHtml(topics) {
    if (!topics || !topics.length) return `<div class="empty-state"><div class="big">🕳️</div><p>这里还空空如也，来发第一帖吧！</p></div>`;
    return `<div class="post-list">${topics.map(postRowHtml).join('')}</div>`;
  }

  const SPORT_SLUGS = ['basketball', 'football', 'tennis', 'badminton', 'pingpong', 'volleyball', 'billiards', 'baseball', 'golf', 'esports', 'sports'];

  function boardTabsHtml(activeSlug, hrefFor = (s) => `/?board=${encodeURIComponent(s)}`, allHref = '/', tabCls = '') {
    // 忏悔录、吃瓜、树洞是大家最常去的，钉在最前面；11 个体育板块合成一个「综合体育」，点开再分
    const bySlug = (s) => state.boards.find(b => b.slug === s);
    const chip = (b) => `<a href="${hrefFor(b.slug)}" class="${activeSlug === b.slug ? 'active' : ''}"><span class="bd-dot" style="background:${esc(b.color)}"></span>${esc(b.name)}</a>`;
    const chips = [
      `<a href="${allHref}" class="${!activeSlug ? 'active' : ''}">全部</a>`,
      `<a href="/tag/忏悔室"><span class="bd-dot" style="background:#7c5cd6"></span>忏悔录</a>`,
    ];
    for (const s of ['chigua', 'tg-treehole']) { const b = bySlug(s); if (b) chips.push(chip(b)); }
    const sports = SPORT_SLUGS.map(bySlug).filter(Boolean);
    const sportsActive = SPORT_SLUGS.includes(activeSlug);
    if (sports.length) {
      const sp = bySlug('sports');
      chips.push(`<a href="#" class="sports-parent${sportsActive ? ' active' : ''}" data-sports-toggle><span class="bd-dot" style="background:${esc(sp ? sp.color : '#06b6d4')}"></span>综合体育 <span class="sp-caret">▾</span></a>`);
    }
    const pinned = new Set(['chigua', 'tg-treehole', ...SPORT_SLUGS]);
    for (const b of state.boards) { if (!pinned.has(b.slug)) chips.push(chip(b)); }
    const sub = sports.length ? `<div class="sports-sub">${sports.map(chip).join('')}</div>` : '';
    return `<div class="bt-wrap${sportsActive ? ' sports-open' : ''}"><div class="board-tabs${tabCls}">${chips.join('')}</div>${sub}<div class="bt-more-row"><button type="button" class="bt-more" data-bt-more>全部板块 ▾</button></div></div>`;
  }

  // 手机端「全部板块」：默认单行横滑，点开摊成完整网格；「综合体育」点开展开细分的体育板块
  document.addEventListener('click', (e) => {
    const sp = e.target.closest('[data-sports-toggle]');
    if (sp) {
      e.preventDefault();
      const wrap = sp.closest('.bt-wrap');
      if (wrap) wrap.classList.toggle('sports-open');
      return;
    }
    const btn = e.target.closest('[data-bt-more]');
    if (!btn) return;
    const wrap = btn.closest('.bt-wrap');
    if (!wrap) return;
    wrap.classList.toggle('open');
    btn.textContent = wrap.classList.contains('open') ? '收起 ▴' : '全部板块 ▾';
  });

  function sortTabsHtml(current) {
    return `<div class="sort-tabs">
      <a href="#" data-sort="latest" class="${current === 'latest' ? 'active' : ''}">最新回复</a>
      <a href="#" data-sort="new" class="${current === 'new' ? 'active' : ''}">新帖子</a>
      <a href="#" data-sort="hot" class="${current === 'hot' ? 'active' : ''}">热门</a>
      <a href="#" data-sort="views" class="${current === 'views' ? 'active' : ''}">浏览</a>
    </div>`;
  }

  function sectionTitle(text, extra = '') {
    return `<div class="section-title">${esc(text)}<span class="hint">${extra}</span></div>`;
  }

  /* ---------- sidebar ---------- */
  async function loadBoards() {
    if (!state.boards.length) state.boards = await api('/api/boards');
    els.sideBoardList.innerHTML = state.boards.map(b => `
      <li><a href="/?board=${esc(b.slug)}"><span class="bd-dot" style="background:${esc(b.color)}"></span>${esc(b.name)}<span class="bd-count">${b.topicCount}</span></a></li>
    `).join('');
    return state.boards;
  }
  async function loadTags() {
    if (!state.tags.length) state.tags = await api('/api/tags');
    els.sideTags.innerHTML = state.tags.map(t => `<a href="/tag/${encodeURIComponent(t.name)}">${esc(t.name)}</a>`).join('');
    return state.tags;
  }
  async function loadCheckinRank() {
    try {
      const list = await api('/api/rank/checkin');
      els.checkinRankList.innerHTML = list.slice(0, 10).map(u => `
        <li><a href="/space/${esc(u.username)}" class="r-name">${esc(u.name)}</a><span class="r-coins">🍗 ${u.coins}</span></li>
      `).join('');
    } catch (e) { els.checkinRankList.innerHTML = '<li class="muted">加载失败</li>'; }
  }
  async function loadHot24() {
    const el = document.getElementById('hot24List');
    if (!el) return;
    try {
      const { list } = await api('/api/hot24');
      el.innerHTML = (list || []).slice(0, 8).map((t, i) => `
        <li><a href="/post/${t.slug || t.id}" class="r-name">${i + 1}. ${esc(t.title)}</a></li>
      `).join('') || '<li class="muted">暂无热文</li>';
    } catch (e) { el.innerHTML = '<li class="muted">加载失败</li>'; }
  }
  async function renderCheckinPanel() {
    if (!state.user) {
      els.checkinPanel.innerHTML = `<p class="muted" style="margin-top:0">登录后每日签到，领取 3~5 个鸡腿 🍗</p><a href="/login" class="btn btn-primary btn-block">登录签到</a>`;
      return;
    }
    const today = localToday();
    const checked = (state.user.lastCheckin || '') === today;
    els.checkinPanel.innerHTML = `
      <p class="muted" style="margin-top:0">🍗 我的鸡腿：<b style="color:var(--accent)">${state.user.coins || 0}</b></p>
      ${checked
        ? `<button class="btn btn-ghost btn-block" disabled>今日已签到 ✓</button>`
        : `<button class="btn btn-primary btn-block" id="doCheckin">立即签到</button>`}
    `;
    const btn = document.getElementById('doCheckin');
    if (btn) btn.addEventListener('click', doCheckin);
  }

  /* 侧栏用户卡片：登录后显示在右侧栏顶部，未登录隐藏 */
  function renderSideUserCard() {
    const el = els.sideUserCard;
    if (!el) return;
    if (!state.user) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const u = state.user;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="suc-head">
        <a href="/space/${esc(u.username)}"><img class="suc-avatar" src="${esc(avatar(u))}" alt=""></a>
        <div class="suc-id">
          <div class="suc-name"><a href="/space/${esc(u.username)}">${esc(u.name)}</a>${roleTag(u)}</div>
          <div class="suc-meta">@${esc(u.username)} · ${esc(u.levelTitle || '')}</div>
        </div>
        ${levelTag(u)}
      </div>
      ${expBar(u)}
      <div class="suc-stats">
        <span>🍗 鸡腿 <b style="color:var(--accent)">${u.coins || 0}</b></span>
        <span>经验 <b>${(u.exp || 0).toLocaleString()}</b></span>
      </div>
      <div class="suc-links">
        <a href="/space/${esc(u.username)}">📝 我的帖子</a>
        <a href="/favorites">⭐ 我的收藏</a>
        <a href="/settings">⚙️ 个人设置</a>
      </div>`;
  }

  async function doCheckin() {
    if (!state.user) { route('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    try {
      const r = await api('/api/checkin', { method: 'POST' });
      if (r.ok) {
        state.user.coins = r.coins;
        state.user.lastCheckin = r.lastCheckin || localToday();
        updateAuthUI();
        renderCheckinPanel();
        loadCheckinRank();
        toast(`签到成功！获得 ${r.gained} 个鸡腿 🍗`, 'ok', 3000);
      } else {
        toast(r.msg || '今天已经签到过了', 'ok');
        renderCheckinPanel();
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- pages ---------- */
  async function renderHome(boardSlug, sort, page = 1, feed = '') {
    const qs = new URLSearchParams();
    if (feed === 'following') qs.set('following', '1');
    else { if (boardSlug) qs.set('board', boardSlug); if (sort) qs.set('sort', sort); }
    qs.set('page', page);
    const [data] = await Promise.all([api('/api/topics?' + qs.toString()), loadBoards(), loadTags()]);
    const topics = data.list || [];
    const pages = data.pages || 1;
    const cur = Math.min(page, pages);
    /* 关注流：只看关注的人发的帖子 */
    if (feed === 'following') {
      const buildUrl = (p) => '/?feed=following' + (p > 1 ? `&page=${p}` : '');
      let recHtml = '';
      if (!topics.length) {
        const rec = await api('/api/rank/active').catch(() => []);
        const myFollowing = new Set((state.user && state.user.following) || []);
        const users = (Array.isArray(rec) ? rec : []).filter(u => !state.user || (u.id !== state.user.id && !myFollowing.has(u.id))).slice(0, 6);
        recHtml = `
          <div class="card follow-empty">
            <div class="follow-empty-ic">👥</div>
            <div class="follow-empty-t">快去关注你感兴趣的用户吧！</div>
            <p class="muted">关注后，这里会显示他们发布的最新帖子</p>
            ${state.user ? '' : `<a class="btn btn-primary" href="/login?next=${encodeURIComponent('/?feed=following')}">登录查看关注动态</a>`}
          </div>
          ${users.length ? `<div class="follow-rec">
            <div class="follow-rec-t">为你推荐</div>
            ${users.map(u => `
              <div class="follow-rec-item">
                <a href="/space/${esc(u.username)}"><img src="${esc(u.avatar || '/assets/logo.png')}" alt="" loading="lazy"></a>
                <div class="fri-id">
                  <a class="fri-name" href="/space/${esc(u.username)}">${esc(u.name)}</a>
                  <span class="fri-tag">社区活跃用户 · 近7天 ${u.total} 条动态</span>
                </div>
                <button class="btn btn-sm btn-primary follow-btn" data-username="${esc(u.username)}" data-id="${esc(u.id)}">+ 关注</button>
              </div>`).join('')}
          </div>` : ''}`;
      }
      renderPage(`
        <div class="card" style="padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="font-weight:700">👀 关注动态</div>
          <div class="muted" style="font-size:13px">只看你关注的人发的帖子</div>
        </div>
        ${topics.length ? postListHtml(topics) + (pages > 1 ? `<div class="card" style="padding:12px;margin-top:14px;display:flex;justify-content:center">${pager(cur, pages, buildUrl)}</div>` : '') : recHtml}
      `);
      document.querySelectorAll('.follow-btn').forEach(b => b.addEventListener('click', async () => {
        if (!state.user) return route('/login?next=' + encodeURIComponent('/?feed=following'));
        try {
          const r = await api('/api/users/' + encodeURIComponent(b.dataset.username) + '/follow', { method: 'POST' });
          const myF = state.user.following || (state.user.following = []);
          if (r.following) { if (!myF.includes(b.dataset.id)) myF.push(b.dataset.id); }
          else { const i = myF.indexOf(b.dataset.id); if (i >= 0) myF.splice(i, 1); }
          b.textContent = r.following ? '✓ 已关注' : '+ 关注';
          b.classList.toggle('btn-primary', !r.following);
          b.classList.toggle('btn-outline', r.following);
          toast(r.following ? '已关注' : '已取消关注');
        } catch (e) { toast(e.message, 'err'); }
      }));
      setNav('home');
      return;
    }
    const title = boardSlug ? boardBySlug(boardSlug)?.name + '板块' : '最新帖子';
    const buildUrl = (p) => {
      const p2 = new URLSearchParams();
      if (boardSlug) p2.set('board', boardSlug);
      if (sort) p2.set('sort', sort);
      if (p > 1) p2.set('page', p);
      const s = p2.toString();
      return '/' + (s ? '?' + s : '');
    };
    renderPage(`
      ${boardTabsHtml(boardSlug)}
      ${boardSlug === 'unemployment' ? `
        <a href="/companies" class="card comp-banner">
          <div class="comp-banner-ic">🏢</div>
          <div class="comp-banner-txt">
            <div class="comp-banner-t">重庆公司避雷库</div>
            <div class="muted">找工作先查一查：看评分、读避雷理由，给真实经历打个星 →</div>
          </div>
        </a>` : ''}
      <div class="card" style="padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div style="font-weight:700">${esc(title)}</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${pages > 1 ? pager(cur, pages, buildUrl, true) : ''}
          ${sortTabsHtml(sort || 'latest')}
          ${state.user ? `<a href="/compose" class="btn btn-primary btn-sm">✍️ 发帖</a>` : ''}
        </div>
      </div>
      ${postListHtml(topics)}
      ${pages > 1 ? `<div class="card" style="padding:12px;margin-top:14px;display:flex;justify-content:center">${pager(cur, pages, buildUrl)}</div>` : ''}
    `);
    bindSortTabs(boardSlug, sort || 'latest');
    setNav('home');
  }

  function bindSortTabs(boardSlug, current) {
    document.querySelectorAll('.sort-tabs a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const sort = a.dataset.sort;
        if (sort === current) return;
        const base = boardSlug ? `/?board=${encodeURIComponent(boardSlug)}` : '/';
        route(base + (sort === 'latest' ? '' : (base === '/' ? '?' : '&') + 'sort=' + sort));
      });
    });
  }

  /* 板块频道：横滑板块 tabs + 帖子列表（虎扑赛事式） */
  async function renderBoards(boardSlug = '', page = 1) {
    await loadBoards();
    const qs = new URLSearchParams();
    if (boardSlug) qs.set('board', boardSlug);
    qs.set('page', page);
    const [data] = await Promise.all([api('/api/topics?' + qs.toString())]);
    const topics = data.list || [];
    const pages = data.pages || 1;
    const cur = Math.min(page, pages);
    const buildUrl = (p) => '/boards' + (boardSlug ? `?board=${encodeURIComponent(boardSlug)}` : '') + (p > 1 ? `${boardSlug ? '&' : '?'}page=${p}` : '');
    renderPage(`
      ${boardTabsHtml(boardSlug, (s) => `/boards?board=${encodeURIComponent(s)}`, '/boards', ' ch-board-tabs')}
      ${pages > 1 ? `<div style="display:flex;justify-content:flex-end;margin:2px 2px 10px">${pager(cur, pages, buildUrl, true)}</div>` : ''}
      ${postListHtml(topics)}
      ${pages > 1 ? `<div class="card" style="padding:12px;margin-top:14px;display:flex;justify-content:center">${pager(cur, pages, buildUrl)}</div>` : ''}
    `);
    setNav('boards');
  }

  /* ⭐ 推荐阅读：精选帖（管理员推荐）+ 热门帖聚合 */
  async function renderFeatured() {
    const [feat, hot] = await Promise.all([
      api('/api/topics?recommended=1&pageSize=50'),
      api('/api/topics?sort=hot&pageSize=24'),
    ]);
    const featList = feat.list || [];
    const featIds = new Set(featList.map(t => t.id));
    const hotList = (hot.list || []).filter(t => !featIds.has(t.id)).slice(0, 20);
    renderPage(`
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:800">⭐ 推荐阅读</div>
        <p class="muted" style="margin:6px 0 0">管理员精选的好帖 + 全站最热讨论，时间不多时从这里开始看。</p>
      </div>
      ${sectionTitle('⭐ 精选帖', featList.length ? `共 ${featList.length} 篇` : '')}
      ${featList.length ? postListHtml(featList) : `<div class="empty-state"><div class="big">⭐</div><p>暂无精选帖，管理员会在后台把好帖设为「推荐」。</p></div>`}
      ${sectionTitle('🔥 热门帖', '按阅读与回复综合排序')}
      ${hotList.length ? postListHtml(hotList) : `<div class="empty-state"><div class="big">🔥</div><p>暂无热门帖</p></div>`}
    `);
    setNav('featured');
  }

  /* 🌱 新人墙：最近注册的 30 位新用户 */
  async function renderNewbies() {
    const data = await api('/api/users/new');
    const list = data.list || [];
    renderPage(`
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:800">🌱 新人墙</div>
        <p class="muted" style="margin:6px 0 0">最近加入社区的新朋友，点进去打个招呼吧。</p>
      </div>
      ${list.length ? `<div class="newbie-grid">${list.map(u => `
        <a class="newbie-card" href="/space/${esc(u.username)}">
          <img src="${esc(avatar(u))}" alt="" loading="lazy">
          <div class="nb-name">${esc(u.name || u.username)}</div>
          <div class="nb-meta">@${esc(u.username)}</div>
          <div class="nb-lv">${levelTag(u)}</div>
          <div class="nb-time">${fmtDateTime(u.createdAt)} 加入</div>
        </a>`).join('')}</div>` : `<div class="empty-state"><div class="big">🌱</div><p>还没有新用户</p></div>`}
    `);
    setNav('newbies');
  }

  /* 🎲 幸运抽奖：列表 + 发起（确定性洗牌，种子公开可复算） */
  async function renderLucky() {
    const list = await api('/api/lottery');
    const me = state.user;
    const card = (l) => {
      const drawn = l.status === 'drawn';
      const cond = l.drawAt ? `⏰ ${fmtDateTime(l.drawAt)} 开奖` : (l.targetFloors ? `🎯 回复满 ${l.targetFloors} 楼开奖` : '');
      return `
      <div class="card" style="padding:16px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:17px;font-weight:800">🎲 ${esc(l.title)}</span>
          <span class="board-chip" style="--bc:${drawn ? '#888' : '#185a56'}">${drawn ? '已开奖' : '进行中'}</span>
        </div>
        <p class="muted" style="margin:8px 0 0">
          关联帖子：<a href="/post/${esc(l.topicSlug || l.topicId)}">${esc(l.topicTitle || '查看帖子')}</a><br>
          🎁 ${l.prizeCount} 份奖品 · 从 ${l.startFloor} 楼开始抽 · ${l.dedupe === false ? '可重复中奖' : '每人只中一次'}<br>
          ${cond} · 由 ${esc(l.createdByName || '')} 发起于 ${fmtDateTime(l.createdAt)}
        </p>
        ${drawn ? `<div style="margin-top:10px">
          <div style="font-weight:700">🏆 中奖名单</div>
          <p style="margin:6px 0 0">${(l.winners || []).map(w => `#${w.floor} 楼 ${esc(w.name)}${w.username ? `（@${esc(w.username)}）` : ''}`).join('、') || '暂无有效参与楼层'}</p>
          <p class="muted" style="margin:6px 0 0;font-size:12px">${esc(l.seedInfo || '')}</p>
        </div>` : `<p class="muted" style="margin:8px 0 0">去帖子里回复即可参与，开奖结果由公开种子复算，绝对公平。</p>`}
      </div>`;
    };
    renderPage(`
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:800">🎲 幸运抽奖</div>
        <p class="muted" style="margin:6px 0 0">回帖即参与，Fisher-Yates 洗牌 + 公开种子，结果人人可复算验证。</p>
      </div>
      ${me ? `
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-weight:800;margin-bottom:10px">发起新抽奖（自己帖子的楼主或管理员）</div>
        <input id="lk-topic" placeholder="帖子链接或帖子 ID（如 /post/xxx 里的 xxx）" style="width:100%;margin-bottom:8px">
        <input id="lk-title" placeholder="抽奖标题（可选）" maxlength="40" style="width:100%;margin-bottom:8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <input id="lk-prize" type="number" min="1" max="100" value="1" style="flex:1;min-width:110px" placeholder="奖品份数">
          <input id="lk-floor" type="number" min="2" value="2" style="flex:1;min-width:110px" placeholder="起始楼层">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <input id="lk-drawat" type="datetime-local" style="flex:1;min-width:180px">
          <input id="lk-target" type="number" min="1" style="flex:1;min-width:150px" placeholder="或：回复满 N 楼开奖">
        </div>
        <label class="muted" style="display:block;margin-bottom:10px"><input id="lk-dedupe" type="checkbox" checked> 每人只中一次</label>
        <button class="btn-primary" id="lk-create" style="min-height:44px;padding:0 18px">发起抽奖</button>
        <span class="muted" id="lk-msg" style="margin-left:10px"></span>
      </div>` : `
      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <a href="/login">登录</a> <span class="muted">后可为自己的帖子发起抽奖。</span>
      </div>`}
      ${sectionTitle('🎲 全部抽奖', `共 ${list.length} 个`)}
      ${list.length ? list.map(card).join('') : `<div class="empty-state"><div class="big">🎲</div><p>还没有抽奖，来发起第一个吧。</p></div>`}
    `);
    setNav('lucky');
    const btn = document.getElementById('lk-create');
    if (btn) btn.addEventListener('click', async () => {
      const msg = document.getElementById('lk-msg');
      let topicId = document.getElementById('lk-topic').value.trim();
      const m = topicId.match(/\/post\/([^/?#]+)/);
      if (m) topicId = decodeURIComponent(m[1]);
      if (!topicId) { msg.textContent = '请先填帖子链接或 ID'; return; }
      const drawVal = document.getElementById('lk-drawat').value;
      const body = {
        topicId,
        title: document.getElementById('lk-title').value.trim(),
        prizeCount: parseInt(document.getElementById('lk-prize').value || '1', 10),
        startFloor: parseInt(document.getElementById('lk-floor').value || '2', 10),
        dedupe: document.getElementById('lk-dedupe').checked,
        drawAt: drawVal ? new Date(drawVal).toISOString() : null,
        targetFloors: parseInt(document.getElementById('lk-target').value || '', 10) || null,
      };
      if (!body.drawAt && !body.targetFloors) { msg.textContent = '请设置开奖时间或目标楼层数'; return; }
      btn.disabled = true; msg.textContent = '提交中…';
      try {
        await api('/api/lottery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        msg.textContent = '已发起！';
        await renderLucky();
      } catch (e) { msg.textContent = e.message || '发起失败'; btn.disabled = false; }
    });
  }

  /* ⚖️ 管理记录公示：封禁 / 删帖 / 置顶等操作公开可查 */
  async function renderRuling(params) {
    const page = Math.max(1, parseInt((params && params.get('page')) || '1', 10));
    const data = await api('/api/modlogs?page=' + page);
    const logs = data.logs || [];
    const pages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 30)));
    const row = (l) => `
      <div style="display:flex;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)">
        <span class="board-chip" style="--bc:#185a56;flex-shrink:0">${esc(l.action)}</span>
        <div style="min-width:0">
          <div>${l.target ? `<b>${esc(l.target)}</b> ` : ''}${esc(l.detail || '')}</div>
          <div class="muted" style="font-size:12px;margin-top:2px">操作人 ${esc(l.admin || '系统')} · ${fmtDateTime(l.createdAt)}</div>
        </div>
      </div>`;
    renderPage(`
      <div class="card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:800">⚖️ 管理记录公示</div>
        <p class="muted" style="margin:6px 0 0">所有封禁、删帖、置顶、锁定等管理操作都在这里公开，管理透明可查。有异议可私信管理员申诉。</p>
      </div>
      <div class="card" style="padding:6px 16px">
        ${logs.length ? logs.map(row).join('') : `<div class="empty-state"><div class="big">⚖️</div><p>暂无管理记录</p></div>`}
      </div>
      ${pages > 1 ? `<div class="card" style="padding:12px;margin-top:14px;display:flex;justify-content:center;gap:14px;align-items:center">
        ${page > 1 ? `<a href="/ruling?page=${page - 1}">‹ 上一页</a>` : ''}
        <span class="muted">${page} / ${pages}</span>
        ${page < pages ? `<a href="/ruling?page=${page + 1}">下一页 ›</a>` : ''}
      </div>` : ''}
    `);
    setNav('ruling');
  }

  async function renderTrends(tab) {
    const tabs = `
      <div class="board-tabs">
        <a href="/trends?tab=day" class="${tab === 'day' ? 'active' : ''}">24 小时</a>
        <a href="/trends?tab=week" class="${tab === 'week' ? 'active' : ''}">7 天</a>
        <a href="/trends?tab=month" class="${tab === 'month' ? 'active' : ''}">30 天</a>
      </div>`;
    const days = tab === 'week' ? 7 : tab === 'month' ? 30 : 1;
    const { list } = await api('/api/hot24?days=' + days);
    const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<span class="trend-no">${i + 1}</span>`;
    renderPage(`
      <div class="rank-card">
        <h2>🔥 热点 <span class="muted" style="font-size:13px;font-weight:400">按点赞 / 回复 / 浏览 / 收藏综合热度</span></h2>
        ${tabs}
        <div class="trend-list">
          ${list.map((t, i) => `
            <a class="trend-item" href="/post/${t.slug || t.id}">
              <span class="trend-medal">${medal(i)}</span>
              <span class="trend-main">
                <span class="trend-title">${t.prefix ? `<span class="prefix-tag">${esc(t.prefix)}</span>` : ''}${esc(t.title)}</span>
                <span class="trend-meta"><span class="board-chip" style="--bc:${t.boardColor}">${esc(t.boardName)}</span> <span class="trend-counts">👍 ${t.likeCount} · 💬 ${t.replyCount} · 👁 ${t.viewCount}</span> <span class="trend-heat">🔥 ${fmtNum(t.likeCount * 3 + t.replyCount * 2 + t.viewCount * 0.1)}</span></span>
              </span>
              <span class="trend-time muted">${fmtTime(t.bumpedAt)}</span>
            </a>`).join('') || '<div class="muted" style="text-align:center;padding:32px">该时段暂无热帖</div>'}
        </div>
      </div>
    `);
    setNav('trends');
  }

  function renderGuide() {
    const sec = (id, icon, title, body) => `
      <section class="guide-sec" id="g-${id}">
        <h3>${icon} ${title}</h3>
        <div class="guide-body">${body}</div>
      </section>`;
    renderPage(`
      <div class="rank-card guide-page">
        <h2>📖 新手教程</h2>
        <p class="muted">欢迎来到 JM 社区！这篇教程按代码实际逻辑编写，看完 5 分钟，玩转社区不迷路。</p>
        <div class="guide-toc">
          <a href="#g-start">🚀 快速上手</a><a href="#g-post">✍️ 发帖指南</a><a href="#g-coins">🍗 鸡腿签到</a>
          <a href="#g-level">📊 等级经验</a><a href="#g-company">🏢 公司避雷库</a><a href="#g-shop">🛒 积分商城</a>
          <a href="#g-lucky">🎲 抽奖工具</a><a href="#g-pro">💡 进阶玩法</a><a href="#g-safe">⚠️ 交易安全</a><a href="#g-faq">❓ 常见问题</a>
        </div>
        ${sec('start', '🚀', '快速上手', `
          <ol>
            <li><b>注册</b>：点右上角「注册」，填用户名+密码即可；如果有朋友的<b>邀请码</b>，填上——朋友能得 20 鸡腿奖励，你也能更快融入。</li>
            <li><b>登录后先签到</b>：首页点「签到」按钮，每天领 <b>3~5 个鸡腿</b> + 3 点经验，连续签到还有成就徽章。</li>
            <li><b>逛逛板块</b>：顶部「板块」看全部分区，体育迷直接去体育专区（篮球/足球/电竞等 11 个板块）。</li>
            <li><b>第一帖</b>：点「发帖」选对板块，标题写清楚，内容支持 Markdown。发完记得回来看看回复！</li>
          </ol>`)}
        ${sec('post', '✍️', '发帖指南', `
          <ul>
            <li><b>选对板块</b>：帖子发到对应板块才有人看；部分板块（如福利分享）会自动带入<b>发帖模板</b>，照着填就行。</li>
            <li><b>前缀标签</b>：体育区发帖可加 [流言板][赛后][前瞻][战报][专栏][讨论][提问][分享][转会][投票] 等前缀，一眼看懂帖子类型。</li>
            <li><b>Markdown</b>：支持 **加粗**、*斜体*、&#96;代码&#96;、代码块、引用、列表、链接、图片。注意代码块内容会被转义，贴代码很安全。</li>
            <li><b>投票帖</b>：发帖时可添加投票选项，适合「二选一」「选最佳」类话题，投票结果实时统计。</li>
            <li><b>阅读权限</b>：发帖时可设阅读等级（LV1~LV10），等级不够的用户打不开，适合发内部干货。</li>
            <li><b>悬赏帖</b>：可设置鸡腿悬赏，最佳答案被采纳后悬赏自动发放。</li>
            <li><b>编辑记录</b>：帖子编辑后会公示编辑历史，坦荡交流。</li>
            <li><b>楼层直达</b>：每层楼的 #编号 可点击复制链接，分享给朋友直达该楼；「👁 只看楼主」一键过滤。</li>
          </ul>`)}
        ${sec('coins', '🍗', '鸡腿与签到', `
          <ul>
            <li><b>鸡腿</b>是社区积分：注册送 <b>10</b> 个，每日签到 <b>3~5</b> 个，被邀请注册、发悬赏被采纳都能赚。</li>
            <li>鸡腿用途：积分商城买<b>头衔/徽章</b>、发<b>悬赏帖</b>、参与抽奖。</li>
            <li>签到连续 <b>7 天 / 30 天</b>解锁成就，在「成就墙」查看你的收集进度。</li>
            <li>排行榜有「鸡腿总榜」和「今日签到榜」，看看谁是鸡腿大户。</li>
          </ul>`)}
        ${sec('level', '📊', '等级与经验', `
          <p>经验决定等级，等级解锁更多玩法（LV2+ 可生成邀请码、发帖可设更高阅读权限）：</p>
          <ul>
            <li>发帖 <b>+5</b> 经验 ／ 回复 <b>+2</b> ／ 每日签到 <b>+3</b> ／ 写公司评价 <b>+3</b> ／ 帖子被点赞 <b>+1</b></li>
            <li>升级会收到站内通知，个人空间有 <b>📊 等级进度面板</b>：全等级轴 + 主题/回复/获赞/被收藏/签到天数/鸡腿六维数据，一目了然。</li>
          </ul>
          <table class="guide-table"><thead><tr><th>等级</th><th>称号</th><th>所需经验</th></tr></thead><tbody>
          <tr><td>LV1</td><td>初来乍到</td><td>0</td></tr><tr><td>LV2</td><td>论坛新人</td><td>50</td></tr>
          <tr><td>LV3</td><td>活跃会员</td><td>150</td></tr><tr><td>LV4</td><td>资深会员</td><td>300</td></tr>
          <tr><td>LV5</td><td>论坛达人</td><td>500</td></tr><tr><td>LV6</td><td>论坛精英</td><td>800</td></tr>
          <tr><td>LV7</td><td>论坛名士</td><td>1200</td></tr><tr><td>LV8</td><td>论坛大师</td><td>1800</td></tr>
          <tr><td>LV9</td><td>论坛传奇</td><td>2600</td></tr><tr><td>LV10</td><td>社区之神</td><td>3600</td></tr>
          </tbody></table>`)}
        ${sec('company', '🏢', '公司避雷库（小白指南）', `
          <p>社区接入了 <b>585 万家</b>全国公司数据 + 真实员工评价，找工作前先来查一查：</p>
          <ul>
            <li><b>🔍 查公司</b>：点「避雷库」，搜公司名。支持按省份筛选、按评价数/好评率排序。列表页远程数据会置顶显示本地已有评价的公司。</li>
            <li><b>⭐ 写评价</b>：进公司详情页写评价（需登录），给分 + 写真实体验，<b>+3 经验</b>。你的评价会帮助下一个求职者。</li>
            <li><b>➕ 添加公司</b>：搜不到？点「添加公司」手动录入，丰富库的同时也方便自己写评价。</li>
            <li><b>📌 避雷清单</b>：看到可疑公司点「加入避雷清单」，在「我的避雷清单」统一管理，投简历前对照看一眼。</li>
            <li><b>排序小技巧</b>：按「评价数」找讨论最多的，按「好评率」找口碑好的；差评多的公司点进去看具体评价内容再下结论。</li>
          </ul>`)}
        ${sec('shop', '🛒', '积分商城', `
          <ul>
            <li>用鸡腿兑换：<b>自定义头衔</b>（80，7 天）／<b>老司机</b>（300，永久）／<b>社区元老</b>（500，永久）／<b>退隐大佬</b>（800，永久）／<b>鸡汤大户徽章</b>（300）。</li>
            <li>买过的头衔进入你的<b>头衔库存</b>，在个人空间随时切换佩戴哪个，不会丢失。</li>
          </ul>`)}
        ${sec('lucky', '🎲', '幸运抽奖 & 社区工具', `
          <ul>
            <li><b>幸运抽奖</b>：<a href="/lucky">/lucky</a> 发起抽奖（Fisher-Yates 洗牌 + 公开种子可复算，绝对公平）；帖子正文写 <b>[lucky:编号]</b> 可把抽奖卡片嵌入帖子，还能一键复制抽奖口号去拉人。</li>
            <li><b>热点榜</b>：<a href="/trends">/trends</a> 看 24 小时 / 7 天 / 30 天热文，不错过大事。</li>
            <li><b>RSS 订阅</b>：<a href="/rss.xml">/rss.xml</a>，用阅读器订阅社区更新。</li>
            <li><b>管理公示</b>：<a href="/ruling">/ruling</a> 公开所有封禁/删帖/置顶/锁定记录，管理透明可查。</li>
          </ul>`)}
        ${sec('pro', '💡', '进阶玩法', `
          <ul>
            <li><b>表情回应</b>：帖子下方可点 ❤️😂😮😢👏🔥 快速表态，不用回帖也能参与。</li>
            <li><b>书签提醒</b>：收藏帖子时点 ⏰ 设提醒（几小时后），到期自动发站内通知，追更连载帖神器。</li>
            <li><b>邀请码</b>：LV2+ 用户在个人空间生成邀请码（默认 5 次），朋友用你的码注册你得 <b>20 鸡腿</b>。</li>
            <li><b>慢速模式</b>：热帖可能开启 🐢 慢速模式，回帖有冷却间隔，理性讨论。</li>
            <li><b>私信</b>：点用户头像进空间可发私信，右上角铃铛看通知（有人@你、回你帖都会提醒）。</li>
            <li><b>用户小卡片</b>：鼠标悬停用户名 0.45 秒弹出小卡片，快速了解对方。</li>
          </ul>`)}
        ${sec('safe', '⚠️', '交易安全', `
          <ul>
            <li>社区<b>不担保</b>任何私下交易：买卖账号、代充、兼职收款等务必走正规平台。</li>
            <li>不轻信「先款后货」、不点陌生链接、不透露验证码。被骗请保留证据并联系管理。</li>
            <li>看到诈骗帖请举报，管理核实后会删帖封禁并公示在 /ruling。</li>
          </ul>`)}
        ${sec('faq', '❓', '常见问题', `
          <ul>
            <li><b>忘记密码？</b>目前请联系管理员重置。</li>
            <li><b>帖子被删了？</b>去 <a href="/ruling">/ruling</a> 查管理记录，公示了原因；有异议可私信管理员申诉。</li>
            <li><b>公司库相关问题</b>（搜不到公司、评价怎么写）→ 看上面「🏢 公司避雷库」一节。</li>
            <li><b>鸡腿不够用？</b>每日签到 + 多发优质帖，优质内容被点赞也有经验加速升级。</li>
            <li><b>页面显示异常？</b>先下拉刷新或清缓存重进，仍不行请截图反馈给管理员。</li>
          </ul>`)}
      </div>
    `);
    setNav('guide');
  }

  async function renderRank(tab) {
    const tabs = `
      <div class="board-tabs">
        <a href="/rank?tab=week" class="${tab === 'week' ? 'active' : ''}">本周活跃</a>
        <a href="/rank?tab=month" class="${tab === 'month' ? 'active' : ''}">本月活跃</a>
        <a href="/rank?tab=checkin" class="${tab === 'checkin' ? 'active' : ''}">今日签到榜</a>
        <a href="/rank?tab=coins" class="${tab === 'coins' ? 'active' : ''}">鸡腿总榜</a>
        <a href="/rank?tab=level" class="${tab === 'level' ? 'active' : ''}">等级榜</a>
      </div>`;
    if (tab === 'level') {
      const list = await api('/api/rank/level');
      renderPage(`
        <div class="rank-card">
          <h2>🏆 排行榜</h2>
          ${tabs}
          <table class="rank-table">
            <thead><tr><th>排名</th><th>用户</th><th style="text-align:right">等级</th><th style="text-align:right">经验</th></tr></thead>
            <tbody>
              ${list.map((u, i) => `
                <tr>
                  <td class="no ${i < 3 ? 'top' + (i + 1) : ''}">${i + 1}</td>
                  <td><a class="rank-user" href="/space/${esc(u.username)}"><img src="${esc(avatar(u))}" alt="">${esc(u.name)} ${levelTag(u)} <span class="muted">@${esc(u.username)}</span></a></td>
                  <td style="text-align:right">Lv.${u.level} ${esc(u.levelTitle)}</td>
                  <td style="text-align:right"><span class="coins">⚡ ${u.exp.toLocaleString()}</span></td>
                </tr>`).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">暂无数据</td></tr>'}
            </tbody>
          </table>
        </div>
      `);
      setNav('rank');
      return;
    }
    if (tab === 'week' || tab === 'month') {
      const list = await api('/api/rank/active?period=' + (tab === 'month' ? 'month' : 'week'));
      renderPage(`
        <div class="rank-card">
          <h2>🏆 排行榜</h2>
          ${tabs}
          <table class="rank-table">
            <thead><tr><th>排名</th><th>用户</th><th style="text-align:right">发帖</th><th style="text-align:right">回复</th><th style="text-align:right">合计</th></tr></thead>
            <tbody>
              ${list.map((u, i) => `
                <tr>
                  <td class="no ${i < 3 ? 'top' + (i + 1) : ''}">${i + 1}</td>
                  <td><a class="rank-user" href="/space/${esc(u.username)}"><img src="${esc(avatar(u))}" alt="">${esc(u.name)} <span class="muted">@${esc(u.username)}</span></a></td>
                  <td style="text-align:right">${u.posts}</td>
                  <td style="text-align:right">${u.replies}</td>
                  <td style="text-align:right"><span class="coins">🔥 ${u.total}</span></td>
                </tr>`).join('') || '<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">本期暂无活跃记录</td></tr>'}
            </tbody>
          </table>
        </div>
      `);
      setNav('rank');
      return;
    }
    const list = await api('/api/rank/' + tab);
    renderPage(`
      <div class="rank-card">
        <h2>🏆 排行榜</h2>
        ${tabs}
        <table class="rank-table">
          <thead><tr><th>排名</th><th>用户</th><th style="text-align:right">鸡腿</th></tr></thead>
          <tbody>
            ${list.map((u, i) => `
              <tr>
                <td class="no ${i < 3 ? 'top' + (i + 1) : ''}">${i + 1}</td>
                <td><a class="rank-user" href="/space/${esc(u.username)}"><img src="${esc(avatar(u))}" alt="">${esc(u.name)} <span class="muted">@${esc(u.username)}</span></a></td>
                <td style="text-align:right"><span class="coins">🍗 ${u.coins}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `);
    setNav('rank');
  }

  async function renderPost(slug) {
    let topic;
    try {
      [topic] = await Promise.all([api('/api/topics/' + encodeURIComponent(slug)), loadBoards()]);
    } catch (e) {
      /* 阅读等级不足 */
      if (e.needLevel) {
        const myLv = e.myLevel || 0;
        renderPage(`<div class="card" style="text-align:center;padding:40px 20px;max-width:520px;margin:40px auto">
          <div style="font-size:48px">🔒</div>
          <h2 style="margin:12px 0 8px">该帖子需要 LV${e.needLevel} 及以上才能查看</h2>
          <p class="muted" style="font-size:13px">${myLv ? `你当前等级：LV${myLv}，多发帖、回帖、签到可升级` : '登录后多发帖、回帖、签到可提升等级'}</p>
          <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
            ${myLv ? '' : '<a class="btn btn-primary" href="/login?next=' + encodeURIComponent(location.pathname) + '">登录</a>'}
            <a class="btn btn-ghost" href="/">返回首页</a>
          </div>
        </div>`);
        return;
      }
      throw e;
    }
    const bd = topic.board;
    const op = topic.posts[0];
    const opAuthor = op.author;
    const head = `
      <div class="topic-back"><a href="${bd ? '/?board=' + encodeURIComponent(bd.slug) : '/'}">← 返回${bd ? esc(bd.name) : '列表'}</a></div>
      <div class="topic-head">
        <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
          ${bd ? `<a class="badge badge-bd" style="background:${esc(bd.color)}" href="/?board=${encodeURIComponent(bd.slug)}">${esc(bd.name)}</a>` : ''}
          ${topic.pinned ? '<span class="badge badge-pin">置顶</span>' : ''}
          ${topic.recommended ? '<span class="badge badge-rec">推荐阅读</span>' : ''}
          ${topic.price ? `<span class="price-tag">💰 ¥ ${topic.price}</span>` : ''}
          ${topic.bounty ? `<span class="price-tag bounty-tag">💰 悬赏 ${topic.bounty} 鸡腿</span>` : ''}
          ${topic.poll ? `<span class="badge badge-rec">🗳️ 投票</span>` : ''}
          ${topic.slowMode ? `<span class="badge" style="background:#fef3c7;color:#b45309" title="每人每 ${topic.slowMode} 秒只能回复一次">🐢 慢速 ${topic.slowMode}s</span>` : ''}
          ${(topic.tags || []).map(t => `<a class="tag-chip tag-link" href="/tag/${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
        </div>
        <h1>${esc(topic.title)}</h1>
        <div class="topic-meta">
          <a href="/space/${esc(opAuthor.username)}">${esc(opAuthor.name)}</a>${roleTag(opAuthor)}${levelTag(opAuthor)}${titleTag(opAuthor)}
          <span>·</span> <time datetime="${esc(topic.createdAt)}">${fmtTime(topic.createdAt)}</time>
          <span>·</span> 👁 ${fmtNum(topic.viewCount)} 浏览
          <span>·</span> 💬 ${fmtNum(topic.replyCount)} 回复
          <span>·</span> ⭐ ${fmtNum(topic.favoriteCount)} 收藏
          ${topic.poll ? `<span>·</span> 🗳️ ${topic.poll.total || 0} 人投票` : ''}
        </div>
      </div>
    `;

    /* 投票面板 */
    const pollHtml = topic.poll ? `
      <div class="card poll-card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">🗳️ ${esc(topic.poll.question)} <span class="muted" style="font-weight:400;font-size:12px">${topic.poll.multi ? '多选' : '单选'} · ${topic.poll.total} 人参与</span></div>
        ${topic.poll.options.map((o, i) => {
          const isMine = o.myPick;
          const voted = state.user ? topic.poll.myVote >= 0 : false;
          return `<div class="poll-opt ${isMine ? 'mine' : ''}" data-i="${i}">
            <div class="poll-opt-text">${isMine ? '✅ ' : ''}${esc(o.text)} <span class="muted">${o.votes} 票 · ${o.ratio}%</span></div>
            ${voted ? `<div class="poll-bar"><div class="poll-bar-fill" style="width:${o.ratio}%"></div></div>` : ''}
          </div>`;
        }).join('')}
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
          ${state.user ? (topic.poll.myVote < 0 ? `<button class="btn btn-primary btn-sm" id="pollVote">${topic.poll.multi ? '提交投票' : '投票'}</button>` : `<button class="btn btn-outline btn-sm" id="pollVote">改票</button><span class="muted" style="font-size:12px">已投票，可改票</span>`) : `<a class="btn btn-sm btn-outline" href="/login?next=${encodeURIComponent(location.pathname)}">登录后投票</a>`}
        </div>
      </div>` : '';
    /* 悬赏面板（未采纳时展示给楼主/管理员） */
    const bountyHtml = topic.bounty ? (state.user && (state.user.id === topic.userId || isStaff(state.user)) ? `
      <div class="card" style="margin-bottom:14px;padding:14px;border-color:#f59e0b55">
        <div class="section-title" style="margin-top:0">💰 悬赏 ${topic.bounty} 鸡腿 · 待采纳</div>
        <p class="muted" style="font-size:13px;margin:0">在满意的回复上点击「✅ 采纳答案」，悬赏鸡腿将自动发放给该用户（不可撤销）。</p>
      </div>` : `<div class="card" style="margin-bottom:14px;padding:14px;border-color:#f59e0b55">
        <div class="section-title" style="margin-top:0">💰 悬赏 ${topic.bounty} 鸡腿</div>
        <p class="muted" style="font-size:13px;margin:0">楼主尚未采纳答案，悬赏悬而未决。帮楼主解决问题，有机会获得全部悬赏！</p>
      </div>`) : '';

    const postsHtml = (topic.posts || []).map((p, idx) => `
      <div class="post-item ${topic.bestReplyId === p.id ? 'best-reply' : ''}">
        <div class="post-avatar"><a href="/space/${esc(p.author.username)}"><img src="${esc(avatar(p.author))}" alt=""></a></div>
        <div class="post-main">
          <div class="post-head">
            <a class="post-username" href="/space/${esc(p.author.username)}">${esc(p.author.name)}</a>${roleTag(p.author)}${levelTag(p.author)}${titleTag(p.author)}
            <span class="post-floor">${p.postNumber} 楼</span>
            <span class="post-time">${fmtTime(p.createdAt)}</span>
            ${topic.bestReplyId === p.id ? '<span class="best-tag">🏆 最佳答案</span>' : ''}
            ${p.postNumber === 1 && topic.bounty ? '<span class="bounty-tag-sm">💰 悬赏帖</span>' : ''}
          </div>
          <div class="post-body">${parseHtml(p.content)}</div>
          ${p.author.signature && idx === 0 ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);font-size:12px;color:var(--text-muted)">${parseHtml(p.author.signature)}</div>` : ''}
          <div class="post-actions">
            <button class="like-btn ${p.likedByMe ? 'liked' : ''}" data-likes="${p.likeCount}" data-liked="${p.likedByMe ? 1 : 0}">👍 <span>${fmtNum(p.likeCount)}</span></button>
            ${state.user && p.author.id !== state.user.id ? `<button class="tip-btn" data-post="${esc(p.id)}" data-author="${esc(p.author.name)}">🍗 打赏</button>` : ''}
            ${idx === 0 && state.user ? `<button class="fav-btn ${topic.favorited ? 'fav-on' : ''}" id="favBtn">${topic.favorited ? '★ 已收藏' : '☆ 收藏'}</button>${topic.favorited ? `<button class="fav-btn" id="remindBtn" title="设置回看提醒">⏰ 提醒</button>` : ''}` : ''}
            <button class="copy-link">🔗 分享</button>
            ${idx > 0 ? `<button class="quote-btn" data-author="${esc(p.author.name)}" data-q="${encodeURIComponent(p.content)}">💬 引用</button>` : ''}
            ${topic.bounty && idx > 0 && state.user && (state.user.id === topic.userId || isStaff(state.user))
              ? `<button class="accept-btn" data-post="${esc(p.id)}" data-author="${esc(p.author.name)}">✅ 采纳答案</button>` : ''}
            <button class="report-btn" data-type="${idx === 0 ? 'topic' : 'reply'}" data-id="${idx === 0 ? esc(topic.id) : esc(p.id)}" data-title="${esc(idx === 0 ? topic.title : topic.id)}">🚩 举报</button>
            ${idx === 0 && state.user && (state.user.id === topic.userId || isStaff(state.user))
              ? `<span class="post-actions-sep"></span><a class="edit-btn" href="/compose?edit=${esc(topic.id)}">✏️ 编辑</a><button class="del-btn" data-id="${esc(topic.id)}">🗑️ 删除</button>`
              : ''}
          </div>
          ${idx === 0 ? `<div class="react-row">${['❤️','😂','😮','😢','👏','🔥'].map(e => {
            const st = (topic.reactions || {})[e] || { count: 0, mine: false };
            return `<button class="react-btn ${st.mine ? 'on' : ''}" data-emoji="${e}" title="回应">${e}<span>${st.count || ''}</span></button>`;
          }).join('')}</div>` : ''}
        </div>
      </div>`).join('');

    const replyBox = state.user ? `
      <div class="reply-box">
        <h3>发表回复</h3>
        <div class="editor-toolbar" id="replyBodyToolbar">
          <button type="button" data-ins="**$**" data-sel="加粗">B</button>
          <button type="button" data-ins="*$*" data-sel="斜体">I</button>
          <button type="button" data-ins="\`$" data-sel="代码">代码</button>
          <button type="button" data-ins="\`\`\`\n$\n\`\`\`" data-sel="代码块">代码块</button>
          <button type="button" data-ins="> ">引用</button>
          <button type="button" data-ins="- ">列表</button>
          <button type="button" data-ins="[$](https://)" data-sel="链接">链接</button>
          <button type="button" data-ins="@">@提及</button>
        </div>
        <textarea class="editor" id="replyBody" placeholder="友善交流，理性发言... 支持 **加粗** 和 @用户名 提醒"></textarea>
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
          <button class="btn btn-primary" id="submitReply">发布回复</button>
          <span class="error" id="replyError"></span>
        </div>
      </div>` : `
      <div class="reply-box" style="text-align:center;color:var(--text-muted)">
        <p>参与讨论请先 <a href="/login?next=${encodeURIComponent(location.pathname + location.search)}">登录</a> 或 <a href="/register">注册</a></p>
      </div>`;

    renderPage(`${head}${pollHtml}${bountyHtml}<div class="post-stream">${postsHtml}</div>${replyBox}`);

    // toolbar insert
    bindMdToolbar('replyBody');

    const submit = document.getElementById('submitReply');
    if (submit) submit.addEventListener('click', async () => {
      const content = document.getElementById('replyBody').value.trim();
      if (!content) return;
      try {
        await api(`/api/topics/${topic.id}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
        route(`/post/${topic.slug}`);
      } catch (e) { document.getElementById('replyError').textContent = e.message; }
    });

    /* 移动端底部评论条（虎扑 App 式） */
    setupMobileCommentBar(topic);

    // like（乐观更新：先改 UI，失败回滚）
    document.querySelectorAll('.like-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!state.user) { toast('请先登录', 'err'); route('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
        const wasLiked = btn.dataset.liked === '1';
        const oldCount = Number(btn.dataset.likes) || 0;
        const newCount = wasLiked ? Math.max(0, oldCount - 1) : oldCount + 1;
        // 乐观 UI
        btn.classList.toggle('liked', !wasLiked);
        btn.dataset.liked = wasLiked ? '0' : '1';
        btn.dataset.likes = newCount;
        btn.querySelector('span').textContent = fmtNum(newCount);
        try {
          const r = await api(`/api/topics/${topic.id}/like`, { method: 'POST' });
          btn.dataset.likes = r.likeCount;
          btn.dataset.liked = r.liked ? '1' : '0';
          btn.classList.toggle('liked', !!r.liked);
          btn.querySelector('span').textContent = fmtNum(r.likeCount);
        } catch (e) {
          // 回滚
          btn.classList.toggle('liked', wasLiked);
          btn.dataset.liked = wasLiked ? '1' : '0';
          btn.dataset.likes = oldCount;
          btn.querySelector('span').textContent = fmtNum(oldCount);
          toast(e.message, 'err');
        }
      });
    });
    // 表情回应
    document.querySelectorAll('.react-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!state.user) { toast('请先登录', 'err'); route('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
        const emoji = btn.dataset.emoji;
        const wasOn = btn.classList.contains('on');
        const span = btn.querySelector('span');
        const oldN = parseInt(span.textContent) || 0;
        btn.classList.toggle('on', !wasOn);
        span.textContent = wasOn ? (oldN - 1 || '') : oldN + 1;
        try {
          const r = await api(`/api/topics/${topic.id}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) });
          const st = r.stats[emoji];
          btn.classList.toggle('on', !!st.mine);
          span.textContent = st.count || '';
        } catch (e) {
          btn.classList.toggle('on', wasOn);
          span.textContent = oldN || '';
          toast(e.message, 'err');
        }
      });
    });
    // favorite（乐观更新）
    const fav = document.getElementById('favBtn');
    if (fav) fav.addEventListener('click', async () => {
      const wasOn = fav.classList.contains('fav-on');
      fav.classList.toggle('fav-on', !wasOn);
      fav.textContent = !wasOn ? '★ 已收藏' : '☆ 收藏';
      try {
        const r = await api(`/api/topics/${topic.id}/favorite`, { method: 'POST' });
        fav.classList.toggle('fav-on', !!r.favorited);
        fav.textContent = r.favorited ? '★ 已收藏' : '☆ 收藏';
      } catch (e) {
        fav.classList.toggle('fav-on', wasOn);
        fav.textContent = wasOn ? '★ 已收藏' : '☆ 收藏';
        toast(e.message, 'err');
      }
    });
    // 书签提醒
    const rmdBtn = document.getElementById('remindBtn');
    if (rmdBtn) rmdBtn.addEventListener('click', async () => {
      const v = prompt('什么时候提醒你回看？输入小时数（1-720），取消则留空后点"取消提醒"：\n如：24 = 1天后', '24');
      try {
        if (v === null) return;
        const hours = parseFloat(v);
        let at = null;
        if (v.trim() === '') { /* 取消 */ }
        else {
          if (!hours || hours < 1 || hours > 720) { toast('请输入 1-720 之间的小时数', 'err'); return; }
          at = new Date(Date.now() + hours * 3600000).toISOString();
        }
        await api(`/api/topics/${topic.id}/reminder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) });
        toast(at ? `已设置，${v} 小时后提醒你` : '已取消提醒');
      } catch (e) { toast(e.message, 'err'); }
    });
    // copy link（带降级）
    document.querySelectorAll('.copy-link').forEach(b => {
      b.addEventListener('click', async () => {
        const ok = await copyText(location.href);
        b.textContent = ok ? '✅ 已复制' : '🔗 分享';
        if (ok) { toast('链接已复制'); setTimeout(() => b.textContent = '🔗 分享', 1500); }
        else toast('复制失败，请手动复制地址栏', 'err');
      });
    });
    // 投票
    const pollVoteBtn = document.getElementById('pollVote');
    if (pollVoteBtn) {
      pollVoteBtn.addEventListener('click', async () => {
        const opts = [...document.querySelectorAll('.poll-opt')];
        let picked = null;
        const tempPick = () => { /* 点击选项临时选中 */ };
        opts.forEach(o => {
          o.addEventListener('click', () => {
            const multi = topic.poll.multi;
            if (multi) o.classList.toggle('sel');
            else { opts.forEach(x => x.classList.remove('sel')); o.classList.add('sel'); }
          });
        });
        const sel = opts.filter(o => o.classList.contains('sel')).map(o => +o.dataset.i);
        if (!sel.length) { toast('请先选择选项', 'err'); return; }
        try {
          await api(`/api/topics/${topic.id}/poll/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picks: sel }) });
          toast('投票成功！');
          route(`/post/${topic.slug}`);
        } catch (e) { toast(e.message, 'err'); }
      });
    }
    // 打赏（楼主或楼层）
    document.querySelectorAll('.tip-btn').forEach(b => {
      b.addEventListener('click', async () => {
        const amount = prompt(`打赏给「${b.dataset.author}」多少鸡腿？（1-10000）`);
        if (amount === null) return;
        const n = Math.floor(Number(amount));
        if (!n || n < 1 || n > 10000) { toast('请输入 1-10000 之间的鸡腿数', 'err'); return; }
        if (!confirm(`确认打赏 ${n} 个鸡腿给「${b.dataset.author}」？`)) return;
        try {
          const r = await api(`/api/topics/${topic.id}/tip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: n, replyId: b.dataset.post }) });
          state.user = { ...state.user, coins: r.coins };
          els.userCoins.textContent = '🍗 ' + (r.coins || 0);
          toast(`打赏成功！送出 🍗 ${n}`);
        } catch (e) { toast(e.message, 'err'); }
      });
    });
    // 采纳悬赏答案
    document.querySelectorAll('.accept-btn').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`确认采纳「${b.dataset.author}」的答案为最佳答案？悬赏 ${topic.bounty} 鸡腿将发放给他（不可撤销）`)) return;
        try {
          await api(`/api/topics/${topic.id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyId: b.dataset.post }) });
          toast('已采纳！悬赏已发放 🎉');
          route(`/post/${topic.slug}`);
        } catch (e) { toast(e.message, 'err'); }
      });
    });
    // 引用回复：把楼层内容以 blockquote 形式填入回复框
    document.querySelectorAll('.quote-btn').forEach(b => {
      b.addEventListener('click', () => {
        const ta = document.getElementById('replyBody');
        if (!ta) { toast('请先登录后再回复', 'err'); return; }
        const author = b.dataset.author;
        const content = decodeURIComponent(b.dataset.q).split('\n').slice(0, 12).map(l => '> ' + l).join('\n');
        const quote = `> ${author} 说：\n${content}\n\n`;
        ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' : '') + quote;
        ta.focus();
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('已引用该楼层，可继续补充你的回复', 'ok', 2000);
      });
    });
    // 删除帖子（作者/管理员）
    document.querySelectorAll('.del-btn').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('⚠️ 确认删除该帖子？此操作不可恢复！')) return;
        try {
          await api('/api/topics/' + b.dataset.id, { method: 'DELETE' });
          route('/');
        } catch (e) { alert(e.message); }
      });
    });
    // 举报
    document.querySelectorAll('.report-btn').forEach(b => {
      b.addEventListener('click', async () => {
        if (!state.user) { route('/login?next=' + encodeURIComponent(location.pathname)); return; }
        const reason = prompt('举报理由（必填，管理员会看到）：');
        if (reason === null) return;
        if (!reason.trim()) { alert('请填写举报理由'); return; }
        try {
          await api('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: b.dataset.type, targetId: b.dataset.id, targetTitle: b.dataset.title, reason: reason.trim() }) });
          b.textContent = '✅ 已举报';
          b.disabled = true;
        } catch (e) { alert(e.message); }
      });
    });
    setNav('');
  }

  /* Markdown 编辑器工具栏：给 textarea 绑定快捷插入 */
  function bindMdToolbar(taId) {
    const wrap = document.getElementById(taId + 'Toolbar');
    if (!wrap) return;
    wrap.querySelectorAll('button[data-ins]').forEach(b => {
      b.addEventListener('click', () => {
        const ta = document.getElementById(taId);
        if (!ta) return;
        const ins = b.dataset.ins;
        const sel = ta.selectionStart, end = ta.selectionEnd;
        const selected = ta.value.slice(sel, end) || b.dataset.sel || '';
        const text = ins.includes('$') ? ins.replace('$', selected) : ins;
        ta.value = ta.value.slice(0, sel) + text + ta.value.slice(end);
        ta.focus();
      });
    });
  }

  async function renderCompose() {
    if (!state.user) { route('/login?next=/compose'); return; }
    await loadBoards();
    const editId = new URLSearchParams(location.search).get('edit') || '';
    let t = null;
    if (editId) {
      try { t = await api('/api/topics/' + encodeURIComponent(editId)); } catch (e) { t = null; }
      if (!t || (t.userId !== state.user.id && !isStaff(state.user))) {
        renderPage('<div class="empty-state"><div class="big">🚫</div><p>你没有编辑权限</p></div>');
        return;
      }
    }
    renderPage(`
      <div class="card auth-card" style="max-width:760px">
        <h2>${t ? '✏️ 编辑帖子' : '✍️ 发布新帖'}</h2>
        <form id="composeForm">
          <div class="form-group">
            <label>标题</label>
            <input type="text" class="form-control" id="cTitle" placeholder="一句话概括主题" required maxlength="80" value="${t ? esc(t.title) : ''}" />
          </div>
          <div class="form-group">
            <label>板块</label>
            <select class="form-control" id="cBoard" required>
              ${state.boards.map(b => `<option value="${esc(b.id)}" ${t && t.board && t.board.id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>正文 <span class="muted" style="font-weight:400">（支持 **加粗** / *斜体* / \`代码\` / \`\`\`代码块\`\`\` / [链接](url) / 引用 / - 列表）</span></label>
            <div class="editor-toolbar" id="cContentToolbar">
              <button type="button" data-ins="**$**" data-sel="加粗">B</button>
              <button type="button" data-ins="*$*" data-sel="斜体">I</button>
              <button type="button" data-ins="\`$" data-sel="代码">代码</button>
              <button type="button" data-ins="\`\`\`\n$\n\`\`\`" data-sel="代码块">代码块</button>
              <button type="button" data-ins="> ">引用</button>
              <button type="button" data-ins="- ">列表</button>
              <button type="button" data-ins="[$](https://)" data-sel="链接">链接</button>
              <button type="button" data-ins="~~$~~" data-sel="删除线">删除线</button>
              <button type="button" data-ins="@">@提及</button>
            </div>
            <textarea class="form-control editor" id="cContent" rows="10" placeholder="写下你的内容..." required>${t ? esc(t.posts[0].content) : ''}</textarea>
          </div>
          <div class="form-group">
            <label>标签（用空格分隔，最多 5 个）</label>
            <input type="text" class="form-control" id="cTags" placeholder="例如：教程 分享" value="${t ? esc((t.tags || []).join(' ')) : ''}" />
          </div>
          <div id="cPreviewWrap" class="hidden" style="margin-bottom:14px">
            <label>预览效果</label>
            <div class="card" style="padding:14px;min-height:80px;margin-top:6px" id="cPreview"></div>
          </div>
          <div class="form-group" id="anonGroup" style="display:none">
            <label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer"><input type="checkbox" id="cAnonymous"> 🌳 匿名投稿（不显示我的名字）</label>
            <div class="help-text">电报树洞：投稿先由管理员审核，通过后同步到电报频道和论坛；带电报链接的内容会被过滤。</div>
          </div>
          <div class="form-group" id="priceGroup" style="display:none">
            <label>售价（元，仅交易板块）</label>
            <input type="number" class="form-control" id="cPrice" min="0" placeholder="0" value="${t && t.price ? esc(t.price) : ''}" />
          </div>
          <div class="form-group">
            <label>💰 悬赏（鸡腿） <span class="muted" style="font-weight:400;font-size:12px">发布悬赏帖，采纳答案后发放给回答者；当前余额：🍗 ${state.user.coins || 0}</span></label>
            <input type="number" class="form-control" id="cBounty" min="0" max="${state.user.coins || 0}" placeholder="0 = 普通帖；填 10+ 即悬赏帖" value="${t && t.bounty ? esc(t.bounty) : ''}" />
          </div>
          <div class="form-group">
            <label>🔒 阅读权限 <span class="muted" style="font-weight:400;font-size:12px">只有达到该等级的用户才能看这篇帖子</span></label>
            <select class="form-control" id="cMinLevel">
              ${[1,2,3,4,5,6,7,8,9,10].map(lv => `<option value="${lv}" ${t && (t.minLevel||1) === lv ? 'selected' : ''}>${lv === 1 ? '所有人可见' : 'LV' + lv + ' 及以上可见'}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>🗳️ 投票 <span class="muted" style="font-weight:400;font-size:12px">可选：为帖子附加一个投票（2-10 个选项，每行一个）</span></label>
            <input type="text" class="form-control" id="cPollQ" placeholder="投票问题（留空则不创建投票）" value="${t && t.poll ? esc(t.poll.question) : ''}" style="margin-bottom:8px" />
            <textarea class="form-control" id="cPollOpts" rows="3" placeholder="每行一个选项，至少 2 个，最多 10 个">${t && t.poll ? esc((t.poll.options || []).map(o => o.text).join('\n')) : ''}</textarea>
            <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="cPollMulti" ${t && t.poll && t.poll.multi ? 'checked' : ''}> 允许多选</label>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
            <button type="button" class="btn btn-outline btn-sm" id="cPreviewBtn">👁 预览</button>
            <span class="muted" style="font-size:12px">预览 Markdown 渲染效果，确认无误再发布</span>
          </div>
          <button type="submit" class="btn btn-primary btn-block">${t ? '保存修改' : '发布'}</button>
          <div class="error" id="formError"></div>
        </form>
      </div>
    `);
    bindMdToolbar('cContent');
    /* 预览切换 */
    const prevBtn = document.getElementById('cPreviewBtn');
    const prevWrap = document.getElementById('cPreviewWrap');
    const prevBox = document.getElementById('cPreview');
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (prevWrap.classList.contains('hidden')) {
        const content = document.getElementById('cContent').value;
        prevBox.innerHTML = content.trim() ? parseHtml(content) : '<span class="muted">内容为空，先写点正文吧</span>';
        prevWrap.classList.remove('hidden');
        prevBtn.textContent = '✏️ 继续编辑';
      } else {
        prevWrap.classList.add('hidden');
        prevBtn.textContent = '👁 预览';
      }
    });
    // price only for trade board
    const bSel = document.getElementById('cBoard');
    const pg = document.getElementById('priceGroup');
    const togglePrice = () => {
      const b = state.boards.find(x => x.id === bSel.value);
      pg.style.display = (b && b.slug === 'trade') ? 'block' : 'none';
      const ag = document.getElementById('anonGroup');
      if (ag) ag.style.display = (b && b.slug === 'tg-treehole') ? 'block' : 'none';
    };
    bSel.addEventListener('change', togglePrice);
    togglePrice();
    /* 话题模板：新帖且内容为空时按板块模板预填 */
    const cContent = document.getElementById('cContent');
    const applyTemplate = () => {
      if (editId || cContent.value.trim()) return;
      const b = state.boards.find(x => x.id === bSel.value);
      if (b && b.topicTemplate) { cContent.value = b.topicTemplate; toast('已按板块模板预填内容'); }
    };
    bSel.addEventListener('change', applyTemplate);
    applyTemplate();

    document.getElementById('composeForm').addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('cTitle').value.trim();
      const boardId = bSel.value;
      const content = document.getElementById('cContent').value.trim();
      const tags = document.getElementById('cTags').value.trim().split(/\s+/).filter(Boolean).slice(0, 5);
      const price = document.getElementById('cPrice').value;
      const bounty = Math.floor(Number(document.getElementById('cBounty').value) || 0);
      const minLevel = Math.max(1, Math.min(10, parseInt(document.getElementById('cMinLevel').value) || 1));
      /* 投票参数 */
      const pollQ = document.getElementById('cPollQ').value.trim();
      const pollOpts = document.getElementById('cPollOpts').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const pollMulti = document.getElementById('cPollMulti').checked;
      let poll = null;
      if (pollQ && pollOpts.length >= 2) poll = { question: pollQ, options: pollOpts, multi: pollMulti };
      if (bounty > (state.user.coins || 0)) { document.getElementById('formError').textContent = '悬赏鸡腿超出你的余额'; return; }
      try {
        if (t) {
          const r = await api('/api/topics/' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, boardId, content, tags, price, minLevel }) });
          route('/post/' + r.slug);
        } else {
          const anonymous = !!(document.getElementById('cAnonymous') && document.getElementById('cAnonymous').checked);
          const nt = await api('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, boardId, content, tags, price, bounty, poll, minLevel, anonymous }) });
          if (nt.status === 'pending') { toast('已提交，等待管理员审核，通过后会同步到电报频道'); route('/boards?board=tg-treehole'); }
          else route('/post/' + nt.slug);
        }
      } catch (err) { document.getElementById('formError').textContent = err.message; }
    });
    setNav('compose');
  }

  function renderLogin() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    renderPage(`
      <div class="card auth-card">
        <h2>👋 欢迎回来</h2>
        <form id="loginForm">
          <div class="form-group">
            <label>用户名或邮箱</label>
            <input type="text" class="form-control" id="lAccount" required />
          </div>
          <div class="form-group">
            <label>密码</label>
            <input type="password" class="form-control" id="lPassword" required />
            <div class="help-text">忘记密码？请联系社区管理员重置</div>
          </div>
          <button type="submit" class="btn btn-primary btn-block">登 录</button>
          <div class="error" id="formError"></div>
          <div class="form-foot">还没有账号？<a href="/register?next=${encodeURIComponent(next)}">立即注册</a></div>
        </form>
      </div>`);
    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: document.getElementById('lAccount').value.trim(), password: document.getElementById('lPassword').value }) });
        await initAuth();
        route(next);
      } catch (err) { document.getElementById('formError').textContent = err.message; }
    });
  }

  function renderRegister() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    renderPage(`
      <div class="card auth-card">
        <h2>🚀 加入社区</h2>
        <div class="help-text" style="margin-bottom:14px;padding:10px 12px;background:var(--soft);border-radius:10px">🔑 本社区采用邀请注册制，需要<strong>邀请码</strong>才能注册。还没有邀请码？找社区老用户要一个吧～</div>
        <form id="registerForm">
          <div class="form-group"><label>用户名</label><input type="text" class="form-control" id="rUsername" required maxlength="20" /></div>
          <div class="form-group"><label>昵称</label><input type="text" class="form-control" id="rName" maxlength="20" /></div>
          <div class="form-group"><label>邮箱</label><input type="email" class="form-control" id="rEmail" required /></div>
          <div class="form-group"><label>邀请码</label><input type="text" class="form-control" id="rCode" required placeholder="JM-XXXXXXXX" style="text-transform:uppercase" /></div>
          <div class="form-group"><label>密码</label><input type="password" class="form-control" id="rPassword" required minlength="6" /></div>
          <button type="submit" class="btn btn-primary btn-block">注 册</button>
          <div class="error" id="formError"></div>
          <div class="form-foot">已有账号？<a href="/login?next=${encodeURIComponent(next)}">去登录</a></div>
        </form>
      </div>`);
    fetch('/api/auth/reg-status').then(r => r.json()).then(st => {
      if (st && st.open) {
        const c = document.getElementById('rCode');
        if (c) { c.required = false; c.placeholder = '🎉 开放注册中，邀请码可不填'; }
      }
    }).catch(() => {});
    document.getElementById('registerForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('rUsername').value.trim(), name: document.getElementById('rName').value.trim(), email: document.getElementById('rEmail').value.trim(), code: document.getElementById('rCode').value.trim(), password: document.getElementById('rPassword').value }) });
        await initAuth();
        route(next);
      } catch (err) { document.getElementById('formError').textContent = err.message; }
    });
  }

  async function renderSpace(username) {
    const user = await api('/api/users/' + encodeURIComponent(username));
    const isMe = state.user && state.user.username === user.username;
    const readmeHtml = user.readme ? parseHtml(user.readme) : '<span class="muted">TA 还没有填写 Readme</span>';
    const contacts = [];
    if (user.contacts?.email) contacts.push(`<span class="muted">📧 ${esc(user.contacts.email)}</span>`);
    if (user.contacts?.website) contacts.push(`<a href="${esc(user.contacts.website)}" target="_blank" rel="noopener">🌐 网站</a>`);
    if (user.contacts?.github) contacts.push(`<a href="https://github.com/${esc(user.contacts.github)}" target="_blank" rel="noopener">🐙 GitHub</a>`);
    if (user.contacts?.twitter) contacts.push(`<a href="https://twitter.com/${esc(user.contacts.twitter)}" target="_blank" rel="noopener">🐦 Twitter</a>`);
    if (user.contacts?.wechat) contacts.push(`<span class="muted">💬 微信: ${esc(user.contacts.wechat)}</span>`);
    /* 成就展示（本人实时，他人用 user.achievements） */
    let achList = null;
    if (isMe) {
      try { achList = await api('/api/achievements'); } catch (e) { achList = null; }
    }
    const mineAch = isMe && achList ? achList.filter(a => a.unlocked) : ((user.achievements || []).map(id => ({ id })));
    /* 我的邀请（仅本人） */
    let myInvites = null;
    if (isMe && (user.level || 1) >= 2) { try { myInvites = await api('/api/invites/mine'); } catch (e) { myInvites = null; } }
    /* 等级进度（linux.do 式面板） */
    let lvProg = null;
    try { lvProg = await api('/api/users/' + encodeURIComponent(username) + '/level-progress'); } catch (e) { lvProg = null; }
    const achUnlocked = achList ? achList.filter(a => a.unlocked).length : (user.achievements || []).length;
    renderPage(`
      <div class="space-head">
        <img src="${esc(avatar(user))}" alt="">
        <div>
          <h1>${esc(user.name)} <span class="muted" style="font-size:14px">@${esc(user.username)}</span>${levelTag(user)}${titleTag(user)}</h1>
          <p class="muted">${user.role === 'owner' ? '社区站长' : user.role === 'admin' ? '社区管理员' : '社区成员'}${roleTag(user)} · Lv.${user.level || 1} ${esc(user.levelTitle || '')} · ${(user.exp || 0).toLocaleString()} 经验 · ${new Date(user.joinedAt).toLocaleDateString('zh-CN')} 加入</p>
          ${expBar(user)}
          ${badgeRow(user)}
          ${isMe && (user.titles || []).length > 1 ? `<div style="margin-top:8px;font-size:13px"><span class="muted">🏷️ 佩戴头衔：</span><select id="wearTitleSel" class="form-control" style="display:inline-block;width:auto;padding:4px 8px;font-size:13px">
            <option value="">（不佩戴）</option>
            ${(user.titles || []).map(t => `<option value="${esc(t)}" ${user.title === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select></div>` : ''}
          <div class="space-stats">
            <div><strong>${user.topicCount}</strong><span>主题</span></div>
            <div><strong>${user.replyCount}</strong><span>回复</span></div>
            <div><strong>🍗 ${user.coins || 0}</strong><span>鸡腿</span></div>
            <div><strong>${user.followerCount || 0}</strong><span>粉丝</span></div>
            <div><strong>${user.followingCount || 0}</strong><span>关注</span></div>
            <div><strong>🏅 ${achUnlocked || 0}</strong><span>成就</span></div>
            <div><strong>${user.checkinCount || 0}</strong><span>签到天数</span></div>
          </div>
          ${lvProg ? `<div class="lvprog">
            <div class="lvprog-head"><span>📊 等级进度</span><span class="muted">Lv.${lvProg.level} ${esc(lvProg.levelTitle)}${lvProg.nextExp ? ` → Lv.${lvProg.level + 1} ${esc(lvProg.nextTitle)}` : '（满级）'}</span></div>
            <div class="lvprog-bar"><div style="width:${lvProg.progress}%"></div></div>
            <div class="lvprog-levels">${lvProg.levels.map(L => `<span class="${L.lv <= lvProg.level ? 'done' : ''} ${L.lv === lvProg.level ? 'cur' : ''}" title="${esc(L.title)}（${L.exp}经验）">Lv.${L.lv}</span>`).join('')}</div>
            <div class="lvprog-stats">${lvProg.stats.map(x => `<div><strong>${x.value}</strong><span>${x.icon} ${x.label}</span></div>`).join('')}</div>
          </div>` : ''}
          ${contacts.length ? `<div style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap;font-size:13px">${contacts.join('')}</div>` : ''}
          ${user.bio ? `<div class="space-bio">${esc(user.bio)}</div>` : ''}
          <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
            ${isMe ? `<a href="/settings" class="btn btn-sm btn-outline">编辑资料</a><a href="/achievements" class="btn btn-sm btn-outline">🏅 成就墙</a>` : state.user ? `<a href="/messages/${esc(user.username)}" class="btn btn-sm btn-primary">💬 发私信</a><button class="btn btn-sm ${user.isFollowing ? 'btn-outline' : 'btn-primary'}" id="followBtn" data-uid="${esc(user.id)}">${user.isFollowing ? '✓ 已关注' : '+ 关注'}</button><button class="btn btn-sm btn-outline" id="transferBtn" data-to="${esc(user.username)}" data-name="${esc(user.name)}">🍗 转鸡腿</button>` : `<a href="/login?next=${encodeURIComponent('/space/' + user.username)}" class="btn btn-sm btn-outline">登录后可关注/私信</a>`}
          </div>
        </div>
      </div>
      ${myInvites ? `<div class="space-ach" id="invites"><h3>🎁 我的邀请 <span class="muted" style="font-size:12px">已邀请 ${myInvites.totalInvited} 人 · 每成功邀请 1 人得 20 🍗</span></h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          ${myInvites.codes.map(c => `<div class="invite-code-card"><code>${esc(c.code)}</code><span class="muted">${c.usedCount}/${c.maxUses} 已用</span><button class="btn btn-xs btn-outline" data-copy="${esc(c.code)}">复制</button></div>`).join('')}
        </div>
        <button class="btn btn-sm btn-primary" id="genInviteBtn">＋ 生成邀请码（默认 5 次）</button>
        ${myInvites.codes.some(c => c.invited.length) ? `<div style="margin-top:8px;font-size:13px" class="muted">已邀请：${myInvites.codes.flatMap(c => c.invited).map(u => esc(u.name || u.username)).join('、')}</div>` : ''}
      </div>` : ''}
      ${mineAch.length ? `<div class="space-ach"><h3>🏅 成就</h3><div class="ach-strip">${mineAch.map(a => {
        const meta = achList ? achList.find(x => x.id === a.id) : null;
        return meta ? `<span class="ach-mini" title="${esc(meta.name)}：${esc(meta.desc)}">${esc(meta.icon)}</span>` : '';
      }).join('')}</div></div>` : ''}
      <div class="space-readme">
        <h3>📖 Readme</h3>
        <div>${readmeHtml}</div>
      </div>
      ${sectionTitle(isMe ? '我发布的主题' : 'TA 发布的主题', user.topicCount + ' 个')}
      ${postListHtml(user.topics || [])}
    `);
    /* 邀请码：生成 + 复制 */
    const genBtn = document.getElementById('genInviteBtn');
    if (genBtn) genBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        toast('邀请码已生成：' + r.code);
        renderSpace(username);
      } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('邀请码已复制')).catch(() => toast('复制失败', 'err'));
    }));
    /* 切换佩戴头衔 */
    const wearSel = document.getElementById('wearTitleSel');
    if (wearSel) wearSel.addEventListener('change', async () => {
      try {
        const url = wearSel.value ? '/api/shop/wear-title' : '/api/shop/unwear-title';
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: wearSel.value }) });
        toast(wearSel.value ? '已佩戴「' + wearSel.value + '」' : '已卸下头衔');
        renderSpace(username);
      } catch (e) { toast(e.message, 'err'); }
    });
    /* 转鸡腿 */
    const trBtn = document.getElementById('transferBtn');
    if (trBtn) trBtn.addEventListener('click', async () => {
      const amount = prompt(`转给「${trBtn.dataset.name}」多少鸡腿？（1-100000）`);
      if (amount === null) return;
      const n = Math.floor(Number(amount));
      if (!n || n < 1 || n > 100000) { toast('请输入 1-100000 之间的鸡腿数', 'err'); return; }
      const note = prompt('附言（可选，100 字内）：') || '';
      if (!confirm(`确认转账 ${n} 个鸡腿给「${trBtn.dataset.name}」？`)) return;
      try {
        const r = await api('/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: trBtn.dataset.to, amount: n, note }) });
        state.user = { ...state.user, coins: r.coins };
        els.userCoins.textContent = '🍗 ' + (r.coins || 0);
        toast(`转账成功！送出 🍗 ${n}`);
      } catch (e) { toast(e.message, 'err'); }
    });
    const flBtn = document.getElementById('followBtn');
    if (flBtn) flBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/users/' + encodeURIComponent(flBtn.dataset.uid) + '/follow', { method: 'POST' });
        flBtn.textContent = r.following ? '✓ 已关注' : '+ 关注';
        flBtn.classList.toggle('btn-primary', !r.following);
        flBtn.classList.toggle('btn-outline', r.following);
        toast(r.following ? '已关注' : '已取消关注');
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function renderFavorites() {
    if (!state.user) { route('/login?next=/favorites'); return; }
    const list = await api('/api/favorites');
    renderPage(`${sectionTitle('⭐ 我的收藏', list.length + ' 个')}${postListHtml(list)}`);
  }

  async function renderSearch(q) {
    if (!q) {
      const tags = await loadTags();
      renderPage(`
        ${sectionTitle('🔍 搜索')}
        <div class="card" style="padding:18px">
          <p class="muted" style="margin-top:0">在顶部搜索框输入关键词（标题 / 作者 / 标签），或直接点击热门标签直达：</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${tags.map(t => `<a class="tag-chip tag-link" href="/tag/${encodeURIComponent(t.name)}">${esc(t.name)}</a>`).join('') || '<span class="muted">暂无标签</span>'}
          </div>
        </div>`);
      setNav('');
      return;
    }
    const topics = await api('/api/search?q=' + encodeURIComponent(q));
    renderPage(`${sectionTitle('搜索结果：' + q, topics.length + ' 条')}${postListHtml(topics)}`);
  }

  async function renderMessages() {
    if (!state.user) { route('/login?next=/messages'); return; }
    const list = await api('/api/messages');
    renderPage(`
      ${sectionTitle('💬 私信')}
      <div class="card" style="padding:0;overflow:hidden">
        <div class="msg-list">
          ${list.map(c => `
            <a class="msg-item ${c.unread ? 'unread' : ''}" href="/messages/${esc(c.peer.username)}">
              <img class="avatar" src="${esc(avatar(c.peer))}" alt="">
              <div class="msg-main">
                <div class="msg-head"><span class="msg-name">${esc(c.peer.name)}${roleTag(c.peer)}</span>${c.unread ? `<span class="msg-unread">${c.unread}</span>` : ''}</div>
                <div class="msg-preview">${c.unread ? '<b>' : ''}${esc(c.lastMessage || '')}${c.unread ? '</b>' : ''}</div>
              </div>
              <span class="msg-time">${fmtTime(c.lastAt)}</span>
            </a>`).join('') || '<div class="empty-state" style="padding:40px"><div class="big">📭</div><p>还没有私信，去别人的主页点「发私信」吧</p></div>'}
        </div>
      </div>`);
    refreshUnread();
  }

  async function renderConversation(username) {
    if (!state.user) { route('/login?next=/messages/' + encodeURIComponent(username)); return; }
    const data = await api('/api/messages/' + encodeURIComponent(username));
    const peer = data.peer;
    renderPage(`
      ${sectionTitle('💬 与 ' + peer.name + ' 的私信', `<a class="btn btn-ghost btn-sm" href="/messages">← 返回</a>`)}
      <div class="card chat-card">
        <div class="chat-stream" id="chatStream">
          ${data.messages.map(m => `
            <div class="chat-msg ${m.fromMe ? 'me' : ''}">
              <img class="avatar avatar-sm" src="${esc(avatar(m.fromMe ? state.user : peer))}" alt="">
              <div class="chat-bubble">${parseHtml(m.content)}</div>
              <span class="chat-time">${fmtTime(m.createdAt)}</span>
            </div>`).join('') || '<div class="empty-state" style="padding:30px"><p>打个招呼吧～</p></div>'}
        </div>
        <div class="chat-input">
          <textarea id="chatBody" class="form-control" rows="2" placeholder="输入消息，支持 **加粗** 与 \`代码\`..."></textarea>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="muted" style="font-size:12px">Ctrl+Enter 快速发送</span>
            <button class="btn btn-primary" id="chatSend">发送</button>
          </div>
        </div>
      </div>`);
    const stream = document.getElementById('chatStream');
    stream.scrollTop = stream.scrollHeight;
    const send = async () => {
      const ta = document.getElementById('chatBody');
      const content = ta.value.trim();
      if (!content) return;
      try {
        await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: peer.username, content }) });
        ta.value = '';
        route('/messages/' + peer.username);
      } catch (e) { alert(e.message); }
    };
    document.getElementById('chatSend').addEventListener('click', send);
    document.getElementById('chatBody').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  }

  async function renderTag(name, page = 1) {
    const data = await api('/api/tag/' + encodeURIComponent(name) + '?page=' + page + '&pageSize=30');
    const topics = data.list || [];
    const pages = data.pages || 1;
    const urlFn = (p) => '/tag/' + encodeURIComponent(name) + (p > 1 ? '?page=' + p : '');
    renderPage(`
      ${sectionTitle('🏷️ 标签：' + name, (data.total || 0) + ' 个帖子')}
      ${pages > 1 ? `<div style="display:flex;justify-content:flex-end;margin:2px 2px 10px">${pager(data.page || 1, pages, urlFn, true)}</div>` : ''}
      ${postListHtml(topics)}
      ${pages > 1 ? `<div class="card" style="padding:12px;margin-top:14px;display:flex;justify-content:center">${pager(data.page || 1, pages, urlFn)}</div>` : ''}
    `);
  }

  /* ---------- 公司避雷库 ---------- */
  /* 通用分页条：cur 当前页、pages 总页数、urlFn 页码→链接 */
  function pager(cur, pages, urlFn, compact) {
    if (pages <= 1) return '';
    const show = new Set([1, pages]);
    for (let i = cur - 2; i <= cur + 2; i++) if (i >= 1 && i <= pages) show.add(i);
    const seq = [...show].sort((a, b) => a - b);
    let html = '', prev = 0;
    seq.forEach(p => {
      if (p - prev > 1) html += '<span class="pager-ellipsis">…</span>';
      html += `<a class="pager-num ${p === cur ? 'on' : ''}" href="${urlFn(p)}">${p}</a>`;
      prev = p;
    });
    return `<div class="pager${compact ? ' pager-compact' : ''}">${cur > 1 ? `<a class="pager-btn" href="${urlFn(cur - 1)}">‹ 上一页</a>` : ''}${html}${cur < pages ? `<a class="pager-btn" href="${urlFn(cur + 1)}">下一页 ›</a>` : ''}</div>`;
  }

  /* ================= 公司避雷库 v9：全国百万级 ================= */
  async function renderCompanies(params) {
    const q = params.get('q') || '';
    const province = params.get('province') || '';
    const industry = params.get('industry') || '';
    const tag = params.get('tag') || '';
    const sort = params.get('sort') || 'name';
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const buildUrl = (fields) => {
      const p2 = new URLSearchParams();
      const cur = { q, province, industry, tag, sort, page };
      Object.assign(cur, fields);
      if (cur.q) p2.set('q', cur.q);
      if (cur.province) p2.set('province', cur.province);
      if (cur.industry) p2.set('industry', cur.industry);
      if (cur.tag) p2.set('tag', cur.tag);
      if (cur.sort !== 'name') p2.set('sort', cur.sort);
      if (cur.page > 1) p2.set('page', cur.page);
      return '/companies' + (p2.toString() ? '?' + p2.toString() : '');
    };
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (province) qs.set('province', province);
    if (industry) qs.set('industry', industry);
    if (tag) qs.set('tag', tag);
    if (sort !== 'name') qs.set('sort', sort);
    const [data, stats, provMeta, indMeta, tagMeta] = await Promise.all([
      api(`/api/companies?${qs.toString()}&page=${page}&pageSize=30`),
      api('/api/companies/stats').catch(() => null),
      api('/api/companies/meta/provinces').catch(() => []),
      api('/api/companies/meta/industries').catch(() => []),
      api('/api/companies/meta/tags').catch(() => []),
    ]);
    const { list = [], total = 0, pages = 1, via = 'static' } = data;
    const cur = Math.min(page, pages);
    const isNational = via === 'sqlite';
    const indShown = indMeta.slice(0, 20);
    if (industry && !indShown.some(i => i.name === industry)) indShown.push({ name: industry, count: 0 });
    const provShown = provMeta.slice(0, 12);
    if (province && !provShown.some(p => p.name === province)) provShown.push({ name: province, count: 0 });
    const tagShown = tagMeta.slice(0, 16);
    /* 热榜 */
    const hot = isNational ? await api('/api/companies/hot?type=danger').catch(() => []) : [];
    const hotRed = isNational ? await api('/api/companies/hot?type=red').catch(() => []) : [];
    const statCards = stats ? `
      <div class="comp-stats">
        <div class="stat"><strong>${fmtNum(stats.total)}</strong><span>全国企业</span></div>
        <div class="stat"><strong>${stats.provinces || 0}</strong><span>省份</span></div>
        <div class="stat"><strong>${stats.industries || 0}</strong><span>行业</span></div>
        <div class="stat"><strong>${fmtNum(stats.chongqing || 0)}</strong><span>重庆企业</span></div>
        <div class="stat"><strong>${(stats.years && stats.years.min) || '—'}-${(stats.years && stats.years.max) || '—'}</strong><span>注册年份</span></div>
      </div>` : '';
    const hotHtml = (hot.length ? `
      <div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
        <div class="section-title" style="padding:12px 16px;margin:0;border-bottom:1px solid var(--border)">🔥 强烈避雷热榜 <span class="muted" style="font-weight:400;font-size:12px">评分最高的风险公司，求职合作前先看这里</span></div>
        <div class="hot-list">
          ${hot.slice(0, 10).map((c, i) => `
            <a class="hot-item" href="/companies/${esc(c.id)}">
              <span class="hot-no ${i < 3 ? 'top' : ''}">${i + 1}</span>
              <span class="hot-name">${esc(c.name)}</span>
              ${compTags(c.tags)}
              <span class="hot-side"><b style="color:#dc2626">${c.avg.toFixed(1)}</b> <span class="muted">${c.reviewCount}评</span> <span class="muted">${esc(c.province)}</span></span>
            </a>`).join('')}
        </div>
        <div class="section-title" style="padding:12px 16px;margin:0;border-bottom:1px solid var(--border);border-top:1px solid var(--border)">❤️ 红榜·口碑尚可 <span class="muted" style="font-weight:400;font-size:12px">评分低于 2 星，被评价为尚可的公司</span></div>
        <div class="hot-list">
          ${hotRed.slice(0, 6).map(c => `
            <a class="hot-item" href="/companies/${esc(c.id)}">
              <span class="hot-name">${esc(c.name)}</span>
              <span class="hot-side"><b style="color:#3d6c45">${c.avg.toFixed(1)}</b> <span class="muted">${c.reviewCount}评</span> <span class="muted">${esc(c.province)}</span></span>
            </a>`).join('') || '<div class="empty-state" style="padding:16px"><p>暂无红榜数据，快去给好公司打分吧</p></div>'}
        </div>
      </div>` : '');
    renderPage(`
      ${sectionTitle('🏢 全国公司避雷库', `${fmtNum(total)} 家 · 真实工商数据 · 重庆优先展示`)}
      ${statCards}
      <div class="card" style="margin-bottom:14px;padding:14px">
        <form id="compFilter" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="text" class="form-control" name="q" placeholder="${isNational ? '搜索全国公司，如：长安、阿里巴巴、餐饮...' : '搜索公司 / 行业 / 区域，如：长安、渝北、餐饮...'}" value="${esc(q)}" style="flex:1;min-width:200px">
          <button class="btn btn-primary btn-sm">搜索</button>
          ${q || province || industry || tag ? `<a class="btn btn-sm btn-ghost" href="/companies">清除</a>` : ''}
        </form>
        ${isNational ? `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
          <a class="chip ${!province ? 'on' : ''}" href="${buildUrl({ province: '', page: 1 })}">全国</a>
          ${provShown.map(p => `<a class="chip ${province === p.name ? 'on' : ''}" href="${buildUrl({ province: p.name, page: 1 })}">${esc(p.name)} <span class="muted" style="font-size:11px">${fmtNum(p.count)}</span></a>`).join('')}
          ${provMeta.length > provShown.length ? `<span class="muted" style="font-size:11px;align-self:center">+${provMeta.length - provShown.length} 省</span>` : ''}
        </div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <a class="chip ${!industry ? 'on' : ''}" href="${buildUrl({ industry: '', page: 1 })}">全部行业</a>
          ${indShown.map(i => `<a class="chip ${industry === i.name ? 'on' : ''}" href="${buildUrl({ industry: i.name, page: 1 })}">${esc(i.name)} <span class="muted" style="font-size:11px">${i.count ? fmtNum(i.count) : ''}</span></a>`).join('')}
        </div>
        ${isNational && tagShown.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center">
          <span class="muted" style="font-size:12px">⚠️ 风险标签：</span>
          <a class="chip chip-warn ${!tag ? 'on' : ''}" href="${buildUrl({ tag: '', page: 1 })}">全部</a>
          ${tagShown.map(t => `<a class="chip chip-warn ${tag === t.tag ? 'on' : ''}" href="${buildUrl({ tag: t.tag, page: 1 })}">${esc(t.tag)} <span class="muted" style="font-size:11px">${fmtNum(t.count)}</span></a>`).join('')}
        </div>` : ''}
      </div>
      ${hotHtml}
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;gap:4px;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
          ${[['name', '按名称'], ['new', '新注册'], ['rating', '避雷最高'], ['danger', '强烈避雷'], ['reviews', '评价最多']].map(([k, lbl]) => `<a class="chip ${sort === k ? 'on' : ''}" href="${buildUrl({ sort: k, page: 1 })}">${lbl}</a>`).join('')}
          ${state.user ? `<a class="btn btn-sm btn-ghost" href="/companies/watch" style="margin-left:auto">🛡️ 我的避雷清单</a>` : ''}
          <button class="btn btn-sm btn-primary" id="btnAddComp">➕ 添加公司</button>
        </div>
        ${list.map(c => `
          <a class="comp-row" href="/companies/${esc(c.id)}">
            <div class="comp-row-main">
              <div class="comp-row-name">${esc(c.name)} ${companyBadge(c)}</div>
              <div class="comp-row-meta muted">${esc(c.industry)}${isNational && c.province ? ` · ${esc(c.province)}${c.city && c.city !== c.province ? '·' + esc(c.city) : ''}` : c.region ? ` · 重庆·${esc(c.region)}` : ''}${c.regYear ? ` · ${c.regYear}` : ''}${c.tags && c.tags.length ? ' · ' + compTags(c.tags) : ''}</div>
            </div>
            <div class="comp-row-side">
              <div>${stars(c.avg)} <span class="comp-avg">${c.avg ? c.avg.toFixed(1) : '—'}</span></div>
              <div class="muted" style="font-size:12px">${c.reviewCount} 条评价${c.watched ? ' · 🛡️' : ''}</div>
            </div>
          </a>`).join('') || `<div class="empty-state"><div class="big">🔍</div><p>没有找到相关公司</p><p class="muted" style="font-size:13px">换个关键词试试，或清除筛选条件</p></div>`}
        ${pager(cur, pages, p => buildUrl({ page: p }))}
      </div>
    `);
    document.getElementById('compFilter').addEventListener('submit', e => {
      e.preventDefault();
      route(buildUrl({ q: new FormData(e.target).get('q') || '', page: 1 }));
    });
    /* 输入防抖实时搜索 */
    const qInput = document.querySelector('#compFilter input[name=q]');
    if (qInput) {
      let t = null;
      qInput.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const v = qInput.value.trim();
          if (v !== q) route(buildUrl({ q: v, page: 1 }));
        }, 500);
      });
    }
    setNav('companies');
  }

  /* 我的避雷清单 */
  async function renderCompanyWatch() {
    if (!state.user) { route('/login?next=/companies/watch'); return; }
    const list = await api('/api/companies/watch/list');
    renderPage(`
      ${sectionTitle('🛡️ 我的避雷清单', list.length + ' 家 · 关注中的公司')}
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;gap:4px;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <span class="muted" style="font-size:12px;align-self:center">在详情页点「🛡️ 加入清单」即可跟踪关注，随时查看其避雷评价</span>
          <a class="btn btn-sm btn-ghost" href="/companies" style="margin-left:auto">← 返回公司库</a>
        </div>
        ${list.map(c => `
          <a class="comp-row" href="/companies/${esc(c.id)}">
            <div class="comp-row-main">
              <div class="comp-row-name">${esc(c.name)} ${companyBadge(c)}</div>
              <div class="comp-row-meta muted">${esc(c.industry)} · ${esc(c.province)}${c.city && c.city !== c.province ? '·' + esc(c.city) : ''}${c.tags && c.tags.length ? ' · ' + compTags(c.tags) : ''}</div>
            </div>
            <div class="comp-row-side">
              <div>${stars(c.avg)} <span class="comp-avg">${c.avg ? c.avg.toFixed(1) : '—'}</span></div>
              <div class="muted" style="font-size:12px">${c.reviewCount} 条评价</div>
            </div>
          </a>`).join('') || '<div class="empty-state"><div class="big">🛡️</div><p>清单还是空的</p><p class="muted" style="font-size:13px">去公司库逛逛，把想避雷的公司加入清单</p></div>'}
      </div>
    `);
    setNav('companies');
  }

  async function renderCompanyDetail(id) {
    const c = await api('/api/companies/' + encodeURIComponent(id));
    const my = c.myReview || null;
    const lvColor = c.level === 'danger' ? '#dc2626' : c.level === 'warn' ? '#ea580c' : c.level === 'careful' ? '#d97706' : c.level === 'ok' ? '#3d6c45' : '#8aa096';
    const loc = c.source === 'national'
      ? `${esc(c.province)}${c.city && c.city !== c.province ? ' · ' + esc(c.city) : ''}`
      : `重庆·${esc(c.region || '')}`;
    const infoRows = [];
    if (c.source === 'national') {
      if (c.address) infoRows.push(['📍 注册地址', esc(c.address)]);
      if (c.regYear) infoRows.push(['🗓️ 注册年份', `${c.regYear}`]);
      if (c.capital && c.capital !== 'N/A') infoRows.push(['💰 注册资金', esc(c.capital)]);
      if (c.legal && c.legal !== 'N/A') infoRows.push(['👤 法人代表', esc(c.legal)]);
    } else {
      infoRows.push(['🗓️ 收录时间', new Date(c.createdAt).toLocaleDateString('zh-CN')]);
    }
    renderPage(`
      ${sectionTitle('', `<a class="btn btn-ghost btn-sm" href="/companies">← 返回公司库</a>`)}
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
          <div style="text-align:center;min-width:110px">
            <div style="font-size:36px;font-weight:800;color:${lvColor}">${c.avg ? c.avg.toFixed(1) : '—'}</div>
            <div>${stars(c.avg, 16)}</div>
            <div class="muted" style="font-size:12px">${c.reviewCount} 条评价</div>
            <div style="margin-top:6px">${companyBadge(c)}</div>
          </div>
          <div style="flex:1;min-width:220px">
            <h1 style="margin:0 0 8px;font-size:22px">${esc(c.name)}</h1>
            <div style="display:flex;gap:16px;flex-wrap:wrap" class="muted">
              <span>🏭 ${esc(c.industry || '其他')}</span>
              <span>📍 ${loc}</span>
            </div>
            ${c.tags && c.tags.length ? `<div style="margin-top:8px">${compTags(c.tags)}</div>` : ''}
            ${c.source === 'national' && infoRows.length ? `<div class="comp-info" style="margin-top:10px">${infoRows.map(([k, v]) => `<div><span class="muted">${k}</span> ${v}</div>`).join('')}</div>` : ''}
            ${c.note ? `<p style="margin-top:8px">${esc(c.note)}</p>` : ''}
            <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
              ${state.user ? `<button class="btn btn-sm ${c.watched ? 'btn-primary' : 'btn-outline'}" id="watchBtn">${c.watched ? '🛡️ 已在清单' : '🛡️ 加入避雷清单'}</button>` : ''}
              <a class="btn btn-sm btn-ghost" href="/companies?sort=reviews">评价最多</a>
            </div>
            <p class="muted" style="font-size:12px;margin-top:10px">★ 星级即避雷指数：1 星尚可 → 5 星强烈避雷。评价来自网友真实经历，仅供参考，不构成任何法律意见。</p>
          </div>
        </div>
      </div>
      ${state.user ? `
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">${my ? '✏️ 更新我的评价' : '⭐ 我来打分避雷'}</div>
        <div style="display:flex;gap:6px" id="rateStars">
          ${[1, 2, 3, 4, 5].map(i => `<span class="rate-star" data-v="${i}" style="font-size:28px;cursor:pointer;color:${my && my.rating >= i ? '#f59e0b' : '#d8e2da'}">★</span>`).join('')}
        </div>
        <textarea id="rateContent" class="form-control" rows="3" maxlength="500" placeholder="写写你的真实经历：薪资、加班、裁员、欠薪、坑在哪...（至少一句话）" style="margin-top:10px">${esc(my ? my.content : '')}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" id="rateAnon" ${my && my.anonymous ? 'checked' : ''}> 🙈 匿名发布（隐藏我的昵称）</label>
          <button class="btn btn-primary btn-sm" id="rateSubmit">${my ? '更新评价' : '提交避雷'}</button>
        </div>
      </div>` : `
      <div class="card" style="margin-bottom:14px;text-align:center;padding:28px 16px">
        <div style="font-size:40px">🔒</div>
        <h3 style="margin:10px 0 6px">登录后才能打分避雷</h3>
        <p class="muted" style="font-size:13px;margin:0 0 14px">写评价、看全部评价都需要登录，保证评价真实可信</p>
        <a class="btn btn-primary" href="/login?next=${encodeURIComponent('/companies/' + c.id)}">登录 / 注册</a>
      </div>`}
      <div class="card" style="padding:0;overflow:hidden">
        <div class="section-title" style="padding:12px 16px;margin:0;border-bottom:1px solid var(--border)">💬 全部评价（${c.reviewCount}）</div>
        ${(c.reviews || []).map(r => `
          <div class="comp-review" data-rid="${esc(r.id)}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              ${r.anonymous
                ? `<span class="rank-user"><img src="/assets/logo.png" alt="">🙈 ${esc(r.name)}</span>`
                : `<a class="rank-user" href="/space/${esc(r.username)}"><img src="${esc(avatar(r))}" alt="">${esc(r.name)}</a>`}
              <div style="display:flex;align-items:center;gap:10px">
                ${stars(r.rating)}
                <span class="muted" style="font-size:12px">${fmtTime(r.createdAt)}</span>
              </div>
            </div>
            <p style="margin:10px 0 0;white-space:pre-wrap">${esc(r.content)}</p>
            <div style="display:flex;gap:10px;margin-top:8px;align-items:center">
              <button class="rv-vote ${r.myVote === 1 ? 'on-up' : ''}" data-dir="1">👍 <span>${r.upCount || 0}</span></button>
              <button class="rv-vote ${r.myVote === -1 ? 'on-down' : ''}" data-dir="-1">👎 <span>${r.downCount || 0}</span></button>
            </div>
          </div>`).join('') || '<div class="empty-state"><div class="big">🤐</div><p>还没有人评价，来做第一个避雷人</p></div>'}
      </div>
    `);
    let picked = my ? my.rating : 0;
    const starEls = [...document.querySelectorAll('.rate-star')];
    const paint = v => starEls.forEach(s => { s.style.color = v >= +s.dataset.v ? '#f59e0b' : '#d8e2da'; });
    starEls.forEach(s => {
      s.addEventListener('mouseenter', () => paint(+s.dataset.v));
      s.addEventListener('mouseleave', () => paint(picked));
      s.addEventListener('click', () => { picked = +s.dataset.v; paint(picked); });
    });
    const submit = document.getElementById('rateSubmit');
    if (submit) submit.addEventListener('click', async () => {
      const rating = picked;
      const content = document.getElementById('rateContent').value.trim();
      const anonymous = document.getElementById('rateAnon') ? document.getElementById('rateAnon').checked : true;
      const nickname = document.getElementById('rateNick') ? document.getElementById('rateNick').value.trim() : '';
      if (!rating) { alert('请先点选星级'); return; }
      if (!content) { alert('请写一句避雷理由'); return; }
      try {
        await api('/api/companies/' + encodeURIComponent(c.id) + '/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating, content, anonymous, nickname }) });
        renderCompanyDetail(c.id);
      } catch (e) { alert(e.message); }
    });
    const watchBtn = document.getElementById('watchBtn');
    if (watchBtn) watchBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/companies/' + encodeURIComponent(c.id) + '/watch', { method: 'POST' });
        watchBtn.classList.toggle('btn-primary', !!r.watched);
        watchBtn.classList.toggle('btn-outline', !r.watched);
        watchBtn.textContent = r.watched ? '🛡️ 已在清单' : '🛡️ 加入避雷清单';
        toast(r.watched ? '已加入避雷清单' : '已移出避雷清单');
      } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('.rv-vote').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!state.user) { toast('请先登录', 'err'); return; }
        const rid = btn.closest('.comp-review').dataset.rid;
        try {
          const r = await api(`/api/companies/${encodeURIComponent(c.id)}/reviews/${rid}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: +btn.dataset.dir }) });
          const wrap = btn.closest('.comp-review');
          wrap.querySelectorAll('.rv-vote').forEach(b => {
            b.classList.remove('on-up', 'on-down');
            b.querySelector('span').textContent = (b.dataset.dir === '1' ? r.upCount : r.downCount);
          });
          btn.classList.add(r.myVote === 1 ? 'on-up' : r.myVote === -1 ? 'on-down' : '');
        } catch (e) { toast(e.message, 'err'); }
      });
    });
    /* 添加公司弹窗 */
    document.getElementById('btnAddComp')?.addEventListener('click', () => {
      if (!state.user) { route('/login?next=/companies'); return; }
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:480px">
          <div class="modal-head"><h3>➕ 添加避雷公司</h3><button class="modal-close">&times;</button></div>
          <div class="modal-body">
            <p class="muted" style="font-size:13px;margin-bottom:12px">提交后需管理员审核通过才会显示在避雷库中。请确保信息真实有效。</p>
            <form id="compSubmitForm">
              <div class="form-group"><label>公司名称 *</label><input type="text" class="form-control" id="csName" required maxlength="80" placeholder="如：重庆XX科技有限公司"></div>
              <div class="form-group"><label>所在省份</label><select class="form-control" id="csProvince">
                <option value="重庆">重庆</option><option value="北京">北京</option><option value="上海">上海</option><option value="广东">广东</option>
                <option value="江苏">江苏</option><option value="浙江">浙江</option><option value="四川">四川</option><option value="湖北">湖北</option>
                <option value="湖南">湖南</option><option value="山东">山东</option><option value="河南">河南</option><option value="福建">福建</option>
                <option value="安徽">安徽</option><option value="江西">江西</option><option value="河北">河北</option><option value="山西">山西</option>
                <option value="辽宁">辽宁</option><option value="吉林">吉林</option><option value="黑龙江">黑龙江</option><option value="陕西">陕西</option>
                <option value="云南">云南</option><option value="贵州">贵州</option><option value="广西">广西</option><option value="海南">海南</option>
                <option value="天津">天津</option><option value="内蒙古">内蒙古</option><option value="新疆">新疆</option><option value="西藏">西藏</option>
                <option value="宁夏">宁夏</option><option value="甘肃">甘肃</option><option value="青海">青海</option><option value="其他">其他</option>
              </select></div>
              <div class="form-group"><label>所在城市</label><input type="text" class="form-control" id="csCity" maxlength="30" placeholder="如：渝北区"></div>
              <div class="form-group"><label>行业</label><select class="form-control" id="csIndustry">
                <option value="其他">其他</option><option value="信息技术">信息技术</option><option value="贸易零售">贸易零售</option>
                <option value="制造业">制造业</option><option value="建筑地产">建筑地产</option><option value="餐饮食品">餐饮食品</option>
                <option value="教育培训">教育培训</option><option value="医疗健康">医疗健康</option><option value="金融投资">金融投资</option>
                <option value="文化传媒">文化传媒</option><option value="物流运输">物流运输</option><option value="农业">农业</option>
                <option value="能源环保">能源环保</option><option value="人力资源">人力资源</option><option value="商务服务">商务服务</option>
                <option value="旅游">旅游</option><option value="汽车服务">汽车服务</option>
              </select></div>
              <div class="form-group"><label>详细地址</label><input type="text" class="form-control" id="csAddress" maxlength="200" placeholder="可选"></div>
              <div class="form-group"><label>避雷说明</label><textarea class="form-control" id="csNote" rows="3" maxlength="500" placeholder="简述该公司的避雷原因，如拖欠工资、虚假招聘等"></textarea></div>
              <div class="error" id="csError"></div>
              <button type="submit" class="btn btn-primary btn-block">提交审核</button>
            </form>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('.modal-close').onclick = () => modal.remove();
      modal.onclick = e => { if (e.target === modal) modal.remove(); };
      modal.querySelector('#compSubmitForm').addEventListener('submit', async e => {
        e.preventDefault();
        try {
          const res = await api('/api/companies/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            name: document.getElementById('csName').value.trim(),
            province: document.getElementById('csProvince').value,
            city: document.getElementById('csCity').value.trim(),
            industry: document.getElementById('csIndustry').value,
            address: document.getElementById('csAddress').value.trim(),
            note: document.getElementById('csNote').value.trim(),
          }) });
          modal.remove();
          alert('✅ ' + res.message);
        } catch (err) { document.getElementById('csError').textContent = err.message; }
      });
    });
    setNav('companies');
  }

  /* ================= v8 玩法前端：积分商城 ================= */
  async function renderShop() {
    const [items, me] = await Promise.all([api('/api/shop/items'), api('/api/auth/me')]);
    state.user = me.user;
    const groups = [
      { key: 'badge', label: '🎖️ 徽章', desc: '永久佩戴在头像旁的荣誉徽章' },
      { key: 'title', label: '🏷️ 头衔', desc: '展示在名字旁的特殊头衔' },
    ];
    renderPage(`
      ${sectionTitle('🛒 积分商城', `我的鸡腿：🍗 ${me.user.coins || 0}`)}
      ${expBar(me.user)}
      <div class="card" style="margin-bottom:14px;padding:14px">
        <p class="muted" style="margin:0;font-size:13px">用「🍗 鸡腿」兑换徽章与头衔。鸡腿来自每日签到、发帖回帖、评价公司、悬赏与打赏，也可以通过 <a href="/rank?tab=coins">排行榜</a> 看看谁最富有～</p>
      </div>
      ${groups.map(g => `
        <div class="section-title" style="margin-top:18px">${g.label} <span class="muted" style="font-weight:400;font-size:12px">${g.desc}</span></div>
        <div class="shop-grid">
          ${items.filter(i => i.type === g.key).map(it => `
            <div class="shop-item card ${it.owned ? 'owned' : ''}" style="margin-bottom:12px">
              <div class="shop-icon">${esc(it.icon || '🎁')}</div>
              <div class="shop-name">${esc(it.name)} ${it.owned ? '<span class="badge badge-pin">已拥有</span>' : ''}</div>
              <div class="shop-desc muted">${esc(it.desc || '')}</div>
              <div class="shop-foot">
                <span class="shop-price">🍗 ${it.price}</span>
                ${it.owned ? '' : `<button class="btn btn-primary btn-sm shop-buy" data-id="${esc(it.id)}" data-type="${it.type}">兑换</button>`}
              </div>
            </div>`).join('') || '<div class="empty-state"><p>该分类暂无商品</p></div>'}
        </div>`).join('')}
    `);
    document.querySelectorAll('.shop-buy').forEach(b => {
      b.addEventListener('click', async () => {
        const itemId = b.dataset.id;
        let customTitle = '';
        if (b.dataset.type === 'title') {
          customTitle = prompt('请输入你的自定义头衔（1-12 字，仅自定义头衔需要）：');
          if (customTitle === null) return;
          customTitle = customTitle.trim();
          if (!customTitle) { toast('头衔不能为空', 'err'); return; }
        }
        if (!confirm('确认花费鸡腿兑换该商品？')) return;
        try {
          const r = await api('/api/shop/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, customTitle }) });
          state.user = { ...state.user, coins: r.coins, title: r.title, badges: r.badges };
          els.userCoins.textContent = '🍗 ' + (r.coins || 0);
          toast('兑换成功！🎉');
          renderShop();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
    setNav('shop');
  }

  /* ================= 关于社区 / FAQ ================= */
  async function renderAbout() {
    let stats = null;
    try { stats = await api('/api/stats').catch(() => null); } catch (e) {}
    const boards = state.boards || await api('/api/boards').catch(() => []);
    renderPage(`
      ${sectionTitle('ℹ️ 关于 JM 社区', '分享 · 交流 · 发现')}
      <div class="card" style="margin-bottom:14px">
        <h3>👋 欢迎来到 JM 社区</h3>
        <p>JM 社区是一个技术、情报、日常与职场互助的交流社区。我们致力于打造一个真实、友好、有价值的分享平台。在这里，你可以：</p>
        <ul style="padding-left:20px;line-height:2">
          <li>📢 <strong>发帖交流</strong> — 在不同板块分享你的经验、见解和发现</li>
          <li>🏢 <strong>公司避雷</strong> — 查询全国 ${stats ? fmtNum(stats.totalCompanies || 5850000) : '580万+'} 家企业信息，分享求职/合作避雷经验</li>
          <li>🍗 <strong>签到赚鸡腿</strong> — 每日签到领鸡腿，鸡腿可用于打赏、悬赏、商城兑换</li>
          <li>🏆 <strong>等级成长</strong> — 发帖、回帖、签到、评价均可获得经验值，提升等级</li>
          <li>🏅 <strong>成就勋章</strong> — 完成特定任务解锁成就，展示你的社区贡献</li>
          <li>💬 <strong>私信互动</strong> — 与其他用户私信交流，建立联系</li>
        </ul>
      </div>
      <div class="card" style="margin-bottom:14px">
        <h3>📋 社区版规</h3>
        <ol style="padding-left:20px;line-height:2">
          <li>禁止发布违法、色情、暴力、政治敏感内容</li>
          <li>禁止人身攻击、恶意辱骂、歧视性言论</li>
          <li>禁止广告刷屏、恶意引流、传销推广</li>
          <li>禁止泄露他人隐私（手机号、身份证、家庭住址等）</li>
          <li>公司避雷评价请基于真实经历，禁止恶意诽谤</li>
          <li>交易板块请遵守相关法律法规，自负盈亏</li>
          <li>鼓励原创分享，转载请注明出处</li>
          <li>遇到问题请 @管理员 或使用举报功能</li>
        </ol>
      </div>
      <div class="card" style="margin-bottom:14px">
        <h3>❓ 常见问题 FAQ</h3>
        <details open><summary><strong>如何注册账号？</strong></summary><p style="padding:8px 0">本社区采用邀请注册制，需要邀请码才能注册。找社区老用户（LV2+）要一个邀请码即可，邀请人还能得鸡腿奖励。</p></details>
        <details><summary><strong>鸡腿有什么用？</strong></summary><p style="padding:8px 0">鸡腿是社区货币，可通过签到、发帖、回帖获取。用途包括：打赏优质帖子、发布悬赏、积分商城兑换徽章和头衔、用户间转账。</p></details>
        <details><summary><strong>如何提升等级？</strong></summary><p style="padding:8px 0">发帖(+5经验)、回帖(+2)、签到(+3)、评价公司(+3)、被点赞(+1)。等级从"初来乍到"到"社区之神"共 10 级。</p></details>
        <details><summary><strong>公司避雷库的数据来源？</strong></summary><p style="padding:8px 0">数据来源于全国工商注册公开信息（1978-2019年），涵盖 31 个省份 580 万+ 家企业。所有访客均可添加公司或发表评价，评价将匿名展示并自动保存。</p></details>
        <details><summary><strong>评价是真实的吗？</strong></summary><p style="padding:8px 0">评价来自网友真实经历，仅供参考，不构成任何法律意见。我们鼓励基于事实的客观评价，禁止恶意诽谤。如发现不实评价，可向管理员举报。</p></details>
        <details><summary><strong>如何添加避雷公司？</strong></summary><p style="padding:8px 0">在公司避雷库页面点击"➕ 添加公司"按钮，填写公司信息后提交。提交后需管理员审核通过才会显示在避雷库中。</p></details>
        <details><summary><strong>忘记密码怎么办？</strong></summary><p style="padding:8px 0">请联系社区管理员重置密码。</p></details>
      </div>
      <div class="card" style="margin-bottom:14px">
        <h3>📂 社区板块</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:10px">
          ${boards.map(b => `<a class="board-card-mini" href="/?board=${esc(b.slug)}" style="display:flex;align-items:center;gap:8px;padding:10px;border-radius:10px;border:1px solid var(--border);text-decoration:none;color:inherit">
            <span style="width:10px;height:10px;border-radius:50%;background:${esc(b.color || '#3d6c45')};flex-shrink:0"></span>
            <div><div style="font-weight:600;font-size:14px">${esc(b.name)}</div><div class="muted" style="font-size:11px">${esc(b.description || '')}</div></div>
          </a>`).join('')}
        </div>
      </div>
      <div class="card" style="text-align:center;padding:20px">
        <p class="muted">JM 社区 · 基于Node.js + Express + SQLite 构建 · PWA 离线支持</p>
        <p class="muted" style="font-size:12px;margin-top:6px">数据来源：全国工商注册公开信息（CC BY-NC-SA 4.0）· 本站不存储任何用户密码明文</p>
      </div>
    `);
  }

  /* ================= v8 玩法前端：成就墙 ================= */
  async function renderAchievements() {
    const [list, me] = await Promise.all([api('/api/achievements'), api('/api/auth/me')]);
    state.user = me.user;
    const mine = new Set((me.user.achievements || []));
    const unlocked = list.filter(a => mine.has(a.id)).length;
    renderPage(`
      ${sectionTitle('🏅 成就墙', `${unlocked}/${list.length} 已解锁`)}
      <div class="card" style="margin-bottom:14px;padding:14px">
        <p class="muted" style="margin:0;font-size:13px">通过发帖、回帖、签到、评价公司、打赏、悬赏、投票、兑换等行为解锁成就，点亮属于你的勋章墙。</p>
      </div>
      <div class="ach-grid">
        ${list.map(a => `
          <div class="ach-item ${mine.has(a.id) ? 'unlocked' : ''}">
            <div class="ach-icon">${mine.has(a.id) ? esc(a.icon) : '🔒'}</div>
            <div class="ach-name">${esc(a.name)}</div>
            <div class="ach-desc muted">${esc(a.desc)}</div>
            ${mine.has(a.id) ? '<div class="ach-check">✓ 已解锁</div>' : ''}
          </div>`).join('')}
      </div>
    `);
    setNav('');
  }

  /* ---------- settings page ---------- */
  async function renderSettings(section) {
    if (!state.user) { route('/login?next=/settings'); return; }
    const data = await api('/api/settings');
    const user = data.user;
    const boards = data.boards;
    const menuItems = [
      { id: 'profile', icon: '👤', label: '个人资料' },
      { id: '2fa', icon: '🔐', label: '双因素验证' },
      { id: 'security', icon: '🔑', label: '账号安全' },
      { id: 'contacts', icon: '📇', label: '联系方式' },
      { id: 'blocked', icon: '🚫', label: '屏蔽用户' },
      { id: 'preferences', icon: '⚙️', label: '常用偏好' },
      { id: 'homeboard', icon: '🏠', label: '首页版块' },
      { id: 'extensions', icon: '🧩', label: '论坛扩展' },
    ];
    const contacts = user.contacts || {};
    const prefs = user.preferences || {};
    const blocked = user.blocked || [];

    const sidebar = `
      <div class="settings-sidebar">
        ${menuItems.map(m => `
          <a href="/settings/${m.id}" class="${section === m.id ? 'active' : ''}">
            <span class="icon">${m.icon}</span>${m.label}
          </a>`).join('')}
      </div>`;

    const sections = {
      profile: `
        <div class="settings-section ${section === 'profile' ? 'active' : ''}" data-section="profile">
          <h2>个人资料</h2>
          <div class="settings-avatar-row">
            <img id="sAvatarImg" src="${esc(avatar(user))}" alt="">
            <div class="avatar-btns">
              <label class="btn btn-primary btn-sm" style="cursor:pointer">
                设置头像
                <input type="file" id="sAvatarFile" accept="image/*" style="display:none">
              </label>
              <input type="text" class="form-control" id="sAvatarUrl" placeholder="或输入图片 URL" value="${esc(user.avatar || '')}" style="min-width:240px">
            </div>
          </div>
          <div class="avatar-preview-grid" id="avatarPresets"></div>
          <div class="form-group">
            <label>昵称</label>
            <input type="text" class="form-control" id="sName" value="${esc(user.name)}" maxlength="30">
          </div>
          <div class="form-group">
            <label>Bio</label>
            <input type="text" class="form-control" id="sBio" value="${esc(user.bio || '')}" maxlength="160" placeholder="用一句话介绍自己">
          </div>
          <div class="form-group">
            <label>签名 <span class="muted" style="font-weight:400">（帖子内容下显示；支持 markdown；不支持图片和引用）</span></label>
            <textarea class="form-control" id="sSignature" rows="4" maxlength="500" placeholder="这里的内容会显示在你的帖子下方">${esc(user.signature || '')}</textarea>
          </div>
          <div class="form-group">
            <label>Readme <span class="muted" style="font-weight:400">（用户主页中显示；支持 markdown）</span></label>
            <textarea class="form-control" id="sReadme" rows="6" maxlength="5000" placeholder="写点关于你的介绍，会展示在你的个人主页">${esc(user.readme || '')}</textarea>
          </div>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span><button class="btn btn-primary" id="saveProfile">保存资料</button></div>
        </div>`,

      '2fa': `
        <div class="settings-section ${section === '2fa' ? 'active' : ''}" data-section="2fa">
          <h2>双因素验证</h2>
          <div style="padding:20px;background:var(--bg-card-2);border:1px solid var(--border);border-radius:var(--radius-sm);text-align:center">
            <div style="font-size:36px;margin-bottom:10px">🔒</div>
            <p style="margin:0 0 14px">当前状态：<span class="muted">未开启</span></p>
            <p class="muted" style="font-size:13px">开启 2FA 后，登录时除了密码还需要输入动态验证码，显著提升账号安全性。</p>
            <button class="btn btn-primary" style="margin-top:14px" id="enable2fa">启用双因素验证</button>
          </div>
        </div>`,

      security: `
        <div class="settings-section ${section === 'security' ? 'active' : ''}" data-section="security">
          <h2>账号安全</h2>
          <div class="form-group"><label>当前密码</label><input type="password" class="form-control" id="sCurPw" autocomplete="current-password" placeholder="输入当前密码"></div>
          <div class="form-group"><label>新密码（至少 6 位）</label><input type="password" class="form-control" id="sNewPw" autocomplete="new-password" placeholder="输入新密码"></div>
          <div class="form-group"><label>再输一次新密码</label><input type="password" class="form-control" id="sNewPw2" autocomplete="new-password" placeholder="确认新密码"></div>
          <p class="muted" style="font-size:13px">修改成功后，其他设备会自动退出登录，本设备保持登录。</p>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span><button class="btn btn-primary" id="changePwBtn">修改密码</button></div>
        </div>`,

      contacts: `
        <div class="settings-section ${section === 'contacts' ? 'active' : ''}" data-section="contacts">
          <h2>联系方式</h2>
          <div class="form-group"><label>公开邮箱</label><input type="email" class="form-control" id="sEmail" value="${esc(contacts.email || '')}" placeholder="example@mail.com"></div>
          <div class="form-group"><label>个人网站</label><input type="text" class="form-control" id="sWebsite" value="${esc(contacts.website || '')}" placeholder="https://your-site.com"></div>
          <div class="form-group"><label>GitHub 用户名</label><input type="text" class="form-control" id="sGithub" value="${esc(contacts.github || '')}" placeholder="username"></div>
          <div class="form-group"><label>Twitter 用户名</label><input type="text" class="form-control" id="sTwitter" value="${esc(contacts.twitter || '')}" placeholder="username"></div>
          <div class="form-group"><label>微信号</label><input type="text" class="form-control" id="sWechat" value="${esc(contacts.wechat || '')}" placeholder="微信号"></div>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span><button class="btn btn-primary" id="saveContacts">保存联系方式</button></div>
        </div>`,

      blocked: `
        <div class="settings-section ${section === 'blocked' ? 'active' : ''}" data-section="blocked">
          <h2>屏蔽用户</h2>
          <p class="muted">被屏蔽的用户无法给你发送私信，你也不会看到他们的帖子（后续版本生效）。</p>
          <div class="form-group" style="display:flex;gap:8px">
            <input type="text" class="form-control" id="blockInput" placeholder="输入要屏蔽的用户名">
            <button class="btn btn-danger" id="addBlock">屏蔽</button>
          </div>
          <div id="blockedList">${blocked.length ? blocked.map(u => blockedChip(u)).join('') : '<span class="muted">暂无屏蔽用户</span>'}</div>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span></div>
        </div>`,

      preferences: `
        <div class="settings-section ${section === 'preferences' ? 'active' : ''}" data-section="preferences">
          <h2>常用偏好</h2>
          <div class="pref-row">
            <div><label>主题风格</label><div class="hint">切换后立即生效，自动记住</div></div>
            <select class="form-control" id="sTheme" style="width:140px">
              <option value="light" ${prefs.theme === 'light' ? 'selected' : ''}>☀️ 浅色模式</option>
              <option value="dark" ${prefs.theme === 'dark' ? 'selected' : ''}>🌙 深色模式</option>
            </select>
          </div>
          <div class="pref-row">
            <div><label>回复通知</label><div class="hint">有人回复我的帖子时通知我</div></div>
            <div class="toggle-switch ${prefs.notifyReply !== false ? 'on' : ''}" id="tNotifyReply" data-key="notifyReply"></div>
          </div>
          <div class="pref-row">
            <div><label>@ 提到通知</label><div class="hint">有人在内容中 @ 我时通知我</div></div>
            <div class="toggle-switch ${prefs.notifyMention !== false ? 'on' : ''}" id="tNotifyMention" data-key="notifyMention"></div>
          </div>
          <div class="pref-row">
            <div><label>界面语言</label></div>
            <select class="form-control" id="sLanguage" style="width:140px">
              <option value="zh-CN" ${prefs.language !== 'en' ? 'selected' : ''}>简体中文</option>
              <option value="en" ${prefs.language === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span><button class="btn btn-primary" id="savePrefs">保存偏好</button></div>
        </div>`,

      homeboard: `
        <div class="settings-section ${section === 'homeboard' ? 'active' : ''}" data-section="homeboard">
          <h2>首页版块</h2>
          <p class="muted">设置登录后首页默认展示的版块。</p>
          <div class="form-group">
            <label>默认首页版块</label>
            <select class="form-control" id="sHomeBoard">
              <option value="" ${!prefs.homeBoard ? 'selected' : ''}>全部帖子</option>
              ${boards.map(b => `<option value="${esc(b.slug)}" ${prefs.homeBoard === b.slug ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
          </div>
          <div class="settings-footer"><span class="settings-msg" id="sMsg"></span><button class="btn btn-primary" id="saveHomeBoard">保存</button></div>
        </div>`,

      extensions: `
        <div class="settings-section ${section === 'extensions' ? 'active' : ''}" data-section="extensions">
          <h2>论坛扩展</h2>
          <div class="empty-state" style="padding:40px 20px">
            <div class="big">🧩</div>
            <p>暂无已安装的扩展</p>
            <p class="muted" style="font-size:13px">扩展市场正在建设中，敬请期待。</p>
          </div>
        </div>`,
    };

    renderPage(`
      ${sectionTitle('设置')}
      <div class="settings-layout">
        ${sidebar}
        <div class="settings-main">
          ${Object.values(sections).join('')}
        </div>
      </div>
    `);

    bindSettingsEvents(section, user, boards);
    setNav('');
  }

  function blockedChip(u) {
    return `<span class="blocked-user-chip">${esc(u)} <button data-u="${esc(u)}" aria-label="移除">×</button></span>`;
  }

  function bindSettingsEvents(section, user, boards) {
    const msg = document.getElementById('sMsg');
    function showMsg(text, ok = true) {
      msg.textContent = text;
      msg.className = 'settings-msg ' + (ok ? 'ok' : 'err');
      setTimeout(() => { msg.textContent = ''; msg.className = 'settings-msg'; }, 3000);
    }

    async function save(body) {
      try {
        const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        state.user = r.user;
        updateAuthUI();
        showMsg('保存成功', true);
        return r.user;
      } catch (e) { showMsg(e.message, false); throw e; }
    }

    if (section === 'profile') {
      // avatar presets
      const presets = [user.avatar, '/assets/logo.png'].filter(Boolean);
      // add some deterministic avatars based on username
      const seed = encodeURIComponent(user.username);
      ['https://api.dicebear.com/7.x/avataaars/svg?seed=', 'https://api.dicebear.com/7.x/bottts/svg?seed=', 'https://api.dicebear.com/7.x/identicon/svg?seed='].forEach(base => presets.push(base + seed));
      document.getElementById('avatarPresets').innerHTML = presets.map(u => `<img src="${esc(u)}" data-url="${esc(u)}" class="${u === (user.avatar || '/assets/logo.png') ? 'selected' : ''}" alt="">`).join('');
      document.querySelectorAll('#avatarPresets img').forEach(img => {
        img.addEventListener('click', () => {
          document.getElementById('sAvatarUrl').value = img.dataset.url;
          document.getElementById('sAvatarImg').src = img.dataset.url;
          document.querySelectorAll('#avatarPresets img').forEach(x => x.classList.remove('selected'));
          img.classList.add('selected');
        });
      });
      document.getElementById('sAvatarUrl').addEventListener('input', e => { document.getElementById('sAvatarImg').src = e.target.value || '/assets/logo.png'; });
      document.getElementById('sAvatarFile').addEventListener('change', e => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const url = ev.target.result;
          document.getElementById('sAvatarUrl').value = url;
          document.getElementById('sAvatarImg').src = url;
        };
        reader.readAsDataURL(f);
      });
      document.getElementById('saveProfile').addEventListener('click', () => save({
        name: document.getElementById('sName').value,
        avatar: document.getElementById('sAvatarUrl').value,
        bio: document.getElementById('sBio').value,
        signature: document.getElementById('sSignature').value,
        readme: document.getElementById('sReadme').value,
      }));
    }

    if (section === '2fa') {
      document.getElementById('enable2fa').addEventListener('click', () => alert('双因素验证功能开发中，将在后续版本上线。'));
    }

    if (section === 'contacts') {
      document.getElementById('saveContacts').addEventListener('click', () => save({
        contacts: {
          email: document.getElementById('sEmail').value,
          website: document.getElementById('sWebsite').value,
          github: document.getElementById('sGithub').value,
          twitter: document.getElementById('sTwitter').value,
          wechat: document.getElementById('sWechat').value,
        }
      }));
    }

    if (section === 'security') {
      document.getElementById('changePwBtn').addEventListener('click', async () => {
        const cur = document.getElementById('sCurPw').value;
        const nw = document.getElementById('sNewPw').value;
        const nw2 = document.getElementById('sNewPw2').value;
        if (!cur || !nw) { showMsg('请填写当前密码和新密码', false); return; }
        if (nw.length < 6) { showMsg('新密码至少 6 位', false); return; }
        if (nw !== nw2) { showMsg('两次输入的新密码不一致', false); return; }
        try {
          const r = await api('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
          document.getElementById('sCurPw').value = '';
          document.getElementById('sNewPw').value = '';
          document.getElementById('sNewPw2').value = '';
          showMsg(r.kicked ? `密码已修改，其他 ${r.kicked} 台设备已退出登录` : '密码已修改', true);
        } catch (e) { showMsg(e.message, false); }
      });
    }

    if (section === 'blocked') {
      const blocked = [...(user.blocked || [])];
      function renderBlocked() {
        document.getElementById('blockedList').innerHTML = blocked.length ? blocked.map(u => blockedChip(u)).join('') : '<span class="muted">暂无屏蔽用户</span>';
        document.querySelectorAll('#blockedList button').forEach(btn => {
          btn.addEventListener('click', async () => {
            const u = btn.dataset.u;
            const idx = blocked.indexOf(u);
            if (idx >= 0) blocked.splice(idx, 1);
            await save({ blocked });
            renderBlocked();
          });
        });
      }
      document.getElementById('addBlock').addEventListener('click', async () => {
        const inp = document.getElementById('blockInput');
        const u = inp.value.trim();
        if (!u) return;
        if (u === user.username) { showMsg('不能屏蔽自己', false); return; }
        if (!blocked.includes(u)) blocked.push(u);
        inp.value = '';
        await save({ blocked });
        renderBlocked();
      });
      renderBlocked();
    }

    if (section === 'preferences') {
      document.querySelectorAll('.toggle-switch').forEach(t => {
        t.addEventListener('click', () => t.classList.toggle('on'));
      });
      document.getElementById('savePrefs').addEventListener('click', () => {
        const theme = document.getElementById('sTheme').value;
        applyTheme(theme);
        localStorage.setItem('forum-theme', theme);
        save({
          preferences: {
            theme,
            notifyReply: document.getElementById('tNotifyReply').classList.contains('on'),
            notifyMention: document.getElementById('tNotifyMention').classList.contains('on'),
            language: document.getElementById('sLanguage').value,
            homeBoard: user.preferences?.homeBoard || '',
          }
        });
      });
    }

    if (section === 'homeboard') {
      document.getElementById('saveHomeBoard').addEventListener('click', () => save({
        preferences: {
          ...(user.preferences || {}),
          homeBoard: document.getElementById('sHomeBoard').value,
        }
      }));
    }
  }

  /* ---------- admin ---------- */
  async function renderAdmin(section) {
    if (!state.user) { route('/login?next=/admin'); return; }
    if (!isStaff(state.user)) {
      renderPage('<div class="empty-state"><div class="big">🚫</div><p>你没有管理员权限</p></div>');
      return;
    }
    const menu = [
      { id: 'dashboard', icon: '📊', label: '仪表盘' },
      { id: 'users', icon: '👥', label: '用户管理' },
      { id: 'codes', icon: '🔑', label: '注册码' },
      { id: 'reports', icon: '🚩', label: '举报队列' },
      { id: 'boards', icon: '📂', label: '板块管理' },
      { id: 'topics', icon: '📝', label: '话题管理' },
      { id: 'notify', icon: '🔔', label: '通知设置' },
      { id: 'companies', icon: '🏢', label: '公司避雷库' },
      { id: 'export', icon: '💾', label: '数据导出' },
    ];
    renderPage(`
      ${sectionTitle('管理后台')}
      <div class="settings-layout">
        <div class="settings-sidebar">
          ${menu.map(m => `<a href="/admin/${m.id}" class="${section === m.id ? 'active' : ''}"><span class="icon">${m.icon}</span>${m.label}</a>`).join('')}
        </div>
        <div class="settings-main" id="adminMain"><div class="loading">加载中...</div></div>
      </div>
    `);
    const main = document.getElementById('adminMain');
    try {
      if (section === 'dashboard') await adminDashboard(main);
      else if (section === 'users') await adminUsers(main);
      else if (section === 'codes') await adminCodes(main);
      else if (section === 'reports') await adminReports(main);
      else if (section === 'boards') await adminBoards(main);
      else if (section === 'topics') await adminTopics(main);
      else if (section === 'notify') await adminNotify(main);
      else if (section === 'companies') await adminCompanies(main);
      else if (section === 'export') adminExport(main);
    } catch (e) {
      main.innerHTML = `<div class="empty-state"><div class="big">⚠️</div><p>${esc(e.message)}</p></div>`;
    }
    setNav('');
  }

  async function adminDashboard(main) {
    const s = await api('/api/admin/stats');
    const cards = [
      ['👥', '用户总数', s.users, '--accent'], ['✨', '今日新增', s.newUsersToday, '--blue'],
      ['📝', '主题总数', s.topics, '--cyan'], ['🆕', '今日新帖', s.newTopicsToday, '--purple'],
      ['💬', '回复总数', s.replies, '--blue'], ['📂', '板块数', s.boards, '--green'],
      ['✅', '今日签到', s.checkinsToday, '--green'], ['🍗', '总鸡腿', fmtNum(s.totalCoins), '--accent'],
      ['👁', '总浏览量', fmtNum(s.totalViews), '--cyan'], ['⭐', '总收藏', fmtNum(s.totalFavorites), '--love'],
      ['🔥', '7日活跃', s.activeUsers7d, '--red'], ['🚫', '封禁用户', s.bannedUsers, '--red'],
      ['🔑', '注册码', `${s.codesUsed}/${s.codesTotal}`, '--blue'],
      ['👑', '站长', s.owners, '--accent'], ['🛡️', '管理员', s.admins, '--purple'],
    ];
    main.innerHTML = `
      <div class="stat-grid">
        ${cards.map(([ic, label, val, c]) => `
          <div class="stat-card">
            <div class="stat-ic" style="color:var(${c})">${ic}</div>
            <div class="stat-val" style="color:var(${c})">${esc(val)}</div>
            <div class="stat-lbl">${esc(label)}</div>
          </div>`).join('')}
      </div>
      <div class="card" style="margin-top:16px">
        <div class="section-title" style="margin-top:0">快捷操作</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn btn-primary btn-sm" href="/admin/users">👥 管理用户</a>
          <a class="btn btn-primary btn-sm" href="/admin/codes">🔑 注册码</a>
          <a class="btn btn-outline btn-sm" href="/admin/boards">📂 管理板块</a>
          <a class="btn btn-outline btn-sm" href="/admin/topics">📝 管理话题</a>
          <a class="btn btn-outline btn-sm" href="/admin/notify">🔔 通知设置</a>
          <a class="btn btn-ghost btn-sm" href="/compose">✍️ 发布公告</a>
        </div>
      </div>`;
  }

  async function adminCompanies(main) {
    const sp = new URLSearchParams(location.search);
    const q = sp.get('q') || '';
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10));
    const data = await api('/api/admin/companies' + (q ? '?q=' + encodeURIComponent(q) : '') + `&page=${page}&pageSize=50`);
    const { list = [], total = 0, pages = 1, summary = {}, recentReviews = [] } = data;
    const buildUrl = (fields) => {
      const p2 = new URLSearchParams();
      const cur = { q, page };
      Object.assign(cur, fields);
      if (cur.q) p2.set('q', cur.q);
      if (cur.page > 1) p2.set('page', cur.page);
      return '/admin/companies' + (p2.toString() ? '?' + p2.toString() : '');
    };
    main.innerHTML = `
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat-card"><div class="stat-ic" style="color:var(--accent)">🏢</div><div class="stat-val" style="color:var(--accent)">${total.toLocaleString()}</div><div class="stat-lbl">公司总数</div></div>
        <div class="stat-card"><div class="stat-ic" style="color:#dc2626">⚠️</div><div class="stat-val" style="color:#dc2626">${summary.danger || 0}</div><div class="stat-lbl">强烈避雷</div></div>
        <div class="stat-card"><div class="stat-ic" style="color:#d97706">💬</div><div class="stat-val" style="color:#d97706">${summary.withReviews || 0}</div><div class="stat-lbl">有评价公司</div></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">➕ 添加公司</div>
        <form id="compAdd" style="display:flex;gap:10px;flex-wrap:wrap">
          <input type="text" class="form-control" name="name" placeholder="公司名称 *" style="flex:1;min-width:140px" required>
          <input type="text" class="form-control" name="industry" placeholder="行业（如：餐饮）" style="width:130px">
          <input type="text" class="form-control" name="region" placeholder="区域（如：渝北）" style="width:110px">
          <button class="btn btn-primary btn-sm">添加</button>
        </form>
        <div class="section-title" style="margin-top:18px">📥 批量导入（一行一个：名称,行业,区域 或 名称|行业|区域）</div>
        <form id="compBatch">
          <textarea class="form-control" name="text" rows="4" placeholder="长安汽车,汽车制造,渝北&#10;德庄集团,餐饮,南岸&#10;..." style="font-family:monospace;font-size:12px"></textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:8px">
            <span class="muted" style="font-size:12px">重复名称自动跳过；当前名录 ${total.toLocaleString()} 家，可粘贴 CSV 继续扩展</span>
            <button class="btn btn-outline btn-sm">导入</button>
          </div>
        </form>
      </div>
      <div class="card" id="pendingCard" style="margin-bottom:14px;padding:0;overflow:hidden;display:none">
        <div class="section-title" style="padding:12px 16px;margin:0;border-bottom:1px solid var(--border)">⏳ 待审核公司提交</div>
        <div id="pendingList"></div>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>公司</th><th>行业</th><th>区域</th><th>避雷指数</th><th>评价数</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${list.map(c => `
              <tr data-id="${esc(c.id)}">
                <td><a href="/companies/${esc(c.id)}" target="_blank">${esc(c.name)}</a>${c.source === 'extra' ? ' <span class="tag tag-orange">新增</span>' : ''}</td>
                <td data-label="行业" class="muted">${esc(c.industry)}</td>
                <td data-label="区域" class="muted">${esc(c.region)}</td>
                <td data-label="避雷指数">${companyBadge(c)} ${c.avg ? `<span class="muted">${c.avg.toFixed(1)}</span>` : ''}</td>
                <td data-label="评价数" class="muted">${c.reviewCount}</td>
                <td class="act-cell">
                  <button class="btn btn-sm btn-ghost act-ed" data-id="${esc(c.id)}">编辑</button>
                  <button class="btn btn-sm btn-danger act-del" data-id="${esc(c.id)}">删除</button>
                </td>
              </tr>`).join('') || `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">暂无公司，用上方表单添加或批量导入</td></tr>`}
          </tbody>
        </table>
        </div>
        ${pager(page, pages, p => buildUrl({ page: p }))}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="section-title" style="margin-top:0">🗂️ 最新避雷评价（前 20 条）</div>
        ${recentReviews.map(r => `
          <div class="comp-review">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <div><a href="/companies/${esc(r.cid)}" target="_blank"><strong>${esc(r.cname)}</strong></a> · ${stars(r.rating)} <span class="muted" style="font-size:12px">by ${esc(r.name || r.username)} · ${fmtTime(r.createdAt)}</span></div>
              <button class="btn btn-sm btn-danger act-rv-del" data-cid="${esc(r.cid)}" data-rid="${esc(r.id)}">删评</button>
            </div>
            <p style="margin:6px 0 0;white-space:pre-wrap;font-size:13px">${esc(r.content)}</p>
          </div>`).join('') || '<p class="muted" style="padding:14px;text-align:center">还没有任何避雷评价</p>'}
      </div>`;
    main.querySelector('#compAdd').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/admin/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fd.get('name'), industry: fd.get('industry'), region: fd.get('region') }) });
        await adminCompanies(main);
      } catch (err) { alert(err.message); }
    });
    main.querySelector('#compBatch').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const text = fd.get('text').trim();
      if (!text) return;
      if (!confirm(`确认批量导入？将解析 ${text.split(/\r?\n/).filter(l => l.trim()).length} 行`)) return;
      try {
        const r = await api('/api/admin/companies/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        alert(`导入完成：新增 ${r.added} 家，跳过 ${r.skipped} 家重复`);
        await adminCompanies(main);
      } catch (err) { alert(err.message); }
    });
    main.querySelectorAll('.act-ed').forEach(b => b.addEventListener('click', () => {
      const row = list.find(c => c.id === b.dataset.id);
      if (!row) return;
      const name = prompt('公司名称', row.name);
      if (name === null) return;
      const industry = prompt('行业', row.industry || '');
      const region = prompt('区域', row.region || '');
      const note = prompt('备注', row.note || '');
      api('/api/admin/companies/' + row.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, industry, region, note }) })
        .then(() => adminCompanies(main)).catch(err => alert(err.message));
    }));
    main.querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 确认删除该公司？其全部避雷评价将一并删除，不可恢复！')) return;
      try { await api('/api/admin/companies/' + b.dataset.id, { method: 'DELETE' }); await adminCompanies(main); } catch (err) { alert(err.message); }
    }));
    main.querySelectorAll('.act-rv-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 删除这条避雷评价？')) return;
      try { await api('/api/admin/companies/' + b.dataset.cid + '/reviews/' + b.dataset.rid, { method: 'DELETE' }); await adminCompanies(main); } catch (err) { alert(err.message); }
    }));
    /* 加载待审核公司 */
    try {
      const pending = await api('/api/admin/companies/pending');
      if (pending.length) {
        const card = main.querySelector('#pendingCard');
        const list = main.querySelector('#pendingList');
        card.style.display = '';
        list.innerHTML = pending.map(p => `
          <div class="pending-item">
            <div class="pending-info">
              <div class="pending-name">${esc(p.name)} <span class="badge-pending">待审核</span></div>
              <div class="pending-meta">${esc(p.industry || '其他')} · ${esc(p.province || '')}${p.city ? '·' + esc(p.city) : ''} · 提交者: ${esc(p.submittedBy || '匿名')} · ${fmtTime(p.createdAt)}</div>
              ${p.note ? `<div style="font-size:13px;margin-top:4px;color:var(--muted)">${esc(p.note)}</div>` : ''}
              ${p.address ? `<div style="font-size:12px;margin-top:2px;color:var(--muted)">📍 ${esc(p.address)}</div>` : ''}
            </div>
            <div class="pending-actions">
              <button class="btn btn-sm btn-primary act-approve" data-pid="${esc(p.id)}">✓ 通过</button>
              <button class="btn btn-sm btn-danger act-reject" data-pid="${esc(p.id)}">✗ 驳回</button>
            </div>
          </div>`).join('');
        list.querySelectorAll('.act-approve').forEach(b => b.addEventListener('click', async () => {
          try { await api('/api/admin/companies/pending/' + b.dataset.pid + '/approve', { method: 'POST' }); toast('已通过审核'); await adminCompanies(main); } catch (err) { alert(err.message); }
        }));
        list.querySelectorAll('.act-reject').forEach(b => b.addEventListener('click', async () => {
          const reason = prompt('驳回原因（可选）');
          try { await api('/api/admin/companies/pending/' + b.dataset.pid + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || '' }) }); toast('已驳回'); await adminCompanies(main); } catch (err) { alert(err.message); }
        }));
      }
    } catch (e) { /* ignore */ }
  }

  async function adminUsers(main) {
    const q = new URLSearchParams(location.search);
    const curQ = q.get('q') || '', curRole = q.get('role') || '', curStatus = q.get('status') || '';
    const curPage = Math.max(1, parseInt(q.get('page') || '1', 10));
    const qs = new URLSearchParams();
    if (curQ) qs.set('q', curQ);
    if (curRole) qs.set('role', curRole);
    if (curStatus) qs.set('status', curStatus);
    const data = await api('/api/admin/users?' + qs.toString() + `&page=${curPage}&pageSize=30`);
    const users = data.list || [];
    const pages = data.pages || 1;
    const page = Math.min(curPage, pages);
    const buildUrl = (fields) => {
      const p2 = new URLSearchParams();
      const cur = { q: curQ, role: curRole, status: curStatus, page };
      Object.assign(cur, fields);
      if (cur.q) p2.set('q', cur.q);
      if (cur.role) p2.set('role', cur.role);
      if (cur.status) p2.set('status', cur.status);
      if (cur.page > 1) p2.set('page', cur.page);
      return '/admin/users' + (p2.toString() ? '?' + p2.toString() : '');
    };
    const me = state.user, meOwner = isOwner(me);
    /* 角色操作按钮：按操作者与目标角色计算 */
    const roleBtns = u => {
      if (u.id === me.id || u.role === 'owner') return '';
      if (meOwner) {
        if (u.role === 'admin') {
          return `<button class="btn btn-sm btn-ghost act-role" data-id="${esc(u.id)}" data-role="owner">👑 设站长</button>
                  <button class="btn btn-sm btn-ghost act-role" data-id="${esc(u.id)}" data-role="user">降为成员</button>`;
        }
        return `<button class="btn btn-sm btn-ghost act-role" data-id="${esc(u.id)}" data-role="admin">升管理员</button>
                <button class="btn btn-sm btn-ghost act-role" data-id="${esc(u.id)}" data-role="owner">👑 设站长</button>`;
      }
      if (u.role === 'user') return `<button class="btn btn-sm btn-ghost act-role" data-id="${esc(u.id)}" data-role="admin">升管理员</button>`;
      return '';
    };
    const lvlBtn = u => {
      if (!meOwner || u.id === me.id) return '';
      return `<button class="btn btn-sm btn-ghost act-level" data-id="${esc(u.id)}">⬆️ 升级</button>`;
    };
    const dangerBtns = u => {
      if (u.id === me.id) return '';
      const canBan = meOwner ? u.role !== 'owner' : u.role === 'user';
      const tip = u.role !== 'user' ? 'title="不能封禁站长或管理员"' : '';
      return `${u.banned
        ? `<button class="btn btn-sm btn-success act-unban" data-id="${esc(u.id)}">解封</button>`
        : `<button class="btn btn-sm btn-danger act-ban" data-id="${esc(u.id)}" ${canBan ? '' : 'disabled ' + tip}>封禁</button>`}
        <button class="btn btn-sm btn-danger act-del" data-id="${esc(u.id)}" ${canBan ? '' : 'disabled ' + tip}>删除</button>`;
    };
    main.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <form id="userFilter" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="text" class="form-control" name="q" placeholder="搜索用户名 / 昵称 / 邮箱" value="${esc(curQ)}" style="flex:1;min-width:180px">
          <select class="form-control" name="role" style="width:130px">
            <option value="">全部角色</option>
            <option value="owner" ${curRole === 'owner' ? 'selected' : ''}>👑 站长</option>
            <option value="admin" ${curRole === 'admin' ? 'selected' : ''}>管理员</option>
            <option value="user" ${curRole === 'user' ? 'selected' : ''}>普通用户</option>
          </select>
          <select class="form-control" name="status" style="width:120px">
            <option value="">全部状态</option>
            <option value="active" ${curStatus === 'active' ? 'selected' : ''}>正常</option>
            <option value="banned" ${curStatus === 'banned' ? 'selected' : ''}>已封禁</option>
          </select>
          <button class="btn btn-primary btn-sm">筛选</button>
        </form>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>用户</th><th>邮箱</th><th>角色</th><th>等级</th><th>鸡腿</th><th>主题/回复</th><th>注册时间</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${users.map(u => `
              <tr data-id="${esc(u.id)}">
                <td><a class="rank-user" href="/space/${esc(u.username)}"><img src="${esc(avatar(u))}" alt=""><span class="u-name">${esc(u.name)}</span> <span class="muted">@${esc(u.username)}</span></a></td>
                <td data-label="邮箱" class="muted u-email">${esc(u.email || '-')}</td>
                <td data-label="角色"><span class="role-badge ${u.role === 'owner' ? 'owner' : u.role === 'admin' ? 'admin' : ''}">${u.role === 'owner' ? '👑 站长' : u.role === 'admin' ? '管理员' : '成员'}</span></td>
                <td data-label="等级"><span class="lv-badge">LV${u.level || 1}</span> <span class="muted" style="font-size:12px;white-space:nowrap">${esc(u.levelTitle || '')}</span></td>
                <td data-label="鸡腿"><span class="coins">🍗 ${u.coins || 0}</span></td>
                <td data-label="主题/回复" class="muted" style="white-space:nowrap">${u.topicCount} / ${u.replyCount}</td>
                <td data-label="注册时间" class="muted" style="white-space:nowrap">${new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
                <td data-label="状态">${u.banned ? '<span class="role-badge banned">已封禁</span>' : '<span class="role-badge ok">正常</span>'}</td>
                <td class="act-cell">
                  ${lvlBtn(u)}
                  ${roleBtns(u)}
                  ${dangerBtns(u)}
                </td>
              </tr>`).join('') || `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">没有找到用户</td></tr>`}
          </tbody>
        </table>
        </div>
        ${pager(page, pages, p => buildUrl({ page: p }))}
      </div>`;
    main.querySelector('#userFilter').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const p = new URLSearchParams();
      if (fd.get('q')) p.set('q', fd.get('q'));
      if (fd.get('role')) p.set('role', fd.get('role'));
      if (fd.get('status')) p.set('status', fd.get('status'));
      route('/admin/users' + (p.toString() ? '?' + p.toString() : ''));
    });
    main.querySelectorAll('.act-role').forEach(b => b.addEventListener('click', async () => {
      const role = b.dataset.role;
      const msgs = { owner: '⚠️ 确认将该用户设为「站长」？站长拥有最高管理权限，可管理所有用户！', admin: '确认将该用户设为管理员？', user: '确认取消该用户的管理员/站长身份，降为普通成员？' };
      if (!confirm(msgs[role] || '')) return;
      try { await api('/api/admin/users/' + b.dataset.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }); await adminUsers(main); } catch (e) { alert(e.message); }
    }));
    /* 站长调等级：弹出 LV1-10 选择（与服务端 LEVELS 称号/经验门槛一致） */
    const LV_META = [[1, '初来乍到', 0], [2, '论坛新人', 50], [3, '活跃会员', 150], [4, '资深会员', 300], [5, '论坛达人', 500], [6, '论坛精英', 800], [7, '论坛名士', 1200], [8, '论坛大师', 1800], [9, '论坛传奇', 2600], [10, '社区之神', 3600]];
    const openLevelPicker = u => {
      document.querySelectorAll('.lv-overlay').forEach(e => e.remove());
      const ov = document.createElement('div');
      ov.className = 'lv-overlay';
      ov.innerHTML = `<div class="lv-modal">
        <div class="lv-modal-head"><b>调整 ${esc(u.name)} 的等级</b><button class="lv-close" aria-label="关闭">✕</button></div>
        <p class="muted" style="font-size:12.5px;margin:0 0 10px">当前 LV${u.level || 1} · ${esc(u.levelTitle || '')}（经验 ${u.exp || 0}）。点目标等级确认后立即生效，用户会收到升级通知。</p>
        <div class="lv-grid">${LV_META.map(([lv, t, e]) => `<button class="lv-opt ${lv === (u.level || 1) ? 'cur' : ''}" data-lv="${lv}"><b>LV${lv}</b><span>${t}</span><small>${e} 经验</small></button>`).join('')}</div>
      </div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.addEventListener('click', e => { if (e.target === ov) close(); });
      ov.querySelector('.lv-close').addEventListener('click', close);
      ov.querySelectorAll('.lv-opt').forEach(b => b.addEventListener('click', async () => {
        const lv = parseInt(b.dataset.lv, 10);
        if (lv === (u.level || 1)) { close(); return; }
        if (!confirm(`确认把 ${u.name}（@${u.username}）的等级设为 LV${lv}？`)) return;
        try {
          await api('/api/admin/users/' + u.id + '/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: lv }) });
          close();
          await adminUsers(main);
        } catch (e) { alert(e.message); }
      }));
    };
    main.querySelectorAll('.act-level').forEach(b => b.addEventListener('click', () => {
      const u = users.find(x => x.id === b.dataset.id);
      if (u) openLevelPicker(u);
    }));
    main.querySelectorAll('.act-ban').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('确认封禁该用户？封禁后其将无法登录。')) return;
      try { await api('/api/admin/users/' + b.dataset.id + '/ban', { method: 'POST' }); await adminUsers(main); } catch (e) { alert(e.message); }
    }));
    main.querySelectorAll('.act-unban').forEach(b => b.addEventListener('click', async () => {
      try { await api('/api/admin/users/' + b.dataset.id + '/unban', { method: 'POST' }); await adminUsers(main); } catch (e) { alert(e.message); }
    }));
    main.querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 确认删除该用户？其发布的主题将转移到「已注销用户」名下，此操作不可恢复！')) return;
      try { await api('/api/admin/users/' + b.dataset.id, { method: 'DELETE' }); await adminUsers(main); } catch (e) { alert(e.message); }
    }));
  }

  async function adminReports(main) {
    const sp = new URLSearchParams(location.search);
    const status = sp.get('status') || 'open';
    const curPage = Math.max(1, parseInt(sp.get('page') || '1', 10));
    const data = await api('/api/admin/reports?status=' + status + `&page=${curPage}&pageSize=30`);
    const list = data.list || [];
    const pages = data.pages || 1;
    const page = Math.min(curPage, pages);
    const buildUrl = (fields) => {
      const p2 = new URLSearchParams();
      const cur = { status, page };
      Object.assign(cur, fields);
      if (cur.status !== 'open') p2.set('status', cur.status);
      if (cur.page > 1) p2.set('page', cur.page);
      return '/admin/reports' + (p2.toString() ? '?' + p2.toString() : '');
    };
    const typeName = { topic: '📝 帖子', reply: '💬 回复', company: '🏢 公司' };
    main.innerHTML = `
      <div class="board-tabs" style="margin-bottom:14px">
        <a href="/admin/reports" class="${status === 'open' ? 'active' : ''}">待处理</a>
        <a href="/admin/reports?status=resolved" class="${status === 'resolved' ? 'active' : ''}">已处理</a>
        <a href="/admin/reports?status=dismissed" class="${status === 'dismissed' ? 'active' : ''}">已驳回</a>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>类型</th><th>举报对象</th><th>理由</th><th>举报人</th><th>时间</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${list.map(r => `
              <tr>
                <td data-label="类型">${typeName[r.type] || r.type}</td>
                <td>${r.type === 'topic' ? `<a href="/post/${esc(r.targetSlug || '')}">${esc(r.targetTitle)}</a>` : esc(r.targetTitle)}</td>
                <td data-label="理由" class="muted" style="max-width:260px">${esc(r.reason)}</td>
                <td data-label="举报人">${esc(r.reporterName)}</td>
                <td data-label="时间" class="muted">${fmtTime(r.createdAt)}</td>
                <td class="act-cell">
                  ${status === 'open' ? `
                    <button class="btn btn-sm btn-success act-rs" data-id="${esc(r.id)}" data-status="resolved">已处理</button>
                    <button class="btn btn-sm btn-ghost act-rs" data-id="${esc(r.id)}" data-status="dismissed">驳回</button>` : `<span class="muted">${esc(r.handledBy || '')} · ${r.handledAt ? fmtTime(r.handledAt) : ''}</span>`}
                </td>
              </tr>`).join('') || `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">暂无举报</td></tr>`}
          </tbody>
        </table>
        </div>
        ${pager(page, pages, p => buildUrl({ page: p }))}
      </div>`;
    main.querySelectorAll('.act-rs').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('/api/admin/reports/' + b.dataset.id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.status }) });
        await adminReports(main);
      } catch (e) { alert(e.message); }
    }));
  }

  function adminExport(main) {
    main.innerHTML = `
      <div class="card">
        <div class="section-title" style="margin-top:0">💾 数据导出 / 备份</div>
        <p class="muted">一键下载全站数据（用户 / 帖子 / 板块 / 注册码 / 公司库 / 私信 / 通知 / 举报）。文件为 JSON 格式，定期备份可在意外时恢复。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <a class="btn btn-primary" href="/api/admin/export" download>⬇️ 下载全站备份</a>
          <button class="btn btn-outline" id="backupTip">ℹ️ 备份说明</button>
        </div>
        <div id="tipBox" class="muted hidden" style="margin-top:12px;padding:12px;background:var(--bg);border-radius:8px">
          <b>恢复方法：</b>本地部署直接覆盖 <code>data/db.json</code> 后重启即可；Vercel 部署请在控制台把备份内容整体写入 KV（键名与代码中 DB_KEY 一致）。<br>
          <b>建议：</b>每周备份一次，发布重大改动前先备份。
        </div>
      </div>`;
    document.getElementById('backupTip').addEventListener('click', () => document.getElementById('tipBox').classList.toggle('hidden'));
  }

  async function adminNotify(main) {
    const cfg = await api('/api/admin/notify');
    main.innerHTML = `
      <div class="card" style="margin-bottom:14px;background:var(--bg-soft)">
        <div class="section-title" style="margin-top:0">📣 群通知说明</div>
        <ul style="margin:0;padding-left:18px;line-height:1.9;font-size:13.5px;color:var(--text-muted)">
          <li><b>Telegram 群</b>：找 <code>@BotFather</code> 创建机器人拿到 Token → 把机器人拉进目标群 → 在群里随便发一句话（或私聊 Bot）→ 点「拉取会话列表」选中该群即可。</li>
          <li><b>微信群</b>：微信群没有开放 API，使用<b>企业微信群机器人</b>即可推送到微信群：企业微信 → 群 → 右上角「群机器人」→ 添加后复制 Webhook 地址填到下面。</li>
          <li>触发事件可独立开关；发送失败不影响论坛正常功能，可在服务端日志排查。</li>
        </ul>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">✈️ Telegram 群通知</div>
        <div class="form-group"><label class="switch-label"><input type="checkbox" id="tgEnabled" ${cfg.telegram.enabled ? 'checked' : ''}> 启用 Telegram 通知</label></div>
        <div class="form-group"><label>Bot Token</label><input class="form-control" id="tgToken" type="password" placeholder="123456:ABC-DEF...（@BotFather 获取）" value="${esc(cfg.telegram.botToken)}"></div>
        <div class="form-group"><label>Chat ID（群 ID）</label>
          <div style="display:flex;gap:10px;align-items:center">
            <input class="form-control" id="tgChatId" placeholder="如 -1001234567890" value="${esc(cfg.telegram.chatId)}" style="flex:1">
            <button type="button" class="btn btn-outline btn-sm" id="tgFetch">🔄 拉取会话列表</button>
          </div>
          <div id="tgChatWrap" style="margin-top:8px"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">💬 企业微信（微信群）通知</div>
        <div class="form-group"><label class="switch-label"><input type="checkbox" id="wcEnabled" ${cfg.wecom.enabled ? 'checked' : ''}> 启用企业微信群机器人通知</label></div>
        <div class="form-group"><label>群机器人 Webhook</label><input class="form-control" id="wcWebhook" type="password" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value="${esc(cfg.wecom.webhook)}"></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">⚡ 触发事件</div>
        <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:14px">
          <label class="switch-label"><input type="checkbox" id="evNewUser" ${cfg.events.newUser ? 'checked' : ''}> 新用户注册</label>
          <label class="switch-label"><input type="checkbox" id="evNewTopic" ${cfg.events.newTopic ? 'checked' : ''}> 新帖发布</label>
          <label class="switch-label"><input type="checkbox" id="evNewReply" ${cfg.events.newReply ? 'checked' : ''}> 新回复</label>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="ntSave">💾 保存配置</button>
        <button class="btn btn-outline" id="ntTest">📨 发送测试消息</button>
        <span class="muted" style="font-size:12.5px">测试前请先保存配置</span>
        <span class="error" id="ntMsg"></span>
      </div>
      <div id="ntResult" style="margin-top:12px"></div>`;

    const collect = () => ({
      telegram: { enabled: document.getElementById('tgEnabled').checked, botToken: document.getElementById('tgToken').value.trim(), chatId: document.getElementById('tgChatId').value.trim() },
      wecom: { enabled: document.getElementById('wcEnabled').checked, webhook: document.getElementById('wcWebhook').value.trim() },
      events: { newUser: document.getElementById('evNewUser').checked, newTopic: document.getElementById('evNewTopic').checked, newReply: document.getElementById('evNewReply').checked },
    });
    const msg = t => { const el = document.getElementById('ntMsg'); el.textContent = t; setTimeout(() => { el.textContent = ''; }, 4000); };

    main.querySelector('#ntSave').addEventListener('click', async () => {
      try { await api('/api/admin/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) }); msg('✅ 已保存'); }
      catch (e) { alert(e.message); }
    });
    main.querySelector('#ntTest').addEventListener('click', async () => {
      const btn = main.querySelector('#ntTest');
      btn.disabled = true; btn.textContent = '发送中...';
      try {
        const res = await api('/api/admin/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
        main.querySelector('#ntResult').innerHTML = (res.results || []).map(r => `
          <div class="card" style="padding:10px 14px;margin-bottom:8px;${r.ok ? 'border-left:3px solid var(--green)' : 'border-left:3px solid var(--red)'}">
            <b>${r.via === 'telegram' ? '✈️ Telegram' : '💬 企业微信'}</b>：
            ${r.ok ? '<span style="color:var(--green)">✅ 发送成功</span>' : `<span style="color:var(--red)">❌ ${esc(r.error)}</span>`}
          </div>`).join('');
      } catch (e) { alert(e.message); }
      btn.disabled = false; btn.textContent = '📨 发送测试消息';
    });
    main.querySelector('#tgFetch').addEventListener('click', async () => {
      const token = document.getElementById('tgToken').value.trim() || cfg.telegram.botToken;
      const wrap = main.querySelector('#tgChatWrap');
      if (!token) { wrap.innerHTML = '<span class="error">请先填写 Bot Token</span>'; return; }
      wrap.innerHTML = '<span class="muted">拉取中...</span>';
      try {
        const res = await api('/api/admin/notify/telegram/chats?botToken=' + encodeURIComponent(token));
        const chats = res.chats || [];
        if (!chats.length) {
          wrap.innerHTML = '<span class="error">没有找到会话：请先把机器人拉进群 / 在群里发一条消息，再点一次（getUpdates 只返回最近 24h 的会话）</span>';
          return;
        }
        wrap.innerHTML = `
          <select class="form-control" id="tgChatPick">
            <option value="">选择会话...</option>
            ${chats.map(c => `<option value="${esc(c.id)}">${esc(c.title)}（${esc(c.type)}${c.id.startsWith('-100') ? ' · ' + esc(c.id) : ''}）</option>`).join('')}
          </select>`;
        main.querySelector('#tgChatPick').addEventListener('change', e => { if (e.target.value) document.getElementById('tgChatId').value = e.target.value; });
      } catch (e) { wrap.innerHTML = `<span class="error">${esc(e.message)}</span>`; }
    });
  }

  async function adminCodes(main) {
    const data = await api('/api/admin/codes');
    main.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">生成注册码</div>
        <form id="codeForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="margin:0;width:110px"><label>数量</label><input type="number" class="form-control" id="cCount" value="5" min="1" max="50"></div>
          <div class="form-group" style="margin:0;flex:1;min-width:200px"><label>备注</label><input class="form-control" id="cNote" maxlength="50" placeholder="如：发给微信好友 / 社区活动"></div>
          <button class="btn btn-primary btn-sm">生成</button>
        </form>
      </div>
      <div class="card" style="margin-bottom:14px;display:flex;gap:28px;flex-wrap:wrap;padding:14px 18px">
        <span>📋 全部：<b>${data.total}</b></span>
        <span>✅ 未使用：<b style="color:var(--green)">${data.available}</b></span>
        <span>🏷️ 已使用：<b style="color:var(--red)">${data.used}</b></span>
        <span class="muted" style="margin-left:auto;font-size:12px">注册码一经使用即失效，请妥善发放</span>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>注册码</th><th>备注</th><th>状态</th><th>使用者</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${data.codes.map(c => `
              <tr data-id="${esc(c.id)}">
                <td><code class="code-chip">${esc(c.code)}</code></td>
                <td data-label="备注" class="muted">${esc(c.note || '-')}</td>
                <td data-label="状态">${c.usedBy ? '<span class="role-badge banned">已使用</span>' : '<span class="role-badge ok">未使用</span>'}</td>
                <td data-label="使用者">${c.usedByUser ? `<a class="muted" href="/space/${esc(c.usedByUser.username)}">${esc(c.usedByUser.name)} @${esc(c.usedByUser.username)}</a>` : '<span class="muted">-</span>'}</td>
                <td data-label="创建时间" class="muted">${new Date(c.createdAt).toLocaleString('zh-CN')}</td>
                <td class="act-cell">
                  <button class="btn btn-sm btn-ghost act-copy" data-code="${esc(c.code)}">复制</button>
                  <button class="btn btn-sm btn-danger act-del" data-id="${esc(c.id)}" ${c.usedBy ? 'disabled title="已使用的注册码不能删除"' : ''}>删除</button>
                </td>
              </tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">还没有生成注册码，先在上面生成一批吧</td></tr>'}
          </tbody>
        </table>
        </div>
      </div>`;
    main.querySelector('#codeForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const res = await api('/api/admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: document.getElementById('cCount').value, note: document.getElementById('cNote').value }) });
        const codes = (res.codes || []).map(c => c.code).join(', ');
        alert('✅ 已生成 ' + res.codes.length + ' 个注册码：\n' + codes + '\n\n可复制分发，也可在列表中逐个复制。');
        await adminCodes(main);
      } catch (err) { alert(err.message); }
    });
    main.querySelectorAll('.act-copy').forEach(b => b.addEventListener('click', async () => {
      const code = b.dataset.code;
      try {
        await navigator.clipboard.writeText(code);
        b.textContent = '已复制 ✓';
        setTimeout(() => { b.textContent = '复制'; }, 1500);
      } catch (e) {
        prompt('复制注册码：', code);
      }
    }));
    main.querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 确认删除该注册码？删除后无法再用于注册。')) return;
      try { await api('/api/admin/codes/' + b.dataset.id, { method: 'DELETE' }); await adminCodes(main); } catch (e) { alert(e.message); }
    }));
  }

  async function adminBoards(main) {
    const boards = await api('/api/boards');
    main.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">新建板块</div>
        <form id="boardForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="margin:0;flex:1;min-width:130px"><label>名称</label><input class="form-control" id="bName" required maxlength="20" placeholder="如：闲聊"></div>
          <div class="form-group" style="margin:0;flex:1;min-width:130px"><label>Slug（英文标识）</label><input class="form-control" id="bSlug" required maxlength="30" placeholder="如：chat"></div>
          <div class="form-group" style="margin:0"><label>颜色</label><input type="color" class="form-control" id="bColor" value="#3d6c45" style="width:72px;padding:4px;height:42px"></div>
          <div class="form-group" style="margin:0;flex:2;min-width:200px"><label>简介</label><input class="form-control" id="bDesc" maxlength="100" placeholder="板块简介"></div>
          <button class="btn btn-primary btn-sm">创建板块</button>
        </form>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>板块</th><th>Slug</th><th>简介</th><th>主题数</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${boards.map(b => `
              <tr data-id="${esc(b.id)}">
                <td><span class="bd-dot" data-color="${esc(b.color)}" style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${esc(b.color)};vertical-align:-1px;margin-right:8px"></span><b>${esc(b.name)}</b></td>
                <td data-label="Slug" class="muted">${esc(b.slug)}</td>
                <td data-label="简介" class="muted">${esc(b.description || '-')}</td>
                <td data-label="主题数">${b.topicCount}</td>
                <td class="act-cell">
                  <button class="btn btn-sm btn-ghost act-edit" data-id="${esc(b.id)}">编辑</button>
                  <button class="btn btn-sm btn-danger act-del" data-id="${esc(b.id)}">删除</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </div>`;
    main.querySelector('#boardForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/api/admin/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          name: document.getElementById('bName').value,
          slug: document.getElementById('bSlug').value,
          color: document.getElementById('bColor').value,
          description: document.getElementById('bDesc').value,
        }) });
        state.boards = [];
        await loadBoards();
        await adminBoards(main);
      } catch (err) { alert(err.message); }
    });
    main.querySelectorAll('.act-edit').forEach(b => b.addEventListener('click', async () => {
      const row = b.closest('tr');
      const id = b.dataset.id;
      const name = prompt('板块名称', row.children[0].textContent.trim());
      if (name === null) return;
      const slug = prompt('Slug', row.children[1].textContent.trim());
      if (slug === null) return;
      const color = prompt('颜色（hex）', row.children[0].querySelector('.bd-dot').dataset.color || '#3d6c45');
      const desc = prompt('简介', row.children[2].textContent.trim() === '-' ? '' : row.children[2].textContent.trim());
      if (desc === null) return;
      const bd = (await api('/api/boards')).find(x => x.id === id);
      const tpl = prompt('发帖模板（发帖时自动预填，留空=无模板）：', (bd && bd.topicTemplate) || '');
      if (tpl === null) return;
      (async () => {
        try {
          await api('/api/admin/boards/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, slug, color, description: desc, topicTemplate: tpl }) });
          state.boards = [];
          await loadBoards();
          await adminBoards(main);
        } catch (err) { alert(err.message); }
      })();
    }));
    main.querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 确认删除该板块？若板块下有话题需先清空话题，此操作不可恢复！')) return;
      try { await api('/api/admin/boards/' + b.dataset.id, { method: 'DELETE' }); state.boards = []; await loadBoards(); await adminBoards(main); } catch (e) { alert(e.message); }
    }));
  }

  async function adminTopics(main) {
    const boards = await loadBoards();
    const params = new URLSearchParams(location.search);
    const curQ = params.get('q') || '', curBoard = params.get('board') || '';
    const curPage = Math.max(1, parseInt(params.get('page') || '1', 10));
    const qs = new URLSearchParams();
    if (curQ) qs.set('q', curQ);
    if (curBoard) qs.set('board', curBoard);
    const data = await api('/api/admin/topics?' + qs.toString() + `&page=${curPage}&pageSize=30`);
    const topics = data.list || [];
    const pages = data.pages || 1;
    const page = Math.min(curPage, pages);
    const buildUrl = (fields) => {
      const p2 = new URLSearchParams();
      const cur = { q: curQ, board: curBoard, page };
      Object.assign(cur, fields);
      if (cur.q) p2.set('q', cur.q);
      if (cur.board) p2.set('board', cur.board);
      if (cur.page > 1) p2.set('page', cur.page);
      return '/admin/topics' + (p2.toString() ? '?' + p2.toString() : '');
    };
    main.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <form id="topicFilter" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="text" class="form-control" name="q" placeholder="搜索标题 / 标签" value="${esc(curQ)}" style="flex:1;min-width:180px">
          <select class="form-control" name="board" style="width:140px">
            <option value="">全部板块</option>
            ${boards.map(b => `<option value="${esc(b.slug)}" ${curBoard === b.slug ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm">筛选</button>
        </form>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>标题</th><th>作者</th><th>板块</th><th>回复</th><th>浏览</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>
            ${topics.map(t => `
              <tr data-id="${esc(t.id)}">
                <td style="max-width:300px"><a href="/post/${esc(t.slug)}" target="_blank" class="admin-topic-link">${esc(t.title)}</a></td>
                <td data-label="作者"><a class="muted" href="/space/${esc(t.author.username)}">${esc(t.author.name)}</a></td>
                <td data-label="板块"><span class="tag-chip" style="background:${esc(t.board.color)}33;color:${esc(t.board.color)}">${esc(t.board.name)}</span></td>
                <td data-label="回复" class="muted">${t.replyCount}</td>
                <td data-label="浏览" class="muted">${fmtNum(t.viewCount)}</td>
                <td data-label="状态">
                  ${t.pinned ? '<span class="role-badge pin">置顶</span>' : ''}
                  ${t.recommended ? '<span class="role-badge rec">推荐</span>' : ''}
                  ${t.closed ? '<span class="role-badge banned">已关闭</span>' : ''}
                  ${t.slowMode ? `<span class="role-badge" style="background:#fef3c7;color:#b45309">🐢 ${t.slowMode}s</span>` : ''}
                  ${!t.pinned && !t.recommended && !t.closed && !t.slowMode ? '<span class="muted">-</span>' : ''}
                </td>
                <td class="act-cell">
                  <button class="btn btn-sm btn-ghost act-pin" data-id="${esc(t.id)}">${t.pinned ? '取消置顶' : '置顶'}</button>
                  <button class="btn btn-sm btn-ghost act-rec" data-id="${esc(t.id)}">${t.recommended ? '取消推荐' : '推荐'}</button>
                  <button class="btn btn-sm btn-ghost act-close" data-id="${esc(t.id)}">${t.closed ? '打开' : '关闭'}</button>
                  <button class="btn btn-sm btn-ghost act-slow" data-id="${esc(t.id)}" data-slow="${t.slowMode || 0}">🐢 慢速</button>
                  <button class="btn btn-sm btn-danger act-del" data-id="${esc(t.id)}">删除</button>
                </td>
              </tr>`).join('') || `<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">没有找到话题</td></tr>`}
          </tbody>
        </table>
        </div>
        ${pager(page, pages, p => buildUrl({ page: p }))}
      </div>`;
    main.querySelector('#topicFilter').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const p = new URLSearchParams();
      if (fd.get('q')) p.set('q', fd.get('q'));
      if (fd.get('board')) p.set('board', fd.get('board'));
      route('/admin/topics' + (p.toString() ? '?' + p.toString() : ''));
    });
    const bind = (sel, apiPath) => {
      main.querySelectorAll(sel).forEach(b => b.addEventListener('click', async () => {
        try { await api(apiPath.replace(':id', b.dataset.id), { method: 'POST' }); await adminTopics(main); } catch (e) { alert(e.message); }
      }));
    };
    bind('.act-pin', '/api/admin/topics/:id/pin');
    bind('.act-rec', '/api/admin/topics/:id/recommend');
    bind('.act-close', '/api/admin/topics/:id/close');
    main.querySelectorAll('.act-slow').forEach(b => b.addEventListener('click', async () => {
      const cur = parseInt(b.dataset.slow) || 0;
      const v = prompt(`设置慢速模式（每人回帖间隔秒数，0=关闭）：\n常用：30秒 / 60秒 / 300秒`, cur || '60');
      if (v === null) return;
      const sec = Math.max(0, Math.min(3600, parseInt(v) || 0));
      try {
        await api('/api/admin/topics/' + b.dataset.id + '/slowmode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds: sec }) });
        toast(sec ? `已开启慢速模式（${sec}秒）` : '已关闭慢速模式');
        await adminTopics(main);
      } catch (e) { alert(e.message); }
    }));
    main.querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('⚠️ 确认删除该话题？此操作不可恢复！')) return;
      try { await api('/api/admin/topics/' + b.dataset.id, { method: 'DELETE' }); await adminTopics(main); } catch (e) { alert(e.message); }
    }));
  }

  /* ---------- core ---------- */
  function renderPage(html) {
    els.pageLoading.classList.add('hidden');
    hidePtr();
    els.pageRoot.innerHTML = html;
    /* 页面转场：快速淡入上滑 */
    els.pageRoot.classList.remove('page-enter');
    void els.pageRoot.offsetWidth;
    els.pageRoot.classList.add('page-enter');
    window.scrollTo(0, 0);
  }
  /* 骨架屏：路由切换瞬间先占位，体感更快 */
  function skelRows(n) {
    let h = '';
    for (let i = 0; i < n; i++) h += `<div class="skel-row"><div class="skel-block" style="height:18px;width:${62 + (i * 13) % 28}%"></div><div class="skel-block" style="height:12px;width:42%;margin-top:9px"></div></div>`;
    return `<div class="skel-list">${h}</div>`;
  }
  function showSkeleton(path) {
    els.pageLoading.classList.add('hidden');
    let html = '';
    if (path === '/' || path === '') html = skelRows(8);
    else if (path === '/trends' || path === '/rank' || path === '/boards' || path === '/favorites' || path === '/featured' || path === '/newbies' || path === '/lucky' || path === '/ruling') html = skelRows(8);
    else if (path.startsWith('/post/')) html = `<div class="skel-card"><div class="skel-block" style="height:24px;width:80%"></div><div class="skel-block" style="height:14px;width:50%"></div><div class="skel-block" style="height:120px;width:100%"></div><div class="skel-block" style="height:60px;width:100%"></div><div class="skel-block" style="height:60px;width:100%"></div></div>`;
    else if (path.startsWith('/space/') || path === '/companies') html = skelRows(6);
    if (html) { els.pageRoot.innerHTML = html; return; }
    els.pageRoot.innerHTML = '';
    els.pageLoading.classList.remove('hidden');
  }

  /* 移动端帖子详情页底部评论条：抖音式 写评论 + 💬👍☆🔗，点写评论弹出底部评论面板 */
  function setupMobileCommentBar(topic) {
    if (window.innerWidth > 760) return;
    if (!state.user) return;
    const replyCount = Math.max(0, (topic.posts || []).length - 1);
    const bar = document.createElement('div');
    bar.className = 'mobile-comment-bar';
    bar.innerHTML = `
      <button class="mc-write" id="mcWrite">✏️ 写评论...</button>
      <button class="mc-btn" id="mcComments" title="评论">💬<span class="mc-num">${replyCount}</span></button>
      <button class="mc-btn" id="mcLike" title="点赞">👍</button>
      <button class="mc-btn" id="mcFav" title="收藏">${topic.favorited ? '★' : '☆'}</button>
      <button class="mc-btn" id="mcShare" title="分享">🔗</button>`;
    document.body.appendChild(bar);
    document.body.classList.add('has-comment-bar');

    function closeSheet() {
      document.querySelectorAll('.mc-backdrop,.mc-sheet').forEach(e => e.remove());
    }
    /* 抖音式底部评论面板：上滑出现，发送后自动滚到新评论 */
    function openSheet() {
      closeSheet();
      const bd = document.createElement('div');
      bd.className = 'mc-backdrop';
      const sheet = document.createElement('div');
      sheet.className = 'mc-sheet';
      sheet.innerHTML = `
        <div class="mc-sheet-handle"></div>
        <div class="mc-sheet-head"><span>发表评论</span><button class="mc-x" aria-label="关闭">✕</button></div>
        <textarea id="mcText" placeholder="友善交流，理性发言..." maxlength="2000"></textarea>
        <div class="mc-sheet-foot">
          <span class="mc-count"><i id="mcCountNum">0</i> / 2000</span>
          <button class="mc-send" id="mcSend" disabled>发送</button>
        </div>`;
      document.body.append(bd, sheet);
      requestAnimationFrame(() => { bd.classList.add('show'); sheet.classList.add('show'); });
      const ta = sheet.querySelector('#mcText');
      const send = sheet.querySelector('#mcSend');
      const num = sheet.querySelector('#mcCountNum');
      ta.addEventListener('input', () => {
        num.textContent = ta.value.length;
        send.disabled = !ta.value.trim();
      });
      bd.addEventListener('click', closeSheet);
      sheet.querySelector('.mc-x').addEventListener('click', closeSheet);
      send.addEventListener('click', async () => {
        const content = ta.value.trim();
        if (!content || send.disabled) return;
        send.disabled = true;
        send.textContent = '发送中...';
        const oldCount = document.querySelectorAll('.post-stream .post-item').length;
        try {
          await api(`/api/topics/${topic.id}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
          closeSheet();
          toast('评论成功');
          route(`/post/${topic.slug}`);
          /* 发完滚到自己的新评论 */
          let tries = 0;
          const timer = setInterval(() => {
            const items = document.querySelectorAll('.post-stream .post-item');
            if (items.length > oldCount || ++tries > 15) {
              clearInterval(timer);
              const last = items[items.length - 1];
              if (last && items.length > oldCount) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 200);
        } catch (e) {
          send.disabled = false;
          send.textContent = '发送';
          toast(e.message, 'err');
        }
      });
      ta.focus();
    }

    document.getElementById('mcWrite').addEventListener('click', openSheet);
    document.getElementById('mcComments').addEventListener('click', () => {
      const box = document.querySelector('.reply-box') || document.querySelector('.post-stream');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('mcLike').addEventListener('click', async () => {
      try { await api(`/api/topics/${topic.id}/like`, { method: 'POST' }); route(`/post/${topic.slug}`); }
      catch (e) { toast(e.message, 'err'); }
    });
    document.getElementById('mcFav').addEventListener('click', async () => {
      try { await api(`/api/topics/${topic.id}/favorite`, { method: 'POST' }); toast('已收藏'); }
      catch (e) { toast(e.message, 'err'); }
    });
    document.getElementById('mcShare').addEventListener('click', () => {
      const url = location.href;
      if (navigator.share) navigator.share({ title: topic.title, url }).catch(() => {});
      else if (navigator.clipboard) { navigator.clipboard.writeText(url).then(() => toast('链接已复制')); }
    });
  }

  function setNav(name) {
    els.navPills.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
    /* 移动端 Tab 栏同步高亮（帖子详情页不高亮任何 tab） */
    const tabMap = { home: 'home', boards: 'boards', compose: 'compose', companies: 'companies', space: 'space' };
    document.querySelectorAll('#mobileTabbar a[data-tab]').forEach(a => {
      a.classList.toggle('active', tabMap[name] === a.dataset.tab);
    });
  }

  function closeDrawer() { els.mobileDrawer.classList.remove('open'); els.overlay.classList.add('hidden'); }
  function openDrawer() { els.mobileDrawer.classList.add('open'); els.overlay.classList.remove('hidden'); }

  async function initAuth() {
    try { const r = await api('/api/auth/me'); state.user = r.user; } catch (e) { state.user = null; }
    window.__forumUser = state.user || null;
    updateAuthUI();
    renderCheckinPanel();
    if (state.user) refreshUnread();
  }

  async function refreshUnread() {
    if (!state.user) { els.bellDot.classList.add('hidden'); els.dmBadge.classList.add('hidden'); return; }
    try {
      const r = await api('/api/notifications/unread-count');
      els.bellDot.classList.toggle('hidden', !r.count);
      els.bellDot.textContent = r.count > 99 ? '99+' : r.count;
      const msgs = await api('/api/messages');
      const dm = msgs.reduce((a, m) => a + (m.unread || 0), 0);
      els.dmBadge.classList.toggle('hidden', !dm);
      els.dmBadge.textContent = dm;
      const td = document.getElementById('tabDot');
      if (td) td.classList.toggle('hidden', !(r.count || dm));
    } catch (e) {}
  }

  async function openBell() {
    if (!state.user) return;
    try {
      const list = await api('/api/notifications');
      const ic = { reply: '💬', mention: '@', message: '✉️', tip: '🍗', bounty: '💰', transfer: '🔁', levelup: '⬆️', achievement: '🏅', invite_reward: '🎁', reminder: '⏰' };
      els.bellDropdown.innerHTML = `
        <div class="bell-head">通知 <a class="bell-clear" href="#" id="bellClearAll">全部已读</a></div>
        <div class="bell-list">
          ${list.map(n => {
            const from = n.fromAvatar ? `<img src="${esc(n.fromAvatar)}" alt="">` : '';
            let body;
            if (n.type === 'reply') body = `<a class="bell-link" href="/post/${esc(n.topicSlug || '')}">回复了你的帖子「${esc(n.topicTitle || '')}」</a>`;
            else if (n.type === 'mention') body = `<a class="bell-link" href="/post/${esc(n.topicSlug || '')}">在「${esc(n.topicTitle || '')}」中提到了你</a>`;
            else if (n.type === 'message') body = `<a class="bell-link" href="/messages/${esc(n.fromUsername || '')}">给你发了一条私信</a>`;
            else if (n.type === 'tip') body = `<a class="bell-link" href="/post/${esc(n.topicSlug || '')}">打赏了你 ${esc(n.amount)} 🍗（帖子「${esc(n.topicTitle || '')}」）</a>`;
            else if (n.type === 'bounty') body = `<a class="bell-link" href="/post/${esc(n.topicSlug || '')}">向你发放了 ${esc(n.amount)} 🍗 悬赏（帖子「${esc(n.topicTitle || '')}」）</a>`;
            else if (n.type === 'transfer') body = `向你转账了 ${esc(n.amount)} 🍗`;
            else if (n.type === 'levelup') body = `恭喜升级到 Lv.${esc(n.level)}「${esc(n.title || '')}」`;
            else if (n.type === 'achievement') body = `解锁成就 ${esc(n.icon || '')}「${esc(n.achName || '')}」`;
            else if (n.type === 'invite_reward') body = `通过你的邀请码注册了论坛，你获得 ${esc(n.coins || 20)} 🍗 奖励（${esc(n.fromName || '')}）`;
            else if (n.type === 'reminder') body = `<a class="bell-link" href="${esc(n.link || '/')}">你设置的书签提醒到了：「${esc(n.title || '')}」</a>`;
            else body = `<a class="bell-link" href="/messages/${esc(n.fromUsername || '')}">给你发了一条私信</a>`;
            return `<div class="bell-item ${n.read ? 'read' : ''}" data-id="${esc(n.id)}"><span class="bell-ic">${ic[n.type] || '🔔'}</span><div class="bell-body"><div class="bell-text">${from}${esc(n.fromName || '系统')} ${body}</div><div class="bell-time">${fmtTime(n.createdAt)}</div></div></div>`;
          }).join('') || '<div class="bell-empty">暂无通知</div>'}
        </div>`;
      els.bellDropdown.classList.remove('hidden');
      document.getElementById('bellClearAll').addEventListener('click', async e => {
        e.preventDefault();
        await api('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        els.bellDropdown.classList.add('hidden');
        refreshUnread();
      });
      document.querySelectorAll('.bell-item').forEach(item => item.addEventListener('click', () => {
        api('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      }));
    } catch (e) {}
  }

  function updateAuthUI() {
    if (state.user) {
      els.authButtons.classList.add('hidden');
      els.userMenu.classList.remove('hidden');
      els.currentAvatar.src = avatar(state.user);
      els.userCoins.textContent = '🍗 ' + (state.user.coins || 0);
      els.profileLink.href = '/space/' + state.user.username;
      els.checkinBtn.classList.remove('hidden');
      els.adminLink.classList.toggle('hidden', !isStaff(state.user));
      const inv = document.getElementById('inviteLink');
      if (inv) inv.href = '/space/' + state.user.username + '#invites';
    } else {
      els.authButtons.classList.remove('hidden');
      els.userMenu.classList.add('hidden');
      els.checkinBtn.classList.add('hidden');
      els.adminLink.classList.add('hidden');
      const inv = document.getElementById('inviteLink');
      if (inv) inv.href = '/login?next=' + encodeURIComponent('/');
    }
    renderSideUserCard();
  }

  function route(path) {
    if (path.startsWith('http')) return;
    history.pushState(null, '', path);
    handleRoute();
  }

  /* 渲染后滚动到锚点（如 #invites） */
  function scrollToHash() {
    const h = location.hash;
    if (!h) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(h);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function handleRoute() {
    /* 清理移动端评论条 */
    document.querySelectorAll('.mobile-comment-bar,.mobile-comment-expand,.mc-backdrop,.mc-sheet').forEach(e => e.remove());
    document.body.classList.remove('has-comment-bar');
    const url = new URL(location.href);
    const path = url.pathname;
    /* 管理后台走全宽：隐藏论坛右侧栏，给后台表格腾出空间 */
    document.body.classList.toggle('wide-mode', path.startsWith('/admin'));
    const params = url.searchParams;
    /* 页面标题随路由更新（标签页/收藏可识别） */
    const SITE = document.title.split(' - ')[0] || '论坛';
    const setTitle = (t) => { document.title = t ? `${SITE} - ${t}` : SITE; };
    if (path === '/' || path === '') setTitle(params.get('board') ? (state.boards.find(b => b.slug === params.get('board'))?.name || '板块') : '首页');
    else if (path === '/boards') setTitle('全部板块');
    else if (path === '/rank') setTitle('排行榜');
    else if (path === '/guide') setTitle('新手教程');
    else if (path === '/trends') setTitle('热点');
    else if (path === '/featured') setTitle('推荐阅读');
    else if (path === '/newbies') setTitle('新人墙');
    else if (path === '/lucky') setTitle('幸运抽奖');
    else if (path === '/ruling') setTitle('管理记录公示');
    else if (path === '/compose') setTitle('发帖');
    else if (path === '/login') setTitle('登录');
    else if (path === '/register') setTitle('注册');
    else if (path === '/favorites') setTitle('我的收藏');
    else if (path === '/search') setTitle('搜索');
    else if (path === '/messages') setTitle('私信');
    else if (path.startsWith('/messages/')) setTitle('私信');
    else if (path.startsWith('/tag/')) setTitle('标签 ' + decodeURIComponent(path.slice(5)));
    else if (path === '/companies') setTitle('公司避雷库');
    else if (path === '/companies/watch') setTitle('我的避雷清单');
    else if (path.startsWith('/companies/')) setTitle('公司详情');
    else if (path === '/shop') setTitle('积分商城');
    else if (path === '/achievements') setTitle('成就墙');
    else if (path === '/about') setTitle('关于社区');
    else if (path.startsWith('/admin')) setTitle('管理后台');
    else if (path.startsWith('/settings')) setTitle('个人设置');
    else if (path.startsWith('/post/')) setTitle('帖子');
    else if (path.startsWith('/space/')) setTitle(decodeURIComponent(path.slice(7)) + ' 的空间');
    else setTitle('');
    closeDrawer();
    /* 移动端顶部频道栏（虎扑式）：推荐 / 关注 / 热榜 / 板块 */
    const _feed = params.get('feed') || '';
    const _ch = path === '/trends' ? 'hot' : path === '/boards' ? 'boards'
      : (path === '/' || path === '') ? (_feed === 'following' ? 'follow' : (params.get('board') || params.get('tag') ? '' : 'rec')) : '';
    document.body.classList.toggle('has-channels', !!_ch);
    document.querySelectorAll('#channelBar a').forEach(a => a.classList.toggle('active', a.dataset.ch === _ch));
    showSkeleton(path);

    try {
      if (path === '/' || path === '') {
        const hb = state.user?.preferences?.homeBoard;
        await renderHome(params.get('board') || hb || '', params.get('sort') || 'latest', parseInt(params.get('page') || '1', 10), params.get('feed') || '');
        return;
      }
      if (path === '/boards') { await renderBoards(params.get('board') || '', parseInt(params.get('page') || '1', 10)); return; }
      if (path === '/rank') { await renderRank(params.get('tab') || 'checkin'); return; }
      if (path === '/guide') { renderGuide(); return; }
      if (path === '/trends') { await renderTrends(params.get('tab') || 'day'); return; }
      if (path === '/featured') { await renderFeatured(); return; }
      if (path === '/newbies') { await renderNewbies(); return; }
      if (path === '/lucky') { await renderLucky(); return; }
      if (path === '/ruling') { await renderRuling(params); return; }
      if (path === '/compose') { await renderCompose(); return; }
      if (path === '/login') { renderLogin(); return; }
      if (path === '/register') { renderRegister(); return; }
      if (path === '/favorites') { await renderFavorites(); return; }
      if (path === '/search') { await renderSearch(params.get('q') || ''); return; }
      if (path === '/messages' || path === '/messages/') { await renderMessages(); return; }
      if (path.startsWith('/messages/')) { await renderConversation(decodeURIComponent(path.slice(10))); return; }
      if (path.startsWith('/tag/')) { await renderTag(decodeURIComponent(path.slice(5)), parseInt(params.get('page') || '1', 10)); return; }
      if (path === '/companies') { await renderCompanies(params); return; }
      if (path === '/companies/watch') { await renderCompanyWatch(); return; }
      if (path.startsWith('/companies/')) { await renderCompanyDetail(decodeURIComponent(path.slice(11))); return; }
      if (path === '/shop') { await renderShop(); return; }
      if (path === '/achievements') { await renderAchievements(); return; }
      if (path === '/about') { await renderAbout(); return; }
      if (path === '/admin' || path === '/admin/') { await renderAdmin('dashboard'); return; }
      if (path.startsWith('/admin/')) { await renderAdmin(path.slice(7) || 'dashboard'); return; }
      if (path === '/settings' || path === '/settings/') { renderSettings('profile'); return; }
      if (path.startsWith('/settings/')) { renderSettings(path.slice(10) || 'profile'); return; }
      if (path.startsWith('/post/')) { await renderPost(decodeURIComponent(path.slice(6))); return; }
      if (path.startsWith('/space/')) { await renderSpace(decodeURIComponent(path.slice(7))); scrollToHash(); return; }
      renderPage('<div class="empty-state"><div class="big">🧭</div><p>404 - 页面不存在</p></div>');
    } catch (err) {
      els.pageLoading.classList.add('hidden');
      els.pageRoot.innerHTML = `<div class="empty-state"><div class="big">⚠️</div><p>${esc(err.message)}</p></div>`;
    }
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="/"]');
    if (a && !e.ctrlKey && !e.metaKey && !a.target) { e.preventDefault(); route(a.getAttribute('href')); }
  });
  /* 手指刚碰到帖子链接就预加载详情，点开时直接命中缓存 */
  document.addEventListener('touchstart', e => {
    const a = e.target && e.target.closest && e.target.closest('a[href^="/post/"]');
    if (!a) return;
    const slug = (a.getAttribute('href').split('/post/')[1] || '').split('?')[0];
    if (slug) prefetch('/api/topics/' + encodeURIComponent(slug));
  }, { passive: true });
  /* 下拉刷新（移动端列表页） */
  const ptrInd = document.getElementById('ptrInd');
  let ptrY = null, ptrOn = false;
  function hidePtr() { ptrOn = false; ptrY = null; if (ptrInd) { ptrInd.classList.remove('on', 'spin'); } }
  document.addEventListener('touchstart', e => {
    if (window.innerWidth > 760) return;
    if (!['/', '/trends', '/boards'].includes(location.pathname)) return;
    if (window.scrollY > 4) return;
    ptrY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (ptrY == null || ptrOn) return;
    if (e.touches[0].clientY - ptrY > 90) { ptrOn = true; if (ptrInd) ptrInd.classList.add('on'); }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!ptrOn) { ptrY = null; return; }
    if (ptrInd) ptrInd.classList.add('spin');
    apiCache.clear();
    handleRoute();
  }, { passive: true });
  /* 头像加载失败 → 兜底默认 logo（捕获模式，覆盖所有动态渲染的 img） */
  document.addEventListener('error', e => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.src && !img.src.endsWith('/assets/logo.png') && !img.dataset.fb) {
      img.dataset.fb = '1';
      img.src = '/assets/logo.png';
    }
  }, true);
  window.addEventListener('popstate', handleRoute);

  els.menuToggle.addEventListener('click', () => els.mobileDrawer.classList.contains('open') ? closeDrawer() : openDrawer());
  els.overlay.addEventListener('click', closeDrawer);
  els.navSearchForm.addEventListener('submit', e => {
    e.preventDefault();
    const q = els.navSearchInput.value.trim();
    if (q) route('/search?q=' + encodeURIComponent(q));
  });
  /* 搜索快捷键：/ 或 ctrl+/ 全局聚焦搜索框（输入框内不触发） */
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (document.activeElement && document.activeElement.isContentEditable)) return;
    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === '/')) {
      e.preventDefault();
      els.navSearchInput.focus();
    }
  });
  els.checkinBtn.addEventListener('click', doCheckin);
  /* 通知铃铛 */
  els.bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!state.user) { route('/login?next=' + encodeURIComponent(location.pathname)); return; }
    if (els.bellDropdown.classList.contains('hidden')) openBell();
    else els.bellDropdown.classList.add('hidden');
  });
  document.addEventListener('click', () => els.bellDropdown.classList.add('hidden'));
  /* 暗色模式 */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.darkToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  function initTheme() {
    let t = localStorage.getItem('forum-theme');
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
    if (state.user && state.user.preferences && state.user.preferences.theme) applyTheme(state.user.preferences.theme);
  }
  els.darkToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('forum-theme', next);
    if (state.user) api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: { theme: next } }) }).catch(() => {});
  });
  initTheme();
  els.userBtn.addEventListener('click', e => { e.stopPropagation(); els.userDropdown.classList.toggle('hidden'); });
  document.addEventListener('click', () => els.userDropdown.classList.add('hidden'));
  els.logoutBtn.addEventListener('click', async e => {
    e.preventDefault();
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    window.__forumUser = null;
    updateAuthUI();
    route('/');
  });

  /* 回到顶部按钮：滚动超过 400px 显示，点击平滑回顶 */
  const toTop = document.getElementById('toTop');
  if (toTop) {
    const onScroll = () => toTop.classList.toggle('hidden', window.scrollY < 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  /* ---------- boot ---------- */
  initAuth().then(() => {
    loadBoards();
    loadTags();
    loadCheckinRank();
    loadHot24();
    handleRoute();
  });
})();
