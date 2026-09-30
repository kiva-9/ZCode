export interface CuaLeaseHolder {
  sessionKey: string;
  pid: number;
  hostname: string;
  platform: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface CuaLeaseAcquireResult {
  ok: boolean;
  reason?: "unavailable" | "busy";
  message?: string;
  holder?: CuaLeaseHolder;
}

export declare function createDesktopControlLease(options: {
  sessionKey: string;
  now?: () => number;
}): {
  readonly leasePath: string;
  acquire(): Promise<CuaLeaseAcquireResult>;
  heartbeat(): boolean;
  release(): boolean;
  holder(): CuaLeaseHolder | undefined;
  isHeldByUs(): boolean;
};

export declare const CUA_LEASE_STALE_MS: number;
