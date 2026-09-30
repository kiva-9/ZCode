# Computer Use 集成设计记录

**状态：** 实现完成（P0/P1 路径），macOS arm64 部分真实验证；安装包与 Windows/Linux 未验证。
**驱动基线：** `@trycua/cua-driver@0.28.2`（精确锁定，`packages/zcode-cua/package.json`）。
**本文档是设计记录与验证报告**，不是需求文档（需求见产品 PRD）。所有结论都标注了证据来源：
[实测] = 在本机对锁定版本真实执行过；[代码] = 读源码/锁文件确认；[未验证] = 没有证据。

---

## 1. 执行基线与仓库判定

| 项          | 实测值                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分支 / HEAD | `main` @ `961ed19`（含官方 `29628c9` "open source" 提交）                                                                                                                            |
| remote      | origin `kiva-9/ZCode`，upstream `zai-org/ZCode`                                                                                                                                      |
| 工作区      | 开始时干净（`git status` 空）；未重置分支、未合并 CE、未覆盖用户改动                                                                                                                 |
| 基线判定    | **官方占位版**：`packages/zcode-cua/index.js` 的 `createComputerUseRuntime` 恒返回 "Computer Use is not available in this build."，包内无 `@trycua/cua-driver` 依赖，无 CUA 测试文件 |

因此走**补齐路径**（不是 CE 增量增强）：保留占位版的 `.d.ts` 契约与 broker 协议面，替换运行时实现。

参考实现（仅阅读，未合并）：

- `Zcode-CE/Zcode-CE` @ `f16bbc7f13b1201d4915702f76c2d4b1e16f7696` —— 运行时/目标解析/动作翻译/错误映射/测试的移植基础。
- `NousResearch/hermes-agent` @ `bddd22be7c2e5f7630c3d90507e6e7280ff092e3` —— 高层语义参考（观察模式、capture_after、verdict、审批范围、硬阻断、视觉路由）。**未引入其 Python 运行时**。
- `@trycua/cua-driver@0.28.2` —— 驱动契约以本机实拉 `listToolsJson()` 与真实调用为准。

---

## 2. 架构与调用链

```text
ZCode 对话/Provider 适配
  → mcp__node_repl__js（唯一入口，Browser Use 与 Computer Use 共用）
  → node-repl-host：js Worker + CUA bridge（Symbol.for("zcode.node-repl.computer-use-bridge")）
  → 主机侧进程内 CUA broker（Unix socket/named pipe + timingSafeEqual token）
  → @zcode/zcode-cua 运行时（本仓库实现）
      门禁 / 租约 / 快照 / 停止 / 动作 / 观察 / 诊断
  → @trycua/cua-driver 0.28.2（嵌入式同进程运行时，CuaDriver.create()）
  → 当前已登录桌面会话
```

与官方占位版的差异：驱动从「desktop 端 Helper 二进制」改为**在 node_repl host 进程内加载**。
理由（[实测]）：0.28.2 的 `check_permissions.source` 明确写着嵌入式模式下 TCC 授权归宿主进程
（"these booleans reflect the HOST app's TCC grant (the driver is a child in the host's
responsibility chain). No separate driver grant exists or is needed."），`CuaDriver.create()`
的文档也写着 "never launches `cua-driver` and never opens daemon IPC"。占位版指向的私有
Helper（`ZCode Computer Use.app`，bundle `dev.zcode.cua-helper`）在本构建不随包分发，
`broker-server.js` 继续 fail-closed，不引入未核实二进制。

---

## 3. 模块地图（`packages/zcode-cua/`）

