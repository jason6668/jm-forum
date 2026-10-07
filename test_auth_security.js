/* 账号安全集成测试：邮箱找回密码全流程 + 注册图形验证码触发规则
   自带临时实例：把代码复制到系统临时目录（独立 data/db.json，绝不碰本地/生产数据），
   随机端口启动后跑断言，结束自动清理。运行：node test_auth_security.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const SRC = __dirname;
const PORT = 3217;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_PW = 'Admintest123!';
const H = { 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function req(p, opts = {}, cookie, extraHeaders) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...H, ...(opts.headers || {}), ...(extraHeaders || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const j = await r.json().catch(() => ({}));
  const m = (r.headers.get('set-cookie') || '').match(/forum_session=([^;]+)/);
  return { s: r.status, j, cookie: m ? 'forum_session=' + m[1] : cookie };
}
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/auth/reg-status'); if (r.ok) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
function captchaAnswer(svg) {
  return [...String(svg).matchAll(/<text[^>]*>([A-Za-z0-9])<\/text>/g)].map(m => m[1]).join('');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-test-'));
  /* 只复制运行所需文件；node_modules 用软链，避免拖上百 MB */
  for (const f of ['server.js', 'notify.js', 'seedCompanies.js', 'package.json']) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
  fs.cpSync(path.join(SRC, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (s) => !s.includes(path.join('public', 'data')) });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  const env = { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: ADMIN_PW };
  for (const k of ['VERCEL', 'KV_REST_API_URL', 'KV_URL', 'KV_REST_API_TOKEN', 'KV_TOKEN', 'KV_REST_API_URL_2', 'KV_REST_API_TOKEN_2', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SITE_URL']) delete env[k];
  const logFile = path.join(tmp, 'server.log');
  const logFd = fs.openSync(logFile, 'a');
  const startServer = () => spawn(process.execPath, ['server.js'], { cwd: tmp, env, stdio: ['ignore', logFd, logFd] });
  let child = startServer();
  const readLog = () => fs.readFileSync(logFile, 'utf8');
  const lastResetToken = () => {
    const ms = [...readLog().matchAll(/reset-password\?token=([0-9a-f]{64})/g)];
    return ms.length ? ms[ms.length - 1][1] : null;
  };
  const readDb = () => JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'db.json'), 'utf8'));

  try {
    check('临时实例启动', await waitUp());
    /* ---------- 初始状态 ---------- */
    let r = await req('/api/auth/reg-status');
    check('初始 reg-status：窗关且不需要验证码', r.j.open === false && r.j.captchaRequired === false, JSON.stringify(r.j));
    r = await req('/api/auth/captcha');
    check('验证码接口返回 id+svg（无 answer 字段）', !!r.j.id && String(r.j.svg).includes('<svg') && !('answer' in r.j) && !('code' in r.j));
    check('验证码图可从 SVG 文本层读出 4 位（测试用）', captchaAnswer(r.j.svg).length === 4, captchaAnswer(r.j.svg));

    /* ---------- 用管理员邀请码注册 tester1（带码豁免验证码） ---------- */
    let ra = await req('/api/auth/login', post({ account: 'admin', password: ADMIN_PW }));
    check('管理员可登录（取码用）', ra.s === 200, JSON.stringify(ra.j).slice(0, 120));
    ra = await req('/api/admin/codes', post({ count: 3, note: 'test' }), ra.cookie);
    check('管理员生成邀请码', ra.s === 201 && (ra.j.codes || []).length === 3, JSON.stringify(ra.j).slice(0, 160));
    const codePool = (ra.j.codes || []).map(c => c.code);
    const code1 = codePool[0];
    r = await req('/api/auth/register', post({ username: 'tester1', name: '测试一号', email: 'tester1@test.local', password: 'Oldpass123', code: code1 }));
    check('带邀请码注册成功（无验证码）', r.s === 200 && r.j.user && r.j.user.username === 'tester1', JSON.stringify(r.j).slice(0, 200));
    const cookie1 = r.cookie;
    r = await req('/api/auth/me', {}, cookie1);
    check('注册后会话有效', r.j.user && r.j.user.username === 'tester1');

    /* ---------- 忘记密码（邮件未配置） ---------- */
    r = await req('/api/auth/forgot-password', post({ account: 'tester1' }));
    check('忘记密码：账号存在 → 200 且明示未配置', r.s === 200 && r.j.ok === true && r.j.mailConfigured === false, JSON.stringify(r.j));
    const token1 = lastResetToken();
    check('未配置邮件时令牌打进服务端日志（管理员人工转交）', !!token1);
    const dbUser1 = readDb().users.find(u => u.username === 'tester1');
    check('库里只存令牌哈希不存明文', dbUser1.resetTokenHash === sha256(token1) && !JSON.stringify(dbUser1).includes(token1));
    check('令牌 30 分钟过期', Math.abs(new Date(dbUser1.resetExpires).getTime() - Date.now() - 30 * 60 * 1000) < 60 * 1000, dbUser1.resetExpires);
    r = await req('/api/auth/forgot-password', post({ account: 'nobody_here_xyz' }));
    check('防枚举：账号不存在返回完全一致', r.s === 200 && r.j.ok === true && r.j.mailConfigured === false && Object.keys(r.j).sort().join() === 'mailConfigured,ok', JSON.stringify(r.j));

    /* ---------- 重置密码全流程 ---------- */
    r = await req('/api/auth/reset-password', post({ token: token1, newPassword: 'short' }));
    check('新密码太短被拒', r.s === 400);
    r = await req('/api/auth/reset-password', post({ token: token1, newPassword: 'Newpass456' }));
    check('重置成功', r.s === 200 && r.j.ok === true && r.j.kicked >= 1, JSON.stringify(r.j));
    r = await req('/api/settings', {}, cookie1);
    check('旧会话已被踢（requireAuth 401）', r.s === 401, 'status=' + r.s);
    r = await req('/api/auth/login', post({ account: 'tester1', password: 'Oldpass123' }));
    check('旧密码登录失败', r.s === 401);
    r = await req('/api/auth/login', post({ account: 'tester1', password: 'Newpass456' }));
    check('新密码登录成功', r.s === 200 && r.j.user.username === 'tester1');
    r = await req('/api/auth/reset-password', post({ token: token1, newPassword: 'Another789' }));
    check('令牌一次性：复用失败', r.s === 400, JSON.stringify(r.j));
    r = await req('/api/auth/reset-password', post({ token: 'f'.repeat(64), newPassword: 'Another789' }));
    check('伪造令牌失败', r.s === 400);

    /* ---------- 令牌过期（改库中过期时间后重启实例验证） ---------- */
    r = await req('/api/auth/forgot-password', post({ account: 'tester1@test.local' }));
    check('按邮箱也能申请重置', r.s === 200 && r.j.ok === true);
    const token2 = lastResetToken();
    check('第二次令牌已生成', !!token2 && token2 !== token1);
    const db2 = readDb();
    const u2 = db2.users.find(u => u.username === 'tester1');
    u2.resetExpires = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(tmp, 'data', 'db.json'), JSON.stringify(db2));
    child.kill('SIGTERM');
    await sleep(600);
    child = startServer();
    check('实例重启', await waitUp());
    r = await req('/api/auth/reset-password', post({ token: token2, newPassword: 'Another789' }));
    check('过期令牌被拒', r.s === 400, JSON.stringify(r.j));

    /* ---------- 免码窗开启 → 强制验证码 ---------- */
    r = await req('/api/auth/login', post({ account: 'admin', password: ADMIN_PW }));
    check('管理员登录', r.s === 200, JSON.stringify(r.j).slice(0, 120));
    const adminCookie = r.cookie;
    r = await req('/api/admin/reg-window', post({ hours: 1 }), adminCookie);
    check('开免码窗', r.j.open === true, JSON.stringify(r.j));
    r = await req('/api/auth/reg-status');
    check('开窗后 reg-status 报 captchaRequired', r.j.open === true && r.j.captchaRequired === true, JSON.stringify(r.j));
    r = await req('/api/auth/register', post({ username: 'tester2', name: '', email: 'tester2@test.local', password: 'Pass123456' }));
    check('开窗无验证码注册被拒（needCaptcha）', r.s === 400 && r.j.needCaptcha === true, JSON.stringify(r.j));
    r = await req('/api/auth/captcha');
    const cap1 = r.j;
    const ans1 = captchaAnswer(cap1.svg);
    r = await req('/api/auth/register', post({ username: 'tester2', name: '', email: 'tester2@test.local', password: 'Pass123456', captchaId: cap1.id, captchaAnswer: ans1.toLowerCase() }));
    check('带对验证码注册成功（大小写不敏感）', r.s === 200 && r.j.user.username === 'tester2', JSON.stringify(r.j).slice(0, 200));
    /* 答错一次即失效 */
    r = await req('/api/auth/captcha');
    const cap2 = r.j;
    const ans2 = captchaAnswer(cap2.svg);
    const wrong2 = (ans2[0] === 'A' ? 'B' : 'A') + ans2.slice(1);
    r = await req('/api/auth/register', post({ username: 'tester3', name: '', email: 'tester3@test.local', password: 'Pass123456', captchaId: cap2.id, captchaAnswer: wrong2 }));
    check('答错被拒', r.s === 400 && r.j.needCaptcha === true);
    r = await req('/api/auth/register', post({ username: 'tester3', name: '', email: 'tester3@test.local', password: 'Pass123456', captchaId: cap2.id, captchaAnswer: ans2 }));
    check('答错后同一验证码失效（答对也不行）', r.s === 400 && r.j.needCaptcha === true, JSON.stringify(r.j));
    r = await req('/api/auth/captcha');
    const cap3 = r.j;
    r = await req('/api/auth/register', post({ username: 'tester3', name: '', email: 'tester3@test.local', password: 'Pass123456', captchaId: cap3.id, captchaAnswer: captchaAnswer(cap3.svg) }));
    check('刷新验证码后注册成功', r.s === 200 && r.j.user.username === 'tester3');
    r = await req('/api/auth/register', post({ username: 'tester4', name: '', email: 'tester4@test.local', password: 'Pass123456', captchaId: cap3.id, captchaAnswer: captchaAnswer(cap3.svg) }));
    check('已用过的验证码不能复用', r.s === 400 && r.j.needCaptcha === true);
    /* 邀请码在开窗期同样豁免 */
    const code2 = codePool[1];
    r = await req('/api/auth/register', post({ username: 'tester5', name: '', email: 'tester5@test.local', password: 'Pass123456', code: code2 }));
    check('开窗期带邀请码免验证码', r.s === 200 && r.j.user.username === 'tester5', JSON.stringify(r.j).slice(0, 160));

    /* ---------- 关窗后：同 IP 1 小时无码尝试 ≥3 次才触发 ---------- */
    r = await req('/api/admin/reg-window', post({ off: true }), adminCookie);
    check('关免码窗', r.j.open === false);
    const IPH = { 'X-Forwarded-For': '9.9.9.9' };
    for (let i = 1; i <= 3; i++) {
      r = await req('/api/auth/register', post({ username: 'freq' + i, name: '', email: 'freq' + i + '@test.local', password: 'Pass123456' }), null, IPH);
      check(`同 IP 第 ${i} 次无码尝试：只提示需要邀请码，不强制验证码`, r.s === 400 && !r.j.needCaptcha && /邀请码|注册码/.test(r.j.error || ''), JSON.stringify(r.j));
    }
    r = await req('/api/auth/register', post({ username: 'freq4', name: '', email: 'freq4@test.local', password: 'Pass123456' }), null, IPH);
    check('同 IP 第 4 次无码尝试：触发验证码', r.s === 400 && r.j.needCaptcha === true, JSON.stringify(r.j));
    r = await req('/api/auth/reg-status', {}, null, IPH);
    check('该 IP 的 reg-status 显示 captchaRequired', r.j.captchaRequired === true, JSON.stringify(r.j));

    /* ---------- 前端页面可达 ---------- */
    for (const p of ['/forgot-password', '/reset-password?token=abc', '/login', '/register']) {
      const rr = await fetch(BASE + p);
      check('页面 ' + p + ' 返回 SPA', rr.status === 200 && (await rr.text()).includes('app.js'));
    }
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n结果：${pass} 过 / ${fail} 败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
