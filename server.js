const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const notify = require('./notify');
const seedCompanies = require('./seedCompanies');
/* Node 22 内置 SQLite（全国公司库 v9 用）；老 Node / Vercel 环境不可用时自动降级为静态名录 */
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { DatabaseSync = null; }

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'forum-secret-2026';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

/* ================= storage ================= */
/* 存储抽象：本地开发用 JSON 文件持久化；部署到 Vercel 时自动切换到 KV（Upstash REST API），业务代码无需区分 */
const IS_VERCEL = !!process.env.VERCEL || !!process.env.KV_REST_API_URL || !!process.env.KV_URL;
const KV_BASE = process.env.KV_REST_API_URL || process.env.KV_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_TOKEN || '';
const DB_KEY = 'jm_forum_db_v1';
/* 双库分片（2026-10-05）：免费库单月流量上限 10GB，整库 7MB 反复整拉几天就烧爆（13GB 停用事故）。
   设了 KV_REST_API_URL_2 + KV_REST_API_TOKEN_2 时启用分片：核心数据（用户/会话/设置）存主库，
   帖子按序号拆两半分存两库（jm_forum_topics_a / jm_forum_topics_b），每库只扛约一半流量。
   未设 2 号库时走单库整存，兼容旧整存数据；首次以分片模式写入即自动完成数据拆分迁移。 */
const KV2_BASE = process.env.KV_REST_API_URL_2 || '';
const KV2_TOKEN = process.env.KV_REST_API_TOKEN_2 || '';
const SHARD_MODE = !!(KV2_BASE && KV2_TOKEN);
const TOPIC_KEY_A = 'jm_forum_topics_a';
const TOPIC_KEY_B = 'jm_forum_topics_b';
let cacheDb = null;

function packGz(obj) {
  return 'gz1:' + require('zlib').gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
}
function unpackGz(result) {
  /* gz1: 前缀 = gzip+base64 压缩存储（整库 JSON 已超 KV 单值上限，必须压缩） */
  if (typeof result === 'string' && result.startsWith('gz1:')) {
    return JSON.parse(require('zlib').gunzipSync(Buffer.from(result.slice(4), 'base64')).toString('utf8'));
  }
  return typeof result === 'string' ? JSON.parse(result) : result;
}
async function kvGetKey(base, token, key) {
  const res = await fetch(`${base}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('KV get ' + res.status);
  const data = await res.json();
  if (data.result === null || data.result === undefined) return null;
  return unpackGz(data.result);
}
async function kvSetKey(base, token, key, obj) {
  const res = await fetch(`${base}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: packGz(obj),
  });
  if (!res.ok) { const _t = await res.text().catch(() => ''); throw new Error('KV set ' + key + ' ' + res.status + ' ' + _t.slice(0, 120)); }
}

function emptyDb() {
  return { users: [], boards: [], tags: [], topics: [], sessions: {}, regCodes: [], settings: {}, companies: [], messages: [], notifications: [], reports: [] };
}
function ensureDb() {
  if (IS_VERCEL) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2));
}
async function kvGet() {
  const core = await kvGetKey(KV_BASE, KV_TOKEN, DB_KEY);
  if (!core) return null;
  if (core.__shard === 2 && SHARD_MODE) {
    /* 分片合并：A/B 两半按原序号交错还原（A 存偶数位、B 存奇数位） */
    const [sa, sb] = await Promise.all([
      kvGetKey(KV_BASE, KV_TOKEN, TOPIC_KEY_A).catch(() => null),
      kvGetKey(KV2_BASE, KV2_TOKEN, TOPIC_KEY_B).catch(() => null),
    ]);
    const topicsA = (sa && sa.topics) || [];
    const topicsB = (sb && sb.topics) || [];
    /* 分片完整性：只读到一半或两半全空都视为读失败，宁可只读顶着也不许把残缺快照回写 */
    if ((sa === null) !== (sb === null)) throw new Error('partial shard read');
    if (!topicsA.length && !topicsB.length) throw new Error('shard read empty');
    const merged = [];
    const n = Math.max(topicsA.length, topicsB.length);
    for (let i = 0; i < n; i++) {
      if (topicsA[i]) merged.push(topicsA[i]);
      if (topicsB[i]) merged.push(topicsB[i]);
    }
    core.topics = merged;
    delete core.__shard;
  }
  return core;
}
/* 省流量节流：实例内存已有数据时，回源整库拉取最多每 minIntervalMs 一次。
   免费库流量按 GB 计，整库反复整拉是 2026-10-04 停用事故的主因。 */
let lastKvRefreshAt = 0;
async function kvGetThrottled(minIntervalMs) {
  const now = Date.now();
  if (now - lastKvRefreshAt < (minIntervalMs || 60000)) return null;
  lastKvRefreshAt = now;
  return kvGet();
}
/* 防覆写护栏（2026-10-04 空库事故）：KV 读失败/为空时绝不把空快照写回 KV；
   快照规模骤降（话题数 < 历史峰值 30%）时拒绝落盘。宁可写失败，不可覆写真数据。 */
let kvLoadedOk = false;
let maxTopicsSeen = 0;
async function kvSet(db) {
  if (IS_VERCEL) {
    const t = (db && db.topics || []).length;
    if (t > maxTopicsSeen) maxTopicsSeen = t;
    if (!kvLoadedOk && t < 100) {
      console.error('KV set blocked: this instance never loaded real data from KV (topics=' + t + ')');
      return;
    }
    if (maxTopicsSeen > 200 && t < maxTopicsSeen * 0.3) {
      throw new Error('KV set blocked: snapshot shrank ' + maxTopicsSeen + ' -> ' + t + ' topics');
    }
  }
  if (SHARD_MODE && IS_VERCEL) {
    /* 分片写入：核心数据（topics 抠掉）进主库，帖子拆两半分存两库 */
    const topics = db.topics || [];
    const topicsA = [], topicsB = [];
    topics.forEach((tp, i) => (i % 2 === 0 ? topicsA : topicsB).push(tp));
    const core = { ...db, topics: [], __shard: 2 };
    await kvSetKey(KV_BASE, KV_TOKEN, DB_KEY, core);
    await Promise.all([
      kvSetKey(KV_BASE, KV_TOKEN, TOPIC_KEY_A, { topics: topicsA }),
      kvSetKey(KV2_BASE, KV2_TOKEN, TOPIC_KEY_B, { topics: topicsB }),
    ]);
    return;
  }
  const packed = packGz(db);
  const res = await fetch(`${KV_BASE}/set/${DB_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: packed,
  });
  if (!res.ok) { const _t = await res.text().catch(() => ''); throw new Error('KV set ' + res.status + ' ' + _t.slice(0, 150)); }
}
/* Vercel 下 KV 写入合并：普通写延迟 ~1.2s 批量落盘（省 KV 配额），注册/登录等关键写走 flushNow 立即落盘 */
let kvTimer = null;
function saveDb(db) {
  cacheDb = db;
  if (!IS_VERCEL) {
    /* 紧凑 JSON（无缩进）：3 万公司等大数据下省体积与写盘时间；读侧靠内存缓存 */
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    return;
  }
  clearTimeout(kvTimer);
  kvTimer = setTimeout(() => { kvTimer = null; kvSet(cacheDb).catch(e => console.error('KV save failed:', e.message)); }, 1200);
}
async function flushNow() {
  if (!IS_VERCEL) return;
  if (kvTimer) { clearTimeout(kvTimer); kvTimer = null; }
  try { await kvSet(cacheDb); lastKvError = ''; } catch (e) { lastKvError = String(e.message || e).slice(0, 200); console.error('KV flush failed:', e.message); }
}
let lastKvError = '';
function loadDb() {
  if (IS_VERCEL) return cacheDb;
  ensureDb();
  if (cacheDb) return cacheDb;
  cacheDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return cacheDb;
}
/* ---- 注册码 ---- */
function genRegCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符 O0I1
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'JM-' + s;
}
function seedRegCodes() {
  return Array.from({ length: 5 }, () => ({ id: id('rc'), code: genRegCode(), note: '演示注册码（管理后台可生成新码）', usedBy: null, usedAt: null, createdAt: nowIso(), createdBy: null, maxUses: 1, usedCount: 0, usedByList: [] }));
}
/* 数据库结构升级：老数据自动补齐新字段/新板块，不覆盖已有内容 */
function migrate(db) {
  if (!Array.isArray(db.regCodes)) db.regCodes = seedRegCodes();
  if (!db.boards.find(b => b.slug === 'unemployment')) {
    db.boards.push({ id: id('b'), name: '失业联盟', slug: 'unemployment', color: '#6b7a8f', description: '失业互助、求职交流、转型分享', topicCount: 0 });
  }
  if (!db.boards.find(b => b.slug === 'chigua')) {
    db.boards.push({ id: id('b'), name: '吃瓜区', slug: 'chigua', color: '#ec4899', description: '热点八卦、瓜田速报、真相搬运', topicCount: 0 });
  }
  /* 公司避雷库 v3（3 万级名录）：
   * - 名录（只读 30000 家，含 125 家真实种子）静态化在 public/data/companies.json，不占主库/KV
   * - 主库只存两样：companyReviews{companyId:[评价]} 与 extraCompanies[]（管理端新增）
   * - 老数据迁移：把旧 db.companies 中产生的评价挪进 companyReviews；有评价的旧公司若不在
   *   静态名录（如管理员手工加的），转入 extraCompanies 保留 */
  if (!db.companyReviews || typeof db.companyReviews !== 'object') {
    db.companyReviews = {};
    if (Array.isArray(db.companies)) {
      db.companies.forEach(c => {
        const reviews = c.reviews || [];
        if (reviews.length) db.companyReviews[c.id] = reviews;
      });
    }
  }
  if (!Array.isArray(db.extraCompanies)) db.extraCompanies = [];
  if (!Array.isArray(db.pendingCompanies)) db.pendingCompanies = [];
  if (Array.isArray(db.companies) && db.companies.length) {
    /* 旧版公司数组：名录部分已并入静态文件，仅保留不在名录且含评价或手工维护的（作为 extra） */
    const catalogNames = new Set((loadCompanyCatalog() || []).map(c => c.name));
    db.companies.forEach(c => {
      if (!catalogNames.has(c.name) && ((c.reviews || []).length || c.note)) db.extraCompanies.push({ id: c.id, name: c.name, industry: c.industry || '其他', region: c.region || '重庆', note: c.note || '', createdAt: c.createdAt || nowIso() });
    });
    db.companies = [];
  }
  if (!db.users.find(u => u.id === GHOST.id)) {
    db.users.push({ ...GHOST, createdAt: nowIso(), passwordHash: hashPw('deleted-ghost'), favorites: [], ...defaultProfile() });
  }
  /* 通知配置：缺省合并默认值 */
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  db.settings.notify = notify.mergeNotify(db.settings.notify);
  /* 角色体系升级：老数据补 role 字段，原 admin 账号自动升级为站长（owner） */
  db.users.forEach(u => {
    if (!u.role) u.role = u.username === 'admin' ? 'owner' : 'user';
    if (u.role === 'admin' && u.username === 'admin') u.role = 'owner';
    if (!['user', 'admin', 'owner'].includes(u.role)) u.role = 'user';
  });
  /* 私信 / 站内通知 / 举报集合 */
  if (!Array.isArray(db.messages)) db.messages = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
  if (!Array.isArray(db.reports)) db.reports = [];
  /* ⚖️ 管理记录公示 */
  if (!Array.isArray(db.modLogs)) db.modLogs = [];
  /* 🎲 幸运抽奖 */
  if (!Array.isArray(db.lotteries)) db.lotteries = [];
  /* 📢 全站公告 */
  if (!Array.isArray(db.announcements)) db.announcements = [];
  /* 📰 新闻播报机器人（每日自动抓取热榜发帖） */
  if (!db.users.find(u => u.username === 'newsbot')) {
    db.users.push({
      id: id('u'), username: 'newsbot', name: '瓜田播报员', passwordHash: '',
      avatar: '', createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 0,
      checkinCoins: 0, lastCheckin: '', favorites: [],
      bio: '🤖 每天早上 8 点自动播报全网热点，吃瓜不迷路',
      signature: '', readme: '', contacts: {}, preferences: {},
      blocked: false, exp: 0, badges: [], title: '', achievements: {},
      checkinCount: 0, following: [],
    });
  }
  /* ⚽ 体育专区（对标虎扑：各球类独立板块） */
  const SPORT_BOARDS = [
    { name: '篮球', slug: 'basketball', color: '#f97316', description: 'NBA、CBA、野球场：聊球看球评球' },
    { name: '足球', slug: 'football', color: '#22c55e', description: '五大联赛、中超、欧冠：世界第一运动' },
    { name: '网球', slug: 'tennis', color: '#a3e635', description: '四大满贯、ATP、WTA' },
    { name: '羽毛球', slug: 'badminton', color: '#eab308', description: '苏杯汤尤杯、世锦赛、奥运争光' },
    { name: '乒乓球', slug: 'pingpong', color: '#ef4444', description: 'WTT、世乒赛，国球无敌' },
    { name: '排球', slug: 'volleyball', color: '#3b82f6', description: '中国女排、联赛、世锦赛' },
    { name: '台球', slug: 'billiards', color: '#8b5cf6', description: '斯诺克、中式八球、九球' },
    { name: '棒球', slug: 'baseball', color: '#f43f5e', description: 'MLB、日职棒、世界棒球经典赛' },
    { name: '高尔夫', slug: 'golf', color: '#10b981', description: '大满贯、PGA、挥杆人生' },
    { name: '电竞', slug: 'esports', color: '#6366f1', description: 'LOL、CS2、王者荣耀、DOTA2' },
    { name: '综合体育', slug: 'sports', color: '#06b6d4', description: '田径、游泳、F1、健身及其他运动' },
  ];
  SPORT_BOARDS.forEach(s => {
    if (!db.boards.find(b => b.slug === s.slug)) {
      db.boards.push({ id: id('b'), name: s.name, slug: s.slug, color: s.color, description: s.description, topicCount: 0, weight: 100 + SPORT_BOARDS.indexOf(s) * 10 });
    }
  });
  /* 福利分享板块（对标 linux.do 福利区） */
  if (!db.boards.find(b => b.slug === 'fuli')) {
    db.boards.push({ id: id('b'), name: '福利分享', slug: 'fuli', color: '#f59e0b', description: '羊毛福利、资源分享、网盘互助', topicCount: 0, weight: 95,
      topicTemplate: '【福利名称】\n\n【领取方式】\n\n【有效期】\n\n【备注】' });
  }
  /* 板块排序权重：老板块按原顺序 */
  db.boards.forEach((b, i) => { if (typeof b.weight !== 'number') b.weight = (i + 1) * 10; });
  /* v8 升级：等级体系 / 积分商城 / 打赏悬赏 / 投票 / 成就 / 鸡腿交易 */
  if (!Array.isArray(db.shopItems) || !db.shopItems.length) db.shopItems = seedShop();
  if (!Array.isArray(db.transfers)) db.transfers = [];
  db.users.forEach(u => {
    if (!u.exp) u.exp = 0;
    if (!Array.isArray(u.badges)) u.badges = [];
    if (!u.title) u.title = '';
    if (!Array.isArray(u.achievements)) u.achievements = [];
    if (!u.checkinCount) u.checkinCount = 0;
    if (!u.lastCheckin && u.checkinCoins > 0) u.checkinCount = 1;
    if (!Array.isArray(u.following)) u.following = [];
  });
}
function slugify(str) { return String(str).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'post'; }
function nowIso() { return new Date().toISOString(); }
function id(p = '') { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/* 会话令牌：256 位真随机（原 id('s') 仅 Math.random+时间戳，熵不足，2026-10-04 升级） */
function newSessionToken() { return 's' + crypto.randomBytes(32).toString('hex'); }
/* ---- ⚖️ 管理记录（公开可查） ---- */
function modLog(db, action, adminUser, targetName, detail) {
  if (!Array.isArray(db.modLogs)) db.modLogs = [];
  db.modLogs.unshift({ id: id('m'), action, admin: adminUser ? adminUser.name : '系统', adminId: adminUser ? adminUser.id : '', target: targetName || '', detail: detail || '', createdAt: nowIso() });
  if (db.modLogs.length > 500) db.modLogs.length = 500;
}
/* ---- 站内通知 ---- */
/* 扫描正文中的 @用户名（中文/字母/数字/下划线/连字符，2-20 位），返回被提及用户列表 */
function scanMentions(db, content, excludeId) {
  const out = [];
  const seen = new Set();
  const re = /@([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})/g;
  let m;
  while ((m = re.exec(String(content || '')))) {
    const u = db.users.find(x => x.username === m[1] && x.id !== excludeId);
    if (u && !seen.has(u.id)) { seen.add(u.id); out.push(u); }
  }
  return out;
}
function addNotification(db, userId, type, payload) {
  db.notifications = db.notifications || [];
  db.notifications.push({ id: id('nt'), userId, type, ...payload, read: false, createdAt: nowIso() });
}
function hashPw(p) { return bcrypt.hashSync(p, 10); }
function checkPw(p, h) { return bcrypt.compareSync(p, h); }
function todayStr(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function defaultProfile() {
  return {
    bio: '',
    signature: '',
    readme: '',
    contacts: { email: '', website: '', github: '', twitter: '', wechat: '' },
    preferences: { theme: 'light', notifyReply: true, notifyMention: true, homeBoard: '', language: 'zh-CN' },
    blocked: [],
  };
}

/* ================= seed ================= */
function seed(db) {
  if (db.boards && db.boards.length) return;

  const seedUsers = [
    ['admin', '管理员', 4, 'admin', 120], ['alice', 'Alice', 3, 'user', 45], ['bob', 'Bob', 2, 'user', 30],
    ['carol', 'Carol', 2, 'user', 38], ['dave', 'Dave', 1, 'user', 15], ['eve', 'Eve', 1, 'user', 22],
    ['frank', 'Frank', 1, 'user', 9], ['grace', 'Grace', 2, 'user', 27], ['heidi', 'Heidi', 1, 'user', 14],
    ['ivan', 'Ivan', 1, 'user', 11], ['judy', 'Judy', 1, 'user', 18], ['mallory', 'Mallory', 1, 'user', 6],
    ['oscar', 'Oscar', 1, 'user', 25], ['peggy', 'Peggy', 2, 'user', 33], ['trent', 'Trent', 1, 'user', 12],
    ['victor', 'Victor', 1, 'user', 20], ['wendy', 'Wendy', 1, 'user', 16], ['xavier', 'Xavier', 1, 'user', 8],
    ['yolanda', 'Yolanda', 1, 'user', 10], ['zara', 'Zara', 1, 'user', 13],
  ];
  /* 云端全新部署只保留管理员账号，不造假用户（本地保留完整演示数据） */
  const users = IS_VERCEL ? [seedUsers[0]] : seedUsers;
  const adminPwd = process.env.ADMIN_PASSWORD || (Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!8');
  const userPwd = Math.random().toString(36).slice(2, 12);
  db.users = users.map(([username, name, trust, role, coins]) => ({
    id: id('u'), username, name, email: username + '@example.com', passwordHash: hashPw(username === 'admin' ? adminPwd : userPwd),
    avatar: username === 'admin' ? '/assets/logo.png' : null, createdAt: nowIso(), trustLevel: trust, role,
    coins, checkinCoins: Math.floor(Math.random() * 15), lastCheckin: todayStr(), favorites: [],
    ...defaultProfile(),
  }));
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  首次启动 - 初始账号信息（请妥善保管）       │');
  console.log('│  管理员账号: admin                           │');
  console.log('│  管理员密码: ' + adminPwd.padEnd(33) + '│');
  if (!IS_VERCEL) console.log('│  其他种子用户密码: ' + userPwd.padEnd(25) + '│');
  console.log('│  ⚠️ 请登录后立即修改密码！                    │');
  console.log('└─────────────────────────────────────────────┘');

  db.boards = [
    { id: id('b'), name: '日常', slug: 'daily', color: '#ffb454', description: '聊天灌水、生活日常', topicCount: 0 },
    { id: id('b'), name: '情报', slug: 'info', color: '#ff6b6b', description: '行业动态、热点情报', topicCount: 0 },
    { id: id('b'), name: '技术', slug: 'tech', color: '#4aa8ff', description: '网络、服务器、编程技术交流', topicCount: 0 },
    { id: id('b'), name: '交易', slug: 'trade', color: '#34d399', description: 'VPS、域名、账号交易市场', topicCount: 0 },
    { id: id('b'), name: 'Dev', slug: 'dev', color: '#c084fc', description: '开发者工具与开源项目', topicCount: 0 },
    { id: id('b'), name: '测评', slug: 'review', color: '#22d3ee', description: '产品测评、体验分享', topicCount: 0 },
    { id: id('b'), name: '失业联盟', slug: 'unemployment', color: '#6b7a8f', description: '失业互助、求职交流、转型分享', topicCount: 0 },
    { id: id('b'), name: '吃瓜区', slug: 'chigua', color: '#ec4899', description: '热点八卦、瓜田速报、真相搬运', topicCount: 0 },
  ];

  db.tags = ['置顶', '公告', '推荐', '教程', '求助', '分享', '开源', '优惠', '讨论', '水贴'].map(t => ({ id: id('t'), name: t }));

  if (IS_VERCEL) {
    /* 云端全新部署：只留一篇欢迎帖，不造假帖/假数据 */
    const admin = db.users[0];
    const board = db.boards[0];
    const topicId = id('tp');
    const welcome = '欢迎来到 JM 社区！\n\n这是一个开放、友善、有料的社区，祝你在这里有所收获。\n\n**社区规范**\n\n1. 友善交流，不人身攻击\n2. 交易帖请标明价格与配置\n3. 不发布违法或侵权内容\n\n违规内容管理员将视情节删帖或封号。';
    db.topics = [{
      id: topicId, title: '欢迎来到 JM 社区 —— 新人必读', slug: 'welcome', boardId: board.id,
      userId: admin.id, createdAt: nowIso(), bumpedAt: nowIso(),
      viewCount: 0, replyCount: 0, likeCount: 0, tags: ['公告'],
      posts: [{ id: id('p'), topicId, userId: admin.id, content: welcome, createdAt: nowIso(), likeCount: 0, postNumber: 1 }],
      pinned: true, recommended: false, price: 0, closed: false, favoriteCount: 0, favoritedUsers: [],
    }];
    board.topicCount = 1;
    saveDb(db);
    return;
  }

  const seedPosts = [
    // [boardIdx, title, contentIdx, userIdx, views, comments, pinned, recommended, tags]
    [0, '欢迎来到 JM 社区 —— 共建我们的理想社区', 0, 0, 128000, 356, true, true, ['公告', '推荐']],
    [0, '社区版规与使用指南（新用户必读）', 1, 0, 86000, 120, true, false, ['公告']],
    [2, '自建落地机协议怎么选？看完这篇不再纠结', 2, 1, 45600, 230, false, true, ['教程', '推荐']],
    [3, '【出售】海外 VPS 低价出，配置见内', 3, 2, 12800, 45, false, false, ['交易', '优惠']],
    [1, '某云服务商大幅降价，卷起来了', 4, 3, 33200, 98, false, false, ['情报']],
    [2, '用 Docker 一分钟部署一个轻量论坛', 5, 1, 28900, 76, false, true, ['教程', '分享', '开源']],
    [5, '新入手的一款机械键盘，手感真的绝了', 6, 4, 6700, 32, false, false, ['分享']],
    [0, '深夜树洞：工作五年，我决定裸辞了', 7, 5, 41900, 210, false, false, ['水贴', '讨论']],
    [4, '开源了一个 API 请求调试工具，欢迎试用', 8, 6, 15400, 58, false, false, ['开源', '分享']],
    [2, 'VPS 被攻击了怎么办？常见安全加固清单', 9, 7, 23800, 64, false, false, ['教程']],
    [3, '【求购】收一台便宜的国内小鸡，日常挂机用', 10, 8, 5200, 21, false, false, ['交易']],
    [1, 'AI 编程工具横评：谁才是真正的效率神器', 11, 1, 58200, 168, false, true, ['情报', '讨论']],
    [5, '某机场节点速度实测，晚高峰表现如何', 12, 9, 31600, 87, false, false, ['测评']],
    [0, '大家今天中午都吃了什么？来晒一晒', 13, 10, 9800, 145, false, false, ['水贴']],
    [4, '推荐几个提高开发效率的 VSCode 插件', 14, 11, 20500, 52, false, false, ['分享']],
    [3, '【已出】闲置域名出售，价格好商量', 15, 12, 4300, 12, false, false, ['交易']],
    [2, 'MySQL 慢查询优化实战记录', 16, 13, 17400, 39, false, false, ['教程']],
    [1, '突发：某大厂开源其内部部署工具', 17, 14, 40900, 102, false, false, ['情报']],
    [5, '百元以内的降噪耳机到底行不行', 18, 15, 22600, 71, false, false, ['测评']],
    [0, '分享一个我坚持了三年的好习惯', 19, 16, 8700, 63, false, false, ['讨论']],
    [2, '从零开始搭建自己的博客站点（保姆级教程）', 20, 1, 36800, 133, false, true, ['教程', '推荐']],
    [4, '写了一年的开源项目终于过千 Star 了', 21, 17, 19800, 49, false, false, ['开源']],
    [3, '【优惠】新用户注册云服务器立减 50 元', 22, 18, 15200, 30, false, false, ['优惠']],
    [1, '聊聊最近的存储芯片涨价潮', 23, 19, 27400, 85, false, false, ['情报']],
    [5, '最近用了几天 Linux 桌面，体验分享', 24, 4, 12100, 57, false, false, ['分享']],
    [0, '论坛已支持深色模式，祝大家冲浪愉快', 25, 0, 31000, 88, false, true, ['公告', '推荐']],
    [6, '失业第 40 天，开个帖子记录求职日常', 26, 3, 8700, 45, false, true, ['讨论', '推荐']],
    [6, '35 岁被优化，聊聊下一段路怎么走', 27, 5, 12300, 78, false, false, ['讨论']],
  ];

  const contents = [
    '很高兴在这里认识大家！希望我们能一起打造一个开放、友善、有料的社区。\n\n请大家遵守社区规范，友好交流。\n\n本站参考了行业里优秀的论坛产品形态，结合自己的理解做了打磨，欢迎大家多提意见。',
    '欢迎新同学！请花一分钟了解以下规则：\n\n1. 友善交流，不人身攻击\n2. 交易帖请标明价格与配置\n3. 不发布违法或侵权内容\n\n违规内容管理员将视情节删帖或封号。',
    '落地机的协议选择直接影响速度和稳定性。\n\n简单结论：\n\n- 日常网页浏览：选协议 A 即可\n- 追求极限速度：协议 B + 锐速参数\n- 需要抗封锁：协议 C\n\n详细对比表如下，欢迎补充。',
    '出一台海外小鸡，配置如下：\n\nCPU：2 核\n内存：2G\n硬盘：40G SSD\n流量：1T/月\n\n价格：¥ 299/年，可小刀，带原邮箱。',
    '刚刚看到消息，某云服务商宣布全线降价 30%，这是要卷死同行的节奏。\n\n对用户来说自然是好事，价格战打起来，选择就多了。',
    'Docker 部署真的很简单，一条命令就能跑起来：\n\n```\ndocker run -d -p 3000:3000 your-image\n```\n\n数据挂载到本地目录即可，备份也方便。',
    '最近入手了一把客制化机械键盘，段落轴，手感扎实，声音清脆。\n\n办公室用起来也不会太吵，写代码心情都好了不少。',
    '在这个公司待了五年，从青涩到圆滑，回头看看成长不少。\n\n但今年越来越觉得不对味，思考再三还是决定离开。\n\n裸辞有风险，但人生总要为自己活一次。',
    '花了两个周末写了个 API 调试工具，支持请求历史、环境变量、导入导出。\n\n完全开源，欢迎 Star 和提 PR！',
    '被攻击的经历想必大家都遇到过，我总结了几条基本的安全实践：\n\n1. 修改默认 SSH 端口\n2. 关闭 root 密码登录\n3. 开启防火墙白名单\n4. 定期更新系统\n\n做到这几点，能挡住大部分脚本小子。',
    '想收一台国内的小鸡，要求不高：\n\n- 1 核 1G 起步\n- 带宽 3M 以上\n- 价格越便宜越好\n\n长期挂机用，有的大佬私聊我。',
    '最近把主流 AI 编程工具都试了一遍，简单说说感受：\n\n- 工具 A：补全快，上下文长\n- 工具 B：对话体验好，适合讲解\n- 工具 C：免费额度大，性价比高\n\n没有绝对的最好，只有最适合自己的。',
    '测了几个机场节点的晚高峰表现，结果如下：\n\n- 节点 X：4K 视频流畅，延迟稳定\n- 节点 Y：白天快，晚高峰波动大\n- 节点 Z：便宜但高峰期基本不能用\n\n结论：一分钱一分货。',
    '今天午饭点了一份黄焖鸡，味道不错，就是分量有点小。\n\n晚饭打算吃碗热干面，大家今天都吃了啥？',
    '整理了几个让我效率翻倍的 VSCode 插件：\n\n- GitLens：看提交历史神器\n- Prettier：统一代码风格\n- Error Lens：错误提示更直观\n- 智能提示类插件：写代码更丝滑',
    '闲置一个域名，品相还可以，注册了两年。\n\n价格 300 出，有意者私聊，可以走平台担保。',
    '最近优化了一个线上慢查询，记录一下排查过程：\n\n1. 先用 EXPLAIN 看执行计划\n2. 发现缺索引，加上之后快 10 倍\n3. 又发现查询里隐式转换，修掉类型\n\n调优真的是个细致活。',
    '刚看到消息，某大厂宣布将其内部部署工具开源。\n\n这个工具在业界口碑一直不错，开源后生态应该会很快起来。',
    '抱着试试看的心态买了个百元级降噪耳机，结果超出预期。\n\n降噪效果在公交地铁上够用，音质对得起价格，就是续航一般。\n\n预算有限的朋友可以考虑。',
    '坚持了三年每天写工作日志，收获真的很大：\n\n- 复盘更及时\n- 汇报有素材\n- 成长看得见\n\n强烈推荐大家试试，哪怕每天只写三行。',
    '从域名、服务器、主题到部署，一步步带你搭建自己的博客：\n\n1. 购买域名并解析\n2. 选购服务器\n3. 安装环境\n4. 配置主题\n5. 绑定域名 + HTTPS\n\n跟着做，一小时搞定。',
    '写了个开源项目，从零开始到现在终于过千 Star 了！\n\n感谢社区的支持，也感谢那些提 Issue 和 PR 的朋友。\n\n我会继续维护下去。',
    '新用户注册云服务器可立减 50 元，仅限新账号，数量有限。\n\n需要的抓紧，链接放这里了。',
    '最近存储芯片价格一路走高，SSD、内存都涨了不少。\n\n有刚需的朋友建议趁早入手，等等党这次可能要失算了。',
    '用了几天 Linux 桌面，简单说下感受：\n\n- 干净、稳定、不打扰\n- 软件生态比想象中好\n- 显卡驱动偶尔要折腾\n\n总体值得一试。',
    '为了更好的浏览体验，我们上线了深色模式。\n\n点击右上角即可切换，如果遇到显示问题欢迎反馈。',
    '被裁三个月了，投了几十份简历大多石沉大海。\n\n开个帖子记录自己的求职日常，也当个树洞。\n\n今天面了一家，聊得还行，希望有下文。\n\n欢迎大家一起来交流找工作的经验，互相打气。',
    '昨天收到通知，整个部门被优化了。\n\n35 岁这个坎，终于轮到我了。\n\n准备先休息一周，然后认真规划下一段路。\n\n也想听听大家的意见：转行、创业还是继续找？',
  ];

  seedPosts.forEach((p, idx) => {
    const topicId = id('tp');
    const board = db.boards[p[0]];
    const author = db.users[p[3]];
    const time = new Date(Date.now() - idx * 3600000 * 3.4).toISOString();
    const posts = [];
    posts.push({ id: id('p'), topicId, userId: author.id, content: contents[p[2]], createdAt: time, likeCount: Math.floor(Math.random() * 120), postNumber: 1 });
    const cmt = Math.min(p[5], 6);
    for (let r = 0; r < cmt; r++) {
      const replier = db.users[(p[3] + r + 1) % db.users.length];
      posts.push({ id: id('p'), topicId, userId: replier.id, content: comments[(p[2] + r) % comments.length], createdAt: new Date(Date.now() - (idx * 3.4 + r * 0.3) * 3600000).toISOString(), likeCount: Math.floor(Math.random() * 40), postNumber: r + 2 });
    }
    db.topics.push({
      id: topicId, title: p[1], slug: slugify(p[1]) + '-' + idx, boardId: board.id,
      userId: author.id, createdAt: time, bumpedAt: new Date(Date.now() - (idx * 3.4 - 0.2) * 3600000).toISOString(),
      viewCount: p[4], replyCount: p[5], likeCount: posts.reduce((a, x) => a + x.likeCount, 0),
      tags: p[8] || [], posts, pinned: !!p[6], recommended: !!p[7], price: p[0] === 3 ? [299, 250, 1200, 300][idx % 4] : 0,
      closed: false, favoriteCount: Math.floor(Math.random() * 90), favoritedUsers: [],
    });
    board.topicCount += 1;
  });

  saveDb(db);
}

const comments = [
  '沙发！支持一下。', '干货满满，收藏了。', '这个思路不错，学到了。', '同问，蹲一个答案。',
  '实测有效，感谢分享。', '哈哈，确实是这样。', '楼主分析得很到位。', '已 PM，麻烦看下私信。',
  '顶一个，让更多人看到。', '请问有更详细的教程吗？', '这个价格有点心动。', '建议加精！',
];

/* ================= auth ================= */
/* 首次请求时异步初始化数据（Vercel 下从 KV 加载，本地读文件），之后走内存缓存 */
let bootPromise = null;
function boot() {
  if (!bootPromise) bootPromise = (async () => {
    if (IS_VERCEL) {
      const loaded = await kvGet().catch(() => null);
      if (loaded) {
        kvLoadedOk = true;
        lastKvRefreshAt = Date.now();
        maxTopicsSeen = (loaded.topics || []).length;
        cacheDb = loaded;
      } else {
        /* KV 读不到：只在内存里用种子数据顶着看，绝不回写（kvSet 护栏会拦） */
        console.error('KV load failed at boot: serving seed data in-memory only, writes to KV are blocked');
        cacheDb = emptyDb();
      }
      seed(cacheDb);
      migrate(cacheDb);
      if (kvLoadedOk) await kvSet(cacheDb);
    } else {
      ensureDb();
      const db = loadDb();
      seed(db);
      migrate(db);
      saveDb(db);
    }
  })();
  return bootPromise;
}
app.use((req, res, next) => { boot().then(() => next()).catch(e => { console.error('boot failed:', e); next(); }); });

function authMiddleware(req, res, next) {
  req.user = null; req.token = null;
  const token = req.signedCookies?.forum_session;
  if (!token) return next();
  const resolve = () => {
    const db = loadDb();
    const s = db && db.sessions[token];
    if (s && new Date(s.expiresAt) > new Date()) {
      const u = (db.users || []).find(x => x.id === s.userId) || null;
      if (u && !u.banned) { req.user = u; req.token = token; }
    }
    next();
  };
  const db = loadDb();
  if (db && db.sessions && db.sessions[token]) return resolve();
  // 缓存未命中：可能该会话写在了其他 serverless 实例，回源 KV 重载一次
  if (IS_VERCEL) {
    kvGetThrottled(20000).then(kvdb => { if (kvdb) cacheDb = kvdb; resolve(); }).catch(() => resolve());
  } else resolve();
}
app.use(authMiddleware);
function requireAuth(req, res, next) { if (!req.user) return res.status(401).json({ error: '请先登录' }); next(); }
/* 角色等级：owner(站长) 2 > admin(管理员) 1 > user 0 */
function roleLevel(r) { return r === 'owner' ? 2 : r === 'admin' ? 1 : 0; }
const STAFF_ROLES = ['admin', 'owner'];
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (!STAFF_ROLES.includes(req.user.role)) return res.status(403).json({ error: '无管理员权限' });
  next();
}
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅站长可执行此操作' });
  next();
}
function userPublic(u) {
  if (!u) return null;
  const lv = userLevel(u);
  return {
    id: u.id, username: u.username, name: u.name, avatar: u.avatar, trustLevel: u.trustLevel, role: u.role,
    coins: u.coins || 0, lastCheckin: u.lastCheckin || '',
    bio: u.bio || '', signature: u.signature || '', readme: u.readme || '',
    contacts: u.contacts || defaultProfile().contacts,
    preferences: u.preferences || defaultProfile().preferences,
    blocked: u.blocked || [],
    exp: lv.exp, level: lv.level, levelTitle: lv.levelTitle, nextExp: lv.nextExp, levelProgress: lv.progress,
    badges: u.badges || [], title: u.title || '', titles: u.titles || [], titleExpireAt: u.titleExpireAt || null,
    achievements: u.achievements || [], checkinCount: u.checkinCount || 0,
    followingCount: (u.following || []).length,
  };
}

/* ================= helpers ================= */
function boardById(db, id) { return db.boards.find(b => b.id === id); }
function boardBySlug(db, slug) { return db.boards.find(b => b.slug === slug); }

/* TG 评论者专属头像：按名字哈希定色 + 首字，同名同头像、不同人不同样 */
function tgAvatarUri(name) {
  const s = String(name || 'TG用户');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const ch = ([...s.trim()][0] || 'T').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='14' fill='hsl(${hue},55%,45%)'/><text x='32' y='43' font-size='30' text-anchor='middle' fill='#ffffff' font-family='sans-serif'>${ch}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function enrichTopic(t, db, opts = {}) {
  const board = boardById(db, t.boardId);
  const author = db.users.find(u => u.id === t.userId);
  const lastPost = t.posts[t.posts.length - 1];
  const lastReply = lastPost && lastPost.postNumber > 1 ? db.users.find(u => u.id === lastPost.userId) : null;
  const obj = {
    id: t.id, userId: t.userId, title: t.title, slug: t.slug, excerpt: (t.posts[0]?.content || '').slice(0, 120),
    board: board ? { id: board.id, name: board.name, slug: board.slug, color: board.color } : null,
    author: userPublic(author), createdAt: t.createdAt, bumpedAt: t.bumpedAt,
    viewCount: t.viewCount, replyCount: t.replyCount, likeCount: t.likeCount, dislikeCount: t.dislikeCount || 0,
    favoriteCount: t.favoriteCount || 0, tags: t.tags || [], pinned: t.pinned, recommended: t.recommended,
    closed: t.closed, price: t.price || 0, bounty: t.bounty || 0, bestReplyId: t.bestReplyId || null,
    prefix: t.prefix || '', minLevel: t.minLevel || 1, slowMode: t.slowMode || 0,
    poll: t.poll ? {
      question: t.poll.question, multi: t.poll.multi,
      options: opts.withPosts ? t.poll.options.map((o, i) => ({ text: o.text, votes: o.votes.length, ratio: t.poll.voters.length ? Math.round(o.votes.length / t.poll.voters.length * 100) : 0, myPick: opts.userId ? o.votes.includes(opts.userId) : false })) : undefined,
      total: (t.poll.voters || []).length, myVote: opts.userId ? (t.poll.voters || []).findIndex(v => v === opts.userId) : -1,
    } : null,
    likedByMe: !!opts.userId && (t.likedUsers || []).includes(opts.userId),
    status: t.status || 'published', anonymous: !!t.anonymous, tgSubmitter: t.tgSubmitter || '',
    dislikedByMe: !!opts.userId && (t.dislikedUsers || []).includes(opts.userId),
    reactions: (() => { const st = {}; for (const e of ['❤️','😂','😮','😢','👏','🔥']) st[e] = { count: ((t.reactions || {})[e] || []).length, mine: !!opts.userId && ((t.reactions || {})[e] || []).includes(opts.userId) }; return st; })(),
    lastReply: lastReply ? { username: lastReply.username, name: lastPost.authorName || lastReply.name, avatar: lastPost.authorName ? tgAvatarUri(lastPost.authorName) : lastReply.avatar, at: lastPost.createdAt } : null,
  };
  if (opts.withPosts) obj.posts = t.posts.map(p => {
    const au = userPublic(db.users.find(u => u.id === p.userId));
    /* 镜像评论显示原作者名 + 专属头像，不挂机器人名下（用户定） */
    return { ...p, author: p.authorName && au ? { ...au, name: p.authorName, avatar: tgAvatarUri(p.authorName) } : au, likedByMe: !!opts.userId && (p.likedUsers || []).includes(opts.userId) };
  });
  if (t.anonymous && obj.author) obj.author = { ...obj.author, name: '匿名', username: 'anonymous' };
  return obj;
}

/* ================= 限流（防爆破 / 防刷帖） ================= */
/* 内存桶限流：Serverless 下按实例生效，可挡常规单点刷请求 */
const rlStore = new Map();
function rateLimit(name, { windowMs, max, byUser }) {
  return (req, res, next) => {
    const who = (byUser && req.user) ? 'u:' + req.user.id
      : 'ip:' + ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '?');
    const nowMs = Date.now();
    if (rlStore.size > 2000) for (const [k, v] of rlStore) if (v.reset <= nowMs) rlStore.delete(k);
    const k = name + '|' + who;
    let b = rlStore.get(k);
    if (!b || b.reset <= nowMs) b = { count: 0, reset: nowMs + windowMs };
    b.count++;
    rlStore.set(k, b);
    if (b.count > max) return res.status(429).json({ error: '操作太频繁，请稍后再试' });
    next();
  };
}
const rlAuth = rateLimit('auth', { windowMs: 10 * 60 * 1000, max: 30 });                 // 登录/注册：同 IP 10 分钟 30 次
const rlTopic = rateLimit('topic', { windowMs: 60 * 60 * 1000, max: 30, byUser: true });  // 发帖：每用户每小时 30 帖
const rlReply = rateLimit('reply', { windowMs: 60 * 60 * 1000, max: 200, byUser: true }); // 回复：每用户每小时 200 条

/* ================= auth API ================= */
app.post('/api/auth/register', rlAuth, async (req, res) => {
  try {
    const { username, email, password, name, code } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: '缺少必填字段' });
    const db = loadDb();
    if (db.users.find(u => u.username === username || u.email === email)) return res.status(409).json({ error: '用户名或邮箱已存在' });
    // 邀请注册制：必须持有管理员发放的注册码；开放注册窗口期内免码（总控「注册码中心」开启）
    const regOpen = !!((db.settings || {}).regOpenUntil && Date.now() < new Date(db.settings.regOpenUntil).getTime());
    const regCode = String(code || '').trim().toUpperCase();
    let rc = null;
    if (regCode) {
      rc = (db.regCodes || []).find(c => c.code.toUpperCase() === regCode);
      if (!rc) return res.status(400).json({ error: '邀请码无效，请检查后重试' });
      /* 兼容老单次码 + 新多次邀请码 */
      const maxUses = Math.max(1, rc.maxUses || 1);
      const usedCount = rc.usedCount || (rc.usedBy ? 1 : 0);
      if (usedCount >= maxUses) return res.status(400).json({ error: '该邀请码已用完，换一个试试' });
      if (rc.expiresAt && new Date(rc.expiresAt) < new Date()) return res.status(400).json({ error: '该邀请码已过期' });
    } else if (!regOpen) {
      return res.status(400).json({ error: '注册需要注册码，请联系管理员获取' });
    }
    const profile = defaultProfile();
    const user = { id: id('u'), username, email, name: name || username, passwordHash: hashPw(password), avatar: null, createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 10, checkinCoins: 0, lastCheckin: '', favorites: [], banned: false, ...profile };
    db.users.push(user);
    if (rc) {
      rc.usedBy = rc.usedBy || user.id;
      rc.usedAt = nowIso();
      rc.usedCount = (rc.usedCount || 0) + 1;
      rc.usedByList = rc.usedByList || [];
      rc.usedByList.push(user.id);
      user.invitedBy = rc.createdBy || null;
      /* 邀请人奖励 +20 鸡腿 */
      if (rc.createdBy) {
        const inviter = db.users.find(u => u.id === rc.createdBy);
        if (inviter) {
          inviter.coins = (inviter.coins || 0) + 20;
          addNotification(db, inviter.id, 'invite_reward', { fromName: user.name || user.username, coins: 20 });
        }
      }
    }
    const token = newSessionToken();
    db.sessions[token] = { userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
    saveDb(db);
    await flushNow();
    notify.notifyAll(db, 'newUser', { username: user.username, name: user.name || user.username }).catch(() => {});
    res.cookie('forum_session', token, { signed: true, httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax', secure: IS_VERCEL });
    res.json({ user: userPublic(user) });
  } catch (e) {
    res.status(500).json({ error: '注册失败：' + e.message });
  }
});

/* 开放注册窗口：regOpenUntil 前注册免码 */
function regWindowState(db) {
  const until = (db.settings || {}).regOpenUntil || null;
  return { open: !!(until && Date.now() < new Date(until).getTime()), until };
}
async function applyRegWindow(body) {
  const db = loadDb();
  db.settings = db.settings || {};
  if (body && body.off) db.settings.regOpenUntil = null;
  else {
    const h = Math.min(Math.max(parseFloat(body && body.hours) || 24, 0.05), 24 * 90);
    db.settings.regOpenUntil = new Date(Date.now() + h * 3600 * 1000).toISOString();
  }
  saveDb(db);
  await flushNow();
  return regWindowState(db);
}
app.get('/api/auth/reg-status', (req, res) => { res.json(regWindowState(loadDb())); });
app.get('/api/admin/reg-window', requireAdmin, (req, res) => { res.json(regWindowState(loadDb())); });
app.post('/api/admin/reg-window', requireAdmin, async (req, res) => {
  try { res.json(await applyRegWindow(req.body || {})); }
  catch (e) { res.status(500).json({ error: '设置失败：' + e.message }); }
});
app.post('/api/integrations/reg-window', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const ok = secret && (req.headers['x-sync-secret'] === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  try { res.json(await applyRegWindow(req.body || {})); }
  catch (e) { res.status(500).json({ error: '设置失败：' + e.message }); }
});

app.post('/api/auth/login', rlAuth, async (req, res) => {
  try {
    const { account, password } = req.body || {};
    const db = loadDb();
    const user = db.users.find(u => u.username === account || u.email === account);
    if (!user || !checkPw(password, user.passwordHash)) return res.status(401).json({ error: '账号或密码错误' });
    if (user.banned) return res.status(403).json({ error: '账号已被封禁，如有疑问请联系管理员' });
    const token = newSessionToken();
    db.sessions[token] = { userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
    saveDb(db);
    await flushNow();
    res.cookie('forum_session', token, { signed: true, httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax', secure: IS_VERCEL });
    res.json({ user: userPublic(user) });
  } catch (e) {
    res.status(500).json({ error: '登录失败：' + e.message });
  }
});

/* 站内改密（2026-10-04 升级）：验旧密→换哈希→踢掉其他设备的会话，当前设备保持登录 */
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写当前密码和新密码' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: '新密码不能和当前密码相同' });
    const db = loadDb();
    const me = db.users.find(u => u.id === req.user.id);
    if (!me) return res.status(404).json({ error: '用户不存在' });
    if (!checkPw(currentPassword, me.passwordHash)) return res.status(401).json({ error: '当前密码不正确' });
    me.passwordHash = hashPw(String(newPassword));
    let kicked = 0;
    for (const tk of Object.keys(db.sessions || {})) {
      if (tk !== req.token && db.sessions[tk].userId === me.id) { delete db.sessions[tk]; kicked++; }
    }
    saveDb(db);
    await flushNow();
    res.json({ ok: true, kicked });
  } catch (e) {
    res.status(500).json({ error: '修改失败：' + e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const db = loadDb();
    if (req.token) delete db.sessions[req.token];
    saveDb(db);
    await flushNow();
    res.clearCookie('forum_session');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.get('/api/auth/me', (req, res) => res.json({ user: userPublic(req.user) }));

/* ================= settings API ================= */
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    user: userPublic(req.user),
    boards: loadDb().boards.map(b => ({ id: b.id, name: b.name, slug: b.slug, color: b.color })),
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const body = req.body || {};
  if (body.name !== undefined) user.name = String(body.name || user.username).slice(0, 30);
  if (body.avatar !== undefined) user.avatar = String(body.avatar || '').slice(0, 500) || null;
  if (body.bio !== undefined) user.bio = String(body.bio || '').slice(0, 160);
  if (body.signature !== undefined) user.signature = String(body.signature || '').slice(0, 500);
  if (body.readme !== undefined) user.readme = String(body.readme || '').slice(0, 5000);
  if (body.contacts && typeof body.contacts === 'object') {
    user.contacts = { ...(user.contacts || defaultProfile().contacts), ...body.contacts };
  }
  if (body.preferences && typeof body.preferences === 'object') {
    user.preferences = { ...(user.preferences || defaultProfile().preferences), ...body.preferences };
  }
  if (body.blocked && Array.isArray(body.blocked)) {
    user.blocked = body.blocked.slice(0, 100).map(x => String(x).slice(0, 30));
  }
  saveDb(db);
  res.json({ user: userPublic(user) });
});

/* ================= boards & tags ================= */
app.get('/api/boards', (req, res) => {
  const boards = loadDb().boards.slice().sort((a, b) => (a.weight || 0) - (b.weight || 0));
  res.json(boards);
});

app.get('/api/tags', (req, res) => res.json(loadDb().tags));

/* ================= topics ================= */
/* 📡 RSS 订阅：最新 30 个主题 */
app.get('/rss.xml', (req, res) => {
  const db = loadDb();
  const base = 'https://bbs.8818618.xyz';
  const xmlEsc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 摘要：先把存量内容里的 HTML 实体还原，再剥掉 Markdown/HTML，压成纯文本单行，避免阅读器里出现 &#x2F; 之类乱码
  const decodeEnt = s => String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e] || m;
  });
  const excerpt = s => decodeEnt(String(s || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 280);
  const items = db.topics.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30).map(t => {
    const author = db.users.find(u => u.id === t.userId);
    const link = `${base}/post/${t.slug || t.id}`;
    return `<item><title>${xmlEsc(t.title)}</title><link>${xmlEsc(encodeURI(link))}</link><guid>${xmlEsc(encodeURI(link))}</guid>`
      + `<dc:creator>${xmlEsc(author ? author.name : '')}</dc:creator>`
      + `<pubDate>${new Date(t.createdAt).toUTCString()}</pubDate>`
      + `<description>${xmlEsc(excerpt(t.posts[0]?.content || ''))}</description></item>`;
  }).join('');
  res.type('application/rss+xml; charset=utf-8').send(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>`
    + `<title>马老师社区 - 最新帖子</title><link>${base}</link><description>马老师社区最新主题订阅</description>`
    + `<language>zh-CN</language>${items}</channel></rss>`);
});
/* 🗺️ sitemap.xml：搜索引擎收录（全部游客可见的 LV1 帖合并在一个 sitemap；1 小时缓存）
   loc 必须百分号编码（中文裸写不符合 sitemap 规范，校验器/部分引擎会拒）；
   带 XSL 样式表，浏览器打开渲染成表格而不是一坨 XML 源码 */
