// 会话计量（StatsPills）纯计算层。
// 移植自 DSH 开源仓库 deepseek-ai/deepseek-harness 的 StatsPills.tsx / token-format.ts：
// 缓存命中百分比取整语义逐字保留——部分命中永不显示 100%（自动补小数位区分），
// 全命中显示 100，无计费输入返回 null。行为取舍见
// docs/specs/2026-09-30-conversation-composer-stats-pills.md。
import type { SessionStatsState, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";

/**
 * usage.cumulative 的四个计费桶。
 * inputTokens 是提示侧**总量**口径（AI SDK total：原始未缓存输入 + 缓存读取 + 缓存写入，
 * 见 @ai-sdk/anthropic convertAnthropicMessagesUsage 与 ai 核心 asLanguageModelUsage 的展平），
 * 「未缓存输入」须用 uncachedInputTokens 派生；移植初期误当作独立未缓存口径，见 spec §8。
 */
export type CumulativeUsage = SessionUsageState["cumulative"];

/** 旧快照 / 草稿态兜底：schema default 之前的零值。 */
export const ZERO_SESSION_STATS: SessionStatsState = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
};

/** usage 缺失时的零计费桶（StatsPills 门禁下整体不渲染）。 */
export const ZERO_CUMULATIVE: CumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * 未缓存输入 = 提示总量 − 缓存读取 − 缓存写入（即 AI SDK 的 noCacheTokens）。
 * 理论上 inputTokens ≥ cacheRead + cacheWrite；防御性钳到 0，避免异常数据出现负数读数。
 */
export function uncachedInputTokens(usage: CumulativeUsage): number {
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
}

/** 提示侧计费总量 = usage.inputTokens（总量口径已含缓存读取/写入，不重复相加）。 */
export function billedInputTokens(usage: CumulativeUsage): number {
  return usage.inputTokens;
}

/** pill 展示总量 = 提示侧计费总量 + 输出（DSH UsagePill 的 total 口径）。 */
export function totalBilledTokens(usage: CumulativeUsage): number {
  return billedInputTokens(usage) + usage.outputTokens;
}

/** 会话是否有任何 token 活动；全失败请求的会话不渲染用量 pill。 */
export function hasTokenActivity(usage: CumulativeUsage): boolean {
  return billedInputTokens(usage) > 0 || usage.outputTokens > 0;
}

/** 正数向上取整的百分比单位（0 位或 1 位小数）。DSH roundedPercentUnits 的等价实现。 */
function roundedPercentUnits(
  cacheReadTokens: number,
  denominator: number,
  decimalPlaces: 0 | 1,
): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold =
      factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * 缓存命中率展示文本：整数档四舍五入；会把部分命中抬成 100 时自动补小数位
 * （如 99.9 / 99.99），保证「不满 100 就看不到 100」。
 * @param cacheReadTokens 缓存读取 token 数。
 * @param promptTokens 提示侧计费 token 总量。
 * @returns 百分比数字文本；无计费输入返回 null。
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null;
  const missedInputTokens = promptTokens - cacheReadTokens;
  if (missedInputTokens === 0) return "100";

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}

/**
 * 输出速度数值：≥10 取整，<10 保留一位小数（DSH formatTokensPerSecond 口径）。
 * @param tps tokens per second。
 * @returns 不含单位的数值文本。
 */
export function formatOutputSpeedValue(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * decode 口径的会话输出速度（tok/s）：decodeTokens ÷ decodeMs。
 * 与 DSH StatsPills 的 TimePill 同公式；无 decode 计时返回 null（不显示速度）。
 */
export function sessionDecodeSpeed(stats: SessionStatsState): number | null {
  if (stats.decodeMs <= 0) return null;
  return stats.decodeTokens / (stats.decodeMs / 1_000);
}

/** 时间 pill 渲染门禁：至少闭合过一个模型步（DSH steps > 0 同口径）。 */
export function shouldShowTimePill(stats: SessionStatsState): boolean {
  return stats.steps > 0;
}

/** 用量 pill 渲染门禁：存在任何计费 token 活动。 */
export function shouldShowUsagePill(cumulative: CumulativeUsage): boolean {
  return hasTokenActivity(cumulative);
}

/** 紧凑时长的分解结果：一分钟内只报秒，之后按分+秒报（DSH formatDuration 口径）。 */
export type CompactDuration =
  | { kind: "seconds"; seconds: number }
  | { kind: "minutes"; minutes: number; seconds: number };

/**
 * 紧凑时长分解：一分钟内保留一位小数秒，之后「X分Y秒」。
 * @param ms 毫秒。
 * @returns 分解结果，调用方按 locale 取文案。
 */
export function splitCompactDuration(ms: number): CompactDuration {
  const seconds = ms / 1_000;
  if (seconds < 60) return { kind: "seconds", seconds: Math.round(seconds * 10) / 10 };
  const whole = Math.round(seconds);
  return { kind: "minutes", minutes: Math.floor(whole / 60), seconds: whole % 60 };
}
