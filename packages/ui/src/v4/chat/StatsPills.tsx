// 会话计量行（StatsPills）：移植自 DSH 开源仓库 deepseek-ai/deepseek-harness 的
// packages/client/ui-chat/src/client/chat/StatsPills.tsx。
//
// 行为对齐：
// - 时间 pill（gauge）：「N轮 M步 · X tok/s」；有计时数据时可点开，面板给
//   模型用时 / 工具调用用时 / 首 token 平均 / 输出速度；无任何计时数据时退化为
//   纯展示 span（DSH 的同一门禁，不开空面板）。
// - 用量 pill（database）：「X tok · 缓存命中 Y%」；面板给缓存命中与四个计费桶。
// - 两个 pill 共享一个互斥打开位（DSH 的 exclusive slot 语义）。
// - 速度 = decodeTokens / decodeMs（DSH decode 口径，数据来自 CLI stats 折叠）。
// 数据、取舍与验收见 docs/specs/2026-09-30-conversation-composer-stats-pills.md。
import { memo, useCallback, useMemo, useState } from "react";
import { Database, Gauge } from "lucide-react";
import type { SessionStatsState, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { cn } from "@/components/lib/utils.js";
import {
  billedInputTokens,
  formatCacheHitPercent,
  formatOutputSpeedValue,
  sessionDecodeSpeed,
  shouldShowTimePill,
  shouldShowUsagePill,
  splitCompactDuration,
  totalBilledTokens,
  type CumulativeUsage,
} from "./sessionStatsFormat.js";

export interface StatsPillsProps {
  stats: SessionStatsState;
  cumulative: SessionUsageState["cumulative"];
}

const PILL_BUTTON_CLASS = cn(
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-ui-sm text-foreground-subtle",
  "transition-colors hover:bg-hover hover:text-foreground",
  "data-[state=open]:bg-hover data-[state=open]:text-foreground",
  "[&_svg]:size-3.5 [&_svg]:shrink-0",
);

const PILL_SPAN_CLASS = cn(
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-ui-sm text-foreground-subtle",
  "[&_svg]:size-3.5 [&_svg]:shrink-0",
);

const PANEL_CLASS = "w-56 gap-2 rounded-xl p-3";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-ui-sm">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="font-mono tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function useDurationFormatter(): (ms: number) => string {
  const { intl } = useZCodeIntl();
  return useCallback(
    (ms: number) => {
      const duration = splitCompactDuration(ms);
      if (duration.kind === "seconds") {
        return intl.formatMessage(
          { id: "chat.stats.duration.seconds" },
          { seconds: String(duration.seconds) },
        );
      }
      return intl.formatMessage(
        { id: "chat.stats.duration.minutes" },
        { minutes: String(duration.minutes), seconds: String(duration.seconds) },
      );
    },
    [intl],
  );
}

function TimePill({ stats, open, onOpenChange }: {
  stats: SessionStatsState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const formatDuration = useDurationFormatter();
  const speed = sessionDecodeSpeed(stats);
  const counts = intl.formatMessage(
    { id: "chat.stats.counts" },
    { turns: String(stats.turns), steps: String(stats.steps) },
  );
  const speedText =
    speed !== null
      ? intl.formatMessage(
          { id: "chat.stats.tokensPerSecond" },
          { tps: formatOutputSpeedValue(speed) },
        )
      : null;
  const hasTiming =
    stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0;
  const icon = <Gauge />;
  if (!hasTiming) {
    // 没有任何计时数据（如旧会话恢复）：不开空面板，保持纯读数（DSH 同门禁）。
    return (
      <span className={PILL_SPAN_CLASS}>
        {icon}
        <span className="tabular-nums">{counts}</span>
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={PILL_BUTTON_CLASS}
        aria-label={speedText === null ? counts : `${counts} · ${speedText}`}
      >
        {icon}
        <span className="tabular-nums">
          {counts}
          {speedText !== null ? (
            <>
              <span className="mx-1.5 text-foreground-subtlest">·</span>
              {speedText}
            </>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={6} className={PANEL_CLASS}>
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <Gauge className="size-3.5" />
          {intl.formatMessage({ id: "chat.stats.dialog.title" })}
        </div>
        <dl className="grid gap-1.5">
          {stats.llmMs > 0 ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.llmTime" })}
              value={formatDuration(stats.llmMs)}
            />
          ) : null}
          {stats.toolMs > 0 ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.toolTime" })}
              value={formatDuration(stats.toolMs)}
            />
          ) : null}
          {stats.ttftSteps > 0 ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.ttft" })}
              value={formatDuration(stats.ttftMs / stats.ttftSteps)}
            />
          ) : null}
          {speed !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.speed" })}
              value={speedText ?? ""}
            />
          ) : null}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function UsagePill({ cumulative, open, onOpenChange }: {
  cumulative: CumulativeUsage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const exactNumberFormat = useMemoizedNumberFormat(locale);
  const total = totalBilledTokens(cumulative);
  const totalText = intl.formatMessage(
    { id: "chat.stats.tokenCount" },
    { count: formatCompactTokenNumber(locale, total) },
  );
  const cacheHit = formatCacheHitPercent(
    cumulative.cacheReadTokens,
    billedInputTokens(cumulative),
  );
  const cacheHitText =
    cacheHit !== null
      ? intl.formatMessage({ id: "chat.stats.cacheHit" }, { percent: cacheHit })
      : null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={PILL_BUTTON_CLASS}
        aria-label={cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`}
      >
        <Database />
        <span className="tabular-nums">
          {totalText}
          {cacheHitText !== null ? (
            <>
              <span className="mx-1.5 text-foreground-subtlest">·</span>
              {cacheHitText}
            </>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={6} className={PANEL_CLASS}>
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <Database className="size-3.5" />
          {intl.formatMessage({ id: "chat.stats.dialog.usageTitle" })}
        </div>
        <dl className="grid gap-1.5">
          {cacheHit !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.cacheHit" })}
              value={`${cacheHit}%`}
            />
          ) : null}
          <DetailRow
            label={intl.formatMessage({ id: "chat.stats.dialog.input" })}
            value={exactNumberFormat.format(cumulative.inputTokens)}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.stats.dialog.cacheRead" })}
            value={exactNumberFormat.format(cumulative.cacheReadTokens)}
          />
          {cumulative.cacheWriteTokens !== 0 ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.stats.dialog.cacheWrite" })}
              value={exactNumberFormat.format(cumulative.cacheWriteTokens)}
            />
          ) : null}
          <DetailRow
            label={intl.formatMessage({ id: "chat.stats.dialog.output" })}
            value={exactNumberFormat.format(cumulative.outputTokens)}
          />
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function useMemoizedNumberFormat(locale: string): Intl.NumberFormat {
  return useMemo(() => new Intl.NumberFormat(locale || undefined), [locale]);
}

export const StatsPills = memo(function StatsPills({ stats, cumulative }: StatsPillsProps) {
  // 一个互斥位同时服务两个面板：开一个就关另一个（DSH exclusive slot）。
  const [openPill, setOpenPill] = useState<"time" | "usage" | null>(null);
  const showTimePill = shouldShowTimePill(stats);
  const showUsagePill = shouldShowUsagePill(cumulative);
  if (!showTimePill && !showUsagePill) return null;
  return (
    <div
      className="flex min-w-0 items-center justify-center gap-3"
      data-testid="v4-composer-stats-pills"
    >
      {showTimePill ? (
        <TimePill
          stats={stats}
          open={openPill === "time"}
          onOpenChange={(open) => setOpenPill(open ? "time" : null)}
        />
      ) : null}
      {showUsagePill ? (
        <UsagePill
          cumulative={cumulative}
          open={openPill === "usage"}
          onOpenChange={(open) => setOpenPill(open ? "usage" : null)}
        />
      ) : null}
    </div>
  );
});
