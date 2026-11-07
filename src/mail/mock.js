/**
 * 内存 Mock 邮件适配器 —— 用于单元测试与集成测试。
 * 模拟 QQ 邮箱收件箱，行为可控、零网络依赖，确保收发链路稳定可测。
 * 接口与 QQMailAdapter 完全一致。
 */
import { normalizeMail } from '../schema.js';

export class MockMailAdapter {
  /**
   * @param {{account:string}} cfg
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    /** @type {import('../schema.js').MailMessage[]} */
    this._inbox = [];
    this._sent = [];
    // 文件夹：INBOX / Sent / Deleted（mock 用数组存）
    this._folders = { INBOX: this._inbox, Sent: this._sent, Deleted: [] };
    this._seen = new Set();
    this.connected = false;
    this._failNextConnect = false;
  }

  /** 测试辅助：预置一封邮件到收件箱。 */
  seed(message) {
    this._inbox.push(normalizeMail({ ...message, direction: 'inbound' }));
  }

  async connect() {
    if (this._failNextConnect) {
      this._failNextConnect = false;
      throw new Error('mock connect failed');
    }
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async listMessages(opts = {}) {
    const folder = opts.folder || 'INBOX';
    let list = [...(this._folders[folder] || [])];
    if (opts.unreadOnly) list = list.filter((m) => !this._seen.has(m.id));
    if (opts.since) list = list.filter((m) => new Date(m.date) >= opts.since);
    const total = list.length;
    if (opts.limit) list = list.slice(-opts.limit);
    return { mails: list, total };
  }

  async getMessage(id, folder = 'INBOX') {
    return (this._folders[folder] || []).find((m) => m.id === id) || null;
  }

  async sendMessage(msg) {
    const m = normalizeMail({
      id: 'sent-' + Date.now(),
      from: [{ address: this.cfg.account || 'me@qq.com' }],
      to: msg.to.map((a) => ({ address: a })),
      subject: msg.subject,
      text: msg.text,
      html: msg.html || '',
      date: new Date().toISOString(),
      direction: 'outbound',
    });
    this._sent.push(m);
    return m;
  }

  async markSeen(id) {
    this._seen.add(id);
  }

  async deleteMessage(id, folder = 'INBOX') {
    const src = this._folders[folder] || [];
    const idx = src.findIndex((m) => m.id === id);
    if (idx >= 0) {
      const [m] = src.splice(idx, 1);
      this._folders.Deleted.push(m);
    }
  }

  async moveMessage(id, fromFolder, toFolder) {
    const src = this._folders[fromFolder] || [];
    const idx = src.findIndex((m) => m.id === id);
    if (idx >= 0) {
      const [m] = src.splice(idx, 1);
      (this._folders[toFolder] || []).push(m);
    }
  }

  /** 测试辅助：读取已发件（校验投递是否成功）。 */
  sentBox() {
    return this._sent;
  }
}
