# Computer Use 集成 — 交接提示词（给接手的开发者）

> 用途：把下面内容整段交给下一位开发者（人或 Agent），他应当能在不重复提问的情况下
> 继续完成剩余验证。生成时间：2026-09-30。仓库：`/Users/kiva/Documents/Zcode`。
> **推送目标**：用户已授权将本地 `main` 的全部提交推送到 fork `kiva-9/ZCode` 的 `origin/main`。
> 实时同步状态以 `git fetch origin` 后的 `git status` 为准。

---

## 1. 这个任务是什么

在 ZCode 开源版里补齐基于 Cua 的桌面控制能力，参考 PRD：
`/Users/kiva/Downloads/ZCode_Computer_Use_PRD.md`（必读，尤其是 §7 验收流程和 AC-01～AC-30）。

设计记录（已包含源码地图、驱动兼容性表、移植修正清单、真实验证报告）：
`docs/development/computer-use.md`。使用文档：`docs/computer-use.md`。

一句话现状：**新包已重建，官方 MCP client 握手、手动签名副本启动、真实模型的
TextEdit「观察 → setValue → 读回 → SDK stop」已通过。设置页权限仍显示「未知」，
截图及 GUI 停止按钮等验收仍未完成。用户本次明确不新增屏幕录制授权，要求收尾。**
最新证据、检查结果及隔离边界见 `docs/development/computer-use.md` §8.1。

## 2. 现在能跑通 / 不能跑通

| 已实跑通过                                                                             | 证据                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 驱动在进程内加载（`@trycua/cua-driver@0.28.2`，darwin-arm64）                          | `docs/development/computer-use.md` §8                                                  |
| 方法路由 / stop / 租约 / 快照绑定的契约回归                                            | `packages/zcode-cua/test` **53 例全过（假驱动，不等于所有原生动作实测）**              |
| 截图→模型链路（真实 raster + image_ref + 完整性 attestation + 宿主 exact-raster 路径） | 同上，6/6 真机                                                                         |
| 安装包首启（AC-28）：干净 HOME + 安装包 node_modules 里加载驱动                        | 同上，7/7                                                                              |
| 设置页启用、真实模型 TextEdit 写入/读回、SDK stop                                      | 2026-09-30 新包真实会话；独立 AX 读回相同测试字符串                                    |
| 官方 SDK 2.0.0 MCP stdio 握手及工具调用                                                | 新包 host，协议 pin `2026-07-28`，`connect/listTools/callTool` 通过                    |
| 手动自签名副本启动                                                                     | 深度签名与严格验证通过；新进程存活并显示登录页，未测公证/Gatekeeper                    |
| typecheck / lint                                                                       | root typecheck 通过；root lint 67 warnings/0 errors；CLI typecheck 通过，CLI lint 失败 |
| **当前构建出的 app**                                                                   | `packages/desktop/dist-local/mac-arm64/ZCode.app`（正式身份 `dev.zcode.app` / 3.14.3） |

| 未验证（这就是你要做的）    | 说明                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| **完整 GUI 回路与权限引导** | 设置页两个权限行仍「未知」；点击权限链接未确认打开系统设置；GUI 停止按钮未实测        |
| 新包屏幕录制与截图          | 实际模型进程报告 denied；用户本次不授权，未执行新包截图/视觉动作                      |
| 原生边界与稳定性            | 同 cell 停止后拒绝、跨窗口旧 state_id、后台拒绝不自动前台及三类任务 10 轮仍需实机验收 |
| Windows / Linux 真机        | 无对应机器                                                                            |
| 干净安装的首次 TCC 授权     | 本次模型实际主体为包内 `ZCode Helper`，已读到状态；未测试从未授权到授权的转换         |
| 三种 Provider 图片协议      | 未用真实图片请求验证 Chat Completions / Anthropic Messages / Responses                |

## 3. 提交与分支

以下为最初集成提交索引；当前提交数量会随合并变化，按内容认：

```
99ec/991863d feat(desktop): 本地自签名证书脚本 + 构建签名接线（默认 opt-in）
aec8d4a     fix(desktop): build-desktop-local 不再发明 bundle.mjs 不支持的参数
a328a9c     fix(computer-use): 修掉 request_access 的三个漏 import/漏透传，并补方法全覆盖守卫
d06d698     Merge branch 'feat/computer-use-settings-ui'
            └ b6fb49f  放开设置页电脑控制入口 + 权限引导接到开源驱动
c48f3ed     feat(desktop): 本地迭代打包落 dist-local
4409542     docs: 安装包首启（AC-28）的真实验证结果
bef30ec     docs: 桌面装配与核心链路的真机验证
623ca33     docs: 截图→模型链路的真机验证结果
06fc49e     docs: 设计记录、使用文档与第三方声明
653b295     feat(computer-use): @trycua/cua-driver 0.28.2 替换占位运行时
```

