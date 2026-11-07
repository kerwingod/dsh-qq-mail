/**
 * DSH 适配模块
 * ---------------------------------------------------------------
 * 职责：
 *   1) 把插件能力以 DSH Tool 形式暴露（发信 / 收信 / 取信 / 立即摘要）。
 *   2) 监听 DSH 会话事件，捕获 user/assistant 消息，存入“会话内容池”，
 *      供定时任务汇总投递到邮箱（双向消息互传的另一半）。
 *   3) 轮询邮箱新邮件，收到后通过可注入的 deliver 回调“推送到 DSH”，
 *      实现 邮件 -> 会话 的消息互传。
 *
 * 关于边界（如实说明）：
 *   DSH 目前没有“向任意已有会话注入一条消息”的公开 API，因此 deliver
 *   默认用自定义事件 ctx.emit('qq-mail/inbound', text) 广播，并落地到
 *   一个可被工具读取的收件队列。生产环境可把 deliver 换成“写通知/插槽/
 *   subagent 消息”的实现，接口保持不变。
 */

import { mailToChatText, chatToMailContent, normalizeMail } from './schema.js';

/**
 * DSH 要求每个 Tool 必须声明规范输出：schema + render(args, value) -> ContentBlock[]。
 * 这里统一包一层：把工具返回值渲染成一段模型可见的纯文本。
 * @param {(value:any)=>string} summarize 把返回值概括成一句话
 */
function makeOutput(summarize) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      let text;
      try {
        text = summarize ? summarize(value) : JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      return [{ type: 'text', text }];
    },
  };
}

/**
 * @param {object} ctx  DSH Cordis 上下文
 * @param {object} cfg  插件 config（来自 cordis.patch.yml）
 * @param {object} mailAdapter 实现了 MailAdapter 接口的实例
 * @returns {() => void} 卸载函数（清理定时器与事件）
 */
