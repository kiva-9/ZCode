import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSectionEnabled } from "../lib/settingsNavigation.js";
import { createSettingsPageConfig } from "./settingsPageConfig.js";

/**
 * 电脑控制设置入口的可见性回归。
 *
 * 背景：开源版不随包携带 Computer Use 期间，`computerUse` 被放进
 * settingsNavigation 的 HIDDEN_SETTINGS_SECTIONS，设置页因此**没有这个入口** ——
 * 用户无法启用插件、看不到权限状态，也就无法触发 macOS 授权，功能整体不可发现。
 * 运行时换成 @trycua/cua-driver 后入口已放开；这两个用例钉住它不再被隐藏，
 * 且仍然只在桌面端出现（Web 继续不展示）。
 */

test("computerUse 不再是隐藏分区", () => {
  assert.equal(isSettingsSectionEnabled("computerUse"), true);
  // 其余三个隐藏项的产品理由不变，不能顺带放开。
  assert.equal(isSettingsSectionEnabled("automations"), false);
  assert.equal(isSettingsSectionEnabled("plugins"), false);
  assert.equal(isSettingsSectionEnabled("workspaceFileSearch"), false);
});

test("桌面端设置页包含电脑控制分区", () => {
  for (const options of [{ isDesktop: true }, { isMacDesktop: true }, { isWindowsDesktop: true }]) {
    const { settingsSections } = createSettingsPageConfig(options);
    assert.equal(
      settingsSections.some((section) => section.id === "computerUse"),
      true,
      JSON.stringify(options),
    );
  }
});

test("Web（非桌面）设置页不包含电脑控制分区", () => {
  const { settingsSections } = createSettingsPageConfig({});
  assert.equal(
    settingsSections.some((section) => section.id === "computerUse"),
    false,
  );
});