let sitemapCache = { at: 0, xml: '' };
app.get('/sitemap.xml', (req, res) => {
  if (Date.now() - sitemapCache.at < 3600000 && sitemapCache.xml) {
    return res.type('application/xml; charset=utf-8').send(sitemapCache.xml);
  }
  const db = loadDb();
  const base = 'https://bbs.8818618.xyz';
  const xmlEsc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const urls = [
    `<url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/boards</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${base}/trends</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`,
    `<url><loc>${base}/guide</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
    `<url><loc>${base}/lucky</loc><changefreq>daily</changefreq><priority>0.5</priority></url>`,
  ];
  db.topics.slice().sort((a, b) => new Date(b.bumpedAt || b.createdAt) - new Date(a.bumpedAt || a.createdAt))
    .filter(t => (t.minLevel || 1) <= 1 && !t.deleted)
    .forEach(t => {
      const lastmod = new Date(t.bumpedAt || t.createdAt).toISOString().slice(0, 10);
      urls.push(`<url><loc>${base}/post/${encodeURIComponent(t.slug || t.id)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`);
    });
  sitemapCache = { at: Date.now(), xml: `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>` };
  res.type('application/xml; charset=utf-8').send(sitemapCache.xml);
});
/* 🔥 24小时热文榜（虎扑式）：24h 内有更新的帖子按热度排序 */
app.get('/api/hot24', (req, res) => {
  const db = loadDb();
  const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 1));
  const since = Date.now() - days * 24 * 3600000;
  const hot = db.topics
    .filter(t => (!t.status || t.status === 'published') && new Date(t.bumpedAt || t.createdAt).getTime() > since)
    .map(t => ({ t, score: (t.likeCount || 0) * 3 + (t.replyCount || 0) * 2 + (t.viewCount || 0) * 0.1 + (t.favoriteCount || 0) * 2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map(({ t }) => ({ id: t.id, slug: t.slug, title: t.title, prefix: t.prefix || '', replyCount: t.replyCount, likeCount: t.likeCount || 0, viewCount: t.viewCount || 0, boardName: (boardById(db, t.boardId) || {}).name || '', boardColor: (boardById(db, t.boardId) || {}).color || '#999', bumpedAt: t.bumpedAt }));
  res.json({ list: hot, days });
});
app.get('/api/topics', (req, res) => {
  const db = loadDb();
  let topics = db.topics.slice();
  /* 待审核/已拒绝的帖子只对作者本人和管理员可见 */
  topics = topics.filter(t => !t.status || t.status === 'published' || (req.user && (t.userId === req.user.id || STAFF_ROLES.includes(req.user.role))));
  const { board, sort, tag, mine, following } = req.query;
  if (following) {
    if (!req.user) topics = [];
    else { const f = new Set(req.user.following || []); topics = topics.filter(t => f.has(t.userId)); }
  }
  if (board) { const b = boardBySlug(db, board); if (b) topics = topics.filter(t => t.boardId === b.id); }
  if (tag) topics = topics.filter(t => (t.tags || []).includes(tag));
  if (req.query.recommended) topics = topics.filter(t => t.recommended);
  if (mine && req.user) topics = topics.filter(t => t.userId === req.user.id);
  if (sort === 'hot') topics.sort((a, b) => (b.viewCount + b.replyCount * 5) - (a.viewCount + a.replyCount * 5));
  else if (sort === 'views') topics.sort((a, b) => b.viewCount - a.viewCount);
  else if (sort === 'new') topics.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else topics.sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  topics.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  /* 分页：默认每页 30 条，首页/分类/标签/我的共用 */
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 30));
  const total = topics.length;
  const rows = topics.slice((page - 1) * pageSize, page * pageSize);
  res.json({ list: rows.map(t => enrichTopic(t, db, { userId: req.user && req.user.id })), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
});

app.get('/api/topics/recommended', (req, res) => {
  const db = loadDb();
  const list = db.topics.filter(t => t.recommended).sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt)).slice(0, 5);
  res.json(list.map(t => enrichTopic(t, db)));
});

app.get('/api/topics/:id', (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.status && topic.status !== 'published' && !(req.user && (topic.userId === req.user.id || STAFF_ROLES.includes(req.user.role)))) {
    return res.status(404).json({ error: '帖子不存在或待审核' });
  }
  /* 阅读等级门槛：LV1 = 所有人可见（含游客）；LV2+ 才需要对应等级 */
  const need = Math.max(1, topic.minLevel || 1);
  const viewerLv = req.user ? userLevel(req.user).level : 0;
  if (need > 1 && viewerLv < need) {
    return res.status(403).json({ error: `该帖子需要 LV${need} 及以上才能查看`, needLevel: need, myLevel: viewerLv });
  }
  topic.viewCount += 1;
  saveDb(db);
  const enriched = enrichTopic(topic, db, { withPosts: true, userId: req.user && req.user.id });
  if (req.user) enriched.favorited = (topic.favoritedUsers || []).includes(req.user.id);
  res.json(enriched);
});

app.post('/api/topics', requireAuth, rlTopic, (req, res) => {
  const { title, content, boardId, tags = [], price, poll, bounty, prefix, minLevel, anonymous } = req.body || {};
  if (!title || !content || !boardId) return res.status(400).json({ error: '缺少标题、内容或板块' });
  const db = loadDb();
  const board = boardById(db, boardId);
  if (!board) return res.status(404).json({ error: '板块不存在' });
  /* 电报树洞：普通用户投稿先进待审核（管理员/站长直发），可匿名；审核通过后同步电报频道 */
  const isReviewBoard = board.slug === 'tg-treehole';
  const needsReview = isReviewBoard && !STAFF_ROLES.includes(req.user.role);
  const topicId = id('tp');
  const time = nowIso();
  /* 悬赏：发帖时从自己鸡腿扣除悬赏金冻结，采纳回复后转给答主 */
  let bountyAmount = Math.max(0, Math.floor(Number(bounty) || 0));
  if (bountyAmount > 0) {
    if ((req.user.coins || 0) < bountyAmount) return res.status(400).json({ error: '鸡腿不足，无法发起悬赏' });
    req.user.coins -= bountyAmount;
  }
  /* 投票：{ question, options: [text...], multi } */
  let pollObj = null;
  if (poll && poll.question && Array.isArray(poll.options) && poll.options.length >= 2 && poll.options.length <= 10) {
    pollObj = {
      question: String(poll.question).slice(0, 100),
      multi: !!poll.multi,
      options: poll.options.slice(0, 10).map(o => ({ text: String(o).slice(0, 50), votes: [] })),
      voters: [],
    };
    unlockAch(db, req.user.id, 'poll');
  }
  /* 阅读权限：LV1=所有人可见（默认），LV2-LV10=对应等级及以上可看 */
  const ml = Math.max(1, Math.min(10, Math.floor(Number(minLevel) || 1)));
  const topic = {
    id: topicId, title, slug: slugify(title), boardId: board.id, userId: req.user.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: Array.isArray(tags) ? tags.slice(0, 5) : [], posts: [{ id: id('p'), topicId, userId: req.user.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
    pinned: false, recommended: false, price: Number(price) || 0, closed: false, minLevel: ml,
    poll: pollObj, bounty: bountyAmount, bestReplyId: null,
    prefix: String(prefix || '').slice(0, 8),
    status: needsReview ? 'pending' : 'published',
    anonymous: isReviewBoard && !!anonymous,
  };
  db.topics.push(topic);
  if (!needsReview) board.topicCount += 1;
  addExp(db, req.user, 5);
  unlockAch(db, req.user.id, 'first-topic');
  checkCumulativeAch(db, req.user);
  /* 发帖时 @提及通知（尊重被提及者 notifyMention 偏好开关） */
  scanMentions(db, content, req.user.id).forEach(u => {
    if ((u.preferences && u.preferences.notifyMention) !== false) addNotification(db, u.id, 'mention', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, content: content.slice(0, 80) });
  });
  saveDb(db);
  if (!needsReview) notify.notifyAll(db, 'newTopic', { topicId: topic.id, title: topic.title, board: board.name, username: req.user.username, name: req.user.name || req.user.username }).catch(() => {});
  res.status(201).json(enrichTopic(topic, db));
});

/* 聊天动态同步：聊天站发动态时自动在「聊天动态」板块开帖（共享密钥鉴权，密钥走环境变量 CHAT_SYNC_SECRET） */
app.post('/api/integrations/moments', async (req, res) => {
  const secret = process.env.CHAT_SYNC_SECRET || '';
  if (!secret) return res.status(503).json({ error: '同步未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const { authorName, content, imageUrl, boardSlug } = req.body || {};
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: '内容为空' });
  const db = loadDb();
  let board = null;
  const wantedSlug = String(boardSlug || '').trim().slice(0, 60);
  if (wantedSlug && wantedSlug !== 'moments') {
    board = db.boards.find(b => b.slug === wantedSlug) || null;
  }
  if (!board) {
    board = db.boards.find(b => b.slug === 'moments');
  }
  if (!board) {
    board = { id: id('b'), name: '聊天动态', slug: 'moments', color: '#2fa39b', description: '马老师专属聊天里发布的动态，自动同步到这里', topicCount: 0 };
    db.boards.push(board);
  }
  let bot = db.users.find(u => u.username === 'momentsbot');
  if (!bot) {
    bot = { id: id('u'), username: 'momentsbot', email: 'momentsbot@localhost', name: '聊天动态同步', passwordHash: hashPw('sync-' + Math.random().toString(36).slice(2)), avatar: null, createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 0, checkinCoins: 0, lastCheckin: '', favorites: [], banned: false, ...defaultProfile() };
    db.users.push(bot);
  }
  const time = nowIso();
  const author = String(authorName || '聊天用户').slice(0, 30);
  const title = text.replace(/\s+/g, ' ').slice(0, 28) || '一条动态';
  const body = `【来自「马老师专属聊天」的动态】作者：${author}\n\n${text}${imageUrl ? `\n\n![](${String(imageUrl).slice(0, 500)})` : ''}`;
  const topic = {
    id: id('tp'), title, slug: slugify(title), boardId: board.id, userId: bot.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: ['聊天动态'], posts: [], pinned: false, recommended: false, price: 0, closed: false, minLevel: 1,
    poll: null, bounty: 0, bestReplyId: null, prefix: '',
  };
  topic.posts.push({ id: id('p'), topicId: topic.id, userId: bot.id, content: body, createdAt: time, likeCount: 0, postNumber: 1 });
  db.topics.push(topic);
  board.topicCount += 1;
  saveDb(db);
  await flushNow();
  res.status(201).json({ ok: true, topicId: topic.id });
});

app.post('/api/topics/:id/replies', requireAuth, rlReply, (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: '回复内容不能为空' });
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.closed) return res.status(403).json({ error: '帖子已关闭' });
  /* 慢速模式：限制每人回帖间隔（版主/管理员不受限） */
  const slowSec = topic.slowMode || 0;
  if (slowSec > 0 && !isStaff(req.user)) {
    const myPosts = topic.posts.filter(x => x.userId === req.user.id);
    const last = myPosts.length ? myPosts[myPosts.length - 1] : null;
    if (last) {
      const waitMs = slowSec * 1000 - (Date.now() - new Date(last.createdAt).getTime());
      if (waitMs > 0) return res.status(429).json({ error: `慢速模式：请 ${Math.ceil(waitMs / 1000)} 秒后再回复`, retryAfter: Math.ceil(waitMs / 1000) });
    }
  }
  const time = nowIso();
  const post = { id: id('p'), topicId: topic.id, userId: req.user.id, content, createdAt: time, likeCount: 0, postNumber: topic.posts.length + 1 };
  topic.posts.push(post);
  topic.replyCount += 1;
  topic.bumpedAt = time;
  if (req.user.lastReplyDate !== todayStr()) { req.user.lastReplyDate = todayStr(); }
  addExp(db, req.user, 2);
  unlockAch(db, req.user.id, 'first-reply');
  /* 站内通知：楼主收到回复提醒（尊重楼主 notifyReply 偏好开关） */
  const opUser = db.users.find(u => u.id === topic.posts[0].userId);
  if (opUser && opUser.id !== req.user.id && (opUser.preferences && opUser.preferences.notifyReply) !== false) {
    addNotification(db, opUser.id, 'reply', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, content: content.slice(0, 80) });
  }
  /* 站内通知：@提及（排除楼主与本人，尊重被提及者 notifyMention 偏好开关） */
  scanMentions(db, content, req.user.id).forEach(u => {
    if (u.id !== topic.posts[0].userId && (u.preferences && u.preferences.notifyMention) !== false) addNotification(db, u.id, 'mention', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, content: content.slice(0, 80) });
  });
  saveDb(db);
  notify.notifyAll(db, 'newReply', { topicId: topic.id, title: topic.title, username: req.user.username, name: req.user.name || req.user.username }).catch(() => {});
  res.status(201).json({ ...post, author: userPublic(req.user) });
});

/* ================= 公司避雷库 v9：全国百万级 SQLite（本地）/ 静态名录（Vercel 降级） ================= */
/* 数据：data/companies.db（由 build_companies_db.js 从公开工商数据构建，1978-2019，31 省 1000 万+ 条）。
 * 本地模式：名录走 SQLite（FTS5 trigram 全文搜索 + 索引），评价仍存主库 db.companyReviews。
 * 降级模式（无 SQLite / Vercel）：回退旧 3 万条静态名录 public/data/companies.json。 */
const COMPANIES_DB_FILE = path.join(__dirname, 'data', 'companies.db');
const NATIONAL_PROVINCES = ['重庆', '北京', '天津', '上海', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '内蒙古', '广西', '西藏', '宁夏', '新疆', '台湾'];
let companiesDb = null;
function getCompaniesDb() {
  if (companiesDb !== null) return companiesDb;
  companiesDb = undefined;
  if (!DatabaseSync) return undefined;
  try {
    if (fs.existsSync(COMPANIES_DB_FILE)) {
      companiesDb = new DatabaseSync(COMPANIES_DB_FILE, { readOnly: true });
    }
  } catch (e) {
    console.error('公司库 SQLite 打开失败（降级为静态名录）:', e.message);
    companiesDb = undefined;
  }
  return companiesDb;
}
function hasNationalCatalog() { return !!getCompaniesDb(); }

/* SQLite 名录 → 对外行（评价独立 enrich，保证行尽量轻量） */
function sqlCompanyRow(row) {
  return {
    id: String(row.id), name: row.name, province: row.province || '其他', city: row.city || row.province || '',
    address: row.address || '', industry: row.industry || '其他', tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    regYear: row.reg_year || null, capital: row.capital || '', legal: row.legal || '', source: 'national',
  };
}
/* 行 + 评价 → 完整视图（含评分/等级） */
function companyView2(db, row) {
  const base = sqlCompanyRow(row);
  const rv = (db.companyReviews || {})[base.id];
  if (!rv || !rv.length) return { ...base, reviewCount: 0, avg: 0, level: 'pending', label: '待评价' };
  const sorted = rv.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { level, label, avg } = companyLevel(rv);
  return { ...base, reviewCount: rv.length, avg, level, label, reviews: sorted };
}

/* ---- SQLite 列表查询：筛选 / 搜索 / 排序 / 分页；重庆默认置顶 ---- */
function sqlListCompanies(db, { q, province, city, industry, tag, sort, page, pageSize }) {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  const where = [];
  const params = [];
  if (province) { where.push('c.province = ?'); params.push(province); }
  if (city) { where.push('c.city = ?'); params.push(city); }
  if (industry) { where.push('c.industry = ?'); params.push(industry); }
  if (tag) { where.push('c.tags LIKE ?'); params.push('%' + tag + '%'); }
  const qs = String(q || '').trim();
  let ftsJoin = '';
  if (qs) {
    if (qs.length >= 3) {
      ftsJoin = 'JOIN companies_fts f ON f.rowid = c.id';
      where.push('companies_fts MATCH ?');
      params.push('"' + qs.replace(/"/g, '""') + '"');
    } else {
      where.push('c.name LIKE ?');
      params.push(qs + '%');
    }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  /* 评价排序：只对有评价公司排序，其余重庆优先名称序垫底 */
  if (['rating', 'reviews', 'danger'].includes(sort)) {
    const reviewedIds = Object.keys(db.companyReviews || {}).map(Number).filter(Number.isInteger);
    if (reviewedIds.length) {
      const ph = reviewedIds.map(() => '?').join(',');
      const rows = sdb.prepare(`SELECT * FROM companies c ${ftsJoin} ${whereSql} AND c.id IN (${ph})`).all(...params, ...reviewedIds);
      let list = rows.map(r => companyView2(db, r));
      if (sort === 'rating') list.sort((a, b) => b.avg - a.avg || b.reviewCount - a.reviewCount);
      else if (sort === 'reviews') list.sort((a, b) => b.reviewCount - a.reviewCount);
      else list.sort((a, b) => (b.avg >= 4 ? 1 : 0) - (a.avg >= 4 ? 1 : 0) || b.avg - a.avg);
      const total = list.length;
      const pageStart = (page - 1) * pageSize;
      const slice = list.slice(pageStart, pageStart + pageSize);
      /* 无评价垫底部分：补足当前页 */
      if (slice.length < pageSize && total >= pageStart) {
        const need = pageSize - slice.length;
        const idsSql = reviewedIds.map(() => '?').join(',');
        const w = where.filter(x => !x.startsWith('c.id IN')).join(' AND ');
        const w2 = (w ? w + ' AND ' : '') + `c.id NOT IN (${idsSql})`;
        const order = "ORDER BY CASE WHEN c.province='重庆' THEN 0 ELSE 1 END, c.name LIMIT ? OFFSET ?";
        const p2 = [...params, ...reviewedIds, need, Math.max(0, pageStart - total)];
        const more = sdb.prepare(`SELECT * FROM companies c ${ftsJoin} WHERE ${w2} ${order}`).all(...p2).map(r => companyView2(db, r));
        slice.push(...more);
      }
      return { list: slice, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), via: 'sqlite' };
    }
  }
  const orderBy = sort === 'new' ? 'ORDER BY c.reg_year DESC, c.id DESC' : "ORDER BY CASE WHEN c.province='重庆' THEN 0 ELSE 1 END, c.name";
  const total = sdb.prepare(`SELECT COUNT(*) n FROM companies c ${ftsJoin} ${whereSql}`).get(...params).n;
  const rows = sdb.prepare(`SELECT * FROM companies c ${ftsJoin} ${whereSql} ${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  return { list: rows.map(r => companyView2(db, r)), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), via: 'sqlite' };
}

/* ---- SQLite 精确查找（id 或名称） ---- */
function sqlFindCompany(idOrName) {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  const key = String(idOrName).trim();
  const row = Number.isInteger(Number(key)) && String(Number(key)) === key
    ? sdb.prepare('SELECT * FROM companies WHERE id = ? LIMIT 1').get(Number(key))
    : sdb.prepare('SELECT * FROM companies WHERE name = ? LIMIT 1').get(key);
  return row || null;
}

/* ---- SQLite 聚合：行业 / 省份 / 标签 统计（带缓存，数据静态） ---- */
const _sqlCache = {};
function _cached(key, fn) {
  if (key in _sqlCache) return _sqlCache[key];
  const r = fn();
  _sqlCache[key] = r;
  return r;
}
function warmSqlCache() {
  if (!getCompaniesDb()) return;
  console.log('预热 SQLite 统计缓存...');
  try {
    _cached('stats', () => sqlStatsRaw());
    _cached('industries', () => sqlMetaIndustriesRaw());
    _cached('provinces', () => sqlMetaProvincesRaw());
    _cached('tags', () => sqlMetaTagsRaw());
    console.log('SQLite 统计缓存预热完成');
  } catch (e) { console.error('缓存预热失败:', e.message); }
}
function sqlMetaIndustriesRaw() {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  return sdb.prepare('SELECT industry name, COUNT(*) count FROM companies GROUP BY industry ORDER BY count DESC LIMIT 80').all();
}
function sqlMetaProvincesRaw() {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  return sdb.prepare("SELECT province name, COUNT(*) count FROM companies GROUP BY province ORDER BY CASE WHEN province='重庆' THEN 0 ELSE 1 END, count DESC").all();
}
function sqlMetaTagsRaw() {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  return sdb.prepare(`SELECT value tag, COUNT(*) count FROM companies, json_each('["' || replace(tags, ',', '","') || '"]') WHERE tags != '' GROUP BY value ORDER BY count DESC LIMIT 50`).all();
}
function sqlStatsRaw() {
  const sdb = getCompaniesDb();
  if (!sdb) return null;
  return {
    total: sdb.prepare('SELECT COUNT(*) n FROM companies').get().n,
    provinces: sdb.prepare('SELECT COUNT(DISTINCT province) n FROM companies').get().n,
    industries: sdb.prepare('SELECT COUNT(DISTINCT industry) n FROM companies').get().n,
    years: sdb.prepare('SELECT MIN(reg_year) min, MAX(reg_year) max FROM companies').get(),
    chongqing: sdb.prepare("SELECT COUNT(*) n FROM companies WHERE province='重庆'").get().n,
  };
}
function sqlMetaIndustries() { return _cached('industries', sqlMetaIndustriesRaw); }
function sqlMetaProvinces() { return _cached('provinces', sqlMetaProvincesRaw); }
function sqlMetaTags() { return _cached('tags', sqlMetaTagsRaw); }
function sqlStats() { return _cached('stats', sqlStatsRaw); }

/* 评价键迁移：旧 c-seed 键按名称映射到 SQLite 数字 id（一次性） */
function migrateCompanyReviews(db) {
  if (!hasNationalCatalog() || db.companyReviewMigrated) return;
  const sdb = getCompaniesDb();
  const byName = sdb.prepare('SELECT id FROM companies WHERE name = ? LIMIT 1');
  const reviews = db.companyReviews || {};
  let moved = 0;
  for (const key of Object.keys(reviews)) {
    if (/^c-seed-/.test(key)) {
      const oldName = (loadCompanyCatalog() || []).find(c => c.id === key);
      if (!oldName) continue;
      const row = byName.get(oldName.name);
      if (!row) continue;
      reviews[String(row.id)] = (reviews[String(row.id)] || []).concat(reviews[key]);
      delete reviews[key];
      moved++;
    }
  }
  if (moved) db.companyReviewMigrated = true;
}

/* ================= 公司避雷库（公开） ================= */
/* ---- 远程公司库代理模式 ----
 * 1.86GB 的 SQLite 全库（585 万家）无法塞进 Vercel Serverless（250MB 上限）。
 * 在一台常驻机器上跑 companies-api/companies-api.js，然后设环境变量：
 *   COMPANIES_API_URL=https://公司库机器:3457  [COMPANIES_API_KEY=xxx]
 * 论坛的公司搜索/详情/meta/统计即走远程全库；未设置时走原有逻辑（本地 SQLite → 静态名录）。
 * 评价数据仍存论坛主库（KV/db.json），远程只提供只读名录。 */
const COMPANIES_API_URL = (process.env.COMPANIES_API_URL || '').replace(/\/+$/, '');
const COMPANIES_API_KEY = process.env.COMPANIES_API_KEY || '';
const _remoteCompanyCache = new Map(); /* id/name -> 行，进程级缓存 */
async function companiesApi(path, timeoutMs = 12000) {
  if (!COMPANIES_API_URL) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(COMPANIES_API_URL + path, {
      headers: COMPANIES_API_KEY ? { 'x-api-key': COMPANIES_API_KEY } : {},
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}
function _cacheRemoteRow(r) {
  if (!r || !r.id) return;
  _remoteCompanyCache.set(String(r.id), r);
  if (r.name) _remoteCompanyCache.set(r.name, r);
  if (_remoteCompanyCache.size > 4000) _remoteCompanyCache.delete(_remoteCompanyCache.keys().next().value);
}
async function ensureRemoteCompany(idOrName) {
  if (!COMPANIES_API_URL || idOrName === undefined || idOrName === null) return null;
  const key = String(idOrName);
  if (_remoteCompanyCache.has(key)) return _remoteCompanyCache.get(key);
  const r = await companiesApi('/companies/' + encodeURIComponent(key));
  if (r && r.id) { _cacheRemoteRow(r); return r; }
  return null;
}
async function ensureRemoteCompanies(ids) {
  if (!COMPANIES_API_URL || !ids.length) return;
  const miss = [...new Set(ids.map(String))].filter(k => /^\d+$/.test(k) && !_remoteCompanyCache.has(k)).slice(0, 500);
  if (!miss.length) return;
  const rows = await companiesApi('/companies/batch?ids=' + miss.join(','));
  (rows || []).forEach(_cacheRemoteRow);
}
/* 远程行 + 本地评价 → 完整视图 */
function remoteCompanyView(db, r) {
  const rv = (db.companyReviews || {})[String(r.id)];
  if (!rv || !rv.length) return { ...r, reviewCount: 0, avg: 0, level: 'pending', label: '待评价' };
  const sorted = rv.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { level, label, avg } = companyLevel(rv);
  return { ...r, reviewCount: rv.length, avg, level, label, reviews: sorted };
}
/* 远程列表查询（含评价排序的两段式逻辑，与 SQLite 版一致） */
async function remoteListCompanies(db, { q, province, city, industry, tag, sort, page, pageSize }) {
  if (!COMPANIES_API_URL) return null;
  const reviewedIds = Object.keys(db.companyReviews || {}).filter(k => /^\d+$/.test(k));
  const toParams = (extra) => new URLSearchParams({
    q: q || '', province: province || '', city: city || '', industry: industry || '',
    tag: tag || '', sort: sort || '', page: String(page), pageSize: String(pageSize), ...extra,
  }).toString();
  if (['rating', 'reviews', 'danger'].includes(sort) && reviewedIds.length) {
    const rows = await companiesApi('/companies/batch?ids=' + reviewedIds.slice(0, 500).join(','));
    if (rows) {
      rows.forEach(_cacheRemoteRow);
      const qs = String(q || '').trim().toLowerCase();
      let list = rows.filter(r =>
        (!qs || String(r.name).toLowerCase().includes(qs)) &&
        (!province || r.province === province) &&
        (!city || r.city === city) &&
        (!industry || r.industry === industry) &&
        (!tag || (r.tags || []).includes(tag))
      ).map(r => remoteCompanyView(db, r));
      if (sort === 'rating') list.sort((a, b) => b.avg - a.avg || b.reviewCount - a.reviewCount);
      else if (sort === 'reviews') list.sort((a, b) => b.reviewCount - a.reviewCount);
      else list.sort((a, b) => (b.avg >= 4 ? 1 : 0) - (a.avg >= 4 ? 1 : 0) || b.avg - a.avg);
      const total = list.length;
      const pageStart = (page - 1) * pageSize;
      const slice = list.slice(pageStart, pageStart + pageSize);
      if (slice.length < pageSize && total >= pageStart) {
        const need = pageSize - slice.length;
        const fillPage = Math.floor(Math.max(0, pageStart - total) / need) + 1;
        const more = await companiesApi('/companies?' + toParams({ page: String(fillPage), pageSize: String(need), excludeIds: reviewedIds.slice(0, 500).join(',') }));
        (more && more.list || []).forEach(r => slice.push(remoteCompanyView(db, r)));
      }
      return { list: slice, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), via: 'companies-api' };
    }
  }
  const r = await companiesApi('/companies?' + toParams({}));
  if (!r) return null;
  r.list = (r.list || []).map(x => remoteCompanyView(db, x));
  /* 合并用户/管理员添加的公司（extraCompanies）：否则审核通过后在远程模式下永远显示不出来。
   * 仅第 1 页置顶展示，命中筛选条件的才合并。 */
  if (page === 1 && Array.isArray(db.extraCompanies) && db.extraCompanies.length) {
    const qs = String(q || '').trim().toLowerCase();
    const remoteNames = new Set(r.list.map(x => String(x.name)));
    const matched = db.extraCompanies.filter(c => {
      const name = String(c.name || '');
      if (!name || remoteNames.has(name)) return false;
      if (qs && !name.toLowerCase().includes(qs)) return false;
      if (province && (c.province || c.region || '') !== province) return false;
      if (city && String(c.city || '') !== String(city)) return false;
      if (industry && (c.industry || '其他') !== industry) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      return true;
    }).map(c => {
      const v = companyView(db, c);
      return {
        id: v.id, name: v.name, industry: v.industry,
        province: c.province || c.region || '', city: c.city || '',
        address: c.address || '', tags: c.tags || [], regYear: null,
        reviewCount: v.reviewCount, avg: v.avg, level: v.level, label: v.label,
        source: 'extra', note: v.note || '',
      };
    });
    if (matched.length) {
      r.list = matched.concat(r.list).slice(0, pageSize);
      r.total = (r.total || 0) + matched.length;
      r.pages = Math.max(1, Math.ceil(r.total / pageSize));
    }
  }
  return r;
}
/* 避雷指数：avg 为该司所有评价星级均值（1-5），level 分级：
 *   pending 待评价 / ok 尚可(1-2) / careful 谨慎(2-3) / warn 避雷(3-4) / danger 强烈避雷(4-5) */
const COMPANY_CATALOG_FILE = path.join(__dirname, 'public', 'data', 'companies.json');
let companyCatalog = null; /* 3 万条名录内存缓存（进程级） */
function loadCompanyCatalog() {
  if (companyCatalog) return companyCatalog;
  try {
    if (fs.existsSync(COMPANY_CATALOG_FILE)) companyCatalog = JSON.parse(fs.readFileSync(COMPANY_CATALOG_FILE, 'utf8'));
    else companyCatalog = [];
  } catch (e) {
    console.error('公司名录加载失败:', e.message);
    companyCatalog = [];
  }
  return companyCatalog;
}
/* ---- 3 万条名录索引缓存（性能优化）----
 * 名录为只读静态文件：进程内只做一次名称预排序 + id/name 映射 + 小写搜索串，
 * 之后每次请求 O(分页大小) 而非 O(3万×排序)；管理端增删改后调用 invalidateCompanies() 失效重建。 */
let catSorted = null;  /* 名录按名称排序（zh） */
let catByName = null;  /* Map name -> company */
let catById = null;    /* Map id -> company */
let catLower = null;   /* 与 catSorted 同序的小写 "名称 行业 区域" 搜索串 */
let indCache = null;   /* 行业统计缓存 */
let indExtraLen = -1;  /* 行业缓存对应的 extraCompanies 长度（变化即失效） */
function invalidateCompanies() {
  catSorted = catByName = catById = catLower = null;
  indCache = null; indExtraLen = -1;
}
function buildCatIndex() {
  const cat = loadCompanyCatalog();
  catSorted = cat.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  catByName = new Map(cat.map(c => [c.name, c]));
  catById = new Map(cat.map(c => [c.id, c]));
  catLower = catSorted.map(c => (c.name + ' ' + (c.industry || '') + ' ' + (c.region || '')).toLowerCase());
  return catSorted;
}
function getSortedCatalog() { return catSorted || buildCatIndex(); }
/* 名录 + 管理端新增公司 的合并视图（extra 量小，惰性排序后归并，保持名称序） */
function allCompanies(db) {
  const cat = getSortedCatalog();
  const extra = (db.extraCompanies || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  if (!extra.length) return cat;
  const out = [];
  let i = 0, j = 0;
  while (i < cat.length && j < extra.length) {
    if (cat[i].name.localeCompare(extra[j].name, 'zh') <= 0) out.push(cat[i++]);
    else out.push(extra[j++]);
  }
  while (i < cat.length) out.push(cat[i++]);
  while (j < extra.length) out.push(extra[j++]);
  return out;
}
/* 名录 + extra 的过滤（保持名称序；q 用预构建小写串，避免每次 toLowerCase 3 万次） */
function filterCompanies(db, { q, industry, region } = {}) {
  const cat = getSortedCatalog();
  const s = String(q || '').trim().toLowerCase();
  const hasQ = !!s;
  let out = [];
  if (!hasQ && !industry && !region) {
    out = cat;
  } else {
    for (let i = 0; i < cat.length; i++) {
      const c = cat[i];
      if (hasQ && !catLower[i].includes(s)) continue;
      if (industry && c.industry !== industry) continue;
      if (region && !(c.region || '').includes(region)) continue;
      out.push(c);
    }
  }
  const extra = (db.extraCompanies || []).filter(c => {
    if (hasQ && !((c.name + ' ' + (c.industry || '') + ' ' + (c.region || '')).toLowerCase().includes(s))) return false;
    if (industry && c.industry !== industry) return false;
    if (region && !(c.region || '').includes(region)) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  if (!extra.length) return out;
  const merged = [];
  let i = 0, j = 0;
  while (i < out.length && j < extra.length) {
    if (out[i].name.localeCompare(extra[j].name, 'zh') <= 0) merged.push(out[i++]);
    else merged.push(extra[j++]);
  }
  while (i < out.length) merged.push(out[i++]);
  while (j < extra.length) merged.push(extra[j++]);
  return merged;
}
/* 某公司的评价数组（惰性取 db.companyReviews[companyId]） */
function companyReviews(db, id) {
  return (db.companyReviews || {})[id] || [];
}
function companyLevel(reviews) {
  const n = reviews.length;
  if (!n) return { level: 'pending', label: '待评价', avg: 0 };
  const avg = reviews.reduce((s, r) => s + Number(r.rating), 0) / n;
  const lv = avg >= 4 ? { level: 'danger', label: '强烈避雷' } : avg >= 3 ? { level: 'warn', label: '避雷' } : avg >= 2 ? { level: 'careful', label: '谨慎' } : { level: 'ok', label: '尚可' };
  return { ...lv, avg: Math.round(avg * 10) / 10 };
}
function companyJson(db, c, opts = {}) {
  const reviews = companyReviews(db, c.id).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { level, label, avg } = companyLevel(reviews);
  return {
    id: c.id, name: c.name, industry: c.industry || '其他', region: c.region || '重庆', note: c.note || '',
    createdAt: c.createdAt, reviewCount: reviews.length, avg, level, label,
    source: c.source || (c.id && String(c.id).startsWith('c-seed') ? 'real' : 'extra'),
    reviews: opts.withReviews ? reviews : undefined,
  };
}
function findCompany(db, idOrName) {
  const extra = (db.extraCompanies || []).find(x => x.id === idOrName || x.name === idOrName);
  if (extra) return extra;
  const row = sqlFindCompany(idOrName);
  if (row) return sqlCompanyRow(row);
  if (!catById) buildCatIndex();
  return catById.get(idOrName) || catByName.get(idOrName) || null;
}

/* 名录内按名称精确定位（区分"评价对象"与"展示对象"；SQLite 优先，静态名录降级） */
function findCompanyMeta(db, idOrName) {
  const extra = (db.extraCompanies || []).find(x => x.id === idOrName || x.name === idOrName);
  if (extra) return { hit: extra, inCatalog: false };
  const row = sqlFindCompany(idOrName);
  if (row) return { hit: sqlCompanyRow(row), inCatalog: true };
  if (COMPANIES_API_URL) {
    const cached = _remoteCompanyCache.get(String(idOrName));
    if (cached) return { hit: cached, inCatalog: true };
  }
  if (!catById) buildCatIndex();
  const hit = catById.get(idOrName) || catByName.get(idOrName);
  return { hit: hit || null, inCatalog: !!hit };
}

/* 惰性 enrich：有评价的公司才走完整 companyJson（含评分/等级计算），无评价的直接给零值，
 * 避免 3 万条全量 map + 评价数组排序 */
function companyView(db, c) {
  const rv = (db.companyReviews || {})[c.id];
  if (!rv || !rv.length) return {
    id: c.id, name: c.name, industry: c.industry || '其他', region: c.region || '重庆', note: c.note || '',
    createdAt: c.createdAt, reviewCount: 0, avg: 0, level: 'pending', label: '待评价',
    source: c.source || (c.id && String(c.id).startsWith('c-seed') ? 'real' : 'extra'),
  };
  return companyJson(db, c);
}

/* 评价带投票字段的渲染（匿名评价隐藏发布者） */
function reviewView(r, viewerId) {
  const votes = r.votes || { up: [], down: [] };
  return {
    ...r, anonymous: !!r.anonymous,
    username: r.anonymous ? '匿名' : r.username, name: r.anonymous ? (r.nickname || '匿名用户') : r.name, avatar: r.anonymous ? null : r.avatar,
    guestKey: undefined,
    upCount: (votes.up || []).length, downCount: (votes.down || []).length,
    myVote: viewerId ? ((votes.up || []).includes(viewerId) ? 1 : (votes.down || []).includes(viewerId) ? -1 : 0) : 0,
    votes: undefined,
  };
}
function companyJson2(db, hit, opts = {}) {
  const id = hit.id;
  const reviews = (db.companyReviews || {})[id] || [];
  const sorted = reviews.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { level, label, avg } = companyLevel(reviews);
  const viewerId = opts.userId;
  return {
    ...hit,
    industry: hit.industry || '其他',
    reviewCount: reviews.length, avg, level, label,
    reviews: opts.withReviews ? sorted.map(r => reviewView(r, viewerId)) : undefined,
    myReview: viewerId ? sorted.find(r => r.userId === viewerId) || null : undefined,
    watched: opts.watched ? opts.watched.includes(id) : false,
  };
}

app.get('/api/companies', async (req, res) => {
  const db = loadDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 30));
  const { q, industry, region, city, tag, sort } = req.query;
  /* 远程全库模式（companies-api）：585 万家 */
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    const remoteRes = await remoteListCompanies(db, { q, province: region || undefined, city, industry, tag, sort, page, pageSize });
    if (remoteRes) {
      remoteRes.list.forEach(c => { c.watched = req.user && (req.user.watchCompanies || []).includes(c.id); });
      return res.json(remoteRes);
    }
  }
  /* 全国模式（SQLite）：重庆省份第一呈现 */
  const sqlRes = sqlListCompanies(db, { q, province: region || undefined, city, industry, tag, sort, page, pageSize });
  if (sqlRes) {
    sqlRes.list.forEach(c => { c.watched = req.user && (req.user.watchCompanies || []).includes(c.id); });
    return res.json(sqlRes);
  }
  /* 降级模式（静态名录） */
  let list = filterCompanies(db, { q, industry, region });
  if (sort === 'rating' || sort === 'reviews' || sort === 'danger') {
    const reviewed = [];
    const plain = [];
    for (const c of list) {
      const rv = (db.companyReviews || {})[c.id];
      if (rv && rv.length) reviewed.push(companyJson(db, c));
      else plain.push(companyView(db, c));
    }
    if (sort === 'rating') reviewed.sort((a, b) => b.avg - a.avg || b.reviewCount - a.reviewCount);
    else if (sort === 'reviews') reviewed.sort((a, b) => b.reviewCount - a.reviewCount);
    else reviewed.sort((a, b) => (b.avg >= 4 ? 1 : 0) - (a.avg >= 4 ? 1 : 0) || b.avg - a.avg);
    list = reviewed.concat(plain);
  } else {
    list = list.map(c => companyView(db, c));
  }
  const total = list.length;
  const rows = list.slice((page - 1) * pageSize, page * pageSize);
  res.json({ list: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), via: 'static' });
});

app.get('/api/companies/meta/industries', async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    const r = await companiesApi('/meta/industries');
    if (r) return res.json(r);
  }
  const s = sqlMetaIndustries();
  if (s) return res.json(s);
  const extraLen = (db.extraCompanies || []).length;
  if (indCache && indExtraLen === extraLen) return res.json(indCache);
  const cat = getSortedCatalog();
  const cnt = {};
  for (const c of cat) { const k = c.industry || '其他'; cnt[k] = (cnt[k] || 0) + 1; }
  for (const c of (db.extraCompanies || [])) { const k = c.industry || '其他'; cnt[k] = (cnt[k] || 0) + 1; }
  indCache = Object.entries(cnt).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  indExtraLen = extraLen;
  res.json(indCache.slice(0, 60));
});

/* 省份 / 风险标签 / 数据看板（全国模式） */
app.get('/api/companies/meta/provinces', async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    const r = await companiesApi('/meta/provinces');
    if (r) return res.json(r);
  }
  const s = sqlMetaProvinces();
  if (s) return res.json(s);
  res.json([]);
});
app.get('/api/companies/meta/tags', async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    const r = await companiesApi('/meta/tags');
    if (r) return res.json(r);
  }
  const s = sqlMetaTags();
  if (s) return res.json(s);
  res.json([]);
});
app.get('/api/companies/stats', async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    const r = await companiesApi('/stats');
    if (r) return res.json({ ok: true, ...r });
  }
  const s = sqlStats();
  if (s) return res.json({ ok: true, ...s });
  res.json({ ok: true, total: loadCompanyCatalog().length, provinces: 1, industries: 0, years: { min: 0, max: 0 }, chongqing: loadCompanyCatalog().filter(c => (c.region || '').includes('重庆') || c.region === '渝').length });
});

