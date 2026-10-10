import { expect, test } from "bun:test";
import {
	ApiClientError,
	ApiClientNetworkError,
	parseWorkspaceSkillGitHubInput,
} from "@clawdi/shared/api";
import {
	createSkillAttemptStore,
	parseSkillAttempt,
	type SkillAttempt,
	skillAttemptAfterFailure,
} from "@/platform/skill-attempt";

test("Workspace Skill recovery preserves uncertain intent and rejects stale destructive journal changes", async () => {
	const memory = new Map<string, string>();
	const store = createSkillAttemptStore({
		getItemAsync: async (key) => memory.get(key) ?? null,
		setItemAsync: async (key, value) => {
			memory.set(key, value);
		},
		deleteItemAsync: async (key) => {
			memory.delete(key);
		},
	});
	const prepared: SkillAttempt = {
		format: 1,
		deploymentId: "dep",
		key: "fixed-key",
		version: "rv1",
		mutation: { action: "install", request: { repo: "owner/repo", path: "skills/demo" } },
		status: "prepared",
	};
	await store.saveAttempt("account-dep", prepared, () => true);
	const sending: SkillAttempt = { ...prepared, status: "uncertain" };
	await store.replaceAttempt("account-dep", prepared, sending, () => true);
	expect(await store.readSavedAttempt("account-dep")).toEqual(sending);
	await expect(store.clearAttempt("account-dep", prepared, () => true)).rejects.toThrow(
		"Saved request changed",
	);
	await expect(
		store.replaceAttempt("account-dep", sending, { ...sending, version: "rv2" }, () => true),
	).rejects.toThrow("Request payload changed");
	await store.clearAttempt("account-dep", sending, () => true);
	expect(await store.readSavedAttempt("account-dep")).toBeNull();
	expect(
		parseSkillAttempt(
			JSON.stringify({ ...sending, mutation: { action: "uninstall", skillKey: "clawdi" } }),
		),
	).toBeNull();
	expect(
		parseSkillAttempt(
			JSON.stringify({
				...sending,
				mutation: { action: "install", request: { repo: "owner/repo", injected: true } },
			}),
		),
	).toBeNull();
});

test("a GitHub install journaled in the panel's field order reaches its send", async () => {
	const memory = new Map<string, string>();
	const store = createSkillAttemptStore({
		getItemAsync: async (key) => memory.get(key) ?? null,
		setItemAsync: async (key, value) => {
			memory.set(key, value);
		},
		deleteItemAsync: async (key) => {
			memory.delete(key);
		},
	});
	// Built like the install panel: version before key, unlike parseSkillAttempt's output.
	const prepared: SkillAttempt = {
		format: 1,
		deploymentId: "dep",
		version: "rv1",
		key: "fixed-key",
		mutation: {
			action: "install",
			request: parseWorkspaceSkillGitHubInput("anthropics/skills/skills/brand-guidelines"),
		},
		status: "prepared",
	};
	await store.saveAttempt("account-dep", prepared, () => true);
	const sending: SkillAttempt = { ...prepared, status: "uncertain" };
	await store.replaceAttempt("account-dep", prepared, sending, () => true);
	expect(await store.readSavedAttempt("account-dep")).toEqual(sending);
	await store.clearAttempt("account-dep", sending, () => true);
	expect(await store.readSavedAttempt("account-dep")).toBeNull();
	await expect(
		store.clearAttempt("account-dep", { ...sending, key: "bad key" }, () => true),
	).rejects.toThrow("Invalid saved attempt");
});

test("a failed send settles by what the server proves, whether or not an earlier send was lost", async () => {
	const memory = new Map<string, string>();
	const store = createSkillAttemptStore({
		getItemAsync: async (key) => memory.get(key) ?? null,
		setItemAsync: async (key, value) => {
			memory.set(key, value);
		},
		deleteItemAsync: async (key) => {
			memory.delete(key);
		},
	});
	const uncertain: SkillAttempt = {
		format: 1,
		deploymentId: "dep",
		key: "fixed-key",
		version: "rv1",
		mutation: { action: "install", request: { repo: "owner/repo", path: "skills/demo" } },
		status: "uncertain",
	};
	for (const saved of [uncertain, { ...uncertain, status: "prepared" as const }]) {
		// A live receipt answers before any of these, so none of them follows an applied change.
		for (const [status, code] of [
			[412, "resource_version_mismatch"],
			[400, "workspace_skill_source_invalid"],
			[404, "workspace_skill_source_invalid"],
			[409, "workspace_skills_capability_unavailable"],
			[409, "workspace_skill_source_conflict"],
			[409, "workspace_skill_reserved"],
		] as const)
			expect(skillAttemptAfterFailure(saved, new ApiClientError(status, code)).status).toBe(
				"rejected",
			);
		expect(
			skillAttemptAfterFailure(saved, new ApiClientError(503, "workspace_skill_source_unavailable"))
				.status,
		).toBe("prepared");
		for (const error of [
			new ApiClientError(500),
			new ApiClientError(409, "idempotency_key_reused"),
			new ApiClientNetworkError("timeout"),
		])
			expect(skillAttemptAfterFailure(saved, error).status).toBe("uncertain");
	}

	// An unavailable source leaves a sendable record; its next send is uncertain again.
	await store.saveAttempt("account-dep", uncertain, () => true);
	const retryable = skillAttemptAfterFailure(
		uncertain,
		new ApiClientError(503, "workspace_skill_source_unavailable"),
	);
	await store.replaceAttempt("account-dep", uncertain, retryable, () => true);
	expect(await store.readSavedAttempt("account-dep")).toEqual(retryable);
	await store.replaceAttempt("account-dep", retryable, uncertain, () => true);
	expect(await store.readSavedAttempt("account-dep")).toEqual(uncertain);
});
