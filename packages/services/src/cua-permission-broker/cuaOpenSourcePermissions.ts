/**
 * 开源构建的 Computer Use 权限探测。
 *
 * 背景：设置页的权限状态与授权引导原本全部走「官方 Helper」（
 * `ICuaPermissionService.getStatus` → Helper broker 的 `permission_status`；
 * `openCuaPermissionOnboarding` → Helper 安装 + 身份验签 + 拖拽进系统设置）。
 * 本构建不随包携带 Helper，这两条路都 fail-closed，表象是设置页两个权限行永远
 * 「未知」、授权按钮永远禁用/点了只弹「暂时无法确认」—— 用户因此无法触发
 * macOS 的辅助功能/屏幕录制授权，也就无法实际使用 Computer Use。
 *
 * 开源构建里权限真值的唯一来源是驱动自己：`@trycua/cua-driver` 的
 * `check_permissions`。实测 0.28.2 返回
 * `{accessibility, screen_recording, screen_recording_capturable,
 *   source:{executable, host_bundle_id, pid, responsible_ppid, note}}`，
 * 其中 `source` 明确写着嵌入式模式下这些布尔反映**宿主进程**的 TCC 授权
 * （驱动是宿主责任链上的子进程）。把它映射成 UI 的 `CuaPermissionStatus` 即可。
 *
 * 边界：
 * - 只读：不点击、不输入、不截图（`check_permissions` 无副作用）。
 * - 不自动拉起任何东西：探测失败只返回不可用与原因，绝不下载/安装 Helper。
 * - 驱动解析失败（平台不支持/未 stage）时返回 `available:false`，由调用方决定文案。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type CuaPermissionStateName = "granted" | "stale" | "denied" | "unknown";

export interface OpenSourceCuaPermissionReport {
  available: true;
  /** 授权主体（真实进程标识），UI 用它告诉用户该给谁授权。 */
  grantOwner: string;
  grantOwnerDisplayName: string | null;
  accessibility: CuaPermissionStateName;
  screenRecording: CuaPermissionStateName;
  screenCaptureProbeOk: boolean;
  /** 驱动自述的授权主体细节，供诊断。 */
  permissionSubject: string | null;
  note: string | null;
}

export interface OpenSourceCuaPermissionFailure {
  available: false;
  reason: string;
}

export type OpenSourceCuaPermissionResult =
  | OpenSourceCuaPermissionReport
  | OpenSourceCuaPermissionFailure;

/** 驱动在 agent bundle 里的落点（与 desktop 打包 staging 同一位置）。 */
export const OPEN_SOURCE_CUA_DRIVER_RELATIVE_PATH =
  "packages/node-repl-host/node_modules/@trycua/cua-driver/dist/index.js";

/** agent bundle 的 `glm` 目录候选：打包态 resourcesPath、显式覆盖、开发态 cwd。 */
export function candidateCuaAgentGlmRoots(input: {
  resourcesPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  platformKey?: string;
}): string[] {
  const roots: string[] = [];
  if (input.resourcesPath) roots.push(join(input.resourcesPath, "glm"));
  const override = input.env?.ZCODE_CUA_AGENT_GLM_DIR?.trim();
  if (override) roots.push(override);
  if (input.cwd && input.platformKey) {
    roots.push(resolve(input.cwd, "bundled-agents", input.platformKey, "glm"));
  }
  return roots;
}

/** 布尔 → UI 权限态。缺省/未知一律 unknown，不猜。 */
export function toPermissionStateName(value: unknown): CuaPermissionStateName {
  if (value === true) return "granted";
  if (value === false) return "denied";
  return "unknown";
}

/** 授权主体：优先 bundle id（用户在系统设置里看到的名字），退回可执行路径。 */
export function resolveGrantOwner(source: unknown): string {
  const record = (source ?? {}) as Record<string, unknown>;
  const bundleId = typeof record.host_bundle_id === "string" ? record.host_bundle_id.trim() : "";
  if (bundleId) return bundleId;
  const executable = typeof record.executable === "string" ? record.executable.trim() : "";
  if (executable) return executable;
  return "unknown";
}

/**
 * 驱动入口的候选位置。
 *
 * 打包态：`<resources>/glm/packages/node-repl-host/node_modules/...`；
 * 开发态：仓库 `packages/desktop/bundled-agents/<platform>/glm/...`。
 * 两条都由 `prepare:agent-bundle` 产出；都不存在时说明 agent bundle 没 stage，
 * 此时返回不可用，**不**去仓库 node_modules 里碰运气（那会让开发态偶然可用、
 * 安装态必坏，正是 PRD 要求避免的漂移）。
 */
export function candidateOpenSourceDriverEntries(glmRoots: readonly string[]): string[] {
  return glmRoots.map((root) => join(root, OPEN_SOURCE_CUA_DRIVER_RELATIVE_PATH));
}

