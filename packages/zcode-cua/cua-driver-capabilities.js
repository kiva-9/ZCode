/**
 * 能力检测（PRD FR-01）：把「驱动包存在」与「能力真的可用」分成两件事。
 *
 * 每一项都要能回答四个状态之一：unknown / unauthorized / unsupported / error。
 * 只报 `true/false` 会让「没测」和「测了不行」看起来一模一样，故障因此不可诊断。
 *
 * 权限主体（实测 0.28.2 + `check_permissions` 的 source 字段）：
 * 嵌入式运行时里驱动是宿主进程的子进程，TCC 授权归**宿主进程**（node_repl host，
 * 其责任链上游是 ZCode 应用）。驱动自己从不弹权限框；权限缺失时由宿主应用请求。
 * 所以这里报的 accessibility/screenRecording 就是当前进程的真实授权状态，
 * 而不是某个假设存在的 Helper 的身份（Hermes 文档里的 `CuaDriver.app` /
 * `com.trycua.driver` 属于它的 daemon 启动链路，不适用于本仓库的嵌入式路径）。
 */
import { arch, platform, release, type } from "node:os";
export const CUA_DRIVER_PACKAGE = "@trycua/cua-driver";
/** 驱动有预编译二进制的目标三元组（0.28.2 optionalDependencies 矩阵）。 */
export const CUA_DRIVER_SUPPORTED_PLATFORMS = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
  "win32-arm64-msvc",
]);
export function currentPlatformTriple() {
  const os = platform();
  const cpu = arch();
  if (os === "darwin") return cpu === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (os === "win32") return cpu === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  if (os === "linux") {
    const libc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? "gnu" : "musl";
    return cpu === "arm64" ? `linux-arm64-${libc}` : `linux-x64-${libc}`;
  }
  return `${os}-${cpu}`;
}
export function isSupportedPlatformTriple() {
  return CUA_DRIVER_SUPPORTED_PLATFORMS.includes(currentPlatformTriple());
}
/**
 * 驱动是否可能在本机加载。
 *
 * 只做**解析**检查，不 import：`import()` 会真的加载原生库（53MB dylib + 初始化），
 * 而能力检测可能在未启用/未授权的会话里被调用。ESM-only 的包必须用
 * `import.meta.resolve`；`createRequire().resolve` 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 把「包在但只有 import 条件」误判成「包不在」。
 */
export function isCuaDriverResolvable() {
  try {
    import.meta.resolve(CUA_DRIVER_PACKAGE);
    return true;
  } catch {
    return false;
  }
}
function permissionState(value, { granted = [true], denied = [false] } = {}) {
  if (value === undefined || value === null) return "unknown";
  if (granted.includes(value)) return "granted";
  if (denied.includes(value)) return "denied";
  return "unknown";
}
/**
 * `check_permissions` 的信封 → 权限段。
 *
 * 0.28.2 返回 `{accessibility, screen_recording, screen_recording_capturable,
 * direct_capture_status, source:{executable, host_bundle_id, pid, responsible_ppid, note}}`。
 */
export function readPermissionReport(envelope) {
  const structured = envelope?.structured ?? {};
  const source = structured.source ?? {};
  const subject =
    typeof source.executable === "string" && source.executable
      ? `${source.executable}${source.host_bundle_id ? ` (${source.host_bundle_id})` : ""}`
      : (source.host_bundle_id ?? null);
  return {
    accessibility: permissionState(structured.accessibility),
    screenRecording: permissionState(structured.screen_recording),
    screenRecordingCapturable: permissionState(structured.screen_recording_capturable),
    permissionSubject: subject,
    detail: typeof source.note === "string" ? source.note : undefined,
  };
}
/** `health_report` 的信封 → 检查项列表（供诊断面板与 doctor）。 */
export function readHealthReport(envelope) {
  const structured = envelope?.structured ?? {};
  const checks = Array.isArray(structured.checks) ? structured.checks : [];
  return {
    overall: typeof structured.overall === "string" ? structured.overall : "unknown",
    driverVersion: structured.driver_version ?? null,
    platform: structured.platform ?? null,
    schemaVersion: structured.schema_version ?? null,
    checks: checks.map((check) => ({
      name: String(check?.name ?? "unknown"),
      status: String(check?.status ?? "unknown"),
      message: typeof check?.message === "string" ? check.message : "",
      ...(check?.hint ? { hint: String(check.hint) } : {}),
      ...(check?.data ? { data: check.data } : {}),
    })),
  };
}
/** 驱动版本的兜底读取：metadata() 在嵌入式模式下可能返回空对象。 */
export function readDriverVersion(driver) {
  try {
    const metadata = driver?.metadata?.();
    if (metadata && typeof metadata === "object" && metadata.driverVersion) {
      return String(metadata.driverVersion);
    }
  } catch {
    // metadata 可能不存在或抛；忽略，走 health_report 路径。
  }
  return null;
}
export function baseEnvironmentReport() {
  return {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    osType: type(),
    platformTriple: currentPlatformTriple(),
    isSupportedPlatformTriple: isSupportedPlatformTriple(),
  };
}
