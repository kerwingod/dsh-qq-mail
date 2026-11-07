# QQ 邮箱 · DSH 互通插件

> 面向个人自动化用户的 QQ 邮箱收发管理 + DSH 平台消息互传 + 定时会话内容投递到邮箱。
> 基于 QQ 邮箱开放接口（IMAP/SMTP）与 DSH Cordis 插件框架。

---

## 一、功能边界与参数

### 能做 / 不能做

| 能力 | 说明 | 边界 |
| --- | --- | --- |
| 邮件收发 | IMAP 收信 + SMTP 发信（QQ 官方协议） | 仅 QQ 邮箱；需**授权码**而非登录密码 |
| 邮件增删查收 | 列出/读取/标记已读/发送 | “删”为标记已读（避免误删真实邮件）；硬删除未暴露 |
| 消息互传（邮件→DSH） | 轮询收件箱，未读邮件推到 DSH | 受限于 DSH 无“注入任意会话”公开 API，默认进收件队列 + 自定义事件；可换 `deliver` 实现 |
| 消息互传（DSH→邮件） | 监听会话事件，捕获内容供摘要 | 捕获的是会话消息文本，不含富媒体/文件体 |
| 定时会话投递 | 按设定时刻把最近会话汇总发到邮箱 | 默认关闭，面板内可随时一键开/关（状态持久化） |
| **邮件链接可跳转** | 正文/HTML 中的链接在网页邮箱里可点击 | HTML 原样保留 `<a href>`；纯文本也抽出链接，转发时呈可点击形态 |

### 配置参数（`cordis.patch.yml` 的 `config`）

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `account` | `''` | 你的完整 QQ 邮箱地址（也是 IMAP/SMTP 登录名） |
| `imapHost` / `imapPort` / `imapSecure` | `imap.qq.com` / `993` / `true` | 收信服务器 |
| `smtpHost` / `smtpPort` / `smtpSecure` | `smtp.qq.com` / `465` / `true` | 发信服务器 |
| `pollIntervalMs` | `60000` | 轮询新邮件间隔 |
| `forwardInboundToDsh` | `true` | 是否把新邮件推到 DSH |
| `forwardBacklog` | `false` | 首次启动是否转发历史未读（false=只建基线，不刷屏） |
| `markSeenOnForward` | `false` | 转发时是否把邮件标记为已读（默认不改你的未读状态） |
| `scheduledDigestEnabled` | `false` | 定时摘要总开关（离线默认值）；面板里可随时一键开/关，状态持久化 |
| `scheduledDigestHour` / `scheduledDigestMinute` | `21` / `0` | 摘要触发时间 |
| `digestTarget` | `''` | 摘要投递目标，留空用当前绑定的 QQ 邮箱 |

> ⚠️ **授权码绝不写在 config 里**，通过 DSH 的 credentials 服务注入，
> ref 名必须是 POSIX 标识符：**`QQ_MAIL_AUTH_CODE`**（存于 `$DSH_HOME/.credentials.yaml` 的 `refs` 下）。
> 若未配置授权码，插件自动降级为 Mock 适配器，保证能加载、能跑测试。

**依赖**：真实收发需要 `imapflow`（IMAP）、`nodemailer`（SMTP）、`mailparser`（解析）。
在插件目录执行：

```bash
npm install imapflow nodemailer mailparser --registry=https://registry.npmmirror.com/
```

---

## 二、模块结构

```
qq-mail-dsh-plugin/
├── index.js                 # 主入口：组装四模块 + 降级策略
├── cordis.patch.yml         # 插件清单（id / config / 启动）
├── package.json
├── locale/zh.json,en.json   # 显示名与简介
├── icon.svg
├── src/
│   ├── schema.js            # 模块三：双向同步 Schema + 链接提取
│   ├── mail/
│   │   ├── adapter.js       # 模块二：真实 IMAP/SMTP 适配器
│   │   └── mock.js          # 测试用内存 Mock 适配器
│   ├── dsh-bridge.js        # 模块三：DSH 适配（工具/事件/轮询）
│   └── scheduler.js         # 模块四：定时任务
└── tests/                   # 单元 + 集成测试（node --test，零依赖）
```

---

## 三、关键实现（代码逻辑片段 + 中文注释）

### 1) 邮件核心：真实 IMAP 收信（节选自 `src/mail/adapter.js`）

```js
async listMessages(opts = {}) {
  if (!this._connected) await this.connect();
  const out = [];
  // 锁定收件箱，顺序读取每封邮件的源码再解析
  let lock = await this._imap.getMailboxLock('INBOX');
  try {
    const query = opts.unreadOnly ? { seen: false } : {};
    const uids = (await this._imap.search(query, { uid: true })) || [];
    const picked = opts.limit ? uids.slice(-opts.limit) : uids; // 只取最近 N 封
    for (const uid of picked) {
      // 关键：uid 必须放在 options（第三个参数）；放进 query 会取不到邮件
      const msg = await this._imap.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && msg.source) out.push(await parseSource(msg.source, uid)); // id 统一用 UID
    }
  } finally {
    lock.release(); // 无论成败都释放锁，避免死锁
  }
  return out;
}
```