/* 避雷热榜：全国 / 按省份；红黑榜 */
app.get('/api/companies/hot', async (req, res) => {
  const db = loadDb();
  const province = req.query.province || '';
  const type = req.query.type || 'danger'; // danger=强烈避雷榜 / reviews=热议榜 / red=红榜(口碑好)
  const reviews = db.companyReviews || {};
  if (COMPANIES_API_URL && !hasNationalCatalog()) {
    await ensureRemoteCompanies(Object.keys(reviews));
  }
  const arr = [];
  for (const [cid, rlist] of Object.entries(reviews)) {
    if (!rlist || !rlist.length) continue;
    const hit = findCompanyMeta(db, cid).hit;
    if (!hit) continue;
    if (province && hit.province !== province) continue;
    const avg = rlist.reduce((s, r) => s + Number(r.rating), 0) / rlist.length;
    arr.push({ id: hit.id, name: hit.name, province: hit.province, city: hit.city, industry: hit.industry, tags: hit.tags || [], reviewCount: rlist.length, avg: Math.round(avg * 10) / 10 });
  }
  if (type === 'red') arr.sort((a, b) => a.avg - b.avg || b.reviewCount - a.reviewCount);
  else if (type === 'reviews') arr.sort((a, b) => b.reviewCount - a.reviewCount);
  else arr.sort((a, b) => b.avg - a.avg || b.reviewCount - a.reviewCount);
  res.json(arr.slice(0, 50));
});