| 文件                             | 职责                                                                   | 来源                                     |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `index.js`                       | 装配点：`driver: "open-source" \| "disabled"`；`loadDriver` 仅测试注入 | 移植 CE，重写注释                        |
| `cua-driver-runtime.js`          | 生命周期：懒加载/串行化/dispose、门禁顺序、kill switch、租约协调       | 移植 CE + PRD §7.3                       |
| `cua-driver-methods.js`          | capability method 实现（list/get/动作/request_access/stop）            | 移植 CE + 重写                           |
| `cua-driver-apps.js`             | app/window 解析 + 观察塑形（image + image_ref 规范帧对）               | **新增**（从 CE runtime 拆出）           |
| `cua-driver-targets.js`          | 目标解析：app 键、窗口筛选、元素/坐标 target、state_id 绑定校验        | 移植 CE + 修正                           |
| `cua-driver-actions.js`          | method → 驱动工具入参白名单翻译                                        | 移植 CE + 按 0.28.2 schema 重校          |
| `cua-driver-observations.js`     | 观察注册表：(会话, 应用, 窗口) 归档 + 上限 + 摘要                      | **新增**（PRD FR-04）                    |
| `cua-driver-lease.js`            | 跨进程桌面控制租约（文件锁 + pid 活性判活）                            | **新增**（PRD FR-09）                    |
| `cua-driver-errors.js`           | 驱动错误码 → broker 错误码、信封、投递/验证四态                        | 移植 CE + 修正                           |
| `cua-driver-capabilities.js`     | 平台三元组、驱动可解析性、权限/健康报告解析                            | **新增**（PRD FR-01/FR-12）              |
| `cua-driver-diagnostics.js`      | `get_capabilities` / `get_diagnostics`                                 | **新增**                                 |
| `cua-capability-policy.js`       | method 分类、审批要求、**授权前硬阻断**                                | **新增**（Hermes `_reject_unsafe` 语义） |
| `frame-contract.js`              | 帧完整性契约：image_ref 签发/校验/压缩重签                             | **新增**（CE 是占位）                    |
| `request-access-contract.js`     | `request_access` 状态信封（与 shared zod schema 逐字一致）             | 移植 CE                                  |
| `broker*.js` / `pip-session*.js` | 协议与占位面，**保持 fail-closed 未改动**                              | 官方原样                                 |

宿主侧改动：`node-repl-host/src/server.ts`（双门控 + 可用性文案）、`tool-contract.ts`
（不可用后缀）、`bootstrap/src/mcp-config.ts`（无需改，凭据契约由 services 侧铸造）、
`services/src/node.ts` + `cua-permission-broker/cuaProductHelperSpawnEnv.ts`（三平台懒铸造）、
`bootstrap/src/app/official-plugin-definitions.ts`（node-repl-host 的 `runtimeTopLevelPaths`）。
插件壳：`apps/zcode-cli/packages/zcode-cua-plugin/`（skill / docs / client script）。

---

## 4. 驱动兼容性表（0.28.2 实测）

拉取方式：`npm pack @trycua/cua-driver@0.28.2` + `listToolsJson()` + 只读调用。55 个工具，
本实现用到 13 个。

