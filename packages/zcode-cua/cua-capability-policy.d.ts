export type CuaHardBlock = { code: string; message: string };
export declare const CUA_METHOD_CLASS: Readonly<{
  readOnly: "read_only";
  input: "input";
  mutating: "mutating";
  lifecycle: "lifecycle";
  diagnostic: "diagnostic";
  unknown: "unknown";
}>;
export declare function classifyCuaMethod(name: string): string;
export declare function requiresActionApproval(name: string): boolean;
export declare function hardBlockFor(method: string, args: unknown): CuaHardBlock | undefined;
export declare const BLOCKED_KEY_CHORDS: readonly string[];
export declare function assertNoHardBlock(method: string, args: unknown): void;
