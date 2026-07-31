import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_DEPLOYMENT_PROVIDER_PREFIX,
	CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID,
	CLAWDI_MANAGED_V2_LEGACY_PUBLIC_PROVIDER_ID,
} from "@clawdi/shared";
import type {
	HostedDeployCheckoutRequest,
	HostedDeployDeployment,
	HostedDeployOperation,
	HostedDeployPlan,
	HostedDeployRequest,
	HostedDeployRequestStatus,
	HostedDeploySubscriptionQuote,
	HostedDeploySubscriptionQuoteRequest,
	HostedSavedAiProvider,
} from "@clawdi/shared/api";
import {
	DEFAULT_DEPLOY_POLL_LIMIT,
	DeployInputError,
	type DeployPromptAdapter,
	deployCommand,
	type HostedDeployGateway,
	hostedCheckoutUrl,
	parseDeployCommandOptions,
	runDeployFlow,
	safeDeployError,
} from "../../src/commands/deploy";
import {
	HostedDeployApiError,
	type HostedDeployCheckoutOperationResult,
} from "../../src/lib/hosted-deploy-client";

function plan(slug: "compute_basic" | "compute_performance", priceCents: number): HostedDeployPlan {
	return {
		slug,
		name: slug === "compute_basic" ? "Basic" : "Performance",
		price_cents: priceCents,
		signup_grant_usd: "0",
		vcpu: slug === "compute_basic" ? 2 : 4,
		ram_gb: slug === "compute_basic" ? 4 : 8,
		disk_size: 20,
		offers: [
			{
				billing_term_months: 1,
				price_cents: priceCents,
				effective_monthly_price_cents: priceCents,
				discount_percent: 0,
			},
			{
				billing_term_months: 12,
				price_cents: priceCents * 10,
				effective_monthly_price_cents: Math.round((priceCents * 10) / 12),
				discount_percent: 16,
			},
		],
	};
}

function operation(done: boolean): HostedDeployOperation {
	return {
		name: "operations/deploy-test",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb: "create",
			targetGeneration: 1,
			manifestETag: "manifest-1",
			createTime: "2026-07-28T00:00:00Z",
			updateTime: "2026-07-28T00:00:01Z",
		},
		done,
	};
}

function savedProvider(
	providerId: string,
	options: {
		auth?: HostedSavedAiProvider["auth"];
		managedBy?: HostedSavedAiProvider["managed_by"];
		models?: HostedSavedAiProvider["models"];
		usable?: boolean;
	} = {},
): HostedSavedAiProvider {
	return {
		id: `provider-row-${providerId}`,
		provider_id: providerId,
		type: "openai",
		label: `Provider ${providerId}`,
		base_url: "https://provider.example.test/v1",
		api_mode: "openai_responses",
		managed_by: options.managedBy ?? "user",
		scope: "account_global",
		auth: options.auth ?? {
			type: "api_key",
			source: "vault",
			ref: `clawdi://default/${providerId}`,
		},
		usable: options.usable ?? true,
		models: options.models ?? [{ id: "gpt-saved" }],
		created_at: "2026-07-28T00:00:00Z",
		updated_at: "2026-07-28T00:00:00Z",
	};
}

class FakeDeployGateway implements HostedDeployGateway {
	plans: HostedDeployPlan[] = [plan("compute_basic", 900), plan("compute_performance", 2_900)];
	deployments: HostedDeployDeployment[] = [];
	savedProviders: HostedSavedAiProvider[] = [];
	paidCheckoutSupported = true;
	created: { body: HostedDeployRequest; idempotencyKey: string } | null = null;
	quoted: HostedDeploySubscriptionQuoteRequest | null = null;
	checkoutCalls: { body: HostedDeployCheckoutRequest; idempotencyKey: string }[] = [];
	planReads = 0;
	deploymentReads = 0;
	managedModelReads = 0;
	savedProviderReads = 0;
	calls: string[] = [];
	checkoutFactory: (
		body: HostedDeployCheckoutRequest,
		idempotencyKey: string,
	) => HostedDeployCheckoutOperationResult = (body, idempotencyKey) =>
		body.funding_source === "stripe"
			? {
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: "https://checkout.stripe.test/session/stable",
					checkout_url: "https://checkout.stripe.test/session/stable",
					client_secret: null,
				}
			: {
					flow_type: "subscription_activation",
					funding_source: "wallet",
					checkout_url: "",
					subscription_id: "csub_paid",
					invoice_id: null,
					deployment_id: "hdep_paid",
					deployment_name: null,
					metadata_generation: null,
					deploy_request_id: idempotencyKey,
					debited_usd: "290.000000",
					balance_after_usd: "10.000000",
					current_period_start: null,
					current_period_end: null,
					entitled_until: null,
				};
	operationPolls = 0;
	requestPolls = 0;
	requestStatusFactory: ((requestId: string) => HostedDeployRequestStatus) | null = null;
	quoteFactory: (body: HostedDeploySubscriptionQuoteRequest) => HostedDeploySubscriptionQuote = (
		body,
	) => ({
		...body,
		currency: "usd",
		term_price_cents: 29_000,
		expires_at: "2026-07-28T00:10:00Z",
		debit_amount_usd: "290.000000",
		balance_before_usd: "300.000000",
		balance_after_usd: "10.000000",
	});