| ZCode method                         | 驱动工具            | 入参要点（实测 schema）                                                                                                                                                                                                                                                                                                                                      | 状态                        |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `list_apps`                          | `list_apps`         | 无参；返回 `apps[]`（pid/name/running/bundle_id/kind/launch_path）                                                                                                                                                                                                                                                                                           | [实测]                      |
| `list_windows`                       | `list_windows`      | `pid?`、`on_screen_only?`；行内含 `bounds{x,y,width,height}`，**无扁平 width/height**                                                                                                                                                                                                                                                                        | [实测]                      |
| `get_app_state`                      | `get_window_state`  | `pid`+`window_id` 必填；`include_accessibility_tree`、`include_screenshot`、`max_elements`、`max_depth`；返回 `snapshot_id`、`elements[]`（`element_index`、`element_token`、`role`、`label`、`actions`、`frame`）、`tree_markdown`、`elements_complete`、`degraded`/`degraded_reason`、`background_input`、`escalation`、`capture_coverage`、`screenshot_*` | [实测]                      |
| `left_click`                         | `click`             | `element_token`（或 `element_index`+`snapshot_id`）、`button`、`count`、`modifier`（**单数**）、`delivery_mode`、`x/y`、`scope`                                                                                                                                                                                                                              | [实测]                      |
| `left_click_drag`                    | `drag`              | `from_x/from_y/to_x/to_y` 必填，`button`、`modifier`、`duration_ms`、`steps`                                                                                                                                                                                                                                                                                 | [代码] schema + [实测] 调用 |
| `type`                               | `type_text`         | `text` 必填；`delay_ms`、`element_*`、`delivery_mode`                                                                                                                                                                                                                                                                                                        | [实测]                      |
| `set_value`                          | `set_value`         | `pid`+`value` 必填；`element_token`/`element_index`+`snapshot_id`                                                                                                                                                                                                                                                                                            | [代码]                      |
| `key`                                | `press_key`         | `key` 必填、`modifiers`（**复数**）                                                                                                                                                                                                                                                                                                                          | [实测]                      |
| `scroll`                             | `scroll`            | `direction` 必填、`by: line\|page`、`amount`                                                                                                                                                                                                                                                                                                                 | [实测]                      |
| `mouse_move`                         | `move_cursor`       | `x`+`y` 必填、`scope`、`cursor_id`                                                                                                                                                                                                                                                                                                                           | [代码]                      |
| `request_access`                     | `check_permissions` | 返回 `accessibility`/`screen_recording`/`screen_recording_capturable`/`source{executable,host_bundle_id,pid,note}`                                                                                                                                                                                                                                           | [实测]                      |
| `get_capabilities`/`get_diagnostics` | `health_report`     | 返回 `checks[]`、`overall`、`driver_version`、`platform`、`schema_version`                                                                                                                                                                                                                                                                                   | [实测]                      |
| `stop_computer_control`              | （不调驱动）        | 只动 ZCode 自己的 kill switch                                                                                                                                                                                                                                                                                                                                | [实测]                      |
| 透明拉起                             | `launch_app`        | `bundle_id` 或 `name`；**没有 `launch_path` 字段**                                                                                                                                                                                                                                                                                                           | [实测] schema               |
| 会话自愈                             | `start_session`     | `session?`、`capture_scope?`、`cursor_theme?`                                                                                                                                                                                                                                                                                                                | [实测]                      |
| 可选校验                             | `verify_state`      | `pid`+`window_id`+`expect[]`，`timeout_ms`、`stable_samples`、`include_screenshot`                                                                                                                                                                                                                                                                           | [代码]                      |

**移植时发现并修正的 CE 契约错误（都有本机证据）**：

1. `list_windows` 行尺寸在 `bounds` 里。CE 的 `usableWindows`/`pickWindow` 读扁平
   `w.width`/`w.height` → `Number(undefined)=NaN` → **每个窗口都判成不可用**。
   CE 的假驱动返回扁字段，所以回归测试没暴露。本实现以 `bounds` 为准、扁字段兜底。
2. `launch_app` 的 schema 只有 `bundle_id`/`name`。CE 传 `launch_path` 会被拒
   （`additionalProperties: false`）。本实现按 bundle_id → name 顺序下发。
3. 后台投递拒绝**只落在文本里**（`structuredContent.code` 为 undefined）：
   "Background input refused (off_space_or_ax_unresolved): window 212 is not among the
   process's current AXWindows…"。CE 把一切纯文本拒绝归 `element_unavailable`，
   会把「后台不可用」误判成「元素过期」。本实现先按文本特征分流到
   `foreground_required`（实测：同一条拒绝在 CE 映射下会让模型反复重新观察，
   永远走不到「告诉用户」这一步）。
4. `delivery_failed`（实测 `press_key` 对不存在的键名返回该码）→ `action_unavailable`
   （客户端 NEVER_RETRY，不再原样重放）。
5. 动作参数改白名单：客户端会传 `strategy`/`hold_seconds`，0.28.2 的 `click`/`press_key`
   都没有这两个字段；实测嵌入式 callTool 对未知字段宽容，但宽容不等于可以依赖。

