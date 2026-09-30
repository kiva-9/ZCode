/**
 * 桌面控制租约：同一台受控桌面上，首版只允许一个活动控制会话（PRD FR-09 / AC-19）。
 *
 * 为什么不能只用进程内变量：ZCode 可以同时开多个窗口 / 多个 workspace，每个都会起自己的
 * node_repl host 进程，各自持有一份 JavaScript 状态。进程内锁对他们彼此不可见，于是
 * 「单桌面单控制」这条边界会在多窗口下静默失效。
 *
 * 实现要点：
 * - 锁文件放在每用户临时目录（`os.tmpdir()`），跨进程可见；文件名带 uid/host/platform，
 *   避免多用户共用一台机器时互相看到对方的租约。
 * - `O_EXCL` 创建即持约；`heartbeat()` 原子重写续期；`release()` 删除。
 * - 陈旧判定：文件超期 **且** 记录里的 pid 已不存在才允许接管。只凭超时接管会在
 *   「对方活着但忙」时抢走桌面，所以 pid 活性是必要条件。
 * - 文件系统不可用时**失败关闭**（返回不可用并说明原因），不静默降级成无租约运行。
 *   临时目录基本总能写；真遇到只读环境时，明确不可用比悄悄放行安全。
 *
 * 局限（已记录，未验证项）：按「每用户」而非「每登录桌面会话」划分。同一用户开多个
 * GUI 会话（快速用户切换）时会共享一个租约文件 —— 首版可接受，因为 ZCode 桌面版本身
 * 也是每用户单实例为主。
 */
import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir, hostname, userInfo } from "node:os";
import { join } from "node:path";
const LEASE_DIR_NAME = "zcode-cua-lease";
const LEASE_FILE_NAME = "desktop-control-lease.json";
const LEASE_STALE_MS = 30_000;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户 —— 仍然算「活着」。
    return error?.code === "EPERM";
  }
}
function leaseDir() {
  let uid = "0";
  try {
    uid = String(userInfo().uid);
  } catch {
    // userInfo 在极少数容器环境会抛；退回固定命名空间，仍按 host 隔离。
  }
  const dir = join(tmpdir(), `${LEASE_DIR_NAME}-${uid}-${hostname()}-${process.platform}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 交给调用方按不可用处理。
  }
  return dir;
}
function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
function writeHolderAtomically(path, holder) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeSync(openSync(tmp, "w"), JSON.stringify(holder));
  renameSync(tmp, path);
}
function holderIsStale(holder, nowMs) {
  const heartbeat = Date.parse(holder?.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeat)) return true;
  if (nowMs - heartbeat <= LEASE_STALE_MS) return false;
  // 超期后仍要求 pid 死亡：对方可能只是卡在一次长动作上。
  return !pidAlive(holder.pid);
}
export function createDesktopControlLease(options) {
  const now = options.now ?? (() => Date.now());
  const dir = leaseDir();
  const path = join(dir, LEASE_FILE_NAME);
  let held = false;
  const self = () => ({
    sessionKey: options.sessionKey,
    pid: process.pid,
    hostname: hostname(),
    platform: process.platform,
    acquiredAt: new Date(now()).toISOString(),
    heartbeatAt: new Date(now()).toISOString(),
  });
  return {
    leasePath: path,
    async acquire() {
      if (held) return { ok: true };
      const attempt = self();
      try {
        const fd = openSync(path, "wx");
        try {
          writeSync(fd, JSON.stringify(attempt));
        } finally {
          closeSync(fd);
        }
        held = true;
        return { ok: true };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          return {
            ok: false,
            reason: "unavailable",
            message: `desktop control lease is unavailable (${error?.code ?? "unknown"}): ${path}`,
          };
        }
      }
      const holder = readHolder(path);
      if (!holder) {
        // 锁文件存在但读不出来：内容损坏或竞态。不接管（可能是别人的半写状态），
        // 明确报告占用，让用户重试或清理临时目录。
        return {
          ok: false,
          reason: "busy",
          message:
            "desktop control lease exists but could not be read; another Computer Use session may be starting. Retry shortly.",
        };
      }
      if (!holderIsStale(holder, now())) {
        return {
          ok: false,
          reason: "busy",
          holder,
          message:
            `another Computer Use session already controls this desktop ` +
            `(session ${holder.sessionKey}, pid ${holder.pid}). Only one active control session is supported.`,
        };
      }
      // 陈旧租约：接管前保留旧持有者信息，便于诊断「上一个会话为什么没了」。
      try {
        writeHolderAtomically(path, attempt);
        held = true;
        return { ok: true };
      } catch (writeError) {
        return {
          ok: false,
          reason: "unavailable",
          message: `desktop control lease could not be refreshed: ${writeError?.code ?? "unknown"}`,
        };
      }
    },
    heartbeat() {
      if (!held) return false;
      try {
        const current = readHolder(path);
        writeHolderAtomically(path, {
          ...self(),
          acquiredAt: current?.acquiredAt ?? new Date(now()).toISOString(),
        });
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (!held) return false;
      held = false;
      try {
        const current = readHolder(path);
        // 只删自己的租约：别人的（接管后的）不能顺手删掉。
        if (!current || current.pid === process.pid) unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
    holder() {
      if (!existsSync(path)) return undefined;
      return readHolder(path);
    },
    isHeldByUs() {
      return held;
    },
  };
}
export const CUA_LEASE_STALE_MS = LEASE_STALE_MS;
