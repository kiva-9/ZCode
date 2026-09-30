/**
 * ZCode CUA 动作 method → cua-driver 工具调用的**入参翻译表**。
 *
 * 字段名全部按锁定版本 0.28.2 的工具 schema 核对过（`listToolsJson()` 实拉，
 * 见 docs/development/computer-use.md 的兼容性表）。两侧形状不同：
 * - ZCode 侧 `scroll_direction`/`scroll_amount` → 驱动 `direction`/`by`/`amount`；
 * - `key` 的 `"ctrl+shift+a"` → 驱动 `key` + `modifiers[]`（press_key 用复数）；
 * - `click` 的修饰键在驱动侧叫 `modifier`（单数）—— 两个工具字段名不一致，抄错就是静默失效。
 *
 * 写错字段名的后果是静默的：驱动只回一句 unrecognized_keys 或干脆按默认值执行，
 * 真机上才暴露。所以这张表是**白名单**：只转发上面列出的字段，客户端多传的
 * `strategy` / `hold_seconds` 等一律在此丢弃（0.28.2 的 press_key 没有持续时间原语，
 * 透传 hold_seconds 只会让调用被拒或语义造假）。
 *
 * `additionalProperties: false` 出现在驱动 schema 里，但实测嵌入式 callTool 路径对
 * 未知字段是宽容的（press_key 带 strategy/hold_seconds/bogus_field 仍按已知字段执行）。
 * 宽容不等于可以依赖：白名单让「我们发了什么」与「驱动认什么」始终保持一致。
 */
import { CuaBrokerError } from "./cua-driver-errors.js";
/** 必填文本字段的守卫：空串在驱动侧会变成一次无操作输入，必须在本地拒绝。 */
export function requireText(value, what) {
  if (typeof value !== "string" || !value) {
    throw new CuaBrokerError(`${what} requires non-empty text`, { code: "invalid_request" });
  }
  return value;
}
function nonNegativeIntegerOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
/** 修饰键白名单（驱动 click 的 `modifier` / press_key 的 `modifiers` 同取值）。 */
const MODIFIER_KEYS = new Set(["cmd", "shift", "option", "alt", "ctrl", "win", "super", "meta"]);
function modifierList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((key) => typeof key === "string")
    .map((key) => key.trim().toLowerCase())
    .filter((key) => MODIFIER_KEYS.has(key));
}
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const SCROLL_BY = new Set(["line", "page"]);
/**
 * method 名 → { tool, target?, args }。
 *
 * `target` 返回 undefined 表示该方法**不接收目标**（`type`/`key` 的输入落到当前焦点）；
 * 运行时据此跳过目标解析，而不是把 undefined 当成非法目标。
 */
export const CUA_ACTIONS = Object.freeze({
  left_click: (a) => ({
    tool: "click",
    target: () => a.target,
    args: () => ({
      ...(typeof a.mouse_button === "string" ? { button: a.mouse_button } : {}),
      ...(a.click_count === undefined ? {} : { count: nonNegativeIntegerOr(a.click_count, 1) }),
      ...(modifierList(a.modifiers).length > 0 ? { modifier: modifierList(a.modifiers) } : {}),
      // delivery_mode 永不由适配层主动设成 foreground：那是用户审批过的前台接管，
      // 只能由模型按 FOREGROUND_REQUIRED 的指引显式走，且仍要过 ZCode 的审批。
      ...(a.delivery_mode === "foreground" ? { delivery_mode: "foreground" } : {}),
    }),
  }),
  left_click_drag: (a) => ({
    tool: "drag",
    target: () => a.from_target,
    args: () => {
      const to = a.to;
      if (!to || to.type !== "coordinate" || !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
        throw new CuaBrokerError("drag requires a {type:'coordinate',x,y} destination", {
          code: "invalid_request",
        });
      }
      return {
        to_x: to.x,
        to_y: to.y,
        ...(modifierList(a.modifiers).length > 0 ? { modifier: modifierList(a.modifiers) } : {}),
        ...(Number.isInteger(a.duration_ms) && a.duration_ms > 0
          ? { duration_ms: a.duration_ms }
          : {}),
        ...(Number.isInteger(a.steps) && a.steps > 0 ? { steps: a.steps } : {}),
      };
    },
  }),
  type: (a) => ({
    tool: "type_text",
    target: () => a.target,
    args: () => ({
      text: requireText(a.text, "type"),
      ...(Number.isInteger(a.delay_ms) && a.delay_ms >= 0 ? { delay_ms: a.delay_ms } : {}),
    }),
  }),
  scroll: (a) => ({
    tool: "scroll",
    target: () => a.target,
    args: () => {
      const direction = String(a.scroll_direction ?? "").toLowerCase();
      if (!SCROLL_DIRECTIONS.has(direction)) {
        throw new CuaBrokerError("scroll_direction must be up, down, left or right", {
          code: "invalid_request",
        });
      }
      const pages = typeof a.scroll_amount === "number" ? a.scroll_amount : 1;
      const by =
        typeof a.scroll_by === "string" && SCROLL_BY.has(a.scroll_by) ? a.scroll_by : "page";
      // 驱动把 amount 限制在 1..50；越界会被它拒绝，这里先夹紧而不是报错。
      return {
        direction,
        by,
        amount: Math.min(50, Math.max(1, Math.round(pages))),
      };
    },
  }),
  set_value: (a) => ({
    tool: "set_value",
    target: () => a.target,
    args: () => {
      if (typeof a.value !== "string") {
        throw new CuaBrokerError("set_value requires a string value", { code: "invalid_request" });
      }
      return { value: a.value };
    },
  }),
  key: (a) => ({
    tool: "press_key",
    args: () => {
      const chord = requireText(a.text, "key").trim();
      // 客户端已把和弦规范化成 "+" 连接的形态（normalizeKeyChord）。
      // 拆成 key + modifiers 才是驱动的入参形状（press_key 用复数 modifiers）。
      const parts = chord
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean);
      const key = parts.pop();
      const modifiers = modifierList(parts);
      return { key, ...(modifiers.length > 0 ? { modifiers } : {}) };
    },
  }),
  mouse_move: (a) => ({
    tool: "move_cursor",
    target: () => a.target,
    args: () => {
      const from = a.from ?? a.target;
      const x = a.x ?? from?.x;
      const y = a.y ?? from?.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
        throw new CuaBrokerError("mouse_move requires non-negative integer x/y", {
          code: "invalid_request",
        });
      }
      return { x, y };
    },
  }),
});
/**
 * 驱动有原语但本版**刻意不开放**的 method（PRD §2.3 / AC-24）。
 *
 * `perform_action`：0.28.2 的 click 带 `action`（press/show_menu/pick/confirm/cancel/open），
 *   理论上可实现 performSecondaryAction。但 PRD 明确把它与 select_text/paste 一起列为
 *   「继续明确返回不可用」——菜单动作会触发真实业务副作用（发送/删除/提交），首版不放宽。
 *   列入这里是给后续阶段的实现线索，不是默认路径。
 */
export const DELIBERATELY_UNAVAILABLE_METHODS = Object.freeze([
  "select_text",
  "perform_action",
  "paste",
]);
/** 动作方法集合（供能力策略与统计复用）。 */
export const CUA_ACTION_METHOD_NAMES = Object.freeze(Object.keys(CUA_ACTIONS));
