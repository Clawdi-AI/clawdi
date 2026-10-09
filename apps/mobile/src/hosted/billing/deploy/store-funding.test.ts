import { describe, expect, test } from "bun:test";
import {
	ApiClientError,
	type StoreComputeSlot,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import {
	admitWithStoreSlotRefresh,
	type CreationAttempt,
	canAdmitCreationAttempt,
	canDiscardCreationAttempt,
	canStartStorePurchase,
	finishReservedRequest,
	parseCreationAttempt,
	reservedDeployResume,
	reusableStoreRowPlan,
	storeFundingAfterCheck,
	storeFundingHoldsAttempt,
	unboundStoreSlotPlan,
} from "@/hosted/billing/deploy/deploy-request";
import { AccountScopeChangedError } from "@/platform/auth/account-scope";
import { createAttemptStore } from "@/platform/creation-attempt-store";

const id = "8e244ab3-1111-4111-8111-111111111111";

function storeAttempt(storeFunding: CreationAttempt["storeFunding"]): CreationAttempt {
	const draft = {
		runtime: "hermes",
		computePlanSlug: "compute_performance",
		agentName: "Agent",
		language: "en",
		timezone: "",
		ai: { mode: "unmanaged" },
	} as const;
	const result = validateAndBuildHostedDeployRequest(draft);
	if (!result.ok) throw new Error("Invalid fixture");
	return {
		version: 1,
		submission: "prepared",
		id,
		draft,
		request: { ...result.request, deploy_request_id: id },
		...(storeFunding ? { storeFunding } : {}),
	};
}

const plan = "compute_performance";
const noSlot = null;

describe("store-funded creation admission", () => {
	const other = {
		purpose: "compute_subscription" as const,
		pending_deploy_request_id: "other-request",
		state: "funding_applied" as const,
	};
	const own = { ...other, pending_deploy_request_id: id };

	test("Check status admits only this request's funded attempt while a live one remains", () => {
		const check = (attempts: Parameters<typeof storeFundingAfterCheck>[1]) =>
			storeFundingAfterCheck(id, attempts, "purchase_pending", plan, noSlot);
		expect(check([other, { ...own, state: "verification_pending" }])).toBe("purchase_pending");
		expect(check([{ ...own, state: "prepared" }])).toBe("purchase_pending");
		expect(check([own])).toBe("funded");
		// A locally cancelled request keeps its retry while its prepared attempt lives on.
		expect(
			storeFundingAfterCheck(id, [{ ...own, state: "prepared" }], "awaiting_purchase", plan, null),
		).toBe("awaiting_purchase");
	});

	test("an expired or missing attempt returns the request to awaiting_purchase", () => {
		for (const attempts of [
			[{ ...own, state: "expired" as const }],
			[{ ...own, state: "rejected" as const }],
			[{ ...own, state: "canceled" as const }],
			[{ ...own, purpose: "standalone_topup" as const }],
			[],
		]) {
			const funding = storeFundingAfterCheck(id, attempts, "purchase_pending", plan, noSlot);
			expect(funding).toBe("awaiting_purchase");
			expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(false);
		}
	});

	test("an expired attempt plus an unbound slot of the same plan allows admission", () => {
		const expired = [{ ...own, state: "expired" as const }];
		const funding = storeFundingAfterCheck(id, expired, "purchase_pending", plan, plan);
		expect(funding).toBe("funded");
		expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(true);
		// A slot of another plan cannot be bound by this request.
		const other = storeFundingAfterCheck(id, expired, "purchase_pending", plan, "compute_basic");
		expect(other).toBe("awaiting_purchase");
		expect(canAdmitCreationAttempt({ storeFunding: other })).toBe(false);
		// A live attempt is never bypassed by a slot.
		expect(
			storeFundingAfterCheck(id, [{ ...own, state: "prepared" }], "purchase_pending", plan, plan),
		).toBe("purchase_pending");
	});

	test("reconciliation_required blocks admission and allows discarding the draft", () => {
		const fromCheck = storeFundingAfterCheck(
			id,
			[{ ...own, state: "reconciliation_required" }],
			"purchase_pending",
			plan,
			plan,
		);
		const funding = fromCheck;
		expect(funding).toBe("review_required");
		const attempt = storeAttempt(funding);
		expect(canAdmitCreationAttempt(attempt)).toBe(false);
		expect(canStartStorePurchase(attempt)).toBe(false);
		expect(canDiscardCreationAttempt(attempt) && !storeFundingHoldsAttempt(attempt)).toBe(true);
	});

	test("unbound store slots are matched by plan and supplying state only", () => {
		const management = {
			contract_id: "11111111-1111-4111-8111-111111111111",
			provider: "app_store" as const,
			product_id: "ai.clawdi.app.compute.performance.monthly",
			management_url: null,
			auto_renews: true,
			renews_or_ends_at: null,
			state: "active",
		};
		const planOf = (productId: string) =>
			productId.includes("performance") ? "compute_performance" : "compute_basic";
		const slot = {
			available: false,
			contract_id: "c",
			agent_id: null,
			store_management: management,
		};
		expect(unboundStoreSlotPlan(slot, planOf, id)).toBe("compute_performance");
		expect(unboundStoreSlotPlan({ ...slot, agent_id: "hdep_bound" }, planOf, id)).toBeNull();
		expect(unboundStoreSlotPlan({ available: true }, planOf, id)).toBeNull();
		expect(
			unboundStoreSlotPlan(
				{ ...slot, store_management: { ...management, state: "lapsed" } },
				planOf,
				id,
			),
		).toBeNull();
		expect(unboundStoreSlotPlan(null, planOf, id)).toBeNull();
		// A compute reserved for a request admits that request only.
		expect(unboundStoreSlotPlan({ ...slot, reserved_deploy_request_id: id }, planOf, id)).toBe(
			"compute_performance",
		);
		expect(
			unboundStoreSlotPlan({ ...slot, reserved_deploy_request_id: "other" }, planOf, id),
		).toBeNull();
	});

	test("a restart mid-purchase restores the store gate from the creation journal", async () => {
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
		const awaiting = storeAttempt("awaiting_purchase");
		await createAttemptStore(store).saveAttempt("account", awaiting, () => true);
		const pending = storeAttempt("purchase_pending");
		await createAttemptStore(store).replaceAttempt("account", awaiting, pending, () => true);

		const restarted = await createAttemptStore(store).readSavedAttempt("account");
		expect(restarted).toEqual(pending);
		if (!restarted) throw new Error("Missing journal");
		expect(canAdmitCreationAttempt(restarted)).toBe(false);
		expect(canStartStorePurchase(restarted)).toBe(false);
		expect(storeFundingHoldsAttempt(restarted)).toBe(true);

		const funded = storeAttempt("funded");
		await createAttemptStore(store).replaceAttempt("account", restarted, funded, () => true);
		const afterCheck = await createAttemptStore(store).readSavedAttempt("account");
		expect(afterCheck && canAdmitCreationAttempt(afterCheck)).toBe(true);
	});

	test("journals reject unknown store funding values", () => {
		expect(
			parseCreationAttempt(JSON.stringify({ ...storeAttempt(undefined), storeFunding: "paid" })),
		).toBeNull();
		expect(parseCreationAttempt(JSON.stringify(storeAttempt(undefined)))).toEqual(
			storeAttempt(undefined),
		);
	});
});

describe("reusable store rows", () => {
	const planOf = (productId: string) =>
		productId.includes("performance") ? "compute_performance" : "compute_basic";
	const contract = "11111111-1111-4111-8111-111111111111";
	const management = {
		contract_id: contract,
		provider: "play_store" as const,
		product_id: "ai.clawdi.app.compute.basic.monthly",
		management_url: null,
		auto_renews: true,
		renews_or_ends_at: null,
		state: "active",
	};
	const slot: StoreComputeSlot = {
		available: false,
		contract_id: contract,
		agent_id: null,
		reserved_deploy_request_id: null,
		store_management: management,
	};
	const row = {
		funding_source: "store" as const,
		plan_slug: "compute_basic" as const,
		store_management: management,
	};

	test("the caller's unbound slot is admitted as store funding for its plan", () => {
		expect(reusableStoreRowPlan(row, slot, planOf)).toBe("compute_basic");
		// Contract ids compare case-insensitively, like the shared UUID guards.
		expect(
			reusableStoreRowPlan(row, { ...slot, contract_id: contract.toUpperCase() }, planOf),
		).toBe("compute_basic");
		// The funded attempt this enables is store-only and may be admitted at once.
		const attempt = storeAttempt("funded");
		expect(canAdmitCreationAttempt(attempt)).toBe(true);
		expect(storeFundingHoldsAttempt(attempt)).toBe(true);
	});

	test("rows that are not this caller's free slot are never offered", () => {
		for (const [candidateRow, candidateSlot] of [
			[row, null],
			[row, { ...slot, contract_id: "22222222-2222-4222-8222-222222222222" }],
			[row, { ...slot, agent_id: "hdep_bound" }],
			[row, { ...slot, reserved_deploy_request_id: id }],
			[row, { ...slot, store_management: { ...management, state: "lapsed" } }],
			[{ ...row, plan_slug: "compute_performance" as const }, slot],
			[{ ...row, funding_source: "wallet" as const }, slot],
			[{ ...row, store_management: null }, slot],
		] as const)
			expect(reusableStoreRowPlan(candidateRow, candidateSlot, planOf)).toBeNull();
	});
});

describe("reserved store requests and late webhooks", () => {
	const planOf = (productId: string) =>
		productId.includes("performance") ? "compute_performance" : "compute_basic";
	const slot: StoreComputeSlot = {
		available: false,
		contract_id: "11111111-1111-4111-8111-111111111111",
		compute_subscription_id: 7,
		agent_id: null,
		reserved_deploy_request_id: id,
		store_management: {
			contract_id: "11111111-1111-4111-8111-111111111111",
			provider: "play_store",
			product_id: "ai.clawdi.app.compute.performance.monthly",
			management_url: null,
			auto_renews: true,
			renews_or_ends_at: null,
			state: "active",
		},
	};
	const unavailable = new ApiClientError(409, "store_compute_unavailable");

	test("offers the reserved request only when no journal entry exists", () => {
		expect(reservedDeployResume(slot, null, planOf)).toEqual({ id, planSlug: plan });
		// The journal already owns this request (or another one): never offer a second admission.
		expect(reservedDeployResume(slot, storeAttempt("funded"), planOf)).toBeNull();
		expect(
			reservedDeployResume(slot, { ...storeAttempt(undefined), id: "other" }, planOf),
		).toBeNull();
		expect(reservedDeployResume({ ...slot, agent_id: "hdep_bound" }, null, planOf)).toBeNull();
		expect(
			reservedDeployResume({ ...slot, reserved_deploy_request_id: null }, null, planOf),
		).toBeNull();
		// Only ids a creation journal can persist are resumable.
		expect(
			reservedDeployResume({ ...slot, reserved_deploy_request_id: "lost-draft" }, null, planOf),
		).toBeNull();
		expect(reservedDeployResume(slot, null, () => null)).toBeNull();
		expect(reservedDeployResume(null, null, planOf)).toBeNull();
	});

	test("a resumed request is admitted with its reserved id as a funded store request", async () => {
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
		const resume = reservedDeployResume(slot, null, planOf);
		if (!resume) throw new Error("Missing resume");
		const resumed = { ...storeAttempt("funded"), id: resume.id };
		expect(resumed.request.deploy_request_id).toBe(resume.id);
		expect(resumed.request.compute_plan_slug).toBe(resume.planSlug);
		expect(canAdmitCreationAttempt(resumed)).toBe(true);
		await journal.saveAttempt("account", resumed, () => true);
		// After a restart the saved request, not the offer, drives the same admission.
		const restored = await journal.readSavedAttempt("account");
		expect(restored).toEqual(resumed);
		expect(reservedDeployResume(slot, restored, planOf)).toBeNull();
	});

	function reservedSteps(readStatus: () => Promise<unknown>, current = () => true) {
		const calls: string[] = [];
		return {
			calls,
			steps: {
				readStatus,
				admit: async () => {
					calls.push("admit");
				},
				observe: async () => {
					calls.push("observe");
				},
				current,
			},
		};
	}

	test("a by-request 404 admits the user's draft under the reserved id", async () => {
		const { calls, steps } = reservedSteps(async () => {
			throw new ApiClientError(404);
		});
		await finishReservedRequest(steps);
		expect(calls).toEqual(["admit"]);
	});

	test("a request hosted already holds is observed, never re-sent", async () => {
		const { calls, steps } = reservedSteps(async () => ({
			deploy_request_id: id,
			request_status: "pending",
		}));
		await finishReservedRequest(steps);
		expect(calls).toEqual(["observe"]);
	});

	test("a failed pre-check admits nothing and surfaces the failure", async () => {
		for (const failure of [
			new ApiClientError(500),
			new ApiClientError(409, "idempotency_key_reused"),
			new Error("offline"),
		]) {
			const { calls, steps } = reservedSteps(async () => {
				throw failure;
			});
			await expect(finishReservedRequest(steps)).rejects.toBe(failure);
			expect(calls).toEqual([]);
		}
	});

	test("an account switch during the pre-check admits and observes nothing", async () => {
		let active = true;
		const { calls, steps } = reservedSteps(
			async () => {
				active = false;
				throw new ApiClientError(404);
			},
			() => active,
		);
		await finishReservedRequest(steps);
		expect(calls).toEqual([]);
	});

	test("store_compute_unavailable re-reads the slot once and repeats the same request", async () => {
		const attempt = storeAttempt("funded");
		const unbound = { ...slot, compute_subscription_id: null, reserved_deploy_request_id: null };
		const sent: string[] = [];
		let reads = 0;
		const result = await admitWithStoreSlotRefresh(
			attempt,
			async () => {
				sent.push(attempt.request.deploy_request_id ?? "missing");
				if (sent.length === 1) throw unavailable;
				return "admitted";
			},
			async () => {
				reads++;
				return unbound;
			},
			planOf,
		);
		expect(result).toBe("admitted");
		expect(sent).toEqual([id, id]);
		expect(reads).toBe(1);
	});

	test("never retries more than once or without a slot this request can bind", async () => {
		const attempt = storeAttempt("funded");
		const cases: [StoreComputeSlot | null, number][] = [
			[{ ...slot, reserved_deploy_request_id: null }, 2],
			[{ ...slot, reserved_deploy_request_id: "other-request" }, 1],
			[{ ...slot, reserved_deploy_request_id: null, agent_id: "hdep_bound" }, 1],
			[
				{
					...slot,
					reserved_deploy_request_id: null,
					store_management: slot.store_management
						? { ...slot.store_management, product_id: "ai.clawdi.app.compute.basic.monthly" }
						: null,
				},
				1,
			],
			[{ available: true }, 1],
			[null, 1],
		];
		for (const [read, expectedSends] of cases) {
			let sends = 0;
			await expect(
				admitWithStoreSlotRefresh(
					attempt,
					async () => {
						sends++;
						throw unavailable;
					},
					async () => read,
					planOf,
				),
			).rejects.toBe(unavailable);
			expect(sends).toBe(expectedSends);
		}
	});

	test("other failures and non-store requests never read the slot", async () => {
		for (const [attempt, error] of [
			[storeAttempt("funded"), new ApiClientError(409, "store_compute_subscriptions_disabled")],
			[storeAttempt("funded"), new ApiClientError(500)],
			[storeAttempt(undefined), unavailable],
		] as const) {
			let reads = 0;
			await expect(
				admitWithStoreSlotRefresh(
					attempt,
					async () => {
						throw error;
					},
					async () => {
						reads++;
						return slot;
					},
					planOf,
				),
			).rejects.toBe(error);
			expect(reads).toBe(0);
		}
	});

	test("an account switch during the slot read keeps the refusal and sends nothing more", async () => {
		let sends = 0;
		await expect(
			admitWithStoreSlotRefresh(
				storeAttempt("funded"),
				async () => {
					sends++;
					throw unavailable;
				},
				async () => {
					throw new AccountScopeChangedError();
				},
				planOf,
			),
		).rejects.toBe(unavailable);
		expect(sends).toBe(1);
	});
});
