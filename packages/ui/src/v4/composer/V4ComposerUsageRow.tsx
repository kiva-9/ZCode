// V4 composer 计量行：输入框 surface 正下方的新行容器。
// - 第一行：DSH 移植的 StatsPills（会话轮次/步数/速度 + 总 tok/缓存命中），见 v4/chat/StatsPills.tsx；
// - 第二行：从 V4ComposerToolbar 下移的上下文窗口计量（ChatContextUsage），展示与交互不变。
// 搬迁依据与验收：docs/specs/2026-09-30-conversation-composer-stats-pills.md。
// 原工具条里只服务 ChatContextUsage 的 entitlement / coding plan / start plan wiring 整块随行迁移，
// 不保留第二份；压缩入口禁用条件收敛为 disabled（recoveryPending 是工具条内部模型恢复态，
// 发送门禁在宿主已覆盖，spec 3.5 有记录）。
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import type { SessionConfigState, SessionStatsState, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { BUILTIN_MODEL_PROVIDER_IDS, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import type { CodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import {
  writeSidebarUsageCodingPlanProviderPreference,
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsUsageCodingPlanIntent } from "@/lib/settingsNavigation.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { resolveDraftDisplayedConfig } from "./draftWorkspaceDefaults.js";
import {
  resolveContextCodingPlanUsageSource,
  resolveV4ContextPlanConnection,
} from "./v4ContextUsage.js";
import { StatsPills } from "../chat/StatsPills.js";
import { ZERO_CUMULATIVE } from "../chat/sessionStatsFormat.js";

export interface V4ComposerUsageRowProps {
  /** 当前展示中的 provider（宿主透传，与 ChatContextUsage 搬迁前一致）。 */
  provider?: ZCodeProvider;
  /** 当前 scope 的 Composer 草稿选择；context plan 连接按 effectiveConfig.provider 解析。 */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  /** 会话计量（snapshot.stats）；旧快照缺省时宿主传零值。 */
  stats: SessionStatsState;
  disabled: boolean;
  onSendCompressionCommand?: (command: string) => void;
}

function V4ComposerUsageRowImpl({
  provider,
  draftConfig,
  usage,
  stats,
  disabled,
  onSendCompressionCommand,
}: V4ComposerUsageRowProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // 有效模型身份与搬迁前 V4ComposerToolbar 同一解析（草稿态取草稿选择）。
  const effectiveConfig = useMemo<SessionConfigState | null>(
    () => resolveDraftDisplayedConfig(draftConfig ?? {}),
    [draftConfig],
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  const { settings: sharedSettings } = useSettings();
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Context 只在用户 hover/open 时刷新，不在 composer 挂载时请求额度。
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);

  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // 剩余额度「更多」直达 Coding Plan 使用统计（按上面写入的来源偏好选中当前套餐），
      // 不落到应用用量；通用 Usage 入口仍走 setPendingSettingsUsageIntent。
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [effectiveConfig?.provider, sharedSettings?.providerFamilyConnectionSelections],
  );
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  const contextStartPlanBalanceConfig = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Start Plan 只有具备独立 Account Access 时才挂载 hover 查询入口。
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // hover access 刷新入口不能只在 Coding Plan 配置上（onAccess）：
      // start plan 用户 hover context 面板从不主动刷新今日余额，只能等设置页/侧栏
      // 刷新后被动同步。接入与 Coding Plan 相同的静默 access 刷新；60s access 窗口
      // 与 in-flight 合并由刷新策略层自动生效，不会因反复 hover 放大 billing/balance 请求。
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () => refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () => handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  const contextStartPlanBalance = hasChatStartPlanBalance(contextStartPlanBalanceConfig)
    ? contextStartPlanBalanceConfig
    : undefined;

  // 原 hook 不传 family，默认只拉 bigmodel 企业 pricing，
  // zai team plan 拿不到订阅产品，模型选择器里的 team 模型组建不出来。
  // 按 contextPlanConnection.family 让 hook 拉对应 family 的 team products。
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      contextPlanConnection.kind === "teamCoding" &&
      Boolean(contextAccountProviderAccess),
    authenticated: true,
    family: contextPlanConnection.kind === "teamCoding" ? contextPlanConnection.family : undefined,
  });
  const subscribedTeamProducts = useMemo(
    () =>
      enterpriseProducts.snapshot?.productList.filter((product) => product.subscribed === true) ??
      [],
    [enterpriseProducts.snapshot?.productList],
  );
  const contextTeamUsageSourceCacheRef = useRef<CodingPlanUsageSource[]>([]);
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current,
            // 原硬取 bigmodelCodingPlan 的 entitlement snapshot，
            // zai team plan 查不到额度。改为按 connection.providerId 取对应 snapshot。
            entitlementSnapshot: entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current;
    const nextCache = cache.filter((source) => source.id !== contextCodingPlanUsageTeamSource.id);
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // Team -> Personal(no_plan) -> Team 期间企业商品或个人 snapshot 可能短暂缺失。
    // 保留最近解析过的团队 source，避免输入框 context 余额跟随水合顺序闪断。
    contextTeamUsageSourceCacheRef.current = nextCache.slice(0, 8);
  }, [contextCodingPlanUsageTeamSource]);
  const contextCodingPlanUsageSelectedSourceId: SidebarUsageCodingPlanSourceId | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  const teamEntitlement = useUsageEntitlement({
    enabled: !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // 原硬编码 bigmodelCodingPlan，zai family team plan 选中时
    // contextCodingPlanUsageTeamSource.providerId 是 zaiCodingPlan，但这里仍传 bigmodelCodingPlan
    // → 服务端 pickQuotaProvider 按 providerId 精确匹配选不到 zai provider →
    // resolveAuthorization 返回 null → zai team plan 的输入框上下文用量区域不显示额度。
    // 改为跟随 team source 的 providerId（已在 resolveContextTeamUsageSourceFromEntitlementSnapshot
    // / resolveV4ContextPlanConnection 按 family 正确产出 zaiCodingPlan/bigmodelCodingPlan）。
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // Team Plan 的 context 面板使用 sourceId 隔离自己的 freshness key；任务边界刷新时
      // 与全局 entitlement 一起发布，底层 request key 会合并相同团队请求。
      await Promise.all([refreshCodingPlanEntitlements(options), teamEntitlement.refresh(options)]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (contextPlanConnection.kind !== "personalCoding" || !contextCodingPlanUsageProviderId) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId: contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [contextAccountProviderAccess, contextCodingPlanUsageProviderId, contextPlanConnection.kind]);
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "personalCoding" && !contextCodingPlanUsageTeamSource) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () => refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () => refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    };
  }, [usage?.contextWindow]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-1" data-testid="v4-composer-usage-row">
      {/* 计量行第一行：DSH StatsPills 移植件（无数据整行不渲染）。 */}
      <StatsPills stats={stats} cumulative={usage?.cumulative ?? ZERO_CUMULATIVE} />
      {/* 计量行第二行：从工具条下移的上下文窗口计量。 */}
      <div className="flex min-w-0 items-center px-2">
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled}
        />
      </div>
    </div>
  );
}

export const V4ComposerUsageRow = memo(V4ComposerUsageRowImpl);
