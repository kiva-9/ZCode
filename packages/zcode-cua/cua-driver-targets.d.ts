export declare const MIN_WINDOW_EDGE_PX: number;
export declare function appKeyOf(appRef: unknown): string;
export declare function observationKeyOf(
  sessionKey: string,
  appRef: unknown,
  windowId: unknown,
): string;
export declare function observationKeyPrefix(sessionKey: string): string;
export declare function matchesRef(app: Record<string, any>, appRef: unknown): boolean;
export declare function windowArea(window: unknown): number;
export declare function usableWindows(windows: unknown): Array<Record<string, any>>;
export declare function pickWindow(
  windows: Array<Record<string, any>>,
  windowId?: number,
): Record<string, any> | undefined;
export declare function toElement(raw: Record<string, any>): Record<string, any>;
export declare function resolveTarget(
  target: unknown,
  observation: { elements?: unknown[]; stateId?: string } | undefined,
): { element_token: string } | { x: number; y: number };
