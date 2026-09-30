/**
 * cua-driver 失败形态 → ZCode CUA broker 错误码，以及 MCP 结果信封的构造。
 *
 * 为什么需要这一层（而不是把 cua-driver 自己的 refusal.code 直接抛给模型）：
 * 模型可见的错误码由 `computer-use-client.mjs` 的 ERROR_CODE_BY_BROKER 决定 —— 它只认
 * broker 码（snake_case），映射不到的一律归 INTERNAL。若这里原样透传
 * `snapshot_id_required` / `window_target_not_found`，每次失败都会退化成 INTERNAL，
 * 模型就失去「先重新观察再试」与「绝不重试」的区别 —— 而那正是这张表存在的理由。
 *
 * 取值口径：本文件只发 broker 码；映射不到的一律 internal（→ INTERNAL），不猜。
 *
 * 与 CE 参考实现的差异（本仓库）：
 * 1. `jsonSafe()`：驱动的 typed API 会返回 bigint（window_id / element_index / zIndex …）。
 *    本运行时的结果最终要经 node-repl-host 的 Unix socket `JSON.stringify` 送出，
 *    裸 BigInt 会让那一步抛 "Do not know how to serialize a BigInt" —— 整条结果丢失。
 *    所以在信封出口统一归一，绝不把 BigInt 带出适配层。
 * 2. 投递/验证状态（PRD FR-06）：`deliveryState()` 把收据翻成 not_sent / sent /
 *    possibly_sent / unknown 四态，`actionReceipt()` 生成带 action_id 的回执块。
 *    「驱动回执」与「任务结果」是两件事，不能互相顶替。
 */
/**
 * cua-driver refusal/error code → ZCode broker code。
 * 右侧取值必须落在 computer-use-client.mjs 的 ERROR_CODE_BY_BROKER 键集合内。
 */
const BROKER_CODE_BY_DRIVER_CODE = Object.freeze({
  // 快照/元素失效：客户端映射成 ELEMENT_UNAVAILABLE，retry 决策为 reobserve。
  // 这类失败的正确反应是「重新观察后按新索引重做」，不是重放旧动作。
  snapshot_id_required: "element_unavailable",
  stale_element_token: "element_unavailable",
  stale_snapshot: "element_unavailable",
  element_not_found: "element_unavailable",
  element_unavailable: "element_unavailable",
  invalid_element_token: "element_unavailable",
  // 目标窗口/应用已不在：同样先刷新再试。
  window_target_not_found: "element_unavailable",
  window_not_found: "element_unavailable",
  // 后台投递不可用是**能力**拒绝，不是暂时故障：客户端映射成 FOREGROUND_REQUIRED，
  // 落在 NEVER_RETRY_CODES。适配层绝不因此改用前台重投 —— 安全语义
  // 「a refusal does not authorize a foreground retry」就靠这条守住。
  background_unavailable: "foreground_required",
  foreground_required: "foreground_required",
  // 权限与授权
  permission_denied: "permission_denied",
  accessibility_denied: "permission_denied",
  screen_recording_denied: "permission_denied",
  screen_locked: "permission_denied",
  not_authorized: "not_authorized",
  blocked_action: "not_authorized",
  // 启动
  launch_failed: "launch_failed",
  // 投递失败（实测 0.28.2：press_key 对不存在的键名返回该码）。语义是「这一次没有
  // 形成有效输入」，且不区分是参数问题还是后端拒绝 —— 两种情况的正确反应都是换路径，
  // 不是原样重放。归 action_unavailable → ACTION_UNAVAILABLE（NEVER_RETRY）。
  delivery_failed: "action_unavailable",
  // 可设置/可选择语义
  not_settable: "not_settable",
  not_selectable: "not_selectable",
  // 该能力在本驱动/本平台上不存在。归 unimplemented → ACTION_UNAVAILABLE（永不重试），
  // 让模型改用别的路径，而不是反复重试一个根本不存在的能力。
  unimplemented: "unimplemented",
  unsupported: "unimplemented",
  action_unavailable: "action_unavailable",
  // 会话与并发
  controller_busy: "controller_busy",
  session_not_found: "controller_busy",
  // 会话已结束（stop 之后、或显式 end_session 之后）。客户端没有 CONTROL_STOPPED 的
  // broker 码，最接近的语义是 controller_busy → CONTROLLER_BUSY（永不重试），
  // 让模型停下而不是当成 INTERNAL 反复重试。
  session_ended: "controller_busy",
  // 驱动本体不可用
  driver_unavailable: "broker_unavailable",
  transport_error: "broker_unavailable",
  // 参数与内部错误
  invalid_arguments: "invalid_request",
  invalid_request: "invalid_request",
  timeout: "timeout",
  internal: "internal",
});
/** 驱动错误码 → broker 码。未知码归 internal，绝不静默当成成功。 */
export function brokerCodeForDriverCode(code) {
  if (typeof code !== "string" || !code) return "internal";
  return BROKER_CODE_BY_DRIVER_CODE[code] ?? "internal";
}
/** 客户端 ERROR_CODE_BY_BROKER 认识的 broker 码集合（用于自检与测试断言）。 */
export const KNOWN_BROKER_CODES = Object.freeze([
  "permission_denied",
  "not_authorized",
  "launch_failed",
  "invalid_request",
  "element_unavailable",
  "not_settable",
  "not_selectable",
  "action_unavailable",
  "foreground_required",
  "controller_busy",
  "broker_unavailable",
  "version_mismatch",
  "stale_socket",
  "timeout",
  "unimplemented",
  "internal",
]);
/**
 * 适配层内部错误：带上 broker 码与「动作是否可能已下发」。
 *
 * actionSent 的方向是**故意保守**的：只有在收据明确说下发过时才置 true。
 * 反过来（默认 true）会让模型对一个从未下发的动作放弃重试。
 */
