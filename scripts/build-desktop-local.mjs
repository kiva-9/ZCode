#!/usr/bin/env node
/**
 * 本地迭代打包：把产物落到 `packages/desktop/dist-local/`，不占用共享的 `dist/`。
 *
 * 为什么需要：`dist/` 是 electron-builder 的 `directories.output`，**每次构建前都会被清空**。
 * 多个会话/多个任务并行改代码时，别人跑一次 `pnpm --filter @zcode/desktop run bundle`
 * 就会把 `dist/` 里你正要用的解包 app 和安装包一起删掉 —— 实测已经发生过一次
 * （另一个会话构建后 `dist/mac-arm64/ZCode.app` 消失，指向它的启动器当场失效）。
 *
 * 做法：沿用仓库已有的隔离约定。`.gitignore` 里 `packages/desktop/dist-<arch>/` 本就是
 * 「CI 按架构隔离 electron-builder 输出目录」的产物规则；`ZCODE_DESKTOP_DIST_DIR`
 * 同时被 `scripts/bundle.mjs` 与 `electron-builder.config.js` 识别（相对 desktop 包根解析）。
 * 所以这里把输出改到 `dist-local/`：
 *   - 已被 .gitignore 覆盖，不会误提交；
 *   - 只用默认 `dist/` 的构建永远碰不到它；
 *   - 自己的每次构建照常整体刷新（可持续覆盖迭代）。
 *
 * 身份：默认 `ZCODE_ENV=production`（正式身份 `ZCode` / `dev.zcode.app`），
 * 与生产安装包同名同 id。要并排安装的 Preview 包显式传 `ZCODE_PREVIEW_IDENTITY=1`。
 *
 * 用法：
 *   node scripts/build-desktop-local.mjs                 # mac arm64：安装包 + 解包 app
 *   node scripts/build-desktop-local.mjs --skip-prepare  # agent bundle 已 stage 过时跳过准备（快很多）
 *   ZCODE_LOCAL_CODESIGN=1 node scripts/build-desktop-local.mjs  # 用本地证书签名（默认关，见下方说明）
 *   node scripts/build-desktop-local.mjs --no-sign       # 跳过本地证书签名
 *   node scripts/build-desktop-local.mjs --os win        # 其它平台（透传给 bundle.mjs）
 *
 * 其它透传参数见 `node packages/desktop/scripts/bundle.mjs --help`。
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const desktopRoot = resolve(repoRoot, "packages/desktop");
const distDirName = "dist-local";
/**
 * 本地自签名证书的 CN（由 scripts/setup-local-codesign-cert.mjs 生成并导入登录钥匙串）。
 * 用它签名后 macOS TCC 按「bundle id + 证书」绑定授权，重建不再失效；
 * ad-hoc 签名只能按 CDHash 绑定，每次构建都要重新授权。
 */
const LOCAL_CODESIGN_IDENTITY = "ZCode Local Dev Codesign";
const LOCAL_CODESIGN_CERT_DIR = join(homedir(), ".zcode-local-codesign");
// 只透传 bundle.mjs 真实支持的参数；不自己发明开关（曾发明过 --zip-only，
// 被 bundle.mjs 的严格参数校验直接拒掉）。
const PASSTHROUGH_ARGS = new Set(["--dry-run", "--skip-prepare", "--skip-build"]);
const args = process.argv.slice(2);
const passthrough = args.filter((arg) => PASSTHROUGH_ARGS.has(arg));
const skipSign = args.includes("--no-sign");

