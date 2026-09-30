/**
 * 应用与窗口解析，以及「观察 → 记录 + 模型可见 state」的塑形。
 *
 * 独立成文件的理由：这两段是纯协议翻译（app_ref → pid/window_id、驱动元素行 → 模型
 * 元素表、get_window_state → image + image_ref 规范帧对），不涉及运行时门禁。
 * 方法表（cua-driver-methods.js）与运行时（cua-driver-runtime.js）都复用它。
 *
 * 与 CE 参考实现的差异（都来自 0.28.2 实测，见 docs/development/computer-use.md）：
 * 1. 窗口尺寸取 `bounds`（CE 读扁平 width/height，在 0.28.2 上会判 모든 窗口不可用）。
 * 2. `launch_app` 用 bundle_id / name（CE 传 launch_path，0.28.2 schema 无该字段）。
 * 3. 观察记录按 (会话, 应用, 窗口) 归档，并保留坐标变换所需事实（bounds、截图宽高/缩放）。
 * 4. degraded / background_input / escalation / capture_coverage 全部带给模型。
 */

import { CuaBrokerError } from "./cua-driver-errors.js";
import {
  appKeyOf,
  matchesRef,
  observationKeyOf,
  pickWindow,
  toElement,
  usableWindows,
} from "./cua-driver-targets.js";
import { attachOfficialCuaFrame, buildOfficialCuaImageRef } from "./frame-contract.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "./host-display-contract.js";
import { imageBlock, okResult, textBlock } from "./cua-driver-errors.js";

/** app_ref 的展示名与 appKey（`<scheme>:<value>`，UI 据此派生图标定位）。 */
export function appIdentityOf(app) {
  const appKey = appKeyOf({ bundle_id: app.bundle_id, pid: app.pid, name: app.name });
  const displayName = typeof app.name === "string" && app.name.trim() ? app.name.trim() : appKey;
  return { appKey, displayName };
}

/** 目标应用身份写进结果 `_meta`：宿主据此在卡片上显示应用名与图标。 */
export function primaryAssociationOf(app) {
  const { appKey, displayName } = appIdentityOf(app);
  return { [CUA_APP_ASSOCIATIONS_META_KEY]: { primary: { appKey, displayName } } };
}

/**
 * 取信封里的第一张 raster。
 *
 * 两种形状都要认：MCP content 块是 `{type:"image", data, mimeType}`（callTool 的
 * rawJson 走的形态），而 typed API 的 `WindowStateOutput.images[]` 是
 * `{mimeType, dataBase64}`。只认一种会在另一种形态上静默丢图 —— 那正是
 * 「UI 有图、模型没图」这类故障的根因。
 */
export function firstRasterOf(envelope) {
  for (const block of envelope.images ?? []) {
    const base64 = typeof block?.dataBase64 === "string" ? block.dataBase64 : block?.data;
    if (typeof base64 === "string" && base64) {
      return { base64, mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined };
    }
  }
  return undefined;
}

