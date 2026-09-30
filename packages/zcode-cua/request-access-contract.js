/**
 * `request_access` 的状态信封契约。
 *
 * 权威定义在 packages/shared/src/zcode-protocol-v4/cuaPermission.ts（zod，strict）。
 * 本包不能依赖 zod（它是零依赖的 Node/渲染共用层），所以这里手写同一套判据：
 * 两侧必须逐字一致，否则 UI 会在「权限状态」上静默降级。改这一处必须同步那一处
 * （packages/services/test 与 bootstrap 的单测都钉着这个 schema）。
 *
 * platform 目前只有 "darwin"：macOS 的 TCC 模型是这个信封存在的原因；Windows/Linux
 * 的权限由驱动自己的能力探测表达，不塞进这个 schema。
 */
export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";

const ACCESSIBILITY = new Set(["granted", "stale", "denied"]);
const SCREEN_RECORDING = new Set(["granted", "denied", "unknown"]);

export function isCuaRequestAccessStatus(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input;
  if (value.schemaVersion !== 1) return false;
  if (value.platform !== "darwin") return false;
  if (typeof value.grantOwner !== "string" || value.grantOwner.length < 1) return false;
  if (typeof value.accessibility !== "string" || !ACCESSIBILITY.has(value.accessibility))
    return false;
  if (typeof value.screenRecording !== "string" || !SCREEN_RECORDING.has(value.screenRecording)) {
    return false;
  }
  // strict：多一个键就不认。UI 按这个 schema 渲染权限行，宽松解析会把未知状态显示成已授权。
  return Object.keys(value).length === 5;
}

export const cuaRequestAccessStatusSchema = {
  safeParse(input) {
    if (!isCuaRequestAccessStatus(input)) {
      return {
        success: false,
        error: new Error(
          "Computer Use request-access status does not match schemaVersion 1 (darwin only)",
        ),
      };
    }
    return { success: true, data: input };
  },
};
