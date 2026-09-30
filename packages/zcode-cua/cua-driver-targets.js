/**
 * ZCode CUA 协议 → cua-driver 的**目标解析**。
 *
 * 两侧定位模型不同构，这里是翻译层：
 * - ZCode 用 `app_ref`（name / bundle_id / pid，可带 window_id）定位应用；
 *   驱动只认 `pid`，窗口另给 `window_id`。
 * - ZCode 的观察结果要回传 `state_id` + 元素表；驱动的元素动作只认
 *   `element_token`（或 snapshot_id + element_index）。
 *
 * 拆成独立模块的理由：这些函数全部是「输入 → 驱动参数」的纯翻译，不持有运行时状态，
 * 只有观察表按会话键传入。混在运行时里会让那个文件既管生命周期又管协议细节。
 *
 * 与 CE 参考实现的差异（本仓库，对应 PRD FR-04 / AC-05 / AC-07 / AC-09）：
 * 1. 观察键从 (会话, 应用) 收紧为 (会话, 应用, **窗口**)。同一应用的多窗口各有自己的
 *    观察记录与元素表，A 窗口的索引不能解析到 B 窗口的控件上。
 * 2. 元素目标的 index → element_token 映射按**观察记录**解析，并额外校验调用方显式
 *    带来的 state_id：不匹配即拒绝（`element_unavailable`），不静默改绑到新快照。
 * 3. 坐标目标必须绑定到具体快照（frame_id）。像素坐标跨快照即失效 —— UI 一改，
 *    同一个 (x, y) 就是另一个控件，静默生效是最典型的错点。
 */
import { CuaBrokerError } from "./cua-driver-errors.js";
/**
 * 允许定位到窗口的最小像素边长。
 *
 * 驱动的窗口表里混着 0x0 的合成窗口（实测同一 pid 同时给出主窗口与若干 0x0 行），
 * 不过滤会把「主窗口」选成一个不可见的幽灵。
 */
export const MIN_WINDOW_EDGE_PX = 1;
/** app_ref → 稳定的会话内键。用于把观察记录按 (会话, 应用) 归档。 */
export function appKeyOf(appRef) {
  if (appRef?.bundle_id) return `bundle:${appRef.bundle_id}`;
  if (appRef?.pid) return `pid:${appRef.pid}`;
  return `name:${String(appRef?.name ?? "").toLowerCase()}`;
}
/** 观察记录的完整键：(会话, 应用, 窗口)。缺 window_id 时窗口段为 `-`。 */
export function observationKeyOf(sessionKey, appRef, windowId) {
  const window = windowId === undefined || windowId === null ? "-" : String(windowId);
  return `${sessionKey}|${appKeyOf(appRef)}|${window}`;
}
/** 同一会话的观察键前缀，用于按会话整体失效。 */
export function observationKeyPrefix(sessionKey) {
  return `${sessionKey}|`;
}
/** app 行是否匹配 app_ref。字段优先级：bundle_id > pid > name。 */
export function matchesRef(app, appRef) {
  if (typeof appRef?.bundle_id === "string" && appRef.bundle_id) {
    return app.bundle_id === appRef.bundle_id;
  }
  if (typeof appRef?.pid === "number" && appRef.pid > 0) return app.pid === appRef.pid;
  const name = typeof appRef?.name === "string" ? appRef.name.trim() : "";
  if (!name) return false;
  if (app.name === name) return true;
  return typeof app.name === "string" && app.name.toLowerCase() === name.toLowerCase();
}
/**
 * 窗口行的像素尺寸。
 *
 * **必须在锁定版本上核对**：实测 0.28.2 的 `list_windows` 行是
 * `{window_id, bounds:{x,y,width,height}, ...}` —— 尺寸在 `bounds` 里，没有扁平
 * `width`/`height`。CE 参考实现的 usableWindows/pickWindow 读扁字段，在 0.28.2 上
 * 会得到 `Number(undefined)=NaN`，于是**每个窗口都被判成不可用**，"app has no open
 * window" 对一切应用成立（它的回归测试用假驱动返回扁字段，所以没暴露）。
 * 这里以 bounds 为准、扁字段为兜底，两种形状都能工作。
 */
