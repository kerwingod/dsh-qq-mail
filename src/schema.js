/**
 * 双向同步数据 Schema
 * ---------------------------------------------------------------
 * 统一描述「邮件」与「DSH 会话消息」两侧的数据结构，并提供转换函数，
 * 让插件内部只和一种标准结构打交道，避免到处写字段映射。
 *
 * 设计要点（先保证可运行，再谈优化）：
 *  - MailMessage / ChatMessage 都是普通对象（JSON 友好），便于落盘与测试。
 *  - extractLinks() 用于保证「邮件里的链接能正常跳转」：HTML 正文里的
 *    <a href> 被原样保留，纯文本里出现的 http(s) 链接也会被单独抽出，
 *    供 UI / 转发时渲染成可点击链接。
 */

/**
 * 邮件地址结构
 * @typedef {{ name?: string, address: string }} MailAddress
 */

/**
 * 统一的邮件消息结构
 * @typedef {Object} MailMessage
 * @property {string} id           邮件唯一标识（IMAP uid 或 mock 生成的 uuid）
 * @property {MailAddress[]} from  发件人
 * @property {MailAddress[]} to    收件人
 * @property {string} subject      主题
 * @property {string} text         纯文本正文
 * @property {string} html         HTML 正文（可能为 ''，原样保留 <a href>）
 * @property {string} date         ISO 时间字符串
 * @property {string[]} links      从正文中提取出的链接（保证可跳转）
 * @property {Array<{filename:string, contentType:string, size:number}>} attachments 附件元信息
 * @property {'inbound'|'outbound'} direction 方向：收 / 发
 */

/**
 * DSH 会话消息结构
 * @typedef {Object} ChatMessage
 * @property {string} id           消息 id
 * @property {string} sessionId   所属会话 id
 * @property {'user'|'assistant'|'system'} role 角色
 * @property {string} text         文本内容
 * @property {string} date         ISO 时间字符串
 * @property {string[]} links      提取出的链接
 */

/**
 * 同步记录：记录一次「邮件 <-> 会话」的桥接，便于去重与追溯。
 * @typedef {Object} SyncRecord
 * @property {string} mailId       邮件 id
 * @property {string} [sessionId]  关联的 DSH 会话 id
 * @property {string} [chatMsgId]  关联的会话消息 id
 * @property {('inbound'|'outbound')} direction
 * @property {string} syncedAt     ISO 时间
 */

/**
 * 从一段文本中抽出 http(s) 链接（用于纯文本正文）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrlsFromText(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  const found = text.match(re) || [];
  // 去掉结尾的标点（常见在句末带有 。,; 等）
  return [...new Set(found.map((u) => u.replace(/[.,;。，；]+$/, '')))];
}

/**
 * 从 HTML 中提取 <a href="..."> 链接。
 * 注意：这里只“抽取”，不做任何改写——HTML 正文在转发/投递时原样保留，
 * 因此邮件中的链接天然可点击跳转。
 * @param {string} html
 * @returns {string[]}
 */
export function extractUrlsFromHtml(html) {
  if (!html) return [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (/^https?:\/\//i.test(url)) out.push(url);
  }
  return [...new Set(out)];
}

/**
 * 合并文本与 HTML 中的链接。
 * @param {{text?:string, html?:string}} msg
 * @returns {string[]}
 */
export function extractLinks(msg) {
  const t = extractUrlsFromText(msg?.text || '');
  const h = extractUrlsFromHtml(msg?.html || '');
  return [...new Set([...t, ...h])];
}

/**
 * 把 DSH 会话消息转成“可投递邮件”的纯文本（链接保留为可点击形式）。
 * 纯文本邮件里链接就是原 URL，收件客户端会自动识别成可点击链接。
 * @param {ChatMessage} chat
 * @returns {{subject:string, text:string, html:string}}
 */
export function chatToMailContent(chat) {
  const roleLabel = { user: '你', assistant: '助手', system: '系统' }[chat.role] || chat.role;
  const text = `[DSH 会话 ${chat.sessionId} · ${roleLabel}]\n${chat.text}`;
  // 同时给一份 HTML：文本转义后，把其中的 http(s) 链接替换成 <a href>，
  // 保证在网页邮箱里点一下就能跳转（链接可点击是交付硬要求）。
  const safeText = escapeHtml(chat.text).replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => {
    const safeUrl = escapeAttr(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  const html = `<div style="font-family:system-ui,sans-serif"><p><b>DSH 会话 ${escapeHtml(
    chat.sessionId,
  )} · ${roleLabel}</b></p><p>${safeText.replace(/\n/g, '<br>')}</p></div>`;
  return { subject: `[DSH] 会话片段 ${chat.sessionId}`, text, html };
}

/**
 * 把收到的邮件转成“转发到 DSH 会话”的文本，链接转成 Markdown 方便点击。
 * @param {MailMessage} mail
 * @returns {string}
 */
export function mailToChatText(mail) {
  const fromStr = mail.from.map((f) => f.address).join(', ');
  let body = mail.text || (mail.html ? '[HTML 邮件，请在邮箱查看]' : '');
  const links = mail.links.length ? '\n\n相关链接：\n' + mail.links.map((l) => `- ${l}`).join('\n') : '';
  return `📧 新邮件来自 ${fromStr}\n主题：${mail.subject}\n\n${body}${links}`;
}

/** 极简 HTML 转义，防止投递正文注入。 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值转义，防止 URL 注入到 href 属性。 */
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 生成简单唯一 id（测试与生产共用，避免引入额外依赖）。
 * @returns {string}
 */
export function genId() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 把任意对象收敛成合法的 MailMessage（用于 mock / 边界兜底）。
 * @param {Partial<MailMessage>} raw
 * @returns {MailMessage}
 */
export function normalizeMail(raw = {}) {
  const base = {
    id: raw.id || genId(),
    from: Array.isArray(raw.from) ? raw.from : [],
    to: Array.isArray(raw.to) ? raw.to : [],
    subject: raw.subject || '(无主题)',
    text: raw.text || '',
    html: raw.html || '',
    date: raw.date || new Date().toISOString(),
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    direction: raw.direction === 'outbound' ? 'outbound' : 'inbound',
  };
  base.links = extractLinks(base);
  return base;
}
