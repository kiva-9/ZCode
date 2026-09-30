import type { CuaVerificationState } from "./cua-driver-errors.js";

export interface ComputerUseRuntimeContext {
  sessionId: string;
  runtimeScope: "main" | "subagent";
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  turnId?: string;
  clientMode?: "web-remote-replayable" | "desktop-continuous";
  deliveryKind?: "web-remote-replayable" | "desktop-continuous";
  trace?: Record<string, unknown>;
}

export interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}

export interface ComputerUseRuntime {
  execute(input: ComputerUseRuntimeExecuteInput): Promise<unknown>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface ComputerUseRuntimeOptions {
  driver?: "open-source" | "disabled";
  /** 官方 Helper 的 broker socket。本包不消费，仅保留以兼容既有装配点。 */
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  /** 测试注入点：生产装配点永不传入。 */
  loadDriver?: () => Promise<unknown>;
}

export interface CuaActionReceipt {
  method: string;
  action_id: string;
  accepted: boolean;
  delivery: "not_sent" | "sent" | "possibly_sent" | "unknown";
  verification: CuaVerificationState;
  before_state_id: string | null;
  after_state_id: string | null;
  requires_approval: boolean;
  observation_error?: string;
}

export interface CreateCuaDriverRuntimeOptions {
  loadDriver?: () => Promise<unknown>;
  driverVersion?: string | null;
}

export declare function createCuaDriverRuntime(
  options?: CreateCuaDriverRuntimeOptions,
): ComputerUseRuntime & {
  CUA_METHOD_NAMES: readonly string[];
  CUA_DRIVER_SUPPORTED_PLATFORMS: readonly string[];
};

export declare const CUA_DRIVER_SUPPORTED_PLATFORMS: readonly string[];
export declare const CUA_METHOD_NAMES: readonly string[];