### 2) 双向 Schema：保证邮件链接可跳转（节选自 `src/schema.js`）

```js
// 邮件 -> 会话：纯文本里的链接原样保留，收件端会自动识别成可点击
export function mailToChatText(mail) {
  const links = mail.links.length
    ? '\n\n相关链接：\n' + mail.links.map((l) => `- ${l}`).join('\n')
    : '';
  return `📧 新邮件来自 ${mail.from.map(f=>f.address).join(', ')}\n主题：${mail.subject}\n\n${mail.text||''}${links}`;
}

// 会话 -> 邮件：HTML 正文里把 http(s) 链接替换成 <a href>，保证网页邮箱可点
const safeText = escapeHtml(chat.text).replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) =>
  `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
```

### 3) DSH 适配：注册工具 + 轮询收件箱（节选自 `src/dsh-bridge.js`）

```js
// 把“发邮件”暴露成 DSH 工具，会话里直接调用
ctx.tools.register({
  name: 'qqmail_send',
  description: '通过 QQ 邮箱发送邮件（链接可点击）',
  parameters: { type:'object', properties:{
    to:{type:'array',items:{type:'string'}}, subject:{type:'string'}, text:{type:'string'},
  }, required:['to','subject','text'] },
  async execute(args){ const m = await mailAdapter.sendMessage(args); return {ok:true, messageId:m.id}; },
});

// 轮询收件箱，未读邮件推到 DSH
const tick = async () => {
  const mails = await mailAdapter.listMessages({ unreadOnly: true });
  for (const m of mails) { deliver(mailToChatText(m)); await mailAdapter.markSeen(m.id); }
};
tick();
pollTimer = ctx.timer.interval(tick, cfg.pollIntervalMs);
```

### 4) 定时任务：到点把最近会话汇总发邮件（节选自 `src/scheduler.js`）

```js
_arm(task) {
  if (!task.enabled) return;
  const delay = this.msUntilNext(task.hour, task.minute, this.now()); // 计算到下一次触发的毫秒
  const handle = this.schedule(() => {
    if (this._onFire) this._onFire(task); // 触发：汇总并投递
    this._arm(task);                      // 安排下一次
  }, delay);
  this._timers.set(task.id, handle);
}
```

---

## 四、使用示例（纯文本描述，开箱即用）

### 初始化（首次使用）

1. **安装插件**：通过npm官方源搜索 `dsh-qq-mail@0.2.0`一键安装，「Open Plugin Market」正在上架中，同样可搜索名称一键安装；
   或 `plugin_manager install_bundle`，target 传本插件目录绝对路径
   （若 profile 依赖树解析失败装不上，见文末「本机安装记录」的手动挂载法）。
2. **面板登录绑定（核心）**：打开 DSH 左侧「QQ 邮箱」面板，未绑定会直接进入绑定页：
   - 填 **QQ 邮箱**（如 `123@qq.com`）和**授权码**（注意是授权码，不是邮箱登录密码）。
   - 点「绑定并进入」→ 后端用新凭据直连 QQ 邮箱，**连接成功即进入主界面**。
   - 绑定信息持久化到 `$DSH_HOME/qq-mail-dsh/state.json`，下次打开自动登录，无需重填。
   - 「如何获取授权码？」折叠里一步一步写了，照着点就行。
3. **（可选，老用户）凭据服务兜底**：若你之前已在 `$DSH_HOME/.credentials.yaml` 的 `refs`
   下写过 `QQ_MAIL_ACCOUNT` / `QQ_MAIL_AUTH_CODE`，插件也会自动读取并跳过绑定页。
   优先级：**state.json > cordis.patch.yml 的 `account` > credentials 服务 > 环境变量**。
4. 验证：`qqmail_list` 能列出真实邮件、`qqmail_send` 返回真实 messageId。

> 如何获取授权码（QQ 邮箱网页端 mail.qq.com）：设置 → 账户 → 开启「IMAP/SMTP 服务」→
> 按提示用手机发短信验证 → 点「生成授权码」，复制那串 16 位字符。

### 消息互传操作

- **DSH → 邮箱**：在 DSH 会话里让助手调用 `qqmail_send`，例如
  “把刚才的总结发邮件给 friend@qq.com，主题‘周报’”。
- **邮箱 → DSH**：插件每 `pollIntervalMs` 轮询一次，未读邮件自动转成会话文本推入收件队列
  （可用 `qqmail_inbound_queue` 工具查看），邮件里的链接以可点击形态呈现。
- **定时投递（默认关闭，面板随时开关）**：主界面顶部有一个「定时会话投递」开关，
  打开后每天 `scheduledDigestHour:scheduledDigestMinute`（默认 21:00）会把最近 24 小时捕获的
  会话内容汇总成邮件，发到当前绑定的 QQ 邮箱（或 `digestTarget`）。开关状态持久化到
  `state.json`，重启后保持。没有新会话内容 / 尚未绑定邮箱时自动跳过，不会发空邮件。

### 运行测试

```bash
cd qq-mail-dsh-plugin
node --test        # 12 项用例全绿：收发/查信/链接提取/定时精度/消息互传
```

---

## 五、已知边界（如实告知）

- DSH 当前没有“向已有会话注入一条消息”的公开 API，故「邮件→DSH」默认走
  收件队列 + 自定义事件 `qq-mail/inbound`。如需真正进入某个会话，替换
  `setupDshBridge` 里的 `deliver` 实现（接通知/插槽/subagent 消息）即可，接口不变。
- 真实 IMAP/SMTP 依赖 `imapflow` / `nodemailer` / `mailparser`；未安装或离线时自动降级 Mock，
  保证插件可加载。
- “删邮件”仅实现标记已读，未暴露硬删除，避免误删真实邮件。
- **不会动你的未读状态**：`markSeenOnForward` 默认 `false`；首次启动只建立基线，
  不把历史未读邮件一次性转发（要转发历史就开 `forwardBacklog`）。
- 定时器本身是**内存存储**（进程重启后由 `index.js` 按 `state.json` 里的 `digestEnabled`
  重新登记）；开关状态持久化在 `state.json`，启动即恢复，无需重新配。
- **面板「写信」已移除**：右上角原写信表单在 DSH Web 面板里无法稳定输入/发送，
  故改为移除该功能栏。需要发邮件请用会话里的 `qqmail_send` 工具
  （如「把总结发邮件给 friend@qq.com，主题‘周报’」）。

---

## 六、DSH 插件契约（踩坑记录，重装必看）

写 Host 插件时，下面两条不满足会在 mount 阶段直接 `fiberPhase: failed`：

### 1) 访问任何服务前必须在 `inject` 里声明

```js
// 不声明就访问 ctx.tools / ctx.timer / ctx.credentials 会抛：
// "cannot get property \"tools\" without inject"
export const inject = ['tools', 'timer', 'credentials'];
```

### 2) 每个 Tool 必须声明 `output: { schema, render }`

```js
ctx.tools.register({
  name: 'qqmail_send',
  parameters: { /* ... */ },
  // 缺这个字段会报：tool "qqmail_send" must declare output { schema, render, presentationMeta? }
  output: {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: `已发送，messageId: ${value.messageId}` }];
    },
  },
  async execute(args) { /* ... */ },
});
```

> 另外：`export const apply` 与 `export default apply` **不要混用**，二选一。

---

## 七、本机安装记录（绕过 pnpm）

本机「DSH懒人版」的 `profiles/web` 依赖树在公共镜像上解析不出来
（`ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-settings`），
`install_bundle` 会先卡在整份 profile 的 `pnpm install` 上，轮不到装本插件。
因此本机改用**目录挂载**（与 profile 里 `dafeiyu-suite`、`dsh-pet` 的 `link:` 同款做法）：

```powershell
# 1) 在 profile 的 node_modules 下建 junction（管理员或开发者模式）
$dst = "E:\HarnessAI\home\profiles\web\node_modules\@local"
New-Item -ItemType Directory -Path $dst -Force
New-Item -ItemType Junction -Path "$dst\qq-mail-dsh" `
  -Target "E:\HarnessAI\work\work\qq-mail-dsh-plugin"
```

