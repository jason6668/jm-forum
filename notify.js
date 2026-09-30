/* =====================================================
 * 通知模块：Telegram Bot + 企业微信群机器人
 * - Telegram：Bot Token + Chat ID（群 ID），sendMessage
 * - 企业微信：群机器人 webhook，markdown 消息
 * - 触发事件：newUser 新用户注册 / newTopic 新帖 / newReply 新回复
 * - 所有发送均为异步、失败静默（不影响主业务流程）
 * 配置存储在 db.settings.notify，管理后台可配置
 * ===================================================== */
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '') || 'http://localhost:3000';
const TG_API = 'https://api.telegram.org/bot';

function defaultNotify() {
  return {
    telegram: { enabled: false, botToken: '', chatId: '' },
    wecom: { enabled: false, webhook: '' },
    events: { newUser: true, newTopic: true, newReply: false },
  };
}

/* 与历史配置合并，缺字段补默认值 */
function mergeNotify(cfg) {
  const d = defaultNotify();
  if (!cfg || typeof cfg !== 'object') return d;
  return {
    telegram: { ...d.telegram, ...(cfg.telegram || {}) },
    wecom: { ...d.wecom, ...(cfg.wecom || {}) },
    events: { ...d.events, ...(cfg.events || {}) },
  };
}

function htmlEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- Telegram ---------- */
async function sendTelegram(cfg, text) {
  if (!cfg || !cfg.botToken || !cfg.chatId) throw new Error('Telegram 未配置 Bot Token / Chat ID');
  const res = await fetch(`${TG_API}${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text: String(text).slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error('Telegram 发送失败: ' + (data.description || res.status));
  return { ok: true, via: 'telegram' };
}

/* ---------- 企业微信群机器人 ---------- */
async function sendWecom(cfg, content) {
  if (!cfg || !cfg.webhook) throw new Error('企业微信未配置群机器人 Webhook');
  const res = await fetch(cfg.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: String(content).slice(0, 4000) } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errcode !== 0) throw new Error('企业微信发送失败: ' + (data.errmsg || res.status));
  return { ok: true, via: 'wecom' };
}

/* ---------- 消息模板 ---------- */
function buildTelegram(event, p) {
  const link = `${SITE_URL}/topic/${p.topicId}`;
  const who = `<b>${htmlEsc(p.name || p.username)}</b>（<code>@${htmlEsc(p.username)}</code>）`;
  switch (event) {
    case 'newUser': return `🎉 <b>新用户注册</b>\n${who} 加入了社区`;
    case 'newTopic': return `📝 <b>新帖发布</b> [${htmlEsc(p.board || '')}]\n<b>${htmlEsc(p.title)}</b>\nby ${who}\n<a href="${link}">查看帖子</a>`;
    case 'newReply': return `💬 <b>新回复</b>\n${htmlEsc(p.title)}\nby ${who}\n<a href="${link}">查看帖子</a>`;
    default: return '';
  }
}

function buildWecom(event, p) {
  const link = `${SITE_URL}/topic/${p.topicId}`;
  const who = `**${p.name || p.username}**（@${p.username}）`;
  switch (event) {
    case 'newUser': return `### 🎉 新用户注册\n${who} 加入了社区`;
    case 'newTopic': return `### 📝 新帖发布 [${p.board || ''}]\n**${p.title}**\n> 作者：${who}\n> [查看帖子](${link})`;
    case 'newReply': return `### 💬 新回复\n**${p.title}**\n> 作者：${who}\n> [查看帖子](${link})`;
    default: return '';
  }
}

/* ---------- 统一入口：按事件开关 + 渠道开关发送 ---------- */
async function notifyAll(db, event, payload) {
  try {
    db.settings = db.settings || {};
    db.settings.notify = mergeNotify(db.settings.notify);
    const cfg = db.settings.notify;
    if (!cfg.events[event]) return [];
    const results = [];
    if (cfg.telegram.enabled && cfg.telegram.botToken && cfg.telegram.chatId) {
      try { results.push(await sendTelegram(cfg.telegram, buildTelegram(event, payload))); }
      catch (e) { console.error('[notify:telegram]', e.message); results.push({ ok: false, via: 'telegram', error: e.message }); }
    }
    if (cfg.wecom.enabled && cfg.wecom.webhook) {
      try { results.push(await sendWecom(cfg.wecom, buildWecom(event, payload))); }
      catch (e) { console.error('[notify:wecom]', e.message); results.push({ ok: false, via: 'wecom', error: e.message }); }
    }
    return results;
  } catch (e) {
    console.error('[notify]', e.message);
    return [];
  }
}

/* 用 Bot Token 拉取最近可用的会话列表（需先与 Bot 对话 / 将 Bot 拉入群） */
async function telegramChats(botToken) {
  if (!botToken) throw new Error('缺少 Bot Token');
  const res = await fetch(`${TG_API}${botToken}/getUpdates`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error('获取会话列表失败: ' + (data.description || res.status));
  const seen = new Map();
  (data.result || []).forEach(u => {
    const ch = (u.message || u.channel_post || u.edited_message || {}).chat || (u.my_chat_member || {}).chat;
    if (!ch) return;
    const id = String(ch.id);
    if (seen.has(id)) return;
    const typeMap = { group: '群组', supergroup: '超级群组', channel: '频道', private: '私聊' };
    seen.set(id, {
      id,
      title: ch.title || ch.username || ch.first_name || id,
      type: typeMap[ch.type] || ch.type,
      username: ch.username || '',
    });
  });
  return Array.from(seen.values());
}

module.exports = { defaultNotify, mergeNotify, sendTelegram, sendWecom, notifyAll, telegramChats };