/* 访客自主添加避雷公司（登录用户即可提交，进入待审核队列） */
app.post('/api/companies/submit', requireAuth, async (req, res) => {
  const db = loadDb();
  const name = String((req.body && req.body.name) || '').trim();
  if (name.length < 2) return res.status(400).json({ error: '公司名称至少 2 个字' });
  const province = String((req.body && req.body.province) || '').trim() || '其他';
  const city = String((req.body && req.body.city) || '').trim() || province;
  const industry = String((req.body && req.body.industry) || '其他').trim();
  const tags = Array.isArray(req.body && req.body.tags) ? req.body.tags.filter(Boolean).slice(0, 5) : [];
  const address = String((req.body && req.body.address) || '').trim().slice(0, 200);
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  /* 去重：已在全国库或 extraCompanies 或 pendingCompanies 中则提示 */
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(name);
  const existMeta = findCompanyMeta(db, name);
  if (existMeta && existMeta.hit) return res.status(409).json({ error: '该公司已存在于避雷库中' });
  if ((db.extraCompanies || []).some(c => c.name === name)) return res.status(409).json({ error: '该公司已存在' });
  if ((db.pendingCompanies || []).some(c => c.name === name && c.status === 'pending')) return res.status(409).json({ error: '该公司已在待审核队列中' });
  const item = {
    id: id('pc'), name, province, city, industry, tags, address, note,
    submittedBy: req.user.username, submittedById: req.user.id,
    status: 'pending', createdAt: nowIso(),
  };
  db.pendingCompanies = db.pendingCompanies || [];
  db.pendingCompanies.push(item);
  saveDb(db);
  /* 通知管理员有新提交 */
  db.users.filter(u => STAFF_ROLES.includes(u.role)).forEach(admin => {
    addNotification(db, admin.id, 'mention', { title: '新公司待审核', content: `${req.user.username} 提交了「${name}」待审核`, link: '/admin/companies?tab=pending' });
  });
  saveDb(db);
  res.json({ ok: true, message: '提交成功！管理员审核通过后将显示在避雷库中', id: item.id });
});

/* 获取待审核公司列表（公开可见，让提交者查看进度） */
app.get('/api/companies/pending', (req, res) => {
  const db = loadDb();
  const list = (db.pendingCompanies || []).filter(c => c.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/companies/:id', async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const j = companyJson2(db, hit, { withReviews: true, userId: req.user ? req.user.id : null, watched: req.user ? (req.user.watchCompanies || []) : [] });
  res.json(j);
});

/* 评价：仅登录用户可写 */
app.post('/api/companies/:id/reviews', requireAuth, async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const rating = Number((req.body && req.body.rating));
  if (![1, 2, 3, 4, 5].includes(rating)) return res.status(400).json({ error: '请选择 1-5 星避雷指数' });
  const content = String((req.body && req.body.content) || '').trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: '请写一句避雷理由' });
  db.companyReviews = db.companyReviews || {};
  const reviews = db.companyReviews[hit.id] || (db.companyReviews[hit.id] = []);
  const isAnon = !!req.body.anonymous;
  const nick = isAnon ? (String((req.body && req.body.nickname) || '').trim().slice(0, 20) || '匿名') : (req.user.name || req.user.username);
  const mine = reviews.find(r => r.userId === req.user.id);
  if (mine) { mine.rating = rating; mine.content = content; mine.anonymous = isAnon; mine.nickname = isAnon ? nick : null; mine.createdAt = nowIso(); saveDb(db); return res.json(companyJson2(db, hit, { withReviews: true, userId: req.user.id, watched: req.user.watchCompanies || [] })); }
  const review = {
    id: id('rv'), userId: req.user.id, username: req.user.username,
    name: nick, avatar: !isAnon ? req.user.avatar : null, rating, content,
    anonymous: isAnon, nickname: isAnon ? nick : null, guestKey: null,
    votes: { up: [], down: [] }, createdAt: nowIso(),
  };
  reviews.push(review);
  addExp(db, req.user, 3); unlockAch(db, req.user.id, 'company-review'); checkCumulativeAch(db, req.user);
  saveDb(db);
  res.json(companyJson2(db, hit, { withReviews: true, userId: req.user.id, watched: req.user.watchCompanies || [] }));
});

/* 评价点赞/踩 */
app.post('/api/companies/:id/reviews/:rid/vote', requireAuth, async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const review = ((db.companyReviews || {})[hit.id] || []).find(r => r.id === req.params.rid);
  if (!review) return res.status(404).json({ error: '评价不存在' });
  const dir = Number((req.body && req.body.dir)) === -1 ? -1 : 1;
  review.votes = review.votes || { up: [], down: [] };
  const up = review.votes.up, down = review.votes.down;
  up.splice(up.indexOf(req.user.id), 1);
  down.splice(down.indexOf(req.user.id), 1);
  if (dir === 1) up.push(req.user.id); else down.push(req.user.id);
  saveDb(db);
  res.json({ upCount: up.length, downCount: down.length, myVote: dir });
});

/* 我的避雷清单：收藏关注 + 列表 + 导出 */
app.post('/api/companies/:id/watch', requireAuth, (req, res) => {
  const db = loadDb();
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const list = req.user.watchCompanies || (req.user.watchCompanies = []);
  const i = list.indexOf(hit.id);
  const watched = i < 0;
  if (watched) list.push(hit.id); else list.splice(i, 1);
  saveDb(db);
  res.json({ watched, id: hit.id });
});
app.get('/api/companies/watch/list', requireAuth, (req, res) => {
  const db = loadDb();
  const ids = req.user.watchCompanies || [];
  const out = [];
  for (const id of ids) {
    const { hit } = findCompanyMeta(db, id);
    if (!hit) continue;
    const rv = (db.companyReviews || {})[String(hit.id)];
    const { level, label, avg } = companyLevel(rv || []);
    out.push({ id: hit.id, name: hit.name, province: hit.province, city: hit.city, industry: hit.industry, tags: hit.tags || [], reviewCount: (rv || []).length, avg, level, label });
  }
  res.json(out);
});

app.post('/api/topics/:id/like', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const likedUsers = topic.likedUsers || (topic.likedUsers = []);
  const idx = likedUsers.indexOf(req.user.id);
  let liked;
  if (idx >= 0) { likedUsers.splice(idx, 1); liked = false; topic.likeCount = Math.max(0, topic.likeCount - 1); }
  else { likedUsers.push(req.user.id); liked = true; topic.likeCount += 1; }
  /* 点赞给作者 +1 经验（不刷自己） */
  if (liked && topic.userId !== req.user.id) {
    const author = db.users.find(u => u.id === topic.userId);
    if (author) addExp(db, author, 1);
  }
  /* 赞踩互斥：点赞则取消之前的踩 */
  if (liked) {
    const dislikedUsers = topic.dislikedUsers || [];
    const di = dislikedUsers.indexOf(req.user.id);
    if (di >= 0) { dislikedUsers.splice(di, 1); topic.dislikeCount = Math.max(0, (topic.dislikeCount || 0) - 1); }
  }
  saveDb(db);
  res.json({ liked, likeCount: topic.likeCount, disliked: (topic.dislikedUsers || []).includes(req.user.id), dislikeCount: topic.dislikeCount || 0 });
});

/* 表情回应：切换某 emoji，返回全量统计 */
const REACT_EMOJIS = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
app.post('/api/topics/:id/react', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const emoji = String((req.body || {}).emoji || '');
  if (!REACT_EMOJIS.includes(emoji)) return res.status(400).json({ error: '不支持的表情' });
  topic.reactions = topic.reactions || {};
  const arr = topic.reactions[emoji] || (topic.reactions[emoji] = []);
  const i = arr.indexOf(req.user.id);
  let on;
  if (i >= 0) { arr.splice(i, 1); on = false; } else { arr.push(req.user.id); on = true; }
  saveDb(db);
  const stats = {};
  for (const e of REACT_EMOJIS) stats[e] = { count: (topic.reactions[e] || []).length, mine: (topic.reactions[e] || []).includes(req.user.id) };
  res.json({ on, emoji, stats });
});

app.post('/api/topics/:id/dislike', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const dislikedUsers = topic.dislikedUsers || (topic.dislikedUsers = []);
  const idx = dislikedUsers.indexOf(req.user.id);
  let disliked;
  if (idx >= 0) { dislikedUsers.splice(idx, 1); disliked = false; topic.dislikeCount = Math.max(0, (topic.dislikeCount || 0) - 1); }
  else {
    dislikedUsers.push(req.user.id); disliked = true; topic.dislikeCount = (topic.dislikeCount || 0) + 1;
    /* 赞踩互斥：踩则取消之前的赞 */
    const likedUsers = topic.likedUsers || [];
    const li = likedUsers.indexOf(req.user.id);
    if (li >= 0) { likedUsers.splice(li, 1); topic.likeCount = Math.max(0, topic.likeCount - 1); }
  }
  saveDb(db);
  res.json({ disliked, dislikeCount: topic.dislikeCount || 0, liked: (topic.likedUsers || []).includes(req.user.id), likeCount: topic.likeCount });
});

app.post('/api/topics/:id/favorite', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const list = topic.favoritedUsers || (topic.favoritedUsers = []);
  const uf = req.user.favorites || (req.user.favorites = []);
  const idx = list.indexOf(req.user.id);
  let favorited;
  if (idx >= 0) { list.splice(idx, 1); uf.splice(uf.indexOf(topic.id), 1); favorited = false; }
  else { list.push(req.user.id); uf.push(topic.id); favorited = true; }
  topic.favoriteCount = list.length;
  saveDb(db);
  res.json({ favorited, favoriteCount: topic.favoriteCount });
});

/* 书签提醒：设置/取消某收藏的提醒时间 */
app.post('/api/topics/:id/reminder', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const at = (req.body || {}).at ? new Date((req.body || {}).at).toISOString() : null;
  if (at && new Date(at).getTime() <= Date.now()) return res.status(400).json({ error: '提醒时间必须是未来时间' });
  req.user.favReminders = req.user.favReminders || {};
  if (at) req.user.favReminders[topic.id] = at;
  else delete req.user.favReminders[topic.id];
  saveDb(db);
  res.json({ ok: true, reminderAt: at });
});

app.get('/api/favorites', requireAuth, (req, res) => {
  const db = loadDb();
  const ids = req.user.favorites || [];
  const list = db.topics.filter(t => ids.includes(t.id)).sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  const rems = req.user.favReminders || {};
  res.json(list.map(t => ({ ...enrichTopic(t, db), reminderAt: rems[t.id] || null })));
});

/* ================= 帖子编辑 / 删除（作者或管理员） ================= */
app.put('/api/topics/:id', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const isAuthor = topic.userId === req.user.id;
  const isStaff = ['admin', 'owner'].includes(req.user.role);
  if (!isAuthor && !isStaff) return res.status(403).json({ error: '只有作者或管理员可以编辑' });
  const { title, content, tags, boardId, minLevel } = req.body || {};
  if (isAuthor || isStaff) {
    if (title !== undefined) {
      const t = String(title).trim().slice(0, 80);
      if (!t) return res.status(400).json({ error: '标题不能为空' });
      topic.title = t;
    }
    if (minLevel !== undefined) topic.minLevel = Math.max(1, Math.min(10, Math.floor(Number(minLevel) || 1)));
    if (boardId) { const b = boardById(db, boardId); if (b) topic.boardId = b.id; }
    if (Array.isArray(tags)) topic.tags = tags.slice(0, 5);
  }
  if (content !== undefined) {
    const t = String(content).trim();
    if (!t) return res.status(400).json({ error: '内容不能为空' });
    topic.posts[0].content = t;
    /* 编辑记录公示 */
    topic.posts[0].editedAt = nowIso();
    topic.posts[0].editedBy = req.user.username;
  }
  topic.slug = slugify(topic.title);
  saveDb(db);
  res.json(enrichTopic(topic, db));
});

app.delete('/api/topics/:id', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const isAuthor = topic.userId === req.user.id;
  const isStaff = ['admin', 'owner'].includes(req.user.role);
  if (!isAuthor && !isStaff) return res.status(403).json({ error: '只有作者或管理员可以删除' });
  const board = boardById(db, topic.boardId);
  if (board) board.topicCount = Math.max(0, (board.topicCount || 1) - 1);
  db.topics = db.topics.filter(t => t.id !== topic.id);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= 站内私信 ================= */
app.get('/api/messages', requireAuth, (req, res) => {
  const db = loadDb();
  const mine = db.messages.filter(m => m.fromId === req.user.id || m.toId === req.user.id);
  const peers = {};
  mine.forEach(m => {
    const pid = m.fromId === req.user.id ? m.toId : m.fromId;
    if (!peers[pid] || new Date(m.createdAt) > new Date(peers[pid].createdAt)) peers[pid] = m;
  });
  const list = Object.entries(peers).map(([pid, last]) => {
    const u = db.users.find(x => x.id === pid);
    if (!u || u.id === GHOST.id) return null;
    const unread = db.messages.filter(m => m.toId === req.user.id && m.fromId === pid && !m.read).length;
    return { peer: userPublic(u), lastMessage: String(last.content || '').slice(0, 60), lastAt: last.createdAt, unread };
  }).filter(Boolean).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  res.json(list);
});

app.get('/api/messages/:username', requireAuth, (req, res) => {
  const db = loadDb();
  const peer = db.users.find(u => u.username === req.params.username);
  if (!peer) return res.status(404).json({ error: '用户不存在' });
  if (peer.id === GHOST.id) return res.status(400).json({ error: '该用户已注销' });
  const list = db.messages.filter(m => (m.fromId === req.user.id && m.toId === peer.id) || (m.fromId === peer.id && m.toId === req.user.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let changed = false;
  list.forEach(m => { if (m.toId === req.user.id && !m.read) { m.read = true; changed = true; } });
  if (changed) saveDb(db);
  res.json({ peer: userPublic(peer), messages: list.map(m => ({ id: m.id, fromMe: m.fromId === req.user.id, content: m.content, createdAt: m.createdAt })) });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const text = String((req.body && req.body.content) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: '消息内容不能为空' });
  const db = loadDb();
  const peer = db.users.find(u => u.username === (req.body && req.body.to) || u.id === (req.body && req.body.to));
  if (!peer) return res.status(404).json({ error: '用户不存在' });
  if (peer.id === GHOST.id) return res.status(400).json({ error: '该用户已注销' });
  if (peer.id === req.user.id) return res.status(400).json({ error: '不能给自己发私信' });
  const msg = { id: id('ms'), fromId: req.user.id, toId: peer.id, content: text, read: false, createdAt: nowIso() };
  db.messages.push(msg);
  addNotification(db, peer.id, 'message', { fromId: req.user.id, fromName: req.user.name || req.user.username, content: text.slice(0, 80) });
  saveDb(db);
  res.status(201).json({ ok: true, id: msg.id });
});

/* ================= 站内通知 ================= */
app.get('/api/notifications', requireAuth, (req, res) => {
  const db = loadDb();
  /* 到期的书签提醒转成通知 */
  const rems = req.user.favReminders || {};
  let remChanged = false;
  for (const [tid, at] of Object.entries(rems)) {
    if (new Date(at).getTime() <= Date.now()) {
      const topic = db.topics.find(t => t.id === tid);
      if (topic) addNotification(db, req.user.id, 'reminder', { topicId: topic.id, title: topic.title, link: '/post/' + topic.slug });
      delete rems[tid];
      remChanged = true;
    }
  }
  if (remChanged) saveDb(db);
  const list = db.notifications.filter(n => n.userId === req.user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
  res.json(list.map(n => {
    const from = db.users.find(u => u.id === n.fromId);
    const topic = db.topics.find(t => t.id === n.topicId);
    return { ...n, fromName: (from && from.name) || n.fromName || '系统', fromAvatar: from && from.avatar, fromUsername: from && from.username, topicSlug: topic && topic.slug };
  }));
});
app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  const db = loadDb();
  res.json({ count: db.notifications.filter(n => n.userId === req.user.id && !n.read).length });
});
app.post('/api/notifications/read', requireAuth, (req, res) => {
  const db = loadDb();
  const ids = (req.body && req.body.ids) || [];
  db.notifications.forEach(n => { if (n.userId === req.user.id && (ids.length === 0 || ids.includes(n.id))) n.read = true; });
  saveDb(db);
  res.json({ ok: true });
});

/* ================= 举报（公开） ================= */
app.post('/api/reports', requireAuth, (req, res) => {
  const { type, targetId, targetTitle, reason } = req.body || {};
  const db = loadDb();
  if (!['topic', 'reply', 'company'].includes(type)) return res.status(400).json({ error: '无效的举报类型' });
  const text = String(reason || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: '请填写举报理由' });
  if (!targetId) return res.status(400).json({ error: '缺少举报对象' });
  const existing = db.reports.find(r => r.type === type && r.targetId === targetId && r.reporterId === req.user.id && r.status === 'open');
  if (existing) return res.status(400).json({ error: '你已经举报过该内容，等待管理员处理' });
  db.reports.push({ id: id('rp'), type, targetId, targetTitle: String(targetTitle || '').slice(0, 120), reason: text, reporterId: req.user.id, status: 'open', createdAt: nowIso(), handledBy: null, handledAt: null });
  saveDb(db);
  res.status(201).json({ ok: true });
});

/* ================= 活跃排行榜（周榜 / 月榜） ================= */
app.get('/api/rank/active', (req, res) => {
  const db = loadDb();
  const period = req.query.period === 'month' ? 30 : 7;
  const cutoff = Date.now() - period * 86400000;
  const score = {};
  db.topics.forEach(t => {
    if (!score[t.userId]) score[t.userId] = { posts: 0, replies: 0 };
    if (new Date(t.createdAt).getTime() >= cutoff) score[t.userId].posts++;
  });
  db.topics.forEach(t => t.posts.forEach(p => {
    if (p.postNumber > 1) {
      if (!score[p.userId]) score[p.userId] = { posts: 0, replies: 0 };
      if (new Date(p.createdAt).getTime() >= cutoff) score[p.userId].replies++;
    }
  }));
  const list = db.users.filter(u => u.id !== GHOST.id).map(u => {
    const s = score[u.id] || { posts: 0, replies: 0 };
    return { id: u.id, username: u.username, name: u.name, avatar: u.avatar, posts: s.posts, replies: s.replies, total: s.posts + s.replies, coins: u.coins || 0 };
  }).filter(u => u.total > 0).sort((a, b) => b.total - a.total || b.coins - a.coins).slice(0, 50);
  res.json(list);
});

/* ================= 标签聚合 ================= */
app.get('/api/tag/:name', (req, res) => {
  const db = loadDb();
  const name = decodeURIComponent(req.params.name);
  /* 服务端分页：标签下帖子可达上千篇，一次全返 2.5MB，手机端卡顿（2026-10-04 升级） */
  const all = db.topics
    .filter(t => (t.tags || []).includes(name) && (!t.status || t.status === 'published'))
    .sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '30', 10) || 30));
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page || '1', 10) || 1));
  const list = all.slice((page - 1) * pageSize, page * pageSize).map(t => enrichTopic(t, db));
  res.json({ total: all.length, page, pages, list });
});

/* ================= v8 玩法升级：等级 / 成就 / 商城 / 打赏悬赏 / 投票 / 交易 ================= */
const LEVELS = [
  { lv: 1, exp: 0, title: '初来乍到' }, { lv: 2, exp: 50, title: '论坛新人' }, { lv: 3, exp: 150, title: '活跃会员' },
  { lv: 4, exp: 300, title: '资深会员' }, { lv: 5, exp: 500, title: '论坛达人' }, { lv: 6, exp: 800, title: '论坛精英' },
  { lv: 7, exp: 1200, title: '论坛名士' }, { lv: 8, exp: 1800, title: '论坛大师' }, { lv: 9, exp: 2600, title: '论坛传奇' },
  { lv: 10, exp: 3600, title: '社区之神' },
];
function userLevel(u) {
  const exp = u.exp || 0;
  let lv = LEVELS[0];
  for (const L of LEVELS) if (exp >= L.exp) lv = L;
  const next = LEVELS.find(L => L.lv === lv.lv + 1);
  return {
    exp, level: lv.lv, levelTitle: lv.title,
    nextExp: next ? next.exp : null,
    progress: next ? Math.min(100, Math.round(((exp - lv.exp) / (next.exp - lv.exp)) * 100)) : 100,
  };
}
/* 加经验：升级时站内通知 */
function addExp(db, userOrId, n) {
  const u = typeof userOrId === 'string' ? db.users.find(x => x.id === userOrId) : userOrId;
  if (!u) return;
  const before = userLevel(u).level;
  u.exp = (u.exp || 0) + n;
  const after = userLevel(u).level;
  if (after > before) addNotification(db, u.id, 'levelup', { level: after, title: LEVELS[after - 1].title });
}

const ACHIEVEMENTS = [
  { id: 'first-topic', icon: '📝', name: '初出茅庐', desc: '发布第一个主题' },
  { id: 'first-reply', icon: '💬', name: '积极回应', desc: '发表第一条回复' },
  { id: 'checkin-7', icon: '🔥', name: '坚持一周', desc: '累计签到 7 天' },
  { id: 'checkin-30', icon: '🏆', name: '月签达人', desc: '累计签到 30 天' },
  { id: 'like-100', icon: '❤️', name: '万人迷', desc: '获赞 100 次' },
  { id: 'topic-10', icon: '✍️', name: '高产作者', desc: '发布 10 个主题' },
  { id: 'company-review', icon: '🛡️', name: '避雷先锋', desc: '写下第一条公司避雷评价' },
  { id: 'company-review-10', icon: '🧭', name: '避雷大师', desc: '累计 10 条公司避雷评价' },
  { id: 'tip-give', icon: '🎁', name: '乐善好施', desc: '打赏他人一次' },
  { id: 'bounty-solve', icon: '💰', name: '悬赏达人', desc: '悬赏被采纳一次' },
  { id: 'transfer', icon: '🤝', name: '社交达人', desc: '完成首笔鸡腿转账' },
  { id: 'poll', icon: '🗳️', name: '意见领袖', desc: '发起一个投票' },
  { id: 'shop-buy', icon: '🛍️', name: '剁手党', desc: '在积分商城完成首次兑换' },
];
function unlockAch(db, userId, achId) {
  const u = db.users.find(x => x.id === userId);
  if (!u) return;
  u.achievements = u.achievements || [];
  if (u.achievements.includes(achId)) return;
  u.achievements.push(achId);
  const meta = ACHIEVEMENTS.find(a => a.id === achId);
  if (meta) addNotification(db, userId, 'achievement', { achId, achName: meta.name, icon: meta.icon });
}
/* 顺带检查可解锁的累计型成就 */
function checkCumulativeAch(db, u) {
  if ((u.exp || 0) >= 0 && u.checkinCount >= 7) unlockAch(db, u.id, 'checkin-7');
  if (u.checkinCount >= 30) unlockAch(db, u.id, 'checkin-30');
  const topicN = db.topics.filter(t => t.userId === u.id).length;
  if (topicN >= 10) unlockAch(db, u.id, 'topic-10');
  const likeN = db.topics.filter(t => t.userId === u.id).reduce((a, t) => a + (t.likeCount || 0), 0)
    + db.topics.reduce((a, t) => a + t.posts.filter(p => p.userId === u.id).reduce((s, p) => s + (p.likeCount || 0), 0), 0);
  if (likeN >= 100) unlockAch(db, u.id, 'like-100');
  const revN = Object.values(db.companyReviews || {}).reduce((a, arr) => a + (arr || []).filter(r => r.userId === u.id).length, 0);
  if (revN >= 10) unlockAch(db, u.id, 'company-review-10');
}

/* 积分商城默认商品（可后台增删改） */
function seedShop() {
  return [
    { id: 'shop-badge-guard', name: '论坛守护者徽章', icon: '🛡️', price: 100, type: 'badge', value: '论坛守护者', desc: '佩戴守护徽章，展示社区资历', stock: -1 },
    { id: 'shop-badge-avoid', name: '避雷先锋徽章', icon: '🧭', price: 150, type: 'badge', value: '避雷先锋', desc: '给公司避雷库贡献评价的荣誉徽章', stock: -1 },
    { id: 'shop-badge-rich', name: '鸡汤大户徽章', icon: '🍗', price: 300, type: 'badge', value: '鸡汤大户', desc: '身怀 500+ 鸡腿的土豪徽章', stock: -1 },
    { id: 'shop-title-custom', name: '自定义头衔（7 天）', icon: '🏷️', price: 80, type: 'title', value: '__CUSTOM__', desc: '名字旁展示 7 天自定义头衔（1-12 字），到期自动失效', stock: -1 },
    { id: 'shop-title-driver', name: '老司机头衔', icon: '🚗', price: 300, type: 'title', value: '老司机', desc: '永久头衔：老司机', stock: -1 },
    { id: 'shop-title-elder', name: '社区元老头衔', icon: '👑', price: 500, type: 'title', value: '社区元老', desc: '永久头衔：社区元老', stock: -1 },
    { id: 'shop-title-legend', name: '退隐大佬头衔', icon: '🧙', price: 800, type: 'title', value: '退隐大佬', desc: '永久头衔：退隐大佬', stock: -1 },
  ];
}

/* ================= checkin & rank ================= */
app.post('/api/checkin', requireAuth, (req, res) => {
  const db = loadDb();
  const today = todayStr();
  if (req.user.lastCheckin === today) return res.json({ ok: false, msg: '今天已经签到过了', coins: req.user.coins });
  const gained = 3 + Math.floor(Math.random() * 3); // 3~5
  req.user.coins = (req.user.coins || 0) + gained;
  req.user.checkinCoins = (req.user.checkinCoins || 0) + gained;
  req.user.lastCheckin = today;
  req.user.checkinCount = (req.user.checkinCount || 0) + 1;
  addExp(db, req.user, 3);
  if (req.user.checkinCount >= 7) unlockAch(db, req.user.id, 'checkin-7');
  if (req.user.checkinCount >= 30) unlockAch(db, req.user.id, 'checkin-30');
  saveDb(db);
  res.json({ ok: true, gained, coins: req.user.coins, lastCheckin: today, level: userLevel(req.user) });
});

app.get('/api/rank/checkin', (req, res) => {
  const db = loadDb();
  const list = db.users.slice().sort((a, b) => (b.checkinCoins || 0) - (a.checkinCoins || 0)).slice(0, 50)
    .map(u => ({ username: u.username, name: u.name, avatar: u.avatar, coins: u.checkinCoins || 0 }));
  res.json(list);
});

app.get('/api/rank/coins', (req, res) => {
  const db = loadDb();
  const list = db.users.slice().sort((a, b) => (b.coins || 0) - (a.coins || 0)).slice(0, 50)
    .map(u => ({ username: u.username, name: u.name, avatar: u.avatar, coins: u.coins || 0 }));
  res.json(list);
});

app.get('/api/rank/level', (req, res) => {
  const db = loadDb();
  const list = db.users.filter(u => u.id !== GHOST.id).slice().sort((a, b) => (b.exp || 0) - (a.exp || 0)).slice(0, 50)
    .map(u => { const lv = userLevel(u); return { username: u.username, name: u.name, avatar: u.avatar, exp: lv.exp, level: lv.level, levelTitle: lv.levelTitle }; });
  res.json(list);
});

/* ================= v8 玩法 API：积分商城 ================= */
app.get('/api/shop/items', (req, res) => {
  const db = loadDb();
  const mine = new Set(req.user ? (req.user.badges || []) : []);
  res.json((db.shopItems || []).map(it => ({
    ...it, owned: it.type === 'badge' ? mine.has(it.value) : (req.user && it.type === 'title' && it.value !== '__CUSTOM__' && req.user.title === it.value),
  })));
});

app.post('/api/shop/buy', requireAuth, (req, res) => {
  const db = loadDb();
  const item = (db.shopItems || []).find(x => x.id === (req.body && req.body.itemId));
  if (!item) return res.status(404).json({ error: '商品不存在' });
  if (item.stock === 0) return res.status(400).json({ error: '商品已售罄' });
  if ((req.user.coins || 0) < item.price) return res.status(400).json({ error: '鸡腿不足，先去签到攒鸡腿吧' });
  let titleText = '';
  if (item.type === 'badge') {
    if ((req.user.badges || []).includes(item.value)) return res.status(400).json({ error: '已拥有该徽章' });
    req.user.badges = req.user.badges || [];
    req.user.badges.push(item.value);
  } else if (item.type === 'title') {
    titleText = item.value === '__CUSTOM__' ? String((req.body && req.body.customTitle) || '').trim().slice(0, 12) : item.value;
    if (item.value === '__CUSTOM__' && !titleText) return res.status(400).json({ error: '请填写自定义头衔' });
    /* 头衔进库存，可随时切换佩戴 */
    req.user.titles = req.user.titles || [];
    if (!req.user.titles.includes(titleText)) req.user.titles.push(titleText);
    req.user.title = titleText;
    req.user.titleExpireAt = item.value === '__CUSTOM__' ? new Date(Date.now() + 7 * 86400000).toISOString() : null;
  }
  req.user.coins -= item.price;
  if (item.stock > 0) item.stock -= 1;
  unlockAch(db, req.user.id, 'shop-buy');
  saveDb(db);
  res.json({ ok: true, coins: req.user.coins, title: req.user.title, badges: req.user.badges });
});

