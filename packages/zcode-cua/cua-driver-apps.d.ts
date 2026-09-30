import type { CuaDriverEnvelope } from "./cua-driver-errors.js";

export interface CuaAppResolverDeps {
  callDriver(toolName: string, args: unknown, signal?: AbortSignal): Promise<CuaDriverEnvelope>;
  sessionKeyOf(context: unknown): string;
  observations: {
    record(input: Record<string, unknown>): { key: string; seq: number; stateId?: string };
  };
}

export declare function appIdentityOf(app: Record<string, any>): {
  appKey: string;
  displayName: string;
};
export declare function primaryAssociationOf(app: Record<string, any>): Record<string, unknown>;

export interface CuaObservationTarget {
  appRef: unknown;
  app: { pid: number; name?: string; bundle_id?: string };
  windowId: number | string;
}

export declare function createCuaAppResolver(deps: CuaAppResolverDeps): {
  loadApps(
    signal?: AbortSignal,
    options?: { fresh?: boolean },
  ): Promise<Array<Record<string, any>>>;
  resolveApp(appRef: unknown, signal?: AbortSignal): Promise<Record<string, any>>;
  listWindowsOf(pid: number, signal?: AbortSignal): Promise<Array<Record<string, any>>>;
  resolveAppWindow(
    appRef: unknown,
    signal?: AbortSignal,
  ): Promise<{ app: Record<string, any>; window: Record<string, any> }>;
  captureObservation(
    context: unknown,
    target: CuaObservationTarget,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ record: Record<string, any>; envelope: CuaDriverEnvelope }>;
  observationStateOf(record: Record<string, any>): Record<string, unknown>;
  observationResult(
    record: Record<string, any>,
    envelope: CuaDriverEnvelope,
    options?: { emitTree?: boolean },
  ): Record<string, any>;
  withAppAssociation(result: Record<string, any>, app: Record<string, any>): Record<string, any>;
  appIdentityOf(app: Record<string, any>): { appKey: string; displayName: string };
};