export function windowArea(window) {
  const width = Number(window?.bounds?.width ?? window?.width ?? 0);
  const height = Number(window?.bounds?.height ?? window?.height ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return width * height;
}
/** 驱动窗口行 → 只保留真正可定位的窗口。 */
export function usableWindows(windows) {
  return (Array.isArray(windows) ? windows : []).filter((w) => windowArea(w) >= MIN_WINDOW_EDGE_PX);
}
/**
 * 在窗口表里挑目标窗口。
 *
 * 不带 window_id 时取面积最大的窗口，而不是第一行：驱动的行序不保证主窗口在前，
 * 按面积取更稳定（实测 Dolphin 的主窗口与合成窗口混排）。
 *
 * **不把「面积最大」当作用户已选择的目标**（PRD FR-02）：它只是没有 window_id 时
 * 的兜底；调用方（客户端）拿不到 window_id 时会先 list_windows 让模型显式选。
 */
export function pickWindow(windows, windowId) {
  if (windowId !== undefined) return windows.find((w) => w.window_id === windowId);
  return windows.slice().sort((a, b) => windowArea(b) - windowArea(a))[0];
}
/** 驱动元素行 → 模型可见的 AXElement，并保留 element_token 供动作解析。 */
export function toElement(raw) {
  return {
    index: raw.element_index,
    kind: raw.role,
    title: raw.label ?? null,
    value: typeof raw.value === "string" ? raw.value : null,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    enabled: raw.enabled !== false,
    ...(typeof raw.element_token === "string" ? { element_token: raw.element_token } : {}),
  };
}
/**
 * 校验调用方显式带来的 state_id 与当前观察记录一致。
 *
 * 模型可以传 `state_id`（「我这个索引属于哪次观察」）。不一致说明它拿着旧快照的
 * 索引在新界面上操作 —— 正是 AC-09 要拦的错点。driver 的 element_token 也会拦，
 * 但那是**驱动**的兜底；适配层先拦能给出可读的原因，也不浪费一次原生往返。
 */
function assertSnapshotBinding(target, observation) {
  const wanted = target.state_id ?? target.snapshot_id;
  if (typeof wanted !== "string" || !wanted) return;
  const current = observation?.stateId;
  if (!current) {
    throw new CuaBrokerError(
      "this target references a snapshot that is no longer held by the runtime; observe again before acting",
      { code: "element_unavailable", details: { need: "getAXState", requested: wanted } },
    );
  }
  if (wanted !== current) {
    throw new CuaBrokerError(
      `snapshot ${wanted} is stale for this window; the latest observation is ${current}. Observe again and use the new indices.`,
      { code: "element_unavailable", details: { need: "getAXState", requested: wanted, current } },
    );
  }
}
/**
 * `target` → 驱动动作参数。
 *
 * 元素索引按「该 (会话, 应用, 窗口) 最近一次观察」解析：查不到观察记录就报
 * element_unavailable 让模型先观察，**绝不猜一个索引** —— 猜错会静默点到别的控件。
 */
export function resolveTarget(target, observation) {
  if (target && typeof target === "object" && !Array.isArray(target)) {
    if (target.type === "element") {
      const index = target.index;
      if (!Number.isInteger(index) || index < 0) {
        throw new CuaBrokerError("target element index must be a non-negative integer", {
          code: "invalid_request",
        });
      }
      assertSnapshotBinding(target, observation);
      const element = observation?.elements?.[index];
      if (!element?.element_token) {
        throw new CuaBrokerError(
          "this element index has no live observation; call getAXState() on the bound app first",
          { code: "element_unavailable", details: { need: "getAXState" } },
        );
      }
      return { element_token: element.element_token };
    }
    if (target.type === "coordinate") {
      const { x, y } = target;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
        throw new CuaBrokerError("target coordinate must be two non-negative integer pixels", {
          code: "invalid_request",
        });
      }
      // 坐标属于某一张具体 raster。跨快照的坐标必须被拒，不能按最新截图解释。
      assertSnapshotBinding(target, observation);
      return { x, y };
    }
  }
  throw new CuaBrokerError("target must be {type:'element',index} or {type:'coordinate',x,y}", {
    code: "invalid_request",
  });
}
