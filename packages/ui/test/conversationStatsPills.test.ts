// 会话计量（StatsPills）纯计算层单测：node:test。
// 运行：node --import tsx --test packages/ui/test/conversationStatsPills.test.ts
// 覆盖 docs/specs/2026-09-30-conversation-composer-stats-pills.md 的验收点：
// 缓存命中取整语义（部分命中永不 100）、总量口径、pill 门禁、decode 速度、紧凑时长。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ZERO_SESSION_STATS,
  billedInputTokens,
  formatCacheHitPercent,
  formatOutputSpeedValue,
  sessionDecodeSpeed,
  shouldShowTimePill,
  shouldShowUsagePill,
  splitCompactDuration,
  totalBilledTokens,
  type CumulativeUsage,
} from "../src/v4/chat/sessionStatsFormat.ts";

const cumulative = (overrides: Partial<CumulativeUsage>): CumulativeUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
});

const stats = (overrides: Partial<typeof ZERO_SESSION_STATS>) => ({
  ...ZERO_SESSION_STATS,
  ...overrides,
});

test("计费桶与总量：input+cacheRead+cacheWrite 为提示侧，+output 为总量", () => {
  const usage = cumulative({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 50 });
  assert.equal(billedInputTokens(usage), 950);
  assert.equal(totalBilledTokens(usage), 1_000);
});

test("缓存命中：全命中显示 100", () => {
  assert.equal(formatCacheHitPercent(1_000, 1_000), "100");
});

test("缓存命中：无计费输入返回 null", () => {
  assert.equal(formatCacheHitPercent(0, 0), null);
});

test("缓存命中：整数档四舍五入（0.985 → 99）", () => {
  assert.equal(formatCacheHitPercent(985, 1_000), "99");
});

test("缓存命中：会把部分命中抬成 100 时自动补小数位（999/1000 → 99.9；9999/10000 → 99.99）", () => {
  // DSH 语义逐字移植：补到「不再四舍五入到 100」的最小精度。
  assert.equal(formatCacheHitPercent(999, 1_000), "99.9");
  assert.equal(formatCacheHitPercent(9_999, 10_000), "99.99");
});

test("缓存命中：极高部分命中补足够小数位", () => {
  const text = formatCacheHitPercent(999_999, 1_000_000);
  assert.ok(text !== null && text.startsWith("99.") && text !== "100");
});

test("pill 门禁：无闭合步且无 token 活动时两个 pill 都不渲染", () => {
  assert.equal(shouldShowTimePill(stats({})), false);
  assert.equal(shouldShowUsagePill(cumulative({})), false);
});

test("pill 门禁：有步数渲染时间 pill；有 token 活动渲染用量 pill", () => {
  assert.equal(shouldShowTimePill(stats({ steps: 3 })), true);
  assert.equal(shouldShowUsagePill(cumulative({ outputTokens: 1 })), true);
});

test("decode 速度：decodeTokens ÷ decodeMs，无计时返回 null", () => {
  assert.equal(sessionDecodeSpeed(stats({})), null);
  // 2_000 tokens / 20s = 100 tok/s
  assert.equal(sessionDecodeSpeed(stats({ decodeMs: 20_000, decodeTokens: 2_000 })), 100);
});

test("速度数值格式：≥10 取整，<10 一位小数", () => {
  assert.equal(formatOutputSpeedValue(100), "100");
  assert.equal(formatOutputSpeedValue(9.94), "9.9");
  assert.equal(formatOutputSpeedValue(5), "5");
  assert.equal(formatOutputSpeedValue(-3), "0");
});

test("紧凑时长：一分钟内报秒，之后分+秒", () => {
  assert.deepEqual(splitCompactDuration(45_230), { kind: "seconds", seconds: 45.2 });
  assert.deepEqual(splitCompactDuration(162_000), { kind: "minutes", minutes: 2, seconds: 42 });
});
