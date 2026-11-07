/**
 * 集成测试：DSH 桥接（轮询收件箱 -> 推送到 DSH 收件队列）+ 定时摘要投递。
 * 用最小 ctx 桩 + Mock 适配器，模拟 DSH 监听/工具/定时器，验证“消息互传”链路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMailAdapter } from '../src/mail/mock.js';
import { setupDshBridge } from '../src/dsh-bridge.js';
import { SessionDigestScheduler } from '../src/scheduler.js';

/** 构造一个最小 DSH ctx 桩，仅包含本插件用到的成员。 */
function makeCtx() {
  const timers = [];
  return {
    logger: { info() {}, warn() {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    emit() {},
    timer: {
      interval: (fn, ms) => {
        const h = setInterval(fn, ms);
        timers.push(h);
        return h;
      },
      clearInterval: (h) => clearInterval(h),
    },
    _timers: timers,
  };
}

test('轮询收件箱：未读邮件被投递到 DSH 收件队列', async () => {
  const ctx = makeCtx();
  const adapter = new MockMailAdapter({ account: 'me@qq.com' });
  await adapter.connect();
  adapter.seed({
    id: 'inc1',
    from: [{ address: 'boss@qq.com' }],
    subject: '会议',
    text: '明早九点开会 https://meeting.qq.com/room',
  });

  const { bridge, dispose } = setupDshBridge(ctx, { forwardInboundToDsh: true, pollIntervalMs: 10 }, adapter);
  // 等待轮询 tick（setupDshBridge 启动时会立即 tick 一次）
  await new Promise((r) => setTimeout(r, 30));
  const q = bridge.getInboundQueue();
  assert.ok(q.length >= 1, '至少应投递一封邮件到 DSH');
  assert.match(q[0].text, /会议/);
  assert.match(q[0].text, /https:\/\/meeting\.qq\.com\/room/);
  dispose();
});

test('捕获会话事件：会话消息进入摘要池', () => {
  const ctx = makeCtx();
  // 覆写 on 以捕获订阅，并手动回放事件
  let handler;
  ctx.on = (name, fn) => {
    handler = fn;
    return () => {};
  };
  const adapter = new MockMailAdapter({ account: 'me@qq.com' });
  const { bridge, dispose } = setupDshBridge(ctx, { forwardInboundToDsh: false }, adapter);
  handler({ type: 'assistant/message', sessionId: 's9', message: { role: 'assistant', text: '已为你写好了代码' } });
  const pool = bridge.getChatPool();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].sessionId, 's9');
  assert.match(pool[0].text, /写好了代码/);
  dispose();
});

test('定时摘要：把会话池汇总并发到邮箱', async () => {
  const ctx = makeCtx();
  let handler;
  ctx.on = (name, fn) => {
    handler = fn;
    return () => {};
  };
  const adapter = new MockMailAdapter({ account: 'me@qq.com' });
  const { bridge, dispose } = setupDshBridge(ctx, { forwardInboundToDsh: false }, adapter);
  handler({ type: 'user/message', sessionId: 's1', message: { role: 'user', text: '帮我查天气' } });
  handler({ type: 'assistant/message', sessionId: 's1', message: { role: 'assistant', text: '晴，25度' } });

  const scheduler = new SessionDigestScheduler({
    now: () => Date.now(),
    schedule: (fn) => () => {
      /* 测试桩：不自动触发，由下方手动调用 _onFire 验证投递逻辑 */
    },
  });
  scheduler.onFire(async (task) => {
    const digest = bridge.buildDigest();
    await adapter.sendMessage({ to: [task.target], subject: digest.subject, text: digest.text });
  });
  // 立即 fire 一次（不走时钟）
  await scheduler.upsert({ id: 'd', hour: 0, minute: 0, target: 'me@qq.com', enabled: true });
  scheduler._onFire({ id: 'd', target: 'me@qq.com' });
  await new Promise((r) => setTimeout(r, 10));
  const sent = adapter.sentBox();
  assert.ok(sent.length >= 1);
  assert.match(sent[0].text, /帮我查天气/);
  assert.match(sent[0].text, /晴，25度/);
  dispose();
  scheduler.dispose(); // 清理调度定时器，避免进程挂起
});
