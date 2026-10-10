import { expect, test } from "bun:test";
import { ApiClientError, parseWorkspaceSkillGitHubInput } from "@clawdi/shared/api";
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
	const conflict = new ApiClientError(412, "resource_version_mismatch");
	expect(skillAttemptAfterFailure(prepared, conflict).status).toBe("rejected");
	expect(skillAttemptAfterFailure(sending, conflict).status).toBe("uncertain");
	expect(
		skillAttemptAfterFailure(prepared, new ApiClientError(409, "idempotency_key_reused")).status,
	).toBe("uncertain");
	expect(
		skillAttemptAfterFailure(prepared, new ApiClientError(400, "workspace_skill_source_invalid"))
			.status,
	).toBe("rejected");
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