export function createCuaAppResolver(deps) {
  let appCache;
  const loadApps = async (signal, { fresh = false } = {}) => {
    if (!appCache || fresh) {
      const envelope = await deps.callDriver("list_apps", {}, signal);
      appCache = Array.isArray(envelope.structured.apps) ? envelope.structured.apps : [];
    }
    return appCache;
  };
  /**
   * app_ref → 运行中的应用行。
   *
   * 未运行但有可寻址身份时按 CE 契约透明拉起一次（getApp 的语义是「需要时后台启动」）。
   * 0.28.2 的 launch_app 只认 bundle_id / name —— CE 传的 launch_path 会被 schema 拒掉，
   * 这里按锁定版本修正（详见 docs/development/computer-use.md 兼容性表）。
   */
  const resolveApp = async (appRef, signal) => {
    if (!appRef || typeof appRef !== "object") {
      throw new CuaBrokerError("app_ref is required", { code: "invalid_request" });
    }
    const find = (apps) =>
      apps.find((app) => app.running && app.pid > 0 && matchesRef(app, appRef));
    let hit = find(await loadApps(signal));
    if (!hit) {
      const candidate = (await loadApps(signal)).find((app) => matchesRef(app, appRef));
      if (candidate?.bundle_id || candidate?.name) {
        try {
          await deps.callDriver(
            "launch_app",
            candidate.bundle_id ? { bundle_id: candidate.bundle_id } : { name: candidate.name },
            signal,
          );
        } catch {
          // 拉起失败不在这里抛：下面的重新查找会给出「找不到应用」这个更准确的结论。
        }
        appCache = undefined;
        hit = find(await loadApps(signal, { fresh: true }));
      }
    }
    if (!hit) {
      // 客户端把「target app is not running」当作可换字段重试的信号，文案必须保留这句。
      throw new CuaBrokerError(
        `target app is not running, and no installed application matched the ${appRef.bundle_id ? "bundle id" : "name"} ${appRef.bundle_id ?? appRef.name ?? appRef.pid}`,
        { code: "element_unavailable", details: { appRef } },
      );
    }
    return hit;
  };
  const listWindowsOf = async (pid, signal) => {
    const envelope = await deps.callDriver("list_windows", pid ? { pid } : {}, signal);
    return usableWindows(envelope.structured.windows);
  };
  const resolveAppWindow = async (appRef, signal) => {
    const app = await resolveApp(appRef, signal);
    const windows = await listWindowsOf(app.pid, signal);
    const wanted = typeof appRef.window_id === "number" ? appRef.window_id : undefined;
    const window = pickWindow(windows, wanted);
    if (!window) {
      throw new CuaBrokerError(
        wanted === undefined
          ? `app "${app.name}" has no open window`
          : `window ${wanted} of "${app.name}" is not open; call list_windows to pick a fresh window_id`,
        { code: "element_unavailable" },
      );
    }
    return { app, window };
  };
  /** 一次 get_window_state → 观察记录（供索引解析）+ 模型可见 state。 */
  const captureObservation = async (context, target, args, signal) => {
    const envelope = await deps.callDriver(
      "get_window_state",
      {
        pid: target.app.pid,
        window_id: target.windowId,
        include_accessibility_tree: args?.include_accessibility_tree !== false,
        include_screenshot: args?.include_screenshot === true,
        ...(args?.max_elements === undefined ? {} : { max_elements: args.max_elements }),
        ...(args?.max_depth === undefined ? {} : { max_depth: args.max_depth }),
      },
      signal,
    );
    const structured = envelope.structured;
    const elements = (Array.isArray(structured.elements) ? structured.elements : []).map(toElement);
    const stateId = typeof structured.snapshot_id === "string" ? structured.snapshot_id : undefined;
    const degradedReason =
      typeof structured.degraded_reason === "string" ? structured.degraded_reason : null;
    const record = {
      key: observationKeyOf(deps.sessionKeyOf(context), target.appRef, target.windowId),
      stateId,
      sessionKey: deps.sessionKeyOf(context),
      appKey: appKeyOf(target.appRef),
      windowId: target.windowId,
      pid: target.app.pid,
      appName: target.app.name ?? null,
      bundleId: target.app.bundle_id ?? null,
      windowTitle: structured.window_title ?? null,
      windowBounds: structured.window_bounds ?? null,
      screenshot:
        structured.screenshot_width && structured.screenshot_height
          ? {
              width: structured.screenshot_width,
              height: structured.screenshot_height,
              scale:
                typeof structured.screenshot_scale === "number" ? structured.screenshot_scale : 1,
              mimeType: structured.screenshot_mime_type ?? "image/png",
            }
          : null,
      captureMode:
        typeof structured.capture_mode === "string"
          ? structured.capture_mode
          : (args?.mode ?? "ax"),
      elementCount: elements.length,
      totalElementCount:
        structured.total_element_count === undefined
          ? null
          : Number(structured.total_element_count),
      elementsComplete: structured.elements_complete !== false,
      elements,
      text: typeof structured.tree_markdown === "string" ? structured.tree_markdown : "",
      degraded: structured.degraded === true,
      degradedReason,
      backgroundInput: structured.background_input ?? null,
      escalation: structured.escalation ?? null,
      captureCoverage: structured.capture_coverage ?? null,
    };
    deps.observations.record(record);
    return { record, envelope };
  };
  /** 模型可见的观察体：state 小字段 + 树文本 + 告知性文本块。 */
  const observationStateOf = (record) => {
    return {
      state_id: record.stateId ?? null,
      app: { pid: record.pid, name: record.appName, bundle_id: record.bundleId },
      window: {
        window_id: record.windowId,
        title: record.windowTitle,
        bounds: record.windowBounds,
      },
      elements: record.elements,
      element_count: record.elementCount,
      ...(record.totalElementCount === null
        ? {}
        : { total_element_count: record.totalElementCount }),
      ...(record.elementsComplete ? {} : { elements_complete: false }),
      ...(record.degradedReason ? { non_actionable_reason: record.degradedReason } : {}),
      ...(record.backgroundInput ? { background_input: record.backgroundInput } : {}),
      ...(record.escalation ? { escalation: record.escalation } : {}),
      ...(record.captureCoverage ? { capture_coverage: record.captureCoverage } : {}),
    };
  };
  /** 观察结果 → MCP 结果（截图走 image + image_ref 规范形态）。 */
  const observationResult = (record, envelope, { emitTree = true } = {}) => {
    const content = [];
    const image = firstRasterOf(envelope);
    if (image) {
      const mimeType = image.mimeType ?? record.screenshot?.mimeType ?? "image/png";
      const ref = buildOfficialCuaImageRef({
        frameId: record.stateId ?? `frame-${record.seq}`,
        stateId: record.stateId ?? null,
        mimeType,
        width: record.screenshot?.width ?? null,
        height: record.screenshot?.height ?? null,
        scale: record.screenshot?.scale ?? null,
        dataBase64: image.base64,
      });
      content.push(imageBlock(image.base64, mimeType), textBlock(ref.text));
    }
    if (emitTree && record.text) content.push(textBlock(record.text));
    // 降级必须说清原因：实测里 AX 未解析的窗口会拿到空树，没有这句模型只能反复重观察。
    if (record.degradedReason) {
      content.push(
        textBlock(
          `[observation degraded: ${record.degradedReason}] The accessibility tree for this window is empty on purpose. ` +
            "Element indices are unavailable; use list_windows to pick another window, or ask the user to bring the app to the current Space.",
        ),
      );
    }
    const screenshotError = envelope.structured.screenshot_error;
    if (screenshotError) {
      const reason =
        typeof screenshotError === "string"
          ? screenshotError
          : (screenshotError.reason ?? screenshotError.code ?? "unknown");
      content.push(textBlock(`[screenshot unavailable: ${reason}]`));
    }
    const result = okResult({ content, structuredContent: observationStateOf(record) });
    return image ? attachOfficialCuaFrame(result) : result;
  };
  const withAppAssociation = (result, app) => ({
    ...result,
    _meta: { ...result._meta, ...primaryAssociationOf(app) },
  });

  return {
    loadApps,
    resolveApp,
    listWindowsOf,
    resolveAppWindow,
    captureObservation,
    observationStateOf,
    observationResult,
    withAppAssociation,
    appIdentityOf,
  };
}
