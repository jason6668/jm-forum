/* 9 项升级集成测试：私信 / 站内通知 / 编辑删除 / 举报 / 周月榜 / 标签 / 导出 / 暗色偏好 / PWA
   跑完后自动清理测试帖子（通知与私信为真实数据可接受少量残留） */
const BASE = 'http://localhost:3000';
const H = { 'Content-Type': 'application/json' };
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
async function req(path, opts = {}, cookie) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, j };
}
async function raw(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  return { s: r.status, ct: r.headers.get('content-type') || '' };
}
async function login(account, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ account, password }) });
  const m = (r.headers.get('set-cookie') || '').match(/forum_session=([^;]+)/);
  return m && m[1];
}
const created = []; // 记录测试创建的帖子 id 便于清理
(async () => {
  const adminT = await login('admin', '123456');
  const aliceT = await login('alice', '123456');
  const bobT = await login('bob', '123456');
  check('站长登录', !!adminT);
  check('alice 登录', !!aliceT);
  check('bob 登录', !!bobT);
  const AH = 'forum_session=' + adminT;
  const UH = 'forum_session=' + aliceT;
  const BH = 'forum_session=' + bobT;
  const boards = (await req('/api/boards')).j;
  const bid = boards[0].id; // 日常板块

  console.log('\n—— 1. 站内私信 ——');
  let r = await req('/api/messages', { method: 'POST', body: JSON.stringify({ to: 'alice', content: '你好 alice' }) }, UH);
  check('给自己发私信 400', r.s === 400);
  r = await req('/api/messages', { method: 'POST', body: JSON.stringify({ to: 'no_such_user_x', content: 'hi' }) }, UH);
  check('发给不存在用户 404', r.s === 404);
  r = await req('/api/messages', { method: 'POST', body: JSON.stringify({ to: 'bob', content: 'bob，测试私信内容' }) }, UH);
  check('alice 发给 bob 成功', r.s === 201 && !!r.j.id);
  r = await req('/api/messages', {}, BH);
  check('bob 会话列表 unread=1', r.s === 200 && r.j.length >= 1 && r.j[0].peer.username === 'alice' && r.j[0].unread === 1);
  r = await req('/api/messages/alice', {}, BH);
  check('bob 打开对话并标记已读', r.s === 200 && r.j.messages.length >= 1 && r.j.messages[0].fromMe === false);
  r = await req('/api/messages', {}, BH);
  check('已读后 unread=0', r.s === 200 && r.j[0].unread === 0);
  r = await req('/api/messages', { method: 'POST', body: JSON.stringify({ to: 'bob', content: '  ' }) }, UH);
  check('空内容 400', r.s === 400);

  console.log('\n—— 2. 站内通知（@提及 / 回复） ——');
  r = await req('/api/notifications/unread-count', {}, BH);
  const n0 = r.j.count || 0;
  r = await req('/api/topics', { method: 'POST', body: JSON.stringify({ title: '测试-通知提及', content: '大家好 @bob 请看这个', boardId: bid, tags: ['测试', '通知'] }) }, UH);
  const t1 = r.j;
  created.push(t1.id);
  check('alice 发帖成功', r.s === 201 && !!t1.id);
  r = await req('/api/notifications/unread-count', {}, BH);
  check('bob 因 @提及 未读+1', r.s === 200 && r.j.count === n0 + 1);
  r = await req('/api/notifications', {}, BH);
  const m1 = r.j.find(n => n.type === 'mention' && n.topicId === t1.id);
  check('通知含提及信息与跳转字段', !!m1 && m1.fromUsername === 'alice' && m1.topicSlug === t1.slug);
  r = await req('/api/topics/' + t1.id + '/replies', { method: 'POST', body: JSON.stringify({ content: '收到，回复测试' }) }, BH);
  check('bob 回复帖子', r.s === 201);
  r = await req('/api/notifications/unread-count', {}, UH);
  check('alice 收到回复通知', r.s === 200 && r.j.count >= 1);
  r = await req('/api/notifications', {}, UH);
  const m2 = r.j.find(n => n.type === 'reply' && n.topicId === t1.id);
  check('回复通知类型与发送人', !!m2 && m2.fromUsername === 'bob');
  r = await req('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [] }) }, UH);
  r = await req('/api/notifications/unread-count', {}, UH);
  check('全部标记已读后未读为 0', r.s === 200 && r.j.count === 0);

  console.log('\n—— 3. 帖子编辑 / 删除 ——');
  r = await req('/api/topics', { method: 'POST', body: JSON.stringify({ title: '测试-编辑删除', content: '原始内容', boardId: bid, tags: ['测试'] }) }, BH);
  const t2 = r.j;
  created.push(t2.id);
  check('bob 发帖', r.s === 201);
  r = await req('/api/topics/' + t2.id, { method: 'PUT', body: JSON.stringify({ title: '测试-已编辑', content: '编辑后的内容', tags: ['测试', '已编辑'] }) }, UH);
  check('非作者编辑 403', r.s === 403);
  r = await req('/api/topics/' + t2.id, { method: 'PUT', body: JSON.stringify({ title: '测试-已编辑', content: '编辑后的内容', tags: ['测试', '已编辑'] }) }, BH);
  check('作者编辑成功（标题/内容/标签）', r.s === 200 && r.j.title === '测试-已编辑' && r.j.excerpt === '编辑后的内容' && r.j.tags.includes('已编辑'));
  r = await req('/api/topics/' + t2.id, { method: 'PUT', body: JSON.stringify({ content: '' }) }, BH);
  check('空内容编辑 400', r.s === 400);
  r = await req('/api/topics/' + t2.id, { method: 'PUT', body: JSON.stringify({ title: '管理端可改' }) }, AH);
  check('管理员可编辑他人帖子', r.s === 200 && r.j.title === '管理端可改');
  const boardBefore = (await req('/api/boards')).j.find(b => b.id === bid).topicCount;
  r = await req('/api/topics/' + t2.id, { method: 'DELETE' }, UH);
  check('非作者删除 403', r.s === 403);
  r = await req('/api/topics/' + t2.id, { method: 'DELETE' }, BH);
  check('作者删除成功', r.s === 200 && r.j.ok === true);
  r = await req('/api/topics/' + t2.id);
  check('删除后帖子 404', r.s === 404);
  r = await req('/api/boards');
  check('板块 topicCount 递减', r.s === 200 && r.j.find(b => b.id === bid).topicCount === boardBefore - 1);

  console.log('\n—— 4. 举报机制 ——');
  r = await req('/api/reports', { method: 'POST', body: JSON.stringify({ type: 'topic', targetId: t1.id, targetTitle: t1.title, reason: '测试举报：内容违规' }) }, UH);
  check('alice 举报成功', r.s === 201);
  r = await req('/api/reports', { method: 'POST', body: JSON.stringify({ type: 'topic', targetId: t1.id, reason: '再举报一次' }) }, UH);
  check('重复举报被拦截 400', r.s === 400);
  r = await req('/api/reports', { method: 'POST', body: JSON.stringify({ type: 'topic', targetId: t1.id, reason: '其他用户举报' }) }, BH);
  check('不同用户可举报同一内容', r.s === 201);
  r = await req('/api/reports', { method: 'POST', body: JSON.stringify({ type: 'topic', targetId: t1.id, reason: '' }) }, UH);
  check('空理由 400', r.s === 400);
  r = await req('/api/admin/reports', {}, UH);
  check('普通用户看后台举报 403', r.s === 403);
  r = await req('/api/admin/reports?status=open', {}, AH);
  const open = r.j.list.filter(x => x.targetId === t1.id);
  check('后台开放队列含 2 条且带跳转', r.s === 200 && open.length === 2 && !!open[0].targetSlug);
  r = await req('/api/admin/reports/' + open[0].id + '/status', { method: 'POST', body: JSON.stringify({ status: 'resolved' }) }, AH);
  check('处理举报 resolved', r.s === 200 && r.j.ok === true);
  r = await req('/api/admin/reports?status=open', {}, AH);
  check('处理后开放队列减为 1', r.s === 200 && r.j.list.filter(x => x.targetId === t1.id).length === 1);
  r = await req('/api/admin/reports/' + open[1].id + '/status', { method: 'POST', body: JSON.stringify({ status: 'dismissed' }) }, AH);
  check('驳回举报 dismissed', r.s === 200);
  r = await req('/api/admin/reports?status=resolved', {}, AH);
  check('已处理队列可见', r.s === 200 && r.j.list.some(x => x.targetId === t1.id));

  console.log('\n—— 5. 周榜 / 月榜 ——');
  r = await req('/api/rank/active?period=week');
  check('周榜返回且含 alice/bob', r.s === 200 && r.j.some(x => x.username === 'alice') && r.j.some(x => x.username === 'bob'));
  r = await req('/api/rank/active?period=month');
  check('月榜返回且含 alice/bob', r.s === 200 && r.j.some(x => x.username === 'alice') && r.j.some(x => x.username === 'bob'));
  const w = await req('/api/rank/active?period=week');
  const aliceRow = w.j.find(x => x.username === 'alice');
  check('周榜含发帖与回复统计字段', !!aliceRow && aliceRow.posts >= 1 && typeof aliceRow.total === 'number');

  console.log('\n—— 6. 标签聚合 ——');
  r = await req('/api/tag/' + encodeURIComponent('测试'));
  check('按标签聚合命中帖子', r.s === 200 && r.j.some(x => x.id === t1.id && x.tags.includes('测试')));
  r = await req('/api/tag/' + encodeURIComponent('不存在的标签xyz'));
  check('无匹配标签返回空数组', r.s === 200 && r.j.length === 0);

  console.log('\n—— 7. 数据导出备份 ——');
  r = await raw('/api/admin/export', { headers: { Cookie: UH } });
  check('普通用户导出 403', r.s === 403);
  const ex = await fetch(BASE + '/api/admin/export', { headers: { Cookie: AH } });
  const exj = await ex.json();
  check('站长导出全量备份', ex.status === 200 && Array.isArray(exj.topics) && Array.isArray(exj.messages) && Array.isArray(exj.notifications) && Array.isArray(exj.reports) && Array.isArray(exj.users) && Array.isArray(exj.boards) && Array.isArray(exj.companies));

  console.log('\n—— 8. 暗色模式偏好持久化 ——');
  r = await req('/api/settings', { method: 'POST', body: JSON.stringify({ preferences: { theme: 'dark' } }) }, UH);
  check('保存暗色偏好', r.s === 200);
  r = await req('/api/auth/me', {}, UH);
  check('偏好已持久化', r.s === 200 && r.j.user.preferences && r.j.user.preferences.theme === 'dark');
  r = await req('/api/settings', { method: 'POST', body: JSON.stringify({ preferences: { theme: 'light' } }) }, UH);
  r = await req('/api/auth/me', {}, UH);
  check('改回亮色', r.s === 200 && r.j.user.preferences.theme === 'light');

  console.log('\n—— 9. PWA 资源 ——');
  const mf = await raw('/manifest.json');
  check('manifest.json 可访问', mf.s === 200 && mf.ct.includes('application/json') || mf.ct.includes('json'));
  const mfj = await (await fetch(BASE + '/manifest.json')).json();
  check('manifest 含名称与主题色', !!mfj.name && !!mfj.theme_color);
  const sw = await raw('/sw.js');
  check('sw.js 可访问', sw.s === 200 && sw.ct.includes('javascript'));

  console.log('\n—— 清理测试帖子 ——');
  for (const id of created) {
    await req('/api/topics/' + id, { method: 'DELETE' }, AH);
  }
  // 兜底：删除历史崩溃残留的「测试-」帖子
  const remain = (await req('/api/topics?tag=' + encodeURIComponent('测试'))).j.list || [];
  for (const t of remain) {
    await req('/api/topics/' + t.id, { method: 'DELETE' }, AH);
  }
  r = await req('/api/topics?tag=' + encodeURIComponent('测试'));
  check('测试帖子已清理', r.s === 200 && r.j.list.length === 0);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
