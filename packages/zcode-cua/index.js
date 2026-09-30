import { createCuaDriverRuntime } from "./cua-driver-runtime.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

/**
 * Computer Use 运行时装配点。
 *
 * 两种模式：
 * - `open-source`（默认）：驱动在本进程内加载 `@trycua/cua-driver@0.28.2`，
 *   由 `ZCODE_CUA_NODE_REPL_HOST=1` 与 `import.meta.resolve` 双重门控后才装配
 *   （见 node-repl-host/src/server.ts）。
 * - `disabled`：占位语义，所有面不可用、失败关闭。用于显式关闭 Computer Use 的构建，
 *   也用于「驱动装不上」时的最小可诊断路径。
 *
 * `brokerSocketPath` / `refreshMarkerPath` / `ensureBrokerAvailable` 仍然接受但**不消费**：
 * 它们是官方 Helper 私有二进制的连接材料。本构建不随包携带 Helper，也不从桌面端
 * Helper 转发请求；保留字段只为兼容既有装配点，并在诊断里可查。
 * 普通工具调用中因此不会触发任何驱动下载、Helper 拉起或权限申请。
 *
 * `loadDriver` 是测试注入点：回归测试用假驱动覆盖路由/错误映射/资源释放。
 * 生产装配点（node-repl-host）永远不传它。
 */
export function createComputerUseRuntime(options = {}) {
  const mode = options.driver ?? "open-source";
  if (mode === "disabled") return createDisabledRuntime();

  const runtime = createCuaDriverRuntime(
    options.loadDriver ? { loadDriver: options.loadDriver } : {},
  );
  return {
    execute: (input) => runtime.execute(input),
    closeSession: (context) => runtime.closeSession(context),
    dispose: () => runtime.dispose(),
  };
}

/** placeholder 语义：所有面不可用，失败关闭。保留给显式关闭 Computer Use 的构建。 */
function createDisabledRuntime() {
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}

export { CUA_DRIVER_SUPPORTED_PLATFORMS, CUA_METHOD_NAMES } from "./cua-driver-runtime.js";
