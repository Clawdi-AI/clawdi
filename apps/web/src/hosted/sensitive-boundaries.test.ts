import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import type { WalletState } from "@/hosted/billing/contracts";
import { walletSnapshotForCache } from "@/hosted/billing/wallet/wallet-cache";
import { whatsappCredentialMetadataForCache } from "@/hosted/v2/channels/whatsapp-credential-cache";
import { cacheValueContains } from "@/lib/sensitive-cache";
import { executeSensitiveAction } from "@/lib/use-sensitive-action";
import { memorySettingsForCache } from "@/pages/dashboard/memories/memory-settings-cache";

function cachedState(queryClient: QueryClient) {
	return {
		queries: queryClient
			.getQueryCache()
			.getAll()
			.map((query) => ({ queryKey: query.queryKey, state: query.state })),
		mutations: queryClient
			.getMutationCache()
			.getAll()
			.map((mutation) => mutation.state),
	};
}

function createUnsanitizedQueryClient(): QueryClient {
	// Deliberately bypass createAppQueryClient and its sensitive-cache guard.
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, structuralSharing: false },
		},
	});
}

function source(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function productionSourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return productionSourceFiles(path);
		if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) {
			return [];
		}
		return [path];
	});
}

describe("structural secret boundaries without the denylist", () => {
	test("fixed query flows stay secret-free in a raw QueryClient", async () => {
		const queryClient = createUnsanitizedQueryClient();
		const secrets = {
			stripe: "pi_raw-query-client-secret",
			walletFuture: "future-wallet-secret-with-an-unregistered-name",
			whatsapp: "whatsapp-auth-material",
			mem0: "mem0-raw-query-api-key",
			settingsFuture: "future-settings-secret-with-an-unregistered-name",
		};
		const wallet: WalletState = {
			balance_usd: "25.00",
			x402_enabled: true,
			auto_reload_enabled: true,
			auto_reload_threshold_usd: "5",
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_structural_test",
				client_secret: secrets.stripe,
				error_code: null,
			},
		};
		const walletWithFutureSecret = {
			...wallet,
			future_material: { value: secrets.walletFuture },
		};
		const whatsappMetadataWithSecrets = [
			{
				credential_id: "credential-id",
				agent_link_id: "link-id",
				agent_id: "agent-id",
				jid: "15555550123@s.whatsapp.net",
				identity_pub_key_hex: "public-key",
				created_at: "2026-07-25T00:00:00Z",
				creds: { material: secrets.whatsapp },
				websocket_url: `wss://example.invalid?material=${secrets.whatsapp}`,
			},
		];

		await Promise.all([
			queryClient.prefetchQuery({
				queryKey: ["billing", "wallet"],
				queryFn: async () => walletSnapshotForCache(walletWithFutureSecret),
			}),
			queryClient.prefetchQuery({
				queryKey: ["whatsapp-tenant-creds", "account-id"],
				queryFn: async () => whatsappCredentialMetadataForCache(whatsappMetadataWithSecrets),
			}),
			queryClient.prefetchQuery({
				queryKey: ["settings"],
				queryFn: async () =>
					memorySettingsForCache({
						memory_provider: "mem0",
						mem0_api_key: secrets.mem0,
						future_material: secrets.settingsFuture,
					}),
			}),
		]);

		expect(queryClient.getQueryData(["billing", "wallet"])).toMatchObject({
			balance_usd: "25.00",
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_structural_test",
			},
		});
		expect(
			queryClient.getQueryData<ReturnType<typeof memorySettingsForCache>>(["settings"]),
		).toEqual({
			memory_provider: "mem0",
			mem0_api_key_configured: true,
		});
		for (const secret of Object.values(secrets)) {
			expect(cacheValueContains(cachedState(queryClient), secret)).toBe(false);
		}
		expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
	});

	test("every fixed sensitive action bypasses MutationCache with secret args and results", async () => {
		const queryClient = createUnsanitizedQueryClient();
		const flows = [
			"channel create",
			"channel link",
			"channel token rotation",
			"channel pair code",
			"agent-detail channel link",
			"provider API key",
			"Codex OAuth start and complete",
			"dashboard bearer key",
			"Stripe top-up",
			"Stripe auto-reload",
			"Stripe subscription checkout",
			"Stripe portal and payment fix",
			"connector credentials and connect URL",
			"WhatsApp credential create",
			"project share token",
			"CLI device code",
			"Vault plaintext import",
			"Mem0 API key",
			"terminal websocket URL",
		] as const;

		for (const [index, flow] of flows.entries()) {
			const argumentSecret = `argument-secret-${index}`;
			const resultSecret = `result-secret-${index}`;
			const result = await executeSensitiveAction(
				async (secret: string) => ({ flow, secret: resultSecret, accepted: secret.length > 0 }),
				argumentSecret,
			);
			expect(result).toEqual({ flow, secret: resultSecret, accepted: true });
			expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
			expect(cacheValueContains(cachedState(queryClient), argumentSecret)).toBe(false);
			expect(cacheValueContains(cachedState(queryClient), resultSecret)).toBe(false);
		}
	});

	test("active call sites are wired to structural actions and safe query projections", () => {
		const actionContracts: Array<[string, string[]]> = [
			[
				"hosted/v2/channels/channels-hooks.ts",
				[
					"export function useCreateChannel()",
					"export function useLinkAgent(accountId: string)",
					"export function useRotateAgentToken(accountId: string)",
					"export function useCreatePairCode(accountId: string)",
					"export function useCreateWhatsappTenantCred(accountId: string)",
					"return useSensitiveAction",
				],
			],
			[
				"hosted/v2/ai-providers/ai-providers-hooks.ts",
				["useSetApiKey", "useOAuthStart", "useOAuthComplete", "return useSensitiveAction"],
			],
			[
				"hosted/billing/sensitive-actions.ts",
				[
					"useSensitiveTopUp",
					"useSensitiveSetAutoReload",
					"useSensitiveCreateSubscription",
					"useSensitiveBillingPortal",
					"useSensitiveFixPayment",
					"useSensitiveWalletSnapshot",
				],
			],
			[
				"hosted/agents/hosted-agent-detail.tsx",
				["const terminal = useSensitiveAction", "const link = useSensitiveAction"],
			],
			["components/connectors/credentials-dialog.tsx", ["const submit = useSensitiveAction"]],
			["components/settings/api-keys-panel.tsx", ["const createKey = useSensitiveAction"]],
			["components/sharing/share-project-dialog.tsx", ["const create = useSensitiveAction"]],
			["components/vault/add-keys-dialog.tsx", ["const save = useSensitiveAction"]],
			["pages/dashboard/connectors/[name]/page.tsx", ["const connectAction = useSensitiveAction"]],
			["pages/dashboard/memories/page.tsx", ["const saveMem0Key = useSensitiveAction"]],
			["pages/share/project-share-page.tsx", ["const upgrade = useSensitiveAction"]],
			[
				"pages/cli-authorize/page.tsx",
				["const approve = useSensitiveAction", "const deny = useSensitiveAction"],
			],
		];
		for (const [path, fragments] of actionContracts) {
			const contents = source(path);
			for (const fragment of fragments) expect(contents).toContain(fragment);
		}
		expect(
			source("hosted/v2/channels/channels-hooks.ts").split("return useSensitiveAction"),
		).toHaveLength(6);
		expect(
			source("hosted/v2/ai-providers/ai-providers-hooks.ts").split("return useSensitiveAction"),
		).toHaveLength(4);
		expect(
			source("hosted/billing/sensitive-actions.ts").split("return useSensitiveAction"),
		).toHaveLength(7);

		const walletConsumers = [
			"hosted/billing/deploy/deploy-wizard.tsx",
			"hosted/billing/wallet/wallet-page.tsx",
			"hosted/billing/subscription/welcome-wallet-card.tsx",
			"hosted/billing/subscription/subscription-create-dialog.tsx",
			"hosted/billing/components/compute-dunning-banner.tsx",
			"hosted/agents/hosted-agent-detail.tsx",
		];
		for (const path of walletConsumers) {
			expect(source(path)).toContain("useWalletSnapshot");
		}
		expect(source("hosted/billing/wallet/wallet-query.ts")).toContain(
			"walletSnapshotForCache(await client.getWallet())",
		);
		expect(source("hosted/v2/channels/channels-hooks.ts")).toContain(
			"whatsappCredentialMetadataForCache(",
		);
		expect(source("pages/dashboard/memories/page.tsx")).toContain(
			"memorySettingsForCache(unwrap(await api.GET",
		);

		const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
		const legacySensitiveHooks = [
			"useWallet",
			"useTopUp",
			"useSetAutoReload",
			"useCreateSubscription",
			"usePortal",
			"useFixPayment",
		];
		const legacyCallers: string[] = [];
		for (const path of productionSourceFiles(sourceRoot)) {
			const contents = readFileSync(path, "utf8");
			for (const hook of legacySensitiveHooks) {
				if (new RegExp(`\\b${hook}\\s*\\(`).test(contents)) {
					legacyCallers.push(`${path}:${hook}`);
				}
			}
		}
		expect(legacyCallers).toEqual([]);
	});
});
