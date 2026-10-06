import { expect, test } from "bun:test";
import {
	createRuntimeAttemptStore,
	parseRuntimeAttempt,
	type RuntimeAttempt,
} from "@/platform/runtime-attempt";

const attempt: RuntimeAttempt = {
	format: 1,
	deploymentId: "agent",
	key: "request-key",
	version: "original-version",
	mutation: {
		action: "update",
		body: {
			provider_ids: ["removed-provider"],
			primary_model: { provider_id: "removed-provider", model: "removed-model" },
		},
	},
	status: "prepared",
};

function fixture() {
	const values = new Map<string, string>();
	const storage = {
		getItemAsync: async (key: string) => values.get(key) ?? null,
		setItemAsync: async (key: string, value: string) => {
			values.set(key, value);
		},
		deleteItemAsync: async (key: string) => {
			values.delete(key);
		},
	};
	return { values, storage, journal: createRuntimeAttemptStore(storage) };
}

test("delete recovery keeps the original subscription choice even without a deployment snapshot", async () => {
	const { journal, storage } = fixture();
	const deletion: RuntimeAttempt = {
		...attempt,
		mutation: { action: "delete", body: { subscription_choice: "keep_subscription" } },
		status: "uncertain",
	};
	await journal.saveAttempt("account-agent", deletion, () => true);
	expect(await createRuntimeAttemptStore(storage).readSavedAttempt("account-agent")).toEqual(
		deletion,
	);
	expect(
		parseRuntimeAttempt(
			JSON.stringify({
				...deletion,
				mutation: { action: "delete", body: { subscription_choice: "cancel_subscription" } },
			}),
		),
	).toBeNull();
});

test("restart preserves exact uncertain intent without consulting the live model catalog", async () => {
	const { journal, storage } = fixture();
	await journal.saveAttempt("account-agent", attempt, () => true);
	const pending: RuntimeAttempt = { ...attempt, status: "uncertain" };
	await journal.replaceAttempt("account-agent", attempt, pending, () => true);
	const rebooted = createRuntimeAttemptStore(storage);
	expect(await rebooted.readSavedAttempt("account-agent")).toEqual(pending);
	await expect(journal.clearAttempt("account-agent", attempt, () => true)).rejects.toThrow(
		"Saved request changed",
	);
	await expect(
		journal.replaceAttempt(
			"account-agent",
			pending,
			{ ...pending, version: "new-version" },
			() => true,
		),
	).rejects.toThrow("Request payload changed");
	await rebooted.clearAttempt("account-agent", pending, () => true);
	expect(await rebooted.readSavedAttempt("account-agent")).toBeNull();
});

test("competing screens cannot replace a request or erase another account's journal", async () => {
	const { journal } = fixture();
	const results = await Promise.allSettled([
		journal.saveAttempt("account-agent", attempt, () => true),
		journal.saveAttempt("account-agent", { ...attempt, key: "other-key" }, () => true),
	]);
	expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
	await expect(journal.clearAttempt("account-agent", attempt, () => false)).rejects.toThrow(
		"Runtime owner changed",
	);
	expect(await journal.readSavedAttempt("other-account-agent")).toBeNull();
	expect(await journal.readSavedAttempt("account-agent")).toEqual(attempt);
});

test("corrupt journals and unsupported requests fail closed; write failures preserve intent", async () => {
	for (const mutation of [
		{ action: "delete" },
		{ action: "stop", body: {} },
		{ action: "update", body: { language: "invalid" } },
		{ action: "update", body: { provider_ids: [1] } },
		{ action: "update", body: { primary_model: { provider_id: "p", model: "m", extra: true } } },
	])
		expect(parseRuntimeAttempt(JSON.stringify({ ...attempt, mutation }))).toBeNull();
	const { values, storage, journal } = fixture();
	await journal.saveAttempt("key", attempt, () => true);
	const failing = createRuntimeAttemptStore({
		...storage,
		setItemAsync: async () => {
			throw new Error("Storage unavailable");
		},
	});
	await expect(
		failing.replaceAttempt("key", attempt, { ...attempt, status: "uncertain" }, () => true),
	).rejects.toThrow("Storage unavailable");
	expect(await journal.readSavedAttempt("key")).toEqual(attempt);
	values.set("key", "invalid JSON");
	await expect(journal.readSavedAttempt("key")).rejects.toThrow("Invalid saved attempt");
	values.set("key", "");
	await expect(journal.readSavedAttempt("key")).rejects.toThrow("Invalid saved attempt");
});
