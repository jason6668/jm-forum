const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
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
let cacheDb = null;

function emptyDb() {
  return { users: [], boards: [], tags: [], topics: [], sessions: {}, regCodes: [], settings: {}, companies: [], messages: [], notifications: [], reports: [] };
}
function ensureDb() {
  if (IS_VERCEL) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2));
}
async function kvGet() {
  const res = await fetch(`${KV_BASE}/get/${DB_KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!res.ok) throw new Error('KV get ' + res.status);
  const data = await res.json();
  if (data.result === null || data.result === undefined) return null;
  return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
}
async function kvSet(db) {
  const res = await fetch(`${KV_BASE}/set/${DB_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(db),
  });
  if (!res.ok) throw new Error('KV set ' + res.status);
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
  try { await kvSet(cacheDb); } catch (e) { console.error('KV flush failed:', e.message); }
}
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
  return Array.from({ length: 5 }, () => ({ id: id('rc'), code: genRegCode(), note: '演示注册码（管理后台可生成新码）', usedBy: null, usedAt: null, createdAt: nowIso() }));
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

  const users = [
    ['admin', '管理员', 4, 'admin', 120], ['alice', 'Alice', 3, 'user', 45], ['bob', 'Bob', 2, 'user', 30],
    ['carol', 'Carol', 2, 'user', 38], ['dave', 'Dave', 1, 'user', 15], ['eve', 'Eve', 1, 'user', 22],
    ['frank', 'Frank', 1, 'user', 9], ['grace', 'Grace', 2, 'user', 27], ['heidi', 'Heidi', 1, 'user', 14],
    ['ivan', 'Ivan', 1, 'user', 11], ['judy', 'Judy', 1, 'user', 18], ['mallory', 'Mallory', 1, 'user', 6],
    ['oscar', 'Oscar', 1, 'user', 25], ['peggy', 'Peggy', 2, 'user', 33], ['trent', 'Trent', 1, 'user', 12],
    ['victor', 'Victor', 1, 'user', 20], ['wendy', 'Wendy', 1, 'user', 16], ['xavier', 'Xavier', 1, 'user', 8],
    ['yolanda', 'Yolanda', 1, 'user', 10], ['zara', 'Zara', 1, 'user', 13],
  ];
  const adminPwd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!8';
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
  console.log('│  其他种子用户密码: ' + userPwd.padEnd(25) + '│');
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
      cacheDb = await kvGet().catch(() => null) || emptyDb();
      seed(cacheDb);
      migrate(cacheDb);
      await kvSet(cacheDb);
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
    kvGet().then(kvdb => { if (kvdb) cacheDb = kvdb; resolve(); }).catch(() => resolve());
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
    badges: u.badges || [], title: u.title || '', titleExpireAt: u.titleExpireAt || null,
    achievements: u.achievements || [], checkinCount: u.checkinCount || 0,
    followingCount: (u.following || []).length,
  };
}

/* ================= helpers ================= */
function boardById(db, id) { return db.boards.find(b => b.id === id); }
function boardBySlug(db, slug) { return db.boards.find(b => b.slug === slug); }

function enrichTopic(t, db, opts = {}) {
  const board = boardById(db, t.boardId);
  const author = db.users.find(u => u.id === t.userId);
  const lastPost = t.posts[t.posts.length - 1];
  const lastReply = lastPost && lastPost.postNumber > 1 ? db.users.find(u => u.id === lastPost.userId) : null;
  const obj = {
    id: t.id, userId: t.userId, title: t.title, slug: t.slug, excerpt: (t.posts[0]?.content || '').slice(0, 120),
    board: board ? { id: board.id, name: board.name, slug: board.slug, color: board.color } : null,
    author: userPublic(author), createdAt: t.createdAt, bumpedAt: t.bumpedAt,
    viewCount: t.viewCount, replyCount: t.replyCount, likeCount: t.likeCount,
    favoriteCount: t.favoriteCount || 0, tags: t.tags || [], pinned: t.pinned, recommended: t.recommended,
    closed: t.closed, price: t.price || 0, bounty: t.bounty || 0, bestReplyId: t.bestReplyId || null,
    poll: t.poll ? {
      question: t.poll.question, multi: t.poll.multi,
      options: opts.withPosts ? t.poll.options.map((o, i) => ({ text: o.text, votes: o.votes.length, ratio: t.poll.voters.length ? Math.round(o.votes.length / t.poll.voters.length * 100) : 0, myPick: opts.userId ? o.votes.includes(opts.userId) : false })) : undefined,
      total: (t.poll.voters || []).length, myVote: opts.userId ? (t.poll.voters || []).findIndex(v => v === opts.userId) : -1,
    } : null,
    likedByMe: !!opts.userId && (t.likedUsers || []).includes(opts.userId),
    lastReply: lastReply ? { username: lastReply.username, name: lastReply.name, avatar: lastReply.avatar, at: lastPost.createdAt } : null,
  };
  if (opts.withPosts) obj.posts = t.posts.map(p => ({ ...p, author: userPublic(db.users.find(u => u.id === p.userId)), likedByMe: !!opts.userId && (p.likedUsers || []).includes(opts.userId) }));
  return obj;
}