export function setupDshBridge(ctx, cfg, mailAdapter) {
  const inboundQueue = []; // 收到的邮件待投递到 DSH 的内容
  /** @type {Array<{sessionId:string, role:string, text:string, date:string, links:string[]}>} */
  const chatPool = []; // 捕获的会话内容，供摘要使用
  let pollTimer = null;

  // 默认 deliver：广播自定义事件 + 入队（可被外部覆盖做更真实的投递）
  let deliver = (text) => {
    inboundQueue.push({ text, at: new Date().toISOString() });
    try {
      ctx.emit('qq-mail/inbound', text);
    } catch {
      /* 某些环境无 emit，忽略 */
    }
  };

  // ---- 1) 注册 DSH 工具 ----
  const disposers = [];
  disposers.push(
    ctx.tools.register({
      name: 'qqmail_send',
      description: '通过 QQ 邮箱发送一封邮件（支持主题/正文/HTML，正文链接可点击）',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: '收件人邮箱数组' },
          subject: { type: 'string', description: '邮件主题' },
          text: { type: 'string', description: '纯文本正文' },
          html: { type: 'string', description: '可选 HTML 正文' },
        },
        required: ['to', 'subject', 'text'],
      },
      output: makeOutput((v) => `已通过 QQ 邮箱发送邮件，messageId: ${v?.messageId ?? '未知'}`),
      async execute(args) {
        const m = await mailAdapter.sendMessage(args);
        return { ok: true, messageId: m.id };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'qqmail_list',
      description: '列出收件箱邮件（可按未读/时间过滤）',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '文件夹：INBOX（默认）/ Sent / Deleted' },
          unreadOnly: { type: 'boolean', description: '仅未读' },
          since: { type: 'string', description: 'ISO 时间，仅取此后的邮件' },
          limit: { type: 'number', description: '最多返回条数' },
        },
      },
      output: makeOutput((v) => {
        const rows = (v?.mails || []).map(
          (m) => `- [${m.id}] ${m.date || ''} ｜ ${(m.from || []).join(', ')} ｜ ${m.subject || '(无主题)'}`,
        );
        return rows.length ? `共 ${v.count} 封：\n${rows.join('\n')}` : '收件箱没有邮件';
      }),
      async execute(args) {
        const folder = args.folder || 'INBOX';
        const { mails, total } = await mailAdapter.listMessages({
          folder,
          unreadOnly: args.unreadOnly,
          since: args.since ? new Date(args.since) : undefined,
          limit: args.limit || 20,
        });
        const slim = mails.map((m) => ({
          id: m.id,
          folder,
          from: m.from.map((f) => f.address),
          subject: m.subject,
          date: m.date,
          links: m.links,
        }));
        return { count: total, mails: slim };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'qqmail_get',
      description: '按 id 获取单封邮件完整内容（含链接）',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      output: makeOutput((v) => {
        const m = v?.mail;
        if (!m) return `未找到：${v?.error ?? '未知'}`;
        const links = (m.links || []).length ? `\n\n链接：\n${m.links.map((l) => `- ${l}`).join('\n')}` : '';
        return `主题：${m.subject}\n发件人：${(m.from || []).map((f) => f.address).join(', ')}\n时间：${m.date}\n\n${String(m.text || '').slice(0, 2000)}${links}`;
      }),
      async execute(args) {
        const m = await mailAdapter.getMessage(args.id, args.folder || 'INBOX');
        return m ? { mail: m } : { error: 'not found' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'qqmail_inbound_queue',
      description: '读取“邮件->DSH”待投递队列（验证消息互传用）',
      parameters: { type: 'object', properties: {} },
      output: makeOutput((v) => {
        const items = (v?.items || []).map((it) => `- ${it.text}`).join('\n');
        return items ? `待投递 ${v.count} 条：\n${items}` : `待投递到 DSH 的邮件：${v?.count ?? 0} 条`;
      }),
      async execute() {
        return { count: inboundQueue.length, items: inboundQueue.slice() };
      },
    }),
  );

  // ---- 2) 监听 DSH 会话事件，捕获消息 ----
  const offSession = ctx.on?.('session/event', (payload) => {
    // 防御式读取：不同版本字段形态可能不同，只取存在的字段
    const p = payload || {};
    const type = p.type || p.event || '';
    if (!/message|assistant|user|turn\/end/i.test(String(type))) return;
    const msg = p.message || p.data?.message || p;
    const text = msg?.text || msg?.content || '';
    const role = msg?.role || (p.role || 'unknown');
    const sessionId = p.sessionId || p.session?.id || 'unknown';
    if (!text) return;
    chatPool.push({
      sessionId,
      role,
      text: String(text),
      date: new Date().toISOString(),
      links: [],
    });
  });
  if (typeof offSession === 'function') disposers.push(offSession);

  // ---- 3) 轮询邮箱新邮件，推送到 DSH ----
  if (cfg.forwardInboundToDsh) {
    // 首次轮询只建立基线，不把历史未读全部转发（避免刷屏）；需要转发历史可开 forwardBacklog。
    let baselined = false;
    const tick = async () => {
      try {
        const mails = await mailAdapter.listMessages({ unreadOnly: true, limit: 20 });
        if (!baselined) {
          baselined = true;
          if (!cfg.forwardBacklog) return; // 首次不转发历史未读
        }
        for (const m of mails) {
          const text = mailToChatText(m);
          deliver(text);
          // 标记已读默认关闭：避免插件把用户邮箱里的未读信悄悄读完
          if (cfg.markSeenOnForward) await mailAdapter.markSeen(m.id, 'INBOX').catch(() => {});
        }
      } catch (e) {
        ctx.logger?.warn?.('qq-mail poll failed: ' + e.message);
      }
    };
    // 立即跑一次，之后按间隔轮询
    tick();
    pollTimer = ctx.timer.interval(tick, cfg.pollIntervalMs || 60000);
  }

  // ---- 导出可测试 / 可扩展的句柄 ----
  const bridge = {
    /** 覆盖默认的 deliver（生产可换成真正的会话注入实现） */
    setDeliver(fn) {
      deliver = fn;
    },
    /** 把最近一段时间捕获的会话内容汇总成邮件正文 */
    buildDigest(sinceMs = 24 * 3600 * 1000) {
      const cutoff = Date.now() - sinceMs;
      const picked = chatPool.filter((c) => new Date(c.date).getTime() >= cutoff);
      const blocks = picked.map((c) => `[${c.sessionId} · ${c.role}] ${c.text}`);
      const text = blocks.join('\n\n') || '（最近没有新的会话内容）';
      return { subject: '[DSH] 会话定时摘要', text, html: '' };
    },
    /** 手动把一封邮件内容转成会话文本（供外部调用） */
    mailToChat(mail) {
      return mailToChatText(normalizeMail(mail));
    },
    chatToMail(chat) {
      return chatToMailContent(chat);
    },
    getChatPool() {
      return chatPool;
    },
    getInboundQueue() {
      return inboundQueue;
    },
  };

  // 卸载时清理
  const dispose = () => {
    if (pollTimer) ctx.timer.clearInterval?.(pollTimer);
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  };

  return { bridge, dispose };
}
