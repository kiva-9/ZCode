import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowDesktopUpdateEntry } from "./desktopUpdateMenu.js";

/**
 * 更新入口可见性回归（docs/specs/2026-09-30-desktop-update-disable-switch.md）。
 *
 * fork/自建包通过构建期 ZCODE_DISABLE_UPDATES=1 禁用更新体系；这里钉住
 * production 身份 + 未禁用时入口保持可见（官方构建行为不变），以及两种禁用路径
 * （Preview 身份、构建开关）都隐藏入口。未注入 define 时 ZCODE_DISABLE_UPDATES
 * 恒为 false，测试显式传参，不依赖构建环境。
 */
test("production 身份且未禁用时显示更新入口", () => {
  assert.equal(shouldShowDesktopUpdateEntry("production", false), true);
});

test("Preview 身份隐藏更新入口", () => {
  assert.equal(shouldShowDesktopUpdateEntry("preview", false), false);
});

test("构建期禁用开关隐藏更新入口", () => {
  assert.equal(shouldShowDesktopUpdateEntry("production", true), false);
  assert.equal(shouldShowDesktopUpdateEntry("preview", true), false);
});
