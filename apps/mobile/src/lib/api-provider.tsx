import {
	type AccountApiClient,
	type AgentExtensionsClient,
	type AgentProfilesClient,
	type AgentProjectClient,
	type AgentSettingsClient,
	type AiProviderClient,
	ApiClientError,
	type ApiClientFetch,
	type ChannelClient,
	type CloudApiClient,
	type ConnectorClient,
	createAccountApiClient,
	createAgentExtensionsClient,
	createAgentProfilesClient,
	createAgentProjectClient,
	createAgentSettingsClient,
	createAiProviderClient,
	createChannelClient,
	createCloudApiClient,
	createConnectorClient,
	createDeploymentMutationClient,
	createHostedApiClient,
	createHostedComputeClient,
	createHostedStoreClient,
	createProjectSharingClient,
	createProviderRemovalClient,
	createPublicSessionClient,
	createSessionSharingClient,
	createSkillClient,
	createTerminalClient,
	createVaultClient,
	createVaultSupplyClient,
	createWhatsAppClient,
	createWorkspaceSkillClient,
	type DeploymentMutationClient,
	type HostedApiClient,
	type HostedComputeClient,
	type HostedStoreClient,
	type ProjectSharingClient,
	type ProviderRemovalClient,
	type PublicSessionClient,
	type SessionSharingClient,
	type SkillClient,
	type TerminalClient,
	type VaultClient,
	type WhatsAppClient,
	type WorkspaceSkillClient,
} from "@clawdi/shared/api";
import {
	type AccountSuspensionStore,
	createAccountSuspensionStore,
	observeAccountSuspension,
} from "@clawdi/shared/view";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";
import type { MobileRuntimeConfig } from "@/lib/config/runtime";
import { useAccountScope } from "@/platform/account-lifecycle";
import type { AccountScope } from "@/platform/auth/account-scope";
import { useAppAuth } from "@/platform/auth/auth-client";

type MobileApiClients = Readonly<{
	cloud: CloudApiClient;
	publicSessions: PublicSessionClient;
	agentExtensions: AgentExtensionsClient;
	agentSettings: AgentSettingsClient;
	channels: ChannelClient;
	deploymentMutations: DeploymentMutationClient | null;
	terminal: TerminalClient | null;
	workspaceSkills: WorkspaceSkillClient | null;
	whatsapp: WhatsAppClient;
	account: AccountApiClient;
	aiProviders: AiProviderClient;
	sharing: ProjectSharingClient;
	agentProjects: AgentProjectClient;
	agentProfiles: AgentProfilesClient;
	skills: SkillClient;
	sessionSharing: SessionSharingClient;
	connectors: ConnectorClient;
	vault: VaultClient;
	vaultSupply: ReturnType<typeof createVaultSupplyClient>;
	compute: HostedComputeClient | null;
	providerRemoval: ProviderRemovalClient | null;
	hosted: HostedApiClient | null;
	store: HostedStoreClient | null;
}>;

const MobileApiContext = createContext<MobileApiClients | null>(null);
const AccountSuspensionContext = createContext<AccountSuspensionStore | null>(null);
const suspensionStores = new WeakMap<AccountScope, AccountSuspensionStore>();

/** One store per account scope, as on Web: a late response never suspends the next account. */
function accountSuspension(scope: AccountScope): AccountSuspensionStore {
	let store = suspensionStores.get(scope);
	if (!store) {
		store = createAccountSuspensionStore();
		suspensionStores.set(scope, store);
	}
	return store;
}

export function MobileApiProvider({
	children,
	config,
}: {
	children: ReactNode;
	config: MobileRuntimeConfig;
}) {
	const scope = useAccountScope();
	const { getToken, sessionId } = useAppAuth();
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
	const suspension = accountSuspension(scope);
	const fetcher = useMemo<ApiClientFetch>(
		() => observeAccountSuspension(suspension, (request, init) => globalThis.fetch(request, init)),
		[suspension],
	);
	const clients = useMemo<MobileApiClients>(
		() => ({
			publicSessions: createPublicSessionClient({
				baseUrl: config.cloudApiUrl,
				fetch: fetcher,
				getToken: scope.isReady ? readToken : undefined,
			}),
			agentExtensions: createAgentExtensionsClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
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
			terminal: config.computeApiUrl
				? createTerminalClient({
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
			store: config.computeApiUrl
				? createHostedStoreClient({
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
			agentProfiles: createAgentProfilesClient({
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
	return (
		<AccountSuspensionContext.Provider value={suspension}>
			<MobileApiContext.Provider value={clients}>{children}</MobileApiContext.Provider>
		</AccountSuspensionContext.Provider>
	);
}

/** True once any account read in the current scope returned hosted's `account_suspended` problem. */
export function useAccountSuspended(): boolean {
	const store = useContext(AccountSuspensionContext);
	if (!store) throw new Error("useAccountSuspended must be used inside MobileApiProvider");
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useMobileApi(): MobileApiClients {
	const clients = useContext(MobileApiContext);
	if (!clients) throw new Error("useMobileApi must be used inside MobileApiProvider");
	return clients;
}