**动手前先 `git status`**：另一位会话可能正在改代码，不要覆盖。

本次重建基于 `0916056`，包含本地修复 `1af878b`（`MessageInfo["summary"]` 联合类型，
解决 bootstrap 构建 TS2345；先补 spec 和 user-summary 回归测试）。修复无运行时行为变化。
构建时该补丁尚未提交，因此不要把包内 Git 元数据当成最终提交的证明。
本次用户已授权将全部本地提交推送到 fork 的 `origin/main`。

## 4. 已知的坑（按踩过的顺序，都是实测）

### 4.1 TCC 授权「加错了对象」（最容易再踩）

机器上有两个 bundle id 同为 `dev.zcode.app`、名字都显示「ZCode」的东西：

- `/Applications/ZCode.app`：52KB 正式签名 stub（Team 8A5X4JJ39T）；
- `packages/desktop/dist-local/mac-arm64/ZCode.app`：真正在跑的本地构建。

系统设置里它们是**两条同名条目**（macOS 不拒绝重名，按代码身份分），肉眼分不清。
**授权必须加到真正运行的那条的路径上**（§5 步骤 2）。

### 4.2 ad-hoc 构建 → 授权每次重建都失效

本地构建是 ad-hoc 签名，TCC 只能按 CDHash（二进制哈希）绑定；**每次重新构建 CDHash 就变**，
授权静默失效。`pnpm build:desktop:local` 有签名接线但默认关闭（见 4.3），要开就
`ZCODE_LOCAL_CODESIGN=1 node scripts/build-desktop-local.mjs`。

### 4.3 手动签名副本已验证启动；构建签名接线仍有缺陷

本地自签名证书已生成并导入登录钥匙串（`scripts/setup-local-codesign-cert.mjs`，幂等）：

- `codesign --verify --deep --strict` **通过**，`Authority=ZCode Local Dev Codesign`；
- 早先签名/未签名 app 同时起不来的现象没有归因，不能据此判定签名导致启动失败。
- 本次将新包复制到 `/tmp/zcode-cu-validation/signed/ZCode.app`，手动签名、严格验证后
  用独立数据目录启动，进程存活并渲染登录页。此项已通过。
- `scripts/build-desktop-local.mjs` 的 opt-in 签名分支仍未修复：`spawnSync` 未导入，
  探测会捕获 ReferenceError 并返回 false；`signMacApp` 中两个异步 `run` 未 await。
  本次默认打包跳过签名，没有验证这条自动签名分支。

不需要这个证书时删干净：`node scripts/setup-local-codesign-cert.mjs --remove`。
（证书文件在 `~/.zcode-local-codesign/`，仓库外，不入库。）

### 4.4 打包产物别放 `packages/desktop/dist/`

那是 electron-builder 的 `directories.output`，**每次构建前会被清空**（并行改代码时
别人的一次构建就会删掉你的产物，已发生过一次）。本地产物一律落
`packages/desktop/dist-local/`（`.gitignore` 的 `packages/desktop/dist-*/` 已覆盖）：

```bash
pnpm build:desktop:local                # 解包 app + dmg + zip
pnpm build:desktop:local --skip-prepare # agent bundle 已 stage 过，快很多
```

### 4.5 用户机器上的启动器

`/Applications/ZCode 开源版.app` 是个 Automator applet，脚本在
`/Applications/ZCode 开源版.app/Contents/Resources/Scripts/main.scpt`，当前内容：

```applescript
do shell script "/usr/bin/open -n /Users/kiva/Documents/Zcode/packages/desktop/dist-local/mac-arm64/ZCode.app --args --open-workspace /Users/kiva/Documents/Zcode"
```

原版备份在 `/tmp/ZCode 开源版.app.bak`（重启会丢）。它被 ad-hoc 重签过，能正常用。

### 4.6 其它

