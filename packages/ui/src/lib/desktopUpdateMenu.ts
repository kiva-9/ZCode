import {
  ZCODE_DISABLE_UPDATES,
  ZCODE_PRODUCT_FLAVOR,
  type ZCodeProductFlavor,
  type UpdateStatePayload,
} from "@zcode/shared";

// 更新入口跟随产品身份而不是后端环境：Preview 身份（含生产后端的 Preview）禁用更新器。
// fork/自建包可注入构建期 ZCODE_DISABLE_UPDATES=1，production 身份下也隐藏全部入口；
// main 侧 updater 未初始化时这里的可见性只是第二道 UI 门，不承担安全性。
export function shouldShowDesktopUpdateEntry(
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
  updatesDisabled: boolean = ZCODE_DISABLE_UPDATES,
): boolean {
  return flavor === "production" && !updatesDisabled;
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