export function resolveOpenSourceCuaDriverEntry(input: {
  glmRoots: readonly string[];
  exists?: (path: string) => boolean;
}): string | undefined {
  const exists = input.exists ?? existsSync;
  return candidateOpenSourceDriverEntries(input.glmRoots).find((candidate) => exists(candidate));
}

/** `check_permissions` 信封 → UI 状态。信封形状见文件头注释。 */
export function mapPermissionReportEnvelope(envelope: unknown): OpenSourceCuaPermissionResult {
  // 驱动 callTool 的 rawJson 是 MCP 工具结果：{content, structuredContent?, isError?}。
  const record = (envelope ?? {}) as Record<string, unknown>;
  const structured = record.structuredContent;
  if (!structured || typeof structured !== "object") {
    return { available: false, reason: "cua-driver returned no permission report" };
  }
  const fields = structured as Record<string, unknown>;
  const accessibility = toPermissionStateName(fields.accessibility);
  const screenRecording = toPermissionStateName(fields.screen_recording);
  if (accessibility === "unknown" && screenRecording === "unknown") {
    return {
      available: false,
      reason: "cua-driver could not determine macOS permissions",
    };
  }
  const source = (fields.source ?? {}) as Record<string, unknown>;
  const grantOwner = resolveGrantOwner(source);
  const note = typeof source.note === "string" ? source.note : null;
  return {
    available: true,
    grantOwner,
    grantOwnerDisplayName: grantOwner === "unknown" ? null : grantOwner,
    accessibility,
    screenRecording,
    screenCaptureProbeOk: fields.screen_recording_capturable === true,
    permissionSubject:
      typeof source.executable === "string" && source.executable ? source.executable : null,
    note,
  };
}

export interface ProbeOpenSourceCuaPermissionsOptions {
  /** `glm` 目录候选；缺省时按 resourcesPath / cwd / env 推导。 */
  glmRoots?: readonly string[];
  resourcesPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  platformKey?: string;
  /** 测试注入：返回一个能 callTool 的假驱动。 */
  createDriver?: () => Promise<{
    callTool(name: string, argsJson: string, options?: unknown): Promise<{ rawJson: string }>;
    shutdown?: () => Promise<void>;
    uniffiDestroy?: () => void;
  }>;
  importDriver?: (entry: string) => Promise<{
    CuaDriver: { create(options?: unknown): unknown };
  }>;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

/**
 * 探测开源驱动的权限状态。
 *
 * 只读、无副作用、失败不抛。每次探测独立创建/释放驱动实例：设置页的查询是
 * 低频事件（挂载/窗口聚焦/显式刷新），不该为了缓存一个 53MB 原生句柄而让
 * Electron main 常驻它。
 */
export async function probeOpenSourceCuaPermissions(
  options: ProbeOpenSourceCuaPermissionsOptions = {},
): Promise<OpenSourceCuaPermissionResult> {
  const glmRoots =
    options.glmRoots ??
    candidateCuaAgentGlmRoots({
      resourcesPath: options.resourcesPath,
      cwd: options.cwd,
      env: options.env,
      platformKey: options.platformKey,
    });
  const entry = resolveOpenSourceCuaDriverEntry({ glmRoots, exists: options.exists });
  if (!entry) {
    return {
      available: false,
      reason: "Computer Use driver is not staged in the agent bundle",
    };
  }
  let driver:
    | {
        callTool(name: string, argsJson: string, options?: unknown): Promise<{ rawJson: string }>;
        shutdown?: () => Promise<void>;
        uniffiDestroy?: () => void;
      }
    | undefined;
  try {
    if (options.createDriver) {
      driver = await options.createDriver();
    } else {
      const importDriver =
        options.importDriver ?? ((path: string) => import(pathToFileURL(path).href));
      const mod = await importDriver(entry);
      driver = mod.CuaDriver.create(undefined) as unknown as typeof driver;
    }
    if (!driver || typeof driver.callTool !== "function") {
      return { available: false, reason: "cua-driver did not expose callTool" };
    }
    const timeoutMs = options.timeoutMs ?? 8000;
    const raw = await driver.callTool("check_permissions", JSON.stringify({}), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = JSON.parse(raw.rawJson) as unknown;
    return mapPermissionReportEnvelope(parsed);
  } catch (error) {
    // 平台不支持（optionalDependencies 没装）、原生库加载失败、超时都在这里。
    return {
      available: false,
      reason: `cua-driver permission probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // 释放原生句柄：只删 JS 引用会让 Rust 对象留到进程退出。
    if (driver) {
      await Promise.resolve()
        .then(() => driver?.shutdown?.())
        .catch(() => undefined)
        .finally(() => {
          try {
            driver?.uniffiDestroy?.();
          } catch {
            // 已释放时重复销毁会抛，忽略。
          }
        });
    }
  }
}
