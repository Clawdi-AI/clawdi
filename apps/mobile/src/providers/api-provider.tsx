import {
	type AccountApiClient,
	type AgentProjectClient,
	type AgentSettingsClient,
	type AiProviderClient,
	ApiClientError,
	type ApiClientFetch,
	type ChannelClient,
	type CloudApiClient,
	type ConnectorClient,
	createAccountApiClient,
	createAgentProjectClient,
	createAgentSettingsClient,
	createAiProviderClient,
	createChannelClient,
	createCloudApiClient,
	createConnectorClient,
	createDeploymentMutationClient,
	createHostedApiClient,
	createHostedComputeClient,
	createProjectSharingClient,
	createProviderRemovalClient,
	createSessionSharingClient,
	createSkillClient,
	createVaultClient,
	createVaultSupplyClient,
	createWhatsAppClient,
	createWorkspaceSkillClient,
	type DeploymentMutationClient,
	type HostedApiClient,
	type HostedComputeClient,
	type ProjectSharingClient,
	type ProviderRemovalClient,
	type SessionSharingClient,
	type SkillClient,
	type VaultClient,
	type WhatsAppClient,
	type WorkspaceSkillClient,
} from "@clawdi/shared/api";
import { useAuth } from "@clerk/expo";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type { MobileRuntimeConfig } from "../config/runtime";
import { useAccountScope } from "../platform/account-lifecycle";

export type MobileApiClients = Readonly<{
	cloud: CloudApiClient;
	agentSettings: AgentSettingsClient;
	channels: ChannelClient;
	deploymentMutations: DeploymentMutationClient | null;
	workspaceSkills: WorkspaceSkillClient | null;
	whatsapp: WhatsAppClient;
	account: AccountApiClient;
	aiProviders: AiProviderClient;
	sharing: ProjectSharingClient;
	agentProjects: AgentProjectClient;
	skills: SkillClient;
	sessionSharing: SessionSharingClient;
	connectors: ConnectorClient;
	vault: VaultClient;
	vaultSupply: ReturnType<typeof createVaultSupplyClient>;
	compute: HostedComputeClient | null;
	providerRemoval: ProviderRemovalClient | null;
	hosted: HostedApiClient | null;
}>;

const MobileApiContext = createContext<MobileApiClients | null>(null);

export function MobileApiProvider({
	children,
	config,
}: {
	children: ReactNode;
	config: MobileRuntimeConfig;
}) {
	const scope = useAccountScope();
	const { getToken, sessionId } = useAuth();
	const readToken = useCallback(async (): Promise<string | null> => {
		const scopeSignal = scope.signal;
		if (
			!scope.isReady ||
			!scope.isCurrent() ||
			scopeSignal.aborted ||
			sessionId !== scope.sessionId
		) {
			throw new ApiClientError(401, "authentication_required");
		}
		const token = await getToken();
		if (!scope.isCurrent() || scopeSignal.aborted || sessionId !== scope.sessionId) {
			throw new ApiClientError(401, "authentication_required");
		}
		return token ?? null;
	}, [getToken, scope, sessionId]);
	const fetcher = useCallback<ApiClientFetch>(
		(request, init) => globalThis.fetch(request, init),
		[],
	);
	const clients = useMemo<MobileApiClients>(
		() => ({
			workspaceSkills: config.computeApiUrl
				? createWorkspaceSkillClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
			agentSettings: createAgentSettingsClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			deploymentMutations: config.computeApiUrl
				? createDeploymentMutationClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
			whatsapp: createWhatsAppClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			channels: createChannelClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			providerRemoval: config.computeApiUrl
				? createProviderRemovalClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
			aiProviders: createAiProviderClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			vaultSupply: createVaultSupplyClient({ baseUrl: config.cloudApiUrl, fetch: fetcher }),
			vault: createVaultClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			connectors: createConnectorClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			sessionSharing: createSessionSharingClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			skills: createSkillClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			cloud: createCloudApiClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			account: createAccountApiClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			compute: config.computeApiUrl
				? createHostedComputeClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
			sharing: createProjectSharingClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			agentProjects: createAgentProjectClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			hosted: config.computeApiUrl
				? createHostedApiClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
		}),
		[config.cloudApiUrl, config.computeApiUrl, fetcher, readToken],
	);
	return <MobileApiContext.Provider value={clients}>{children}</MobileApiContext.Provider>;
}

export function useMobileApi(): MobileApiClients {
	const clients = useContext(MobileApiContext);
	if (!clients) throw new Error("useMobileApi must be used inside MobileApiProvider");
	return clients;
}
