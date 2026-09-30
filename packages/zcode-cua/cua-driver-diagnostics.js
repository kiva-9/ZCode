/**
 * 能力检测与诊断导出（PRD FR-01 / FR-12）。
 *
 * 独立成文件的理由：这两个方法是**只读**的，且回答的是「这台机器能不能用 Computer Use」
 * 与「导出给人看的诊断包」，与动作/观察的协议翻译无关。分开之后，门禁（运行时）与
 * 协议翻译（methods/apps）都不会因为它们变长而被稀释。
 *
 * 两条硬约束：
 * - 不执行任何点击或输入（诊断只在出错时更有用，不能自己制造故障）。
 * - 默认不含输入正文、完整 AX 树与截图；导出的观察记录只有摘要。
 */

import {
  baseEnvironmentReport,
  isCuaDriverResolvable,
  readHealthReport,
  readPermissionReport,
} from "./cua-driver-capabilities.js";
import { okResult, jsonBlock } from "./cua-driver-errors.js";

export function createCuaDiagnostics(deps) {
  const methodGetCapabilities = async (context, signal) => {
    const environment = baseEnvironmentReport();
    let permissions;
    try {
      permissions = readPermissionReport(await deps.callDriver("check_permissions", {}, signal));
    } catch (error) {
      permissions = {
        accessibility: "error",
        screenRecording: "error",
        screenRecordingCapturable: "error",
        permissionSubject: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    let health = null;
    try {
      health = readHealthReport(await deps.callDriver("health_report", {}, signal));
    } catch {
      // health_report 缺失不影响其它能力项。
    }
    // driverInfo 放在探测之后读：驱动是懒加载的，此刻才真的知道版本与来源。
    const driverInfo = deps.driverInfo();
    const report = {
      ...environment,
      driver: {
        package: "@trycua/cua-driver",
        version: health?.driverVersion ?? driverInfo.version,
        loaded: true,
        loadSource: driverInfo.source,
        supportedPlatform: environment.isSupportedPlatformTriple,
      },
      nativeDependencies: {
        present: environment.isSupportedPlatformTriple,
        detail: environment.isSupportedPlatformTriple
          ? `platform package @trycua/cua-driver-${environment.platformTriple} resolved`
          : `no prebuilt driver package for ${environment.platformTriple}`,
      },
      systemPermissions: permissions,
      observation: {
        accessibilityTree:
          permissions.accessibility === "granted" ? "granted" : permissions.accessibility,
        windowCapture:
          permissions.screenRecording === "granted" ? "granted" : permissions.screenRecording,
        backgroundInput: "unknown",
      },
      modelImageTransport: {
        screenshotProducible: "unknown",
        modelCanReadImages: "unknown",
        providerCanCarryToolImages: "unknown",
        note: "Whether the active model can read images and whether the provider can carry tool images is decided by the host's provider layer, not here. Use mode 'ax' when the model is text-only.",
      },
      session: {
        leaseHeld: deps.leaseStatus(deps.sessionKeyOf(context)).held,
        leaseHolder: deps.leaseStatus(deps.sessionKeyOf(context)).holder ?? null,
        stopped: deps.isStopped?.(context) ?? false,
        observations: deps.observations.size,
      },
      ...(health ? { health: { overall: health.overall, checks: health.checks.length } } : {}),
    };
    return okResult({ content: [jsonBlock(report)], structuredContent: report });
  };
  /**
   * 诊断导出（PRD FR-12）：只读，不执行任何点击或输入。
   *
   * 默认不含输入正文、完整 AX 树与截图；观察记录只给**摘要**（不含元素全表）。
   * 调用方（UI 导出）负责让用户先预览再落盘。
   */
  const methodGetDiagnostics = async (context, signal) => {
    let health;
    try {
      health = readHealthReport(await deps.callDriver("health_report", {}, signal));
    } catch (error) {
      health = {
        overall: "error",
        error: error instanceof Error ? error.message : String(error),
        checks: [],
      };
    }
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: {
        pid: process.pid,
        node: process.version,
        stats: deps.stats(),
        driverResolvable: isCuaDriverResolvable(),
        driver: deps.driverInfo(),
      },
      lease: (() => {
        const status = deps.leaseStatus(deps.sessionKeyOf(context));
        return { held: status.held, holder: status.holder, path: status.path };
      })(),
      observations: deps.observations.summarize(),
      health,
    };
    return okResult({ content: [jsonBlock(report)], structuredContent: report });
  };

  return { methodGetCapabilities, methodGetDiagnostics };
}
