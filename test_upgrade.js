/* 升级功能集成测试：角色体系 + 通知配置 API */
const BASE = 'http://localhost:3000';

async function login(account, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const data = await res.json();
  const cookies = res.headers.get('set-cookie') || '';
  const m = cookies.match(/forum_session=([^;]+)/);
  const token = m ? m[1] : null;
  return { status: res.status, data, token };
}

async function api(token, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Cookie = 'forum_session=' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  console.log('== 1. 登录与角色升级 ==');
  const admin = await login('admin', '123456');
  check('admin 登录成功', admin.status === 200 && admin.token);
  check('admin 已升级为站长(owner)', admin.data.user.role === 'owner', JSON.stringify(admin.data.user.role));
  const alice = await login('alice', '123456');
  check('alice 登录成功', alice.status === 200 && alice.token);
  check('alice 仍是普通用户', alice.data.user.role === 'user');

  console.log('== 2. 通知配置 API ==');
  let r = await api(admin.token, '/api/admin/notify');
  check('GET 通知配置 200', r.status === 200 && r.data.telegram && r.data.events);
  r = await api(admin.token, '/api/admin/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram: { enabled: false, botToken: 'TEST_TOKEN', chatId: '-100123' }, wecom: { enabled: false, webhook: '' }, events: { newUser: true, newTopic: true, newReply: true } }),
  });
  check('POST 保存通知配置 200', r.status === 200 && r.data.notify.telegram.botToken === 'TEST_TOKEN');
  r = await api(admin.token, '/api/admin/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('测试发送返回渠道结果(未启用应提示未配置)', r.status === 200 && Array.isArray(r.data.results) && r.data.results.length === 2);
  r = await api(admin.token, '/api/admin/notify/telegram/chats?botToken=INVALID');
  check('非法 Bot Token 拉群列表返回 400', r.status === 400);
  // 清掉测试 token
  await api(admin.token, '/api/admin/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegram: { enabled: false, botToken: '', chatId: '' }, wecom: { enabled: false, webhook: '' }, events: { newUser: true, newTopic: true, newReply: false } }) });

  console.log('== 3. 统计与筛选 ==');
  r = await api(admin.token, '/api/admin/stats');
  check('stats 含站长/管理员统计', r.status === 200 && r.data.owners >= 1 && typeof r.data.admins === 'number');
  r = await api(admin.token, '/api/admin/users?role=owner');
  check('按角色筛选站长', r.status === 200 && r.data.list.every(u => u.role === 'owner'));

  console.log('== 4. 权限矩阵 ==');
  // 普通用户访问后台 → 403
  r = await api(alice.token, '/api/admin/stats');
  check('普通用户访问后台 403', r.status === 403);
  r = await api(alice.token, '/api/admin/notify');
  check('普通用户访问通知 403', r.status === 403);

  // 站长把 alice 设为管理员
  r = await api(admin.token, '/api/admin/users/' + alice.data.user.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
  check('站长设 alice 为管理员', r.status === 200 && r.data.user.role === 'admin');
  const alice2 = await login('alice', '123456');
  r = await api(alice2.token, '/api/admin/stats');
  check('alice(管理员) 可进后台', r.status === 200);

  // alice(admin) 不能把 bob 设站长 / 不能改 admin 角色
  r = await api(alice2.token, '/api/admin/users?q=bob');
  const bob = r.data.list.find(u => u.username === 'bob');
  r = await api(alice2.token, '/api/admin/users/' + bob.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) });
  check('管理员不能设站长 403', r.status === 403);
  r = await api(alice2.token, '/api/admin/users/' + bob.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
  check('管理员可把普通用户升为管理员', r.status === 200 && r.data.user.role === 'admin');
  r = await api(alice2.token, '/api/admin/users/' + bob.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) });
  check('管理员不能降级其他管理员 403（角色权集中站长）', r.status === 403);
  // alice(admin) 不能动站长 admin
  r = await api(alice2.token, '/api/admin/users/' + admin.data.user.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) });
  check('管理员不能改站长角色 403', r.status === 403);
  // alice(admin) 不能封禁 alice 自己 → 400
  r = await api(alice2.token, '/api/admin/users/' + alice.data.user.id + '/ban', { method: 'POST' });
  check('管理员不能封禁自己 400', r.status === 400);

  // 站长把 bob 设为站长
  r = await api(admin.token, '/api/admin/users?q=bob');
  const bob2 = r.data.list.find(u => u.username === 'bob');
  r = await api(admin.token, '/api/admin/users/' + bob2.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) });
  check('站长可设用户为站长', r.status === 200 && r.data.user.role === 'owner');
  // 站长不能封禁其他站长
  r = await api(admin.token, '/api/admin/users/' + bob2.id + '/ban', { method: 'POST' });
  check('站长不能封禁站长 400', r.status === 400);
  // 站长可封禁管理员 alice
  r = await api(admin.token, '/api/admin/users/' + alice.data.user.id + '/ban', { method: 'POST' });
  check('站长可封禁管理员', r.status === 200 && r.data.user.banned === true);
  r = await api(admin.token, '/api/admin/users/' + alice.data.user.id + '/unban', { method: 'POST' });
  check('解封 alice', r.status === 200 && r.data.user.banned === false);

  console.log('== 5. 清理：恢复测试数据 ==');
  r = await api(admin.token, '/api/admin/users/' + alice.data.user.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) });
  check('恢复 alice 为普通用户', r.status === 200 && r.data.user.role === 'user');
  r = await api(admin.token, '/api/admin/users/' + bob2.id + '/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) });
  check('恢复 bob 为普通用户', r.status === 200 && r.data.user.role === 'user');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
