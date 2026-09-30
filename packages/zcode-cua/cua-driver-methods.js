/**
 * CUA capability method 的实现：list_apps / list_windows / get_app_state / 动作七件套 /
 * request_access / get_capabilities / get_diagnostics / stop_computer_control。
 *
 * 这一层只做「协议翻译 + 结果塑形」，生命周期（驱动加载、串行化、dispose）与门禁
 * （停止、租约、子代理）在 cua-driver-runtime.js。分开放是为了让任一半都能被单独测试：
 * 这里的每个函数都用注入的 callDriver，无图形会话也能跑。
 *
 * 与 CE 参考实现的差异（都来自锁定版本实测 + PRD）：
 * 1. 窗口解析用 `bounds`（CE 读扁字段，见 cua-driver-targets.js 的说明）。
 * 2. `launch_app` 用 bundle_id/name（CE 传 launch_path，0.28.2 的 schema 没有该字段）。
 * 3. 观察结果把 `degraded` / `degraded_reason` / `background_input` / `escalation` /
 *    `capture_coverage` 全部带给模型。CE 把它们丢了 —— 而实测里「AX 未解析」的窗口
 *    会拿到**空树**，不说原因模型只会反复重新观察（Electron 应用尤其常见）。
 * 4. 截图走 frame-contract 的 image + image_ref 规范形态，宿主据此走 exact-raster 路径。
 */