/* ================= auth API ================= */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, name, code } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: '缺少必填字段' });
    const db = loadDb();
    if (db.users.find(u => u.username === username || u.email === email)) return res.status(409).json({ error: '用户名或邮箱已存在' });
    // 邀请注册制：必须持有管理员发放的注册码
    const regCode = String(code || '').trim().toUpperCase();
    if (!regCode) return res.status(400).json({ error: '注册需要注册码，请联系管理员获取' });
    const rc = (db.regCodes || []).find(c => c.code.toUpperCase() === regCode);
    if (!rc) return res.status(400).json({ error: '注册码无效，请检查后重试' });
    if (rc.usedBy) return res.status(400).json({ error: '该注册码已被使用，不能重复注册' });
    const profile = defaultProfile();
    const user = { id: id('u'), username, email, name: name || username, passwordHash: hashPw(password), avatar: null, createdAt: nowIso(), trustLevel: 1, role: 'user', coins: 10, checkinCoins: 0, lastCheckin: '', favorites: [], banned: false, ...profile };
    db.users.push(user);
    rc.usedBy = user.id;
    rc.usedAt = nowIso();
    const token = id('s');
    db.sessions[token] = { userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
    saveDb(db);
    await flushNow();
    notify.notifyAll(db, 'newUser', { username: user.username, name: user.name || user.username }).catch(() => {});
    res.cookie('forum_session', token, { signed: true, httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax' });
    res.json({ user: userPublic(user) });
  } catch (e) {
    res.status(500).json({ error: '注册失败：' + e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { account, password } = req.body || {};
    const db = loadDb();
    const user = db.users.find(u => u.username === account || u.email === account);
    if (!user || !checkPw(password, user.passwordHash)) return res.status(401).json({ error: '账号或密码错误' });
    if (user.banned) return res.status(403).json({ error: '账号已被封禁，如有疑问请联系管理员' });
    const token = id('s');
    db.sessions[token] = { userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
    saveDb(db);
    await flushNow();
    res.cookie('forum_session', token, { signed: true, httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax' });
    res.json({ user: userPublic(user) });
  } catch (e) {
    res.status(500).json({ error: '登录失败：' + e.message });
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
app.get('/api/boards', (req, res) => res.json(loadDb().boards));

app.get('/api/tags', (req, res) => res.json(loadDb().tags));

/* ================= topics ================= */
app.get('/api/topics', (req, res) => {
  const db = loadDb();
  let topics = db.topics.slice();
  const { board, sort, tag, mine } = req.query;
  if (board) { const b = boardBySlug(db, board); if (b) topics = topics.filter(t => t.boardId === b.id); }
  if (tag) topics = topics.filter(t => (t.tags || []).includes(tag));
  if (mine && req.user) topics = topics.filter(t => t.userId === req.user.id);
  if (sort === 'hot') topics.sort((a, b) => (b.viewCount + b.replyCount * 5) - (a.viewCount + a.replyCount * 5));
  else if (sort === 'views') topics.sort((a, b) => b.viewCount - a.viewCount);
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
  topic.viewCount += 1;
  saveDb(db);
  const enriched = enrichTopic(topic, db, { withPosts: true, userId: req.user && req.user.id });
  if (req.user) enriched.favorited = (topic.favoritedUsers || []).includes(req.user.id);
  res.json(enriched);
});

app.post('/api/topics', requireAuth, (req, res) => {
  const { title, content, boardId, tags = [], price, poll, bounty } = req.body || {};
  if (!title || !content || !boardId) return res.status(400).json({ error: '缺少标题、内容或板块' });
  const db = loadDb();
  const board = boardById(db, boardId);
  if (!board) return res.status(404).json({ error: '板块不存在' });
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
  const topic = {
    id: topicId, title, slug: slugify(title), boardId: board.id, userId: req.user.id,
    createdAt: time, bumpedAt: time, viewCount: 0, replyCount: 0, likeCount: 0, favoriteCount: 0, favoritedUsers: [],
    tags: Array.isArray(tags) ? tags.slice(0, 5) : [], posts: [{ id: id('p'), topicId, userId: req.user.id, content, createdAt: time, likeCount: 0, postNumber: 1 }],
    pinned: false, recommended: false, price: Number(price) || 0, closed: false,
    poll: pollObj, bounty: bountyAmount, bestReplyId: null,
  };
  db.topics.push(topic);
  board.topicCount += 1;
  addExp(db, req.user, 5);
  unlockAch(db, req.user.id, 'first-topic');
  checkCumulativeAch(db, req.user);
  /* 发帖时 @提及通知（尊重被提及者 notifyMention 偏好开关） */
  scanMentions(db, content, req.user.id).forEach(u => {
    if ((u.preferences && u.preferences.notifyMention) !== false) addNotification(db, u.id, 'mention', { topicId: topic.id, topicTitle: topic.title, fromId: req.user.id, fromName: req.user.name || req.user.username, content: content.slice(0, 80) });
  });
  saveDb(db);
  notify.notifyAll(db, 'newTopic', { topicId: topic.id, title: topic.title, board: board.name, username: req.user.username, name: req.user.name || req.user.username }).catch(() => {});
  res.status(201).json(enrichTopic(topic, db));
});

app.post('/api/topics/:id/replies', requireAuth, (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: '回复内容不能为空' });
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  if (topic.closed) return res.status(403).json({ error: '帖子已关闭' });
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

app.get('/api/companies', (req, res) => {
  const db = loadDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 30));
  const { q, industry, region, city, tag, sort } = req.query;
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

app.get('/api/companies/meta/industries', (req, res) => {
  const db = loadDb();
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
app.get('/api/companies/meta/provinces', (req, res) => {
  const db = loadDb();
  const s = sqlMetaProvinces();
  if (s) return res.json(s);
  res.json([]);
});
app.get('/api/companies/meta/tags', (req, res) => {
  const db = loadDb();
  const s = sqlMetaTags();
  if (s) return res.json(s);
  res.json([]);
});
app.get('/api/companies/stats', (req, res) => {
  const db = loadDb();
  const s = sqlStats();
  if (s) return res.json({ ok: true, ...s });
  res.json({ ok: true, total: loadCompanyCatalog().length, provinces: 1, industries: 0, years: { min: 0, max: 0 }, chongqing: loadCompanyCatalog().filter(c => (c.region || '').includes('重庆') || c.region === '渝').length });
});

/* 避雷热榜：全国 / 按省份；红黑榜 */
app.get('/api/companies/hot', (req, res) => {
  const db = loadDb();
  const province = req.query.province || '';
  const type = req.query.type || 'danger'; // danger=强烈避雷榜 / reviews=热议榜 / red=红榜(口碑好)
  const reviews = db.companyReviews || {};
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
app.post('/api/companies/submit', requireAuth, (req, res) => {
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

app.get('/api/companies/:id', (req, res) => {
  const db = loadDb();
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const j = companyJson2(db, hit, { withReviews: true, userId: req.user ? req.user.id : null, watched: req.user ? (req.user.watchCompanies || []) : [] });
  res.json(j);
});

/* 评价：支持匿名 + 点赞/踩；未登录访客也可评价（带昵称） */
app.post('/api/companies/:id/reviews', (req, res) => {
  const db = loadDb();
  const { hit } = findCompanyMeta(db, req.params.id);
  if (!hit) return res.status(404).json({ error: '公司不存在' });
  const rating = Number((req.body && req.body.rating));
  if (![1, 2, 3, 4, 5].includes(rating)) return res.status(400).json({ error: '请选择 1-5 星避雷指数' });
  const content = String((req.body && req.body.content) || '').trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: '请写一句避雷理由' });
  db.companyReviews = db.companyReviews || {};
  const reviews = db.companyReviews[hit.id] || (db.companyReviews[hit.id] = []);
  const isAnon = !req.user || !!req.body.anonymous;
  const nick = isAnon ? (String((req.body && req.body.nickname) || '').trim().slice(0, 20) || '匿名访客') : (req.user.name || req.user.username);
  if (req.user) {
    const mine = reviews.find(r => r.userId === req.user.id);
    if (mine) { mine.rating = rating; mine.content = content; mine.anonymous = isAnon; mine.nickname = isAnon ? nick : null; mine.createdAt = nowIso(); saveDb(db); return res.json(companyJson2(db, hit, { withReviews: true, userId: req.user.id, watched: req.user.watchCompanies || [] })); }
  } else {
    /* 访客匿名评价：按昵称+IP 防刷（同一公司同一昵称 10 分钟内只能评一次） */
    const guestKey = nick + '|' + (req.ip || 'unknown');
    const recent = reviews.find(r => r.guestKey === guestKey && (Date.now() - new Date(r.createdAt).getTime()) < 600000);
    if (recent) return res.status(429).json({ error: '评价太频繁，请 10 分钟后再试' });
  }
  const review = {
    id: id('rv'), userId: req.user ? req.user.id : null, username: req.user ? req.user.username : null,
    name: nick, avatar: req.user && !isAnon ? req.user.avatar : null, rating, content,
    anonymous: isAnon, nickname: isAnon ? nick : null, guestKey: req.user ? null : (nick + '|' + (req.ip || 'unknown')),
    votes: { up: [], down: [] }, createdAt: nowIso(),
  };
  reviews.push(review);
  if (req.user) { addExp(db, req.user, 3); unlockAch(db, req.user.id, 'company-review'); checkCumulativeAch(db, req.user); }
  saveDb(db);
  res.json(companyJson2(db, hit, { withReviews: true, userId: req.user ? req.user.id : null, watched: req.user ? (req.user.watchCompanies || []) : [] }));
});

/* 评价点赞/踩 */
app.post('/api/companies/:id/reviews/:rid/vote', requireAuth, (req, res) => {
  const db = loadDb();
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
  saveDb(db);
  res.json({ liked, likeCount: topic.likeCount });
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

app.get('/api/favorites', requireAuth, (req, res) => {
  const db = loadDb();
  const ids = req.user.favorites || [];
  const list = db.topics.filter(t => ids.includes(t.id)).sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  res.json(list.map(t => enrichTopic(t, db)));
});

/* ================= 帖子编辑 / 删除（作者或管理员） ================= */
app.put('/api/topics/:id', requireAuth, (req, res) => {
  const db = loadDb();
  const topic = db.topics.find(t => t.id === req.params.id || t.slug === req.params.id);
  if (!topic) return res.status(404).json({ error: '帖子不存在' });
  const isAuthor = topic.userId === req.user.id;
  const isStaff = ['admin', 'owner'].includes(req.user.role);
  if (!isAuthor && !isStaff) return res.status(403).json({ error: '只有作者或管理员可以编辑' });
  const { title, content, tags, boardId } = req.body || {};
  if (isAuthor || isStaff) {
    if (title !== undefined) {
      const t = String(title).trim().slice(0, 80);
      if (!t) return res.status(400).json({ error: '标题不能为空' });
      topic.title = t;
    }
    if (boardId) { const b = boardById(db, boardId); if (b) topic.boardId = b.id; }
    if (Array.isArray(tags)) topic.tags = tags.slice(0, 5);
  }
  if (content !== undefined) {
    const t = String(content).trim();
    if (!t) return res.status(400).json({ error: '内容不能为空' });
    topic.posts[0].content = t;
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
    return { username: u.username, name: u.name, avatar: u.avatar, posts: s.posts, replies: s.replies, total: s.posts + s.replies, coins: u.coins || 0 };
  }).filter(u => u.total > 0).sort((a, b) => b.total - a.total || b.coins - a.coins).slice(0, 50);
  res.json(list);
});

/* ================= 标签聚合 ================= */
app.get('/api/tag/:name', (req, res) => {
  const db = loadDb();
  const name = decodeURIComponent(req.params.name);
  const list = db.topics.filter(t => (t.tags || []).includes(name)).sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt));
  res.json(list.map(t => enrichTopic(t, db)));
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
    req.user.title = titleText;
    req.user.titleExpireAt = item.value === '__CUSTOM__' ? new Date(Date.now() + 7 * 86400000).toISOString() : null;
  }
  req.user.coins -= item.price;
  if (item.stock > 0) item.stock -= 1;
  unlockAch(db, req.user.id, 'shop-buy');
  saveDb(db);
  res.json({ ok: true, coins: req.user.coins, title: req.user.title, badges: req.user.badges });
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

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不能封禁自己' });
  /* 站长可封禁管理员，但不能封禁站长；管理员只能封禁普通用户 */
  const canBan = req.user.role === 'owner' ? u.role !== 'owner' : u.role === 'user';
  if (!canBan) return res.status(400).json({ error: req.user.role === 'owner' ? '不能封禁站长' : '不能封禁管理员或站长' });
  u.banned = true;
  saveDb(db);
  res.json({ ok: true, user: adminUserJson(u, db) });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  u.banned = false;
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
  saveDb(db);
  res.json({ ok: true, [flag]: t[flag] });
}
app.post('/api/admin/topics/:id/pin', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'pinned'));
app.post('/api/admin/topics/:id/recommend', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'recommended'));
app.post('/api/admin/topics/:id/close', requireAdmin, (req, res) => toggleTopicFlag(req, res, 'closed'));

app.delete('/api/admin/topics/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const idx = db.topics.findIndex(t => t.id === req.params.id || t.slug === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '帖子不存在' });
  const t = db.topics[idx];
  const b = boardById(db, t.boardId);
  if (b) b.topicCount = Math.max(0, (b.topicCount || 1) - 1);
  db.topics.splice(idx, 1);
  db.users.forEach(u => { const f = u.favorites || []; const fi = f.indexOf(t.id); if (fi >= 0) f.splice(fi, 1); });
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/boards', requireAdmin, (req, res) => {
  const db = loadDb();
  const { name, slug, color, description } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '板块名称和 slug 必填' });
  if (db.boards.find(b => b.slug === slug)) return res.status(409).json({ error: 'slug 已存在' });
  const board = { id: id('b'), name: String(name).slice(0, 20), slug: String(slug).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]/g, '-').slice(0, 30), color: color || '#7b6cf6', description: String(description || '').slice(0, 100), topicCount: 0 };
  db.boards.push(board);
  saveDb(db);
  res.status(201).json(board);
});

app.put('/api/admin/boards/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const b = boardById(db, req.params.id);
  if (!b) return res.status(404).json({ error: '板块不存在' });
  const { name, slug, color, description } = req.body || {};
  if (slug && slug !== b.slug && db.boards.find(x => x.slug === slug)) return res.status(409).json({ error: 'slug 已存在' });
  if (name) b.name = String(name).slice(0, 20);
  if (slug) b.slug = String(slug).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]/g, '-').slice(0, 30);
  if (color) b.color = color;
  if (description !== undefined) b.description = String(description || '').slice(0, 100);
  saveDb(db);
  res.json(b);
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

app.put('/api/admin/companies/:id', requireAdmin, (req, res) => {
  const db = loadDb();
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

app.delete('/api/admin/companies/:id', requireAdmin, (req, res) => {
  const db = loadDb();
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

app.delete('/api/admin/companies/:id/reviews/:rid', requireAdmin, (req, res) => {
  const db = loadDb();
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

app.post('/api/admin/companies/pending/:pid/approve', requireAdmin, (req, res) => {
  const db = loadDb();
  const item = (db.pendingCompanies || []).find(c => c.id === req.params.pid && c.status === 'pending');
  if (!item) return res.status(404).json({ error: '待审核公司不存在' });
  /* 检查是否重复 */
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
  }));
}
module.exports = app;
