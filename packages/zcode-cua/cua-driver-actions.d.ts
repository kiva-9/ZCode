export declare function requireText(value: unknown, what: string): string;
export interface CuaActionPlan {
  tool: string;
  target?: (args: Record<string, any>) => unknown;
  args: (args: Record<string, any>) => Record<string, unknown>;
}
export declare const CUA_ACTIONS: Readonly<Record<string, (a: any) => CuaActionPlan>>;
export declare const DELIBERATELY_UNAVAILABLE_METHODS: readonly string[];
export declare const CUA_ACTION_METHOD_NAMES: readonly string[];