**终止/取消/释放语义（CE 移植 + 保持不变）**：`@ubjs/core@0.31.0-3` 的 async-rust-call
读 `asyncOpts?.signal.aborted`，可选链没护住 `signal`，所以 `{}`/`{signal: undefined}` 会抛
（上游缺陷），适配层**永远合成 signal**。`dispose()` 先 abort 再 `shutdown()` +
`uniffiDestroy()`，幂等（二次销毁会抛，被测覆盖）。取消后已下发的输入不回滚。

**Hermes MCP 与 Node SDK 的差异（阶段 0 要求核对）**：不同构。Hermes 走外部
`cua-driver mcp` 守护进程 + `CuaDriver.app` 启动链路（TCC 归 `com.trycua.driver`），
Node SDK 0.28.2 提供同进程 `CuaDriver.create()` 与 55 个 callTool 工具；权限主体是宿主进程。
Hermes 的 14 个动作与 ZCode capability method 也只是语义对应，参数形状不同
（例如 Hermes 的 `element` 是 1-based，驱动 `element_index` 是 0-based，ZCode 客户端契约
用驱动索引）。因此**不能假设两者等价**，只迁移已验证语义。

---

## 5. 源码移植清单与来源

| 目标文件                                                                  | 来源                                                              | 修改                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `packages/zcode-cua/{index,frame-contract,request-access-contract}.js`    | CE 同名文件                                                       | 重写/补全实现（CE 的 frame-contract 是占位）       |
| `packages/zcode-cua/cua-driver-{errors,targets,actions}.js`               | CE 同名文件                                                       | 契约修正（§4）+ PRD 四态                           |
| `packages/zcode-cua/cua-driver-runtime.js`                                | CE 同名文件（525 行）                                             | 拆出 apps/observations/lease，补租约/子代理/硬阻断 |
| `packages/zcode-cua/test/computerUseCuaDriver.test.mjs`                   | CE `packages/services/test/computerUseCuaDriver.test.ts`（19 例） | 26 例：全部移植 + 修正断言 + 新增用例              |
| `apps/zcode-cli/packages/zcode-cua-plugin/**`                             | 上游官方发行包 `zcode-cua-plugin` 0.6.1（经 CE 仓库转存）         | 逐字复制 + 2 个只读新增方法 + SKILL 自查段         |
| `packages/desktop/scripts/cua-driver-package-assets.mjs`                  | CE 同名文件（220 行）                                             | 主体逐字移植 + 头部基线说明                        |
| `packages/services/src/cua-permission-broker/cuaProductHelperSpawnEnv.ts` | CE 同名文件（58 行）                                              | 按本仓库路径改写注释                               |

Hermes 参考（语义级迁移，未复制代码）：`schema.py`（观察模式/审批范围/1-based index）、
`tool.py`（verdict 分类、只读重放白名单、'No follow-up capture after a failed action'）、
`permissions.py`（权限主体与 TCC 语义，但其 `com.trycua.driver` 主体不适用于嵌入式路径）、
`vision_routing.py`（模型能读图 / Provider 能承载工具图片 / 宿主是否真的传了图，三问不互相代替）。

### 许可证来源

| 组件                          | 版本     | 许可证                                                                                                                                                                                 | 证据           |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `@trycua/cua-driver`          | 0.28.2   | MIT（package.json 字段；根 tarball 无 LICENSE 文件）                                                                                                                                   | [实测] tarball |
| `@trycua/cua-driver-<triple>` | 0.28.2   | MIT AND MPL-2.0；`node-runtime-NOTICE.md` 声明 `cua_driver_node_runtime.node` 派生自 uniffi-bindgen-react-native 0.31.0-3 N-API runtime（MPL-2.0，源码在 trycua/cua 对应 release tag） | [实测] tarball |
| `@ubjs/core` / `@ubjs/node`   | 0.31.0-3 | MPL-2.0                                                                                                                                                                                | [实测]         |
| `computer-use` 插件壳         | 0.6.1    | manifest 声明 MIT，author Z.ai；与 zai-org/ZCode（根 Apache-2.0）同源                                                                                                                  | [实测] 文件    |

