/* 公司避雷库集成测试（v9 双模式：SQLite 全国 1000 万+ / 静态 3 万名录降级）：跑完后自动清理测试数据 */
const BASE = 'http://localhost:3000';
const H = { 'Content-Type': 'application/json' };
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}
async function req(path, opts = {}, cookie) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, j };
}
async function login(account, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ account, password }) });
  const m = (r.headers.get('set-cookie') || '').match(/forum_session=([^;]+)/);
  return m && m[1];
}
(async () => {
  const adminT = await login('admin', '123456');
  const aliceT = await login('alice', '123456');
  check('管理员登录', !!adminT);
  check('普通用户登录', !!aliceT);
  const AH = 'forum_session=' + adminT;
  const UH = 'forum_session=' + aliceT;

  console.log('\n—— 模式探测 ——');
  let r = await req('/api/companies?page=1&pageSize=30');
  const MODE = r.j.via || 'static';
  check('返回 via 字段（sqlite / static）', ['sqlite', 'static'].includes(MODE), 'via=' + MODE);
  console.log('   当前模式：' + MODE);

  console.log('\n—— 公开列表与搜索 ——');
  if (MODE === 'sqlite') {
    check('SQLite 全国总量为百万级', r.s === 200 && r.j.total >= 1000000, 'total=' + r.j.total);
    check('列表含省份/城市/注册年份/资金/法人/风险标签', r.j.list.length > 0 && r.j.list[0].province && r.j.list[0].regYear !== undefined && r.j.list[0].source === 'national');
    r = await req('/api/companies?province=' + encodeURIComponent('重庆') + '&pageSize=30');
    check('按省份筛选重庆', r.s === 200 && r.j.list.length > 0 && r.j.list.every(c => c.province === '重庆'));
    r = await req('/api/companies?q=' + encodeURIComponent('长安汽车'));
    check('FTS 搜索命中真实公司', r.s === 200 && r.j.total >= 1 && r.j.list[0].name.includes('长安'));
    r = await req('/api/companies?sort=new&pageSize=10');
    check('按注册年份倒序', r.s === 200 && r.j.list.length > 0 && r.j.list[0].regYear >= r.j.list[r.j.list.length - 1].regYear);
    r = await req('/api/companies/meta/provinces');
    check('省份统计 30+ 且重庆置顶第一', r.s === 200 && r.j.length >= 30 && r.j[0].name === '重庆', 'first=' + (r.j[0] && r.j[0].name));
    r = await req('/api/companies/meta/tags');
    check('风险标签统计非空', r.s === 200 && r.j.length > 0 && r.j[0].tag && r.j[0].count > 0);
    const tagName = r.j[0].tag;
    r = await req('/api/companies?tag=' + encodeURIComponent(tagName) + '&pageSize=10');
    check('按风险标签筛选', r.s === 200 && r.j.list.length > 0 && r.j.list.every(c => (c.tags || []).includes(tagName)));
    r = await req('/api/companies/stats');
    check('数据看板：全国总量/省份数/重庆数', r.s === 200 && r.j.total >= 1000000 && r.j.provinces >= 30 && r.j.chongqing > 0, JSON.stringify({ total: r.j.total, provinces: r.j.provinces, chongqing: r.j.chongqing }));
    r = await req('/api/companies/meta/industries');
    check('行业统计（SQLite 版）', r.s === 200 && r.j.length >= 10 && r.j.every(x => x.count > 0));
  } else {
    check('静态名录 total=30000', r.s === 200 && r.j.total === 30000);
    check('pages 计算正确', r.j.pages === 1000 && r.j.list.length === 30);
    r = await req('/api/companies?q=' + encodeURIComponent('长安汽车'));
    check('搜索命中真实种子', r.s === 200 && r.j.total === 1 && r.j.list[0].name === '长安汽车' && r.j.list[0].source === 'real');
    r = await req('/api/companies?region=' + encodeURIComponent('城口'));
    check('按区县筛选', r.s === 200 && r.j.total > 0 && r.j.list.every(c => c.region === '城口'));
    r = await req('/api/companies/meta/industries');
    check('行业统计接口', r.s === 200 && r.j.length === 60 && r.j.every(x => x.count > 0));
  }
  r = await req('/api/companies?page=99999999');
  check('越界页返回空', r.s === 200 && r.j.list.length === 0);

  console.log('\n—— 评价（打星 + 匿名 + 点赞） ——');
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 5, content: '裁员不给赔偿，避雷' }) });
  check('未登录评价被拒 401', r.s === 401);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 5, content: '裁员不给赔偿，避雷' }) }, UH);
  check('alice 评价长安汽车', r.s === 200 && r.j.reviewCount === 1 && r.j.avg === 5 && r.j.level === 'danger');
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 3, content: '加班多但工资还行' }) }, AH);
  check('admin 评价（拉低均分）', r.s === 200 && r.j.reviewCount === 2 && r.j.avg === 4);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 2, content: '更新一下' }) }, UH);
  check('同用户重复评价覆盖', r.s === 200 && r.j.reviewCount === 2 && r.j.avg === 2.5);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 6, content: 'x' }) }, UH);
  check('无效星级 400', r.s === 400);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车'), {}, UH);
  check('登录态详情含 myReview', r.s === 200 && r.j.myReview && r.j.myReview.rating === 2);
  /* 匿名评价 */
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 1, content: '匿名吐槽一下', anonymous: true }) }, AH);
  const anonReview = (r.j.reviews || []).find(rv => rv.content === '匿名吐槽一下');
  check('admin 匿名评价生效', r.s === 200 && anonReview && anonReview.anonymous === true && !anonReview.username && !anonReview.name && !anonReview.avatar);
  /* 评价点赞/踩 */
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews/' + anonReview.id + '/vote', { method: 'POST', body: JSON.stringify({ dir: 1 }) }, UH);
  check('alice 给匿名评价点赞', r.s === 200 && r.j.upCount === 1 && r.j.myVote === 1);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews/' + anonReview.id + '/vote', { method: 'POST', body: JSON.stringify({ dir: -1 }) }, AH);
  check('admin 踩自己的评价', r.s === 200 && r.j.downCount === 1);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/reviews/' + anonReview.id + '/vote', { method: 'POST', body: JSON.stringify({ dir: -1 }) }, UH);
  check('重复投票切换（改为踩）', r.s === 200 && r.j.myVote === -1 && r.j.upCount === 0 && r.j.downCount === 2);

  console.log('\n—— 避雷热榜 / 红黑榜 / 避雷清单 ——');
  r = await req('/api/companies/hot?type=danger');
  check('避雷热榜（danger）', r.s === 200 && r.j.some(c => c.name === '长安汽车'));
  r = await req('/api/companies/hot?type=red');
  check('红榜（red 口碑好）', r.s === 200 && Array.isArray(r.j));
  r = await req('/api/companies/hot?type=reviews');
  check('热议榜（reviews）', r.s === 200 && r.j.some(c => c.name === '长安汽车'));
  r = await req('/api/companies?sort=danger&pageSize=10');
  check('危险指数排序榜首', r.s === 200 && r.j.list.length > 0);
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/watch', { method: 'POST' }, UH);
  check('alice 加入避雷清单', r.s === 200 && r.j.watched === true);
  r = await req('/api/companies/watch/list', {}, UH);
  check('避雷清单含长安汽车', r.s === 200 && r.j.list.some(c => c.name === '长安汽车'));
  r = await req('/api/companies/' + encodeURIComponent('长安汽车') + '/watch', { method: 'POST' }, UH);
  check('再次点击取消避雷清单', r.s === 200 && r.j.watched === false);
  r = await req('/api/companies/watch/list', {}, UH);
  check('清单已移除', r.s === 200 && !r.j.list.some(c => c.name === '长安汽车'));

  console.log('\n—— 排序 ——');
  r = await req('/api/companies?sort=rating&page=1&pageSize=3');
  check('避雷最高排序首位为长安汽车', r.s === 200 && r.j.list[0].name === '长安汽车' && r.j.list[0].avg === 2.5);
  r = await req('/api/companies?sort=reviews&page=1&pageSize=3');
  check('评价最多排序首位', r.s === 200 && r.j.list[0].name === '长安汽车' && r.j.list[0].reviewCount === 3);

  console.log('\n—— 管理 API（extra 公司，双模式通用） ——');
  r = await req('/api/admin/companies?page=1&pageSize=1', {}, UH);
  check('普通用户访问后台 403', r.s === 403);
  r = await req('/api/admin/companies?page=1&pageSize=1', {}, AH);
  check('管理员列表含评价字段', r.s === 200 && r.j.total >= 30000 && r.j.list[0].reviewCount !== undefined);
  r = await req('/api/admin/companies', { method: 'POST', body: JSON.stringify({ name: '测试公司A', industry: '测试', region: '江北' }) }, AH);
  const cid = r.j.id;
  check('添加公司(extra)', r.s === 201 && r.j.name === '测试公司A' && r.j.source === 'extra');
  r = await req('/api/admin/companies', { method: 'POST', body: JSON.stringify({ name: '测试公司A', industry: 'x', region: 'x' }) }, AH);
  check('重名拒绝 400', r.s === 400);
  r = await req('/api/admin/companies/batch', { method: 'POST', body: JSON.stringify({ text: '批量公司B,科技,渝北\n批量公司C|餐饮|南岸\n测试公司A,重复,江北\n' }) }, AH);
  check('批量导入（新增2跳过1）', r.s === 200 && r.j.added === 2 && r.j.skipped === 1);
  const bid = r.j.companies[0].id, cid2 = r.j.companies[1].id;
  r = await req('/api/admin/companies/' + bid, { method: 'PUT', body: JSON.stringify({ name: '批量公司B2', industry: '互联网', region: '渝中' }) }, AH);
  check('编辑 extra 公司', r.s === 200 && r.j.name === '批量公司B2' && r.j.region === '渝中');
  await req('/api/companies/' + bid + '/reviews', { method: 'POST', body: JSON.stringify({ rating: 1, content: '测试评价待删' }) }, UH);
  r = await req('/api/companies/' + bid, {}, AH);
  const rid = r.j.reviews[0].id;
  r = await req('/api/admin/companies/' + bid + '/reviews/' + rid, { method: 'DELETE', headers: H }, AH);
  check('删除单条评价', r.s === 200);
  r = await req('/api/companies/' + bid);
  check('删评后该公司无评价', r.s === 200 && r.j.reviewCount === 0);
  r = await req('/api/admin/companies/' + cid, { method: 'DELETE' }, AH);
  check('删除 extra 公司', r.s === 200);
  r = await req('/api/companies?q=' + encodeURIComponent('测试公司A'));
  check('删除后列表不可见', r.s === 200 && r.j.total === 0);
  await req('/api/admin/companies/' + bid, { method: 'DELETE' }, AH);
  await req('/api/admin/companies/' + cid2, { method: 'DELETE' }, AH);
  check('清理批量公司', true);

  console.log('\n—— 清理种子数据上的测试评价 ——');
  const detail = (await req('/api/companies/' + encodeURIComponent('长安汽车'), {}, AH)).j;
  for (const rv of detail.reviews) {
    await req('/api/admin/companies/' + detail.id + '/reviews/' + rv.id, { method: 'DELETE' }, AH);
  }
  r = await req('/api/companies/' + encodeURIComponent('长安汽车'));
  check('长安汽车评价已清空', r.s === 200 && r.j.reviewCount === 0 && r.j.level === 'pending');

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
