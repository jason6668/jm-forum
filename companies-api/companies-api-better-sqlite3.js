/* 全国公司库只读查询 API（独立服务）· better-sqlite3 版
 * 数据：companies.db（jm-forum releases v9-data，585 万家，FTS5 trigram 全文索引）
 * 依赖：npm install better-sqlite3
 * 启动：DB_FILE=/path/companies.db PORT=3457 API_KEY=xxx node companies-api.js
 * 接口均为 GET，返回 JSON。写操作（评价/提交）不在这里，走论坛主服务。
 *
 * 查询层设计（585 万行，慢盘也必须在 12 秒内返回）：
 *  - 列表/过滤一律按 name 有序走 idx_name 索引扫描（INDEXED BY），绝不做全表 ORDER BY；
 *  - 默认浏览（无过滤）：重庆置顶两段式 —— 先取重庆（17.9万），再补其他省份；
 *  - total 计数：无过滤直接用 stats 缓存；有过滤走索引计数 + 进程级缓存；
 *  - FTS 全文搜索（q>=3字符）：trigram 索引，bm25 取前 2000 候选再做重庆置顶。
 *
 * 接口契约（论坛 server.js 代理层依赖以下格式）：
 *   GET /companies?q=&province=&city=&industry=&tag=&sort=&page=&pageSize=&excludeIds=
 *     → { list:[{id,name,province,city,address,industry,tags,regYear,capital,legal,source}], total, page, pageSize, pages, via:'sqlite' }
 *   GET /companies/batch?ids=1,2,3 → [row]
 *   GET /companies/:idOrName → row | 404
 *   GET /meta/industries → [{name,count}]   GET /meta/provinces → [{name,count}]   GET /meta/tags → [{tag,count}]
 *   GET /stats → {total,provinces,industries,years:{min,max},chongqing}
 *   GET /health → {ok:true}
 * 鉴权：请求头 x-api-key（未设置 API_KEY 时免鉴权，仅限内网调试用）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'companies.db');
const PORT = parseInt(process.env.PORT || '3457', 10);
const API_KEY = process.env.API_KEY || '';

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('缺少依赖：请先 npm install better-sqlite3'); process.exit(1); }
if (!fs.existsSync(DB_FILE)) { console.error('找不到 DB 文件:', DB_FILE); process.exit(1); }
const sdb = new Database(DB_FILE, { readonly: true });
console.log('公司库已打开:', DB_FILE);

/* 启动自检：确认依赖的索引都在（缺失则告警，查询会降级变慢） */
for (const ix of ['idx_name', 'idx_prov', 'idx_industry', 'idx_year']) {
  const hit = sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(ix);
  if (!hit) console.error('警告：缺少索引 ' + ix + '，相关查询会变慢');
}
const hasFts = !!sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companies_fts'").get();
if (!hasFts) console.error('警告：缺少 FTS 表 companies_fts，全文搜索不可用');

function row(r) {
  return {
    id: String(r.id), name: r.name, province: r.province || '其他', city: r.city || r.province || '',
    address: r.address || '', industry: r.industry || '其他',
    tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
    regYear: r.reg_year || null, capital: r.capital || '', legal: r.legal || '', source: 'national',
  };
}
const cache = {};
const cached = (k, fn) => (k in cache ? cache[k] : (cache[k] = fn()));
/* 静态 DB 的聚合结果 sidecar 缓存：重启秒就绪，避免每次冷启动全表扫描几分钟 */
const CACHE_FILE = DB_FILE + '.cache.json';
function loadCacheFile() {
  try {
    const st = fs.statSync(DB_FILE);
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && c.mtime === st.mtimeMs && c.size === st.size && c.stats) {
      cache.stats = c.stats; cache.industries = c.industries; cache.provinces = c.provinces;
      if (c.stats && c.stats.total) countCache.set('t:', c.stats.total); /* 重启后首次默认列表不用再 COUNT(*) */
      for (const r of c.industries || [])
        countCache.set('f|' + JSON.stringify(['', '', r.name, '', '']), r.count);
      for (const r of c.provinces || [])
        countCache.set('f|' + JSON.stringify([r.name, '', '', '', '']), r.count);
      console.log('已加载聚合缓存，跳过重算');
      return true;
    }
  } catch (e) { /* 无缓存或 DB 已变化，走正常计算 */ }
  return false;
}
function saveCacheFile() {
  try {
    const st = fs.statSync(DB_FILE);
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      mtime: st.mtimeMs, size: st.size,
      stats: cache.stats, industries: cache.industries, provinces: cache.provinces,
    }));
    console.log('聚合缓存已写入 ' + CACHE_FILE);
  } catch (e) { console.error('缓存文件写入失败:', e.message); }
}
function getStats() {
  return cached('stats', () => ({
    total: sdb.prepare('SELECT COUNT(*) n FROM companies').get().n,
    provinces: sdb.prepare('SELECT COUNT(DISTINCT province) n FROM companies').get().n,
    industries: sdb.prepare('SELECT COUNT(DISTINCT industry) n FROM companies').get().n,
    years: sdb.prepare('SELECT MIN(reg_year) min, MAX(reg_year) max FROM companies').get(),
    chongqing: sdb.prepare("SELECT COUNT(*) n FROM companies WHERE province='重庆'").get().n,
  }));
}

