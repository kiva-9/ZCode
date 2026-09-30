/**
 * Computer Use 运行时：把 ZCode 的 CUA broker 协议适配到 MIT 许可的
 * `@trycua/cua-driver@0.28.2`（Rust 原生 SDK，六平台预编译二进制）。
 *
 * 为什么需要这一层：两侧的接口面**不同构**，不能直接转发。
 * - ZCode 的模型可见面是 capability method（computer-use-client.mjs 的
 *   COMPUTER_METHOD_NAMES），按 Codex 的 `cua` 形状定义：`app_ref` 定位应用、
 *   `target` 定位元素/坐标、观察结果回传 `state_id` 与元素表。
 * - cua-driver 的工具面是 55 个 MCP 风格工具，按 `pid` + `window_id` 定位窗口，
 *   元素必须带 `element_token`（或 snapshot_id + element_index）才允许点击。
 * 所以这里是**协议翻译 + 边界执行**：应用名 → pid、窗口解析、元素索引 → element_token、
 * 观察结果 → state_id、驱动错误码 → broker 错误码。目标解析在 ./cua-driver-targets.js，
 * 方法实现在 ./cua-driver-methods.js，错误与信封在 ./cua-driver-errors.js。
 *
 * 三条安全语义（来自 PRD §4.2 / §7.3，不可协商）：
 * 1. 后台投递优先。**拒绝不代表可以改用前台重投** —— 适配层从不主动传
 *    `delivery_mode: "foreground"`；驱动返回 background_unavailable 时映射成
 *    FOREGROUND_REQUIRED 交给模型，由用户决定，而不是我们替它升级。
 * 2. 动作下发成功 ≠ 结果达成。收据里的 `delivery`/`effect` 原样带出去，
 *    并由 `cua.verification` 单独记录「有没有新证据」。
 * 3. 取消后已完成的输入不会回滚：`action_sent` 只在收据明确说下发过时才置 true，
 *    投递未知时是 `unknown`，绝不坍缩成 `not_sent`。
 *
 * 执行顺序（PRD §7.3）在 execute() 里逐条落实；停止检查出现两次：
 * 进函数一次、**下发前再一次** —— 中间的目标解析可能耗去整个用户耐心。
 */
import {
  CuaBrokerError,
  errorResult,
  readDriverEnvelope,
  refusalOf,
  brokerCodeForDriverCode,
  actionDelivered,
} from "./cua-driver-errors.js";
import { CUA_ACTIONS, DELIBERATELY_UNAVAILABLE_METHODS } from "./cua-driver-actions.js";
import { createCuaMethods } from "./cua-driver-methods.js";
import { createObservationRegistry } from "./cua-driver-observations.js";
import { createDesktopControlLease } from "./cua-driver-lease.js";
import { CUA_METHOD_CLASS, assertNoHardBlock, classifyCuaMethod } from "./cua-capability-policy.js";
import { CUA_DRIVER_SUPPORTED_PLATFORMS } from "./cua-driver-capabilities.js";
/**
 * 驱动在 KDE/GNOME Wayland 会话下默认关闭原生 Wayland 后端（上游标为 experimental），
 * 关闭时 `list_windows` 恒返回 0 行 —— Computer Use 直接不可用。我们只在**用户没表态**
 * 且检测到 Wayland 会话时打开它。这是驱动自己的开关，不是 ZCode 的环境变量约定。
 */
const WAYLAND_ENABLE_ENV = "CUA_DRIVER_RS_ENABLE_WAYLAND";
/** 需要桌面控制租约的 method：观察窗口内容与一切动作。 */
const LEASE_REQUIRED_METHODS = new Set(["get_app_state", ...Object.keys(CUA_ACTIONS)]);
/** 能力表对外可见的 method 名（供宿主、客户端与测试对齐）。 */
export const CUA_METHOD_NAMES = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "request_access",
  "get_capabilities",
  "get_diagnostics",
  "stop_computer_control",
  ...Object.keys(CUA_ACTIONS),
  ...DELIBERATELY_UNAVAILABLE_METHODS,
]);

