# 桌面端更新体系编译期禁用开关（ZCODE_DISABLE_UPDATES）Spec

- 日期：2026-09-30
- 状态：已实现

## 1. 背景

fork/自建打包的桌面端默认继承 production 身份，自动更新器（`initAutoUpdater`）与远端强制升级门（`forceUpdateGuard`）都会启用，并向官方端点（`https://zcode.z.ai`）请求发布 manifest 与 client configs。自建包带有大量包内定制，一旦执行更新会被官方安装包就地覆盖；强更门还可能依服务端策略阻断启动。需要一个**构建期**开关让 fork 构建彻底脱离官方更新体系（零出网、零入口），且不改变应用身份（区别于 `ZCODE_PREVIEW_IDENTITY`，后者会更换 appId/productName/数据目录）。

## 2. 行为

- 新增构建期开关 `ZCODE_DISABLE_UPDATES`（环境变量，值精确为 `1` 开启，其余/未设置关闭，语义与 `ZCODE_PREVIEW_IDENTITY` 的单拼写规则一致）。
- 由 `packages/desktop/scripts/desktop-product-identity.mjs` 的 `isDesktopUpdatesDisabled(env)` 统一解析，`tsup.config.ts`（main/preload/host/scheduler/plugin-sandbox）与 `vite.config.ts`（renderer）注入 define `__ZCODE_DISABLE_UPDATES__`。
- `packages/shared/src/env.ts` 暴露编译期常量 `ZCODE_DISABLE_UPDATES: boolean`（沿用 `__ZCODE_PRODUCT_FLAVOR__` 的 `typeof` 守卫模式；未注入 define 的 bundle——web、CLI、测试——恒为 `false`，不影响既有包）。
- 开关为真时：
  1. `initAutoUpdater({ enabled: false })`：`autoUpdaterDisabledForProductFlavor = true`，不调用 `setFeedURL`、不建轮询定时器、不发任何更新请求；手动检查命中 `autoUpdater.ts` 的 fail-closed 守卫。
  2. 强更门跳过：不请求 `/api/v1/client/configs`，不弹强制升级对话框。
  3. 全部更新入口隐藏：应用菜单（macOS/其他平台两处）、Windows 托盘、`DesktopCommandIds.CheckForUpdates` 命令、渲染层标题栏更新按钮（`shouldShowDesktopUpdateEntry`）。
- 开关为假时行为与现状完全一致（默认不变，官方构建不受影响）。

## 3. 所有权与不变量

- **单一事实源**：开关的解析只存在于 `desktop-product-identity.mjs`（构建期）与 `shared/env.ts`（运行时常量），各消费方读共享常量，不得自行读环境变量二次判定。
- **fail-closed**：任何拼拼写错误（`"true"`、`"0 "`）都视为关闭，不产生半开状态；运行时无动态改道入口（与 `resolveUpdateFeedSourceFromStartupConfig` 在 packaged 下忽略覆盖的既有立场一致：更新行为不允许被运行时环境改变）。
- **不新增状态所有者**：本开关只收紧既有门禁条件，不引入新状态、事件或持久化字段；`enabled: false` 路径复用 `autoUpdaterDisabledForProductFlavor` 既有守卫。

## 4. 验收场景

1. `ZCODE_DISABLE_UPDATES=1` 构建：启动日志无 `[auto-update] initializing`、无 `[force-update]` 检查请求；菜单/托盘/标题栏无更新入口；进程不对 `zcode.z.ai` 发起 releases/manifest 或 client/configs 请求。
2. 未设置开关的构建：`typecheck`/`lint` 后行为与改动前一致，现有更新链路（菜单项、弹窗、轮询）不变。
3. `shouldShowDesktopUpdateEntry` 单测：production+未禁用 → 显示；preview → 隐藏；production+禁用 → 隐藏。

## 5. 明确不做

- 不剔除更新体系代码（协议字段、`IPlatformService` 契约、设置 schema、i18n 保持不动），保证与上游合并的兼容性。
- 不处理设置页内「接收 Preview 更新 / 自动下载并安装」开关的隐藏（开关为真时它们写入的偏好不会被消费，属无害死配置）。
