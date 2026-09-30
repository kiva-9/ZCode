/**
 * 假驱动：记录调用、按脚本返回信封。
 *
 * 为什么用假驱动：真驱动需要图形会话 + 平台原生二进制，CI 上跑不了；而这一层要守的
 * 恰恰**不是**驱动的桌面能力，是适配层自己的契约：
 *   ① capability method 到驱动工具的**路由形状**（app_ref → pid、target → element_token、
 *      key 和弦拆分、scroll 单位…）。字段名一旦写错，真机上表现为「观察被 unrecognized_keys
 *      打回」或「静默点到别的控件」，而且只有真机才能发现。
 *   ② 错误码映射。客户端只认 broker 码，映射错了全部退化成 INTERNAL。
 *   ③ 资源释放。dispose 必须真的 shutdown + uniffiDestroy，否则原生句柄泄漏。
 *
 * 信封形状按 **0.28.2 实测**构造（不是照抄任何一份旧代码）：
 * - `list_windows` 行的尺寸在 `bounds` 里（0.28.2 的真实形状；CE 参考实现的测试用扁平
 *   width/height，因此没暴露它读错字段的问题）。
 * - 拒绝有两种落点：`structuredContent.code`，或**只有 isError + 一段文本**
 *   （实测 stale token 与后台拒绝都走后者）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 桌面控制租约是**跨进程文件锁**，落在 os.tmpdir()。多个测试文件并行跑时共享同一个
 * 真实 TMPDIR，于是「会话 sess-1」的租约会互相挡住（这正是租约该有的行为）。
 * 这里在每个测试文件加载时换一个独立的 TMPDIR，让各文件的租约空间彼此隔离。
 */
const isolatedTmp = mkdtempSync(join(tmpdir(), "zcode-cua-test-"));
process.env.TMPDIR = isolatedTmp;
process.on("exit", () => rmSync(isolatedTmp, { recursive: true, force: true }));

export function createFakeDriver(script = {}) {
  const calls = [];
  return {
    calls,
    shutdownCalls: 0,
    destroyCalls: 0,
    async callTool(name, argumentsJson, options) {
      // 适配层必须传 signal：@ubjs/core 直接读 options.signal.aborted。
      assert.ok(options?.signal, "适配层必须传 signal（@ubjs/core 读 options.signal.aborted）");
      const args = JSON.parse(argumentsJson);
      calls.push({ name, args });
      const entry = script[name];
      const value = typeof entry === "function" ? entry(args) : entry;
      return { rawJson: JSON.stringify(value ?? { content: [] }) };
    },
    async shutdown() {
      this.shutdownCalls += 1;
    },
    uniffiDestroy() {
      this.destroyCalls += 1;
    },
  };
}

export const envelope = (structured, texts = []) => ({
  content: texts.map((text) => ({ type: "text", text })),
  ...(structured ? { structuredContent: structured } : {}),
});

/** 文本-only 拒绝（实测里 stale token / 后台拒绝的真实形态）。 */
export const textRefusal = (text) => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** 一个能被 resolveAppWindow 解析的最小驱动：list_apps + list_windows 固定返回一行。 */
export function baseScript(extra = {}) {
  return {
    list_apps: envelope({
      apps: [
        {
          name: "Dolphin",
          pid: 42,
          running: true,
          bundle_id: "org.kde.dolphin",
          kind: "desktop",
          launch_path: "dolphin",
        },
      ],
    }),
    // 0.28.2 的真实形状：尺寸在 bounds 里。第二个窗口 0x0 是合成窗口，必须被过滤。
    list_windows: envelope({
      windows: [
        {
          pid: 42,
          window_id: 7,
          app_name: "dolphin",
          title: "t",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
        {
          pid: 42,
          window_id: 8,
          app_name: "dolphin",
          title: "ghost",
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    }),
    get_window_state: envelope({
      snapshot_id: "s00000001",
      window_id: 7,
      pid: 42,
      app_name: "dolphin",
      window_title: "t",
      window_bounds: { x: 0, y: 0, width: 800, height: 600 },
      element_count: 2,
      elements_complete: true,
      tree_markdown: '- frame = "t"',
      elements: [
        {
          element_index: 0,
          role: "push button",
          label: "OK",
          actions: ["Press"],
          element_token: "s00000001:0",
        },
        {
          element_index: 1,
          role: "text",
          label: "field",
          actions: ["SetFocus"],
          element_token: "s00000001:1",
        },
      ],
    }),
    check_permissions: envelope({
      accessibility: true,
      screen_recording: true,
      source: { executable: "/usr/local/bin/node", host_bundle_id: "", note: "host grant" },
    }),
    health_report: envelope({
      overall: "ok",
      driver_version: "0.28.2",
      platform: "macos",
      checks: [{ name: "binary_version", status: "pass", message: "cua-driver 0.28.2" }],
    }),
    start_session: envelope({ active: true, session: "implicit" }),
    ...extra,
  };
}

export const SESSION = { sessionId: "sess-1", runtimeScope: "main", workspaceKey: "ws-1" };
export const APP = { app_ref: { bundle_id: "org.kde.dolphin" } };

export const execute = (runtime, toolName, args, context = SESSION) =>
  runtime.execute({ toolName, arguments: args, context });

export const bodyOf = (result) => JSON.parse(result.content[0].text);

/** 经生产装配点创建运行时（与 server.ts 同一入口，只额外注入假驱动）。 */
export async function createRuntime(driver) {
  const { createComputerUseRuntime } = await import("../../index.js");
  return createComputerUseRuntime({ loadDriver: async () => driver });
}

export async function withRuntime(script, run) {
  const driver = createFakeDriver(script);
  const runtime = await createRuntime(driver);
  try {
    await run({ runtime, driver });
  } finally {
    await runtime.dispose();
  }
}
