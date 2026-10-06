import { projectUserSelectableAiProviders } from "@clawdi/shared";
import type { SavedAiProvider } from "@clawdi/shared/api";
import {
	aiProvidersUiClasses,
	ENTITY_CARD_BASE,
	aiProvidersPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	MANAGED_PROVIDER_LABEL,
	providerAuthLabel,
	providerPresentation,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { BrainCircuit, CheckCircle2, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentCollection } from "@/components/dashboard/collection";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { EmptyState } from "@/components/empty-state";
import { EntityCardSkeleton, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import { DeploymentControls } from "@/hosted/agents/deployment-controls";
import { ProviderEdit } from "@/hosted/v2/ai-providers/edit-provider-dialog";
import { ProviderOAuth } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import { ProviderRemove } from "@/hosted/v2/ai-providers/remove-provider-dialog";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export function AiProvidersScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string | string[]; agentId?: string | string[] }>(),
		agentId = routeParam(params.id ?? params.agentId);
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
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ aiProviders } = useMobileApi();
	const router = useRouter();
	const providers = useQuery({
		queryKey: accountQueryKey(scope, "ai-providers"),
		queryFn: ({ signal }) => read((lease) => aiProviders.list(lease), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const list = projectUserSelectableAiProviders(providers.data?.providers ?? []);
	return (
		<SafeAreaScreen>
			<NativeHeader
				title={agentSurfaceCopy.aIProviders}
				actions={[
					{
						id: "add",
						label: "Add provider",
						disabled: !providers.data || !scope.isReady,
						onPress: () => router.push("/ai-providers/new"),
					},
				]}
			/>
			<NativeList
				data={list}
				keyExtractor={(provider) => provider.id}
				refreshing={providers.isRefetching}
				onRefresh={() => void providers.refetch()}
				header={
					<WebView recipe={styles.section}>
						<PageHeader
							title={agentSurfaceCopy.aIProviders}
							description={agentSurfaceCopy.chooseHowYourAgentsReachAModel}
						/>

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
						<SectionLabel
							count={!providers.isPending && !providers.isError ? list.length : undefined}
						>
							{agentSurfaceCopy.yourProviders}
						</SectionLabel>
					</WebView>
				}
				empty={
					providers.isError ? (
						<ApiErrorPanel
							error={providers.error}
							title={agentSurfaceCopy.couldnTLoadProviders}
							onRetry={() => void providers.refetch()}
						/>
					) : providers.isPending ? (
						<EntityCardSkeleton metaLines={2} actions />
					) : (
						<EmptyState
							title={agentSurfaceCopy.noProvidersAdded}
							description={agentSurfaceCopy.connectAProviderToUseYourOwn}
						/>
					)
				}
				footer={
					providers.isError && providers.data ? (
						<ApiErrorPanel error={providers.error} onRetry={() => void providers.refetch()} />
					) : null
				}
				renderItem={({ item: provider }) => <ProviderCard provider={provider} />}
			/>
		</SafeAreaScreen>
	);
}

function ProviderCard({ provider }: { provider: SavedAiProvider }) {
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
				<ProviderEdit provider={provider} />
				<ProviderRemove providerId={provider.provider_id} />
				{provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile" ? (
					<ProviderOAuth provider={provider} />
				) : null}
				<Button
					variant="ghost"
					size="icon-sm"
					accessibilityLabel={t("providers.validate")}
					disabled={action.busy || !scope.isReady}
					onPress={() =>
						action.run(async (current) => {
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
