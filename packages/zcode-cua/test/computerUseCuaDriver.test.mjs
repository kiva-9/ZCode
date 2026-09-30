/**
 * Computer Use 运行时（cua-driver 适配层）的回归测试。
 *
 * 运行：cd packages/zcode-cua && node --test test/
 *
 * 与 CE 参考实现（packages/services/test/computerUseCuaDriver.test.ts，19 例）的关系：
 * 全部移植，并按 0.28.2 实测修正了三处契约（窗口尺寸取 bounds、launch_app 用
 * bundle_id、文本-only 拒绝的分类），另加 PRD 要求的新用例。凡是与 CE 断言不同的地方，
 * 都在用例上方写明了原因 —— 不是「为了让测试绿」而改断言。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { APP, baseScript, bodyOf, envelope, execute, withRuntime } from "./support/fake-driver.mjs";

// ─────────────────────────────────────────── 工具路由

test("list_apps only surfaces user-addressable apps", async () => {
  await withRuntime(
    baseScript({
      list_apps: envelope({
        apps: [
          { name: "Dolphin", pid: 42, running: true, kind: "desktop" },
          // 内核线程：Linux 上驱动把 800+ 个进程全报成应用，必须被挡在模型上下文之外。
          { name: "kworker/R-rcu_gp", pid: 9, running: true, kind: null },
          { name: "Konsole", pid: 0, running: false, kind: "desktop", launch_path: "konsole" },
        ],
      }),
    }),
    async ({ runtime }) => {
      const result = await execute(runtime, "list_apps", {});
      assert.equal(result.isError, undefined);
      assert.deepEqual(
        bodyOf(result).apps.map((app) => app.name),
        ["Dolphin", "Konsole"],
      );
    },
  );
});

test("list_apps 的应用关联写进 _meta（宿主据此显示应用名/图标）", async () => {
  // 回归：okResult 曾只转发 content/structuredContent，list_apps 与 request_access 的
  // _meta 被静默丢掉 —— 工具卡不显示目标应用、设置页权限行永不更新，且无任何报错。
  await withRuntime(baseScript(), async ({ runtime }) => {
    const result = await execute(runtime, "list_apps", {});
    const items = result._meta?.["zcode.cua/app-associations-v1"]?.items;
    assert.ok(Array.isArray(items), JSON.stringify(result._meta));
    assert.deepEqual(
      items.map((item) => item.appKey),
      ["bundle:org.kde.dolphin"],
    );
    assert.equal(items[0].displayName, "Dolphin");
  });
});

test("get_app_state resolves the app to a pid and returns a usable state_id", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const result = await execute(runtime, "get_app_state", APP);
    const state = result.structuredContent;
    assert.equal(state.state_id, "s00000001");
    assert.equal(state.app.pid, 42);
    assert.equal(state.elements.length, 2);
    assert.equal(state.elements[0].index, 0);
    assert.deepEqual(state.elements[0].actions, ["Press"]);
    // 观察必须走 get_window_state，且落在被选中的窗口（7）而不是 0x0 的幽灵窗口（8）。
    const observe = driver.calls.find((call) => call.name === "get_window_state");
    assert.equal(observe.args.pid, 42);
    assert.equal(observe.args.window_id, 7);
  });
});

test("窗口尺寸取 bounds（0.28.2 实测）：扁字段形状同样兼容", async () => {
  // CE 的假驱动用扁平 width/height，0.28.2 的真实行把尺寸放在 bounds 里。
  // 两种形状都必须能解析，否则真机上每个窗口都会被判成不可用。
  await withRuntime(
    baseScript({
      list_windows: envelope({
        windows: [
          { pid: 42, window_id: 9, app_name: "dolphin", title: "flat", width: 640, height: 480 },
        ],
      }),
      get_window_state: envelope({ snapshot_id: "s0000000a", elements: [] }),
    }),
    async ({ runtime, driver }) => {
      const result = await execute(runtime, "get_app_state", {
        app_ref: { bundle_id: "org.kde.dolphin", window_id: 9 },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(result.structuredContent.state_id, "s0000000a");
      const observe = driver.calls.find((call) => call.name === "get_window_state");
      assert.equal(observe.args.window_id, 9);
    },
  );
});

test("left_click sends an element token, never a bare index", async () => {
  await withRuntime(
    baseScript({
      click: envelope({
        delivery: { mode: "background", delivered_count: 1 },
        effect: "unverifiable",
      }),
    }),
    async ({ runtime, driver }) => {
      await execute(runtime, "get_app_state", APP);
      const result = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 1 },
      });
      assert.equal(result.isError, undefined);
      const click = driver.calls.find((call) => call.name === "click");
      // 驱动拒绝裸 element_index（"bare element_index is not accepted"），token 才携带快照身份。
      assert.equal(click.args.element_token, "s00000001:1");
      assert.equal(click.args.element_index, undefined);
      // 后台投递是默认值；适配层永不主动升级到前台。
      assert.equal(click.args.delivery_mode, undefined);
      // 收据原样回传，让模型从新观察里确认结果。
      assert.equal(result.structuredContent.delivery.mode, "background");
      // PRD §7.2：投递与验证状态必须成对出现。
      assert.equal(result.structuredContent.cua.delivery, "sent");
      assert.equal(result.structuredContent.cua.verification, "inconclusive");
      assert.equal(result.structuredContent.cua.before_state_id, "s00000001");
    },
  );
});

test("an element index without a live observation is refused instead of guessed", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const result = await execute(runtime, "left_click", {
      ...APP,
      target: { type: "element", index: 0 },
    });
    assert.equal(result.isError, true);
    assert.equal(bodyOf(result).code, "element_unavailable");
    assert.equal(driver.calls.filter((call) => call.name === "click").length, 0);
  });
});

test("an element index stays valid across several actions in one cell", async () => {
  // 官方契约允许「click 一个索引，然后往它里面输入」而不重新观察。
  await withRuntime(
    baseScript({
      click: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      type_text: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
    }),
    async ({ runtime }) => {
      await execute(runtime, "get_app_state", APP);
      const first = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 1 },
      });
      const second = await execute(runtime, "type", { ...APP, text: "hello" });
      assert.equal(first.isError, undefined);
      assert.equal(second.isError, undefined);
    },
  );
});

test("key splits a normalized chord into key plus modifiers", async () => {
  await withRuntime(
    baseScript({ press_key: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      await execute(runtime, "key", { ...APP, text: "ctrl+shift+a" });
      const press = driver.calls.find((call) => call.name === "press_key");
      assert.equal(press.args.key, "a");
      assert.deepEqual(press.args.modifiers, ["ctrl", "shift"]);
    },
  );
});

test("scroll maps pages onto the driver's page unit", async () => {
  await withRuntime(
    baseScript({ scroll: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      // scroll 的签名里 target 必填，先观察再滚动。
      await execute(runtime, "get_app_state", APP);
      await execute(runtime, "scroll", {
        ...APP,
        target: { type: "element", index: 0 },
        scroll_direction: "down",
        scroll_amount: 3,
      });
      const scroll = driver.calls.find((call) => call.name === "scroll");
      assert.equal(scroll.args.direction, "down");
      assert.equal(scroll.args.by, "page");
      assert.equal(scroll.args.amount, 3);
    },
  );
});

test("drag 展平 to 目标，from 走 from_target", async () => {
  await withRuntime(
    baseScript({ drag: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      await execute(runtime, "get_app_state", APP);
      await execute(runtime, "left_click_drag", {
        ...APP,
        from_target: { type: "element", index: 0 },
        to: { type: "coordinate", x: 120, y: 240 },
      });
      const drag = driver.calls.find((call) => call.name === "drag");
      assert.equal(drag.args.element_token, "s00000001:0");
      assert.equal(drag.args.to_x, 120);
      assert.equal(drag.args.to_y, 240);
    },
  );
});

test("动作参数白名单：客户端多传的 strategy / hold_seconds 不会进入驱动入参", async () => {
  // 0.28.2 的 click / press_key schema 都没有 strategy、持续时间字段。
  // 透传的后果是 unrecognized_keys 或语义造假，所以适配层只转发白名单字段。
  await withRuntime(
    baseScript({
      press_key: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      click: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
    }),
    async ({ runtime, driver }) => {
      await execute(runtime, "key", { ...APP, text: "ctrl+a", hold_seconds: 2, strategy: "ax" });
      const press = driver.calls.find((call) => call.name === "press_key");
      assert.equal(press.args.hold_seconds, undefined);
      assert.equal(press.args.strategy, undefined);
      await execute(runtime, "left_click", {
        ...APP,
        target: { type: "coordinate", x: 10, y: 20 },
        strategy: "ax",
        click_count: 2,
      });
      const click = driver.calls.find((call) => call.name === "click");
      assert.equal(click.args.strategy, undefined);
      assert.equal(click.args.count, 2);
      assert.equal(click.args.x, 10);
    },
  );
});

test("mouse_move 只投递坐标，不要求元素观察", async () => {
  await withRuntime(
    baseScript({ move_cursor: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      const result = await execute(runtime, "mouse_move", { ...APP, x: 120, y: 240 });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      const move = driver.calls.find((call) => call.name === "move_cursor");
      assert.equal(move.args.x, 120);
      assert.equal(move.args.y, 240);
      // 非负整数守卫：负坐标必须在驱动调用前被拒。
      const bad = await execute(runtime, "mouse_move", { ...APP, x: -1, y: 3 });
      assert.equal(bodyOf(bad).code, "invalid_request");
      assert.equal(driver.calls.filter((call) => call.name === "move_cursor").length, 1);
    },
  );
});

test("an unlaunched app is launched once through its bundle id", async () => {
  // 与 CE 断言的差异：0.28.2 的 launch_app schema 只有 bundle_id / name，
  // 没有 launch_path —— CE 传 launch_path 会被拒（见 docs/development/computer-use.md）。
  let running = false;
  await withRuntime(
    baseScript({
      list_apps: () => {
        const apps = running
          ? [{ name: "Dolphin", pid: 42, running: true, bundle_id: "org.kde.dolphin" }]
          : [
              {
                name: "Dolphin",
                pid: 0,
                running: false,
                bundle_id: "org.kde.dolphin",
                launch_path: "dolphin",
              },
            ];
        return envelope({ apps });
      },
      launch_app: () => {
        running = true;
        return envelope({ launched: true });
      },
    }),
    async ({ runtime, driver }) => {
      const result = await execute(runtime, "list_windows", APP);
      assert.equal(result.isError, undefined);
      assert.equal(driver.calls.filter((call) => call.name === "launch_app").length, 1);
      assert.equal(
        driver.calls.find((call) => call.name === "launch_app").args.bundle_id,
        "org.kde.dolphin",
      );
    },
  );
});

test("an unknown app reports the retryable not-running message", async () => {
  await withRuntime(baseScript({ list_apps: envelope({ apps: [] }) }), async ({ runtime }) => {
    const result = await execute(runtime, "get_app_state", { app_ref: { name: "NoSuchApp" } });
    assert.equal(result.isError, true);
    const body = bodyOf(result);
    // 客户端按这个前缀决定「换字段再查一次」，改文案会静默废掉那条备用查询。
    assert.match(body.message, /target app is not running/u);
  });
});

// ─────────────────────────────────────────── 方法全覆盖守卫

test("每个已实现 method 都能跑通（不存在漏 import 的运行时 ReferenceError）", async () => {
  // 背景：抽出 diagnostics 模块时漏了 readPermissionReport /
  // CUA_REQUEST_ACCESS_STATUS_META_KEY 两个 import，request_access 一调用就
  // INTERNAL: xxx is not defined。单测只覆盖被测方法，所以漏了一个月没人发现。
  // 这个守卫遍历运行时声明的全部 method，任何「用到未导入符号」都会在这里现形。
  const { CUA_METHOD_NAMES } = await import("../index.js");
  const readOnly = new Set([
    "list_apps",
    "list_windows",
    "request_access",
    "get_capabilities",
    "get_diagnostics",
    "stop_computer_control",
  ]);
  const withTarget = {
    left_click: { target: { type: "element", index: 1 } },
    left_click_drag: {
      from_target: { type: "element", index: 0 },
      to: { type: "coordinate", x: 1, y: 2 },
    },
    scroll: { target: { type: "element", index: 0 }, scroll_direction: "down" },
    mouse_move: { x: 1, y: 2 },
    type: { text: "x" },
    set_value: { value: "x" },
    key: { text: "ctrl+a" },
  };
  for (const method of CUA_METHOD_NAMES) {
    if (!readOnly.has(method) && !(method in withTarget)) continue; // 未实现的那三个
    const args = readOnly.has(method) ? {} : { ...APP, ...withTarget[method] };
    if (method === "get_app_state") continue; // 需要先观察，另有专门用例
    if (method === "stop_computer_control") continue; // 会触发 kill switch，另有专门用例
    const script = baseScript({
      click: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      drag: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      type_text: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      set_value: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      press_key: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      scroll: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      move_cursor: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
    });
    await withRuntime(script, async ({ runtime }) => {
      const result = await execute(runtime, method, args);
      const body = result.isError ? bodyOf(result) : null;
      assert.equal(
        body?.code === "internal" && /is not defined/.test(String(body?.message ?? "")),
        false,
        `${method} 触发未定义引用：${body?.message ?? ""}`,
      );
      assert.notEqual(body?.code, "unimplemented", `${method} 应已实现`);
    });
  }
});