/* 切换佩戴头衔 */
app.post('/api/shop/wear-title', requireAuth, (req, res) => {
  const db = loadDb();
  const t = String((req.body || {}).title || '').trim().slice(0, 12);
  if (!t) return res.status(400).json({ error: '缺少头衔' });
  const owned = req.user.titles || [];
  if (!owned.includes(t) && req.user.title !== t) return res.status(403).json({ error: '你还没有这个头衔' });
  req.user.title = t;
  saveDb(db);
  res.json({ ok: true, title: t });
});
/* 卸下头衔 */
app.post('/api/shop/unwear-title', requireAuth, (req, res) => {
  const db = loadDb();
  req.user.title = '';
  saveDb(db);
  res.json({ ok: true });
});

/* 后台：商城商品管理 */
app.post('/api/admin/shop', requireAdmin, (req, res) => {
  const db = loadDb();
  const b = req.body || {};
  if (!b.name || !b.price) return res.status(400).json({ error: '缺少名称或价格' });
  const item = { id: id('shop'), name: String(b.name).slice(0, 30), icon: b.icon || '🎁', price: Math.max(1, Math.floor(Number(b.price))), type: b.type === 'title' ? 'title' : 'badge', value: String(b.value || b.name).slice(0, 30), desc: String(b.desc || '').slice(0, 100), stock: b.stock === undefined ? -1 : Math.max(0, Math.floor(Number(b.stock))) };
  db.shopItems.push(item);
  saveDb(db);
  res.json(item);
});
app.put('/api/admin/shop/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const item = (db.shopItems || []).find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '商品不存在' });
  const b = req.body || {};
  if (b.name !== undefined) item.name = String(b.name).slice(0, 30);
  if (b.price !== undefined) item.price = Math.max(1, Math.floor(Number(b.price)));
  if (b.icon !== undefined) item.icon = b.icon || '🎁';
  if (b.desc !== undefined) item.desc = String(b.desc || '').slice(0, 100);
  if (b.stock !== undefined) item.stock = Math.max(-1, Math.floor(Number(b.stock)));
  saveDb(db);
  res.json(item);
});
app.delete('/api/admin/shop/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const i = (db.shopItems || []).findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '商品不存在' });
  db.shopItems.splice(i, 1);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= v8 玩法 API：打赏 / 悬赏 / 采纳 ================= */
app.post('/api/topics/:id/tip', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const amount = Math.floor(Number((req.body && req.body.amount)) || 0);
  if (amount < 1 || amount > 10000) return res.status(400).json({ error: '打赏金额需在 1-10000 鸡腿之间' });
  if ((req.user.coins || 0) < amount) return res.status(400).json({ error: '鸡腿不足' });
  const replyId = (req.body && req.body.replyId) || null;
  const targetPost = replyId ? topic.posts.find(p => p.id === replyId) : topic.posts[0];
  if (!targetPost) return res.status(404).json({ error: '目标回复不存在' });
  if (targetPost.userId === req.user.id) return res.status(400).json({ error: '不能打赏自己' });
  const targetUser = db.users.find(u => u.id === targetPost.userId);
  if (!targetUser) return res.status(404).json({ error: '目标用户不存在' });
  req.user.coins -= amount;
  targetUser.coins = (targetUser.coins || 0) + amount;
  topic.tips = topic.tips || [];
  topic.tips.push({ userId: req.user.id, targetPostId: targetPost.id, amount, createdAt: nowIso() });
  unlockAch(db, req.user.id, 'tip-give');
  addNotification(db, targetUser.id, 'tip', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, amount });
  saveDb(db);
  res.json({ ok: true, coins: req.user.coins, amount });
});

app.post('/api/topics/:id/accept', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.userId !== req.user.id && !STAFF_ROLES.includes(req.user.role)) return res.status(403).json({ error: '只有楼主或管理员可以采纳悬赏' });
  if (!topic.bounty) return res.status(400).json({ error: '该帖不是悬赏帖' });
  const replyId = String((req.body && req.body.replyId) || '');
  const target = topic.posts.find(p => p.id === replyId && p.postNumber > 1);
  if (!target) return res.status(404).json({ error: '采纳的回复不存在' });
  const targetUser = db.users.find(u => u.id === target.userId);
  if (!targetUser) return res.status(404).json({ error: '目标用户不存在' });
  if (targetUser.id === req.user.id) return res.status(400).json({ error: '不能采纳自己的回复' });
  targetUser.coins = (targetUser.coins || 0) + topic.bounty;
  addExp(db, targetUser, 10);
  unlockAch(db, targetUser.id, 'bounty-solve');
  addNotification(db, targetUser.id, 'bounty', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, amount: topic.bounty });
  topic.bestReplyId = target.id;
  topic.bounty = 0;
  saveDb(db);
  res.json({ ok: true, bestReplyId: target.id });
});

/* ================= v8 玩法 API：投票 ================= */
app.post('/api/topics/:id/poll/vote', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (!topic.poll) return res.status(400).json({ error: '该帖没有投票' });
  if (topic.closed) return res.status(403).json({ error: '帖子已关闭' });
  const picks = Array.isArray(req.body.picks) ? req.body.picks.map(Number) : [Number(req.body.optionIndex)];
  if (picks.some(i => !Number.isInteger(i) || i < 0 || i >= topic.poll.options.length)) return res.status(400).json({ error: '无效选项' });
  if (!topic.poll.multi && picks.length > 1) return res.status(400).json({ error: '该投票为单选' });
  const voters = topic.poll.voters || (topic.poll.voters = []);
  if (voters.includes(req.user.id)) {
    /* 改票：先撤销旧票 */
    topic.poll.options.forEach(o => { o.votes = o.votes.filter(v => v !== req.user.id); });
    voters.splice(voters.indexOf(req.user.id), 1);
  }
  voters.push(req.user.id);
  const uniq = [...new Set(picks)];
  uniq.forEach(i => topic.poll.options[i].votes.push(req.user.id));
  addExp(db, req.user, 1);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= v8 玩法 API：鸡腿交易（用户间转账） ================= */
app.post('/api/transfer', requireAuth, (req, res) => {
  const db = loadDb();
  const { to, amount, note } = req.body || {};
  const amt = Math.floor(Number(amount) || 0);
  if (amt < 1 || amt > 100000) return res.status(400).json({ error: '转账金额需在 1-100000 鸡腿之间' });
  const target = db.users.find(u => (u.username === to || u.name === to) && u.id !== GHOST.id);
  if (!target) return res.status(404).json({ error: '收款用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能转给自己' });
  if ((req.user.coins || 0) < amt) return res.status(400).json({ error: '鸡腿不足' });
  req.user.coins -= amt;
  target.coins = (target.coins || 0) + amt;
  db.transfers.push({ id: id('tr'), fromId: req.user.id, toId: target.id, amount: amt, note: String(note || '').slice(0, 100), createdAt: nowIso() });
  unlockAch(db, req.user.id, 'transfer');
  addNotification(db, target.id, 'transfer', { fromId: req.user.id, fromName: req.user.name || req.user.username, amount: amt });
  saveDb(db);
  res.json({ ok: true, coins: req.user.coins, amount: amt });
});

/* ================= v8 玩法 API：成就 ================= */
app.get('/api/achievements', (req, res) => {
  const db = loadDb();
  const mine = new Set(req.user ? (req.user.achievements || []) : []);
  res.json(ACHIEVEMENTS.map(a => ({ ...a, unlocked: mine.has(a.id) })));
});

/* ================= search ================= */
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const db = loadDb();
  if (!q) return res.json([]);
  const topics = db.topics.filter(t => t.title.toLowerCase().includes(q) || (t.posts[0]?.content || '').toLowerCase().includes(q) || (t.tags || []).some(x => x.toLowerCase().includes(q)));
  res.json(topics.map(t => enrichTopic(t, db)));
});

/* ================= users ================= */
/* 🌱 新用户墙（公开接口：只露用户名/头像/等级/注册时间，最近 30 人；须排在 /api/users/:id 之前） */
app.get('/api/users/new', (req, res) => {
  const db = loadDb();
  const list = db.users
    .filter(u => !u.banned)
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30)
    .map(u => { const lv = userLevel(u); return { username: u.username, name: u.name, avatar: u.avatar || null, level: lv.level, levelTitle: lv.levelTitle, createdAt: u.createdAt }; });
  res.json({ list });
});

app.get('/api/users/:id', (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id || u.username === req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const topics = db.topics.filter(t => t.userId === user.id);
  const replies = db.topics.reduce((a, t) => a + t.posts.filter(p => p.userId === user.id && p.postNumber > 1).length, 0);
  const followerCount = db.users.filter(u => (u.following || []).includes(user.id)).length;
  const isFollowing = req.user ? (req.user.following || []).includes(user.id) : false;
  res.json({ ...userPublic(user), topicCount: topics.length, replyCount: replies, joinedAt: user.createdAt, followerCount, isFollowing, topics: topics.sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt)).map(t => enrichTopic(t, db)) });
});

/* 等级进度面板（linux.do 式：多维数据展示） */
app.get('/api/users/:id/level-progress', (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id || u.username === req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const myTopics = db.topics.filter(t => t.userId === user.id);
  const replies = db.topics.reduce((a, t) => a + t.posts.filter(p => p.userId === user.id && p.postNumber > 1).length, 0);
  const likesReceived = myTopics.reduce((a, t) => a + (t.likeCount || 0), 0);
  const favReceived = myTopics.reduce((a, t) => a + (t.favoriteCount || 0), 0);
  const lv = userLevel(user);
  const next = LEVELS.find(L => L.lv === lv.level + 1);
  /* 各等级所需经验（供前端画全等级轴） */
  res.json({
    level: lv.level, levelTitle: lv.levelTitle, exp: lv.exp, nextExp: lv.nextExp, progress: lv.progress,
    nextTitle: next ? next.title : null,
    levels: LEVELS.map(L => ({ lv: L.lv, exp: L.exp, title: L.title })),
    stats: [
      { icon: '📝', label: '主题', value: myTopics.length },
      { icon: '💬', label: '回复', value: replies },
      { icon: '👍', label: '获赞', value: likesReceived },
      { icon: '⭐', label: '被收藏', value: favReceived },
      { icon: '📅', label: '签到天数', value: user.checkinCount || 0 },
      { icon: '🍗', label: '鸡腿', value: user.coins || 0 },
    ],
  });
});

/* 用户小卡片（轻量，供 hover 展示） */
app.get('/api/users/:id/card', (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id || u.username === req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const p = userPublic(user);
  const topicCount = db.topics.filter(t => t.userId === user.id).length;
  const replyCount = db.topics.reduce((a, t) => a + t.posts.filter(x => x.userId === user.id && x.postNumber > 1).length, 0);
  const likeGot = db.topics.filter(t => t.userId === user.id).reduce((a, t) => a + (t.likeCount || 0), 0);
  res.json({ username: p.username, name: p.name, avatar: p.avatar, role: p.role, level: p.level, levelTitle: p.levelTitle, coins: p.coins || 0, bio: p.bio || '', topicCount, replyCount, likeGot, joinedAt: user.createdAt });
});

/* ⚖️ 管理记录公示（公开可查） */
app.get('/api/modlogs', (req, res) => {
  const db = loadDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 30;
  const list = (db.modLogs || []).slice();
  res.json({ total: list.length, page, pageSize, logs: list.slice((page - 1) * pageSize, page * pageSize) });
});
/* ---- 🎲 幸运抽奖（确定性算法，种子公开可复算） ---- */
function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function tryLotteryDraw(db, lot, force) {
  if (lot.status === 'drawn') return { ok: true };
  const topic = db.topics.find(t => t.id === lot.topicId);
  if (!topic) return { ok: false, error: '关联帖子不存在' };
  const timeOk = lot.drawAt && Date.now() >= new Date(lot.drawAt).getTime();
  const floorOk = lot.targetFloors && topic.replyCount >= lot.targetFloors;
  if (!force && !timeOk && !floorOk) return { ok: false, error: '开奖条件未满足' };
  const floors = [];
  const seenUsers = new Set();
  topic.posts.forEach(p => {
    if (p.postNumber < lot.startFloor) return;
    if (lot.dedupe) { if (seenUsers.has(p.userId)) return; seenUsers.add(p.userId); }
    floors.push({ floor: p.postNumber, userId: p.userId });
  });
  if (!floors.length) return { ok: false, error: '暂无符合条件的楼层' };
  const rand = seededRandom(lot.id + '|' + lot.topicId + '|' + lot.createdAt);
  for (let i = floors.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const tmp = floors[i]; floors[i] = floors[j]; floors[j] = tmp; }
  lot.winners = floors.slice(0, Math.min(lot.prizeCount, floors.length)).map(f => {
    const u = db.users.find(x => x.id === f.userId);
    return { floor: f.floor, userId: f.userId, name: u ? u.name : '未知用户', username: u ? u.username : '' };
  });
  lot.status = 'drawn';
  lot.drawnAt = nowIso();
  lot.seedInfo = `种子=${lot.id}|${lot.topicId}|${lot.createdAt}（Fisher-Yates 洗牌，结果可复算验证）`;
  return { ok: true };
}
app.post('/api/lottery', requireAuth, (req, res) => {
  const db = loadDb();
  const { topicId, title, prizeCount, startFloor, dedupe, drawAt, targetFloors } = req.body || {};
  const topic = db.topics.find(t => t.id === topicId || t.slug === topicId);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.userId !== req.user.id && !['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: '只有楼主或管理员可以为该帖发起抽奖' });
  const lot = {
    id: id('lucky'), topicId: topic.id, topicTitle: topic.title,
    title: String(title || '').trim().slice(0, 40) || '幸运抽奖',
    prizeCount: Math.min(100, Math.max(1, parseInt(prizeCount) || 1)),
    startFloor: Math.max(2, parseInt(startFloor) || 2),
    dedupe: dedupe !== false,
    drawAt: drawAt ? new Date(drawAt).toISOString() : null,
    targetFloors: parseInt(targetFloors) || null,
    status: 'pending', winners: [], drawnAt: null, seedInfo: '',
    createdBy: req.user.id, createdByName: req.user.name, createdAt: nowIso(),
  };
  if (!lot.drawAt && !lot.targetFloors) return res.status(400).json({ error: '请设置开奖时间或目标楼层数' });
  db.lotteries.unshift(lot);
  saveDb(db);
  res.json({ ok: true, lottery: lot });
});
app.get('/api/lottery', (req, res) => {
  const db = loadDb();
  res.json((db.lotteries || []).map(l => ({ ...l, topicSlug: ((db.topics.find(t => t.id === l.topicId)) || {}).slug || '' })));
});
app.get('/api/lottery/:id', (req, res) => {
  const db = loadDb();
  const lot = (db.lotteries || []).find(l => l.id === req.params.id);
  if (!lot) return res.status(404).json({ error: '抽奖不存在' });
  tryLotteryDraw(db, lot, false);
  saveDb(db);
  const topic = db.topics.find(t => t.id === lot.topicId);
  res.json({ ...lot, topicSlug: topic ? (topic.slug || topic.id) : '', replyCount: topic ? topic.replyCount : 0 });
});
app.post('/api/lottery/:id/draw', requireAuth, (req, res) => {
  const db = loadDb();
  const lot = (db.lotteries || []).find(l => l.id === req.params.id);
  if (!lot) return res.status(404).json({ error: '抽奖不存在' });
  if (lot.createdBy !== req.user.id && !['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: '只有发起人或管理员可以开奖' });
  if (lot.status === 'drawn') return res.status(400).json({ error: '已开奖' });
  const r = tryLotteryDraw(db, lot, true);
  saveDb(db);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, lottery: lot });
});
/* 用户关注 / 取消关注 */
app.post('/api/users/:id/follow', requireAuth, (req, res) => {
  const db = loadDb();
  const target = db.users.find(u => u.id === req.params.id || u.username === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能关注自己' });
  const list = req.user.following || (req.user.following = []);
  const i = list.indexOf(target.id);
  const following = i < 0;
  if (following) list.push(target.id); else list.splice(i, 1);
  saveDb(db);
  if (following) addNotification(db, target.id, 'mention', { title: '新粉丝', content: `${req.user.name || req.user.username} 关注了你`, link: '/space/' + req.user.username });
  saveDb(db);
  const followerCount = db.users.filter(u => (u.following || []).includes(target.id)).length;
  res.json({ following, followerCount });
});

/* ================= admin ================= */
const GHOST = { id: 'ghost-user', username: 'deleted', name: '已注销用户', avatar: null, email: '', role: 'user', trustLevel: 0, coins: 0, banned: false };

function adminUserJson(u, db) {
  const topics = db.topics.filter(t => t.userId === u.id);
  const replies = db.topics.reduce((a, t) => a + t.posts.filter(p => p.userId === u.id && p.postNumber > 1).length, 0);
  return { ...userPublic(u), banned: !!u.banned, email: u.email, createdAt: u.createdAt, lastCheckin: u.lastCheckin || '', checkinCoins: u.checkinCoins || 0, topicCount: topics.length, replyCount: replies, favoriteCount: (u.favorites || []).length };
}

/* 公开统计（关于页用，无需管理员权限） */
app.get('/api/stats', (req, res) => {
  const db = loadDb();
  const cs = sqlStats();
  res.json({
    users: db.users.filter(u => u.id !== GHOST.id).length,
    topics: db.topics.length,
    replies: db.topics.reduce((a, t) => a + t.posts.length - 1, 0),
    boards: db.boards.length,
    totalCompanies: cs ? cs.total : (loadCompanyCatalog() || []).length,
  });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = loadDb();
  const today = todayStr();
  const weekAgo = Date.now() - 7 * 86400000;
  res.json({
    users: db.users.filter(u => u.id !== GHOST.id).length,
    bannedUsers: db.users.filter(u => u.banned).length,
    topics: db.topics.length,
    replies: db.topics.reduce((a, t) => a + t.posts.length - 1, 0),
    boards: db.boards.length,
    tags: db.tags.length,
    newUsersToday: db.users.filter(u => u.id !== GHOST.id && todayStr(new Date(u.createdAt)) === today).length,
    newTopicsToday: db.topics.filter(t => todayStr(new Date(t.createdAt)) === today).length,
    checkinsToday: db.users.filter(u => u.lastCheckin === today).length,
    totalCoins: db.users.reduce((a, u) => a + (u.coins || 0), 0),
    totalViews: db.topics.reduce((a, t) => a + (t.viewCount || 0), 0),
    totalFavorites: db.topics.reduce((a, t) => a + (t.favoriteCount || 0), 0),
    activeUsers7d: db.users.filter(u => u.lastCheckin && new Date(u.lastCheckin).getTime() > weekAgo).length,
    codesTotal: (db.regCodes || []).length,
    codesUsed: (db.regCodes || []).filter(c => c.usedBy).length,
    owners: db.users.filter(u => u.role === 'owner').length,
    admins: db.users.filter(u => u.role === 'admin').length,
  });
});

/* 14 日趋势：每日新增用户 / 主题 / 回复 */
app.get('/api/admin/stats/trend', requireAdmin, (req, res) => {
  const db = loadDb();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(todayStr(d));
  }
  const trend = days.map(day => {
    const newUsers = db.users.filter(u => u.id !== GHOST.id && u.createdAt && todayStr(new Date(u.createdAt)) === day).length;
    const newTopics = db.topics.filter(t => t.createdAt && todayStr(new Date(t.createdAt)) === day).length;
    let newReplies = 0;
    db.topics.forEach(t => { (t.posts || []).forEach((p, idx) => { if (idx > 0 && p.createdAt && todayStr(new Date(p.createdAt)) === day) newReplies++; }); });
    return { day: day.slice(5), newUsers, newTopics, newReplies };
  });
  res.json({ trend });
});

/* ================= admin: 全站公告 ================= */
app.get('/api/admin/announcements', requireAdmin, (req, res) => {
  res.json(loadDb().announcements || []);
});
app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const db = loadDb();
  const { title, content, active } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '公告标题必填' });
  const a = { id: id('an'), title: String(title).slice(0, 60), content: String(content || '').slice(0, 500), active: active !== false, createdAt: nowIso(), createdBy: req.user.name };
  db.announcements.unshift(a);
  modLog(db, '发布公告', req.user, '', `《${a.title}》`);
  saveDb(db);
  res.status(201).json(a);
});
app.put('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const a = (db.announcements || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  const { title, content, active } = req.body || {};
  if (title !== undefined) a.title = String(title).slice(0, 60);
  if (content !== undefined) a.content = String(content || '').slice(0, 500);
  if (active !== undefined) a.active = !!active;
  saveDb(db);
  res.json(a);
});
app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.announcements || []).findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '公告不存在' });
  const [a] = db.announcements.splice(idx, 1);
  modLog(db, '删除公告', req.user, '', `《${a.title}》`);
  saveDb(db);
  res.json({ ok: true });
});
/* 公开：生效中的公告（首页横幅） */
app.get('/api/announcements', (req, res) => {
  res.json((loadDb().announcements || []).filter(a => a.active).slice(0, 5));
});

/* ================= 📰 每日新闻自动播报（Vercel Cron 触发） ================= */
/* 数据源：TrendRadar 同款 NewsNow 聚合 API（newsnow.busiyi.world），单接口覆盖全平台热榜 */
const NEWS_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
async function fetchJson(url, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: NEWS_UA, signal: c.signal }); return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}
/* NewsNow 平台源：id / 表情 / 名称 / 取条数 */
const NEWS_SOURCES = [
  { id: 'weibo', emoji: '🔥', name: '微博热搜', n: 10 },
  { id: 'douyin', emoji: '🎬', name: '抖音热点', n: 10 },
  { id: 'toutiao', emoji: '📰', name: '今日头条', n: 8 },
  { id: 'hupu', emoji: '🏀', name: '虎扑热搜', n: 8 },
  { id: 'zhihu', emoji: '💬', name: '知乎热榜', n: 8 },
  { id: 'cls', emoji: '💰', name: '财经快讯', n: 8 },
  { id: 'sspai', emoji: '💻', name: '科技前沿', n: 8 },
];
async function getNewsNow(id) {
  const d = await fetchJson(`https://newsnow.busiyi.world/api/s?id=${id}&latest`);
  if (!d || !['success', 'cache'].includes(d.status)) return [];
  return (d.items || []).map(x => ({ title: String(x.title || '').trim(), url: x.url || x.mobileUrl || '' })).filter(x => x.title);
}
/* TG 推送：按 4000 字符分块发送（HTML 格式） */
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function pushTelegram(sections, dateTag) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: '未配置 TG' };
  const chunks = [];
  let cur = `<b>📰 每日吃瓜速报 · ${escHtml(dateTag)}</b>\n`;
  for (const s of sections) {
    let block = `\n<b>${s.emoji} ${escHtml(s.name)}</b>\n`;
    s.items.forEach((x, i) => { block += `${i + 1}. <a href="${x.url}">${escHtml(x.title)}</a>\n`; });
    if ((cur + block).length > 4000) { chunks.push(cur); cur = block; }
    else cur += block;
  }
  if (cur.trim()) chunks.push(cur);
  let sent = 0;
  for (const text of chunks) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if ((await r.json()).ok) sent++;
    } catch { /* 忽略单条失败 */ }
    await new Promise(r => setTimeout(r, 600));
  }
  return { ok: sent > 0, sent, total: chunks.length };
}
app.get('/api/cron/daily-news', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'chigua') || db.boards[0];
  const bot = db.users.find(u => u.username === 'newsbot');
  if (!bot || !board) return res.status(500).json({ error: '机器人或板块未就绪' });
  /* 北京时间日期 */
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const M = now.getUTCMonth() + 1, D = now.getUTCDate();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getUTCDay()];
  const dateTag = `${M}月${D}日`;
  const title = `📰 每日吃瓜速报 · ${dateTag}`;
  /* 当天已发过就跳过 */
  if (db.topics.some(t => t.userId === bot.id && t.title === title)) return res.json({ ok: true, skipped: true, reason: '今日已播报' });
  const results = await Promise.all(NEWS_SOURCES.map(async s => ({ ...s, items: (await getNewsNow(s.id)).slice(0, s.n) })));
  const sec = (s) => {
    if (!s.items.length) return '';
    const lines = s.items.map((x, i) => `${i + 1}. [${x.title}](${x.url})`);
    return `\n## ${s.emoji} ${s.name}\n\n${lines.join('\n')}\n`;
  };
  const srcNames = results.filter(s => s.items.length).map(s => s.name).join(' · ');
  const content = `> 🤖 数据来源：${srcNames}（TrendRadar 同款聚合），机器人每日早上 8 点自动抓取整理，仅供吃瓜参考。\n`
    + results.map(sec).join('')
    + `\n---\n🍉 今日份的瓜已送达，欢迎在评论区补充你看到的大瓜～`;
  const time = nowIso();
  const topicId = id('tp');
  const topic = {
    id: topicId, title, slug: slugify(title), boardId: board.id, userId: bot.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: ['每日速报', '吃瓜'], posts: [{ id: id('p'), topicId, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
    pinned: false, recommended: false, price: 0, closed: false,
    poll: null, bounty: 0, bestReplyId: null,
    prefix: '速报',
  };
  db.topics.push(topic);
  board.topicCount = (board.topicCount || 0) + 1;
  saveDb(db);
  /* 同步推送到 TG */
  const tg = await pushTelegram(results.filter(s => s.items.length), dateTag).catch(() => ({ ok: false }));
  res.json({ ok: true, topicId, counts: Object.fromEntries(results.map(s => [s.id, s.items.length])), tg });
});

/* ===== 电报树洞投稿审核（管理员）：待审核列表 / 通过（同步电报自有频道）/ 拒绝 ===== */
async function tgPublishTopic(topic) {
  const token = process.env.TG_BOT_TOKEN || '';
  const chatRaw = String(process.env.TG_OWN_CHANNEL || '').trim();
  const chat = !chatRaw || /^-?\d+$/.test(chatRaw) || chatRaw.startsWith('@') ? chatRaw : '@' + chatRaw;
  if (!token || !chat) return { skipped: true, reason: 'TG 未配置' };
  const raw = (topic.posts[0] && topic.posts[0].content) || '';
  const imgM = raw.match(/!\[[^\]]*\]\((https?:[^)\s]+)\)/);
  let text = ((topic.title || '') + '\n\n' + raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '')).trim();
  text = text.replace(/https?:\/\/t\.me\/[^\s)]+/g, '').replace(/@\w{3,}/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000); /* 过滤电报链接与引流@ */
  const base = `https://api.telegram.org/bot${token}`;
  /* TG 投稿带照片：先向 TG 取原图再转发到频道（file_id 只有本机器人可用，走 getFile 下载） */
  if (topic.tgPhotoFileId) {
    try {
      const gf = await (await fetch(`${base}/getFile?file_id=${encodeURIComponent(topic.tgPhotoFileId)}`)).json();
      const filePath = gf && gf.result && gf.result.file_path;
      if (filePath) {
        const fr = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
        if (fr.ok) {
          const buf = Buffer.from(await fr.arrayBuffer());
          const fd = new FormData();
          fd.append('chat_id', chat);
          fd.append('caption', text.slice(0, 1024));
          fd.append('protect_content', 'true');
          fd.append('photo', new Blob([buf]), 'photo.jpg');
          const resp = await fetch(`${base}/sendPhoto`, { method: 'POST', body: fd });
          const data = await resp.json().catch(() => ({}));
          if (data.ok) return { messageId: data.result && data.result.message_id };
        }
      }
    } catch (e) { /* 取图失败则退回纯文字发布 */ }
  }
  const payload = imgM
    ? { url: base + '/sendPhoto', body: { chat_id: chat, photo: imgM[1], caption: text.slice(0, 1024), protect_content: true } }
    : { url: base + '/sendMessage', body: { chat_id: chat, text: text || topic.title, protect_content: true } };
  const resp = await fetch(payload.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.body) });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || ('TG HTTP ' + resp.status));
  return { messageId: data.result && data.result.message_id };
}

