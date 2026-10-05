import { projectUserSelectableAiProviders } from "@clawdi/shared";
import type { AiProviderRemovalResult, SavedAiProvider } from "@clawdi/shared/api";
import {
	agentsIndexClasses,
	aiProvidersUiClasses,
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	aiProvidersPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	MANAGED_PROVIDER_LABEL,
	providerAuthLabel,
	providerPresentation,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { BrainCircuit, CheckCircle2, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AgentCollection } from "../ui/agents/collection";
import { AgentSectionNavigation } from "../ui/agents/navigation";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { EntityCardSkeleton, EntityHeader } from "../ui/entity-card";
import { EntityIcon } from "../ui/entity-icon";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { PageHeader } from "../ui/page-header";
import { AppScrollView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { SectionLabel } from "../ui/section-label";
import { StatusBadge } from "../ui/status-badge";
import { Text } from "../ui/text";
import { WebView, webView } from "../ui/web-layout";
import { DeploymentControls } from "./deployments/controls";
import { ProviderCreate } from "./provider-create";
import { ProviderEdit } from "./provider-edit";
import { ProviderOAuth } from "./provider-oauth";
import { ProviderRemove } from "./provider-remove";
import { routeParam } from "./read-helpers";
export function AiProvidersScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>(),
		agentId = routeParam(params.agentId);
	if (agentId)
		return (
			<AgentProviders
				key={`${scope.accountKey}:${scope.generation}:${agentId}`}
				agentId={agentId}
			/>
		);
	return <ProvidersView key={`${scope.accountKey}:${scope.generation}`} />;
}
function ProvidersView() {
	const cache = useQueryClient(),
		scope = useAccountScope(),
		read = useAccountRead(),
		{ aiProviders } = useMobileApi();
	const [removed, setRemoved] = useState<AiProviderRemovalResult | null>(null);
	const providers = useQuery({
		queryKey: accountQueryKey(scope, "ai-providers"),
		queryFn: ({ signal }) => read((lease) => aiProviders.list(lease), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const list = projectUserSelectableAiProviders(providers.data?.providers ?? []);
	const refresh = async () => {
		await providers.refetch();
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
				<PageHeader
					title={agentSurfaceCopy.aIProviders}
					description={agentSurfaceCopy.chooseHowYourAgentsReachAModel}
					actions={<ProviderCreate providers={providers.data?.providers} refresh={refresh} />}
				/>
				{removed ? (
					<Text accessibilityRole="alert">
						{removed.remote_revoke_status === "pending"
							? "Provider removed. Remote access revocation is pending."
							: "Provider removed."}
					</Text>
				) : null}
				<WebView recipe={styles.section}>
					<SectionLabel>{agentSurfaceCopy.clawdi}</SectionLabel>
					<WebView recipe={ENTITY_CARD_BASE}>
						<EntityHeader
							align="start"
							icon={
								<IconChip tint={aiProvidersUiClasses.managedTint}>
									<Icon as={BrainCircuit} />
								</IconChip>
							}
							title={MANAGED_PROVIDER_LABEL}
							titleAdornment={
								<StatusBadge status="success">
									<Icon as={ShieldCheck} className={webView(aiProvidersUiClasses.shield)} />
									<Text>{agentSurfaceCopy.default}</Text>
								</StatusBadge>
							}
							meta={[agentSurfaceCopy.noSetupRequired, agentSurfaceCopy.walletBilled]}
						/>
					</WebView>
				</WebView>
				<WebView recipe={styles.section}>
					<SectionLabel
						count={!providers.isPending && !providers.isError ? list.length : undefined}
					>
						{agentSurfaceCopy.yourProviders}
					</SectionLabel>
					{providers.isError && !providers.data ? (
						<ApiErrorPanel
							error={providers.error}
							title={agentSurfaceCopy.couldnTLoadProviders}
							onRetry={() => void providers.refetch()}
						/>
					) : providers.isPending ? (
						<WebView recipe={ENTITY_GRID_CLASS}>
							{[0, 1, 2].map((i) => (
								<EntityCardSkeleton key={i} metaLines={2} actions />
							))}
						</WebView>
					) : !list.length ? (
						<EmptyState
							title={agentSurfaceCopy.noProvidersAdded}
							description={agentSurfaceCopy.connectAProviderToUseYourOwn}
						/>
					) : (
						<WebView recipe={ENTITY_GRID_CLASS}>
							{list.map((provider) => (
								<ProviderCard
									key={provider.id}
									provider={provider}
									refresh={refresh}
									onRemoved={async (result) => {
										setRemoved(result);
										await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
									}}
								/>
							))}
						</WebView>
					)}
				</WebView>
			</AppScrollView>
		</ReadScreen>
	);
}
function ProviderCard({
	provider,
	refresh,
	onRemoved,
}: {
	provider: SavedAiProvider;
	refresh: () => Promise<void>;
	onRemoved: (result: AiProviderRemovalResult) => Promise<void>;
}) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		{ aiProviders } = useMobileApi(),
		action = useAuthAction(scope.identity);
	const [valid, setValid] = useState<{ revision: string; value: boolean } | null>(null);
	const presentation = providerPresentation(provider),
		ready = (provider.readiness?.deployable ?? provider.usable) && provider.auth.type !== "none";
	return (
		<WebView recipe={ENTITY_CARD_BASE}>
			<EntityHeader
				align="start"
				icon={
					<EntityIcon kind="provider" id={presentation.iconId} label={presentation.brandLabel} />
				}
				title={presentation.label}
				titleAdornment={
					<WebView recipe={styles.titleBadges} className="flex-row">
						<Badge variant="secondary" className={webView(aiProvidersUiClasses.authBadge)}>
							<Text>{providerAuthLabel(provider.auth.type)}</Text>
						</Badge>
						<StatusBadge status={ready ? "success" : "warning"} withDot>
							<Text>{ready ? "Ready" : "Setup required"}</Text>
						</StatusBadge>
					</WebView>
				}
				meta={[
					presentation.summary,
					provider.auth.type === "none"
						? agentSurfaceCopy.addACredentialBeforeAssigningThisProviderToAn
						: !ready
							? agentSurfaceCopy.finishSetupBeforeAssigningThisProviderToAnAgent
							: null,
				]}
			/>
			<WebView recipe={styles.actions} className="flex-row">
				<ProviderEdit provider={provider} refresh={refresh} />
				<ProviderRemove providerId={provider.provider_id} onRemoved={onRemoved} />
				{provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile" ? (
					<ProviderOAuth provider={provider} refresh={refresh} />
				) : null}
				<Button
					variant="ghost"
					size="icon-sm"
					accessibilityLabel={t("providers.validate")}
					disabled={action.busy || !scope.isReady}
					onPress={() =>
						void action.run(async (current) => {
							setValid(null);
							const result = await read((signal) =>
								aiProviders.validate(provider.provider_id, signal),
							);
							if (current()) setValid({ revision: provider.updated_at, value: result.valid });
						})
					}
				>
					<Icon as={CheckCircle2} />
				</Button>
			</WebView>
			{valid?.revision === provider.updated_at ? (
				<Text accessibilityRole="alert">
					{t(valid.value ? "providers.valid" : "providers.invalid")}
				</Text>
			) : null}
			{action.error ? <ApiErrorPanel error={action.error} title={t("providers.failed")} /> : null}
		</WebView>
	);
}

function AgentProviders({ agentId }: { agentId: string }) {
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ hosted } = useMobileApi(),
		cache = useQueryClient();
	const inventory = useQuery({
		queryKey: accountQueryKey(scope, "deployments"),
		enabled: scope.isReady && Boolean(hosted),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!hosted) throw new Error("Hosted API unavailable");
				return hosted.listDeployments(lease);
			}, signal),
	});
	const deployment = inventory.data?.find((item) => item.agent_id === agentId);
	return (
		<AgentCollection
			title={agentSurfaceCopy.aIProviders}
			description="AI provider and primary model used by this agent."
			navigation={<AgentSectionNavigation agentId={agentId} section="ai" />}
		>
			{inventory.isError ? (
				<ApiErrorPanel
					error={inventory.error}
					title="Couldn't load Agent"
					onRetry={() => void inventory.refetch()}
				/>
			) : inventory.isLoading ? (
				<EntityCardSkeleton />
			) : deployment ? (
				<DeploymentControls
					section="ai"
					deployment={deployment}
					deploymentId={deployment.resource.id}
					blocked={inventory.isError}
					transitioning={Boolean(
						deployment.accepted_operation && !deployment.accepted_operation.done,
					)}
					onAccepted={async () => {
						await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "deployments") });
					}}
					onAbsent={async () => {
						await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
					}}
				/>
			) : (
				<EmptyState description="Configure model access inside the agent." />
			)}
		</AgentCollection>
	);
}
