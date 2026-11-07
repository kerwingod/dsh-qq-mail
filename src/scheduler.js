/**
 * 定时任务模块
 * ---------------------------------------------------------------
 * 负责：把“最近一段时间的 DSH 会话内容”按设定的时刻汇总成邮件投递到邮箱。
 *
 * 设计取舍（先可运行，再优化）：
 *  - 调度逻辑与真实定时器解耦：构造时注入 `schedule(fn, delayMs)` 与
 *    `now()`，默认用 setTimeout / Date；测试时换成可控实现，精准验证定时。
 *  - 任务配置持久化到 Storage（传入的 storage 实现），重启后可恢复。
 */

/**
 * @typedef {Object} DigestTask
 * @property {string} id
 * @property {number} hour        触发小时 0-23
 * @property {number} minute      触发分钟 0-59
 * @property {string} [target]    投递邮箱；空则用插件账号
 * @property {string} [sessionId] 仅汇总该会话；空则汇总全部
 * @property {boolean} enabled
 */

/**
 * @param {object} deps
 * @param {() => number} [deps.now]            返回当前毫秒时间戳（默认 Date.now）
 * @param {(fn:()=>void, ms:number)=>()=>void} [deps.schedule] 返回取消函数（默认 setTimeout 包装）
 * @param {{get:()=>Promise<DigestTask[]>, set:(t:DigestTask[])=>Promise<void>}} [deps.storage]
 */
export class SessionDigestScheduler {
  constructor(deps = {}) {
    this.now = deps.now || (() => Date.now());
    this.schedule = deps.schedule || ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.storage = deps.storage || memoryStorage();
    /** @type {DigestTask[]} */
    this.tasks = [];
    /** @type {Map<string, ()=>void>} 任务 id -> 取消函数 */
    this._timers = new Map();
  }

  /** 计算下一次触发距离现在的毫秒数（用于验证精度）。 */
  msUntilNext(hour, minute, fromMs) {
    const from = new Date(fromMs);
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - from.getTime();
  }

  async load() {
    this.tasks = (await this.storage.get()) || [];
    return this.tasks;
  }

  /** 注册/更新任务，并立即安排下一次触发。 */
  async upsert(task) {
    const idx = this.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) this.tasks[idx] = task;
    else this.tasks.push(task);
    await this.storage.set(this.tasks);
    this._arm(task);
    return task;
  }

  /** 安排单次定时器（到点回调 onFire）。 */
  _arm(task) {
    if (!task.enabled) return;
    const cancel = this._timers.get(task.id);
    if (cancel) cancel();
    const delay = this.msUntilNext(task.hour, task.minute, this.now());
    const handle = this.schedule(() => {
      // 触发：调用外部注入的投递逻辑，然后安排下一次
      if (this._onFire) this._onFire(task);
      this._arm(task);
    }, delay);
    this._timers.set(task.id, handle);
  }

  /** 设置触发回调：参数为任务定义。 */
  onFire(fn) {
    this._onFire = fn;
  }

  /** 取消所有定时器（插件卸载时调用）。 */
  dispose() {
    for (const cancel of this._timers.values()) cancel();
    this._timers.clear();
  }
}

/** 默认的内存存储（生产可替换为 DSH Storage 实现）。 */
function memoryStorage() {
  let data = [];
  return {
    get: async () => data,
    set: async (t) => {
      data = t;
    },
  };
}