macOS arm64 原生体积（[实测]）：`libcua_driver_sdk.dylib` 51,741,008 B（universal x86_64+arm64，
minos 13.0）+ `cua_driver_node_runtime.node` 1,712,400 B ≈ 53 MB。打包只带目标平台（见 §7）。

---

## 6. 安全边界与设计决定

1. **后台优先，拒绝不授权前台重投**：适配层从不主动传 `delivery_mode:"foreground"`；
   驱动返回 `background_unavailable` → `foreground_required`（客户端 NEVER_RETRY）。
   [实测] 在真机上取到过这条拒绝（窗口不在当前 Space）。
2. **收据 ≠ 任务成功**：`action_sent`/`dispatch_status` 只在 `delivered_count > 0` 时置位；
   成功与失败都带 `cua.delivery`（not_sent/sent/possibly_sent/unknown）与
   `cua.verification`（not_run/observed_change/expected_state_confirmed/inconclusive）。
   超时/取消 → `unknown`，绝不坍缩成 `not_sent`。
3. **动作后默认再观察**（`capture_after` 默认开，可显式关）：失败只让结果「未确认」，
   不把已投递说成失败。
4. **索引 → token 冻结映射**：`(会话, 应用, 窗口)` 归档；窗口切换不串用（AC-07），
   显式带旧 `state_id` 被拒（AC-09）；放行「同 cell 多个动作复用索引」是官方契约，
   误点防护由驱动 token 的快照身份负责（实测：旧 token 被拒并要求重新观察）。
5. **跨进程租约**：文件锁 + pid 活性判活；占用即告知不抢占；只读方法（list/capabilities/
   diagnostics）不需要租约，保证「诊断为什么被占用」这条路永远通着。
6. **子代理三道防线**：core policy、bridge assertAvailable、运行时 `not_authorized`。
7. **授权前硬阻断**：危险组合键与管道执行/递归删除输入，先于一切审批执行（Hermes 同语义）。
8. **模型参数不可越权**：`approved/authorized/sessionId` 等 arguments 字段全部无效，
   上下文只来自宿主 requestMeta（broker 侧二次白名单校验）。
9. **不自动下载驱动**：驱动只在 `import.meta.resolve` 通过后才装配；运行失败给
   `broker_unavailable` 并把尝试回滚（可重试一次），并在工具描述里明说「没有东西需要安装」。
10. **未知即未知**：`get_capabilities` 的 `modelCanReadImages` /
    `providerCanCarryToolImages` 恒为 unknown —— 那两问由宿主 Provider 层回答，
    运行时不用截图路径冒充模型已看到图。

**未采用/明确不做（首版）**：`select_text`/`perform_action`/`paste`（驱动有
`click.action` 可实现 perform_action，但 PRD 明确继续返回不可用；菜单动作会触发真实业务
副作用）；前台自动接管；子代理；远程桌面；并发桌面控制；常驻录屏；辅助视觉模型。

---

## 7. 打包与 seed

- `packages/desktop/scripts/cua-driver-package-assets.mjs`：把 5 个包
  （`@trycua/cua-driver`、`@ubjs/core`、`@ubjs/node` + 目标三元组的
  `@trycua/cua-driver-<triple>`、`@ubjs/node-<triple>`）stage 到
  `<agent bundle>/glm/packages/node-repl-host/node_modules/` —— 这是**唯一**同时满足两条
  约束的位置：electron-builder 会丢掉源码根相邻的 `node_modules`，seed 白名单按深度 0 过滤。
- `electron-builder.config.js` 的 `afterPack:assertPackagedCuaDriver` 缺任何一个包/原生库
  就让出包失败，并校验 host bundle 里仍保留 `await import("@trycua/cua-driver")` 字样
  （证明驱动仍是运行时 import，没被 inline）。
- `official-plugin-definitions.ts` 给 node-repl-host 声明 `runtimeTopLevelPaths:["node_modules"]`；
  不声明的话整个驱动树会被 seed 静默裁掉，症状是安装包首启第一次调用才
  ERR_MODULE_NOT_FOUND，而构建全程绿灯。
