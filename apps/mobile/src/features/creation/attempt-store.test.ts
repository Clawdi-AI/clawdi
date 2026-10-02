import { expect, test } from "bun:test";
import { validateAndBuildHostedDeployRequest } from "@clawdi/shared/api";
import { createAttemptStore } from "./attempt-store";
import type { CreationAttempt } from "./state";

function fixture() {
	const draft = {
		runtime: "hermes",
		computePlanSlug: "compute_basic",
		agentName: "Agent",
		language: "en",
		timezone: "",
		ai: { mode: "unmanaged" },
	} as const;
	const result = validateAndBuildHostedDeployRequest(draft);
	if (!result.ok) throw new Error("Invalid fixture");
	const id = "8e244ab3-1111-4111-8111-111111111111";
	const attempt: CreationAttempt = {
		version: 1,
		submission: "prepared",
		id,
		draft,
		request: { ...result.request, deploy_request_id: id },
	};
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
	return { attempt, values, store, journal: createAttemptStore(store) };
}

test("stale prepared screen cannot discard a durable in-flight marker", async () => {
	const { attempt, journal } = fixture();
	await journal.saveAttempt("account", attempt, () => true);
	const inFlight: CreationAttempt = { ...attempt, submission: "uncertain" };
	await journal.replaceAttempt("account", attempt, inFlight, () => true);
	await expect(journal.clearAttempt("account", attempt, () => true)).rejects.toThrow(
		"Saved request changed",
	);
	expect(await journal.readSavedAttempt("account")).toEqual(inFlight);
});

test("proven rejection survives restart and can be explicitly discarded", async () => {
	const { attempt, journal, store } = fixture();
	await journal.saveAttempt("account", attempt, () => true);
	const inFlight: CreationAttempt = { ...attempt, submission: "uncertain" };
	await journal.replaceAttempt("account", attempt, inFlight, () => true);
	const rejected: CreationAttempt = { ...attempt, submission: "entitlement_rejected" };
	await journal.replaceAttempt("account", inFlight, rejected, () => true);
	const restarted = createAttemptStore(store);
	expect(await restarted.readSavedAttempt("account")).toEqual(rejected);
	await restarted.clearAttempt("account", rejected, () => true);
	expect(await restarted.readSavedAttempt("account")).toBeNull();
});

test("write failure and owner changes cannot erase the original draft", async () => {
	const { attempt, journal, values, store } = fixture();
	await journal.saveAttempt("account", attempt, () => true);
	await expect(journal.clearAttempt("account", attempt, () => false)).rejects.toThrow(
		"Creation owner changed",
	);
	const failing = createAttemptStore({
		...store,
		setItemAsync: async () => {
			throw new Error("Write failed");
		},
	});
	await expect(
		failing.replaceAttempt("account", attempt, { ...attempt, submission: "uncertain" }, () => true),
	).rejects.toThrow("Write failed");
	expect(values.has("account")).toBe(true);
	expect(await journal.readSavedAttempt("account")).toEqual(attempt);
});