```yaml
# 2) 追加到 E:\HarnessAI\home\profiles\web\cordis.patch.yml
- insert:
    - id: qq-mail-dsh
      name: '@local/qq-mail-dsh'
      config:
        account: ''          # 填你的 QQ 邮箱
        pollIntervalMs: 60000
        forwardInboundToDsh: true
```

```text
3) 重载插件行（二选一）：
   - 调用 plugin_manager set_plugin 先 false 再 true（会重新 import 模块）
   - 或重启 DSH
4) 验证：cordis_inspect_query Tool.listTools 里应出现 qqmail_*，
   且 plugin_manager list_plugins 里该行 fiberPhase = active。
```

实测结果：4 个工具全部注册成功，`qqmail_list` / `qqmail_inbound_queue` / `qqmail_send` 均可调用。

---

## 八、其他信息

本插件是标准 DSH Cordis 静态插件，`package.json` 已声明 `dsh.bundle.patch` 与
`dsh.client` 钩子、`locale/*.json` 含 `meta.title/description`、`icon.svg` 就绪，
打包后即可发布。

> 发布前自检清单：
> - `package.json` 的 `version` 已递增（当前 `0.2.0`）；
> - `locale/zh.json`、`locale/en.json` 的 `meta.title` + `meta.description` 已填（管理器不激活也能读）；
> - `icon.svg` 体积 ≤ 256KiB；
> - 根目录不留开发残留（已清理 `.cordis.patch.yml.bak` / `diag-*.mjs` / `local-smoke.js` /
>   `src/http/server.js.bak-*`）；
> - 不含明文凭据、`.credentials.yaml`、`node_modules` 不进包。

