export interface CuaObservationRecord {
  key: string;
  seq: number;
  capturedAt: number;
  stateId?: string;
  sessionKey: string;
  appKey: string;
  windowId: number | string;
  pid: number;
  appName: string | null;
  bundleId: string | null;
  windowTitle: string | null;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  screenshot: { width: number; height: number; scale: number; mimeType: string } | null;
  captureMode: string;
  elementCount: number;
  totalElementCount: number | null;
  elementsComplete: boolean;
  elements: unknown[];
  text: string;
  degraded: boolean;
  degradedReason: string | null;
  backgroundInput: unknown;
  escalation: unknown;
  captureCoverage: unknown;
}

export interface CreateObservationRegistryOptions {
  maxEntries?: number;
  now?: () => number;
}

export declare function createObservationRegistry(options?: CreateObservationRegistryOptions): {
  readonly size: number;
  record(input: Omit<CuaObservationRecord, "key" | "seq" | "capturedAt">): CuaObservationRecord;
  get(key: string): CuaObservationRecord | undefined;
  latestForSession(sessionKey: string): CuaObservationRecord | undefined;
  drop(key: string): void;
  dropSession(sessionKey: string): number;
  dropProcess(sessionKey: string, pid: number): number;
  clear(): void;
  summarize(): Array<Record<string, unknown>>;
};
