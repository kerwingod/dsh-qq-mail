/**
 * QQ 邮箱 · DSH 互通 插件主入口
 * ---------------------------------------------------------------
 * 组装四模块：插件配置（来自 cordis.patch.yml）、邮件核心（IMAP/SMTP）、
 * dsh 适配（工具/事件/轮询）、定时任务（会话摘要投递）。
 *
 * 运行策略（先保证可运行）：
 *  - 授权码从 credentials 服务读取，绝不写进 config 明文。
 *  - 有授权码 + 依赖可用 → 真实 QQMailAdapter；否则自动降级到 Mock，
 *    保证插件在“没配邮箱 / 没装依赖 / 离线”时依然能加载、能跑测试。
 *  - 任何外部调用失败都被包裹，不会拖垮整个宿主。
 *
 * @param {object} ctx  DSH Cordis 上下文
 * @param {object} cfg  插件配置
 * @returns {Promise<() => void>} 卸载函数
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQMailAdapter } from './src/mail/adapter.js';
import { MockMailAdapter } from './src/mail/mock.js';
import { setupDshBridge } from './src/dsh-bridge.js';
import { SessionDigestScheduler } from './src/scheduler.js';
import { createMailHttpServer } from './src/http/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 前端（client.js）固定访问的本地桥端口；与 package.json / client.js 保持一致。 */
const HTTP_PORT = 32999;

/**
 * Cordis 要求：访问任何服务（tools/timer/credentials/storage）前必须在此声明，
 * 否则访问 ctx.xxx 会直接抛 "cannot get property ... without inject"。
 */
export const inject = ['tools', 'timer', 'credentials'];

