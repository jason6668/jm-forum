/* v8 玩法升级集成测试：等级体系 / 积分商城 / 打赏 / 悬赏 / 投票 / 成就 / 鸡腿交易
 * 使用专用测试账号 play_qa / play_qb（注册码注册），跑完后自动清理 */
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
  return { token: m && m[1], user: (await r.json().catch(() => ({}))).user };
}
const TS = Date.now();
const SUF = String(TS).slice(-6);

(async () => {
  console.log('== 1. 准备：登录 + 注册测试账号 ==');
  const admin = await login('admin', '123456');
  const alice = await login('alice', '123456');
  check('admin 登录', !!admin.token);
  check('alice 登录', !!alice.token);
  check('登录响应含等级字段', alice.user && typeof alice.user.exp === 'number' && alice.user.level === 1 && alice.user.levelTitle === '初来乍到', JSON.stringify(alice.user && { exp: alice.user.exp, level: alice.user.level, levelTitle: alice.user.levelTitle }));
  const AH = 'forum_session=' + admin.token;
  let r = await req('/api/admin/codes', { method: 'POST', body: JSON.stringify({ count: 2, note: 'test_play' }) }, AH);
  const codes = r.j.codes || [];
  check('生成 2 个测试注册码', r.s === 201 && codes.length === 2);
  const qaUser = 'play_qa_' + SUF, qbUser = 'play_qb_' + SUF;
  r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: qaUser, email: qaUser + '@t.cn', password: '123456', name: '玩法测试A', code: codes[0].code }) });
  check('注册 play_qa', r.s === 200 && r.j.user && r.j.user.username === qaUser);
  r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: qbUser, email: qbUser + '@t.cn', password: '123456', name: '玩法测试B', code: codes[1].code }) });
  check('注册 play_qb', r.s === 200 && r.j.user && r.j.user.username === qbUser);
  const qa = await login(qaUser, '123456');
  const qb = await login(qbUser, '123456');
  check('play_qa 登录', !!qa.token);
  check('play_qb 登录', !!qb.token);
  const QAH = 'forum_session=' + qa.token;
  const QBH = 'forum_session=' + qb.token;

  console.log('\n== 2. 等级体系 ==');
  r = await req('/api/rank/level');
  check('等级榜 200 且含等级字段', r.s === 200 && r.j.length > 0 && r.j[0].level >= 1 && r.j[0].exp !== undefined && r.j[0].levelTitle);
  r = await req('/api/rank/level?page=1', {}, QAH);
  check('登录态等级榜正常', r.s === 200);

  console.log('\n== 3. 积分商城 ==');
  r = await req('/api/shop/items', {}, QAH);
  check('默认 7 个商品', r.s === 200 && r.j.length === 7);
  r = await req('/api/shop/buy', { method: 'POST', body: JSON.stringify({ itemId: 'shop-title-custom', customTitle: '' }) }, QAH);
  check('自定义头衔留空被拒 400', r.s === 400);
  /* admin 建一个 1 鸡腿的测试徽章供购买 */
  r = await req('/api/admin/shop', { method: 'POST', body: JSON.stringify({ name: '测试徽章', icon: '🧪', price: 1, type: 'badge', value: '测试徽章_' + SUF, desc: 'test' }) }, AH);
  const testItem = r.j;
  check('admin 创建测试商品', r.s === 200 && !!testItem.id);
  r = await req('/api/shop/buy', { method: 'POST', body: JSON.stringify({ itemId: testItem.id }) }, QAH);
  check('play_qa 用 1 鸡腿购买徽章', r.s === 200 && (r.j.badges || []).includes('测试徽章_' + SUF) && r.j.coins === 9);
  r = await req('/api/shop/buy', { method: 'POST', body: JSON.stringify({ itemId: testItem.id }) }, QAH);
  check('重复购买被拒 400', r.s === 400);
  r = await req('/api/admin/shop/' + testItem.id, { method: 'PUT', body: JSON.stringify({ price: 5 }) }, AH);
  check('admin 改价', r.s === 200 && r.j.price === 5);
  r = await req('/api/admin/shop/' + testItem.id, { method: 'DELETE' }, AH);
  check('admin 删除测试商品', r.s === 200);
  r = await req('/api/shop/items', {}, QAH);
  check('商品列表回到 7 个', r.s === 200 && r.j.length === 7);

  console.log('\n== 4. 发帖 / 投票 ==');
  const boards = (await req('/api/boards')).j;
  const bid = boards.find(b => b.name === '吃瓜区')?.id || boards[0].id;
  r = await req('/api/topics', { method: 'POST', body: JSON.stringify({ title: '【测试投票】' + SUF + ' 今天吃什么', content: '投票测试正文', boardId: bid, poll: { question: '今晚吃什么？', options: ['火锅', '烧烤', '面条'], multi: false } }) }, QAH);
  check('play_qa 发投票帖', r.s === 201 && r.j.poll && r.j.poll.question === '今晚吃什么？');
  const pollTopicId = r.j.id;
  r = await req('/api/topics/' + pollTopicId + '/replies', { method: 'POST', body: JSON.stringify({ content: '我选火锅！' }) }, QBH);
  check('play_qb 回复投票帖', r.s === 201);
  r = await req('/api/topics/' + pollTopicId + '/poll/vote', { method: 'POST', body: JSON.stringify({ optionIndex: 0 }) }, QBH);
  check('play_qb 投票', r.s === 200 && r.j.ok === true);
  r = await req('/api/topics/' + pollTopicId, {}, QBH);
  check('投票结果正确', r.s === 200 && r.j.poll.total === 1 && r.j.poll.options[0].votes === 1 && r.j.poll.options[0].ratio === 100 && r.j.poll.myVote >= 0);
  r = await req('/api/topics/' + pollTopicId + '/poll/vote', { method: 'POST', body: JSON.stringify({ optionIndex: 1 }) }, QBH);
  check('改票成功', r.s === 200);
  r = await req('/api/topics/' + pollTopicId, {}, QBH);
  check('改票后统计正确（total 仍 1，选项 1 得 1 票）', r.s === 200 && r.j.poll.total === 1 && r.j.poll.options[0].votes === 0 && r.j.poll.options[1].votes === 1);

  console.log('\n== 5. 悬赏 ==');
  r = await req('/api/topics', { method: 'POST', body: JSON.stringify({ title: '【测试悬赏】' + SUF + ' 求方案', content: '悬赏测试正文', boardId: bid, bounty: 10 }) }, AH);
  check('admin 发悬赏帖（冻结 10 鸡腿）', r.s === 201 && r.j.bounty === 10);
  const bountyTopicId = r.j.id;
  r = await req('/api/topics/' + bountyTopicId + '/replies', { method: 'POST', body: JSON.stringify({ content: '这是我的方案！' }) }, QBH);
  const replyId = r.j.id;
  check('play_qb 回复悬赏帖', r.s === 201 && !!replyId, 'replyId=' + replyId);
  r = await req('/api/topics/' + bountyTopicId + '/accept', { method: 'POST', body: JSON.stringify({ replyId }) }, AH);
  check('admin 采纳 play_qb 回复', r.s === 200 && r.j.bestReplyId === replyId);
  r = await req('/api/topics/' + bountyTopicId, {}, QBH);
  check('采纳后 bounty 清零且标记最佳', r.s === 200 && r.j.bounty === 0 && r.j.bestReplyId === replyId);
  const qbAfter = (await login(qbUser, '123456')).user;
  check('play_qb 收到 10 鸡腿悬赏金', qbAfter.coins === 20, 'coins=' + qbAfter.coins);

  console.log('\n== 6. 鸡腿交易 ==');
  r = await req('/api/transfer', { method: 'POST', body: JSON.stringify({ to: qbUser, amount: 20, note: '测试转账' }) }, AH);
  check('admin 转 20 鸡腿给 play_qb', r.s === 200 && r.j.amount === 20);
  r = await req('/api/transfer', { method: 'POST', body: JSON.stringify({ to: qaUser, amount: 0 }) }, AH);
  check('金额为 0 被拒 400', r.s === 400);
  r = await req('/api/transfer', { method: 'POST', body: JSON.stringify({ to: 'admin', amount: 5 }) }, AH);
  check('转给自己被拒 400', r.s === 400);
  r = await req('/api/transfer', { method: 'POST', body: JSON.stringify({ to: '不存在的用户xyz', amount: 5 }) }, AH);
  check('收款人不存在 404', r.s === 404);
  const qbAfter2 = (await login(qbUser, '123456')).user;
  check('play_qb 余额 20+20=40', qbAfter2.coins === 40, 'coins=' + qbAfter2.coins);

  console.log('\n== 7. 打赏 ==');
  r = await req('/api/topics/' + pollTopicId + '/tip', { method: 'POST', body: JSON.stringify({ amount: 5 }) }, QBH);
  check('play_qb 打赏 play_qa 5 鸡腿', r.s === 200 && r.j.amount === 5);
  r = await req('/api/topics/' + pollTopicId + '/tip', { method: 'POST', body: JSON.stringify({ amount: 1 }) }, QAH);
  check('打赏自己被拒 400', r.s === 400);
  r = await req('/api/topics/' + pollTopicId + '/tip', { method: 'POST', body: JSON.stringify({ amount: 0 }) }, QBH);
  check('打赏金额 0 被拒 400', r.s === 400);
  r = await req('/api/topics/' + pollTopicId + '/tip', { method: 'POST', body: JSON.stringify({ amount: 99999 }) }, QBH);
  check('打赏超上限被拒 400', r.s === 400);
  const qbAfter3 = (await login(qbUser, '123456')).user;
  check('play_qb 余额 40-5=35', qbAfter3.coins === 35, 'coins=' + qbAfter3.coins);

  console.log('\n== 8. 成就 / 通知 ==');
  r = await req('/api/achievements', {}, QAH);
  const achA = r.j;
  check('成就列表含 13 项', r.s === 200 && achA.length === 13);
  check('play_qa 解锁 first-topic / poll / shop-buy', achA.find(a => a.id === 'first-topic')?.unlocked && achA.find(a => a.id === 'poll')?.unlocked && achA.find(a => a.id === 'shop-buy')?.unlocked);
  r = await req('/api/achievements', {}, QBH);
  const achB = r.j;
  check('play_qb 解锁 first-reply / bounty-solve / tip-give', achB.find(a => a.id === 'first-reply')?.unlocked && achB.find(a => a.id === 'bounty-solve')?.unlocked && achB.find(a => a.id === 'tip-give')?.unlocked);
  r = await req('/api/notifications', {}, QAH);
  const notifA = r.j || [];
  check('play_qa 收到 tip 通知', notifA.some(n => n.type === 'tip'));
  r = await req('/api/notifications', {}, QBH);
  const notifB = r.j || [];
  check('play_qb 收到 bounty 通知', notifB.some(n => n.type === 'bounty'));
  r = await req('/api/notifications', {}, AH);
  const notifAdm = r.j || [];
  check('admin 无新增打赏类通知（仅自己发起）', Array.isArray(notifAdm));

  console.log('\n== 9. 清理 ==');
  for (const tid of [pollTopicId, bountyTopicId]) {
    await req('/api/admin/topics/' + tid, { method: 'DELETE' }, AH);
  }
  r = await req('/api/topics/' + pollTopicId);
  check('投票帖已删除', r.s === 404);
  r = await req('/api/admin/users?q=' + qaUser, {}, AH);
  const qaRec = (r.j.list || []).find(u => u.username === qaUser);
  await req('/api/admin/users/' + qaRec.id, { method: 'DELETE' }, AH);
  r = await req('/api/admin/users?q=' + qbUser, {}, AH);
  const qbRec = (r.j.list || []).find(u => u.username === qbUser);
  await req('/api/admin/users/' + qbRec.id, { method: 'DELETE' }, AH);
  r = await req('/api/admin/users?q=' + qaUser, {}, AH);
  check('测试用户已删除', (r.j.list || []).length === 0);
  r = await req('/api/admin/users?q=' + qbUser, {}, AH);
  check('测试用户已删除', (r.j.list || []).length === 0);

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