/* TG 投稿入口：聊天机器人 webhook 转发来的私聊投稿，进电报树洞待审核（共享密钥 TG_SUBMIT_SECRET） */
app.post('/api/integrations/tg-submit', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  if (!secret) return res.status(503).json({ error: '投稿入口未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const body = req.body || {};
  const photoFileId = String(body.photoFileId || '');
  const content = String(body.content || '').trim().slice(0, 4000) || (photoFileId ? '📷 图片投稿' : '');
  if (!content) return res.status(400).json({ error: '内容为空' });
  const tgName = String(body.tgName || 'TG用户').trim().slice(0, 30) || 'TG用户';
  const source = body.source === 'chat' ? 'chat' : 'tg';
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  if (!board) return res.status(404).json({ error: '树洞板块不存在' });
  const bot = db.users.find(u => u.username === 'tgbot');
  if (!bot) return res.status(500).json({ error: '搬运机器人不存在' });
  const time = nowIso();
  const title = content.replace(/\s+/g, ' ').slice(0, 30) || '树洞投稿';
  const topic = {
    id: id('tp'), title, slug: slugify(title) + '-tg' + Date.now().toString(36), boardId: board.id, userId: bot.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: [source === 'chat' ? '聊天投稿' : 'TG投稿'], posts: [], pinned: false, recommended: false, price: 0, closed: false, minLevel: 1,
    poll: null, bounty: 0, bestReplyId: null, prefix: '',
    status: 'pending', anonymous: !!body.anonymous, tgSubmitter: tgName, tgSubmitterId: String(body.tgUserId || ''),
    source,
    tgPhotoFileId: photoFileId,
  };
  topic.posts.push({ id: id('p'), topicId: topic.id, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 });
  db.topics.push(topic);
  saveDb(db);
  await flushNow();
  res.status(201).json({ ok: true, topicId: topic.id });
});

/* 自有频道新帖存档：聊天机器人 webhook 实时转发 channel_post，直接发到树洞（按 tgMid+频道去重） */
app.post('/api/integrations/tg-post', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  if (!secret) return res.status(503).json({ error: '未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const body = req.body || {};
  const tgMid = parseInt(body.tgMid, 10) || 0;
  const text = String(body.content || '').trim().slice(0, 4000);
  if (!tgMid || (!text && !body.photoFileId && !body.videoFileId)) return res.status(400).json({ error: '内容为空' });
  const ownChannel = String(process.env.TG_OWN_CHANNEL || '').replace(/^@/, '');
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  if (!board) return res.status(404).json({ error: '树洞板块不存在' });
  if (db.topics.some(t => t.tgMid === tgMid && (t.tgChannel || '') === ownChannel)) return res.json({ ok: true, created: false });
  const bot = db.users.find(u => u.username === 'tgbot');
  if (!bot) return res.status(500).json({ error: '搬运机器人不存在' });
  const time = body.at && !isNaN(new Date(body.at).getTime()) ? new Date(body.at).toISOString() : nowIso();
  const flat = text.replace(/\s+/g, ' ').trim();
  const title = flat ? flat.slice(0, 30) : '树洞投稿';
  const mediaNote = body.photoFileId ? '\n\n🖼 [图片见电报频道原帖]' : (body.videoFileId ? '\n\n🎬 [视频见电报频道原帖]' : '');
  const content = `> 🤖 转自 Telegram 树洞频道，由「树洞投稿机器人」自动同步\n\n${text}${mediaNote}\n\n[查看原帖](https://t.me/${ownChannel}/${tgMid})`;
  const topic = {
    id: id('tp'), title, slug: slugify(title) + '-' + tgMid, boardId: board.id, userId: bot.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: ['树洞'], posts: [], pinned: false, recommended: false, price: 0, closed: false, minLevel: 1,
    poll: null, bounty: 0, bestReplyId: null, prefix: '树洞',
    tgMid, tgChannel: ownChannel, tgCommentIds: [], tgCommentMin: 0, tgCommentsDone: false,
  };
  topic.posts.push({ id: id('p'), topicId: topic.id, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 });
  db.topics.push(topic);
  board.topicCount = (board.topicCount || 0) + 1;
  saveDb(db);
  await flushNow();
  res.status(201).json({ ok: true, created: true, topicId: topic.id });
});

app.get('/api/admin/review-topics', requireAdmin, (req, res) => {
  const db = loadDb();
  const list = db.topics.filter(t => t.status === 'pending').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ list: list.map(t => enrichTopic(t, db, { withPosts: true })) });
});

/* 投稿备注行：来自哪个入口、实名（带投稿人）还是匿名。发布时加到正文头部，存量投稿一次性补齐。 */
function submissionNoteHeader(db, topic) {
  const srcLabel = topic.source === 'chat' ? '聊天投稿'
    : topic.source === 'tg' ? '电报投稿'
    : topic.source === 'import' ? '电报频道搬运'
    : (Array.isArray(topic.tags) && topic.tags.includes('聊天投稿')) ? '聊天投稿'
    : (Array.isArray(topic.tags) && topic.tags.includes('TG投稿')) ? '电报投稿'
    : '论坛投稿';
  const au = db.users.find(u => u.id === topic.userId);
  const who = topic.anonymous
    ? '匿名投稿'
    : `实名投稿 · ${topic.tgSubmitter || (au && (au.name || au.username)) || '投稿人'}`;
  return `> 🌳 来自${srcLabel} · ${who}`;
}

/* 审核通过的统一动作：公开帖子 + 发电报频道 + 同步聊天树洞频道。总控网页与 TG 机器人按钮共用。 */
async function doApproveTopic(db, topic) {
  /* 投稿备注（导入帖已有「转自」落款的不重复加） */
  const firstPost = topic.posts && topic.posts[0];
  if (firstPost && typeof firstPost.content === 'string' && !firstPost.content.startsWith('> ')) {
    firstPost.content = `${submissionNoteHeader(db, topic)}\n\n${firstPost.content}`;
  }
  topic.status = 'published';
  const board = boardById(db, topic.boardId);
  if (board) board.topicCount = (board.topicCount || 0) + 1;
  let tg = { skipped: true, reason: 'TG 未配置' };
  try {
    tg = await tgPublishTopic(topic);
    if (tg.messageId) { topic.tgMid = tg.messageId; topic.tgChannel = String(process.env.TG_OWN_CHANNEL || '').replace(/^@/, ''); }
  } catch (e) {
    tg = { error: String(e.message || e).slice(0, 200) };
    topic.tgPublishError = tg.error;
  }
  /* 同步到聊天「树洞」频道，机器人代发；失败只记录不拦审核 */
  let chat = { skipped: true, reason: '聊天同步未配置' };
  const chatUrl = process.env.CHAT_TREEHOLE_URL || '';
  const chatSecret = process.env.CHAT_TREEHOLE_SECRET || '';
  if (chatUrl && chatSecret) {
    try {
      const au = db.users.find(u => u.id === topic.userId);
      const authorName = topic.tgSubmitter || (topic.anonymous ? '' : ((au && (au.name || au.username)) || ''));
      const r = await fetch(chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sync-secret': chatSecret }, body: JSON.stringify({ topicId: topic.id, authorName, anonymous: !!topic.anonymous, content: ((topic.posts[0] || {}).content || '').slice(0, 4000) }) });
      chat = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      if (!r.ok) topic.chatSyncError = String((chat && chat.error) || r.status).slice(0, 200);
    } catch (e) {
      chat = { error: String(e.message || e).slice(0, 200) };
      topic.chatSyncError = chat.error;
    }
  }
  return { tg, chat };
}

app.post('/api/admin/topics/:id/approve', requireAdmin, async (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.status !== 'pending') return res.status(400).json({ error: '该帖子不在待审核状态' });
  const { tg, chat } = await doApproveTopic(db, topic);
  saveDb(db);
  await flushNow();
  res.json({ ok: true, tg, chat, topic: enrichTopic(topic, db) });
});

/* 机器人审核通道：TG 里点「通过/拒绝」按钮时由聊天后端转发过来（共享密钥 TG_SUBMIT_SECRET） */
app.post('/api/integrations/tg-review', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  if (!secret) return res.status(503).json({ error: '未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const body = req.body || {};
  const db = loadDb();
  const topic = db.topics.find(t => t.id === String(body.topicId || ''));
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.status !== 'pending') return res.status(400).json({ error: '该帖子不在待审核状态' });
  if (body.action === 'approve') {
    const { tg, chat } = await doApproveTopic(db, topic);
    saveDb(db);
    await flushNow();
    return res.json({ ok: true, tg, chat });
  }
  if (body.action === 'reject') {
    topic.status = 'rejected';
    saveDb(db);
    await flushNow();
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: '未知操作' });
});

app.post('/api/admin/topics/:id/reject', requireAdmin, async (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.status !== 'pending') return res.status(400).json({ error: '该帖子不在待审核状态' });
  topic.status = 'rejected';
  saveDb(db);
  await flushNow();
  res.json({ ok: true });
});

/* 机器人删帖通道：密钥校验后删除指定帖子（供机器人后台管理/清理联调帖，共享密钥 TG_SUBMIT_SECRET） */
app.post('/api/integrations/topic-delete', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  if (!secret) return res.status(503).json({ error: '未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const topicId = String((req.body || {}).topicId || '');
  const db = loadDb();
  const idx = db.topics.findIndex(t => t.id === topicId);
  if (idx < 0) return res.status(404).json({ error: '帖子不存在' });
  const topic = db.topics[idx];
  if (topic.status === 'published') {
    const board = boardById(db, topic.boardId);
    if (board && board.topicCount > 0) board.topicCount -= 1;
  }
  db.topics.splice(idx, 1);
  saveDb(db);
  await flushNow();
  res.json({ ok: true, deleted: topicId });
});

/* 待审列表（机器人通道）：供聊天后台「树洞机器人」页读取统一待审队列（共享密钥 TG_SUBMIT_SECRET） */
app.get('/api/integrations/review-list', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  if (!secret) return res.status(503).json({ error: '未启用' });
  if (String(req.headers['x-sync-secret'] || '') !== secret) return res.status(401).json({ error: '密钥不正确' });
  const db = loadDb();
  const list = db.topics
    .filter(t => t.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(t => ({
      id: t.id,
      title: t.title || '',
      content: String((t.posts[0] || {}).content || '').slice(0, 600),
      author: t.anonymous ? '匿名' : (t.tgSubmitter || ''),
      anonymous: !!t.anonymous,
      source: t.source || (Array.isArray(t.tags) && t.tags.includes('聊天投稿') ? 'chat' : (Array.isArray(t.tags) && t.tags.includes('TG投稿') ? 'tg' : 'forum')),
      hasPhoto: !!t.tgPhotoFileId,
      createdAt: t.createdAt || '',
    }));
  res.json({ ok: true, list });
});

/* 同步动态（给聊天后台「树洞机器人」页展示）：树洞板块总量、待审数、旧频道搬运进度、最近帖子的三端同步状态 */
app.get('/api/integrations/sync-feed', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  const secretOk = secret && String(req.headers['x-sync-secret'] || '') === secret;
  const staffOk = req.user && STAFF_ROLES.includes(req.user.role);
  if (!secretOk && !staffOk) return res.status(401).json({ error: '密钥不正确' });
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  const inBoard = board ? db.topics.filter(t => t.boardId === board.id) : [];
  const recent = inBoard
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(t => ({
      id: t.id,
      title: t.title || '',
      createdAt: t.createdAt || '',
      status: t.status || 'published',
      source: t.source || (Array.isArray(t.tags) && t.tags.includes('聊天投稿') ? 'chat' : (Array.isArray(t.tags) && t.tags.includes('TG投稿') ? 'tg' : '')),
      tgMid: t.tgMid || t.tgFromMid || null,
      tgError: t.tgPublishError || '',
      chatError: t.chatSyncError || '',
    }));
  const st = db.tgSyncState || {};
  const ownChannel = String(process.env.TG_OWN_CHANNEL || '').replace(/^@/, '');
  const srcOf = (t) => {
    if (t.source === 'chat' || t.source === 'tg' || t.source === 'import') return t.source;
    if (Array.isArray(t.tags) && t.tags.includes('聊天投稿')) return 'chat';
    if (Array.isArray(t.tags) && t.tags.includes('TG投稿')) return 'tg';
    if (t.tgFromMid) return 'import';
    if (t.tgMid && t.tgChannel) return t.tgChannel === ownChannel ? 'tg' : 'import';
    const body0 = String(((t.posts || [])[0] || {}).content || '');
    const linkM = body0.match(/t\.me\/([A-Za-z0-9_]+)\//);
    if (linkM) return linkM[1] === ownChannel ? 'tg' : 'import';
    if (body0.slice(0, 60).includes('转自 Telegram')) return 'import';
    return 'forum';
  };
  const isPub = (t) => !t.status || t.status === 'published';
  const published = inBoard.filter(isPub);
  const todayKey = new Date().toISOString().slice(0, 10);
  const stats = {
    total: published.length,
    pending: inBoard.filter(t => t.status === 'pending').length,
    rejected: inBoard.filter(t => t.status === 'rejected').length,
    today: inBoard.filter(t => String(t.createdAt || '').slice(0, 10) === todayKey).length,
    anonymous: published.filter(t => t.anonymous).length,
    bySource: {
      chat: published.filter(t => srcOf(t) === 'chat').length,
      tg: published.filter(t => srcOf(t) === 'tg').length,
      forum: published.filter(t => srcOf(t) === 'forum').length,
      import: published.filter(t => srcOf(t) === 'import').length,
    },
  };
  res.json({
    ok: true,
    boardTopicCount: inBoard.filter(isPub).length,
    pendingCount: inBoard.filter(t => t.status === 'pending').length,
    stats,
    backfillDone: !!st.done,
    legacy: st.legacy ? { channel: st.legacy.channel || '', oldestId: st.legacy.oldestId || 0, done: !!st.legacy.done } : null,
    migrations: db.tgMigrations && typeof db.tgMigrations === 'object'
      ? Object.entries(db.tgMigrations).map(([ch, m]) => ({ channel: ch, tag: m.tag || '', anonymous: !!m.anonymous, oldestId: m.oldestId || 0, lastId: m.lastId || 0, done: !!m.done }))
      : [],
    recent,
  });
});

/* 批量转发：把某个公开 TG 频道的最新 N 条（广告过滤、去重）搬进树洞并同步 TG 频道+聊天频道。
   管理员在 TG 机器人发 /import 频道名 条数 或聊天后台触发（共享密钥 TG_SUBMIT_SECRET） */
app.post('/api/integrations/tg-import', async (req, res) => {
  const secret = process.env.TG_SUBMIT_SECRET || '';
  const secretOk = secret && String(req.headers['x-sync-secret'] || '') === secret;
  const staffOk = req.user && STAFF_ROLES.includes(req.user.role);
  if (!secretOk && !staffOk) return res.status(401).json({ error: '密钥不正确' });
  const body = req.body || {};
  const srcChannel = String(body.channel || '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!srcChannel) return res.status(400).json({ error: '频道名不能为空' });
  const count = Math.min(50, Math.max(1, parseInt(body.count, 10) || 20));
  const dryRun = !!body.dryRun;
  /* 日期范围（YYYY-MM-DD）：只搬这段时间内发布的帖子；给了范围就往回翻到起始日期为止 */
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const fromTs = dateRe.test(String(body.from || '')) ? new Date(body.from + 'T00:00:00Z').getTime() : 0;
  const toTs = dateRe.test(String(body.to || '')) ? new Date(body.to + 'T23:59:59Z').getTime() : 0;
  const TG_UA = { headers: { 'User-Agent': 'Mozilla/5.0 (JMForumTgSync/1.0)' } };
  const parseImportPosts = (pageHtml) => {
    const list = [];
    const wrapRe = /data-post="[^"/]+\/(\d+)"[\s\S]*?(?=data-post="[^"/]+\/\d+"|<\/main>|$)/g;
    let mm;
    while ((mm = wrapRe.exec(pageHtml)) !== null) {
      const block = mm[0];
      const mid = parseInt(mm[1], 10);
      if (!mid) continue;
      const textM = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      const text = tgStripHtml(textM ? textM[1] : '').slice(0, 4000);
      const imgM = block.match(/tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/);
      const timeM = block.match(/<time[^>]*datetime="([^"]+)"/);
      list.push({ mid, text, image: imgM ? imgM[1] : '', at: timeM ? timeM[1] : '' });
    }
    list.sort((a, b) => a.mid - b.mid);
    return list;
  };
  /* 从最新页往回翻：无日期范围时凑够 count 条；有范围时翻到起始日期之前为止（最多 12 页） */
  let posts = [];
  try {
    const r = await fetch(`https://t.me/s/${srcChannel}`, TG_UA);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    posts = parseImportPosts(await r.text());
    let pages = 1;
    while (posts.length) {
      const oldest = posts[0];
      const oldestTs = oldest.at ? new Date(oldest.at).getTime() : 0;
      const needMore = fromTs ? (oldestTs > fromTs && pages < 12) : (posts.length < count);
      if (!needMore) break;
      const before = oldest.mid;
      const r2 = await fetch(`https://t.me/s/${srcChannel}?before=${before}`, TG_UA);
      if (!r2.ok) break;
      const older = parseImportPosts(await r2.text());
      if (!older.length || older[0].mid >= before) break;
      posts = older.concat(posts);
      pages++;
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: '频道页拉取失败（私有频道或网络问题）：' + e.message });
  }
  if (!posts.length) return res.json({ ok: true, imported: 0, skippedAds: 0, skippedDup: 0, error: '没有抓到帖子：频道可能是私有频道，或还没有公开帖子' });
  /* 日期范围过滤（按发布时间，两端都含） */
  let inRange = posts;
  if (fromTs || toTs) {
    inRange = posts.filter(p => {
      const ts = p.at ? new Date(p.at).getTime() : 0;
      if (!ts) return false;
      if (fromTs && ts < fromTs) return false;
      if (toTs && ts > toTs) return false;
      return true;
    });
  }
  const matched = inRange.length;
  const targets = inRange.slice(-count);
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  if (!board) return res.status(404).json({ error: '树洞板块不存在' });
  let bot = db.users.find(u => u.username === 'tgbot');
  if (!bot) return res.status(500).json({ error: '搬运机器人不存在' });
  let skippedAds = 0, skippedDup = 0, wouldImport = 0;
  const imported = [];
  for (const p of targets) {
    if (!p.text && !p.image) continue;
    if (TG_AD_RE.test(p.text)) { skippedAds++; continue; }
    if (db.topics.some(t => t.tgFromMid === p.mid && t.tgFromChannel === srcChannel)) { skippedDup++; continue; }
    if (db.topics.some(t => t.boardId === board.id && t.tgMid === p.mid && (t.tgChannel || '') === srcChannel)) { skippedDup++; continue; }
    if (db.topics.some(t => t.boardId === board.id && t.slug && t.slug.endsWith('-' + p.mid) && ((t.tgChannel || '') === srcChannel || (t.tgFromChannel || '') === srcChannel))) { skippedDup++; continue; }
    if (dryRun) { wouldImport++; continue; }
    const time = p.at && !isNaN(new Date(p.at).getTime()) ? new Date(p.at).toISOString() : nowIso();
    const flat = p.text.replace(/\s+/g, ' ').trim();
    const title = flat ? flat.slice(0, 30) : '树洞图片投稿';
    const content = `> 🤖 转自 Telegram 频道 @${srcChannel}，由「树洞投稿机器人」自动同步\n\n${p.text}${p.image ? `\n\n![](${p.image})` : ''}\n\n[查看原帖](https://t.me/${srcChannel}/${p.mid})`;
    const topic = {
      id: id('tp'), title, slug: slugify(title) + '-' + p.mid, boardId: board.id, userId: bot.id,
      createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
      tags: ['频道搬运'], posts: [], pinned: false, recommended: false, price: 0, closed: false, minLevel: 1,
      poll: null, bounty: 0, bestReplyId: null, prefix: '树洞',
      status: 'pending', anonymous: false, tgFromMid: p.mid, tgFromChannel: srcChannel, source: 'import',
    };
    topic.posts.push({ id: id('p'), topicId: topic.id, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 });
    db.topics.push(topic);
    await doApproveTopic(db, topic); /* 公开 + 发 TG 自有频道 + 同步聊天树洞频道 */
    imported.push(topic.id);
  }
  if (!dryRun && imported.length) { saveDb(db); await flushNow(); }
  res.json({ ok: true, imported: dryRun ? 0 : imported.length, wouldImport, skippedAds, skippedDup, matched, ranged: !!(fromTs || toTs), topicIds: imported });
});