export async function apply(ctx, cfg = {}) {
  const config = {
    account: '',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    pollIntervalMs: 60000,
    forwardInboundToDsh: true,
    forwardBacklog: false,
    markSeenOnForward: false,
    scheduledDigestEnabled: false,
    scheduledDigestHour: 21,
    scheduledDigestMinute: 0,
    digestTarget: '',
    ...cfg,
  };

  // 1) 绑定持久化：state.json 优先（前端 /api/bind 写入），其次 cordis.patch.yml 的 account，
  //    再其次 credentials 服务（已有的用户凭据），最后环境变量。授权码同优先级。
  //    这样老用户（凭据已在 credentials 里）无需重新绑定即可直接用。
  const dataDir = path.join(process.env.DSH_HOME || __dirname, 'qq-mail-dsh');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
  const stateFile = path.join(dataDir, 'state.json');
  const loadState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8') || '{}'); } catch { return {}; }
  };
  const saveState = (s) => {
    try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  };

  let resolvedAccount = '';
  try { const r = await ctx.credentials.resolve('QQ_MAIL_ACCOUNT'); resolvedAccount = r?.value || ''; } catch { /* ignore */ }
  let authCode = '';
  try { const r = await ctx.credentials.resolve('QQ_MAIL_AUTH_CODE'); authCode = r?.value || ''; } catch { /* ignore */ }
  if (!authCode) authCode = process.env.QQ_MAIL_AUTH_CODE || '';

  const saved = loadState();
  const account = saved.account || config.account || resolvedAccount || '';
  authCode = saved.authCode || authCode;
  const useReal = !!(authCode && account);

  // 2) 选适配器：有授权码就尝试真实实现，否则内存 Mock。
  //    state.adapter 是“当前生效的”适配器；绑定切换时整块替换（见 onBind）。
  const state = { adapter: null, bound: false, account };
  let initial;
  if (useReal) {
    try {
      initial = new QQMailAdapter({ ...config, account, authCode });
      await initial.connect(); // 试连一次，失败则降级
    } catch (e) {
      ctx.logger?.warn?.('QQ 邮箱真实连接失败，降级为 Mock 适配器：' + e.message);
      initial = new MockMailAdapter({ account: account || 'demo@qq.com' });
    }
  } else {
    initial = new MockMailAdapter({ account: account || 'demo@qq.com' });
  }
  state.adapter = initial;
  state.bound = initial instanceof QQMailAdapter;

  // 始终通过 liveAdapter 代理访问邮箱：绑定切换时只换 state.adapter，
  // 而 bridge / httpServer / scheduler 持有的引用不变，自然用上新适配器。
  const liveAdapter = new Proxy({}, {
    get(_t, prop) {
      const a = state.adapter;
      if (!a) return undefined;
      const v = a[prop];
      return typeof v === 'function' ? (...args) => v.apply(a, args) : v;
    },
    set(_t, prop, val) {
      const a = state.adapter;
      if (a) a[prop] = val;
      return true;
    },
  });

  // 3) dsh 适配：注册工具 + 监听会话 + 轮询收件箱（通过 liveAdapter 代理，绑定切换自动生效）
  const { bridge, dispose: disposeBridge } = setupDshBridge(ctx, config, liveAdapter);

  // 3.5) 本地 HTTP 桥：让浏览器前端（client.js）能调真实邮箱。
  //      仅本机回环监听，跨域（CORS）放行 DSH Web 来源。
  const httpServer = createMailHttpServer({
    adapter: liveAdapter, // 兼容内部 adapter?.connected 等只读访问
    port: HTTP_PORT,
    logger: ctx.logger,
    getMe: () => ({ bound: state.bound, account: state.account }),
    isBound: () => state.bound,
    onBind: async (account, authCode) => {
      // 先用新凭据建连，失败直接抛错（前端显示 400 + 原因），不污染现有状态
      const candidate = new QQMailAdapter({ ...config, account, authCode });
      await candidate.connect();
      try { state.adapter?.disconnect?.(); } catch { /* ignore */ }
      state.adapter = candidate;
      state.account = account;
      state.bound = true;
      saveState({ account, authCode });
      // 尽量同步进 credentials 服务（各版本 API 可能不同，失败不致命）
      try {
        await ctx.credentials.set?.('QQ_MAIL_ACCOUNT', account);
        await ctx.credentials.set?.('QQ_MAIL_AUTH_CODE', authCode);
      } catch { /* ignore */ }
      return { bound: true, account };
    },
    // 定时摘要开关：用户在面板里随时开/关，状态持久化到 state.json。
    getDigest: () => {
      const s = loadState();
      return {
        enabled: s.digestEnabled === true,
        hour: s.digestHour || config.scheduledDigestHour,
        minute: s.digestMinute || config.scheduledDigestMinute,
        target: s.digestTarget || '',
      };
    },
    setDigest: async (patch = {}) => {
      const cur = loadState();
      // 前端以 enabled/hour/minute/target 传参，这里映射到 state.json 的存储字段
      const next = {
        ...cur,
        digestEnabled: patch.enabled !== undefined ? !!patch.enabled : cur.digestEnabled,
        digestHour: patch.hour !== undefined ? patch.hour : cur.digestHour,
        digestMinute: patch.minute !== undefined ? patch.minute : cur.digestMinute,
        digestTarget: patch.target !== undefined ? patch.target : cur.digestTarget,
      };
      await scheduler.upsert({
        id: 'default-digest',
        hour: next.digestHour || config.scheduledDigestHour,
        minute: next.digestMinute || config.scheduledDigestMinute,
        target: next.digestTarget || state.account || config.account,
        enabled: !!next.digestEnabled,
      });
      saveState(next);
      return {
        enabled: !!next.digestEnabled,
        hour: next.digestHour || config.scheduledDigestHour,
        minute: next.digestMinute || config.scheduledDigestMinute,
        target: next.digestTarget || '',
      };
    },
  });
  await httpServer.start();

  // 4) 定时摘要：到点把最近会话内容发到邮箱
  //    先用内存存储（保证可运行）；DSH storage 服务各版本形态不一，
  //    接入前宁可降级也不要让 mount 失败。
  const scheduler = new SessionDigestScheduler({ now: () => Date.now() });
  scheduler.onFire(async (task) => {
    try {
      const digest = bridge.buildDigest();
      // 没有捕获到会话内容就不发空邮件，免得每天收到一封“（最近没有新的会话内容）”
      if (digest.text === '（最近没有新的会话内容）') return;
      // 收件人动态解析：绑定页可能是在插件启动之后才绑定的，
      // 真实账号存在 state.account（config.account 在 patch 里是空串），故优先取它。
      const target = task.target || state.account || config.account || config.digestTarget;
      if (!target) {
        ctx.logger?.warn?.('定时摘要跳过：尚未绑定 QQ 邮箱');
        return;
      }
      await liveAdapter.sendMessage({
        to: [target],
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
      });
      ctx.logger?.info?.('[qq-mail-dsh] 定时会话摘要已投递到 ' + target);
    } catch (e) {
      ctx.logger?.warn?.('定时摘要投递失败：' + e.message);
    }
  });
  await scheduler.load();
  // 定时摘要默认关闭：是否开启完全由用户在面板里随时切换，并持久化到 state.json，
  // 因此启动时按 state.json 里保存的 digestEnabled 决定是否注册定时器。
  if (saved.digestEnabled === true) {
    await scheduler.upsert({
      id: 'default-digest',
      hour: saved.digestHour || config.scheduledDigestHour,
      minute: saved.digestMinute || config.scheduledDigestMinute,
      target: config.digestTarget || state.account || config.account,
      enabled: true,
    });
  }

  ctx.logger?.info?.(
    `[qq-mail-dsh] 已启动（模式：${useReal ? '真实QQ邮箱' : 'Mock'}；定时摘要：${
      saved.digestEnabled ? '开' : '关'
    }）`,
  );

  // 卸载清理
  return () => {
    try {
      httpServer.stop();
      disposeBridge();
      scheduler.dispose();
      state.adapter?.disconnect?.();
    } catch {
      /* ignore */
    }
  };
}
