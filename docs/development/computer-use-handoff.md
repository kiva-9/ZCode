# Computer Use 集成 — 交接提示词（给接手的开发者）

> 用途：把下面内容整段交给下一位开发者（人或 Agent），他应当能在不重复提问的情况下
> 继续完成剩余验证。生成时间：2026-09-30。仓库：`/Users/kiva/Documents/Zcode`。
> **未 push**：所有提交都在本地 `main` 上（见 §3），origin 是 `kiva-9/ZCode`。

---

## 1. 这个任务是什么

在 ZCode 开源版里补齐基于 Cua 的桌面控制能力，参考 PRD：
`/Users/kiva/Downloads/ZCode_Computer_Use_PRD.md`（必读，尤其是 §7 验收流程和 AC-01～AC-30）。

设计记录（已包含源码地图、驱动兼容性表、移植修正清单、真实验证报告）：
`docs/development/computer-use.md`。使用文档：`docs/computer-use.md`。

一句话现状：**运行时、宿主装配、设置页入口、权限探测、打包 staging 都已实现并有测试；
真正没做完的只有「授权之后的 GUI 实机回路」**（见 §5）。

## 2. 现在能跑通 / 不能跑通

| 已实跑通过                                                                             | 证据                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 驱动在进程内加载（`@trycua/cua-driver@0.28.2`，darwin-arm64）                          | `docs/development/computer-use.md` §8                                                  |
| list_apps / list_windows / get_app_state / 全部动作 / stop / 租约 / 快照绑定           | `packages/zcode-cua/test` **53 例全过**                                                |
| 截图→模型链路（真实 raster + image_ref + 完整性 attestation + 宿主 exact-raster 路径） | 同上，6/6 真机                                                                         |
| 安装包首启（AC-28）：干净 HOME + 安装包 node_modules 里加载驱动                        | 同上，7/7                                                                              |
| 设置页「电脑控制」入口 + 权限状态 + 打开系统设置面板                                   | 提交 `b6fb49f`                                                                         |
| typecheck / lint / oxfmt                                                               | 干净                                                                                   |
| **当前构建出的 app**                                                                   | `packages/desktop/dist-local/mac-arm64/ZCode.app`（正式身份 `dev.zcode.app` / 3.14.3） |

| 未验证（这就是你要做的）                | 说明                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **用户在系统设置授权后，整条 GUI 回路** | 见 §5 的复测步骤                                                                                                              |
| 签名后的 app 能否正常启动               | 见 §4.3 的悬案                                                                                                                |
| Windows / Linux 真机                    | 无对应机器                                                                                                                    |
| MCP stdio 传输层 envelope 握手          | SDK 2.0.0 的 2026-07-28 per-request envelope，自研脚手架满足不了；生产用官方 `@modelcontextprotocol/client`，需在真实会话里验 |
| 安装态 TCC 授权主体                     | 未在干净安装环境验过                                                                                                          |

## 3. 提交与分支

`git log --oneline 961ed19..HEAD` 应看到 10 个提交（若已被合并/变基，按内容认）：

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

### 4.3 悬案：签名后的 app 启动表现未结论

本地自签名证书已生成并导入登录钥匙串（`scripts/setup-local-codesign-cert.mjs`，幂等）：

- `codesign --verify --deep --strict` **通过**，`Authority=ZCode Local Dev Codesign`；
- 但签名后 app 启动不了；**同时段把未签名的另一份 app 也启动不了**，而系统应用
  TextEdit 正常 → 怀疑是图形会话层面的问题，不是签名本身。
- 接手人请先复现「app 到底能不能启动」再判断签名方案。

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

## 5. 下一步：复测授权后的 GUI 回路（核心）

前置：构建产物 = `packages/desktop/dist-local/mac-arm64/ZCode.app`（见 §4.4；
需要带最新代码就重新 `pnpm build:desktop:local`，但**先问过用户**，他可能在改代码）。

1. 启动：`/usr/bin/open -n packages/desktop/dist-local/mac-arm64/ZCode.app --args --open-workspace /Users/kiva/Documents/Zcode`
   （app 起不来的话先看 §4.3 和 §4.6）
2. 系统设置 → 隐私与安全性 → 辅助功能：删掉所有 ZCode 条目，用 `Cmd+Shift+G` 粘贴
   **`/Users/kiva/Documents/Zcode/packages/desktop/dist-local/mac-arm64/ZCode.app`** 添加；
   屏幕录制同样再来一遍。
3. **完全退出并重启 ZCode**（TCC 只对新进程生效）。
4. 设置 → 电脑控制 → 打开「启用电脑控制」→ 两个权限行应显示**已授权**（不再是「未知」）。
   点击链接应能直接打开对应系统设置面板。
5. 在对话里让模型做一个真实任务（例如「打开文本编辑，输入 hello」，然后用只读方式确认），
   观察：观察 → 点击/输入 → 再观察 → 停止按钮 全链路。
6. 重点回归这几条（PRD 的安全底线）：
   - 点「停止电脑控制」后，同一个 REPL cell 再发动作必须被拒（`controller_busy`），
     不能重连/重试恢复；
   - 窗口换了之后，旧 state_id 的动作必须被拒；
   - 后台投递被拒时**不能**自动改成前台。

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

- 测试用的 TextEdit 已退出；ZCode 当前**没有**在跑。
- 登录钥匙串里有一张「ZCode Local Dev Codesign」自签名证书（§4.3），不需要就
  `node scripts/setup-local-codesign-cert.mjs --remove`。
- `packages/desktop/dist-local/mac-arm64/ZCode.app` 当前是 **ad-hoc 签名**（我把它从
  自签名改回了 ad-hoc，方便你重新做 §5 的对照实验）。
- 工作区干净，所有改动已提交。
