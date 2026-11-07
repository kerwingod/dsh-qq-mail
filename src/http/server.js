/**
 * 本地 HTTP 桥 —— 浏览器前端（client.js）与真实 Node 后端之间的唯一通道。
 *
 * 为什么需要它：本插件是「静态包」（无 harness），前端在浏览器里跑，
 * 没法调用 host.call，只能通过 fetch 打到本地端口，由这里转调 IMAP/SMTP。
 *
 * 安全：仅监听 127.0.0.1（本机回环），不对外暴露；带 CORS 允许 DSH Web 来源。
 */
import http from 'node:http';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

export function createMailHttpServer({ adapter, port = 32999, logger, getMe, onBind, isBound, getDigest, setDigest } = {}) {
  const log = (...a) => logger?.info?.(a.join(' ')) ?? console.log('[qq-mail-http]', ...a);
  const warn = (...a) => logger?.warn?.(a.join(' ')) ?? console.warn('[qq-mail-http]', ...a);
  // IMAP 断线时前端会一直重试，同一句错误能把 web.err 刷成几千行、拖慢主进程。
  // 同类错误每分钟最多写一条，其余计数汇总；返回给前端的结果不变。
  let lastWarnAt = 0;
  let suppressed = 0;

  const server = http.createServer(async (req, res) => {
    // 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const q = url.searchParams;
    // 请求级超时：IMAP 偶尔会僵死，必须保证 HTTP 一定会返回（否则前端一直“加载中”）。
    let settled = false;
    const guard = setTimeout(() => {
      if (!settled) {
        settled = true;
        json(res, 504, { ok: false, error: '请求超时，邮件服务器响应过慢，请稍后重试' });
      }
    }, 18000);
    const send = (status, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      json(res, status, body);
    };
    try {
      // 健康检查
      if (path === '/api/health' && req.method === 'GET') {
        return send(200, { ok: true, connected: !!adapter?.connected });
      }

      // 当前绑定状态（前端据此决定显示登录页还是主界面）
      if (path === '/api/me' && req.method === 'GET') {
        return send(200, { ok: true, ...(typeof getMe === 'function' ? getMe() : { bound: false, account: '' }) });
      }

      // 绑定 / 重绑邮箱（account + authCode）；连接失败返回 400 并带上原因
      if (path === '/api/bind' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const account = String(body.account || '').trim();
          const authCode = String(body.authCode || '').trim();
          if (!account || !authCode) return send(400, { ok: false, error: '邮箱和授权码都不能为空' });
          const r = await (typeof onBind === 'function'
            ? onBind(account, authCode)
            : Promise.reject(new Error('未配置绑定能力')));
          return send(200, { ok: true, ...(r || {}) });
        } catch (e) {
          return send(400, { ok: false, error: e.message || '绑定失败' });
        }
      }

      // 定时摘要开关（GET 查状态 / POST 设置），放在 403 网关前，面板随时可调（默认关）
      if (path === '/api/digest' && req.method === 'GET') {
        return send(200, {
          ok: true,
          ...(typeof getDigest === 'function'
            ? getDigest()
            : { enabled: false, hour: 21, minute: 0, target: '' }),
        });
      }
      if (path === '/api/digest' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const r = await (typeof setDigest === 'function'
            ? setDigest(body)
            : Promise.reject(new Error('未配置摘要功能')));
          return send(200, { ok: true, ...(r || {}) });
        } catch (e) {
          return send(400, { ok: false, error: e.message || '设置失败' });
        }
      }

      // 未绑定邮箱时，除 health/me/bind/digest 外一律拒绝，避免把 Mock 数据暴露给前端
      if (isBound && !isBound() && path !== '/api/health' && path !== '/api/me' && path !== '/api/bind' && path !== '/api/digest') {
        return send(403, { ok: false, error: '请先在插件面板中绑定 QQ 邮箱' });
      }

      // 文件夹清单（动态：含 QQ 真实的所有文件夹 + 父子层级）
      if (path === '/api/folders' && req.method === 'GET') {
        try {
          const folders = await adapter.listFolders();
          return send(200, { ok: true, folders });
        } catch (e) {
          return send(500, { ok: false, error: e.message });
        }
      }

      // 邮件列表（分页：page + pageSize；默认每页 30，最新在前）
      if (path === '/api/mails' && req.method === 'GET') {
        const folder = q.get('folder') || 'INBOX';
        const page = Math.max(1, Number(q.get('page') || 1));
        const pageSize = Math.min(100, Math.max(1, Number(q.get('pageSize') || 30)));
        const unreadOnly = q.get('unreadOnly') === 'true';
        const since = q.get('since') || undefined;
        const search = q.get('q') || undefined;
        const result = await adapter.listMessages({
          folder,
          page,
          pageSize,
          unreadOnly,
          since: since ? new Date(since) : undefined,
          q: search,
        });
        return send(200, { ok: true, ...result });
      }

      // 单封邮件 + 标记已读
      let m = path.match(/^\/api\/mails\/([^/]+)\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const folder = decodeURIComponent(m[1]);
        const id = decodeURIComponent(m[2]);
        const mail = await adapter.getMessage(id, folder);
        if (!mail) return send(404, { ok: false, error: 'not found' });
        await adapter.markSeen(id, folder).catch(() => {});
        return send(200, { ok: true, mail });
      }

      // 发信
      if (path === '/api/send' && req.method === 'POST') {
        const body = await readBody(req);
        const to = Array.isArray(body.to) ? body.to : [String(body.to || '').trim()].filter(Boolean);
        if (!to.length) return send(400, { ok: false, error: '收件人不能为空' });
        const sent = await adapter.sendMessage({
          to,
          subject: String(body.subject || ''),
          text: String(body.text || ''),
          html: body.html ? String(body.html) : undefined,
        });
        return send(200, { ok: true, mail: sent });
      }

      // 标记已读
      if (path === '/api/seen' && req.method === 'POST') {
        const body = await readBody(req);
        // seen=false 时标为未读（去掉 \Seen）；其余标已读
        await adapter.markSeen(String(body.id), body.folder || 'INBOX', body.seen !== false);
        return send(200, { ok: true });
      }

      // 删除（移到已删除）
      if (path === '/api/delete' && req.method === 'POST') {
        const body = await readBody(req);
        await adapter.deleteMessage(String(body.id), body.folder || 'INBOX');
        return send(200, { ok: true });
      }

      return send(404, { ok: false, error: 'unknown route' });
    } catch (e) {
      const now = Date.now();
      if (now - lastWarnAt > 60000) {
        warn('request failed: ' + e.message + (suppressed ? ` (另有 ${suppressed} 次同类错误已抑制)` : ''));
        lastWarnAt = now;
        suppressed = 0;
      } else {
        suppressed++;
      }
      return send(500, { ok: false, error: e.message });
    }
  });

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          log(`listening on http://127.0.0.1:${port}`);
          resolve();
        });
      });
      return port;
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
      log('server stopped');
    },
  };
}