- `okResult` 曾经不透传 `_meta`，`request_access` 漏过两个 import —— 已修并加了
  「方法全覆盖守卫」测试（遍历所有 method 跑一遍）。新增 method 时**必须**让它出现在
  `CUA_METHOD_NAMES` 里，否则守卫不覆盖。
- 环境提醒：这台机器的 AX 会**间歇性全面失效**（所有窗口 `ax_window_unresolved`、
  `list_apps` 看不到刚启动的 app）。遇到时不要以为是代码回归，先 `open -a TextEdit`
  确认会话还活着，过一会再试。

## 5. 本次收尾与后续验收

本次不再申请系统授权或继续扩大测试。后续只有用户重新要求时继续：

1. 先调查设置页权限探测失败：模型侧已读到真实权限，但设置页仍未知；原因尚未证实。
2. 检查 CLI 的独立存储配置。仅设置 Desktop 的 data/userData/session/home 目录不能证明
   CLI 隔离；本次测试会话仍写入 `~/.zcode/cli/db/db.sqlite`，config/插件市场目录也共享。
3. 若用户允许新的系统授权，确认真实责任进程和包路径，只调整该测试对象；不要删除
   所有同名 ZCode TCC 条目。授权后按需完整重启并用实际捕获验证。
4. 验证设置页权限真值、系统设置链接、截图抵达真实模型、GUI 停止按钮。
5. 实机验证停止后同 cell 动作拒绝、跨窗口旧 state_id 拒绝、后台拒绝不自动前台。
6. 补 `capture_after` 回执、`verify_state` 原生谓词、文本/文件/表单各 10 轮、三个 Provider
   图片协议与其它平台。已有假驱动测试及宿主投影验证不能代替这些验收。

## 6. 关键文件索引

| 想看什么                            | 在哪                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 运行时装配点                        | `packages/zcode-cua/index.js`                                                                                       |
| 运行时核心（门禁/停止/租约/序列化） | `packages/zcode-cua/cua-driver-runtime.js`                                                                          |
| method 实现                         | `cua-driver-methods.js` / `cua-driver-apps.js` / `cua-driver-diagnostics.js`                                        |
| 目标解析 / 动作翻译 / 错误码        | `cua-driver-targets.js` / `cua-driver-actions.js` / `cua-driver-errors.js`                                          |
| 快照注册表 / 跨进程租约             | `cua-driver-observations.js` / `cua-driver-lease.js`                                                                |
| 帧契约（截图→模型）                 | `frame-contract.js`（+ `test/frameContract.test.mjs`）                                                              |
| 权限探测（设置页用）                | `packages/services/src/cua-permission-broker/cuaOpenSourcePermissions.ts`                                           |
| 设置入口显隐                        | `packages/ui/src/lib/settingsNavigation.ts` 的 `HIDDEN_SETTINGS_SECTIONS`                                           |
| 宿主门控                            | `apps/zcode-cli/packages/node-repl-host/src/server.ts`（`ZCODE_CUA_NODE_REPL_HOST=1` + `import.meta.resolve` 双门） |
| 模型可见面（skill/client/docs）     | `apps/zcode-cli/packages/zcode-cua-plugin/`                                                                         |
| 测试                                | `packages/zcode-cua/test/`（53 例，`node --test 'test/**/*.test.mjs'`）                                             |

## 7. 现场状态（交接时）

- 测试用的 TextEdit 与本次启动的 ZCode 测试进程均已退出；其它 ZCode 实例不属于本次收尾范围。
- 登录钥匙串里有一张「ZCode Local Dev Codesign」自签名证书（§4.3），不需要就
  `node scripts/setup-local-codesign-cert.mjs --remove`。
- `packages/desktop/dist-local/mac-arm64/ZCode.app` 已重新构建；默认跳过正式代码签名，
  主可执行文件只有 linker 的 ad-hoc 签名。DMG/ZIP 同步刷新，DMG 校验通过。
- 隔离实例「启用电脑控制」已关闭，Desktop 测试进程与 TextEdit 已正常退出。
- 复制到测试 data 目录的登录凭据、provider/config，以及临时 Desktop profile 已移除。
  CLI 共享数据库中的两条测试会话保留，未删除其它共享数据，不能称为完全隔离测试。
- 测试草稿已移至 `/tmp/zcode-cu-validation/TextEdit-validation.rtf`；旧 app 备份、手动签名
  副本与测试日志、工具回执在 `/tmp/zcode-cu-validation/`，临时目录不保证长期保存。
- 工作区干净，所有改动已提交。
