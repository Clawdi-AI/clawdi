import { describe, expect, test } from "bun:test";
import {
	ApiClientError,
	ApiClientNetworkError,
	createHostedComputeClient,
	type DeployComponents,
	type HostedDeployPlan,
	type HostedDeployWizardDraft,
	type HostedIncludedBasicAvailability,
	recordHostedCheckoutSends,
	type SavedAiProvider,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import { deploySubmissionErrorCopy } from "@clawdi/shared/view";
import {
	type CreationAttempt,
	canDiscardCreationAttempt,
	canonicalWalletQuote,
	canStartStorePurchase,
	creationAttemptControls,
	deploySubmissionFailure,
	isDefinitiveAdmissionRejection,
	offeredQuoteSelections,
	parseCreationAttempt,
	releaseWalletRequest,
	retryStoreAdmission,
	serverAllowsEntitledCreation,
	storeAdmissionMessageKey,
	storeAdmissionRecoveryAttempt,
	storeFundingHoldsAttempt,
	WALLET_RELEASE_GRACE_MS,
	walletCreationErrorCopy,
	walletQuoteConfirmation,
	walletRequestNeedsQuote,
} from "@/hosted/billing/deploy/deploy-request";
import { en } from "@/lib/i18n/en";
import { createAttemptStore } from "@/platform/creation-attempt-store";

describe("durable creation boundary", () => {
	const capabilities: DeployComponents["schemas"]["V1UserProductCapabilities"] = {
		can_use_v1: true,
		can_use_v2: true,
		can_create_v1_deployment: false,
	};
	const included: HostedIncludedBasicAvailability = {
		total_slots: 1,
		used_slots: 0,
		available_slots: 1,
	};
	const basic: HostedDeployPlan = {
		slug: "compute_basic",
		name: "Basic",
		price_cents: 1000,
		vcpu: 1,
		ram_gb: 2,
		disk_size: 20,
		signup_grant_usd: "0",
	};
	test("creation requires actual capability, matching inventory and a supported catalog plan", () => {
		expect(serverAllowsEntitledCreation(capabilities, included, basic)).toBe(true);
		expect(
			serverAllowsEntitledCreation({ ...capabilities, can_use_v2: false }, included, basic),
		).toBe(false);
		expect(serverAllowsEntitledCreation(undefined, included, basic)).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic),
		).toBe(false);
		expect(serverAllowsEntitledCreation(capabilities, included, undefined)).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, included, {
				...basic,
				slug: "compute_performance",
			}),
		).toBe(false);
	});
	test("quote choices follow offered plans and monthly/annual terms", () => {
		const performance: HostedDeployPlan = {
			...basic,
			slug: "compute_performance",
			offers: [
				{
					billing_term_months: 12,
					price_cents: 10000,
					effective_monthly_price_cents: 833,
					discount_percent: 17,
				},
			],
		};
		expect(offeredQuoteSelections([basic, performance])).toEqual([
			{ planSlug: "compute_basic", billingTermMonths: 1, fundingSource: "stripe" },
			{ planSlug: "compute_performance", billingTermMonths: 12, fundingSource: "stripe" },
		]);
	});
	test("same-key recovery does not depend on capacity consumed by the original admission", () => {
		expect(
			serverAllowsEntitledCreation(capabilities, undefined, undefined, { hasSavedAttempt: true }),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation({ ...capabilities, can_use_v2: false }, included, basic, {
				hasSavedAttempt: true,
			}),
		).toBe(false);
		const reusable: DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"] = {
			subscription_id: "csub_K8fJ3pQm",
			plan_slug: "compute_basic",
			billing_term_months: 1,
			funding_source: "stripe",
			status: "active",
			currency: "usd",
			entitled_until: "2026-11-01T00:00:00Z",
			cancel_at_period_end: false,
		};
		const performance = { ...basic, slug: "compute_performance" };
		expect(
			serverAllowsEntitledCreation(capabilities, included, performance, { reusable: [reusable] }),
		).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, included, performance, {
				reusable: [{ ...reusable, plan_slug: "compute_performance" }],
			}),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation(
				capabilities,
				included,
				{ ...performance, slug: "unknown" },
				{ reusable: [reusable] },
			),
		).toBe(false);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic, {
				reusable: [reusable],
			}),
		).toBe(true);
		expect(
			serverAllowsEntitledCreation(capabilities, { ...included, available_slots: 0 }, basic, {
				reusable: [{ ...reusable, plan_slug: "compute_performance" }],
			}),
		).toBe(false);
	});
	test("restore rejects malformed IDs and unsupported runtime", () => {
		const draft: HostedDeployWizardDraft = {
			runtime: "hermes",
			computePlanSlug: "compute_basic",
			agentName: " A ",
			language: "en",
			timezone: "",
			ai: { mode: "unmanaged" },
		};
		const built = validateAndBuildHostedDeployRequest(draft);
		if (!built.ok) throw new Error("Invalid fixture");
		const id = "8e244ab3-1111-4111-8111-111111111111";
		const saved: CreationAttempt = {
			version: 1,
			submission: "prepared",
			id,
			draft,
			request: { ...built.request, deploy_request_id: id },
		};
		expect(parseCreationAttempt(JSON.stringify(saved))).toEqual(saved);
		const funded = { ...saved, storeFunding: "funded" as const };
		expect(parseCreationAttempt(JSON.stringify(funded))).toEqual(funded);
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...funded, request: { ...funded.request, compute_source: "store" } }),
			),
		).toBeNull();
		const performanceDraft: HostedDeployWizardDraft = {
			...draft,
			computePlanSlug: "compute_performance",
		};
		const performanceBuilt = validateAndBuildHostedDeployRequest(performanceDraft);
		if (!performanceBuilt.ok) throw new Error("Invalid Performance fixture");
		const performanceSaved: CreationAttempt = {
			...saved,
			submission: "uncertain",
			draft: performanceDraft,
			request: { ...performanceBuilt.request, deploy_request_id: id },
		};
		expect(parseCreationAttempt(JSON.stringify(performanceSaved))).toEqual(performanceSaved);
		expect(canDiscardCreationAttempt(performanceSaved)).toBe(false);
		expect(
			parseCreationAttempt(JSON.stringify({ ...saved, submission: undefined }))?.submission,
		).toBe("uncertain");
		expect(
			parseCreationAttempt(JSON.stringify({ ...saved, submission: "unrecognized" })),
		).toBeNull();
		expect(canDiscardCreationAttempt(saved)).toBe(true);
		expect(canDiscardCreationAttempt({ ...saved, submission: "entitlement_rejected" })).toBe(true);
		expect(canDiscardCreationAttempt({ ...saved, submission: "uncertain" })).toBe(false);
		const denied = new ApiClientError(409, "compute_entitlement_required");
		expect(isDefinitiveAdmissionRejection(saved, denied)).toBe(true);
		expect(isDefinitiveAdmissionRejection({ ...saved, submission: "uncertain" }, denied)).toBe(
			false,
		);
		for (const error of [
			new ApiClientError(404),
			new ApiClientError(409, "compute_entitlement_pending"),
			new ApiClientError(500),
			new Error("network"),
		])
			expect(isDefinitiveAdmissionRejection(saved, error)).toBe(false);
		expect(parseCreationAttempt(JSON.stringify({ ...saved, id: "weak-id" }))).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, draft: { ...saved.draft, runtime: "other" } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, request: { ...saved.request, name: "different" } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({
					...saved,
					request: { ...saved.request, deploy_request_id: "another-key" },
				}),
			),
		).toBeNull();
		expect(parseCreationAttempt("{broken")).toBeNull();
	});

	test("restores saved-provider and exact-subscription requests only as persisted", () => {
		const provider: SavedAiProvider = {
			id: "row-api",
			provider_id: "openai-main",
			scope: "user",
			type: "openai",
			label: "OpenAI",
			base_url: "https://api.openai.com/v1",
			api_mode: "openai_responses",
			managed_by: "user",
			runtime_env_name: "OPENAI_API_KEY",
			models: [{ id: "gpt-catalog" }],
			auth: { type: "api_key", source: "managed", profile: "work" },
			usable: true,
			readiness: {
				credential_material: "available",
				runtime_compatibility: { openclaw: true, hermes: true, codex: true },
				deployable: true,
				endpoint_reachability: "not_tested",
				inference_verification: "not_tested",
			},
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
		const draft: HostedDeployWizardDraft = {
			runtime: "hermes",
			computePlanSlug: "compute_performance",
			agentName: "Hermes",
			language: "",
			timezone: "America/Los_Angeles",
			ai: { mode: "configured", providerId: "openai-main", model: "gpt-catalog" },
		};
		const built = validateAndBuildHostedDeployRequest(draft, [], [provider]);
		if (!built.ok) throw new Error("Invalid fixture");
		const id = "8e244ab3-2222-4222-8222-222222222222";
		const saved: CreationAttempt = {
			version: 1,
			submission: "uncertain",
			id,
			draft,
			request: { ...built.request, deploy_request_id: id },
			subscription: {
				id: "csub_K8fJ3pQm",
				planSlug: "compute_performance",
				billingTermMonths: 12,
				fundingSource: "wallet",
			},
		};
		// Provider metadata may change later; the persisted binding replays unchanged.
		expect(parseCreationAttempt(JSON.stringify(saved))).toEqual(saved);
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, request: { ...saved.request, ai_provider_id: "other" } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({ ...saved, draft: { ...draft, ai: { ...draft.ai, providerId: "other" } } }),
			),
		).toBeNull();
		expect(
			parseCreationAttempt(
				JSON.stringify({
					...saved,
					subscription: { ...saved.subscription, planSlug: "compute_basic" },
				}),
			),
		).toBeNull();
		expect(parseCreationAttempt(JSON.stringify({ ...saved, storeFunding: "funded" }))).toBeNull();
		const gone = new ApiClientError(409, "reusable_subscription_unavailable");
		expect(isDefinitiveAdmissionRejection({ ...saved, submission: "prepared" }, gone)).toBe(true);
		expect(
			isDefinitiveAdmissionRejection(
				{ ...saved, submission: "prepared", subscription: undefined },
				gone,
			),
		).toBe(false);
	});
});

