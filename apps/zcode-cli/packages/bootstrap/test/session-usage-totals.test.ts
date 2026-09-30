// 冷恢复用量还原（sumPersistedUsageTotals）单测：node:test。
// 运行：node --import tsx --test apps/zcode-cli/packages/bootstrap/test/session-usage-totals.test.ts
// 背景：transcript 合成的 ModelComplete 只带零用量占位（transcript-hydration.ts），
// 重启后 snapshot.usage.cumulative 从 0 起算、StatsPills 用量 pill 消失；
// 本折叠把持久 assistant 消息的 tokens 汇总成恢复种子。
import assert from "node:assert/strict";
import test from "node:test";
import { sumPersistedUsageTotals } from "../src/zcode-protocol/session-usage-totals.ts";

interface Msg {
  info: {
    role: string;
    summary?: boolean;
    tokens?: {
      total?: number;
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
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

test("汇总全部非 summary assistant 消息的四个计费桶", () => {
  const messages: Msg[] = [
    { info: { role: "user", tokens: undefined } },
    assistant(100, 50, { read: 800, write: 50 }),
    assistant(120, 30, { read: 700, write: 0 }),
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.deepEqual(totals, {
    inputTokens: 220,
    outputTokens: 80,
    cacheReadTokens: 1_500,
    cacheWriteTokens: 50,
    requests: 2,
  });
});

test("compact summary 消息不参与汇总（重写历史边界，不是 provider 记账）", () => {
  const messages: Msg[] = [
    assistant(100, 50),
    { info: { role: "assistant", summary: true, tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } } } },
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.deepEqual(totals, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 1,
  });
});

test("没有任何带 token 的 assistant 消息时返回 null（无种子可播）", () => {
  assert.equal(sumPersistedUsageTotals([{ info: { role: "user" } }]), null);
  assert.equal(sumPersistedUsageTotals([]), null);
  assert.equal(
    sumPersistedUsageTotals([assistant(0, 0, { read: 0, write: 0 })]),
    null,
  );
});

test("total 字段不参与桶汇总（total 是上下文占用口径，与分桶计费不同源）", () => {
  const messages: Msg[] = [
    {
      info: {
        role: "assistant",
        tokens: { total: 12345, input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  ];
  const totals = sumPersistedUsageTotals(messages);
  assert.equal(totals?.inputTokens, 100);
  assert.equal(totals?.outputTokens, 50);
});
