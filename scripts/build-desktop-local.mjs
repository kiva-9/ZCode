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
 *   node scripts/build-desktop-local.mjs --os win        # 其它平台（透传给 bundle.mjs）
 *
 * 其它透传参数见 `node packages/desktop/scripts/bundle.mjs --help`。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const desktopRoot = resolve(repoRoot, "packages/desktop");
const distDirName = "dist-local";
// 只透传 bundle.mjs 真实支持的参数；不自己发明开关（曾发明过 --zip-only，
// 被 bundle.mjs 的严格参数校验直接拒掉）。
const PASSTHROUGH_ARGS = new Set(["--dry-run", "--skip-prepare", "--skip-build"]);
const args = process.argv.slice(2);
const passthrough = args.filter((arg) => PASSTHROUGH_ARGS.has(arg));

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

console.log("\n[build:desktop:local] 完成，产物：");
if (existsSync(appPath)) console.log(`  解包 app  ${appPath}`);
if (existsSync(dmgPath)) console.log(`  安装包    ${dmgPath}`);
if (existsSync(zipPath)) console.log(`  zip       ${zipPath}`);
console.log("\n提示：这些路径不会被其他会话的构建清掉；下次构建会整体刷新同一目录。");
