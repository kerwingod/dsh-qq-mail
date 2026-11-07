/**
 * 邮件适配器接口（约定）
 * ---------------------------------------------------------------
 * 真实实现与 Mock 实现都遵守同一组方法签名，插件其余部分只依赖接口，
 * 从而在「真实 QQ 邮箱」与「测试 Mock」之间无缝切换。
 *
 * @typedef {import('../schema.js').MailMessage} MailMessage
 *
 * 接口方法：
 *   connect(): Promise<void>
 *   disconnect(): Promise<void>
 *   listMessages(opts?: {folder?:string, since?: Date, unreadOnly?: boolean, limit?:number}): Promise<{mails:MailMessage[], total:number}>
 *   getMessage(id, folder?): Promise<MailMessage | null>
 *   sendMessage(msg: {to:string[], subject:string, text:string, html?:string}): Promise<MailMessage>
 *   markSeen(id, folder?): Promise<void>
 *   deleteMessage(id, folder?): Promise<void>   // 移入「已删除」文件夹，可恢复
 *   moveMessage(id, fromFolder, toFolder): Promise<void>
 *
 * 文件夹约定：'INBOX' 收件箱 / 'Sent' 发件箱 / 'Deleted' 已删除（QQ 邮箱里叫"已删除"）。
 */

/**
 * 真实 QQ 邮箱适配器（IMAP 收 / SMTP 发）。
 * 依赖 imapflow、nodemailer、mailparser，运行时懒加载；
 * 若宿主环境没装这些包，则会在 connect() 时报错，由上层降级到 Mock。
 * 这样「先保证可运行」：插件能加载，缺依赖时联动 Mock，不会整体崩。
 */
// 逻辑文件夹名（前端用）。真实 IMAP 名不固定（QQ 是 "Sent Messages" / "Deleted Messages"），
// 一律在 connect() 时按 IMAP 标准 flag（\Sent / \Trash）动态解析。
const FOLDERS = {
  INBOX: 'INBOX',
  Sent: 'Sent',
  Deleted: 'Deleted', // 逻辑名；真实名由 _resolveFolder 按 flag 解析
};

const IMAP_OP_TIMEOUT = 15000; // 单步 IMAP 操作超时（ms）：超时即放弃并重建连接，避免永久卡死