	supportsPaidCheckout() {
		return this.paidCheckoutSupported;
	}

	async getPlans() {
		this.calls.push("plans");
		this.planReads += 1;
		return this.plans;
	}

	async listDeployments() {
		this.calls.push("deployments");
		this.deploymentReads += 1;
		return this.deployments;
	}

	async getManagedModels() {
		this.calls.push("managed-models");
		this.managedModelReads += 1;
		return [{ id: "gpt-test", display_name: "GPT Test", is_default: true }];
	}

	async getSavedAiProviders() {
		this.calls.push("saved-providers");
		this.savedProviderReads += 1;
		return this.savedProviders;
	}

	async quoteSubscription(body: HostedDeploySubscriptionQuoteRequest) {
		this.calls.push("quote");
		this.quoted = body;
		return this.quoteFactory(body);
	}

	async createDeployment(body: HostedDeployRequest, idempotencyKey: string) {
		this.calls.push("create");
		this.created = { body, idempotencyKey };
		return operation(false);
	}

	async checkout(body: HostedDeployCheckoutRequest, idempotencyKey: string) {
		this.calls.push("checkout");
		this.checkoutCalls.push({ body, idempotencyKey });
		return this.checkoutFactory(body, idempotencyKey);
	}

	async getOperation() {
		this.operationPolls += 1;
		return operation(true);
	}

	async getDeploymentRequest(requestId: string) {
		this.calls.push("request");
		this.requestPolls += 1;
		if (this.requestStatusFactory) return this.requestStatusFactory(requestId);
		if (!this.created && this.checkoutCalls.length === 0) {
			throw new HostedDeployApiError(404, "not found");
		}
		return {
			deploy_request_id: requestId,
			request_status: "succeeded",
			lineage_tail: {
				deployment_id: this.created ? "hdep_test" : "hdep_paid",
				lineage_version: 1,
				lineage_state: "succeeded",
				operation: operation(true),
			},
		};
	}
}

const noUnexpectedPrompts: DeployPromptAdapter = {
	intro() {},
	async select() {
		throw new Error("Unexpected select prompt");
	},
	async text() {
		throw new Error("Unexpected text prompt");
	},
	async confirm() {
		throw new Error("Unexpected confirmation prompt");
	},
	note() {},
	outro() {},
};