- 只带目标平台：macOS arm64 包不含六个平台的二进制。
- [未验证] 没有打包环境：afterPack 校验、`glm → resources/glm` 拷贝、seed cache 首启解析
  都未实跑。

### 7.2 产品身份轴：`ZCODE_ENV` 与 `ZCODE_PREVIEW_IDENTITY`（实跑踩坑）

打包产物名由**产品身份**决定，与后端环境是两个轴（`packages/desktop/scripts/desktop-product-identity.mjs`）：

| 命令                                                           | 解包 app                                      | 安装包名                                       |
| -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `pnpm --filter @zcode/desktop run bundle`（未设 `ZCODE_ENV`）  | `dist/mac-arm64/ZCode Preview.app`            | `ZCode Preview-<ver>-mac-arm64_TEST.{dmg,zip}` |
| `ZCODE_ENV=production pnpm --filter @zcode/desktop run bundle` | `dist/mac-arm64/ZCode.app`（`dev.zcode.app`） | `ZCode-<ver>-mac-arm64.{dmg,zip}`              |

electron-builder 会**清空 `directories.output`**，所以两种身份的构建会互相覆盖解包目录。
本次实跑中先用默认（Preview/TEST）身份出过一次包，把工作树里既有的
`dist/mac-arm64/ZCode.app`（本地 dev 启动入口）覆盖成了 `ZCode Preview.app`；
随后用 `ZCODE_ENV=production` 重建恢复。**教训**：动这个目录前先确认身份，
并先备份已有的解包 app 与安装包。

### 7.1 构建期修复：驱动必须保持运行时 import（实测）

`node-repl-host` 的 esbuild 原本会把 `@trycua/cua-driver`（连同 `@ubjs/*` 的平台解析）
**整个内联进 bundle**（实测：2,717,235 B 的产物里出现
`node_modules/@trycua/cua-driver/dist/native/node-runtime.js` 的内容）。那份代码靠**自己包内
相对路径**定位 `libcua_driver_sdk.dylib`；进了宿主 bundle 之后 `import.meta.url` 指向
`dist/mcp/server.js`，原生库解析必然失败。而源码/dev 下 `node_modules` 在祖先链上恰好能解析，
所以本地怎么测都看不出来 —— 只在安装包第一次 Computer Use 调用时暴露。

修复（`apps/zcode-cli/packages/node-repl-host/scripts/build.mjs`）：

1. esbuild `external: ["@trycua/cua-driver", "@ubjs/core", "@ubjs/node"]`；
2. 构建后守卫：产物里必须仍能找到 `"@trycua/cua-driver"` 字样，否则让构建直接失败。

[实测] 修复后产物 2,085,349 B（-632 KB），`await import("@trycua/cua-driver")` 保留 1 处，
`cua_driver_node_runtime` / `dist/native/node-runtime` 不再出现。
[实测] 用真实包 + 真实 bundle 组成 staged 树后跑 `verifyStagedCuaDriver` → `[]`（无问题）。

---

## 8. 真实验证报告（macOS 27.0.1 arm64，Node v24.18.0）

