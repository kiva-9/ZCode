// 冷恢复用量还原（sumPersistedUsageTotals）单测：node:test。
// 运行：node --import tsx --test apps/zcode-cli/packages/bootstrap/test/session-usage-totals.test.ts
// 背景：transcript 合成的 ModelComplete 只带零用量占位（transcript-hydration.ts），
// 重启后 snapshot.usage.cumulative/stats 从 0 起算、StatsPills 用量 pill 消失；
// 本折叠把持久 assistant 消息的 tokens 与 wall 计时汇总成恢复种子。
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageInfo } from "@zcode/contracts";
import { sumPersistedUsageTotals } from "../src/zcode-protocol/session-usage-totals.ts";

interface Msg {
  info: {
    role: string;
    summary?: MessageInfo["summary"];
    tokens?: {
      total?: number;
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    time?: { created: number; completed?: number; firstTokenAt?: number };
  };
}

const assistant = (
  input: number,
  output: number,
  cache: { read: number; write: number } = { read: 0, write: 0 },
): Msg => ({
  info: {
    role: "assistant",
    tokens: { input, output, reasoning: 0, cache },
  },
});

const timedAssistant = (
  input: number,
  output: number,
  time: { created: number; completed?: number; firstTokenAt?: number },
  cache: { read: number; write: number } = { read: 0, write: 0 },
): Msg => ({
  info: {
    role: "assistant",
    tokens: { input, output, reasoning: 0, cache },
    time,
  },
});

test("汇总全部非 summary assistant 消息的四个计费桶（无计时字段时计时为零）", () => {
  const messages: Msg[] = [
    { info: { role: "user" } },
    assistant(100, 50, { read: 800, write: 50 }),
    assistant(120, 30, { read: 700, write: 0 }),
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.deepEqual(totals, {
    inputTokens: 220,
    outputTokens: 80,
    cacheReadTokens: 1_500,
    cacheWriteTokens: 50,
    llmMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    requests: 2,
  });
});

test("wall 计时：llmMs/ttftMs/ttftSteps/decodeMs 按 created/firstTokenAt/completed 汇总", () => {
  const messages: Msg[] = [
    // created=1000，首 token=1500（ttft 500ms），completed=3000（decode 1500ms，llm 2000ms）
    timedAssistant(100, 500, { created: 1_000, firstTokenAt: 1_500, completed: 3_000 }),
    // 无 firstTokenAt 的旧消息：只累计 llmMs，不编造 ttft/decode
    timedAssistant(100, 200, { created: 4_000, completed: 4_800 }),
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.equal(totals?.llmMs, 2_800);
  assert.equal(totals?.ttftMs, 500);
  assert.equal(totals?.ttftSteps, 1);
  assert.equal(totals?.decodeMs, 1_500);
  assert.equal(totals?.outputTokens, 700);
});

test("firstTokenAt 早于 created 的异常时钟不产生负跨度", () => {
  const messages: Msg[] = [
    timedAssistant(100, 10, { created: 2_000, firstTokenAt: 1_500, completed: 2_500 }),
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.equal(totals?.llmMs, 500);
  assert.equal(totals?.ttftMs, 0);
  assert.equal(totals?.ttftSteps, 0);
  assert.equal(totals?.decodeMs, 1_000);
});

test("compact summary 消息不参与汇总（重写历史边界，不是 provider 记账）", () => {
  const messages: Msg[] = [
    assistant(100, 50),
    {
      info: {
        role: "assistant",
        summary: true,
        tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.deepEqual(totals, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    requests: 1,
  });
});

test("用户消息的摘要对象符合输入契约且不参与用量汇总", () => {
  const messages: Msg[] = [
    {
      info: {
        role: "user",
        summary: { title: "测试摘要", diffs: [] },
        tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1_000, completed: 9_000, firstTokenAt: 2_000 },
      },
    },
    timedAssistant(100, 50, { created: 2_000, firstTokenAt: 2_100, completed: 2_500 }),
  ];
  assert.deepEqual(sumPersistedUsageTotals(messages), {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmMs: 500,
    ttftMs: 100,
    ttftSteps: 1,
    decodeMs: 400,
    requests: 1,
  });
});

test("没有任何带 token 的 assistant 消息时返回 null（无种子可播）", () => {
  assert.equal(sumPersistedUsageTotals([{ info: { role: "user" } }]), null);
  assert.equal(sumPersistedUsageTotals([]), null);
  assert.equal(sumPersistedUsageTotals([assistant(0, 0, { read: 0, write: 0 })]), null);
});

test("total 字段不参与桶汇总（total 是上下文占用口径，与分桶计费不同源）", () => {
  const messages: Msg[] = [
    {
      info: {
        role: "assistant",
        tokens: {
          total: 12345,
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.equal(totals?.inputTokens, 100);
  assert.equal(totals?.outputTokens, 50);
});
