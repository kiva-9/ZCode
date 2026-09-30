export type CapabilityState = "granted" | "denied" | "unknown" | "unsupported" | "error";
export declare const CUA_DRIVER_PACKAGE: string;
export declare const CUA_DRIVER_SUPPORTED_PLATFORMS: readonly string[];
export declare function currentPlatformTriple(): string;
export declare function isSupportedPlatformTriple(): boolean;
export declare function isCuaDriverResolvable(): boolean;
export declare function readPermissionReport(envelope: unknown): {
  accessibility: CapabilityState;
  screenRecording: CapabilityState;
  screenRecordingCapturable: CapabilityState;
  permissionSubject: string | null;
  detail?: string;
};
export declare function readHealthReport(envelope: unknown): {
  overall: string;
  driverVersion: string | null;
  platform: unknown;
  schemaVersion: unknown;
  checks: Array<Record<string, unknown>>;
};
export declare function readDriverVersion(driver: unknown): string | null;
export declare function baseEnvironmentReport(): Record<string, unknown>;
