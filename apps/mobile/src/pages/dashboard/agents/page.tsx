import { agentSourceBadgeClasses, hostedAgentGroupsClasses } from "@clawdi/shared/ui";
import {
	type AgentTile,
	agentSourceKindLabel,
	agentSurfaceCopy,
	hostedAgentCountLabel,
	hostedAgentGroupsCopy,
	OVERVIEW_COPY,
} from "@clawdi/shared/view";
import Cloud from "lucide-react-native/icons/cloud";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentsCard, AgentTileView } from "@/components/dashboard/agents-card";
import { useNewAgentAction } from "@/components/dashboard/new-agent-button";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebView, webBoth } from "@/components/ui/web-layout";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { WelcomeWalletCard } from "@/hosted/billing/subscription/welcome-wallet-card";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** Web's /agents index: Cloud Agents, then Connected Agents, each failing on its own. */
export default function AgentsRoute() {
	const { agents, tiles, hasHosted, canDeploy, hostedStatus } = useDashboardAgents();
	const newAgent = useNewAgentAction();
	const selfManagedError = agents.data ? undefined : agents.error;
	const hosted = tiles.filter((tile) => tile.source === "on-clawdi");
	const other = tiles.filter((tile) => tile.source !== "on-clawdi");
	const empty =
		!agents.isPending &&
		!selfManagedError &&
		(agents.data ?? []).length === 0 &&
		tiles.length === 0 &&
		!hostedStatus?.isLoading &&
		!hostedStatus?.error;
	// Without hosted compute this is Web's OSS list: one card with its own states.
	const grouped = hasHosted && !agents.isPending && !hostedStatus?.isLoading && !empty;
	const rows = grouped ? [...hosted, ...other] : [];
	const refresh = () => {
		void agents.refetch();
		hostedStatus?.onRetry?.();
	};
	return (
		<SafeAreaScreen>
			<NativeHeader title={agentSurfaceCopy.agents} actions={[newAgent]} />
			<NativeList<AgentTile>
				data={rows}
				keyExtractor={(tile) => `${tile.source}:${tile.id}`}
				refreshing={agents.isRefetching}
				onRefresh={refresh}
				header={
					<PageHeader
						title={agentSurfaceCopy.agents}
						description={agentSurfaceCopy.everyAgentInYourAccount}
					/>
				}
				empty={
					grouped ? null : hasHosted && empty ? (
						<WebView recipe="gap-4">
							<OnboardingCard canDeployOnClawdi={canDeploy} />
							<WelcomeWalletCard />
						</WebView>
					) : (
						<AgentsCard
							agents={tiles}
							isLoading={agents.isPending || hostedStatus?.isLoading === true}
							error={selfManagedError}
							onRetry={() => void agents.refetch()}
						/>
					)
				}
				renderItem={({ item, index }) => (
					<WebView recipe={hostedAgentGroupsClasses.section}>
						{index === 0 || index === hosted.length ? (
							item.source === "on-clawdi" ? (
								<SectionLabel
									count={hostedAgentCountLabel(hosted.length)}
									leading={
										<StatusBadge
											className={webBoth(
												`${agentSourceBadgeClasses.root} ${agentSourceBadgeClasses.compact} ${agentSourceBadgeClasses.hosted}`,
											)}
										>
											<Icon
												as={Cloud}
												fill="currentColor"
												className={webBoth(agentSourceBadgeClasses.icon)}
											/>
											<Text>{agentSourceKindLabel("hosted")}</Text>
										</StatusBadge>
									}
								>
									{hostedAgentGroupsCopy.cloud}
								</SectionLabel>
							) : (
								<SectionLabel>{hostedAgentGroupsCopy.other}</SectionLabel>
							)
						) : null}
						<AgentTileView tile={item} />
					</WebView>
				)}
				footer={
					grouped && (selfManagedError || hostedStatus?.error) ? (
						<WebView recipe={hostedAgentGroupsClasses.root}>
							{selfManagedError ? (
								<WebView recipe={hostedAgentGroupsClasses.section}>
									<SectionLabel>{hostedAgentGroupsCopy.other}</SectionLabel>
									<ApiErrorPanel
										error={selfManagedError}
										onRetry={() => void agents.refetch()}
										title={hostedAgentGroupsCopy.otherError}
									/>
								</WebView>
							) : null}
							{hostedStatus?.error ? (
								<ApiErrorPanel
									error={hostedStatus.error}
									onRetry={hostedStatus.onRetry}
									title={OVERVIEW_COPY.cloudInventoryError}
								/>
							) : null}
						</WebView>
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}
