/**
 * Computer Use 能力策略：哪些 method 只读、哪些会改界面、哪些必须人工确认，
 * 以及**先于一切审批的硬阻断**。
 *
 * 来源与边界：
 * - 分类参考 Hermes `tools/computer_use/schema.py` 的 dispatch flags
 *   （capture/list_apps/list_windows 只读免审；click/type/key/set_value/scroll/drag 是
 *   input+destructive；focus_app 是 destructive 但非 input）。
 * - 硬阻断清单参考 Hermes `tool.py::_reject_unsafe`（在审批之前执行，任何授权级别都
 *   不能放行）：危险组合键与「下载即执行 / 递归删除」类输入。
 * - 按键解析按 `+` 与 `-` 双分隔并做别名归一（command→cmd、control→ctrl、
 *   alt→option、windows|super|meta→win），否则 `ctrl-alt-delete` 这类连字符写法会成为漏网入口。
 *
 * 与 Hermes 的差异（本仓库）：ZCode 的动作审批走既有的工具权限与 Computer Use
 * 授权链路（`mcp__node_repl__js` 的调用审批 + 插件启用 + 系统权限），本模块不实现
 * 第二套审批存储；它负责的是**语义分类**与**不可授权的硬阻断**，并把
 * `requires_approval` 写进回执，让上层 UI 与模型知道这一步为什么被拦。
 */
import { CuaBrokerError } from "./cua-driver-errors.js";
import { CUA_ACTION_METHOD_NAMES } from "./cua-driver-actions.js";
/** 只读：不改变目标应用状态，也不需要动作授权。 */
const READ_ONLY_METHODS = new Set(["list_apps", "list_windows", "get_app_state", "request_access"]);
/** 生命周期/控制面：只影响 ZCode 自己的会话，不直接改桌面。 */
const LIFECYCLE_METHODS = new Set(["stop_computer_control"]);
/** 诊断：只读，且按 PRD FR-12 不执行任何点击或输入。 */
const DIAGNOSTIC_METHODS = new Set(["get_capabilities", "get_diagnostics"]);
/**
 * 会向目标应用投递输入的 method。首版这些都需要人工确认（PRD FR-07：
 * 写操作逐次审批），批量授权不覆盖它们。
 */
const INPUT_METHODS = new Set(["type", "set_value", "key", "mouse_move"]);
/** 会改变界面但不投递文本的 method（点击/滚动/拖动同样需要授权）。 */
const MUTATING_METHODS = new Set([
  "left_click",
  "left_click_drag",
  "scroll",
  ...CUA_ACTION_METHOD_NAMES,
]);
export const CUA_METHOD_CLASS = Object.freeze({
  readOnly: "read_only",
  input: "input",
  mutating: "mutating",
  lifecycle: "lifecycle",
  diagnostic: "diagnostic",
  unknown: "unknown",
});
export function classifyCuaMethod(name) {
  if (READ_ONLY_METHODS.has(name)) return CUA_METHOD_CLASS.readOnly;
  if (LIFECYCLE_METHODS.has(name)) return CUA_METHOD_CLASS.lifecycle;
  if (DIAGNOSTIC_METHODS.has(name)) return CUA_METHOD_CLASS.diagnostic;
  if (INPUT_METHODS.has(name)) return CUA_METHOD_CLASS.input;
  if (MUTATING_METHODS.has(name)) return CUA_METHOD_CLASS.mutating;
  return CUA_METHOD_CLASS.unknown;
}
/** 是否需要人工授权（只读与诊断不需要）。 */
export function requiresActionApproval(name) {
  const kind = classifyCuaMethod(name);
  return kind === CUA_METHOD_CLASS.input || kind === CUA_METHOD_CLASS.mutating;
}
/**
 * 先于审批执行的硬阻断（Hermes `_reject_unsafe` 同语义）。
 *
 * 这些组合在 macOS 上分别是「清废纸篓」「强制退出登录/重启」「锁屏」「关闭窗口」，
 * 在 Windows 上是锁屏/任务管理器。任何授权级别都不放行 —— 用户自己要执行时，
 * 请他在本机手动操作，而不是让 Agent 代按。
 */
const KEY_ALIASES = {
  command: "cmd",
  cmd: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  alt: "option",
  option: "option",
  windows: "win",
  super: "win",
  meta: "win",
  win: "win",
  shift: "shift",
  fn: "fn",
  delete: "delete",
  del: "delete",
  backspace: "backspace",
  escape: "esc",
  esc: "esc",
  return: "return",
  enter: "return",
  f4: "f4",
  l: "l",
  q: "q",
};
/** 归一化后的阻断组合（集合比较，顺序无关）。 */
const BLOCKED_CHORDS = Object.freeze([
  Object.freeze(["cmd", "shift", "backspace"]),
  Object.freeze(["cmd", "option", "backspace"]),
  Object.freeze(["cmd", "ctrl", "q"]),
  Object.freeze(["cmd", "shift", "q"]),
  Object.freeze(["cmd", "option", "shift", "q"]),
  Object.freeze(["win", "l"]),
  Object.freeze(["ctrl", "option", "delete"]),
  Object.freeze(["option", "f4"]),
]);
function normalizeChordTokens(chord) {
  return String(chord)
    .split(/[+\-\s]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .map((token) => KEY_ALIASES[token] ?? token);
}
/** 输入正文的硬阻断模式（下载即执行 / 递归删除 / fork bomb）。 */
const BLOCKED_TEXT_PATTERNS = Object.freeze([
  /(curl|wget)[^\n]{0,200}\|\s*(bash|sh|zsh)/iu,
  /sudo\s+rm\s+-rf/iu,
  /rm\s+-rf\s+\/(?:\s|$)/u,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/u,
]);
/**
 * 返回不可授权的硬阻断原因；可执行返回 undefined。
 *
 * `not_authorized` 的语义：这不是「再试一次」也不是「重新观察」，而是这一步需要用户
 * 在本机亲自完成。模型收到后必须停止该类操作并向用户说明。
 */
export function hardBlockFor(method, args) {
  if (method === "key") {
    const chord = typeof args?.text === "string" ? args.text : "";
    const tokens = normalizeChordTokens(chord);
    const set = new Set(tokens);
    for (const blocked of BLOCKED_CHORDS) {
      if (blocked.every((key) => set.has(key))) {
        return {
          code: "blocked_key_chord",
          message:
            `Key chord "${chord}" is blocked for Computer Use: it triggers a system-level ` +
            `action (trash/force-quit/log-out/lock). Ask the user to perform it manually on this machine.`,
        };
      }
    }
  }
  if (method === "type" || method === "set_value") {
    const text = typeof args?.text === "string" ? args.text : (args?.value ?? "");
    for (const pattern of BLOCKED_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        return {
          code: "blocked_input_pattern",
          message:
            "This input matches a blocked pattern (pipe-to-shell / recursive delete / fork bomb). " +
            "Computer Use will not type it. Ask the user to confirm the command in a terminal instead.",
        };
      }
    }
  }
  return undefined;
}
/** 供测试与文档复用的阻断清单（不含内部别名表）。 */
export const BLOCKED_KEY_CHORDS = BLOCKED_CHORDS.map((chord) => chord.join("+"));
/** 把硬阻断翻成 broker 错误。code 走 not_authorized（客户端 NOT_AUTHORIZED，永不重试）。 */
export function assertNoHardBlock(method, args) {
  const block = hardBlockFor(method, args);
  if (!block) return;
  throw new CuaBrokerError(block.message, {
    code: "not_authorized",
    details: { reason: block.code, method },
  });
}