export class CuaBrokerError extends Error {
  constructor(message, { code = "internal", actionSent = false, details } = {}) {
    super(message);
    this.name = "CuaBrokerError";
    this.code = code;
    this.actionSent = actionSent === true;
    if (details !== undefined) this.details = details;
  }
}
export function textBlock(text) {
  return { type: "text", text };
}
export function jsonBlock(value) {
  return { type: "text", text: JSON.stringify(jsonSafe(value)) };
}
export function imageBlock(base64, mimeType) {
  return { type: "image", data: base64, mimeType };
}
/**
 * 递归把 BigInt 归一成可 JSON 序列化的值。
 *
 * 安全范围内的 BigInt → number；超出 Number.MAX_SAFE_INTEGER → 十进制字符串
 * （保留精确值，调用方仍可识别）。驱动返回的 id 类字段（window_id、element_index）
 * 在 typed API 里就是 BigInt，只是走 rawJson 时已被 Rust 序列化成数字/字符串。
 */
export function jsonSafe(value, depth = 0) {
  if (depth > 32) return "[depth-exceeded]";
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, depth + 1);
    return out;
  }
  return value;
}
/**
 * 成功信封。content 为 [] 时也要保留 structuredContent，宿主展示面板需要它。
 *
 * `_meta` 必须原样透出：request_access 的权限状态信封、list_apps 的应用关联
 * （宿主据此在卡片上显示应用名/图标）都走这个字段。早前这里只转发 content 与
 * structuredContent，两个 _meta 都被静默丢掉 —— 表现是设置页权限行永远不更新、
 * 工具卡不显示目标应用，且没有任何报错。
 */
export function okResult({ content = [], structuredContent, _meta } = {}) {
  return {
    content,
    ...(structuredContent ? { structuredContent: jsonSafe(structuredContent) } : {}),
    ...(_meta ? { _meta: jsonSafe(_meta) } : {}),
  };
}
/**
 * 失败信封。
 *
 * 为什么不是 throw：broker 会把抛出的异常压成 `{ok:false,error:"字符串"}`，客户端
 * `bridge.call` 只能再抛一个普通 Error —— 模型拿到的是没有 code、没有 actionSent 的
 * 一句话。所以工具级失败必须以 isError 结果回传，让 assertOk 能读到 code/action_sent。
 */
export function errorResult({ code, message, actionSent = false, details, cua }) {
  const payload = {
    code,
    message,
    ...(details === undefined ? {} : { details: jsonSafe(details) }),
  };
  return {
    content: [jsonBlock(payload)],
    structuredContent: {
      code,
      message,
      ...(actionSent ? { action_sent: true, dispatch_status: "possibly_sent" } : {}),
      // PRD §7.2：失败路径同样要给投递/验证四态。放进 details 里模型与 UI 都要多解一层，
      // 而「投递未知」这条信息恰恰必须在最外层可直接读到。
      ...(cua ? { cua: jsonSafe(cua) } : {}),
    },
    isError: true,
  };
}
/**
 * 读 driver 的 rawJson 信封。
 *
 * 形态（实测 0.28.2）：{content:[{type:"text",text}], structuredContent?, isError?}。
 * 拒绝分两种落点：老一些的路径给 structuredContent.refusal + status:"refused"，
 * 另一些只给 isError + structuredContent.code（或干脆只有一段文本）。
 */