describe("store-only admission recovery", () => {
	const id = "8e244ab3-1111-4111-8111-111111111111";
	const draft: HostedDeployWizardDraft = {
		runtime: "hermes",
		computePlanSlug: "compute_basic",
		agentName: "Store Agent",
		language: "en",
		timezone: "UTC",
		ai: { mode: "unmanaged" },
	};
	const built = validateAndBuildHostedDeployRequest(draft);
	if (!built.ok) throw new Error("Invalid fixture");
	const attempt: CreationAttempt = {
		version: 1,
		submission: "prepared",
		id,
		draft,
		request: { ...built.request, deploy_request_id: id },
		storeFunding: "funded",
	};

	test("first-send store_compute_unavailable makes the saved request purchasable and discardable; earlier uncertainty stays", async () => {
		for (const submission of ["prepared", "uncertain"] as const) {
			const values = new Map<string, string>();
			const journal = createAttemptStore({
				getItemAsync: async (key) => values.get(key) ?? null,
				setItemAsync: async (key, value) => {
					values.set(key, value);
				},
				deleteItemAsync: async (key) => {
					values.delete(key);
				},
			});
			const saved = { ...attempt, submission };
			await journal.saveAttempt("account", saved, () => true);
			const submitting = { ...saved, submission: "uncertain" as const };
			await journal.replaceAttempt("account", saved, submitting, () => true);
			const recovered = storeAdmissionRecoveryAttempt(
				saved,
				new ApiClientError(409, "store_compute_unavailable"),
			);
			if (recovered) await journal.replaceAttempt("account", submitting, recovered, () => true);
			const restored = await journal.readSavedAttempt("account");
			if (!restored) throw new Error("Missing saved request");
			if (submission === "prepared") {
				expect(restored.storeFunding).toBe("awaiting_purchase");
				expect(canStartStorePurchase(restored)).toBe(true);
				expect(canDiscardCreationAttempt(restored) && !storeFundingHoldsAttempt(restored)).toBe(
					true,
				);
			} else {
				expect(recovered).toBeNull();
				expect(restored).toEqual(submitting);
				expect(canDiscardCreationAttempt(restored)).toBe(false);
			}
		}
	});

	test("long Retry-After is not awaited", async () => {
		const error = new ApiClientError(409, "compute_entitlement_pending", 30_001);
		let sends = 0;
		await expect(
			retryStoreAdmission(
				attempt,
				async () => {
					sends++;
					throw error;
				},
				new AbortController().signal,
				async () => {
					throw new Error("Must not wait");
				},
			),
		).rejects.toBe(error);
		expect(sends).toBe(1);
		expect(storeAdmissionMessageKey(attempt, error)).toBe("creation.storeComputePending");
	});

	test.each([
		["store_compute_unavailable", "creation.storeComputeUnavailable"],
		["store_compute_subscriptions_disabled", "creation.storeComputeDisabled"],
		["compute_entitlement_pending", "creation.storeComputePending"],
		["deployment_plan_release_pending", "creation.storeComputePending"],
	] as const)(
		"preserves store-funded attempts for %s with Check status / retry copy",
		(code, key) => {
			const error = new ApiClientError(409, code);
			for (const submission of ["prepared", "uncertain", "entitlement_rejected"] as const) {
				const saved = { ...attempt, submission };
				expect(isDefinitiveAdmissionRejection(saved, error)).toBe(false);
				expect(storeAdmissionMessageKey(saved, error)).toBe(key);
			}
			const copy = {
				"creation.storeComputeUnavailable": en.creation.storeComputeUnavailable,
				"creation.storeComputeDisabled": en.creation.storeComputeDisabled,
				"creation.storeComputePending": en.creation.storeComputePending,
			}[key];
			expect(copy).toContain("Check status");
			if (key !== "creation.storeComputeUnavailable") expect(copy).toContain("retry");
			expect(storeAdmissionMessageKey({ ...attempt, storeFunding: undefined }, error)).toBeNull();
		},
	);

	test("a store purchase is preserved even if admission reports a missing entitlement", () => {
		expect(
			isDefinitiveAdmissionRejection(
				attempt,
				new ApiClientError(409, "compute_entitlement_required"),
			),
		).toBe(false);
	});

	test("HTTP pending responses retry the same store-only body without persisting compute_source", async () => {
		const bodies: unknown[] = [];
		const keys: (string | null)[] = [];
		const operation: DeployComponents["schemas"]["LongRunningOperation"] = {
			name: "operations/store-create",
			done: false,
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_store",
				verb: "create",
				targetGeneration: 1,
				manifestETag: "etag",
				createTime: "2026-10-08T00:00:00Z",
				updateTime: "2026-10-08T00:00:00Z",
			},
		};
		const client = createHostedComputeClient({
			baseUrl: "https://compute.example.test",
			getToken: async () => "test-token",
			fetch: async (request) => {
				bodies.push(await request.json());
				keys.push(request.headers.get("Idempotency-Key"));
				return bodies.length < 3
					? Response.json(
							{
								code:
									bodies.length === 1
										? "compute_entitlement_pending"
										: "deployment_plan_release_pending",
							},
							{ status: 409, headers: { "Retry-After": "0" } },
						)
					: Response.json(operation, { status: 202 });
			},
		});
		const before = JSON.stringify(attempt);
		expect(
			await retryStoreAdmission(
				attempt,
				(signal) =>
					client.createEntitledDeployment(attempt.request, attempt.id, signal, {
						computeSource: "store",
					}),
				new AbortController().signal,
			),
		).toEqual(operation);
		expect(bodies).toEqual(
			Array.from({ length: 3 }, () => ({ ...attempt.request, compute_source: "store" })),
		);
		expect(keys).toEqual([attempt.id, attempt.id, attempt.id]);
		expect(JSON.stringify(attempt)).toBe(before);
		expect(parseCreationAttempt(before)).toEqual(attempt);
	});

	test.each(["compute_entitlement_pending", "deployment_plan_release_pending"])(
		"retries %s after the supplied delay and keeps the exact journal",
		async (code) => {
			const original = JSON.stringify(attempt);
			const delays: number[] = [];
			let sends = 0;
			const signal = new AbortController().signal;
			const result = await retryStoreAdmission(
				attempt,
				async (s) => {
					expect(s).toBe(signal);
					sends++;
					if (sends <= 2) throw new ApiClientError(409, code, sends * 5000);
					return "admitted";
				},
				signal,
				async (delay) => {
					delays.push(delay);
				},
			);
			expect(result).toBe("admitted");
			expect(delays).toEqual([5000, 10_000]);
			expect(sends).toBe(3);
			expect(JSON.stringify(attempt)).toBe(original);
			expect(parseCreationAttempt(original)).toEqual(attempt);
		},
	);

	test.each(["compute_entitlement_pending", "deployment_plan_release_pending"])(
		"bounds retries for %s then directs Check status",
		async (code) => {
			const error = new ApiClientError(409, code, 5000);
			let sends = 0;
			const delays: number[] = [];
			await expect(
				retryStoreAdmission(
					attempt,
					async () => {
						sends++;
						throw error;
					},
					new AbortController().signal,
					async (delay) => {
						delays.push(delay);
					},
				),
			).rejects.toBe(error);
			expect(sends).toBe(4);
			expect(delays).toEqual([5000, 5000, 5000]);
			expect(storeAdmissionMessageKey(attempt, error)).toBe("creation.storeComputePending");
		},
	);

	test("does not retry non-store attempts, unavailable/disabled admission, uncertainty or missing guidance", async () => {
		for (const [saved, error] of [
			[
				{ ...attempt, storeFunding: undefined },
				new ApiClientError(409, "compute_entitlement_pending", 5000),
			],
			[
				{ ...attempt, storeFunding: "purchase_pending" as const },
				new ApiClientError(409, "compute_entitlement_pending", 5000),
			],
			[attempt, new ApiClientError(409, "store_compute_unavailable", 5000)],
			[attempt, new ApiClientError(409, "store_compute_subscriptions_disabled", 5000)],
			[attempt, new ApiClientError(409, "compute_entitlement_pending")],
			[attempt, new ApiClientError(500, "compute_entitlement_pending", 5000)],
			[attempt, new Error("network uncertainty")],
		] as const) {
			let sends = 0;
			await expect(
				retryStoreAdmission(
					saved,
					async () => {
						sends++;
						throw error;
					},
					new AbortController().signal,
					async () => {
						throw new Error("Must not wait");
					},
				),
			).rejects.toBe(error);
			expect(sends).toBe(1);
		}
	});

	test("account cancellation during Retry-After stops the timer and any later POST", async () => {
		const controller = new AbortController();
		let started: () => void = () => {};
		const sent = new Promise<void>((resolve) => {
			started = resolve;
		});
		let sends = 0;
		const result = retryStoreAdmission(
			attempt,
			async () => {
				sends++;
				started();
				throw new ApiClientError(409, "compute_entitlement_pending", 30_000);
			},
			controller.signal,
		);
		await sent;
		// Let the failed POST start its retry timer before canceling the account scope.
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort(new Error("Account changed"));
		await expect(result).rejects.toBe(controller.signal.reason);
		expect(sends).toBe(1);
	});
});