function getIndustries() {
  return cached('industries', () => sdb.prepare(
    'SELECT industry name, COUNT(*) count FROM companies GROUP BY industry ORDER BY count DESC LIMIT 80').all());
}
function getProvinces() {
  return cached('provinces', () => sdb.prepare(
    "SELECT province name, COUNT(*) count FROM companies GROUP BY province ORDER BY CASE WHEN province='重庆' THEN 0 ELSE 1 END, count DESC").all());
}
const countCache = new Map();
function cachedCount(key, sql, params) {
  if (countCache.has(key)) return countCache.get(key);
  const n = sdb.prepare(sql).get(...params).n;
  countCache.set(key, n);
  if (countCache.size > 2000) countCache.delete(countCache.keys().next().value);
  return n;
}
/* 按 name 有序的索引扫描：强制走 idx_name，避免 planner 对大过滤集误选全表排序 */
function scanByName(whereSql, params, limit, offset) {
  return sdb.prepare(
    `SELECT * FROM companies INDEXED BY idx_name ${whereSql} ORDER BY name LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
}
const pageOut = (list, total, page, pageSize) => ({
  list: list.map(row), total, page, pageSize,
  pages: Math.max(1, Math.ceil(total / pageSize)), via: 'sqlite',
});

function search({ q, province, city, industry, tag, sort, page, pageSize, excludeIds }) {
  const qs = String(q || '').trim();
  const notIn = (excludeIds && excludeIds.length)
    ? { sql: `id NOT IN (${excludeIds.map(() => '?').join(',')})`, params: excludeIds } : null;

  /* ---------- FTS 全文搜索（q>=3字符） ---------- */
  if (hasFts && qs.length >= 3) {
    const where = [], params = [];
    if (province) { where.push('c.province = ?'); params.push(province); }
    if (city) { where.push('c.city = ?'); params.push(city); }
    if (industry) { where.push('c.industry = ?'); params.push(industry); }
    if (tag) { where.push('c.tags LIKE ?'); params.push('%' + tag + '%'); }
    if (notIn) { where.push('c.' + notIn.sql); params.push(...notIn.params); }
    where.push('companies_fts MATCH ?');
    params.push('"' + qs.replace(/"/g, '""') + '"');
    const whereSql = 'WHERE ' + where.join(' AND ');
    const ftsJoin = 'JOIN companies_fts f ON f.rowid = c.id';
    const total = notIn
      ? sdb.prepare(`SELECT COUNT(*) n FROM companies c ${ftsJoin} ${whereSql}`).get(...params).n
      : cachedCount('fts|' + qs + '|' + province + '|' + city + '|' + industry + '|' + tag,
          `SELECT COUNT(*) n FROM companies c ${ftsJoin} ${whereSql}`, params);
    const off = (page - 1) * pageSize;
    /* bm25 取前 2000 候选（2000 行内排序极快），再做重庆置顶 */
    const rows = off >= 2000 ? [] : sdb.prepare(
      `SELECT * FROM (SELECT c.* FROM companies c ${ftsJoin} ${whereSql} ORDER BY bm25(companies_fts) LIMIT 2000) ` +
      `ORDER BY CASE WHEN province='重庆' THEN 0 ELSE 1 END, name LIMIT ? OFFSET ?`
    ).all(...params, pageSize, off);
    return pageOut(rows, total, page, pageSize);
  }

  /* ---------- 非 FTS 查询 ---------- */
  const where = [], params = [];
  if (province) { where.push('province = ?'); params.push(province); }
  if (city) { where.push('city = ?'); params.push(city); }
  if (industry) { where.push('industry = ?'); params.push(industry); }
  if (tag) { where.push('tags LIKE ?'); params.push('%' + tag + '%'); }
  if (notIn) { where.push(notIn.sql); params.push(...notIn.params); }
  if (qs) { where.push('name LIKE ?'); params.push(qs + '%'); } /* 短 q：前缀搜索，走 idx_name */
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const off = (page - 1) * pageSize;

  /* 按注册年份倒序：走 idx_year */
  if (sort === 'new') {
    const key = 'new|' + JSON.stringify([province, city, industry, tag, qs]);
    const total = notIn
      ? sdb.prepare(`SELECT COUNT(*) n FROM companies ${whereSql}`).get(...params).n
      : cachedCount(key, `SELECT COUNT(*) n FROM companies ${whereSql}`, params);
    const rows = sdb.prepare(
      `SELECT * FROM companies ${whereSql} ORDER BY reg_year DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, off);
    return pageOut(rows, total, page, pageSize);
  }

  /* 默认浏览（无任何过滤）：重庆置顶两段式，全部走索引 */
  if (!where.length) {
    const st = getStats();
    let list = [];
    if (off < st.chongqing) list = scanByName(`WHERE province='重庆'`, [], pageSize, off);
    if (list.length < pageSize) {
      const need = pageSize - list.length;
      const off2 = Math.max(0, off - st.chongqing);
      list = list.concat(scanByName(`WHERE province != '重庆'`, [], need, off2));
    }
    return pageOut(list, st.total, page, pageSize);
  }

  /* 有过滤条件：统一按 name 有序扫描 */
  const key = 'f|' + JSON.stringify([province, city, industry, tag, qs]);
  const total = notIn
    ? sdb.prepare(`SELECT COUNT(*) n FROM companies ${whereSql}`).get(...params).n
    : cachedCount(key, `SELECT COUNT(*) n FROM companies ${whereSql}`, params);
  return pageOut(scanByName(whereSql, params, pageSize, off), total, page, pageSize);
}