export function readDriverEnvelope(rawJson) {
  let parsed;
  if (typeof rawJson === "string") {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new CuaBrokerError("cua-driver returned a malformed tool result", {
        code: "internal",
        details: { raw: String(rawJson).slice(0, 200) },
      });
    }
  } else if (rawJson && typeof rawJson === "object") {
    parsed = rawJson;
  } else {
    throw new CuaBrokerError("cua-driver returned an empty tool result", { code: "internal" });
  }
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  return {
    parsed,
    isError: parsed.isError === true,
    structured:
      parsed.structuredContent && typeof parsed.structuredContent === "object"
        ? parsed.structuredContent
        : {},
    texts: content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text),
    images: content.filter((block) => block?.type === "image"),
  };
}
/**
 * 纯文本拒绝的分类（实测 0.28.2 的重要补丁）。
 *
 * 驱动的后台投递拒绝**只落在文本里**，`structuredContent.code` 是 undefined：
 *   "Background input refused (off_space_or_ax_unresolved): window 212 is not among
 *    the process's current AXWindows (another Space, or its AX surface ...)"
 * CE 参考实现把所有纯文本拒绝一律归 element_unavailable（语义「刷新后再试」），
 * 那会把「后台不可用」误判成「元素过期」—— 模型据此反复重新观察，永远走不到
 * 「告诉用户需要前台/换路径」这一步，正是 PRD FR-11 要求区分的两类失败。
 * 这里按文本特征先分流，剩下的才按元素过期处理。
 */
const BACKGROUND_REFUSAL_PATTERN =
  /background input refused|background_unavailable|off_space_or_ax_unresolved/iu;
function textRefusalCode(texts) {
  const joined = texts.join("\n");
  if (BACKGROUND_REFUSAL_PATTERN.test(joined)) return "background_unavailable";
  return "element_unavailable";
}
/** 从信封里取出驱动自己的拒绝原因（code + message）。取不到返回 undefined。 */
export function refusalOf(envelope) {
  const { structured, texts, isError } = envelope;
  const refusal = structured.refusal;
  if (refusal && typeof refusal === "object" && typeof refusal.code === "string") {
    return {
      code: refusal.code,
      message:
        typeof refusal.message === "string" && refusal.message ? refusal.message : refusal.code,
    };
  }
  if (typeof structured.code === "string" && structured.code) {
    const text = texts.find((value) => value && value !== structured.code);
    return { code: structured.code, message: text ?? structured.code };
  }
  if (!isError) return undefined;
  // 只剩一段纯文本的失败。先按内容分流（后台拒绝 vs 元素过期），见 textRefusalCode。
  return { code: textRefusalCode(texts), message: texts[0] ?? "cua-driver refused the request" };
}
/**
 * 动作是否**可能已经下发**。
 *
 * 只认驱动收据里的 delivered_count：effect 为 suspected_noop 也算已下发 ——
 * 输入确实进了目标应用，只是界面没变，重放会真的多点一次。
 */
export function actionDelivered(envelope) {
  const delivery = envelope.structured.delivery;
  return typeof delivery?.delivered_count === "number" && delivery.delivered_count > 0;
}
/**
 * 收据 → PRD §7.2 的四态投递状态。
 *
 * 四态不可互相坍缩：`unknown`（超时/取消后不知道有没有送达）绝不能写成
 * `not_sent` —— 那会让模型放心重放一个可能已经落地的非幂等输入。
 */
export function deliveryState({ delivered, aborted, refused }) {
  if (refused) return "not_sent";
  if (delivered === true) return "sent";
  if (aborted) return "unknown";
  return "unknown";
}
/** 驱动 effect → PRD §7.2 的验证状态初值（观察后的最终值由运行时补齐）。 */
export function verificationStateForEffect(effect) {
  switch (String(effect ?? "")) {
    case "confirmed":
      return "observed_change";
    case "partial":
      return "observed_change";
    case "unverifiable":
      return "inconclusive";
    case "suspected_noop":
      return "inconclusive";
    case "refused":
      return "not_run";
    default:
      return "not_run";
  }
}