| 项                                                  | 命令/方式                                                                                                                                                             | 结果                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 驱动安装与加载                                      | `pnpm install`（工作区新增 1 个直接依赖 + 6 平台包）→ `node` 经 `createComputerUseRuntime({driver:"open-source"})`                                                    | [实测] 通过；176 exports；`metadata.driverVersion 0.28.2`                                                                                                                                                                                                                                                          |
| **截图 → 模型链路**（原未验证项 1，屏幕解锁后补测） | 真机在屏窗口（ChatGPT 326 元素）带 `include_screenshot:true` 观察 + **真实 core 宿主链路** `normalizeMcpToolResultForModel`                                           | [实测] 6/6 通过：image@0 + image_ref@1、`hasOfficialCuaFrameAuthority` 认出权威帧、raster 149 KiB 原样保留（<200 KiB inline 预算，不落盘）、块序 image 优先、`image_ref.state_id` 与同次观察一致                                                                                                                   |
| TCC 权限主体                                        | `check_permissions`                                                                                                                                                   | [实测] `accessibility:true`、`screenRecording:true`、`source.executable=/usr/local/bin/node`、note 明确嵌入式模式授权归宿主进程                                                                                                                                                                                    |
| `list_apps`                                         | 运行时方法                                                                                                                                                            | [实测] 96 apps → 过滤后模型可见；Linux 800+ 进程过滤逻辑有单测                                                                                                                                                                                                                                                     |
| `list_windows`                                      | 运行时方法                                                                                                                                                            | [实测] `bounds` 形状、`z_index`、`space_ids`、`is_on_screen`                                                                                                                                                                                                                                                       |
| `get_capabilities`                                  | 运行时方法                                                                                                                                                            | [实测] 平台三元组、驱动版本/来源、权限、租约、观察数；`modelImageTransport` 三项 unknown                                                                                                                                                                                                                           |
| `get_diagnostics`                                   | 运行时方法                                                                                                                                                            | [实测] `health_report` 8 项；`bundle_identity: fail`（宿主进程无 CFBundleIdentifier，符合预期），`tcc_*: pass`，`ax_capability: pass`                                                                                                                                                                              |
| AX 观察                                             | `get_app_state(pid=1270, window_id=212)`                                                                                                                              | [实测] **71 elements**、`snapshot_id s00000001`、tokens `s00000001:N`、`tree_markdown`                                                                                                                                                                                                                             |
| 元素点击                                            | `click{element_index:1, snapshot_id:...}`                                                                                                                             | [实测] 真机收据 "✅ Performed AXPress on [1] AXButton"（**这是本会话唯一的真实输入副作用**）                                                                                                                                                                                                                       |
| 过期 token                                          | `click{element_token:"sdeadbeef:0"}`                                                                                                                                  | [实测] 文本拒绝 "element_token is stale; call get_window_state again to refresh" → `element_unavailable`                                                                                                                                                                                                           |
| 后台拒绝                                            | 新 token 点击窗口不在当前 Space                                                                                                                                       | [实测] "Background input refused (off_space_or_ax_unresolved)…" → `foreground_required`，未自动前台                                                                                                                                                                                                                |
| 降级观察                                            | 会话后期所有窗口                                                                                                                                                      | [实测] 每窗返回 `ax_window_unresolved` + 空树；运行时映射为 `element_unavailable` 并带上原因                                                                                                                                                                                                                       |
| 单元/契约测试                                       | `cd packages/zcode-cua && node --test 'test/**/*.test.mjs'`                                                                                                           | [实测] **48 passed / 0 failed**                                                                                                                                                                                                                                                                                    |
| lint / format                                       | `pnpm lint`（oxlint，包目录）/ `oxfmt --check`                                                                                                                        | [实测] 0 warnings 0 errors / 全部已格式化                                                                                                                                                                                                                                                                          |
| node-repl-host 构建                                 | `pnpm build`（依赖链 contracts→core→node-repl-host 已建）                                                                                                             | [实测] 成功，产出 `dist/mcp/server.js`                                                                                                                                                                                                                                                                             |
| **桌面装配（阶段 3 步骤 2）**                       | `node scripts/build-desktop-agent-cli.mjs` + `pnpm --filter @zcode/desktop prepare:agent-bundle`                                                                      | [实测] 通过：host 构建（含 external 守卫）、BUA 无回归、`zcode.cjs` 16.1MB、**驱动 5 包 52.9 MiB stage 到 `glm/packages/node-repl-host/node_modules/`**、`packages/zcode-cua-plugin` 完整（3/3 requiredSeedPaths）；真实包+真实 bundle 组树后 `verifyStagedCuaDriver` → `[]`                                       |
| **插件 seed 刷新**                                  | 清掉陈旧 cache 后重跑                                                                                                                                                 | [实测] cache 0.6.3 重新 seed 出 skills/scripts/docs；`skills list` 显示 `computer-use`；`plugins list` → `skills: 1`。**发现**该机原 cache 是 CE 仓库残留（含 `bump-zcode-cua-producer.mjs` 等工具脚本）且缺 skill/client —— seed 的 `missingSeedPaths` 守卫生效（拒绝写残缺缓存并告警回落），没有静默装出残缺插件 |
| **宿主装配（AC-03 + 凭据）**                        | 生产代码路径（`resolveBuiltInNodeReplMcpServers` + `omitMcpServers` + `sanitizeZCodeRuntimeEnv`）                                                                     | [实测] 12/12：四种启用组合正确、CUA-only 不泄漏 BUA 文档 root、有凭据时注入 `ZCODE_CUA_NODE_REPL_HOST=1` + socket + authority + 插件身份、无凭据时不装配也不伪造                                                                                                                                                   |
| **核心链路端到端**                                  | 装配点门控 → host 本地 broker → 进程内执行器（与 Worker 同路径）→ **插件自带 client script** → `agent.computerUse.capabilities()/diagnostics()/getApp().getAXState()` | [实测] 5/5 + 真实观察：驱动 0.28.2/bundled、权限双 granted（subject `/usr/local/bin/node`）、health 8 项、ChatGPT 窗口 AX 树真实读出                                                                                                                                                                               |
| **安装包首启（AC-28）**                             | `pnpm --filter @zcode/desktop build` + `run bundle` → 解包 zip，**干净 HOME + cwd=/tmp**，只许访问安装包                                                              | [实测] 7/7：`afterPack:assertPackagedCuaDriver` 通过；包内 host 能解析 `@trycua/cua-driver`；驱动从**安装包 node_modules** 加载（0.28.2/bundled）；96 应用、9 在屏窗口、权限与诊断均真机返回。产物 `packages/desktop/dist/ZCode Preview-3.14.3-mac-arm64_TEST.{dmg,zip}`（dmg 207MB / zip 198MB）                  |
| MCP stdio 传输层                                    | 自研 JSON-RPC client                                                                                                                                                  | [未验证] 本脚手架无法满足 SDK 2.0.0 的 2026-07-28 per-request envelope 握手（`server/discover` 探测 + 每次请求都要带 `io.modelcontextprotocol/*` envelope；带 ZCode 请求上下文时该 SDK 构建不响应）。生产走官方 `@modelcontextprotocol/client@2.0.0` + `versionNegotiation pin`，该路径未在无模型环境下复现        |