export function createCuaDriverRuntime(options = {}) {
  const loadDriver =
    options.loadDriver ??
    (async () => {
      if (!process.env[WAYLAND_ENABLE_ENV] && process.env.WAYLAND_DISPLAY) {
        process.env[WAYLAND_ENABLE_ENV] = "1";
      }
      // 直接内联包名：knip 的静态分析只认字面量 specifier，抽成变量会被判成未使用依赖。
      const mod = await import("@trycua/cua-driver");
      return mod.CuaDriver.create(undefined);
    });
  let driverPromise;
  let driverInstance;
  let disposed = false;
  let driverSource = options.loadDriver ? "test-injection" : "not-loaded";
  /** 运行时生命周期信号：dispose() 时 abort，取消在途的原生调用。 */
  const lifetime = new AbortController();
  /** 串行化驱动调用：原生句柄不保证可重入。 */
  let queue = Promise.resolve();
  /** (会话, 应用, 窗口) 的观察记录；跨窗口/跨会话不复用。 */
  const observations = createObservationRegistry();
  /**
   * 已被 stop_computer_control 关闭的 session。
   *
   * kill switch 必须在**会话生命周期内**持续生效：PRD 要求「停止后本会话的新调用一律
   * 被拒绝，自动重连、驱动 TTL 到期恢复、REPL reset、再次执行一个 cell 都不能恢复权限」。
   * 如果 stop 之后的下一次调用悄悄重建隐式会话，模型只要再发一个 cell 就能继续操作桌面 ——
   * 那等于没有 kill switch。这里把它钉到会话结束（closeSession）为止。
   */
  const stoppedSessions = new Set();
  /** 每个会话的桌面控制租约（跨进程文件锁）。 */
  const leases = new Map();
  const stats = {
    driverCalls: 0,
    observations: 0,
    actions: 0,
    refusals: 0,
    stops: 0,
    leaseDenied: 0,
    startedAt: Date.now(),
  };
  const serialize = (run) => {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const sessionKeyOf = (context) => context?.sessionId?.trim() || "__unscoped__";
  const ensureDriver = async () => {
    if (disposed)
      throw new CuaBrokerError("Computer Use runtime is disposed", { code: "internal" });
    if (!driverPromise) {
      driverPromise = (async () => {
        try {
          driverInstance = await loadDriver();
          driverSource = options.loadDriver ? "test-injection" : "bundled";
        } catch (error) {
          // 平台二进制缺失（optionalDependencies 未装到本平台）会走到这里。
          // 归 broker_unavailable → HELPER_UNAVAILABLE：这是「本机没有可用后端」，
          // 不是可以盲目重试的暂时故障，也**不是**让模型去 npm install 的信号。
          throw new CuaBrokerError(
            `Computer Use driver is unavailable on this platform: ${error instanceof Error ? error.message : String(error)}`,
            { code: "broker_unavailable" },
          );
        }
        return driverInstance;
      })().catch((error) => {
        // 启动失败必须回滚，否则后续每次调用都复用一个已死的 promise，
        // 且 driverInstance 会留下半初始化的句柄。
        driverPromise = undefined;
        throw error;
      });
    }
    return await driverPromise;
  };
  /**
   * 调一次驱动工具，返回原始信封。
   *
   * **必须**传 signal，且不能传 undefined：`@ubjs/core@0.31.0-3` 的 async-rust-call
   * 里写的是 `asyncOpts?.signal.aborted` —— 可选链只护住了 `asyncOpts`，没护住
   * `signal`。于是 `{}`、`{signal: undefined}` 都会抛
   * "Cannot read properties of undefined (reading 'aborted')"，而 `{signal}` 正常。
   * 这是上游缺陷，所以这里永远合成一个信号，而不是把参数原样透传。
   */
  const callDriverOnce = async (toolName, args, signal) => {
    const driver = await ensureDriver();
    if (disposed || lifetime.signal.aborted) {
      throw new DOMException("Computer Use runtime is disposed", "AbortError");
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    stats.driverCalls += 1;
    const raw = await driver.callTool(toolName, JSON.stringify(args ?? {}), { signal: combined });
    const envelope = readDriverEnvelope(raw.rawJson);
    const refusal = refusalOf(envelope);
    if (refusal) {
      stats.refusals += 1;
      throw new CuaBrokerError(refusal.message, {
        code: brokerCodeForDriverCode(refusal.code),
        actionSent: actionDelivered(envelope),
        details: { driverCode: refusal.code, tool: toolName },
      });
    }
    return envelope;
  };
  /**
   * 带会话自愈的驱动调用。
   *
   * 驱动维护一个**隐式**生命周期会话，并在空闲到期后拒绝后续调用
   * （refusal code = `session_ended`）。没有自愈的话，一段超过会话 TTL 的闲置就会让
   * Computer Use 永久不可用，而模型只看到一句 session_ended。
   *
   * 重放安全性：`session_ended` 表示驱动在**执行之前**就拒绝了，动作没有下发
   * （`actionDelivered` 为 false），所以补一次 start_session 再重放不会重复输入。
   * 这条守卫是必须的 —— 对可能已下发的动作重放会真的多点一次。
   */
  const callDriver = async (toolName, args, signal) => {
    try {
      return await callDriverOnce(toolName, args, signal);
    } catch (error) {
      const rearmable =
        error instanceof CuaBrokerError &&
        error.details?.driverCode === "session_ended" &&
        error.actionSent !== true &&
        toolName !== "start_session" &&
        toolName !== "end_session";
      if (!rearmable) throw error;
      await callDriverOnce("start_session", {}, signal);
      return await callDriverOnce(toolName, args, signal);
    }
  };
  const methods = createCuaMethods({
    callDriver: (toolName, args, signal) => callDriver(toolName, args, signal),
    sessionKeyOf,
    observations,
    leaseStatus: (sessionKey) => {
      const lease = leases.get(sessionKey);
      return {
        held: lease?.isHeldByUs() ?? false,
        holder: lease?.holder() ?? null,
        path: lease?.leasePath ?? null,
      };
    },
    driverInfo: () => ({ version: options.driverVersion ?? null, source: driverSource }),
    stats: () => ({ ...stats, uptimeMs: Date.now() - stats.startedAt }),
  });
  // ─────────────────────────────────────────── 租约
  const leaseFor = (sessionKey) => {
    let lease = leases.get(sessionKey);
    if (!lease) {
      lease = createDesktopControlLease({ sessionKey });
      leases.set(sessionKey, lease);
    }
    return lease;
  };
  /** 取得（或续期）桌面控制租约。失败即失败关闭，不静默降级。 */
  const acquireLease = async (sessionKey) => {
    const lease = leaseFor(sessionKey);
    if (lease.isHeldByUs()) {
      lease.heartbeat();
      return { ok: true };
    }
    const result = await lease.acquire();
    if (result.ok) return { ok: true };
    stats.leaseDenied += 1;
    return { ok: false, message: result.message, holder: result.holder };
  };
  const releaseLease = (sessionKey) => {
    const lease = leases.get(sessionKey);
    if (!lease) return;
    lease.release();
    leases.delete(sessionKey);
  };
  // ─────────────────────────────────────────── method 表
  const handlers = {
    list_apps: (context, args, signal) => methods.methodListApps(context, signal),
    list_windows: (context, args, signal) => methods.methodListWindows(context, args, signal),
    get_app_state: (context, args, signal) => methods.methodGetAppState(context, args, signal),
    request_access: (context, args, signal) => methods.methodRequestAccess(context, signal),
    get_capabilities: (context, args, signal) => methods.methodGetCapabilities(context, signal),
    get_diagnostics: (context, args, signal) => methods.methodGetDiagnostics(context, signal),
    stop_computer_control: (context, args) => {
      const key = sessionKeyOf(context);
      stoppedSessions.add(key);
      stats.stops += 1;
      // 只丢本会话的观察：别的会话（其它窗口/其它 runtime）仍持自己的记录。
      observations.dropSession(key);
      return methods.methodStop(context, args);
    },
    ...Object.fromEntries(
      Object.entries(CUA_ACTIONS).map(([name]) => [
        name,
        (context, args, signal) => {
          stats.actions += 1;
          return methods.runAction(context, name, args ?? {}, signal);
        },
      ]),
    ),
  };
  /** 能力表对外可见的 method 名（供宿主与测试对齐）。 */
  const CUA_METHOD_NAMES = Object.freeze([
    ...Object.keys(handlers),
    ...DELIBERATELY_UNAVAILABLE_METHODS,
  ]);
  return {
    CUA_METHOD_NAMES,
    CUA_DRIVER_SUPPORTED_PLATFORMS,
    async execute({ toolName, arguments: args, context, signal }) {
      const handler = handlers[toolName];
      if (!handler) {
        // 驱动没有对应能力（select_text / perform_action / paste），或根本不是本协议的方法。
        // 归 unimplemented → ACTION_UNAVAILABLE（客户端 NEVER_RETRY_CODES）：
        // 明确告诉模型这条路不存在，别反复重试，改走元素或键盘路径。
        return errorResult({
          code: "unimplemented",
          message: DELIBERATELY_UNAVAILABLE_METHODS.includes(toolName)
            ? `Computer Use method "${toolName}" has no equivalent in the open-source driver; use element or keyboard actions instead.`
            : `Computer Use method "${toolName}" is not part of the Computer Use protocol.`,
        });
      }
      if (disposed) {
        return errorResult({
          code: "broker_unavailable",
          message: "Computer Use runtime is disposed",
        });
      }
      // 宿主上下文校验：sessionId 是会话隔离的锚，缺失时不能落到 "__unscoped__" 共享桶。
      if (typeof context?.sessionId !== "string" || !context.sessionId.trim()) {
        return errorResult({
          code: "invalid_request",
          message: "Computer Use request context is missing sessionId",
        });
      }
      // 子代理一律拒绝（PRD FR-09 / AC-20）。上游 policy 与 bridge 已各有一道，
      // 这里是第三道：任何新入口都不能因为忘了接 policy 而放开。
      if (context.runtimeScope === "subagent") {
        return errorResult({
          code: "not_authorized",
          message: "Computer Use is not available in subagent",
        });
      }
      // kill switch：本会话已 stop，除再次 stop 与只读诊断外一律拒绝。
      // controller_busy → CONTROLLER_BUSY 在客户端是 NEVER_RETRY_CODES，
      // 模型据此停止而不是换个方法继续操作桌面。
      const sessionKey = sessionKeyOf(context);
      const isDiagnostic = classifyCuaMethod(toolName) === CUA_METHOD_CLASS.diagnostic;
      if (
        stoppedSessions.has(sessionKey) &&
        toolName !== "stop_computer_control" &&
        !isDiagnostic
      ) {
        return errorResult({
          code: "controller_busy",
          message:
            "Computer Use control was stopped for this session. Do not continue; ask the user to start a new session.",
        });
      }
      // 租约：观察窗口内容与动作必须先拿到桌面控制权；占用即告知，不抢占。
      if (LEASE_REQUIRED_METHODS.has(toolName)) {
        const lease = await acquireLease(sessionKey);
        if (!lease.ok) {
          return errorResult({
            code: "controller_busy",
            message: lease.message ?? "desktop control lease is unavailable",
            details: { holder: lease.holder ?? null },
          });
        }
      }
      // 硬阻断先于一切授权执行（危险组合键 / 管道执行 / 递归删除）。
      try {
        assertNoHardBlock(toolName, args ?? {});
      } catch (error) {
        if (error instanceof CuaBrokerError) {
          return errorResult({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
      try {
        return await serialize(() => handler(context, args ?? {}, signal));
      } catch (error) {
        if (error instanceof CuaBrokerError) {
          return errorResult({
            code: error.code,
            message: error.message,
            actionSent: error.actionSent,
            details: error.details,
          });
        }
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        return errorResult({
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async closeSession(context) {
      const sessionKey = sessionKeyOf(context);
      stoppedSessions.delete(sessionKey);
      observations.dropSession(sessionKey);
      releaseLease(sessionKey);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 先取消在途调用再释放句柄：反序会让 shutdown() 与仍持锁的原生调用互相等待。
      lifetime.abort(new DOMException("Computer Use runtime is disposed", "AbortError"));
      observations.clear();
      const leaseKeys = Array.from(leases.keys());
      for (const sessionKey of leaseKeys) releaseLease(sessionKey);
      stoppedSessions.clear();
      const instance = driverInstance;
      driverInstance = undefined;
      driverPromise = undefined;
      if (!instance) return;
      // 真正释放原生资源：shutdown 结束会话，uniffiDestroy 释放 FFI 句柄。
      // 少了后者，Rust 侧对象会留到进程退出。
      await Promise.resolve()
        .then(() => instance.shutdown())
        .catch(() => undefined)
        .finally(() => {
          try {
            instance.uniffiDestroy();
          } catch {
            // 已释放时重复销毁会抛，忽略。
          }
        });
    },
  };
}
export const CUA_METHOD_CLASS_NAMES = CUA_METHOD_CLASS;
export { CUA_DRIVER_SUPPORTED_PLATFORMS };