/** 给 Promise 套一个超时帽子：超时 reject，原 Promise 仍在后台跑（靠连接自愈兜底）。 */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}超时`)), ms)),
  ]);
}

export class QQMailAdapter {
  /**
   * @param {{account:string, authCode:string, imapHost:string, imapPort:number, imapSecure:boolean, smtpHost:string, smtpPort:number, smtpSecure:boolean}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this._imap = null;
    this._connected = false;
    this._deletedFolder = null; // 运行期探测到的「已删除」真实名
    this._chain = Promise.resolve(); // 串行化：同一时刻只有一个 IMAP 操作在跑，避免“邮箱已锁”
    this._stale = false; // 标记连接已损坏，下次操作前重建
  }

  /** 公开连接状态（供 HTTP 健康检查读取；真实适配器用私有 _connected 存储）。 */
  get connected() {
    return this._connected;
  }

  async connect() {
    // 动态加载，避免无依赖时顶层 import 直接失败
    const { ImapFlow } = await import('imapflow');
    this._imap = new ImapFlow({
      host: this.cfg.imapHost,
      port: this.cfg.imapPort,
      secure: this.cfg.imapSecure,
      clientTimeout: 15000, // 命令响应超时：卡住的 fetch 会在这里被中止
      socketTimeout: 20000, // 空闲/僵死 socket 超时：兜底断开坏连接
      auth: { user: this.cfg.account, pass: this.cfg.authCode },
    });
    await this._imap.connect();
    this._connected = true;
    // 探测文件夹真实名（按 IMAP 标准 flag 解析 Sent / Deleted）
    await this._resolveFolders();
  }

  /**
   * 按 IMAP 标准 flag 把逻辑名映射到真实文件夹路径：
   *  - \Sent   -> 已发送（QQ 真实名为 "Sent Messages" 等）
   *  - \Trash  -> 已删除（QQ 真实名为 "Deleted Messages" 等）
   *  - INBOX   -> 直接返回
   */
  async _resolveFolders() {
    this._folderMap = { INBOX: 'INBOX', Sent: null, Deleted: null };
    try {
      const list = (await this._imap.list()) || [];
      for (const m of list) {
        const flags = m.flags || new Set();
        if (flags.has('\\Sent') && !this._folderMap.Sent) this._folderMap.Sent = m.path;
        if (flags.has('\\Trash') && !this._folderMap.Deleted) this._folderMap.Deleted = m.path;
      }
    } catch {
      /* 保留 null，下面回退 */
    }
    this._folderMap.Sent = this._folderMap.Sent || 'Sent';
    this._folderMap.Deleted = this._folderMap.Deleted || 'Deleted';
  }

  /** 逻辑文件夹名 -> IMAP 真实路径。 */
  _resolveFolder(logical) {
    if (!logical) return FOLDERS.INBOX;
    const map = this._folderMap || { INBOX: 'INBOX', Sent: 'Sent', Deleted: 'Deleted' };
    if (logical === FOLDERS.Sent) return map.Sent;
    if (logical === FOLDERS.Deleted) return map.Deleted;
    return logical;
  }

  async disconnect() {
    if (this._imap) await this._imap.logout();
    this._connected = false;
  }

  /**
   * 列出某文件夹的邮件。返回 {mails, total}：total 是该文件夹真实邮件总数（不受 limit 影响）。
   * @param {{folder?:string, since?:Date, unreadOnly?:boolean, limit?:number}} opts
   */
  /**
   * 列出某文件夹的邮件（支持分页）。返回 {mails, total, page, pageSize, pageCount}：
   * total 是该文件夹真实邮件总数（不受单页大小影响）；mails 是当前页（最新在前）。
   * @param {{folder?:string, since?:Date, unreadOnly?:boolean, page?:number, pageSize?:number}} opts
   */
  async listMessages(opts = {}) {
    const folder = this._resolveFolder(opts.folder || FOLDERS.INBOX);
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 30));
    return this._withImap(folder, async (imap) => {
      /** @type {MailMessage[]} */
      const out = [];
      let asc = []; // 升序 UID 列表（用于窗口分页）

      if (opts.q) {
        const q = String(opts.q);
        // 中文 / 非 ASCII：QQ 的 IMAP 服务端检索对中文不可靠（会返回全部），
        // 改为取全部信封（主题 + 发件人）在本地按包含匹配。
        if (/[^\x00-\x7f]/.test(q)) {
          const all = [];
          for await (const m of imap.fetch('1:*', { uid: true, envelope: true })) all.push(m);
          const ql = q.toLowerCase();
          asc = all
            .filter((m) => {
              const subj = ((m.envelope && m.envelope.subject) || '').toLowerCase();
              const from = ((m.envelope && m.envelope.from) || [])
                .map((f) => (f.address || f.name || '')).join(' ').toLowerCase();
              return subj.includes(ql) || from.includes(ql);
            })
            .map((m) => m.uid);
        } else {
          // 纯 ASCII：用 IMAP 服务端检索（快），主题 / 发件人 / 正文 任一命中即匹配
          const query = { or: [
            { header: ['SUBJECT', q] },
            { header: ['FROM', q] },
            { body: q },
          ] };
          asc = ((await imap.search(query, { uid: true })) || []).slice().sort((a, b) => a - b);
        }
      } else {
        const query = {};
        if (opts.unreadOnly) query.seen = false;
        if (opts.since) query.since = opts.since;
        asc = ((await imap.search(query, { uid: true })) || []).slice().sort((a, b) => a - b);
      }

      const total = asc.length;
      // 最新在前：把升序 UID 反转为降序，再按页取窗口
      const ordered = asc.slice().reverse();
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pageCount);
      const start = (safePage - 1) * pageSize;
      const picked = ordered.slice(start, start + pageSize);
      for (const uid of picked) {
        const msg = await imap.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (msg && msg.source) {
          const parsed = await parseSource(msg.source, uid);
          parsed.folder = folder; // 标注来源文件夹，便于后续打开 / 删除
          parsed.seen = msg.flags ? msg.flags.has('\\Seen') : false; // 真实已读/未读
          out.push(parsed);
        }
      }
      return { mails: out, total, page: safePage, pageSize, pageCount };
    });
  }

  async getMessage(id, folder = FOLDERS.INBOX) {
    folder = this._resolveFolder(folder);
    return this._withImap(folder, async (imap) => {
      const msg = await imap.fetchOne(String(id), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const m = await parseSource(msg.source);
      m.folder = folder;
      return m;
    });
  }

  async sendMessage(msg) {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort,
      secure: this.cfg.smtpSecure,
      auth: { user: this.cfg.account, pass: this.cfg.authCode },
    });
    const info = await transport.sendMail({
      from: this.cfg.account,
      to: msg.to.join(', '),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return {
      id: info.messageId,
      from: [{ address: this.cfg.account }],
      to: msg.to.map((a) => ({ address: a })),
      subject: msg.subject,
      text: msg.text,
      html: msg.html || '',
      date: new Date().toISOString(),
      links: [],
      attachments: [],
      direction: 'outbound',
    };
  }

  async markSeen(id, folder = FOLDERS.INBOX, seen = true) {
    folder = this._resolveFolder(folder);
    return this._withImap(folder, async (imap) => {
      // seen=true 加 \Seen（标已读）；seen=false 去掉 \Seen（标未读）
      if (seen) await imap.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
      else await imap.messageFlagsRemove(String(id), ['\\Seen'], { uid: true });
    });
  }

  /**
   * 删除 = 移入「已删除」文件夹（可恢复）。QQ 邮箱把已删除当普通文件夹。
   * @param {string|number} id  IMAP UID（在该 folder 内唯一）
   * @param {string} folder  源文件夹（默认收件箱）
   */
  async deleteMessage(id, folder = FOLDERS.INBOX) {
    const target = this._resolveFolder(FOLDERS.Deleted);
    return this._withImap(this._resolveFolder(folder), async (imap) =>
      this._moveInner(imap, String(id), this._resolveFolder(folder), target));
  }

  /**
   * 在 IMAP 里把一封邮件从一个文件夹移动到另一个，复用 _moveInner（messageMove 原子移动）。
   */
  async moveMessage(id, fromFolder, toFolder) {
    return this._withImap(this._resolveFolder(fromFolder), async (imap) =>
      this._moveInner(imap, String(id), this._resolveFolder(fromFolder), this._resolveFolder(toFolder)));
  }

  async _moveInner(imap, id, fromFolder, toFolder) {
    // imapflow 2.x 没有 imap.copy；用 messageMove 原子地移动到目标文件夹
    // （内部走 MOVE 命令，服务器不支持时回退为 COPY + 标记\Deleted + EXPUNGE）。
    await imap.messageMove(String(id), toFolder, { uid: true });
  }

  // ---- 连接自愈：单连接串行化 + 单步操作超时 + 出错自动重建 ----
  async _withImap(folder, fn) {
    const release = await this._chainAcquire();
    try {
      await this._ensureConnection();
      const lock = await withTimeout(this._imap.getMailboxLock(folder), IMAP_OP_TIMEOUT, '锁定邮箱');
      try {
        return await withTimeout(fn(this._imap), IMAP_OP_TIMEOUT, '邮件操作');
      } finally {
        try { lock.release(); } catch {}
      }
    } catch (e) {
      this._killConnection(); // 任一步异常 → 标记坏连接，下次操作前重建
      throw e;
    } finally {
      release();
    }
  }

  /** 仅保证连接存活并运行 fn（不锁定邮箱），用于 LIST 这类与邮箱选择无关的命令。 */
  async _withConnection(fn) {
    const release = await this._chainAcquire();
    try {
      await this._ensureConnection();
      return await withTimeout(fn(this._imap), IMAP_OP_TIMEOUT, '连接操作');
    } catch (e) {
      this._killConnection();
      throw e;
    } finally {
      release();
    }
  }

  /**
   * 列出全部邮箱文件夹（含父子层级），返回树形结构。
   * 每个节点：{ id, path, name, parentPath, label, specialUse, flags, noSelect, hasChildren, children }
   * - 特殊文件夹（\Inbox/\Sent/\Trash/\Drafts/\Junk）给出中文标签；
   * - \NoSelect 节点（如“其他文件夹”）不可直接打开，只能展开看子文件夹。
   */
  async listFolders() {
    const nodes = await this._withConnection(async (imap) => {
      const raw = (await imap.list()) || [];
      return raw.map((mb) => {
        const flags = [...(mb.flags || [])];
        const suMatch = flags.find((f) => /^\\(Inbox|Sent|Trash|Drafts|Junk)$/i.test(f));
        let specialUse = suMatch ? suMatch.replace(/\\/g, '').toLowerCase() : null;
        // QQ 收件箱不一定带 \Inbox 标志，按路径兜底，保证排在最前且用收件箱图标
        if (!specialUse && /^inbox$/i.test(mb.path || mb.name || '')) specialUse = 'inbox';
        const labelMap = { inbox: '收件箱', sent: '已发送', trash: '已删除', drafts: '草稿箱', junk: '垃圾箱' };
        return {
          id: mb.path,
          path: mb.path,
          name: mb.name,
          parentPath: mb.parentPath || '',
          label: specialUse ? (labelMap[specialUse] || mb.name) : mb.name,
          specialUse,
          flags,
          noSelect: flags.includes('\\NoSelect'),
          hasChildren: flags.includes('\\HasChildren'),
          children: [],
        };
      });
    });

    // 用 parentPath 组装成树
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    const roots = [];
    for (const n of nodes) {
      const parent = n.parentPath && byPath.has(n.parentPath) ? byPath.get(n.parentPath) : null;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }

    // 排序：特殊文件夹优先，其余按中文名
    const rank = { inbox: 0, sent: 1, drafts: 2, junk: 3, trash: 4 };
    const sortFn = (a, b) => {
      const ra = a.specialUse && rank[a.specialUse] !== undefined ? rank[a.specialUse] : 99;
      const rb = b.specialUse && rank[b.specialUse] !== undefined ? rank[b.specialUse] : 99;
      if (ra !== rb) return ra - rb;
      return (a.label || '').localeCompare(b.label || '', 'zh');
    };
    const sortTree = (arr) => { arr.sort(sortFn); arr.forEach((c) => sortTree(c.children)); };
    sortTree(roots);
    return roots;
  }

  async _chainAcquire() {
    const prev = this._chain;
    let release;
    this._chain = new Promise((r) => { release = r; });
    await prev;
    return () => { try { release(); } catch {} };
  }

  async _ensureConnection() {
    if (this._connected && this._imap && !this._stale) return;
    this._killConnection();
    await this.connect();
  }

  _killConnection() {
    this._stale = false;
    if (this._imap) {
      try { this._imap.close().catch(() => {}); } catch {}
      this._imap = null;
    }
    this._connected = false;
  }
}

export { FOLDERS };

/** 把 RFC822 源码解析为 MailMessage（依赖 mailparser）。uid 存在时作为邮件 id。 */
async function parseSource(source, uid) {  const { simpleParser } = await import('mailparser');
  const p = await simpleParser(source);
  const from = (p.from?.value || []).map((v) => ({ name: v.name, address: v.address }));void from;
  const to = (p.to?.value || []).map((v) => ({ name: v.name, address: v.address }));void to;
  const text = p.text || '';void text;
  const html = p.html || '';void html;
  const links = [];void links;
  const { normalizeMail, extractLinks } = await import('../schema.js');
  const plain = p.text || (p.html ? htmlToText(p.html) : '');
  const base = normalizeMail({
    id: uid !== undefined ? String(uid) : String(p.messageId || ''),
    from: (p.from?.value || []).map((v) => ({ name: v.name, address: v.address })),
    to: (p.to?.value || []).map((v) => ({ name: v.name, address: v.address })),
    subject: p.subject || '',
    text: plain,
    html: p.html || '',
    date: p.date ? new Date(p.date).toISOString() : new Date().toISOString(),
    attachments: (p.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.contentType || '',
      size: a.size || 0,
    })),
  });
  base.links = extractLinks(base);
  return base;
}

/** 极简 HTML -> 纯文本：HTML-only 邮件没有 text 时的回退（去标签、解常见实体）。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