**未验证项（不得当作通过）**：

1. ~~截图抵达模型消息~~ —— 2026-09-30 屏幕解锁后补测**通过**（见上表新增行）。
2. `capture_after` 的真实后续观察、`verify_state` 真实调用。
3. 桌面任务集（文本编辑 / 文件管理 / 表单）、10 轮稳定性。
4. ~~安装包首启~~ —— 2026-09-30 已从真实安装包 + 干净 HOME 验证通过（见上表）。**仍未验证**：安装态 TCC 授权（首次安装时授权主体是 ZCode.app，需用户实机确认）与「用户在设置页启用后由模型驱动」的完整回路。
5. Windows / Linux 真机；macOS arm64 以外架构。
6. Provider 三方协议（OpenAI Chat Completions / Anthropic Messages / Responses）的图片序列化
   在真实模型上的表现 —— 需凭证，未测；帧契约单测覆盖了形状与完整性。

---

## 9. 已知限制

- `ax_window_unresolved`：窗口不在当前 Space、被隐藏或最小化时，驱动**故意**返回空树
  （防止用别的 surface 的元素误导下一次动作）。此时只能换窗口或请用户激活应用。
- Electron/Chromium 类应用的窗口在该会话里普遍 `ax_unresolved`（实测 Chrome/飞书/ChatGPT
  全部如此）—— 需要前台或换目标，运行时会把原因带给模型。
- 权限主体是宿主进程：dev 态是 `node`，安装态是 ZCode 应用。首次安装的授权情况与开发机
  已授权**不是**同一件事（未在干净环境验证）。
- `bundle_identity` 健康项在非 .app 宿主下恒 fail，属预期诊断信息而非故障。