function batch(ids) {
  const clean = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 500);
  if (!clean.length) return [];
  const ph = clean.map(() => '?').join(',');
  return sdb.prepare(`SELECT * FROM companies WHERE id IN (${ph})`).all(...clean).map(row);
}
function find(idOrName) {
  const key = String(idOrName).trim();
  const r = Number.isInteger(Number(key)) && String(Number(key)) === key
    ? sdb.prepare('SELECT * FROM companies WHERE id = ? LIMIT 1').get(Number(key))
    : sdb.prepare('SELECT * FROM companies WHERE name = ? LIMIT 1').get(key);
  return r ? row(r) : null;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'unauthorized' });
    const p = u.pathname, qp = u.searchParams;
    if (p === '/health') return send(200, { ok: true, via: 'companies-api' });
    if (p === '/companies') {
      const excludeIds = (qp.get('excludeIds') || '').split(',').map(Number).filter(Number.isInteger);
      return send(200, search({
        q: qp.get('q') || '', province: qp.get('province') || '', city: qp.get('city') || '',
        industry: qp.get('industry') || '', tag: qp.get('tag') || '', sort: qp.get('sort') || '',
        page: Math.max(1, parseInt(qp.get('page')) || 1),
        pageSize: Math.min(100, Math.max(1, parseInt(qp.get('pageSize')) || 30)),
        excludeIds,
      }));
    }
    if (p === '/companies/batch') {
      const ids = (qp.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
      return send(200, batch(ids));
    }
    if (p === '/meta/industries') return send(200, getIndustries());
    if (p === '/meta/provinces') return send(200, getProvinces());
    if (p === '/meta/tags') return send(200, cached('tags',
      () => sdb.prepare(`SELECT value tag, COUNT(*) count FROM companies, json_each('["' || replace(tags, ',', '","') || '"]') WHERE tags != '' GROUP BY value ORDER BY count DESC LIMIT 50`).all()));
    if (p === '/stats') return send(200, getStats());
    const m = p.match(/^\/companies\/(.+)$/);
    if (m) {
      const r = find(decodeURIComponent(m[1]));
      return r ? send(200, r) : send(404, { error: 'not found' });
    }
    return send(404, { error: 'not found' });
  } catch (e) { send(500, { error: e.message }); }
});
const cacheReady = loadCacheFile();
server.listen(PORT, '0.0.0.0', () => {
  console.log('companies-api listening on :' + PORT);
  /* 预热（异步）：把 FTS 索引页读进内存；聚合数据有 sidecar 缓存则秒就绪 */
  if (process.env.WARMUP === '0') { console.log('跳过预热（WARMUP=0）'); return; }
  setImmediate(() => {
    try {
      const t0 = Date.now();
      if (!cacheReady) {
        getStats();
        for (const r of getIndustries())
          countCache.set('f|' + JSON.stringify(['', '', r.name, '', '']), r.count);
        for (const r of getProvinces())
          countCache.set('f|' + JSON.stringify([r.name, '', '', '', '']), r.count);
        saveCacheFile();
      }
      if (hasFts) search({ q: '腾讯科技', page: 1, pageSize: 1 });
      console.log('预热完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
    } catch (e) { console.error('预热失败:', e.message); }
  });
});
