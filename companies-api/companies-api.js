/* 全国公司库只读查询 API（独立服务）
 * 数据：companies.db（jm-forum releases v9-data，585 万家，node:sqlite FTS5）
 * 启动：DB_FILE=/path/companies.db PORT=3457 [API_KEY=xxx] node companies-api.js
 * 接口均为 GET，返回 JSON。写操作（评价/提交）不在这里，走论坛主服务。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { DatabaseSync = null; }

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'companies.db');
const PORT = parseInt(process.env.PORT || '3457', 10);
const API_KEY = process.env.API_KEY || '';

if (!DatabaseSync) { console.error('需要 Node 22+（node:sqlite）'); process.exit(1); }
if (!fs.existsSync(DB_FILE)) { console.error('找不到 DB 文件:', DB_FILE); process.exit(1); }
const sdb = new DatabaseSync(DB_FILE, { readOnly: true });
console.log('公司库已打开:', DB_FILE);

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
function getStats() {
  return cached('stats', () => ({
    total: sdb.prepare('SELECT COUNT(*) n FROM companies').get().n,
    provinces: sdb.prepare('SELECT COUNT(DISTINCT province) n FROM companies').get().n,
    industries: sdb.prepare('SELECT COUNT(DISTINCT industry) n FROM companies').get().n,
    years: sdb.prepare('SELECT MIN(reg_year) min, MAX(reg_year) max FROM companies').get(),
    chongqing: sdb.prepare("SELECT COUNT(*) n FROM companies WHERE province='重庆'").get().n,
  }));
}

function search({ q, province, city, industry, tag, sort, page, pageSize, excludeIds }) {
  const where = [], params = [];
  if (province) { where.push('c.province = ?'); params.push(province); }
  if (city) { where.push('c.city = ?'); params.push(city); }
  if (industry) { where.push('c.industry = ?'); params.push(industry); }
  if (tag) { where.push('c.tags LIKE ?'); params.push('%' + tag + '%'); }
  if (excludeIds && excludeIds.length) {
    where.push(`c.id NOT IN (${excludeIds.map(() => '?').join(',')})`);
    params.push(...excludeIds);
  }
  const qs = String(q || '').trim();
  let ftsJoin = '';
  if (qs) {
    if (qs.length >= 3) {
      ftsJoin = 'JOIN companies_fts f ON f.rowid = c.id';
      where.push('companies_fts MATCH ?');
      params.push('"' + qs.replace(/"/g, '""') + '"');
    } else { where.push('c.name LIKE ?'); params.push(qs + '%'); }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderBy = sort === 'new' ? 'ORDER BY c.reg_year DESC, c.id DESC'
    : "ORDER BY CASE WHEN c.province='重庆' THEN 0 ELSE 1 END, c.name";
  const total = sdb.prepare(`SELECT COUNT(*) n FROM companies c ${ftsJoin} ${whereSql}`).get(...params).n;
  /* FTS 全文搜索命中可能几十万条：先按 bm25 相关度取前 2000 候选，再做重庆置顶排序，
   * 避免对全量命中做全局排序（12 秒论坛超时兜底） */
  let rows;
  if (ftsJoin && qs) {
    const off = (page - 1) * pageSize;
    rows = off >= 2000 ? [] : sdb.prepare(
      `SELECT * FROM (SELECT c.* FROM companies c ${ftsJoin} ${whereSql} ORDER BY bm25(companies_fts) LIMIT 2000) AS c ` +
      `${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, off);
    return { list: rows.map(row), total, page, pageSize, pages: Math.max(1, Math.ceil(Math.min(total, 2000) / pageSize)), via: 'companies-api' };
  }
  rows = sdb.prepare(`SELECT * FROM companies c ${ftsJoin} ${whereSql} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { list: rows.map(row), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), via: 'companies-api' };
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
    if (p === '/meta/industries') return send(200, cached('industries',
      () => sdb.prepare('SELECT industry name, COUNT(*) count FROM companies GROUP BY industry ORDER BY count DESC LIMIT 80').all()));
    if (p === '/meta/provinces') return send(200, cached('provinces',
      () => sdb.prepare("SELECT province name, COUNT(*) count FROM companies GROUP BY province ORDER BY CASE WHEN province='重庆' THEN 0 ELSE 1 END, count DESC").all()));
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
server.listen(PORT, '0.0.0.0', () => {
  console.log('companies-api listening on :' + PORT);
  /* 预热：让 FTS 索引页进内存，避免上线后首次搜索超时（异步，不阻塞服务） */
  setImmediate(() => {
    try {
      getStats();
      search({ q: '腾讯科技', page: 1, pageSize: 1 });
      console.log('预热完成');
    } catch (e) { console.error('预热失败:', e.message); }
  });
});
