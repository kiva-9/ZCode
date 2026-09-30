// 冷恢复用量还原（纯折叠，无 IO）。
//
// 背景：v4 snapshot 的 usage.cumulative 由 ModelComplete 事件累加，而冷恢复时
// transcript 合成出的 ModelComplete 只带零用量占位（v4-gateway 注释），重启后
// 会话计量从 0 起算，StatsPills 用量 pill 直接消失。
// 持久事实在 transcript 的 assistant 消息里：每条 info.tokens 记录
// { total?, input, output, reasoning, cache: { read, write } }（TokenUsageInfo），
// info.time 记录 { created, firstTokenAt?, completed? }。本模块把全量非 summary
// assistant 消息汇总成四个计费桶与三组 wall 计时，经 getSessionUsageSeed 播种给
// ProductProjection（与 contextWindow 种子同一条恢复路径、同一守卫）。
import type { TokenUsageInfo } from "@zcode/contracts";

/** 汇总入口需要的最小消息形状（结构类型，MessageWithParts 天然满足）。 */
export interface UsageTotalsMessageLike {
  info: {
    role: string;
    summary?: boolean;
    /** 仅 assistant 消息持久化 tokens/time；其他角色缺省（折叠时跳过）。 */
    tokens?: TokenUsageInfo;
    time?: {
      created: number;
      completed?: number;
      firstTokenAt?: number;
    };
  };
}

export interface SessionUsageTotals {
  /** 未缓存输入合计（与 ModelComplete → cumulative.inputTokens 同口径）。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 模型请求墙钟合计（time.created → time.completed；DSH llmMs）。 */
  llmMs: number;
  /** 首 token 延迟合计（time.created → time.firstTokenAt；DSH ttftMs）。 */
  ttftMs: number;
  /** 记录了首 token 的请求数（DSH ttftSteps）。 */
  ttftSteps: number;
  /** 解码用时合计（time.firstTokenAt → time.completed；DSH decodeMs）。 */
  decodeMs: number;
  /** 参与汇总的 assistant 请求数。 */
  requests: number;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegativeSpan(from: number | undefined, to: number | undefined): number {
  if (typeof from !== "number" || typeof to !== "number") return 0;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

/**
 * 汇总持久化 assistant 消息的计费桶与 wall 计时。
 * 只统计非 summary 的 assistant 消息：compact summary 是重写后的历史边界，
 * 其 tokens 不是 provider 请求记账（与 contextCacheUsageFromMessages 同口径）。
 * 旧消息缺 time.firstTokenAt 时 ttft/decode 记 0，llmMs 与计费桶不受影响。
 * @param messages 持久化 transcript 消息。
 * @returns 汇总值；没有任何带 token 的 assistant 消息时返回 null（无种子可播）。
 */
export function sumPersistedUsageTotals(
  messages: readonly UsageTotalsMessageLike[],
): SessionUsageTotals | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let llmMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  let decodeMs = 0;
  let requests = 0;
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const tokens = message.info.tokens;
    if (!tokens) {
      continue;
    }
    const input = nonNegative(tokens.input);
    const read = nonNegative(tokens.cache?.read);
    const write = nonNegative(tokens.cache?.write);
    const output = nonNegative(tokens.output);
    if (input <= 0 && read <= 0 && write <= 0 && output <= 0) {
      continue;
    }
    requests += 1;
    inputTokens += input;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    outputTokens += output;
    // 计时：created/completed 是消息级持久事实；firstTokenAt 为首个输出增量
    // （缺失时不编造 ttft/decode，只累计 llmMs）。
    const time = message.info.time;
    llmMs += nonNegativeSpan(time?.created, time?.completed);
    const firstTokenAt = time?.firstTokenAt;
    if (typeof firstTokenAt === "number" && Number.isFinite(firstTokenAt)) {
      const ttft = nonNegativeSpan(time?.created, firstTokenAt);
      if (ttft > 0) {
        ttftMs += ttft;
        ttftSteps += 1;
      }
      decodeMs += nonNegativeSpan(firstTokenAt, time?.completed);
    }
  }
  if (requests <= 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    llmMs,
    ttftMs,
    ttftSteps,
    decodeMs,
    requests,
  };
}
