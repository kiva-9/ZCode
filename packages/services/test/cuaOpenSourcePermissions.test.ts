import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateCuaAgentGlmRoots,
  candidateOpenSourceDriverEntries,
  mapPermissionReportEnvelope,
  probeOpenSourceCuaPermissions,
  resolveGrantOwner,
  resolveOpenSourceCuaDriverEntry,
  toPermissionStateName,
} from "../src/cua-permission-broker/cuaOpenSourcePermissions.js";

/**
 * 开源构建的权限探测回归。
 *
 * 背景：设置页的权限状态与授权引导原本全部走官方 Helper；本构建不随包携带 Helper，
 * 于是两个权限行永远「未知」、授权按钮永远不可用，用户无法触发 macOS 系统授权。
 * 这一层把权限真值改到开源驱动自己的 `check_permissions`（只读）。
 *
 * 运行：cd packages/services && node --import tsx --test test/cuaOpenSourcePermissions.test.ts
 */

/** 造一个「驱动已 stage」的 glm 目录，供 createDriver 注入点使用。 */
function stagedGlmRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-cua-staged-"));
  const dist = join(dir, "glm", "packages/node-repl-host/node_modules/@trycua/cua-driver/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "export {};\n");
  return join(dir, "glm");
}

const envelope = (structured: unknown) => ({
  rawJson: JSON.stringify({ structuredContent: structured }),
});

/** 与 0.28.2 实测一致的 check_permissions 信封（含 source 自述的授权主体）。 */
const grantedEnvelope = envelope({
  accessibility: true,
  screen_recording: true,
  screen_recording_capturable: null,
  source: {
    executable: "/usr/local/bin/node",
    host_bundle_id: "dev.zcode.app",
    pid: 123,
    responsible_ppid: 120,
    note: "Embedded mode: these booleans reflect the HOST app's TCC grant",
  },
});

test("granted/denied/unknown 三态映射不猜", () => {
  assert.equal(toPermissionStateName(true), "granted");
  assert.equal(toPermissionStateName(false), "denied");
  assert.equal(toPermissionStateName(undefined), "unknown");
  assert.equal(toPermissionStateName("granted"), "unknown");
});

test("授权主体优先 bundle id，退回可执行路径", () => {
  assert.equal(
    resolveGrantOwner({ host_bundle_id: "dev.zcode.app", executable: "/x" }),
    "dev.zcode.app",
  );
  assert.equal(
    resolveGrantOwner({ host_bundle_id: "", executable: "/usr/local/bin/node" }),
    "/usr/local/bin/node",
  );
  assert.equal(resolveGrantOwner({}), "unknown");
  assert.equal(resolveGrantOwner(undefined), "unknown");
});

test("驱动报告的 TCC 真值映射成 UI 状态", () => {
  const result = mapPermissionReportEnvelope(JSON.parse(grantedEnvelope.rawJson));
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.accessibility, "granted");
  assert.equal(result.screenRecording, "granted");
  assert.equal(result.grantOwner, "dev.zcode.app");
  assert.equal(result.permissionSubject, "/usr/local/bin/node");
  assert.match(String(result.note), /HOST app's TCC grant/u);
});

test("denied 一样要报出来（不是未知）", () => {
  const result = mapPermissionReportEnvelope(
    JSON.parse(
      envelope({ accessibility: true, screen_recording: false, source: { executable: "/x" } })
        .rawJson,
    ),
  );
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.accessibility, "granted");
  assert.equal(result.screenRecording, "denied");
  assert.equal(result.grantOwner, "/x");
});

test("两个轴都未知 → 判为不可用，不伪装成已授权", () => {
  const result = mapPermissionReportEnvelope(
    JSON.parse(envelope({ accessibility: undefined, screen_recording: undefined }).rawJson),
  );
  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /could not determine/u);
});

test("没有 structuredContent → 不可用", () => {
  assert.equal(mapPermissionReportEnvelope({}).available, false);
  assert.equal(mapPermissionReportEnvelope(null).available, false);
});

test("glm 根候选：打包态 / 显式覆盖 / 开发态 cwd", () => {
  const roots = candidateCuaAgentGlmRoots({
    resourcesPath: "/Applications/ZCode.app/Contents/Resources",
    cwd: "/repo/packages/desktop",
    env: { ZCODE_CUA_AGENT_GLM_DIR: "/custom/glm" },
    platformKey: "darwin-arm64",
  });
  assert.deepEqual(roots, [
    "/Applications/ZCode.app/Contents/Resources/glm",
    "/custom/glm",
    "/repo/packages/desktop/bundled-agents/darwin-arm64/glm",
  ]);
});

test("驱动入口按候选顺序取第一个存在的", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-cua-probe-"));
  try {
    const glm = join(dir, "glm");
    const missing = join(glm, "packages/node-repl-host/node_modules/@trycua/cua-driver/dist");
    assert.equal(resolveOpenSourceCuaDriverEntry({ glmRoots: [glm] }), undefined);
    mkdirSync(missing, { recursive: true });
    writeFileSync(join(missing, "index.js"), "export {};\n");
    assert.equal(resolveOpenSourceCuaDriverEntry({ glmRoots: [glm] }), join(missing, "index.js"));
    // 候选路径全部指向同一个相对落点。
    assert.deepEqual(candidateOpenSourceDriverEntries([glm]), [join(missing, "index.js")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("探测成功：经 createDriver 注入点拿到真值", async () => {
  const result = await probeOpenSourceCuaPermissions({
    glmRoots: [stagedGlmRoot()],
    createDriver: async () => ({
      callTool: async (name: string) => {
        assert.equal(name, "check_permissions");
        return grantedEnvelope;
      },
      shutdown: async () => {},
      uniffiDestroy: () => {},
    }),
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.accessibility, "granted");
  assert.equal(result.screenRecording, "granted");
});

test("探测失败不抛：驱动不可加载 → 不可用 + 原因", async () => {
  const result = await probeOpenSourceCuaPermissions({
    glmRoots: [stagedGlmRoot()],
    createDriver: async () => {
      throw new Error("no platform binary for this target");
    },
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /no platform binary/u);
});

test("没有 stage 驱动 → 不可用（不去仓库 node_modules 碰运气）", async () => {
  const result = await probeOpenSourceCuaPermissions({
    glmRoots: [join(tmpdir(), "definitely-missing-glm-root")],
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /not staged/u);
});

test("释放原生句柄：shutdown + uniffiDestroy 各一次", async () => {
  let shutdowns = 0;
  let destroys = 0;
  await probeOpenSourceCuaPermissions({
    glmRoots: [stagedGlmRoot()],
    createDriver: async () => ({
      callTool: async () => grantedEnvelope,
      shutdown: async () => {
        shutdowns += 1;
      },
      uniffiDestroy: () => {
        destroys += 1;
      },
    }),
  });
  assert.equal(shutdowns, 1);
  assert.equal(destroys, 1);
});
