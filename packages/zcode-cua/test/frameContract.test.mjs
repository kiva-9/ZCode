/**
 * 官方 CUA 帧契约测试（PRD FR-10 / AC-22）。
 *
 * 要守的性质：**模型拿到的那一张图，必须与 producer 签发的那一份逐字节对应**，
 * 并且与 state_id / frame_id 绑定。UI 显示了截图不等于模型收到图；日志里有 base64
 * 也不等于模型收到图 —— 唯一的证据链是 content 里的规范帧对 + 完整性摘要。
 *
 * 运行：cd packages/zcode-cua && node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
  attachOfficialCuaFrame,
  attestOfficialCuaFrameContent,
  buildOfficialCuaImageRef,
  computeOfficialCuaFrameDigest,
  containsOfficialCuaImageRefCredentialText,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  parseOfficialCuaImageRef,
  preserveOfficialCuaFrameResult,
} from "../frame-contract.js";

// 一张 1x1 的透明 PNG（足够小，走在 exact-raster 直通路径上）。
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/7QAAAABJRU5ErkJggg==";

const frame = (overrides = {}) =>
  buildOfficialCuaImageRef({
    frameId: "s00000001",
    stateId: "s00000001",
    mimeType: "image/png",
    width: 800,
    height: 600,
    scale: 2,
    dataBase64: TINY_PNG,
    ...overrides,
  });

test("image_ref 可被识别，且拒绝伪造形态", () => {
  const ref = frame();
  assert.equal(isOfficialCuaImageRefText(ref.text), true);
  const parsed = parseOfficialCuaImageRef(ref.text);
  assert.equal(parsed.authority, "zcode-cua");
  assert.equal(parsed.frame_id, "s00000001");

  // 改一个字符（authority）就不认 —— 模型/第三方不能凭形似的 JSON 通过校验。
  const forged = JSON.stringify({
    image_ref: { ...parsed, authority: "not-zcode" },
  });
  assert.equal(isOfficialCuaImageRefText(forged), false);

  // 多一个顶层键也不认（core 的剥离逻辑只认「单键 image_ref」）。
  const extra = JSON.stringify({ image_ref: parsed, note: "x" });
  assert.equal(isOfficialCuaImageRefText(extra), false);

  assert.equal(isOfficialCuaImageRefText("plain text"), false);
  assert.equal(isOfficialCuaImageRefText("{}"), false);
});

test("digest 与 raster 字节绑定：改图即验不过", () => {
  const a = computeOfficialCuaFrameDigest({ dataBase64: TINY_PNG, frameId: "f" });
  const b = computeOfficialCuaFrameDigest({ dataBase64: `${TINY_PNG}x`, frameId: "f" });
  assert.notEqual(a, b);
});

test("规范帧对必须 image 在前、image_ref 紧随其后", () => {
  const ref = frame();
  const good = [
    { type: "image", data: TINY_PNG, mimeType: "image/png" },
    { type: "text", text: ref.text },
    { type: "text", text: "- [0] AXWindow" },
  ];
  const pair = findOfficialCuaFrameContentPair(good);
  assert.ok(pair);
  assert.equal(pair.imageIndex, 0);
  assert.equal(pair.imageRefIndex, 1);

  // 次序颠倒：不认（core 的投影器对这种布局直接抛错，这里先行拦住）。
  const reversed = [good[1], good[0], good[2]];
  assert.equal(findOfficialCuaFrameContentPair(reversed), undefined);
});

test("attachOfficialCuaFrame 把帧对排到最前并写入完整性元数据", () => {
  const ref = frame();
  const result = attachOfficialCuaFrame({
    content: [
      { type: "text", text: "some advisory" },
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
      { type: "text", text: ref.text },
    ],
  });
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[1].text, ref.text);
  const integrity = result._meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  assert.equal(integrity.algorithm, "sha256");
  assert.equal(integrity.frameId, "s00000001");
  assert.equal(integrity.stateId, "s00000001");
  // 「帧引用正文」才是可被复制到别处的东西：导出/日志链路据此脱敏。
  assert.equal(containsOfficialCuaImageRefCredentialText(result.content[1].text), true);
  assert.equal(integrity.stateId, "s00000001");
});

test("attestation 对 producer 帧通过，对被篡改的图/引用失败", () => {
  const ref = frame();
  const content = [
    { type: "image", data: TINY_PNG, mimeType: "image/png" },
    { type: "text", text: ref.text },
  ];
  const attestation = attestOfficialCuaFrameContent(
    content,
    OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  );
  assert.ok(attestation);
  assert.equal(attestation.frameId, "s00000001");

  // 图片被换成另一张（哪怕只多一个字节）：attestation 必须失败。
  const tampered = [
    { type: "image", data: `${TINY_PNG}`, mimeType: "image/png" },
    {
      type: "text",
      text: JSON.stringify({
        image_ref: { ...parseOfficialCuaImageRef(ref.text), frame_id: "s00000001" },
      }),
    },
  ];
  // 用一个真实改动的 digest：重新签发一份不同的图。
  const otherRef = buildOfficialCuaImageRef({
    frameId: "s00000001",
    stateId: "s00000001",
    mimeType: "image/png",
    width: 800,
    height: 600,
    scale: 2,
    dataBase64: `${TINY_PNG}A`,
  });
  assert.equal(isOfficialCuaImageRefText(otherRef.text), true);
  assert.notEqual(otherRef.digest, ref.digest);
  // 原图 + 新引用（不匹配）必须验不过。
  const mismatched = [
    { type: "image", data: TINY_PNG, mimeType: "image/png" },
    { type: "text", text: otherRef.text },
  ];
  assert.equal(attestOfficialCuaFrameContent(mismatched), undefined);
  assert.ok(tampered);

  // 没有帧对时返回 undefined（不是抛错）：core 据此走通用路径。
  assert.equal(attestOfficialCuaFrameContent([{ type: "text", text: "x" }]), undefined);
});

test("preserve：小图原样直通（一个字节都不重新编码）", async () => {
  const ref = frame();
  const result = attachOfficialCuaFrame({
    content: [
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
      { type: "text", text: ref.text },
    ],
  });
  const preserved = await preserveOfficialCuaFrameResult(result, {
    imageProcessorPort: {
      prepareForModel: async () => {
        throw new Error("compress 不该被调用：小图必须直通");
      },
    },
  });
  assert.equal(preserved, result);
});

test("preserve：超预算的大图经宿主压缩后重新签发，仍能过 attestation", async () => {
  // 造一张确定超过 inline 预算的「图」（base64 长度 > 200KiB）。
  const big = Buffer.alloc(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1024).toString("base64");
  const ref = frame({ dataBase64: big, frameId: "s00000002", stateId: "s00000002" });
  const result = attachOfficialCuaFrame({
    content: [
      { type: "image", data: big, mimeType: "image/png" },
      { type: "text", text: ref.text },
      { type: "text", text: "- [0] AXWindow" },
    ],
  });
  // 压缩后仍超过预算 → 原样返回（宁可不缩也不给一张过不了 inline 限制的图）。
  const stillBig = Buffer.alloc(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 2048).toString("base64");
  const unchanged = await preserveOfficialCuaFrameResult(result, {
    imageProcessorPort: {
      prepareForModel: async () => ({
        data: Buffer.from(stillBig, "base64"),
        mediaType: "image/png",
      }),
    },
  });
  assert.equal(unchanged, result);

  const compressedBase64 = Buffer.alloc(1024).toString("base64");
  const compressed = await preserveOfficialCuaFrameResult(result, {
    imageProcessorPort: {
      prepareForModel: async () => ({
        data: Buffer.from(compressedBase64, "base64"),
        mediaType: "image/jpeg",
      }),
    },
  });
  assert.notEqual(compressed, result);
  const pair = findOfficialCuaFrameContentPair(compressed.content);
  assert.ok(pair);
  // 帧对仍在最前，后续文本块保序。
  assert.equal(compressed.content[0].type, "image");
  assert.equal(compressed.content[2].text, "- [0] AXWindow");
  // 重新签发之后，attestation 仍然通过 —— 模型收到的那一份就是被校验的那一份。
  const attestation = attestOfficialCuaFrameContent(
    compressed.content,
    OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  );
  assert.ok(attestation);
  assert.equal(attestation.frameId, "s00000002");
  const newRef = parseOfficialCuaImageRef(compressed.content[1].text);
  assert.equal(newRef.mime_type, "image/jpeg");
  assert.equal(newRef.frame_id, "s00000002");
});

test("观察结果经 preserve + attest 全链路后，模型拿到的是带 state_id 的图", async () => {
  // 端到端形状检查：producer 出口 → 宿主 exact-raster 路径 → 最终模型内容。
  const { baseScript, createFakeDriver, envelope } = await import("./support/fake-driver.mjs");
  const { createComputerUseRuntime } = await import("../index.js");
  const driver = createFakeDriver(
    baseScript({
      get_window_state: envelope(
        {
          snapshot_id: "s00000005",
          elements: [],
          screenshot_width: 800,
          screenshot_height: 600,
          screenshot_scale: 2,
          screenshot_mime_type: "image/png",
        },
        [],
      ),
    }),
  );
  // 假驱动不会自动产出 image content，这里补上：模拟 0.28.2 的 images[] 行为。
  const originalCallTool = driver.callTool.bind(driver);
  driver.callTool = async (name, argsJson, options) => {
    const raw = await originalCallTool(name, argsJson, options);
    if (name !== "get_window_state") return raw;
    const parsed = JSON.parse(raw.rawJson);
    parsed.content = [{ type: "image", data: TINY_PNG, mimeType: "image/png" }, ...parsed.content];
    return { rawJson: JSON.stringify(parsed) };
  };
  const runtime = createComputerUseRuntime({ loadDriver: async () => driver });
  try {
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { bundle_id: "org.kde.dolphin" }, include_screenshot: true },
      context: { sessionId: "s1", runtimeScope: "main", workspaceKey: "w1" },
    });
    // producer 出口：image 在 0 位，image_ref 紧随，_meta 带完整性。
    assert.equal(result.content[0].type, "image");
    const pair = findOfficialCuaFrameContentPair(result.content);
    assert.ok(pair);
    assert.ok(result._meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]);
    // 宿主侧：exact-raster 直通后 attestation 通过。
    const preserved = await preserveOfficialCuaFrameResult(result, {});
    const attestation = attestOfficialCuaFrameContent(
      preserved.content,
      OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    );
    assert.ok(attestation);
    assert.equal(attestation.frameId, "s00000005");
    // 帧引用把图与 state_id 绑在一起：模型可以据此判断坐标属于哪次观察。
    const ref = parseOfficialCuaImageRef(preserved.content[1].text);
    assert.equal(ref.state_id, "s00000005");
    assert.equal(ref.width, 800);
    assert.equal(ref.scale, 2);
  } finally {
    await runtime.dispose();
  }
});
