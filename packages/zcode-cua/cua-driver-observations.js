/**
 * 观察记录注册表：把每次观察钉成一份**不可跨窗口、不可跨会话**复用的快照。
 *
 * PRD FR-04 的要求，逐条落到结构上：
 * - 每份观察有 `stateId`（驱动签发，模型不可伪造）、`seq`（本进程捕获序号）与
 *   `capturedAt`，并绑定 host/会话 generation/进程/窗口。
 * - 键是 (sessionKey, appKey, windowId)：**同一应用的不同窗口各有自己的元素表**。
 *   CE 参考实现的键只到 (session, app)，多窗口会话里 A 窗口的索引能解析到 B 窗口的
 *   控件上 —— 那正是 AC-07 要拦的事故。
 * - 记录里保留坐标变换所需的全部事实：窗口 bounds、截图宽高/缩放/mime、元素 frame。
 * - `maxEntries` 上限 + 会话维度整体失效：缓存不能无限增长，也不能比会话活得更久。
 *
 * 这个模块只做存储与查询，不做策略判断（策略在 cua-driver-targets.js 与运行时里）。
 */
const DEFAULT_MAX_ENTRIES = 64;
export function createObservationRegistry(options = {}) {
  const now = options.now ?? (() => Date.now());
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const records = new Map();
  let seq = 0;
  const expireOldest = () => {
    while (records.size > maxEntries) {
      const oldestKey = records.keys().next().value;
      if (oldestKey === undefined) break;
      records.delete(oldestKey);
    }
  };
  return {
    get size() {
      return records.size;
    },
    record(input) {
      seq += 1;
      const entry = {
        ...input,
        key: input.key,
        seq,
        capturedAt: now(),
      };
      // Map 保序：重设同一键会把它移到末尾，于是「最旧」天然是队首。
      records.set(entry.key, entry);
      expireOldest();
      return entry;
    },
    get(key) {
      return records.get(key);
    },
    /** 该会话最近一次观察（诊断与「当前盯着的窗口」展示用）。 */
    latestForSession(sessionKey) {
      let latest;
      for (const entry of records.values()) {
        if (entry.sessionKey !== sessionKey) continue;
        if (!latest || entry.seq > latest.seq) latest = entry;
      }
      return latest;
    },
    drop(key) {
      records.delete(key);
    },
    dropSession(sessionKey) {
      const prefix = `${sessionKey}|`;
      // 先收集再删除：显式两段式，避免「边遍历边改 Map」的读法歧义。
      const doomed = [];
      for (const key of records.keys()) {
        if (key.startsWith(prefix)) doomed.push(key);
      }
      for (const key of doomed) records.delete(key);
      return doomed.length;
    },
    /** 进程/窗口生命周期失效：进程退出或窗口消失时丢掉它的全部记录。 */
    dropProcess(sessionKey, pid) {
      const doomed = [];
      for (const [key, entry] of records.entries()) {
        if (entry.sessionKey === sessionKey && entry.pid === pid) doomed.push(key);
      }
      for (const key of doomed) records.delete(key);
      return doomed.length;
    },
    clear() {
      records.clear();
    },
    /** 诊断快照（不含元素全表，避免把 AX 树写进日志）。 */
    summarize() {
      return [...records.values()].map((entry) => ({
        seq: entry.seq,
        stateId: entry.stateId ?? null,
        sessionKey: entry.sessionKey,
        appKey: entry.appKey,
        windowId: entry.windowId,
        pid: entry.pid,
        elementCount: entry.elementCount,
        degraded: entry.degraded,
        capturedAt: new Date(entry.capturedAt).toISOString(),
      }));
    },
  };
}