function run(command, commandArgs, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      // Windows 上 pnpm 是 .cmd；shell:true 只影响 .cmd 查找，参数仍按数组传递。
      shell: process.platform === "win32",
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`),
      );
    });
  });
}

/**
 * 本地证书是否可用（用 codesign 实签判定，不靠 find-identity —— 私钥 ACL 下它枚举不到）。
 */
function localCodesignAvailable() {
  try {
    const probe = join(LOCAL_CODESIGN_CERT_DIR, ".probe");
    if (!existsSync(LOCAL_CODESIGN_CERT_DIR)) return false;
    writeFileSync(probe, "probe");
    const result = spawnSync("codesign", ["--force", "--sign", LOCAL_CODESIGN_IDENTITY, probe], {
      encoding: "utf8",
    });
    const detail = spawnSync("codesign", ["-dvv", probe], { encoding: "utf8" });
    rmSync(probe, { force: true });
    const authority = `${detail.stdout ?? ""}${detail.stderr ?? ""}`
      .match(/Authority=(.+)/)?.[1]
      ?.trim();
    return result.status === 0 && authority === LOCAL_CODESIGN_IDENTITY;
  } catch {
    return false;
  }
}

/**
 * 给解包 app 签名并严格校验。
 *
 * 只用 `--force --deep --sign`：实测（0.28.2 之后的 Electron 41 产物）一步通过，
 * 嵌套的 Frameworks/*.app 由 --deep 覆盖，且 `codesign --verify --deep --strict` 通过。
 * 不要在签名前先单独签嵌套 bundle：外层 app 的 CodeResources 会记录嵌套件哈希，
 * 先改嵌套件再签外层时报 "unsealed contents"（实测踩过）。
 */
function signMacApp(appPath) {
  run("codesign", ["--force", "--deep", "--sign", LOCAL_CODESIGN_IDENTITY, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const env = {
  ...process.env,
  ZCODE_ENV: "production",
  ZCODE_DESKTOP_DIST_DIR: distDirName,
};

const bundleArgs = ["--filter", "@zcode/desktop", "run", "bundle", "--", ...passthrough];

console.log(
  `[build:desktop:local] 输出目录 packages/desktop/${distDirName}/（已被 .gitignore 覆盖）`,
);
console.log("[build:desktop:local] 身份：production（ZCode / dev.zcode.app）");
if (passthrough.length > 0) console.log(`[build:desktop:local] 透传参数：${passthrough.join(" ")}`);

await run(pnpmCommand, bundleArgs, env);

const distRoot = resolve(desktopRoot, distDirName);
const appPath = resolve(distRoot, "mac-arm64", "ZCode.app");
const dmgPath = resolve(distRoot, "ZCode-3.14.3-mac-arm64.dmg");
const zipPath = resolve(distRoot, "ZCode-3.14.3-mac-arm64.zip");

// 签名（显式 opt-in，默认关闭）：让 TCC 授权跨构建保持稳定（ad-hoc 每次重建
// CDHash 都变，授权静默失效）。
//
// 为什么默认关闭：本地自签名证书能用 `codesign --verify --deep --strict`
// （实测通过），但**签名后的 app 能否正常启动尚未结论** —— 同一时段未签名的 app
// 也不启动（系统应用 TextEdit 正常），怀疑是图形会话层面的问题。接手人复测确认
// app 能起来后再改成默认开启。
//
//   ZCODE_LOCAL_CODESIGN=1 node scripts/build-desktop-local.mjs   # 开启签名
//   node scripts/build-desktop-local.mjs --no-sign               # 显式跳过
if (
  process.platform === "darwin" &&
  !skipSign &&
  process.env.ZCODE_LOCAL_CODESIGN === "1" &&
  existsSync(appPath)
) {
  if (localCodesignAvailable()) {
    console.log(`[build:desktop:local] 用本地证书签名（${LOCAL_CODESIGN_IDENTITY}）…`);
    try {
      signMacApp(appPath);
      console.log("[build:desktop:local] ✅ 签名并校验通过");
    } catch (error) {
      console.log(
        `[build:desktop:local] ⚠️ 签名失败，保留原产物（仍是 ad-hoc）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    console.log(
      "[build:desktop:local] ⚠️ 未找到本地签名证书，跳过签名（TCC 授权将在下次重建后失效）。" +
        "修复：node scripts/setup-local-codesign-cert.mjs",
    );
  }
}

console.log("\n[build:desktop:local] 完成，产物：");
if (existsSync(appPath)) console.log(`  解包 app  ${appPath}`);
if (existsSync(dmgPath)) console.log(`  安装包    ${dmgPath}`);
if (existsSync(zipPath)) console.log(`  zip       ${zipPath}`);
console.log("\n提示：这些路径不会被其他会话的构建清掉；下次构建会整体刷新同一目录。");