import { randomUUID } from "node:crypto";
import {
  CuaBrokerError,
  actionDelivered,
  errorResult,
  imageBlock,
  jsonBlock,
  okResult,
  textBlock,
  deliveryState,
  verificationStateForEffect,
} from "./cua-driver-errors.js";
import { CUA_ACTIONS } from "./cua-driver-actions.js";
import { observationKeyOf, resolveTarget, usableWindows } from "./cua-driver-targets.js";
import { appIdentityOf } from "./cua-driver-apps.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "./host-display-contract.js";
import {
  CUA_METHOD_CLASS,
  classifyCuaMethod,
  requiresActionApproval,
} from "./cua-capability-policy.js";
import { createCuaDiagnostics } from "./cua-driver-diagnostics.js";
import { createCuaAppResolver } from "./cua-driver-apps.js";
/** 帧对必须排在 content 最前（core 投影器对非规范布局直接抛错）。 */
function normalizeFrameFirst(result) {
  if (!Array.isArray(result.content) || result.content.length < 2) return result;
  const imageIndex = result.content.findIndex((block) => block?.type === "image");
  if (imageIndex <= 0) return result;
  const image = result.content[imageIndex];
  const rest = result.content.filter((_, index) => index !== imageIndex);
  return { ...result, content: [image, ...rest] };
}
export function createCuaMethods(deps) {
  // 应用/窗口解析与观察塑形是纯协议翻译，独立成模块；这里只消费它的出口。
  const { methodGetCapabilities, methodGetDiagnostics } = createCuaDiagnostics(deps);
  const {
    loadApps,
    resolveApp,
    resolveAppWindow,
    captureObservation,
    observationResult,
    withAppAssociation,
  } = createCuaAppResolver(deps);
  const methodGetAppState = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    const { record, envelope } = await captureObservation(
      context,
      { appRef, app, windowId: window.window_id },
      args,
      signal,
    );
    // 空树 + 无快照身份 = 这次观察没有可用元素。返回错误而不是一个 state_id 为 null 的
    // 「成功」：客户端会把缺 state_id 判成 STRUCTURED_STATE_UNAVAILABLE，但那时已经
    // 拿不到 degraded_reason 了。在这里给全信息，并归 element_unavailable（先重新观察/换窗口）。
    if (record.degraded && record.elementCount === 0 && !record.stateId) {
      return errorResult({
        code: "element_unavailable",
        message:
          `observation of "${app.name}" window ${window.window_id} produced no usable elements: ${record.degradedReason ?? "degraded"}. ` +
          "Call list_windows to choose a window that is on the current Space, or ask the user to activate the app.",
        details: { app: app.name, windowId: window.window_id, reason: record.degradedReason },
      });
    }
    return withAppAssociation(observationResult(record, envelope), app);
  };
  // ─────────────────────────────────────────── 动作
  /**
   * 动作的完整链路（PRD §7.3）：
   * 目标与快照检查 → 硬阻断 → 投递前复检停止 → 单次驱动调用 → 保存回执与投递态 →
   * 使旧坐标快照失效 → 按策略取新观察 → 分别回传执行结果/观察结果/验证状态。
   */
  const runAction = async (context, methodName, args, signal) => {
    const plan = CUA_ACTIONS[methodName](args ?? {});
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    const observationKey = observationKeyOf(deps.sessionKeyOf(context), appRef, window.window_id);
    const observation = deps.observations.get(observationKey);
    // target 可选：type/key 不带目标（输入落到当前焦点），click/scroll 必填。
    const requested = plan.target?.(args);
    const target = requested === undefined ? {} : resolveTarget(requested, observation);
    const actionId = randomUUID();
    const beforeStateId = observation?.stateId ?? null;
    const needsApproval = requiresActionApproval(methodName);
    let envelope;
    try {
      envelope = await deps.callDriver(
        plan.tool,
        { pid: app.pid, window_id: window.window_id, ...target, ...plan.args(args) },
        signal,
      );
    } catch (error) {
      if (error instanceof CuaBrokerError) {
        // 投递未知（超时/取消）与明确未投递必须分开；见 deliveryState 的注释。
        const aborted = signal?.aborted === true;
        const refused = error.actionSent !== true && !aborted;
        const receipt = {
          method: methodName,
          action_id: actionId,
          accepted: true,
          delivery: deliveryState({ delivered: false, aborted, refused }),
          verification: "not_run",
          before_state_id: beforeStateId,
          requires_approval: needsApproval,
        };
        return errorResult({
          code: error.code,
          message: error.message,
          actionSent: error.actionSent,
          details: error.details,
          cua: receipt,
        });
      }
      throw error;
    }
    const delivered = actionDelivered(envelope);
    const effect = envelope.structured.effect;
    let verification = verificationStateForEffect(effect);
    let afterStateId = null;
    let observationError = null;
    let afterImage = null;
    let afterText = "";
    const mutation = classifyCuaMethod(methodName) !== CUA_METHOD_CLASS.readOnly;
    if (delivered && mutation && args?.capture_after !== false) {
      // 默认动作后观察（PRD FR-06）。失败不推翻已投递的事实：结果未确认，
      // 但绝不能把「新截图失败」说成「动作失败」。
      try {
        const captured = await captureObservation(
          context,
          { appRef, app, windowId: window.window_id },
          {},
          signal,
        );
        afterStateId = captured.record.stateId ?? null;
        if (afterStateId && afterStateId !== beforeStateId) verification = "observed_change";
        if (verification === "not_run") verification = "observed_change";
        afterText = captured.record.text;
        afterImage = captured.envelope.images.find(
          (block) => typeof block?.dataBase64 === "string",
        );
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error);
        verification = "inconclusive";
      }
    }
    // 显式语义校验（可选）：verify_state 的谓词由调用方给出，通过才记
    // expected_state_confirmed。不用它冒充「任务完成」—— 那只能由模型/用户判断。
    if (delivered && Array.isArray(args?.expect) && args.expect.length > 0) {
      try {
        const verify = await deps.callDriver(
          "verify_state",
          {
            pid: app.pid,
            window_id: window.window_id,
            expect: args.expect,
            ...(Number.isInteger(args.verify_timeout_ms)
              ? { timeout_ms: args.verify_timeout_ms }
              : {}),
          },
          signal,
        );
        const status = String(verify.structured.status ?? "");
        verification = status === "satisfied" ? "expected_state_confirmed" : "inconclusive";
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error);
        verification = "inconclusive";
      }
    }
    const content = [];
    if (args?.capture_after_text !== false) {
      if (afterText) {
        content.push(
          textBlock(`[state after action · ${afterStateId ?? "no-snapshot"}]\n${afterText}`),
        );
      }
      if (afterImage) {
        content.push(imageBlock(afterImage.base64, afterImage.mimeType ?? "image/png"));
      }
    }
    if (observationError) {
      content.push(
        textBlock(`[observation after action failed: ${observationError}] result is unconfirmed.`),
      );
    }
    for (const text of envelope.texts) content.push(textBlock(text));
    const structured = {
      ...envelope.structured,
      action_id: actionId,
      ...(delivered ? { action_sent: true, dispatch_status: "possibly_sent" } : {}),
      cua: {
        method: methodName,
        action_id: actionId,
        accepted: true,
        delivery: delivered ? "sent" : "not_sent",
        verification,
        before_state_id: beforeStateId,
        after_state_id: afterStateId,
        requires_approval: needsApproval,
        ...(observationError ? { observation_error: observationError } : {}),
      },
    };
    const result = okResult({ content, structuredContent: structured });
    return normalizeFrameFirst(withAppAssociation(result, app));
  };
  // ─────────────────────────────────────────── 只读 / 诊断 / 生命周期
  const methodListApps = async (context, signal) => {
    const apps = await loadApps(signal, { fresh: true });
    // 驱动在 Linux 上把 800+ 个进程全当应用返回（systemd/kworker 都在里面）。
    // 只保留用户可寻址的目标：XDG 桌面项，或当前持有窗口的进程。
    const owners = new Set(
      usableWindows((await deps.callDriver("list_windows", {}, signal)).structured.windows).map(
        (w) => w.pid,
      ),
    );
    const visible = apps.filter(
      (app) => app.kind === "desktop" || (app.running && app.pid > 0 && owners.has(app.pid)),
    );
    const items = visible.map((app) => appIdentityOf(app));
    return okResult({
      content: [jsonBlock({ apps: visible })],
      structuredContent: { apps: visible },
      _meta: { [CUA_APP_ASSOCIATIONS_META_KEY]: { mode: "items", items } },
    });
  };
  const methodListWindows = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const pid = appRef ? (await resolveApp(appRef, signal)).pid : undefined;
    const envelope = await deps.callDriver("list_windows", pid ? { pid } : {}, signal);
    const windows = usableWindows(envelope.structured.windows);
    return okResult({
      content: [jsonBlock({ windows })],
      structuredContent: { windows },
    });
  };
  /**
   * 权限状态（request_access）。
   *
   * 只读不投递；返回体带 permission_subject —— 实测 0.28.2 的 check_permissions 会
   * 给出嵌入式运行时下的真实授权主体（宿主进程），PRD FR-01 要求它可诊断。
   */
  const methodRequestAccess = async (context, signal) => {
    const envelope = await deps.callDriver("check_permissions", {}, signal);
    const permissions = readPermissionReport(envelope);
    const status = {
      ready: permissions.accessibility === "granted" && permissions.screenRecording === "granted",
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
      screen_recording_capturable: permissions.screenRecordingCapturable,
      permission_subject: permissions.permissionSubject,
      message: envelope.texts.join("\n"),
      ...(permissions.detail ? { note: permissions.detail } : {}),
    };
    // darwin 上同时按 request-access 信封写 _meta：设置页的权限行与一次性授权指引
    // 读的是这个 key（schema 见 request-access-contract.js，权威定义在
    // packages/shared/src/zcode-protocol-v4/cuaPermission.ts）。其它平台不写 ——
    // 那个 schema 的 platform 字段只接受 darwin，塞假值会让 UI 误判。
    const darwinStatus =
      process.platform === "darwin" && permissions.permissionSubject
        ? {
            schemaVersion: 1,
            platform: "darwin",
            grantOwner: permissions.permissionSubject,
            accessibility:
              permissions.accessibility === "granted"
                ? "granted"
                : permissions.accessibility === "denied"
                  ? "denied"
                  : permissions.accessibility === "error"
                    ? "denied"
                    : "stale",
            screenRecording:
              permissions.screenRecording === "granted"
                ? "granted"
                : permissions.screenRecording === "denied"
                  ? "denied"
                  : "unknown",
          }
        : undefined;
    return okResult({
      content: [jsonBlock(status)],
      structuredContent: status,
      ...(darwinStatus ? { _meta: { [CUA_REQUEST_ACCESS_STATUS_META_KEY]: darwinStatus } } : {}),
    });
  };
  const methodStop = (context, args) =>
    okResult({
      structuredContent: { stopped: true, reason: args?.reason ?? null },
      content: [jsonBlock({ stopped: true, reason: args?.reason ?? null })],
    });
  return {
    methodListApps,
    methodListWindows,
    methodGetAppState,
    methodRequestAccess,
    methodGetCapabilities,
    methodGetDiagnostics,
    methodStop,
    runAction,
  };
}
export { CUA_METHOD_CLASS };