describe("deploy option parsing", () => {
	test("help documents exact saved-provider ids and caller UUIDs for paid examples", async () => {
		const processResult = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../../src/index.ts"), "deploy", "--help"],
			{
				env: {
					...process.env,
					CLAWDI_NO_AUTO_UPDATE: "1",
					CLAWDI_NO_UPDATE_CHECK: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			processResult.exited,
			new Response(processResult.stdout).text(),
			new Response(processResult.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const normalizedHelp = stdout.replace(/\s+/g, " ");
		expect(normalizedHelp).toContain("managed, unmanaged, or an exact saved provider id");
		expect(normalizedHelp).toContain("--request-id <uuid>");
		expect(normalizedHelp).toContain("--compute basic --request-id <uuid> --yes --json");
		expect(normalizedHelp).toContain("--payment wallet --request-id <uuid> --yes --json");
		expect(normalizedHelp).toContain("--payment card --request-id <uuid> --yes --json");
	});

	test("normalizes clean automation aliases", () => {
		expect(
			parseDeployCommandOptions({
				runtime: "OpenClaw",
				provider: "managed",
				compute: "performance",
				term: "12",
				payment: "stripe",
				language: "default",
				yes: true,
				json: true,
			}),
		).toMatchObject({
			runtime: "openclaw",
			aiMode: "managed",
			computePlanSlug: "compute_performance",
			billingTermMonths: 12,
			payment: "card",
			language: "",
			yes: true,
			json: true,
		});
	});

	test("rejects model flags for unmanaged AI and malformed request ids", () => {
		expect(() =>
			parseDeployCommandOptions({ provider: "unmanaged", model: "secret-model" }),
		).toThrow("--model cannot be used");
		expect(() => parseDeployCommandOptions({ requestId: "retry-me" })).toThrow(
			"--request-id must be a UUID",
		);
	});

	test("preserves exact saved provider ids without label-style normalization", () => {
		expect(parseDeployCommandOptions({ provider: "OpenAI-Team" })).toMatchObject({
			aiMode: "saved",
			providerId: "OpenAI-Team",
		});
		expect(parseDeployCommandOptions({ provider: "MANAGED" }).aiMode).toBe("managed");
	});

	test("validates IANA timezone syntax before orchestration", () => {
		expect(parseDeployCommandOptions({ timezone: "America/Los_Angeles" }).timezone).toBe(
			"America/Los_Angeles",
		);
		expect(parseDeployCommandOptions({ timezone: "" }).timezone).toBe("");
		for (const timezone of [" Factory", "Factory", "localtime", "Mars/Olympus"]) {
			expect(() => parseDeployCommandOptions({ timezone })).toThrow("valid IANA timezone");
		}
	});
});

describe("deploy orchestration", () => {
	test("uses one JSON stdout object for non-TTY success, failure, and parse errors", async () => {
		const cases: Array<{
			options: Parameters<typeof deployCommand>[0];
			client: FakeDeployGateway;
			status: string;
			code?: string;
		}> = [
			{
				options: {
					provider: "managed",
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174000",
					yes: true,
				},
				client: new FakeDeployGateway(),
				status: "succeeded",
			},
			{
				options: { provider: "managed", compute: "basic", yes: true },
				client: new FakeDeployGateway(),
				status: "error",
				code: "request_id_required",
			},
			{
				options: { runtime: "invalid" },
				client: new FakeDeployGateway(),
				status: "error",
				code: "invalid_runtime",
			},
		];

		for (const testCase of cases) {
			const stdout: string[] = [];
			const stderr: string[] = [];
			process.exitCode = 0;
			await deployCommand(testCase.options, {
				client: testCase.client,
				interactive: false,
				writeStdout: (value) => stdout.push(value),
				writeStderr: (value) => stderr.push(value),
			});
			expect(stdout).toHaveLength(1);
			const result: unknown = JSON.parse(stdout[0] ?? "");
			expect(result).toMatchObject({
				schema_version: "clawdi.deploy.v1",
				status: testCase.status,
				...(testCase.code ? { error: { code: testCase.code } } : {}),
			});
			expect(stderr.join("\n")).not.toContain("schema_version");
		}
		process.exitCode = 0;
	});

	test("creates free Basic directly and reports accepted/progress/result", async () => {
		const client = new FakeDeployGateway();
		const events: string[] = [];
		const requestId = "123e4567-e89b-42d3-a456-426614174000";
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				provider: "managed",
				compute: "basic",
				requestId,
				yes: true,
			}),
			{
				client,
				interactive: false,
				sleep: async () => undefined,
				onEvent: (event) => events.push(event.stage),
			},
		);

		expect(result).toMatchObject({
			status: "succeeded",
			request_id: requestId,
			deployment_id: "hdep_test",
			payment: { kind: "included_basic" },
		});
		expect(client.created).toMatchObject({
			idempotencyKey: requestId,
			body: {
				runtime: "hermes",
				compute_plan_slug: "compute_basic",
				ai_provider_auth_kind: "managed",
				primary_model: { provider_id: "clawdi", model: "gpt-test" },
			},
		});
		expect(client.checkoutCalls).toHaveLength(0);
		expect(events).toContain("accepted");
		expect(events).toContain("progress");
		expect(events).toContain("succeeded");
		expect(client.managedModelReads).toBe(1);
		expect(client.savedProviderReads).toBe(0);
	});

	test("loads provider catalogs only when the selected flow needs them", async () => {
		const unmanagedClient = new FakeDeployGateway();
		await runDeployFlow(
			parseDeployCommandOptions({
				provider: "unmanaged",
				compute: "basic",
				requestId: "123e4567-e89b-42d3-a456-426614174081",
				yes: true,
			}),
			{ client: unmanagedClient, interactive: false, sleep: async () => undefined },
		);
		expect(unmanagedClient.managedModelReads).toBe(0);
		expect(unmanagedClient.savedProviderReads).toBe(0);

		const managedClient = new FakeDeployGateway();
		await runDeployFlow(
			parseDeployCommandOptions({
				provider: "managed",
				compute: "basic",
				requestId: "123e4567-e89b-42d3-a456-426614174082",
				yes: true,
			}),
			{ client: managedClient, interactive: false, sleep: async () => undefined },
		);
		expect(managedClient.managedModelReads).toBe(1);
		expect(managedClient.savedProviderReads).toBe(0);
	});

	test("interactive provider metadata failure degrades to managed and unmanaged choices", async () => {
		const client = new FakeDeployGateway();
		client.getSavedAiProviders = async () => {
			client.savedProviderReads += 1;
			throw new Error("secret upstream detail");
		};
		const notes: { message: string; title?: string }[] = [];
		const prompts: DeployPromptAdapter = {
			...noUnexpectedPrompts,
			async select(message) {
				if (message === "AI provider") return "unmanaged";
				throw new Error(`Unexpected select prompt: ${message}`);
			},
			note(message, title) {
				notes.push({ message, title });
			},
		};

		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				compute: "basic",
				name: "Hermes",
				language: "default",
				timezone: "Etc/UTC",
				yes: true,
				wait: false,
			}),
			{ client, interactive: true, prompts },
		);

		expect(result.ai_provider).toBe("unmanaged");
		expect(client.created).not.toBeNull();
		expect(notes).toContainEqual({
			title: "Saved providers unavailable",
			message:
				"Saved AI providers could not be loaded. Continue with Clawdi AI or Configure inside agent.",
		});
		expect(JSON.stringify(notes)).not.toContain("secret upstream detail");
	});

	test("interactive provider choices use the shared user-selectable projection", async () => {
		const client = new FakeDeployGateway();
		client.savedProviders = [
			savedProvider(CLAWDI_MANAGED_V1_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_V2_LEGACY_PUBLIC_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID),
			savedProvider(`${CLAWDI_MANAGED_V2_DEPLOYMENT_PROVIDER_PREFIX}42`),
			savedProvider("custom-managed-id", { managedBy: "clawdi" }),
			savedProvider("openai-team"),
		];
		let providerChoices: readonly string[] = [];
		const prompts: DeployPromptAdapter = {
			...noUnexpectedPrompts,
			async select(message, options) {
				if (message === "AI provider") {
					providerChoices = options.map((option) => option.value);
					return "openai-team";
				}
				if (message === "Primary model") return "gpt-saved";
				throw new Error(`Unexpected select prompt: ${message}`);
			},
		};

		await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				compute: "basic",
				name: "Hermes",
				language: "default",
				timezone: "Etc/UTC",
				yes: true,
				wait: false,
			}),
			{ client, interactive: true, prompts },
		);

		expect(providerChoices).toEqual(["managed", "openai-team", "unmanaged"]);
		expect(client.created?.body.ai_provider_id).toBe("openai-team");
	});

	test("exact saved provider selection fails closed when metadata cannot load", async () => {
		const client = new FakeDeployGateway();
		client.getSavedAiProviders = async () => {
			client.savedProviderReads += 1;
			throw new Error("secret upstream detail");
		};

		await expect(
			runDeployFlow(
				parseDeployCommandOptions({
					provider: "saved-exact",
					model: "gpt-saved",
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174083",
					yes: true,
				}),
				{ client, interactive: false },
			),
		).rejects.toThrow("Saved AI provider metadata could not be loaded");
		expect(client.created).toBeNull();
		expect(client.savedProviderReads).toBe(1);
	});

	test("exact provider ids cannot bypass the user-selectable projection", async () => {
		const managedProviders = [
			savedProvider(CLAWDI_MANAGED_V1_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_V2_LEGACY_PUBLIC_PROVIDER_ID),
			savedProvider(CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID),
			savedProvider(`${CLAWDI_MANAGED_V2_DEPLOYMENT_PROVIDER_PREFIX}42`),
			savedProvider("custom-managed-id", { managedBy: "clawdi" }),
		];

		for (const provider of managedProviders) {
			const client = new FakeDeployGateway();
			client.savedProviders = [provider];
			await expect(
				runDeployFlow(
					parseDeployCommandOptions({
						provider: provider.provider_id,
						model: "gpt-saved",
						compute: "basic",
						requestId: "123e4567-e89b-42d3-a456-426614174084",
						yes: true,
					}),
					{ client, interactive: false },
				),
			).rejects.toMatchObject({ code: "provider_missing" });
			expect(client.created).toBeNull();
		}
	});

	test("binds exact saved API-key and Codex OAuth providers without credential material", async () => {
		const apiKeyClient = new FakeDeployGateway();
		apiKeyClient.savedProviders = [savedProvider("openai-team")];
		const apiKeyResult = await runDeployFlow(
			parseDeployCommandOptions({
				provider: "openai-team",
				compute: "basic",
				requestId: "123e4567-e89b-42d3-a456-426614174030",
				yes: true,
			}),
			{ client: apiKeyClient, interactive: false, sleep: async () => undefined },
		);
		expect(apiKeyClient.created?.body).toMatchObject({
			ai_provider_auth_kind: "api_key",
			ai_provider_id: "openai-team",
			provider_ids: ["openai-team"],
			primary_model: { provider_id: "openai-team", model: "gpt-saved" },
			ai_provider_bootstrap: {
				selected_provider_id: "openai-team",
				auth_kind: "api_key",
			},
		});
		expect(apiKeyResult).toMatchObject({
			ai_provider: "openai-team",
			primary_model: "gpt-saved",
		});

		const codexClient = new FakeDeployGateway();
		codexClient.savedProviders = [
			savedProvider("codex-work", {
				auth: { type: "agent_profile", tool: "codex", profile: "default" },
				models: [{ id: "gpt-catalog" }, { id: "gpt-other" }],
			}),
		];
		await runDeployFlow(
			parseDeployCommandOptions({
				provider: "codex-work",
				model: "gpt-custom",
				compute: "basic",
				requestId: "123e4567-e89b-42d3-a456-426614174031",
				yes: true,
			}),
			{ client: codexClient, interactive: false, sleep: async () => undefined },
		);
		expect(codexClient.created?.body).toMatchObject({
			ai_provider_auth_kind: "codex_oauth",
			primary_model: { provider_id: "codex-work", model: "gpt-custom" },
			ai_provider_bootstrap: { auth_kind: "codex_oauth" },
		});
		expect(JSON.stringify(codexClient.created?.body)).not.toContain("access_token");
	});

	test("fails closed for missing, unusable, and ambiguous saved-provider models", async () => {
		const client = new FakeDeployGateway();
		client.savedProviders = [
			savedProvider("needs-key", { usable: false }),
			savedProvider("many-models", {
				models: [{ id: "model-a" }, { id: "model-b" }],
			}),
		];
		const base = {
			compute: "basic",
			requestId: "123e4567-e89b-42d3-a456-426614174032",
			yes: true,
		};
		await expect(
			runDeployFlow(parseDeployCommandOptions({ ...base, provider: "missing" }), {
				client,
				interactive: false,
			}),
		).rejects.toThrow("exact provider id");
		await expect(
			runDeployFlow(parseDeployCommandOptions({ ...base, provider: "needs-key" }), {
				client,
				interactive: false,
			}),
		).rejects.toThrow("clawdi ai-provider test needs-key");
		await expect(
			runDeployFlow(parseDeployCommandOptions({ ...base, provider: "many-models" }), {
				client,
				interactive: false,
			}),
		).rejects.toThrow("--model is required");
		expect(client.created).toBeNull();
	});

	test("quotes Wallet, confirms exact server quote, and reuses one request id", async () => {
		const client = new FakeDeployGateway();
		const requestId = "123e4567-e89b-42d3-a456-426614174001";
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "openclaw",
				provider: "unmanaged",
				compute: "performance",
				term: "12",
				payment: "wallet",
				requestId,
				yes: true,
			}),
			{
				client,
				interactive: false,
				now: () => Date.parse("2026-07-28T00:00:00Z"),
				sleep: async () => undefined,
			},
		);

		expect(client.quoted).toEqual({
			plan_slug: "compute_performance",
			billing_term_months: 12,
			funding_source: "wallet",
		});
		expect(client.checkoutCalls[0]).toMatchObject({
			idempotencyKey: requestId,
			body: {
				funding_source: "wallet",
				ui_mode: "hosted",
				quote: {
					debit_amount_usd: "290.000000",
					balance_after_usd: "10.000000",
				},
				deploy_config: { deploy_request_id: requestId },
			},
		});
		expect(result).toMatchObject({
			status: "succeeded",
			deployment_id: "hdep_paid",
			deploy_request_id: requestId,
			payment: {
				kind: "wallet",
				debit_usd: "290.000000",
				balance_after_usd: "10.000000",
			},
		});
	});

	test("requires a caller request id before any non-interactive mutation", async () => {
		const freeClient = new FakeDeployGateway();
		await expect(
			runDeployFlow(
				parseDeployCommandOptions({ compute: "basic", provider: "managed", yes: true }),
				{ client: freeClient, interactive: false },
			),
		).rejects.toThrow("--request-id is required");
		expect(freeClient.created).toBeNull();
		expect(freeClient.quoted).toBeNull();
		expect(freeClient.checkoutCalls).toHaveLength(0);
		expect(freeClient.planReads).toBe(0);
		expect(freeClient.deploymentReads).toBe(0);
		expect(freeClient.managedModelReads).toBe(0);
		expect(freeClient.savedProviderReads).toBe(0);
		expect(freeClient.requestPolls).toBe(0);

		for (const payment of ["wallet", "card"] as const) {
			const client = new FakeDeployGateway();
			client.quoteFactory = () => {
				throw new Error("ambiguous network quote must not run");
			};
			await expect(
				runDeployFlow(
					parseDeployCommandOptions({
						compute: "performance",
						payment,
						yes: true,
					}),
					{ client, interactive: false },
				),
			).rejects.toThrow("--request-id is required");
			expect(client.quoted).toBeNull();
			expect(client.checkoutCalls).toHaveLength(0);
		}
	});

	test("replays an existing free Basic create before paid availability classification", async () => {
		for (const wait of [false, true]) {
			const client = new FakeDeployGateway();
			client.requestStatusFactory = (requestId) => ({
				deploy_request_id: requestId,
				request_status: wait ? "succeeded" : "processing",
				lineage_tail: {
					deployment_id: "hdep_recovered_free",
					lineage_version: 1,
					lineage_state: wait ? "succeeded" : "processing",
				},
			});
			const result = await runDeployFlow(
				parseDeployCommandOptions({
					compute: "basic",
					provider: "managed",
					requestId: "123e4567-e89b-42d3-a456-426614174099",
					yes: true,
					wait,
				}),
				{ client, interactive: false, sleep: async () => undefined },
			);

			expect(result).toMatchObject({
				status: wait ? "succeeded" : "accepted",
				deployment_id: "hdep_test",
				payment: { kind: "included_basic" },
			});
			expect(client.calls[0]).toBe("request");
			expect(client.planReads).toBe(1);
			expect(client.deploymentReads).toBe(1);
			expect(client.created).toMatchObject({
				idempotencyKey: "123e4567-e89b-42d3-a456-426614174099",
				body: { compute_plan_slug: "compute_basic" },
			});
			expect(client.quoted).toBeNull();
			expect(client.checkoutCalls).toHaveLength(0);
		}
	});

	test("lets server idempotency reject changed intent for an existing Basic request", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "processing",
		});
		client.createDeployment = async () => {
			client.calls.push("create");
			throw new HostedDeployApiError(409, "idempotency fingerprint mismatch");
		};
		let rejected: unknown;
		try {
			await runDeployFlow(
				parseDeployCommandOptions({
					runtime: "openclaw",
					provider: "managed",
					model: "gpt-test",
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174091",
					yes: true,
				}),
				{ client, interactive: false },
			);
		} catch (error) {
			rejected = error;
		}
		expect(safeDeployError(rejected).code).toBe("hosted_conflict");
		expect(client.calls[0]).toBe("request");
		expect(client.calls).toContain("create");
		expect(client.quoted).toBeNull();
		expect(client.checkoutCalls).toHaveLength(0);
	});

	test("never reports an existing paid Basic request as included", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "succeeded",
			lineage_tail: {
				deployment_id: "hdep_paid_basic",
				lineage_version: 1,
				lineage_state: "succeeded",
			},
		});
		client.createDeployment = async () => {
			client.calls.push("create");
			throw new HostedDeployApiError(409, "included_basic_required");
		};
		let rejected: unknown;
		try {
			await runDeployFlow(
				parseDeployCommandOptions({
					provider: "managed",
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174092",
					yes: true,
				}),
				{ client, interactive: false },
			);
		} catch (error) {
			rejected = error;
		}
		expect(safeDeployError(rejected)).toMatchObject({ code: "hosted_conflict" });
		expect(client.quoted).toBeNull();
		expect(client.checkoutCalls).toHaveLength(0);
	});

	test("returns secure hosted card checkout for automation without leaking client secret", async () => {
		const client = new FakeDeployGateway();
		const requestId = "123e4567-e89b-42d3-a456-426614174002";
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				compute: "performance",
				payment: "card",
				requestId,
				yes: true,
				json: true,
			}),
			{ client, interactive: false },
		);

		expect(result).toMatchObject({
			status: "payment_required",
			request_id: requestId,
			deployment_id: null,
			deploy_request_id: requestId,
			payment: {
				kind: "card",
				checkout_url: "https://checkout.stripe.test/session/stable",
			},
		});
		expect(client.quoted).toBeNull();
		expect(client.requestPolls).toBe(0);
		expect(client.checkoutCalls[0]).toMatchObject({
			idempotencyKey: requestId,
			body: {
				funding_source: "stripe",
				ui_mode: "hosted",
				deploy_config: { deploy_request_id: requestId },
			},
		});
		expect(JSON.stringify(result)).not.toContain("client_secret");
	});

	test("rejects browser-only secrets and mismatched checkout intent ids", async () => {
		const options = parseDeployCommandOptions({
			compute: "performance",
			payment: "card",
			requestId: "123e4567-e89b-42d3-a456-426614174020",
			yes: true,
		});
		const secretClient = new FakeDeployGateway();
		secretClient.checkoutFactory = (_body, _idempotencyKey) => ({
			flow_type: "checkout_session",
			funding_source: "stripe",
			action_url: null,
			checkout_url: "https://checkout.stripe.test/session/secret",
			client_secret: "must-not-leak",
		});
		let secretError: unknown;
		try {
			await runDeployFlow(options, { client: secretClient, interactive: false });
		} catch (error) {
			secretError = error;
		}
		expect(safeDeployError(secretError)).toEqual({
			code: "invalid_checkout_response",
			message: "Hosted returned a browser-only checkout secret that the CLI will not handle.",
		});
		expect(JSON.stringify(safeDeployError(secretError))).not.toContain("must-not-leak");

		const mismatchClient = new FakeDeployGateway();
		mismatchClient.checkoutFactory = () => ({
			flow_type: "subscription_activation",
			funding_source: "stripe",
			checkout_url: "",
			subscription_id: "csub_paid",
			invoice_id: null,
			deployment_id: "hdep_paid",
			deployment_name: null,
			metadata_generation: null,
			deploy_request_id: "different-request-id",
			debited_usd: null,
			balance_after_usd: null,
			current_period_start: null,
			current_period_end: null,
			entitled_until: null,
		});
		await expect(
			runDeployFlow(options, { client: mismatchClient, interactive: false }),
		).rejects.toThrow("requested deployment intent");
	});

	test("reuses the request id and logical Stripe intent across recovery runs", async () => {
		const client = new FakeDeployGateway();
		const requestId = "123e4567-e89b-42d3-a456-426614174003";
		let checkoutAttempt = 0;
		client.checkoutFactory = (_body, idempotencyKey) => {
			checkoutAttempt += 1;
			return checkoutAttempt === 1
				? {
						flow_type: "checkout_session",
						funding_source: "stripe",
						checkout_url: "https://checkout.stripe.test/session/stable",
						deploy_request_id: idempotencyKey,
					}
				: {
						flow_type: "subscription_activation",
						funding_source: "stripe",
						checkout_url: "",
						deployment_id: "hdep_recovered",
						deploy_request_id: idempotencyKey,
					};
		};
		const parsed = parseDeployCommandOptions({
			compute: "performance",
			payment: "card",
			requestId,
			yes: true,
		});

		const pending = await runDeployFlow(parsed, { client, interactive: false });
		const recovered = await runDeployFlow(parsed, { client, interactive: false });

		expect(client.checkoutCalls).toHaveLength(2);
		expect(client.checkoutCalls[0]).toEqual(client.checkoutCalls[1]);
		expect(client.checkoutCalls[0]?.body.deploy_config?.deploy_request_id).toBe(requestId);
		expect(pending.status).toBe("payment_required");
		expect(recovered).toMatchObject({
			status: "succeeded",
			deployment_id: "hdep_paid",
			request_id: requestId,
		});
		expect(client.requestPolls).toBe(1);
	});

	test("does not poll a recovered subscription activation with --no-wait", async () => {
		const client = new FakeDeployGateway();
		client.checkoutFactory = (_body, idempotencyKey) => ({
			flow_type: "subscription_activation",
			funding_source: "stripe",
			checkout_url: "",
			deployment_id: "hdep_recovered",
			deploy_request_id: idempotencyKey,
		});
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				compute: "performance",
				payment: "card",
				requestId: "123e4567-e89b-42d3-a456-426614174033",
				yes: true,
				wait: false,
			}),
			{ client, interactive: false },
		);
		expect(client.requestPolls).toBe(0);
		expect(result).toMatchObject({ status: "accepted", deployment_id: "hdep_recovered" });
	});

	test("shows an auto-generated interactive request id in the confirmation summary", async () => {
		const client = new FakeDeployGateway();
		const notes: string[] = [];
		const prompts: DeployPromptAdapter = {
			...noUnexpectedPrompts,
			note(message) {
				notes.push(message);
			},
		};
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				provider: "managed",
				model: "gpt-test",
				compute: "basic",
				name: "Hermes",
				language: "default",
				timezone: "Etc/UTC",
				yes: true,
			}),
			{ client, interactive: true, prompts, sleep: async () => undefined },
		);
		expect(result.request_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(notes).toContainEqual(expect.stringContaining(`Request ID: ${result.request_id}`));
		expect(client.created?.idempotencyKey).toBe(result.request_id);
	});

	test("opens HTTPS card checkout interactively and returns payment_required immediately", async () => {
		const client = new FakeDeployGateway();
		const opened: string[] = [];
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				provider: "managed",
				model: "gpt-test",
				compute: "performance",
				term: "1",
				payment: "card",
				name: "Hermes",
				language: "default",
				timezone: "Etc/UTC",
				requestId: "123e4567-e89b-42d3-a456-426614174004",
				yes: true,
			}),
			{
				client,
				interactive: true,
				prompts: noUnexpectedPrompts,
				openUrl: (url) => opened.push(url),
				sleep: async () => undefined,
			},
		);

		expect(opened).toEqual(["https://checkout.stripe.test/session/stable"]);
		expect(client.requestPolls).toBe(0);
		expect(result).toMatchObject({ status: "payment_required", deployment_id: null });
	});

	test("keeps payment_required when interactive card watch has no acceptance evidence", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "pending",
		});
		const opened: string[] = [];
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				runtime: "hermes",
				provider: "managed",
				model: "gpt-test",
				compute: "performance",
				term: "1",
				payment: "card",
				name: "Hermes",
				language: "default",
				timezone: "Etc/UTC",
				requestId: "123e4567-e89b-42d3-a456-426614174006",
				yes: true,
			}),
			{
				client,
				interactive: true,
				prompts: noUnexpectedPrompts,
				openUrl: (url) => opened.push(url),
				pollLimit: 1,
				sleep: async () => undefined,
			},
		);

		expect(client.requestPolls).toBe(0);
		expect(opened).toHaveLength(1);
		expect(result).toMatchObject({
			status: "payment_required",
			deployment_id: null,
			payment: {
				kind: "card",
				checkout_url: "https://checkout.stripe.test/session/stable",
			},
		});
	});

	test("fetches operation_name lineage when deployment projection is not available", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "processing",
			lineage_tail: {
				lineage_version: 1,
				lineage_state: "processing",
				operation_name: "operations/deploy-test",
			},
		});
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				compute: "performance",
				term: "12",
				payment: "wallet",
				requestId: "123e4567-e89b-42d3-a456-426614174005",
				yes: true,
			}),
			{
				client,
				interactive: false,
				now: () => Date.parse("2026-07-28T00:00:00Z"),
				sleep: async () => undefined,
			},
		);

		expect(client.operationPolls).toBe(1);
		expect(result).toMatchObject({
			status: "succeeded",
			deployment_id: "hdep_paid",
			operation_name: "operations/deploy-test",
		});
	});

	test("returns accepted when a processing request reaches the bounded watch limit", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "processing",
			lineage_tail: {
				deployment_id: "hdep_paid",
				lineage_version: 1,
				lineage_state: "processing",
			},
		});
		const result = await runDeployFlow(
			parseDeployCommandOptions({
				compute: "performance",
				term: "12",
				payment: "wallet",
				requestId: "123e4567-e89b-42d3-a456-426614174007",
				yes: true,
			}),
			{
				client,
				interactive: false,
				now: () => Date.parse("2026-07-28T00:00:00Z"),
				pollLimit: 1,
				sleep: async () => undefined,
			},
		);

		expect(client.requestPolls).toBe(2);
		expect(result).toMatchObject({ status: "accepted", deployment_id: "hdep_paid" });
		expect(DEFAULT_DEPLOY_POLL_LIMIT).toBe(1_200);
	});

	test("uses only projected public terminal failures and hides unknown errors", async () => {
		const client = new FakeDeployGateway();
		client.requestStatusFactory = (requestId) => ({
			deploy_request_id: requestId,
			request_status: "failed",
			lineage_tail: {
				lineage_version: 1,
				lineage_state: "failed",
				termination_reason: { internal_secret: "do-not-print" },
			},
		});
		let terminalError: unknown;
		try {
			await runDeployFlow(
				parseDeployCommandOptions({
					compute: "performance",
					term: "12",
					payment: "wallet",
					requestId: "123e4567-e89b-42d3-a456-426614174008",
					yes: true,
				}),
				{
					client,
					interactive: false,
					now: () => Date.parse("2026-07-28T00:00:00Z"),
				},
			);
		} catch (error) {
			terminalError = error;
		}

		expect(safeDeployError(terminalError)).toEqual({
			code: "deployment_failed",
			message: "Hosted could not complete this deployment.",
		});
		expect(safeDeployError(new Error("database password leaked"))).toEqual({
			code: "deploy_failed",
			message: "Deployment could not be completed. Retry with the same --request-id.",
		});
		expect(safeDeployError(new HostedDeployApiError(400, "database password leaked"))).toEqual({
			code: "hosted_invalid_request",
			message: "Hosted rejected the deployment input. Review the selected options and retry.",
		});
		expect(safeDeployError(new HostedDeployApiError(402, "internal wallet detail"))).toEqual({
			code: "insufficient_wallet_balance",
			message:
				"Wallet funds changed before payment completed. Top up in the dashboard and retry with a fresh quote.",
		});
	});

	test("rejects malformed Wallet amounts and unavailable explicit billing terms", async () => {
		const malformedQuoteClient = new FakeDeployGateway();
		malformedQuoteClient.quoteFactory = (body) => ({
			...body,
			currency: "usd",
			term_price_cents: 2_900,
			expires_at: "2026-07-28T00:10:00Z",
			debit_amount_usd: "not-a-decimal",
			balance_before_usd: "100.00",
			balance_after_usd: "71.00",
		});
		await expect(
			runDeployFlow(
				parseDeployCommandOptions({
					compute: "performance",
					payment: "wallet",
					requestId: "123e4567-e89b-42d3-a456-426614174009",
					yes: true,
				}),
				{
					client: malformedQuoteClient,
					interactive: false,
					now: () => Date.parse("2026-07-28T00:00:00Z"),
				},
			),
		).rejects.toThrow("missing the exact debit");
		expect(malformedQuoteClient.checkoutCalls).toHaveLength(0);

		const unavailableTermClient = new FakeDeployGateway();
		const performance = plan("compute_performance", 2_900);
		performance.offers = performance.offers.slice(0, 1);
		unavailableTermClient.plans = [plan("compute_basic", 900), performance];
		await expect(
			runDeployFlow(
				parseDeployCommandOptions({
					compute: "performance",
					term: "12",
					payment: "card",
					requestId: "123e4567-e89b-42d3-a456-426614174093",
					yes: true,
				}),
				{ client: unavailableTermClient, interactive: false },
			),
		).rejects.toThrow("does not offer a 12-month billing term");
		expect(unavailableTermClient.checkoutCalls).toHaveLength(0);
	});

	test("surfaces only the typed public LRO problem detail", async () => {
		const client = new FakeDeployGateway();
		client.getOperation = async () => ({
			...operation(true),
			error: {
				code: 13,
				message: "internal reconciler secret",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/runtime-start",
						title: "Runtime start failed",
						status: 500,
						detail: "The runtime could not be started safely.",
						code: "runtime_start_failed",
						phase: "reconcile",
						retryable: true,
						conditionReason: "RuntimeUnavailable",
						conditionMessage: "Public projected condition",
						observedGeneration: 1,
					},
				],
			},
		});
		let lroError: unknown;
		try {
			await runDeployFlow(
				parseDeployCommandOptions({
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174094",
					yes: true,
				}),
				{
					client,
					interactive: false,
					sleep: async () => undefined,
				},
			);
		} catch (error) {
			lroError = error;
		}

		expect(safeDeployError(lroError)).toEqual({
			code: "runtime_start_failed",
			message: "The runtime could not be started safely.",
		});
	});

	test("fails closed before paid mutations when the auth audience lacks checkout", async () => {
		const client = new FakeDeployGateway();
		client.paidCheckoutSupported = false;
		await expect(
			runDeployFlow(
				parseDeployCommandOptions({
					compute: "performance",
					payment: "card",
					yes: true,
				}),
				{ client, interactive: false },
			),
		).rejects.toBeInstanceOf(DeployInputError);
		expect(client.quoted).toBeNull();
		expect(client.checkoutCalls).toHaveLength(0);
	});

	test("rejects insecure or secret-bearing checkout URLs", () => {
		const base = {
			flow_type: "checkout_session",
			funding_source: "stripe",
			action_url: null,
			checkout_url: "https://checkout.stripe.test/session/stable",
			client_secret: null,
		} satisfies HostedDeployCheckoutOperationResult;
		expect(() => hostedCheckoutUrl({ ...base, checkout_url: "http://stripe.test/x" })).toThrow(
			"valid secure",
		);
		expect(() =>
			hostedCheckoutUrl({
				...base,
				checkout_url: "https://stripe.test/x?client_secret=hidden",
			}),
		).toThrow("valid secure");
	});

	test("requires explicit non-interactive confirmation", async () => {
		await expect(
			runDeployFlow(
				parseDeployCommandOptions({
					compute: "basic",
					requestId: "123e4567-e89b-42d3-a456-426614174095",
				}),
				{
					client: new FakeDeployGateway(),
					interactive: false,
				},
			),
		).rejects.toThrow("--yes is required");
	});
});