describe("new Wallet subscription creation", () => {
	const id = "8e244ab3-3333-4333-8333-333333333333";
	const draft: HostedDeployWizardDraft = {
		runtime: "hermes",
		computePlanSlug: "compute_basic",
		agentName: "Wallet Agent",
		language: "en",
		timezone: "UTC",
		ai: { mode: "unmanaged" },
	};
	const built = validateAndBuildHostedDeployRequest(draft);
	if (!built.ok) throw new Error("Invalid fixture");
	// Server field order differs from the canonical journal shape on purpose.
	const serverQuote = {
		balance_after_usd: "20.00",
		balance_before_usd: "30.00",
		billing_term_months: 1,
		currency: "usd",
		debit_amount_usd: "10.00",
		expires_at: "2026-10-09T23:30:00Z",
		funding_source: "wallet",
		plan_slug: "compute_basic",
		term_price_cents: 1000,
	} as const;
	const walletQuote = canonicalWalletQuote(serverQuote, "compute_basic");
	if (!walletQuote) throw new Error("Invalid quote fixture");
	const attempt: CreationAttempt = {
		version: 1,
		submission: "prepared",
		id,
		draft,
		request: { ...built.request, deploy_request_id: id },
		walletQuote,
	};
	const memoryJournal = () => {
		const values = new Map<string, string>();
		const store = {
			getItemAsync: async (key: string) => values.get(key) ?? null,
			setItemAsync: async (key: string, value: string) => {
				values.set(key, value);
			},
			deleteItemAsync: async (key: string) => {
				values.delete(key);
			},
		};
		return { store, journal: createAttemptStore(store) };
	};

	test("only a complete Wallet quote for the draft's plan is journaled", () => {
		expect(walletQuote.preview_invoice_id).toBeNull();
		expect(
			canonicalWalletQuote({ ...serverQuote, plan_slug: "compute_performance" }, "compute_basic"),
		).toBeNull();
		expect(
			canonicalWalletQuote({ ...serverQuote, funding_source: "stripe" }, "compute_basic"),
		).toBeNull();
		expect(
			canonicalWalletQuote({ ...serverQuote, debit_amount_usd: null }, "compute_basic"),
		).toBeNull();
		expect(
			canonicalWalletQuote({ ...serverQuote, balance_after_usd: "-6" }, "compute_basic"),
		).not.toBeNull();
		expect(
			canonicalWalletQuote({ ...serverQuote, balance_before_usd: "0E-8" }, "compute_basic"),
		).not.toBeNull();
		expect(parseCreationAttempt(JSON.stringify(attempt))).toEqual(attempt);
		for (const invalid of [
			{ ...attempt, walletQuote: { ...walletQuote, plan_slug: "compute_performance" } },
			{ ...attempt, walletQuote: { ...walletQuote, expires_at: "soon" } },
			{ ...attempt, storeFunding: "funded" },
			{
				...attempt,
				subscription: {
					id: "csub_K8fJ3pQm",
					planSlug: "compute_basic",
					billingTermMonths: 1,
					fundingSource: "wallet",
				},
			},
		])
			expect(parseCreationAttempt(JSON.stringify(invalid))).toBeNull();
	});

	test("crash after the uncertain marker replays the identical checkout after restart", async () => {
		const { store, journal } = memoryJournal();
		// Journal before POST, then mark uncertainty before any send.
		await journal.saveAttempt("account", attempt, () => true);
		const submitting: CreationAttempt = { ...attempt, submission: "uncertain" };
		await journal.replaceAttempt("account", attempt, submitting, () => true);
		const sent: { key: string | null; body: unknown }[] = [];
		const client = createHostedComputeClient({
			baseUrl: "https://compute.example.test",
			getToken: async () => "token",
			fetch: async (request) => {
				sent.push({ key: request.headers.get("Idempotency-Key"), body: await request.json() });
				return Response.json({ detail: "lost" }, { status: 502 });
			},
		});
		const send = (saved: CreationAttempt) => {
			if (!saved.walletQuote) throw new Error("Missing quote");
			return client
				.createWalletSubscriptionDeployment(saved.request, saved.id, saved.walletQuote)
				.catch(() => undefined);
		};
		await send(submitting);
		// The app restarts: a new journal instance reads the same storage.
		const restored = await createAttemptStore(store).readSavedAttempt("account");
		if (!restored) throw new Error("Missing saved request");
		expect(restored).toEqual(submitting);
		expect(canDiscardCreationAttempt(restored)).toBe(false);
		await send(restored);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(sent[0]);
		expect(sent[0]?.key).toBe(id);
	});

	test("a different quote is never sent under a journaled request", async () => {
		const { journal } = memoryJournal();
		await journal.saveAttempt("account", attempt, () => true);
		await expect(
			journal.replaceAttempt(
				"account",
				attempt,
				{
					...attempt,
					submission: "uncertain",
					walletQuote: { ...walletQuote, balance_before_usd: "40.00" },
				},
				() => true,
			),
		).rejects.toThrow("Request payload changed");
		// Account switch: the old owner can no longer write.
		await expect(
			journal.replaceAttempt(
				"account",
				attempt,
				{ ...attempt, submission: "uncertain" },
				() => false,
			),
		).rejects.toThrow("Creation owner changed");
		expect(await journal.readSavedAttempt("account")).toEqual(attempt);
	});

	test("only hosted's typed 404, past the quote's expiry plus grace, releases the request", () => {
		const expiry = Date.parse(walletQuote.expires_at);
		const uncertain: CreationAttempt = { ...attempt, submission: "uncertain" };
		const notFound = (code: string | null, serverDateMs: number | null) =>
			new ApiClientError(404, code, null, serverDateMs);
		const graceEnd = expiry + WALLET_RELEASE_GRACE_MS;
		expect(WALLET_RELEASE_GRACE_MS).toBe(10 * 60_000);
		const released = releaseWalletRequest(
			uncertain,
			notFound("deploy_request_not_found", graceEnd),
		);
		// Same request id and payload; only the submission marker changes.
		expect(released).toEqual({ ...uncertain, submission: "released" });
		for (const error of [
			// Untyped 404s: a gateway, or hosted's principal/owner check.
			notFound(null, graceEnd + 60_000),
			notFound("owner_not_found", graceEnd + 60_000),
			// Hosted's typed 404, but within the grace period or without a server clock.
			notFound("deploy_request_not_found", graceEnd - 1),
			notFound("deploy_request_not_found", expiry + 60_000),
			notFound("deploy_request_not_found", null),
			new ApiClientError(409, "deploy_request_not_found", null, graceEnd),
			new ApiClientNetworkError("offline"),
		])
			expect(releaseWalletRequest(uncertain, error)).toBeNull();
		// Only an uncertain Wallet request can be released.
		const typed = notFound("deploy_request_not_found", graceEnd);
		expect(releaseWalletRequest(attempt, typed)).toBeNull();
		const { walletQuote: _quote, ...included } = uncertain;
		expect(releaseWalletRequest(included, typed)).toBeNull();
	});

	test("a released request keeps its id, may be discarded and is confirmed on a fresh quote", async () => {
		const uncertain: CreationAttempt = { ...attempt, submission: "uncertain" };
		const released: CreationAttempt = { ...uncertain, submission: "released" };
		expect(creationAttemptControls(attempt, false)).toEqual({ checkStatus: false, discard: true });
		expect(creationAttemptControls(uncertain, false)).toEqual({
			checkStatus: true,
			discard: false,
		});
		// Hosted's typed 404 after the grace period proves no charge, so the wizard never locks.
		expect(creationAttemptControls(released, false)).toEqual({
			checkStatus: false,
			discard: true,
		});
		expect(canDiscardCreationAttempt(released)).toBe(true);
		expect(canDiscardCreationAttempt(uncertain)).toBe(false);
		expect(walletRequestNeedsQuote(released)).toBe(true);
		expect(walletRequestNeedsQuote(uncertain)).toBe(false);
		expect(walletRequestNeedsQuote(null)).toBe(false);
		expect(parseCreationAttempt(JSON.stringify(released))).toEqual(released);
		const { walletQuote: _quote, ...withoutQuote } = released;
		expect(parseCreationAttempt(JSON.stringify(withoutQuote))).toBeNull();
		expect(en.creation.walletNotFound).toBe("We couldn't find this payment — you can try again.");
		expect(en.creation.walletNotFound).not.toMatch(/charged|no payment|nothing/i);

		const { journal } = memoryJournal();
		await journal.saveAttempt("account", attempt, () => true);
		await journal.replaceAttempt("account", attempt, uncertain, () => true);
		const fresh = {
			...walletQuote,
			expires_at: "2026-10-10T00:30:00Z",
			balance_before_usd: "25.00",
			balance_after_usd: "15.00",
		};
		// While a send may still charge, the confirmed quote is immutable.
		await expect(
			journal.replaceAttempt(
				"account",
				uncertain,
				{ ...uncertain, walletQuote: fresh },
				() => true,
			),
		).rejects.toThrow("Request payload changed");
		await journal.replaceAttempt("account", uncertain, released, () => true);
		const requoted: CreationAttempt = { ...released, walletQuote: fresh };
		await journal.replaceAttempt("account", released, requoted, () => true);
		await journal.replaceAttempt(
			"account",
			requoted,
			{ ...requoted, submission: "uncertain" },
			() => true,
		);
		expect(await journal.readSavedAttempt("account")).toEqual({
			...attempt,
			submission: "uncertain",
			walletQuote: fresh,
		});
	});

	test("the wizard sends only the quote terms the user saw", () => {
		const fresh = {
			...walletQuote,
			expires_at: "2026-10-10T00:30:00Z",
			preview_invoice_id: "in_2",
		};
		expect(walletQuoteConfirmation(walletQuote, fresh)).toBe("confirmed");
		expect(walletQuoteConfirmation(null, fresh)).toBe("changed");
		expect(
			walletQuoteConfirmation(walletQuote, {
				...fresh,
				balance_before_usd: "29.00",
				balance_after_usd: "19.00",
			}),
		).toBe("changed");
		const short = { ...fresh, balance_before_usd: "4.00", balance_after_usd: "-6.00" };
		expect(walletQuoteConfirmation(short, short)).toBe("changed");
	});

	test("'No wallet payment was made' only for a definitive refusal of the first and only send", async () => {
		const noPayment = "No wallet payment was made";
		const unconfirmed = "We couldn’t confirm the payment — check status before trying again.";
		const refused = recordHostedCheckoutSends(new ApiClientError(422, null), 1);
		expect(walletCreationErrorCopy(attempt, refused).description).toContain(noPayment);
		// Without a recorded send count the refusal is never treated as a first send.
		expect(walletCreationErrorCopy(attempt, new ApiClientError(422, null)).description).toBe(
			unconfirmed,
		);
		// Manual retry of an uncertain send, a replay conflict, or a released request's send.
		for (const saved of [
			{ ...attempt, submission: "uncertain" as const },
			{ ...attempt, submission: "released" as const },
		])
			for (const error of [refused, new ApiClientError(409, "idempotency_key_reused")])
				expect(walletCreationErrorCopy(saved, error).description).toBe(unconfirmed);

		// A slow first send, then "billing operation in progress" on the shared retries.
		const replies = [
			() => {
				throw new TypeError("Network request failed");
			},
			() =>
				Response.json(
					{ detail: "A billing operation is already in progress" },
					{ status: 409, headers: { "Retry-After": "0" } },
				),
			() =>
				Response.json(
					{ detail: "A billing operation is already in progress" },
					{ status: 409, headers: { "Retry-After": "0" } },
				),
		];
		let sends = 0;
		const client = createHostedComputeClient({
			baseUrl: "https://compute.example.test",
			getToken: async () => "token",
			fetch: async () => {
				const reply = replies[sends++];
				if (!reply) throw new Error("Unexpected send");
				return reply();
			},
		});
		const error = await client
			.createWalletSubscriptionDeployment(attempt.request, attempt.id, walletQuote)
			.then(
				() => null,
				(failure: unknown) => failure,
			);
		expect(sends).toBe(3);
		expect(error).toMatchObject({ status: 409 });
		const copy = walletCreationErrorCopy(attempt, error);
		expect(copy.description).toBe(unconfirmed);
		expect(copy.description).not.toContain(noPayment);
	});

	test("refusals keep the request for same-key replay with Web's copy", () => {
		const insufficient = new ApiClientError(402, "insufficient_wallet_balance");
		// A Wallet request is never released as an entitlement rejection.
		for (const error of [insufficient, new ApiClientError(409, "compute_entitlement_required")])
			expect(isDefinitiveAdmissionRejection(attempt, error)).toBe(false);
		expect(deploySubmissionFailure(new ApiClientNetworkError("timeout"))).toEqual({
			kind: "timeout",
			recovery: null,
		});
		expect(deploySubmissionFailure(new ApiClientError(503))).toEqual({
			kind: "server",
			recovery: null,
		});
		expect(deploySubmissionFailure(new ApiClientError(409, "idempotency_key_reused"))).toEqual({
			kind: "rejected",
			code: "idempotency_key_reused",
			recovery: "This attempt couldn't be matched to the earlier request.",
		});
		// Hosted debited, then deferred acceptance: never claim nothing was paid.
		const pending = deploySubmissionErrorCopy(
			deploySubmissionFailure(new ApiClientError(409, "deployment_acceptance_pending")),
			"wallet_creation",
		);
		expect(pending.title).toBe("Your payment may have gone through");
		expect(pending.description).not.toContain("No wallet payment was made");
		expect(pending.description).toContain("Check its status");
		expect(
			walletCreationErrorCopy(attempt, recordHostedCheckoutSends(new ApiClientError(401), 1)),
		).toEqual({
			title: "Payment and creation didn’t start",
			description:
				"Your session expired before this request could start. No wallet payment was made. Review your choices and retry.",
		});
		expect(
			deploySubmissionErrorCopy(
				deploySubmissionFailure(new ApiClientNetworkError("offline")),
				"wallet_creation",
			).description,
		).toContain("Retry to safely resume the same attempt.");
	});
});