/* 📝 博客文章自动同步：每小时拉取博客 search.xml，新文章自动发帖到「博客同步」板块 */
app.get('/api/cron/blog-sync', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  const db = loadDb();
  /* 机器人账号 */
  let bot = db.users.find(u => u.username === 'blogbot');
  if (!bot) {
    bot = {
      id: id('u'), username: 'blogbot', name: '博客同步姬', passwordHash: '',
      avatar: '', createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 0,
      checkinCoins: 0, lastCheckin: '', favorites: [],
      bio: '🤖 博客有新文章时自动同步到论坛',
      signature: '', readme: '', contacts: {}, preferences: {},
      blocked: false, exp: 0, badges: [], title: '', achievements: {},
      checkinCount: 0, following: [],
    };
    db.users.push(bot);
  }
  /* 博客同步板块 */
  let board = db.boards.find(b => b.slug === 'blog');
  if (!board) {
    board = { id: id('b'), name: '博客同步', slug: 'blog', color: '#3b82f6', description: '马老师博客新文章自动同步', topicCount: 0 };
    db.boards.push(board);
  }
  if (!Array.isArray(db.blogSyncedUrls)) db.blogSyncedUrls = [];
  /* 拉取博客 search.xml */
  let xml = '';
  try {
    const r = await fetch('https://blog.8818618.xyz/search.xml', { headers: { 'User-Agent': 'JMForumBlogSync/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    xml = await r.text();
  } catch (e) {
    return res.status(502).json({ ok: false, error: '博客 search.xml 拉取失败：' + e.message });
  }
  const entries = [];
  const re = /<entry>\s*<title>([\s\S]*?)<\/title>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<content[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/content>/g;
  let m;
  while ((m = re.exec(xml)) && entries.length < 50) {
    entries.push({ title: m[1].trim(), url: m[2].trim(), html: m[3] });
  }
  /* 首次运行：只建基线，不补发旧文章，避免一次性刷屏（但同步最新一篇，让当前新文有帖子） */
  if (!db.blogSyncedUrls.length && entries.length) {
    const [newest, ...rest] = entries;
    db.blogSyncedUrls = rest.map(e => e.url);
    /* 同步最新一篇 */
    const text = newest.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const fullUrl = 'https://blog.8818618.xyz' + newest.url;
    const title = `📝 ${newest.title}`;
    const content = `> 🤖 本文由博客自动同步\n\n${text}${text.length >= 220 ? '…' : ''}\n\n📖 [阅读原文](${fullUrl})`;
    const time = nowIso();
    const topicId = id('tp');
    db.topics.push({
      id: topicId, title, slug: slugify(title), boardId: board.id, userId: bot.id,
      createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
      tags: ['博客同步'], posts: [{ id: id('p'), topicId, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
      pinned: false, recommended: false, price: 0, closed: false,
      poll: null, bounty: 0, bestReplyId: null,
      prefix: '博客',
    });
    board.topicCount = (board.topicCount || 0) + 1;
    db.blogSyncedUrls.push(newest.url);
    saveDb(db); await flushNow(); /* serverless 延迟写会被冻结杀掉，必须立即落盘 */
    return res.json({ ok: true, baseline: true, count: entries.length, synced: [newest.title] });
  }
  const forceUrl = req.query.force || ''; /* 强制补同步某篇（绕过去重） */
  const synced = [];
  for (const e of entries) {
    if (synced.length >= 10) break; /* 单次最多同步 10 篇，防刷屏 */
    const isForced = forceUrl && e.url === forceUrl;
    if (!isForced && db.blogSyncedUrls.includes(e.url)) continue;
    const text = e.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const fullUrl = 'https://blog.8818618.xyz' + e.url;
    const title = `📝 ${e.title}`;
    const content = `> 🤖 本文由博客自动同步\n\n${text}${text.length >= 220 ? '…' : ''}\n\n📖 [阅读原文](${fullUrl})`;
    const time = nowIso();
    const topicId = id('tp');
    db.topics.push({
      id: topicId, title, slug: slugify(title), boardId: board.id, userId: bot.id,
      createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
      tags: ['博客同步'], posts: [{ id: id('p'), topicId, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
      pinned: false, recommended: false, price: 0, closed: false,
      poll: null, bounty: 0, bestReplyId: null,
      prefix: '博客',
    });
    board.topicCount = (board.topicCount || 0) + 1;
    db.blogSyncedUrls.push(e.url);
    synced.push({ title: e.title, url: e.url, topicId });
  }
  if (synced.length) { saveDb(db); await flushNow(); } /* 立即落盘，防 serverless 冻结丢数据 */
  else saveDb(db);
  res.json({ ok: true, synced });
});

/* 额外 TG 频道整体迁移注册（如忏悔室）：登记后由 /api/cron/tg-sync 每轮自动搬（新帖+全部历史+评论），
   带自定义标签与匿名标注。鉴权：TG_SYNC_SECRET / TG_SUBMIT_SECRET / 论坛管理员会话 */
app.post('/api/integrations/tg-migrate', async (req, res) => {
  const header = String(req.headers['x-sync-secret'] || '');
  const secretOk = [process.env.TG_SYNC_SECRET, process.env.TG_SUBMIT_SECRET].some(s => s && header === s);
  const staffOk = req.user && STAFF_ROLES.includes(req.user.role);
  if (!secretOk && !staffOk) return res.status(401).json({ error: '密钥不正确' });
  const body = req.body || {};
  const migChannel = String(body.channel || '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!migChannel) return res.status(400).json({ error: '频道名不能为空' });
  if (IS_VERCEL) { try { const fresh = await kvGetThrottled(30000); if (fresh) cacheDb = fresh; } catch (e) { /* 同上 */ } }
  const db = loadDb();
  if (!db.tgMigrations || typeof db.tgMigrations !== 'object') db.tgMigrations = {};
  if (body.remove) {
    delete db.tgMigrations[migChannel];
    saveDb(db);
    await flushNow();
    return res.json({ ok: true, removed: migChannel });
  }
  const existing = db.tgMigrations[migChannel];
  if (!existing) {
    db.tgMigrations[migChannel] = {
      tag: String(body.tag || '').slice(0, 20),
      anonymous: !!body.anonymous,
      lastId: 0, oldestId: 0, done: false, emptyHits: 0,
      registeredAt: nowIso(),
    };
  } else {
    if (body.tag !== undefined) existing.tag = String(body.tag || '').slice(0, 20);
    if (body.anonymous !== undefined) existing.anonymous = !!body.anonymous;
    if (body.resume) { existing.done = false; existing.emptyHits = 0; }
  }
  saveDb(db);
  await flushNow();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  const already = board ? db.topics.filter(t => t.boardId === board.id && ((t.tgChannel || '') === migChannel || (t.tgFromChannel || '') === migChannel)).length : 0;
  res.json({ ok: true, channel: migChannel, migration: db.tgMigrations[migChannel], alreadyImported: already });
});

/* 原始 KV 读写（分片恢复中转用，绕开护栏，仅限 restore 流程内部使用） */
async function kvSetRaw(key, value) {
  const res = await fetch(`${KV_BASE}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!res.ok) throw new Error('KV set ' + key + ' ' + res.status);
}
async function kvGetRaw(key) {
  const res = await fetch(`${KV_BASE}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!res.ok) throw new Error('KV get ' + key + ' ' + res.status);
  const data = await res.json();
  return data.result === undefined ? null : data.result;
}
async function kvDelRaw(key) {
  await fetch(`${KV_BASE}/del/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` } }).catch(() => {});
}

/* 全库恢复·分片上传（密钥与 tg-sync 相同）：备份 gz1 体积超过 Vercel 单请求上限，
   先逐片存进 KV 临时键，再调 restore-assemble 拼回整库。恢复后须重新部署一次，
   让所有 serverless 实例丢弃内存里的旧快照。 */
app.post('/api/integrations/restore-chunk', express.text({ limit: '3mb', type: () => true }), async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const ok = secret && (req.headers['x-sync-secret'] === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  try {
    const idx = parseInt(req.query.i || '0', 10);
    const body = String(req.body || '');
    if (!body) return res.status(400).json({ error: 'empty chunk' });
    await kvSetRaw('jm_forum_restore_' + idx, body);
    res.json({ ok: true, i: idx, len: body.length });
  } catch (e) { res.status(500).json({ error: '分片保存失败：' + e.message }); }
});
app.post('/api/integrations/restore-assemble', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const ok = secret && (req.headers['x-sync-secret'] === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  try {
    let raw = '';
    for (let i = 0; i < 64; i++) {
      const part = await kvGetRaw('jm_forum_restore_' + i);
      if (part === null) break;
      raw += part;
    }
    if (!raw.startsWith('gz1:')) return res.status(400).json({ error: 'bad format: chunks do not form a gz1: payload' });
    const parsed = JSON.parse(require('zlib').gunzipSync(Buffer.from(raw.slice(4), 'base64')).toString('utf8'));
    if (!parsed || !Array.isArray(parsed.topics) || !Array.isArray(parsed.users)) {
      return res.status(400).json({ error: 'bad payload: topics/users missing' });
    }
    cacheDb = parsed;
    kvLoadedOk = true;
    maxTopicsSeen = parsed.topics.length;
    migrate(cacheDb);
    const posts = cacheDb.topics.reduce((n, t) => n + (t.posts || []).length, 0);
    await flushNow();
    for (let i = 0; i < 64; i++) kvDelRaw('jm_forum_restore_' + i);
    res.json({ ok: true, topics: cacheDb.topics.length, posts, users: cacheDb.users.length });
  } catch (e) { res.status(500).json({ error: '恢复失败：' + e.message }); }
});

/* 全库备份导出（密钥与 tg-sync 相同）：返回 gz1: 压缩全库，供定时备份脚本拉取存档 */
app.get('/api/integrations/backup', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const ok = secret && (req.headers['x-sync-secret'] === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  if (IS_VERCEL) { try { const fresh = await kvGetThrottled(30000); if (fresh) cacheDb = fresh; } catch (e) { /* 用现有快照 */ } }
  const db = loadDb();
  const packed = 'gz1:' + require('zlib').gzipSync(Buffer.from(JSON.stringify(db), 'utf8')).toString('base64');
  res.type('text/plain').send(packed);
});

/* 🌳 TG 频道自动搬运：定时抓 t.me/s/<频道> 公开页，新帖由「树洞搬运」发到「电报树洞」板块（广告过滤，TG_SYNC_SECRET 鉴权） */
const TG_AD_RE = /广告|推广|赞助|商务合作|招商|代理加盟|开户|充值返|博彩|赌场|下注|稳赚|副业项目|兼职招聘|日入|月入过万|加群|进群|入群|群推荐|频道推荐|优质频道|旗下频道|互推|资源群|福利群|点击链接|立即购买|购买链接|限时优惠|秒杀价|官网直达|客服微信|联系微信|扫码进|欢迎关注|点击下方|点此进入|➡|t\.me\/\+|telegram\.me\/\+/i;
/* 电报链接剥离（用户定：搬运内容里 t.me/telegram.me 链接一律过滤） */
const stripTgLinks = (s) => String(s || '')
  .replace(/\[([^\]]*)\]\((?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[^)]+\)/gi, '$1')
  .replace(/(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[^\s)）」』】>]+/gi, '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function tgStripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (mm, href, text) => {
      const t = text.replace(/<[^>]+>/g, '');
      return href && href !== t ? `${t} (${href})` : t;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.get('/api/cron/tg-sync', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.headers['x-sync-secret'] === secret || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  /* 批量写任务先回源 KV 刷新快照，避免拿实例里的旧数据整库覆盖掉并发写入的新数据 */
  if (IS_VERCEL) { try { const fresh = await kvGetThrottled(30000); if (fresh) cacheDb = fresh; } catch (e) { /* 刷新失败就用现有快照继续 */ } }
  const channel = String(process.env.TG_CHANNEL || 'chxpd').replace(/[^A-Za-z0-9_]/g, '');
  if (!channel) return res.status(400).json({ error: '频道未配置' });
  const db = loadDb();
  /* 存量标签补登记：树洞系列标签进标签库，前台才有入口 */
  if (Array.isArray(db.tags)) { for (const tgName of ['树洞', '忏悔室', '聊天投稿', 'TG投稿']) if (!db.tags.some(x => x.name === tgName)) db.tags.push({ id: id('t'), name: tgName }); }
  /* 一次性清理（2026-10-04 用户定）：所有导入帖正文尾部的「[查看原帖](t.me/…)」链接全部删掉 */
  if (!db.viewOriginalStrippedV1) {
    let strippedPosts = 0;
    for (const t of db.topics) {
      for (const p of (t.posts || [])) {
        if (p.content && p.content.includes('查看原帖')) {
          const nc = p.content.replace(/\s*\[查看原帖\]\(https:\/\/t\.me\/[^)]+\)/g, '').trim();
          if (nc !== p.content) { p.content = nc; strippedPosts++; }
        }
      }
    }
    db.viewOriginalStrippedV1 = { at: nowIso(), posts: strippedPosts };
  }
  if (req.query.reset === '1') db.tgSyncState = { lastId: 0, oldestId: 0, done: false }; /* 重置基线：重新搬最近一批+重新回填 */
  /* 投稿机器人账号 */
  let bot = db.users.find(u => u.username === 'tgbot');
  if (!bot) {
    bot = {
      id: id('u'), username: 'tgbot', name: '树洞投稿机器人', passwordHash: '',
      avatar: '', createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 0,
      checkinCoins: 0, lastCheckin: '', favorites: [],
      bio: '🌳 树洞投稿机器人：自动同步树洞投稿（广告已过滤）',
      signature: '', readme: '', contacts: {}, preferences: {},
      blocked: false, exp: 0, badges: [], title: '', achievements: {},
      checkinCount: 0, following: [],
    };
    db.users.push(bot);
  }
  /* 机器人改名（树洞搬运 → 树洞投稿机器人）：账号名/简介对齐一次，存量帖正文里的旧称呼一次性替换 */
  if (bot.name !== '树洞投稿机器人' || !String(bot.bio || '').includes('树洞投稿机器人')) {
    bot.name = '树洞投稿机器人';
    bot.bio = '🌳 树洞投稿机器人：自动同步树洞投稿（广告已过滤）';
  }
  if (!db.treeholeBotRenamedV1) {
    db.treeholeBotRenamedV1 = true;
    for (const t of db.topics) {
      if (typeof t.content === 'string' && t.content.includes('树洞搬运')) t.content = t.content.split('树洞搬运').join('树洞投稿机器人');
      for (const p of (t.posts || [])) {
        if (typeof p.content === 'string' && p.content.includes('树洞搬运')) p.content = p.content.split('树洞搬运').join('树洞投稿机器人');
      }
    }
  }
  /* 电报树洞板块 */
  let board = db.boards.find(b => b.slug === 'tg-treehole');
  if (!board) {
    board = { id: id('b'), name: '树洞', slug: 'tg-treehole', color: '#229ed9', description: '树洞投稿自动同步（广告已过滤）', topicCount: 0 };
    db.boards.push(board);
  }
  /* 板块改名（电报树洞 → 树洞，与电报频道、聊天频道同名）：板块名/简介一次对齐，存量帖子标签一并替换 */
  if (!db.treeholeBoardRenamedV1) {
    db.treeholeBoardRenamedV1 = true;
    board.name = '树洞';
    board.description = '树洞投稿自动同步（广告已过滤）';
    for (const t of db.topics) {
      if (Array.isArray(t.tags) && t.tags.includes('电报树洞')) t.tags = t.tags.map(x => (x === '电报树洞' ? '树洞' : x));
    }
  }
  /* 存量投稿补备注：已发布的投稿帖（不含电报搬运）正文头部补「来自X · 实名/匿名」一行 */
  if (!db.treeholeNoteBackfilledV1) {
    db.treeholeNoteBackfilledV1 = true;
    for (const t of db.topics) {
      if (t.boardId !== board.id) continue;
      if (t.status && t.status !== 'published') continue;
      const isSubmission = t.source === 'chat' || t.source === 'tg'
        || (Array.isArray(t.tags) && (t.tags.includes('聊天投稿') || t.tags.includes('TG投稿')));
      const p0 = t.posts && t.posts[0];
      if (isSubmission && p0 && typeof p0.content === 'string' && !p0.content.startsWith('> ')) {
        p0.content = `${submissionNoteHeader(db, t)}\n\n${p0.content}`;
      }
    }
  }
  /* 一次性托底（2026-10-04 用户定）：导入帖阅读数不低于真实评论人数 */
  if (!db.viewFloorV1) {
    let floored = 0;
    for (const t of db.topics) {
      if (t.userId !== bot.id || !Array.isArray(t.posts) || t.posts.length < 2) continue;
      const n = new Set(t.posts.slice(1).map(p => p.authorName || p.userId)).size;
      if (n > (t.viewCount || 0)) { t.viewCount = n; floored++; }
    }
    db.viewFloorV1 = { at: nowIso(), topics: floored };
  }
  /* 一次性迁移（2026-10-04 用户定）：已搬评论的【作者名】前缀改为帖子作者名字段，正文去掉前缀 */
  if (!db.tgAuthorNameV1) {
    let renamed = 0;
    const nameRe = /^【([^】]{1,40})】\s*/;
    for (const t of db.topics) {
      if (t.userId !== bot.id || !Array.isArray(t.posts)) continue;
      t.posts.forEach((p, idx) => {
        if (idx === 0 || p.authorName || typeof p.content !== 'string') return;
        const mm = p.content.match(nameRe);
        if (mm) { p.authorName = mm[1]; p.content = p.content.replace(nameRe, ''); renamed++; }
      });
    }
    db.tgAuthorNameV1 = { at: nowIso(), posts: renamed };
  }
  /* 一次性清理（2026-10-04 用户定）：搬移帖正文头部的「来自匿名投稿·转自 Telegram 频道…」备注行全部删掉（投稿备注不动） */
  if (!db.importHeaderStrippedV1) {
    let strippedHeaders = 0;
    const hdrRe = /^> (?:🌳 来自匿名投稿 · 转自 Telegram 频道 @\w+|🤖 转自 Telegram 树洞频道)，由「树洞投稿机器人」自动同步\s*\n+/;
    for (const t of db.topics) {
      const p0 = t.posts && t.posts[0];
      if (p0 && typeof p0.content === 'string' && hdrRe.test(p0.content)) {
        p0.content = p0.content.replace(hdrRe, '');
        strippedHeaders++;
      }
    }
    db.importHeaderStrippedV1 = { at: nowIso(), posts: strippedHeaders };
  }
  /* 一次性清理（2026-10-04 用户定）：已搬评论剥掉电报链接，广告评论整条删，导入正文也剥链接 */
  if (!db.tgLinkCleanV1) {
    let rmPosts = 0, strippedPosts = 0;
    for (const t of db.topics) {
      if (t.userId !== bot.id || !Array.isArray(t.posts) || !t.posts.length) continue;
      let changed = false;
      const kept = [];
      t.posts.forEach((p, idx) => {
        const isFirst = idx === 0;
        let c = typeof p.content === 'string' ? p.content : '';
        if (!isFirst && TG_AD_RE.test(c)) { rmPosts++; changed = true; return; } /* 广告评论整条删 */
        const nc = stripTgLinks(c);
        if (nc !== c) { strippedPosts++; changed = true; c = nc; }
        if (!isFirst && !c.trim()) { rmPosts++; changed = true; return; } /* 只剩链接被剥空的评论删掉 */
        kept.push(c === p.content ? p : { ...p, content: c });
      });
      if (changed) {
        kept.forEach((p, i) => { p.postNumber = i + 1; });
        t.posts = kept;
        t.replyCount = Math.max(0, kept.length - 1);
      }
    }
    db.tgLinkCleanV1 = { at: nowIso(), removed: rmPosts, stripped: strippedPosts };
  }
  const TG_UA = { headers: { 'User-Agent': 'Mozilla/5.0 (JMForumTgSync/1.0)' } };
  const parsePosts = (pageHtml) => {
    const list = [];
    const wrapRe = /data-post="[^"/]+\/(\d+)"[\s\S]*?(?=data-post="[^"/]+\/\d+"|<\/main>|$)/g;
    let mm;
    while ((mm = wrapRe.exec(pageHtml)) !== null) {
      const block = mm[0];
      const mid = parseInt(mm[1], 10);
      if (!mid) continue;
      const textM = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      const text = tgStripHtml(textM ? textM[1] : '').slice(0, 4000);
      const imgM = block.match(/tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/);
      const timeM = block.match(/<time[^>]*datetime="([^"]+)"/);
      list.push({ mid, text, image: imgM ? imgM[1] : '', at: timeM ? timeM[1] : '' });
    }
    list.sort((a, b) => a.mid - b.mid);
    return list;
  };
  const state = (db.tgSyncState && typeof db.tgSyncState === 'object') ? db.tgSyncState : (db.tgSyncState = { lastId: 0, oldestId: 0, done: false });
  /* 同步源切换（chxpd -> 自有频道）时编号从头算，自动重置基线；未搬完的旧频道进度存入 legacy 继续搬完，不丢历史 */
  if (state.channel && state.channel !== channel) {
    if (!state.done && state.oldestId > 1 && !state.legacy) state.legacy = { channel: state.channel, oldestId: state.oldestId, done: false, emptyHits: 0 };
    state.lastId = 0; state.oldestId = 0; state.done = false; state.doneV2 = true; state.emptyHits = 0;
  }
  state.channel = channel;
  let skippedAds = 0;
  const importOne = (p, srcChannel = channel, opts = {}) => {
    if (!p.text && !p.image) return 'empty';
    if (TG_AD_RE.test(p.text)) { skippedAds++; return 'ad'; }
    /* 已搬过的自动跳过（按来源频道+编号判定，不同频道编号相同也不误伤），防重置/补齐时重复发帖 */
    if (db.topics.some(t => t.boardId === board.id && t.userId === bot.id && t.slug && t.slug.endsWith('-' + p.mid) && ((t.tgChannel || '') === srcChannel || (t.tgFromChannel || '') === srcChannel))) return 'dup';
    if (db.topics.some(t => t.tgMid === p.mid && (t.tgChannel || 'chxpd') === srcChannel)) return 'dup';
    const time = p.at && !isNaN(new Date(p.at).getTime()) ? new Date(p.at).toISOString() : nowIso();
    const flat = p.text.replace(/\s+/g, ' ').trim();
    const title = flat ? flat.slice(0, 30) : '树洞图片投稿';
    const cleanText = stripTgLinks(p.text); /* 电报链接过滤（用户定） */
    /* 搬移帖不加来源备注行（2026-10-04 用户定），正文就是原内容 */
    const body = cleanText + (p.image ? `\n\n![](${p.image})` : '');
    const topicId = id('tp');
    const newTags = (Array.isArray(opts.tags) && opts.tags.length) ? opts.tags : ['树洞'];
    /* 标签登记进标签库，侧栏标签云/标签页才有入口（树洞/忏悔室等） */
    if (!Array.isArray(db.tags)) db.tags = [];
    for (const tgName of newTags) if (tgName && !db.tags.some(x => x.name === tgName)) db.tags.push({ id: id('t'), name: tgName });
    db.topics.push({
      id: topicId, title, slug: slugify(title) + '-' + p.mid, boardId: board.id, userId: bot.id,
      createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
      tags: newTags, posts: [{ id: id('p'), topicId, userId: bot.id, content: body, createdAt: time, likeCount: 0, postNumber: 1 }],
      pinned: false, recommended: false, price: 0, closed: false,
      poll: null, bounty: 0, bestReplyId: null,
      prefix: '树洞',
      tgMid: p.mid, tgChannel: srcChannel, tgCommentIds: [], tgCommentMin: 0, tgCommentsDone: false,
      ...(opts.anonymous ? { anonymous: true } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    });
    board.topicCount = (board.topicCount || 0) + 1;
    return 'ok';
  };
  /* ① 最新一页 */
  let posts = [];
  try {
    const r = await fetch(`https://t.me/s/${channel}`, TG_UA);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    posts = parsePosts(await r.text());
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'TG 频道页拉取失败：' + e.message });
  }
  const firstRun = !state.lastId;
  const pageMax = posts.length ? posts[posts.length - 1].mid : 0;
  const synced = [];
  if (posts.length && (!state.lastId || !state.oldestId)) {
    /* 首次/补齐：整页过一遍（已搬的靠 slug 去重跳过），不留缝隙 */
    for (const p of posts) { if (importOne(p) === 'ok') synced.push(p.mid); }
    state.lastId = pageMax;
    state.oldestId = posts[0].mid;
  } else {
    const candidates = posts.filter(p => p.mid > state.lastId).slice(0, 10); /* 新帖单次最多 10 条，积压下轮继续 */
    let lastProcessed = state.lastId;
    for (const p of candidates) {
      lastProcessed = p.mid;
      if (importOne(p) === 'ok') synced.push(p.mid);
    }
    state.lastId = lastProcessed && lastProcessed < pageMax ? lastProcessed : pageMax;
  }
  /* ② 历史全量回填：沿 ?before= 往更早翻页，直到频道第一条（广告同样过滤）
     完成判定宁可保守：只有空页连续两次、或翻到编号 1 才算搬完，避免临时短页误判 */
  let backfilled = 0;
  if (state.done && !state.doneV2) { state.done = false; state.doneV2 = true; } /* 旧版误判完成的存量状态，自动恢复一次 */
  if (!state.done && state.oldestId > 1) {
    for (let page = 0; page < 3 && !state.done; page++) {
      let older = [];
      try {
        const r2 = await fetch(`https://t.me/s/${channel}?before=${state.oldestId}`, TG_UA);
        if (r2.ok) older = parsePosts(await r2.text());
      } catch (e) { break; }
      if (!older.length) {
        state.emptyHits = (state.emptyHits || 0) + 1;
        if (state.emptyHits >= 2) state.done = true;
        break;
      }
      state.emptyHits = 0;
      const pageMin = older[0].mid;
      if (pageMin >= state.oldestId) break; /* 编号没推进，防死循环 */
      for (const p of older) {
        if (p.mid >= state.oldestId) continue;
        if (importOne(p) === 'ok') backfilled++;
      }
      state.oldestId = pageMin;
      if (pageMin <= 1) state.done = true;
    }
  }
  /* ②-bis 旧频道剩余历史（同步源切换时保留的 legacy 进度）：每轮顺手搬 2 页，搬完为止 */
  let legacyBackfilled = 0;
  if (state.legacy && !state.legacy.done && state.legacy.oldestId > 1) {
    for (let page = 0; page < 2 && !state.legacy.done; page++) {
      let older = [];
      try {
        const r3 = await fetch(`https://t.me/s/${state.legacy.channel}?before=${state.legacy.oldestId}`, TG_UA);
        if (r3.ok) older = parsePosts(await r3.text());
      } catch (e) { break; }
      if (!older.length) {
        state.legacy.emptyHits = (state.legacy.emptyHits || 0) + 1;
        if (state.legacy.emptyHits >= 2) state.legacy.done = true;
        break;
      }
      state.legacy.emptyHits = 0;
      const pageMin = older[0].mid;
      if (pageMin >= state.legacy.oldestId) break;
      for (const p of older) {
        if (p.mid >= state.legacy.oldestId) continue;
        if (importOne(p, state.legacy.channel) === 'ok') legacyBackfilled++;
      }
      state.legacy.oldestId = pageMin;
      if (pageMin <= 1) state.legacy.done = true;
    }
  }
  /* ②-ter 额外频道整体迁移（如忏悔室）：注册在 db.tgMigrations 的频道独立于主同步——最新页补新帖、向后翻页搬全部历史，
     带自定义标签与匿名标注；评论由下面的评论镜像统一接管（topics 记 tgChannel=来源频道） */
  if (!db.tgMigrations || typeof db.tgMigrations !== 'object') db.tgMigrations = {};
  let migrated = 0;
  const migReport = {};
  for (const [migChannel, mig] of Object.entries(db.tgMigrations)) {
    if (!mig) continue;
    const migOpts = { tags: ['树洞', ...(mig.tag ? [mig.tag] : [])], anonymous: !!mig.anonymous, source: 'import' };
    try {
      const rm = await fetch(`https://t.me/s/${migChannel}`, TG_UA);
      if (rm.ok) {
        const mposts = parsePosts(await rm.text());
        if (mposts.length) {
          if (!mig.lastId) {
            for (const p of mposts) { if (importOne(p, migChannel, migOpts) === 'ok') migrated++; }
            mig.lastId = mposts[mposts.length - 1].mid;
            mig.oldestId = mposts[0].mid;
          } else {
            for (const p of mposts.filter(x => x.mid > mig.lastId).slice(0, 10)) {
              if (importOne(p, migChannel, migOpts) === 'ok') migrated++;
              if (p.mid > mig.lastId) mig.lastId = p.mid;
            }
          }
        }
      }
    } catch (e) { /* 单轮拉取失败不中断，下轮继续 */ }
    /* 已搬完的频道到此为止：只持续守最新页搬新帖（用户定：源频道有新投稿自动转移），历史不再重复翻 */
    if (mig.done) { migReport[migChannel] = { oldestId: mig.oldestId || 0, lastId: mig.lastId || 0, done: true, watching: true }; continue; }
    if (!mig.done && mig.oldestId > 1) {
      for (let page = 0; page < 3 && !mig.done; page++) {
        let older = [];
        try {
          const r4 = await fetch(`https://t.me/s/${migChannel}?before=${mig.oldestId}`, TG_UA);
          if (r4.ok) older = parsePosts(await r4.text());
        } catch (e) { break; }
        if (!older.length) {
          mig.emptyHits = (mig.emptyHits || 0) + 1;
          if (mig.emptyHits >= 2) mig.done = true;
          break;
        }
        mig.emptyHits = 0;
        const pageMin = older[0].mid;
        if (pageMin >= mig.oldestId) break;
        for (const p of older) {
          if (p.mid >= mig.oldestId) continue;
          if (importOne(p, migChannel, migOpts) === 'ok') migrated++;
        }
        mig.oldestId = pageMin;
        if (pageMin <= 1) mig.done = true;
      }
    }
    migReport[migChannel] = { oldestId: mig.oldestId || 0, lastId: mig.lastId || 0, done: !!mig.done };
  }
  /* ③ 评论镜像：把每个帖子在 TG 的评论同步成论坛回帖（由树洞搬运代发，标注原评论者；广告评论同样过滤）
     讨论页 ?embed=1&discussion=1 服务端直出评论；&comment=<最小ID> 向更早翻页。单轮限额，靠 tgCommentIds 去重续传 */
  const parseComments = (pageHtml) => {
    const out = [];
    for (const seg of String(pageHtml).split('js-widget_message_wrap')) {
      const idM = seg.match(/data-post-id="(\d+)"/);
      if (!idM || !seg.includes('?comment=')) continue;
      const cid = parseInt(idM[1], 10);
      const aM = seg.match(/tgme_widget_message_author_name[^>]*>([\s\S]{0,160}?)<\/span>/);
      const author = (aM ? tgStripHtml(aM[1]) : '').slice(0, 40) || '匿名';
      const texts = [...seg.matchAll(/tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/g)].map(x => x[1]);
      const text = texts.length ? tgStripHtml(texts[texts.length - 1]).slice(0, 1500) : '';
      const imgM = seg.match(/tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/);
      const timeM = seg.match(/<time[^>]*datetime="([^"]+)"/);
      out.push({ cid, author, text, image: imgM ? imgM[1] : '', at: timeM ? timeM[1] : '' });
    }
    return out;
  };
  let commentsAdded = 0;
  let commentTopics = 0;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const allMine = db.topics
    .filter(t => t.boardId === board.id && (t.userId === bot.id || (typeof t.tgMid === 'number' && t.tgChannel === channel)))
    .map(t => {
      if (typeof t.tgMid !== 'number') {
        const mm = /-(\d+)$/.exec(t.slug || '');
        t.tgMid = mm ? parseInt(mm[1], 10) : 0;
      }
      if (!Array.isArray(t.tgCommentIds)) t.tgCommentIds = [];
      return t;
    })
    .filter(t => t.tgMid > 0);
  /* 未补完评论的按最近活跃优先（用户先看到的帖先补齐），而不是只按入库顺序 */
  const ctCandidates = allMine.filter(t => !t.tgCommentsDone).sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt)).slice(0, 16); /* 未完成评论同步的 16 帖 */
  const ctRefresh = allMine.filter(t => t.tgCommentsDone && new Date(t.createdAt).getTime() > weekAgo).sort((a, b) => b.tgMid - a.tgMid).slice(0, 3); /* 近 7 天已同步完的帖再查最新页，接新评论 */
  for (const [t, maxPages] of [...ctCandidates.map(t => [t, 3]), ...ctRefresh.map(t => [t, 1])]) {
    const seen = new Set(t.tgCommentIds || []);
    const fresh = [];
    let minSeen = t.tgCommentMin || Infinity;
    let pages = 0;
    let reachedOldest = false;
    let cursor = 0; /* 0=最新页；之后=已抓到的最小评论ID，向更早翻 */
    while (pages < maxPages) {
      const url = `https://t.me/${t.tgChannel || channel}/${t.tgMid}?embed=1&discussion=1` + (cursor ? `&comment=${cursor}` : '');
      let list = [];
      try {
        const rr = await fetch(url, TG_UA);
        if (rr.ok) list = parseComments(await rr.text());
      } catch (e) { break; }
      pages++;
      if (!list.length) { reachedOldest = true; break; }
      let pageMin = Infinity;
      for (const c of list) {
        if (c.cid < pageMin) pageMin = c.cid;
        if (c.cid < minSeen) minSeen = c.cid;
        if (seen.has(c.cid)) continue;
        seen.add(c.cid);
        const cleanText = stripTgLinks(c.text); /* 电报链接过滤：剥掉 t.me 等链接，只剩链接的评论整条跳过 */
        if (!cleanText && !c.image) continue;   /* 纯表情/贴纸/纯链接跳过（ID 已记，不会重复抓） */
        if (TG_AD_RE.test(cleanText)) continue; /* 广告评论不搬 */
        fresh.push({ ...c, text: cleanText });
      }
      if (cursor !== 0 && pageMin >= cursor) { reachedOldest = true; break; } /* 锚点页没再变老 = 到最老一条 */
      cursor = pageMin;
      /* 续传：之前已抓到过更老的地方时，从最新页直接跳回上次的最老处继续往下，不重复翻已抓的窗口 */
      if (pages === 1 && t.tgCommentMin && cursor > t.tgCommentMin) cursor = t.tgCommentMin;
    }
    fresh.sort((a, b) => a.cid - b.cid);
    for (const c of fresh) {
      if ((t.tgCommentIds || []).length >= 200) break; /* 单帖评论镜像上限 200 条 */
      const ctime = c.at && !isNaN(new Date(c.at).getTime()) ? new Date(c.at).toISOString() : nowIso();
      const cbody = `${c.text}${c.image ? `\n\n![](${c.image})` : ''}`.trim();
      /* 评论挂原作者名（用户定：不要看起来全是机器人在评论） */
      t.posts.push({ id: id('p'), topicId: t.id, userId: bot.id, authorName: String(c.author || 'TG用户').slice(0, 40), content: cbody, createdAt: ctime, likeCount: 0, postNumber: t.posts.length + 1 });
      t.replyCount = (t.replyCount || 0) + 1;
      commentsAdded++;
    }
    t.tgCommentIds = [...seen].slice(-400);
    if (minSeen !== Infinity) t.tgCommentMin = minSeen;
    /* 阅读数托底（用户定）：多少人评论就至少多少人看过 */
    const commenters = new Set(t.posts.slice(1).map(p => p.authorName || p.userId));
    if (commenters.size > (t.viewCount || 0)) t.viewCount = commenters.size;
    if (reachedOldest || (t.tgCommentIds || []).length >= 200) t.tgCommentsDone = true;
    if (fresh.length || pages) commentTopics++;
  }
  /* 社区小助手：给零回复的新帖搭第一句话（官方助手号，帖主会收到回复通知） */
  let assisted = 0;
  try {
    let helper = db.users.find(u => u.username === 'jmhelper');
    if (!helper) {
      helper = {
        id: id('u'), username: 'jmhelper', name: '社区小助手', passwordHash: '',
        avatar: '', createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 0,
        checkinCoins: 0, lastCheckin: '', favorites: [],
        bio: '🤖 社区小助手：负责给新帖子捧场，有事找站长',
        signature: '新帖别冷场，我先来搭句话', readme: '', contacts: {}, preferences: {},
        blocked: false, exp: 0, badges: [], title: '官方助手', achievements: {},
        checkinCount: 0, following: [],
      };
      db.users.push(helper);
    }
    const BOT_NAMES = new Set(['tgbot', 'newsbot', 'blogbot', 'jmhelper']);
    db.settings = db.settings || {};
    const dayKey = todayStr();
    if (!db.settings.assistDay || db.settings.assistDay.date !== dayKey) db.settings.assistDay = { date: dayKey, count: 0 };
    const cutoff = Date.now() - 72 * 3600 * 1000;
    const candidates = (db.topics || [])
      .filter(t => (t.status || 'published') === 'published' && !t.closed)
      .filter(t => Array.isArray(t.posts) && t.posts.length === 1)
      .filter(t => new Date(t.createdAt).getTime() > cutoff)
      .filter(t => {
        const op = db.users.find(u => u.id === t.posts[0].userId);
        return op && !BOT_NAMES.has(op.username);
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const kw = (x) => String(x || '').replace(/[\s#＃【】\[\]《》「」]+/g, ' ').trim().slice(0, 24);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    for (const t of candidates) {
      if (assisted >= 2 || db.settings.assistDay.count >= 8) break;
      const title = String(t.title || '').trim();
      const body = String((t.posts[0] && t.posts[0].content) || '').replace(/\s+/g, ' ').trim();
      const topicKw = kw(title) || kw(body);
      const asks = /(怎么|如何|为什么|请教|求助|求推荐|有没有|哪位|咋|吗[？?]?$|[？?])/.test(title + body.slice(0, 60));
      const shares = /(分享|教程|经验|记录|总结|攻略|测评|体验)/.test(title);
      let content;
      if (asks) content = pick([
        '「' + topicKw + '」这个问题问得好，蹲一个大佬解答，我也想知道 👇',
        '看到标题就点进来了，「' + topicKw + '」正好我也想搞清楚，等楼下高手现身',
        '先占个楼，「' + topicKw + '」有答案了记得踢我一下',
      ]);
      else if (shares) content = pick([
        '感谢分享！「' + topicKw + '」先码住慢慢看 📌',
        '这种实打实的分享最有用了，「' + topicKw + '」收藏了',
        '楼主辛苦，「' + topicKw + '」写得很实在，先存为敬',
      ]);
      else content = pick([
        '沙发！「' + topicKw + '」这个话题有意思，坐等楼主更新',
        '前排支持一下，「' + topicKw + '」展开说说呗',
        '「' + topicKw + '」点进来了，楼主继续，别停 😄',
      ]);
      const time = nowIso();
      t.posts.push({ id: id('p'), topicId: t.id, userId: helper.id, content, createdAt: time, likeCount: 0, postNumber: t.posts.length + 1 });
      t.replyCount = (t.replyCount || 0) + 1;
      t.bumpedAt = time;
      const opUser = db.users.find(u => u.id === t.posts[0].userId);
      if (opUser && (opUser.preferences && opUser.preferences.notifyReply) !== false) {
        addNotification(db, opUser.id, 'reply', { topicId: t.id, topicTitle: t.title, fromId: helper.id, fromName: helper.name, content: content.slice(0, 80) });
      }
      assisted++;
      db.settings.assistDay.count++;
    }
  } catch (e) { console.error('社区小助手失败:', e.message); }
  saveDb(db);
  await flushNow(); /* 立即落盘，防 serverless 冻结丢数据 */
  res.json({ ok: true, assisted, firstRun, synced: synced.length, backfilled, legacyBackfilled, legacyDone: state.legacy ? !!state.legacy.done : true, legacyOldestId: state.legacy ? state.legacy.oldestId : 0, skippedAds, commentsAdded, commentTopics, backfillDone: !!state.done, oldestId: state.oldestId, lastId: state.lastId, migrated, migrations: migReport, saveError: lastKvError || null, sizes: { bytes: (() => { try { return JSON.stringify(db).length; } catch (e) { return -1; } })(), topics: db.topics.length, posts: db.topics.reduce((a, t) => a + ((t.posts || []).length), 0), companies: (db.companies || []).length, users: (db.users || []).length } });
});


/* TG 评论结构探针（临时调试，同一密钥鉴权）：看讨论页服务端 HTML 里评论的标记与分页线索 */
app.get('/api/cron/tg-probe', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.headers['x-sync-secret'] === secret || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  const channel = String(process.env.TG_CHANNEL || 'chxpd').replace(/[^A-Za-z0-9_]/g, '');
  const mid = parseInt(req.query.mid || '3563', 10);
  const url = `https://t.me/${channel}/${mid}?embed=1&discussion=1`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (JMForumTgSync/1.0)' } });
    const html = await r.text();
    const ids = [...new Set([...html.matchAll(/\?comment=(\d+)/g)].map(m => m[1]))];
    const authors = [...html.matchAll(/tgme_widget_message_author_name[^>]*>([^<]{1,40})</g)].map(m => m[1]).slice(0, 6);
    const dateHrefs = [...html.matchAll(/href="(https:\/\/t\.me\/[^"]*\?comment=\d+)"/g)].map(m => m[1]).slice(0, 4);
    const moreHrefs = [...new Set([...html.matchAll(/href="([^"]*(?:discussion|comment)[^"]*)"/g)].map(m => m[1]))].slice(0, 8);
    /* 评论三元组提取试跑：作者 / 正文 / 评论ID */
    const triples = [];
    const segRe = /tgme_widget_message_author_name[^>]*>([^<]{1,40})<[\s\S]{0,4000}?tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>[\s\S]{0,2000}?\?comment=(\d+)/g;
    let sm;
    while ((sm = segRe.exec(html)) !== null && triples.length < 6) {
      triples.push({ author: sm[1], text: tgStripHtml(sm[2]).slice(0, 60), cid: sm[3] });
    }
    const out = {
      status: r.status, len: html.length,
      commentAnchors: ids.length, sampleIds: ids.slice(0, 5),
      authors, dateHrefs, moreHrefs, triples,
      hasShowMoreText: /more comments/i.test(html),
      hasWidgetMessageText: (html.match(/tgme_widget_message_text/g) || []).length,
    };
    /* 分页试探：?test2= 后缀拼到讨论页 URL 后再抓一次，看评论 ID 是否变化 */
    if (req.query.test2) {
      const r2 = await fetch(url + String(req.query.test2), { headers: { 'User-Agent': 'Mozilla/5.0 (JMForumTgSync/1.0)' } });
      const h2 = await r2.text();
      out.test2 = { status: r2.status, ids: [...new Set([...h2.matchAll(/\?comment=(\d+)/g)].map(m => m[1]))].slice(0, 8) };
    }
    /* 结构取样：第 3 个评论锚点前后的原始 HTML，确认嵌套回复的真实结构 */
    if (req.query.around) {
      const idxs = [...html.matchAll(/\?comment=(\d+)/g)].map(m => m.index);
      const k = Math.min(parseInt(req.query.around, 10) || 2, idxs.length - 1);
      if (k >= 0) out.around = html.slice(Math.max(0, idxs[k] - 2200), idxs[k] + 120);
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* TG 搬运清理：把已搬进「电报树洞」但命中广告规则的帖子删掉（?prune=1，同一密钥鉴权） */
app.get('/api/cron/tg-prune', async (req, res) => {
  const secret = process.env.TG_SYNC_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.headers['x-sync-secret'] === secret || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  if (req.query.prune !== '1') return res.status(400).json({ error: '加 ?prune=1 才执行' });
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'tg-treehole');
  const bot = db.users.find(u => u.username === 'tgbot');
  if (!board || !bot) return res.json({ ok: true, removed: [] });
  const removed = [];
  db.topics = db.topics.filter(t => {
    if (t.boardId !== board.id || t.userId !== bot.id) return true;
    /* 只拿投稿原文比对：剥掉机器人署名行与原帖链接尾巴，避免署名里的字眼误伤 */
    const raw = ((t.posts && t.posts[0] && t.posts[0].content) || '')
      .replace(/^> .*$/m, '')
      .replace(/\n\[查看原帖\][\s\S]*$/, '');
    const hay = (t.title || '') + '\n' + raw;
    if (TG_AD_RE.test(hay)) { removed.push(t.title); return false; }
    return true;
  });
  if (removed.length) {
    board.topicCount = Math.max(0, (board.topicCount || 0) - removed.length);
    saveDb(db);
    await flushNow();
  }
  res.json({ ok: true, removed });
});

/* TrendRadar AI 解读同步：sandbox 定时任务抓取+AI分析后 POST 内容，由 newsbot 发帖 */
app.post('/api/cron/trendradar-post', express.json({ limit: '512kb' }), async (req, res) => {
  const secret = process.env.TRENDRADAR_SECRET || process.env.CRON_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  const { title, content, prefix } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title/content 必填' });
  const db = loadDb();
  const board = db.boards.find(b => b.slug === 'chigua') || db.boards[0];
  const bot = db.users.find(u => u.username === 'newsbot');
  if (!bot || !board) return res.status(500).json({ error: '机器人或板块未就绪' });
  if (db.topics.some(t => t.userId === bot.id && t.title === title)) return res.json({ ok: true, skipped: true, reason: '已存在' });
  const time = nowIso();
  const topicId = id('tp');
  const topic = {
    id: topicId, title, slug: slugify(title), boardId: board.id, userId: bot.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: ['AI解读', '吃瓜'], posts: [{ id: id('p'), topicId, userId: bot.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
    pinned: false, recommended: false, price: 0, closed: false,
    poll: null, bounty: 0, bestReplyId: null,
    prefix: prefix || 'AI解读',
  };
  db.topics.push(topic);
  board.topicCount = (board.topicCount || 0) + 1;
  saveDb(db);
  res.json({ ok: true, topicId });
});

/* ================= 热点专区 TrendRadar 报告 ================= */
const TREND_INDEX_KEY = 'trend:index';
const trendKey = (k) => `trend:report:${k}`;
async function kvRawGet(key) {
  if (!IS_VERCEL) return null;
  const res = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}
async function kvRawSet(key, val) {
  if (!IS_VERCEL) return;
  await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof val === 'string' ? val : JSON.stringify(val),
  });
}
/* 上传报告（sandbox 定时任务调用） */
app.post('/api/cron/trendradar-upload', express.json({ limit: '2mb' }), async (req, res) => {
  const secret = process.env.TRENDRADAR_SECRET || process.env.CRON_SECRET || '';
  const authOk = secret && (req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret);
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });
  const { key, title, dateTag, period, stats, html, html_gzip } = req.body || {};
  let htmlContent = html;
  if (html_gzip) {
    try {
      const buf = Buffer.from(html_gzip, 'base64');
      htmlContent = require('zlib').gunzipSync(buf).toString('utf-8');
    } catch (e) { return res.status(400).json({ error: 'gzip 解压失败' }); }
  }
  if (!key || !htmlContent) return res.status(400).json({ error: 'key/html 必填' });
  try {
    await kvRawSet(trendKey(key), htmlContent);
    let idx = await kvRawGet(TREND_INDEX_KEY);
    idx = idx ? (typeof idx === 'string' ? JSON.parse(idx) : idx) : [];
    idx = idx.filter(x => x.key !== key);
    idx.unshift({ key, title, dateTag, period, stats: stats || {}, createdAt: nowIso() });
    idx = idx.slice(0, 60); /* 保留最近 60 期 */
    await kvRawSet(TREND_INDEX_KEY, JSON.stringify(idx));
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
/* 报告列表 */
app.get('/api/trends', async (req, res) => {
  try {
    let idx = await kvRawGet(TREND_INDEX_KEY);
    idx = idx ? (typeof idx === 'string' ? JSON.parse(idx) : idx) : [];
    res.json({ list: idx });
  } catch (e) { res.json({ list: [] }); }
});
/* 单期报告 HTML（完整网页版） */
app.get('/api/trends/:key/html', async (req, res) => {
  try {
    const html = await kvRawGet(trendKey(req.params.key));
    if (!html) return res.status(404).send('报告不存在');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(typeof html === 'string' ? html : JSON.stringify(html));
  } catch (e) { res.status(500).send('读取失败'); }
});

/* ================= admin: 抽奖管理 ================= */
app.delete('/api/admin/lottery/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.lotteries || []).findIndex(l => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '抽奖不存在' });
  const [l] = db.lotteries.splice(idx, 1);
  modLog(db, '删除抽奖', req.user, '', `《${l.title}》`);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= admin: 通知设置 ================= */
app.get('/api/admin/notify', requireAdmin, (req, res) => {
  res.json(notify.mergeNotify(loadDb().settings.notify));
});

app.post('/api/admin/notify', requireAdmin, (req, res) => {
  const db = loadDb();
  const cur = notify.mergeNotify(db.settings.notify);
  const body = req.body || {};
  const tBody = body.telegram || {}, wBody = body.wecom || {};
  const next = {
    telegram: {
      enabled: !!tBody.enabled,
      /* 字段显式传值（含空串）则使用新值；未传则保留旧值 */
      botToken: tBody.botToken !== undefined ? String(tBody.botToken).trim() : cur.telegram.botToken,
      chatId: tBody.chatId !== undefined ? String(tBody.chatId).trim() : cur.telegram.chatId,
    },
    wecom: {
      enabled: !!wBody.enabled,
      webhook: wBody.webhook !== undefined ? String(wBody.webhook).trim() : cur.wecom.webhook,
    },
    events: {
      newUser: body.events && body.events.newUser !== undefined ? !!body.events.newUser : cur.events.newUser,
      newTopic: body.events && body.events.newTopic !== undefined ? !!body.events.newTopic : cur.events.newTopic,
      newReply: body.events && body.events.newReply !== undefined ? !!body.events.newReply : cur.events.newReply,
    },
  };
  db.settings = db.settings || {};
  db.settings.notify = next;
  saveDb(db);
  res.json({ ok: true, notify: next });
});

/* 测试发送：优先用请求体里的配置（未填则回落已保存配置），可先测再保存 */
app.post('/api/admin/notify/test', requireAdmin, async (req, res) => {
  const db = loadDb();
  const cfg = notify.mergeNotify({ ...db.settings.notify, ...(req.body || {}) });
  const results = [];
  if (cfg.telegram.enabled && cfg.telegram.botToken && cfg.telegram.chatId) {
    try { results.push(await notify.sendTelegram(cfg.telegram, '<b>✅ 测试消息</b>\nJM 论坛通知配置成功，Telegram 机器人已就绪。')); }
    catch (e) { results.push({ ok: false, via: 'telegram', error: e.message }); }
  } else {
    results.push({ ok: false, via: 'telegram', error: 'Telegram 未启用或未配置完整' });
  }
  if (cfg.wecom.enabled && cfg.wecom.webhook) {
    try { results.push(await notify.sendWecom(cfg.wecom, '### ✅ 测试消息\nJM 论坛通知配置成功，企业微信群机器人已就绪。')); }
    catch (e) { results.push({ ok: false, via: 'wecom', error: e.message }); }
  } else {
    results.push({ ok: false, via: 'wecom', error: '企业微信未启用或未配置 Webhook' });
  }
  res.json({ results });
});

/* 用 Bot Token 拉取可用会话（群/频道/私聊），供选择 Chat ID */
app.get('/api/admin/notify/telegram/chats', requireAdmin, async (req, res) => {
  try {
    const saved = loadDb().settings.notify || {};
    const token = String(req.query.botToken || '').trim() || (saved.telegram || {}).botToken || '';
    const chats = await notify.telegramChats(token);
    res.json({ chats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ================= admin: 注册码 ================= */
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const db = loadDb();
  const codes = (db.regCodes || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(c => ({
    id: c.id, code: c.code, note: c.note || '', usedBy: c.usedBy, usedAt: c.usedAt, createdAt: c.createdAt,
    usedByUser: c.usedBy ? (db.users.find(u => u.id === c.usedBy) || null) : null,
  }));
  res.json({ codes, total: codes.length, used: codes.filter(c => c.usedBy).length, available: codes.filter(c => !c.usedBy).length });
});

app.post('/api/admin/codes', requireAdmin, (req, res) => {
  const db = loadDb();
  const { count = 1, note = '' } = req.body || {};
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);
  const created = [];
  for (let i = 0; i < n; i++) {
    const rc = { id: id('rc'), code: genRegCode(), note: String(note || '').slice(0, 50), usedBy: null, usedAt: null, createdAt: nowIso() };
    db.regCodes.push(rc);
    created.push(rc);
  }
  saveDb(db);
  res.status(201).json({ codes: created });
});

/* ================= 用户邀请码 ================= */
/* 生成邀请码：LV2+ 用户可生成，每码默认 5 次使用 */
app.post('/api/invites', requireAuth, (req, res) => {
  const db = loadDb();
  const lv = userLevel(req.user).level;
  if (lv < 2) return res.status(403).json({ error: 'LV2 及以上才能生成邀请码，多发帖回帖升级吧' });
  const myCodes = (db.regCodes || []).filter(c => c.createdBy === req.user.id);
  if (myCodes.length >= 10) return res.status(400).json({ error: '你最多只能有 10 个邀请码' });
  const maxUses = Math.max(1, Math.min(20, parseInt((req.body || {}).maxUses) || 5));
  const rc = { id: id('rc'), code: genRegCode(), note: String(((req.body || {}).note) || '').slice(0, 50), createdBy: req.user.id, maxUses, usedCount: 0, usedByList: [], usedBy: null, usedAt: null, createdAt: nowIso(), expiresAt: null };
  db.regCodes.push(rc);
  saveDb(db);
  res.status(201).json({ code: rc.code, maxUses: rc.maxUses });
});
/* 我的邀请码 + 邀请统计 */
app.get('/api/invites/mine', requireAuth, (req, res) => {
  const db = loadDb();
  const codes = (db.regCodes || []).filter(c => c.createdBy === req.user.id).map(c => ({
    code: c.code, note: c.note || '', maxUses: c.maxUses || 1, usedCount: c.usedCount || 0, createdAt: c.createdAt,
    invited: (c.usedByList || []).map(uid => { const u = db.users.find(x => x.id === uid); return u ? { username: u.username, name: u.name, createdAt: u.createdAt } : null; }).filter(Boolean),
  }));
  const totalInvited = codes.reduce((a, c) => a + c.invited.length, 0);
  res.json({ codes, totalInvited, rewardPerInvite: 20 });
});

app.delete('/api/admin/codes/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = (db.regCodes || []).findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '注册码不存在' });
  if (db.regCodes[idx].usedBy) return res.status(400).json({ error: '该注册码已被使用，不能删除' });
  db.regCodes.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = loadDb();
  const q = (req.query.q || '').toLowerCase().trim();
  let list = db.users.filter(u => u.id !== GHOST.id);
  if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  if (['owner', 'admin', 'user'].includes(req.query.role)) list = list.filter(u => u.role === req.query.role);
  if (req.query.status === 'banned') list = list.filter(u => u.banned);
  if (req.query.status === 'active') list = list.filter(u => !u.banned);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = list.length;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '30', 10)));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = list.slice((page - 1) * pageSize, page * pageSize).map(u => adminUserJson(u, db));
  res.json({ list: rows, total, pages, page });
});

app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });
  const role = req.body && req.body.role;
  if (!['user', 'admin', 'owner'].includes(role)) return res.status(400).json({ error: '无效角色' });
  if (req.user.role !== 'owner') {
    /* 管理员：只能升降普通用户（user <-> admin），不能动站长和其他管理员，不能授予站长 */
    if (role === 'owner') return res.status(403).json({ error: '仅站长可设置站长角色' });
    if (u.role !== 'user') return res.status(403).json({ error: '不能修改管理员或站长的角色' });
  }
  u.role = role;
  saveDb(db);
  res.json({ ok: true, user: adminUserJson(u, db) });
});

/* 站长设置用户等级（LV1-10）：按等级门槛设置经验值，通知用户并记录管理日志 */
app.post('/api/admin/users/:id/level', requireAdmin, async (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.user.role !== 'owner') return res.status(403).json({ error: '仅站长可调整用户等级' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不能修改自己的等级' });
  const level = parseInt(req.body && req.body.level, 10);
  if (!Number.isInteger(level) || level < 1 || level > 10) return res.status(400).json({ error: '等级需为 1-10' });
  const before = userLevel(u).level;
  u.exp = LEVELS[level - 1].exp;
  if (level !== before) {
    addNotification(db, u.id, 'levelup', { level, title: LEVELS[level - 1].title, byAdmin: true });
    modLog(db, '调整等级', req.user, u.name, `将 @${u.username} 的等级从 LV${before} 调整为 LV${level}（${LEVELS[level - 1].title}）`);
  }
  saveDb(db);
  await flushNow(); /* 立即落盘，防 serverless 延迟写被冻结丢失 */
  res.json({ ok: true, user: adminUserJson(u, db) });
});

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不能封禁自己' });
  /* 站长可封禁管理员，但不能封禁站长；管理员只能封禁普通用户 */
  const canBan = req.user.role === 'owner' ? u.role !== 'owner' : u.role === 'user';
  if (!canBan) return res.status(400).json({ error: req.user.role === 'owner' ? '不能封禁站长' : '不能封禁管理员或站长' });
  u.banned = true;
  modLog(db, '封禁用户', req.user, u.name, `封禁用户 @${u.username}`);
  saveDb(db);
  res.json({ ok: true, user: adminUserJson(u, db) });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  u.banned = false;
  modLog(db, '解封用户', req.user, u.name, `解封用户 @${u.username}`);
  saveDb(db);
  res.json({ ok: true, user: adminUserJson(u, db) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = db.users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '用户不存在' });
  const u = db.users[idx];
  if (u.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const canDel = req.user.role === 'owner' ? u.role !== 'owner' : u.role === 'user';
  if (!canDel) return res.status(400).json({ error: req.user.role === 'owner' ? '不能删除站长账号' : '不能删除管理员或站长账号' });
  db.topics.forEach(t => {
    if (t.userId === u.id) t.userId = GHOST.id;
    t.posts.forEach(p => { if (p.userId === u.id) p.userId = GHOST.id; });
  });
  db.users.splice(idx, 1);
  modLog(db, '删除用户', req.user, u.name, `删除用户 @${u.username}`);
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/admin/topics', requireAdmin, (req, res) => {
  const db = loadDb();
  const q = (req.query.q || '').toLowerCase().trim();
  let list = db.topics.slice();
  if (q) list = list.filter(t => t.title.toLowerCase().includes(q) || (t.tags || []).some(x => x.toLowerCase().includes(q)));
  if (req.query.board) { const b = boardBySlug(db, req.query.board); if (b) list = list.filter(t => t.boardId === b.id); }
  list.sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  const total = list.length;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '30', 10)));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = list.slice((page - 1) * pageSize, page * pageSize).map(t => enrichTopic(t, db));
  res.json({ list: rows, total, pages, page });
});

function toggleTopicFlag(req, res, flag) {
  const db = loadDb();
  const t = db.topics.find(x => x.id === req.params.id || x.slug === req.params.id);
  if (!t) return res.status(404).json({ error: '帖子不存在' });
  t[flag] = !t[flag];
  const flagName = { pinned: '置顶', recommended: '推荐', closed: '锁定' }[flag] || flag;
  modLog(db, (t[flag] ? '设置' : '取消') + flagName, req.user, '', `帖子《${t.title}》`);
  saveDb(db);
  res.json({ ok: true, [flag]: t[flag] });
}
app.post('/api/admin/topics/:id/pin', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'pinned'));
app.post('/api/admin/topics/:id/recommend', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'recommended'));
app.post('/api/admin/topics/:id/close', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'closed'));
/* 设置慢速模式（秒，0=关闭） */
app.post('/api/admin/topics/:id/slowmode', requireAdmin, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const sec = Math.max(0, Math.min(3600, parseInt((req.body || {}).seconds) || 0));
  topic.slowMode = sec;
  saveDb(db);
  res.json({ ok: true, slowMode: sec });
});

app.delete('/api/admin/topics/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = db.topics.findIndex(t => t.id === req.params.id || t.slug === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '帖子不存在' });
  const t = db.topics[idx];
  const b = boardById(db, t.boardId);
  if (b) b.topicCount = Math.max(0, (b.topicCount || 1) - 1);
  db.topics.splice(idx, 1);
  db.users.forEach(u => { const f = u.favorites || []; const fi = f.indexOf(t.id); if (fi >= 0) f.splice(fi, 1); });
  modLog(db, '删除帖子', req.user, '', `删除帖子《${t.title}》`);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/boards', requireAdmin, (req, res) => {
  const db = loadDb();
  const { name, slug, color, description, weight, topicTemplate } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '板块名称和 slug 必填' });
  if (db.boards.find(b => b.slug === slug)) return res.status(409).json({ error: 'slug 已存在' });
  const maxW = db.boards.reduce((m, b) => Math.max(m, b.weight || 0), 0);
  const board = { id: id('b'), name: String(name).slice(0, 20), slug: String(slug).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]/g, '-').slice(0, 30), color: color || '#7b6cf6', description: String(description || '').slice(0, 100), topicCount: 0, weight: typeof weight === 'number' ? weight : maxW + 10 };
  db.boards.push(board);
  saveDb(db);
  res.status(201).json(board);
});

app.put('/api/admin/boards/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const b = boardById(db, req.params.id);
  if (!b) return res.status(404).json({ error: '板块不存在' });
  const { name, slug, color, description, weight } = req.body || {};
  if (slug && slug !== b.slug && db.boards.find(x => x.slug === slug)) return res.status(409).json({ error: 'slug 已存在' });
  if (name) b.name = String(name).slice(0, 20);
  if (slug) b.slug = String(slug).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]/g, '-').slice(0, 30);
  if (color) b.color = color;
  if (description !== undefined) b.description = String(description || '').slice(0, 100);
  if (typeof weight === 'number') b.weight = weight;
  if (topicTemplate !== undefined) b.topicTemplate = String(topicTemplate || '').slice(0, 2000);
  saveDb(db);
  res.json(b);
});

/* 板块排序：按给定 id 顺序重设 weight */
app.post('/api/admin/boards/reorder', requireAdmin, (req, res) => {
  const db = loadDb();
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必填' });
  ids.forEach((bid, i) => { const b = boardById(db, bid); if (b) b.weight = (i + 1) * 10; });
  modLog(db, '板块排序', req.user, '', '调整板块显示顺序');
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/admin/boards/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = db.boards.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '板块不存在' });
  const b = db.boards[idx];
  const cnt = db.topics.filter(t => t.boardId === b.id).length;
  if (cnt > 0 && req.query.force !== '1') return res.status(400).json({ error: `该板块下还有 ${cnt} 个话题，删除话题后可再删除（或强制删除）` });
  db.topics = db.topics.filter(t => t.boardId !== b.id);
  db.boards.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= admin: 公司避雷库 ================= */
/* 管理端公司库（名录 3 万只读 + extraCompanies 增删改 + 评价管理）
 * 性能：名录走预排序缓存；列表行用轻量 companyView，仅对有评价公司做完整 enrich */
app.get('/api/admin/companies', requireAdmin, (req, res) => {
  const db = loadDb();
  const q = (req.query.q || '').toLowerCase();
  const list = filterCompanies(db, { q });
  /* 全量统计与最新评价（不受分页影响）——只遍历有评价的公司 */
  const summary = { total: list.length, danger: 0, withReviews: 0 };
  const recentReviews = [];
  for (const c of list) {
    const rv = (db.companyReviews || {})[c.id];
    if (!rv || !rv.length) continue;
    summary.withReviews++;
    const lv = companyLevel(rv);
    if (lv.level === 'danger') summary.danger++;
    for (const r of rv) recentReviews.push({ ...r, cname: c.name, cid: c.id });
  }
  recentReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
  const total = list.length;
  const rows = list.slice((page - 1) * pageSize, page * pageSize).map(c => companyView(db, c));
  res.json({ list: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), summary, recentReviews: recentReviews.slice(0, 20) });
});

/* 本地模式下把名录变更写回静态文件（Vercel 文件系统只读，返回 409 提示走 extra） */
function writeCatalog() {
  if (IS_VERCEL) return false;
  try {
    fs.writeFileSync(COMPANY_CATALOG_FILE, JSON.stringify(companyCatalog));
    invalidateCompanies();
    return true;
  } catch (e) { console.error('名录写盘失败:', e.message); return false; }
}

app.post('/api/admin/companies', requireAdmin, (req, res) => {
  const db = loadDb();
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: '公司名称不能为空' });
  if (allCompanies(db).some(c => c.name === name)) return res.status(400).json({ error: '公司已存在' });
  const c = {
    id: id('c'), name,
    industry: String((req.body && req.body.industry) || '其他').trim().slice(0, 30),
    region: String((req.body && req.body.region) || '重庆').trim().slice(0, 30),
    note: String((req.body && req.body.note) || '').trim().slice(0, 200),
    createdAt: nowIso(),
  };
  db.extraCompanies.push(c);
  invalidateCompanies();
  saveDb(db);
  res.status(201).json(companyJson(db, c, { withReviews: true }));
});

app.post('/api/admin/companies/batch', requireAdmin, (req, res) => {
  const db = loadDb();
  const text = String((req.body && req.body.text) || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  const names = new Set(allCompanies(db).map(c => c.name));
  const seen = new Set();
  const list = [];
  for (const line of lines) {
    const parts = line.split(/[,，|]/).map(s => s.trim()).filter(Boolean);
    const [name, industry, region, ...rest] = parts;
    if (!name) continue;
    if (seen.has(name) || names.has(name)) { skipped++; continue; }
    seen.add(name); names.add(name);
    const c = {
      id: id('c'), name,
      industry: (industry || '其他').slice(0, 30),
      region: (region || '重庆').slice(0, 30),
      note: (rest.join('') || '').slice(0, 200),
      createdAt: nowIso(),
    };
    db.extraCompanies.push(c); added++; list.push(c);
  }
  invalidateCompanies();
  saveDb(db);
  res.json({ ok: true, added, skipped, companies: list.map(c => companyJson(db, c, { withReviews: true })) });
});

app.put('/api/admin/companies/:id', requireAdmin, async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit, inCatalog } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  if (inCatalog) {
    /* 静态名录条目：本地直接改文件；Vercel 只读则拒绝 */
    if (IS_VERCEL) return res.status(409).json({ error: '内置名录在线上为只读，请用「新增公司」添加同名公司，或本地修改后重新部署' });
    const body = req.body || {};
    if (body.name !== undefined && body.name.trim() && body.name.trim() !== hit.name) {
      if (allCompanies(db).some(x => x.id !== hit.id && x.name === body.name.trim())) return res.status(400).json({ error: '公司已存在' });
      hit.name = body.name.trim().slice(0, 80);
    }
    if (body.industry !== undefined) hit.industry = String(body.industry).trim().slice(0, 30) || hit.industry;
    if (body.region !== undefined) hit.region = String(body.region).trim().slice(0, 30) || hit.region;
    if (body.note !== undefined) hit.note = String(body.note).trim().slice(0, 200);
    if (!writeCatalog()) return res.status(500).json({ error: '名录写入失败' });
    res.json(companyJson(db, hit, { withReviews: true }));
    return;
  }
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: '公司名称不能为空' });
    if (allCompanies(db).some(x => x.id !== hit.id && x.name === name)) return res.status(400).json({ error: '公司已存在' });
    hit.name = name;
  }
  if (body.industry !== undefined) hit.industry = String(body.industry).trim().slice(0, 30) || hit.industry;
  if (body.region !== undefined) hit.region = String(body.region).trim().slice(0, 30) || hit.region;
  if (body.note !== undefined) hit.note = String(body.note).trim().slice(0, 200);
  invalidateCompanies();
  saveDb(db);
  res.json(companyJson(db, hit, { withReviews: true }));
});

app.delete('/api/admin/companies/:id', requireAdmin, async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit, inCatalog } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  if (inCatalog) {
    if (IS_VERCEL) return res.status(409).json({ error: '内置名录在线上为只读，无法删除；本地部署可直接删除' });
    const idx = companyCatalog.indexOf(hit);
    if (idx >= 0) companyCatalog.splice(idx, 1);
    if (!writeCatalog()) return res.status(500).json({ error: '名录写入失败' });
    res.json({ ok: true });
    return;
  }
  const idx = db.extraCompanies.findIndex(x => x.id === hit.id);
  if (idx >= 0) db.extraCompanies.splice(idx, 1);
  invalidateCompanies();
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/admin/companies/:id/reviews/:rid', requireAdmin, async (req, res) => {
  const db = loadDb();
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(req.params.id);
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  db.companyReviews = db.companyReviews || {};
  const reviews = db.companyReviews[hit.id] || [];
  db.companyReviews[hit.id] = reviews.filter(r => r.id !== req.params.rid);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= admin: 待审核公司 ================= */
app.get('/api/admin/companies/pending', requireAdmin, (req, res) => {
  const db = loadDb();
  const list = (db.pendingCompanies || []).filter(c => c.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.post('/api/admin/companies/pending/:pid/approve', requireAdmin, async (req, res) => {
  const db = loadDb();
  const item = (db.pendingCompanies || []).find(c => c.id === req.params.pid && c.status === 'pending');
  if (!item) return res.status(404).json({ error: '待审核公司不存在' });
  /* 检查是否重复 */
  if (COMPANIES_API_URL && !hasNationalCatalog()) await ensureRemoteCompany(item.name);
  const existMeta = findCompanyMeta(db, item.name);
  if (existMeta && existMeta.hit) { item.status = 'rejected'; item.rejectReason = '公司已存在'; saveDb(db); return res.status(409).json({ error: '公司已存在，已自动驳回' }); }
  /* 加入 extraCompanies */
  const c = {
    id: id('c'), name: item.name,
    industry: item.industry || '其他', region: item.province || '其他',
    province: item.province, city: item.city, address: item.address, tags: (item.tags || []).join(','),
    note: item.note || '', submittedBy: item.submittedBy, createdAt: nowIso(),
  };
  db.extraCompanies.push(c);
  item.status = 'approved'; item.approvedAt = nowIso(); item.companyId = c.id;
  invalidateCompanies();
  saveDb(db);
  /* 通知提交者 */
  if (item.submittedById) addNotification(db, item.submittedById, 'mention', { title: '公司审核通过', content: `您提交的「${item.name}」已通过审核，已加入避雷库`, link: '/companies/' + c.id });
  saveDb(db);
  res.json({ ok: true, company: companyJson(db, c, { withReviews: true }) });
});

app.post('/api/admin/companies/pending/:pid/reject', requireAdmin, (req, res) => {
  const db = loadDb();
  const item = (db.pendingCompanies || []).find(c => c.id === req.params.pid && c.status === 'pending');
  if (!item) return res.status(404).json({ error: '待审核公司不存在' });
  item.status = 'rejected'; item.rejectReason = String((req.body && req.body.reason) || '').slice(0, 200); item.rejectedAt = nowIso();
  if (item.submittedById) addNotification(db, item.submittedById, 'mention', { title: '公司审核未通过', content: `您提交的「${item.name}」未通过审核${item.rejectReason ? '：' + item.rejectReason : ''}`, link: '/companies' });
  saveDb(db);
  res.json({ ok: true });
});

/* ================= admin: 举报队列 ================= */
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const db = loadDb();
  const status = req.query.status || 'open';
  const full = db.reports.filter(r => r.status === status).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = full.length;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '30', 10)));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = full.slice((page - 1) * pageSize, page * pageSize).map(r => {
    const reporter = db.users.find(u => u.id === r.reporterId);
    const topic = r.type === 'topic' ? db.topics.find(t => t.id === r.targetId) : null;
    return { ...r, reporterName: (reporter && reporter.name) || r.reporterName, targetSlug: topic && topic.slug };
  });
  res.json({ list: rows, total, pages, page });
});

app.post('/api/admin/reports/:id/status', requireAdmin, (req, res) => {
  const db = loadDb();
  const r = db.reports.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '举报不存在' });
  const status = req.body && req.body.status;
  if (!['resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: '无效状态' });
  r.status = status;
  r.handledBy = req.user.username;
  r.handledAt = nowIso();
  saveDb(db);
  res.json({ ok: true });
});

/* ================= admin: 数据导出 ================= */
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const db = loadDb();
  const stamp = todayStr().replace(/-/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="forum-backup-${stamp}.json"`);
  res.json(db);
});

/* ================= static ================= */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));


/* ================= boot ================= */
/* 本地直接运行：node server.js；部署到 Vercel：导出 Express app 作为 serverless handler */
if (require.main === module) {
  boot().then(() => app.listen(PORT, () => {
    console.log(`JM Forum server running at http://localhost:${PORT}`);
    setTimeout(warmSqlCache, 100);
  })).catch(e => { console.error('启动失败:', e.message); process.exit(1); });
}
module.exports = app;
