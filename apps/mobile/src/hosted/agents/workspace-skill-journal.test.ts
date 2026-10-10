import { expect, test } from "bun:test";
import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";
import {
	createWorkspaceSkillJournal,
	newSkillAttempt,
} from "@/hosted/agents/workspace-skill-journal";
import { createSkillAttemptStore, type SkillAttempt } from "@/platform/skill-attempt";

const KEY = "clawdi.workspace-skills.v1.test";

function harness() {
	const memory = new Map<string, string>();
	let gate: Promise<void> | null = null;
	const store = createSkillAttemptStore({
		getItemAsync: async (key) => {
			const value = memory.get(key) ?? null;
			await gate;
			return value;
		},
		setItemAsync: async (key, value) => {
			memory.set(key, value);
		},
		deleteItemAsync: async (key) => {
			memory.delete(key);
		},
	});
	const sent: { version: string; key: string; journaled: SkillAttempt | null }[] = [];
	const reported: (SkillAttempt | null)[] = [];
	let failure: unknown = null;
	const journal = createWorkspaceSkillJournal(store);
	const options = (fresh: boolean) => ({
		key: KEY,
		fresh,
		owns: () => true,
		visible: () => true,
		onJournal: (attempt: SkillAttempt | null) => reported.push(attempt),
		apply: async (attempt: SkillAttempt) => {
			sent.push({
				version: attempt.version,
				key: attempt.key,
				journaled: await store.readSavedAttempt(KEY),
			});
			if (failure) throw failure;
		},
	});
	return {
		store,
		journal,
		sent,
		reported,
		options,
		fail: (error: unknown) => {
			failure = error;
		},
		hold: () => {
			let release: (() => void) | undefined;
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = null;
				release?.();
			};
		},
	};
}

const uninstall = (version = "rv-7") =>
	newSkillAttempt(
		"deployment-1",
		version,
		{ action: "uninstall", skillKey: "brand-guidelines" },
		"idempotency-1",
	);

test("one confirmed change sends one request with the current version and the journaled key", async () => {
	const h = harness();
	expect(await h.journal.send(uninstall(), h.options(true))).toBe("accepted");
	expect(h.sent).toEqual([
		{
			version: "rv-7",
			key: "idempotency-1",
			journaled: { ...uninstall(), status: "uncertain" },
		},
	]);
	expect(await h.store.readSavedAttempt(KEY)).toBeNull();
	expect(h.reported.at(-1)).toBeNull();
});

test("a network error keeps an uncertain journal that Retry resends with the same key and Discard clears", async () => {
	const h = harness();
	h.fail(new ApiClientNetworkError("offline"));
	await expect(h.journal.send(uninstall(), h.options(true))).rejects.toThrow(ApiClientNetworkError);
	const { attempt: saved } = await h.journal.read(KEY, "deployment-1");
	expect(saved).toEqual({ ...uninstall(), status: "uncertain" });
	if (!saved) throw new Error("Missing uncertain journal");

	// Retry replays the saved attempt, so the server can recognize the same idempotency key.
	h.fail(null);
	expect(await h.journal.send(saved, h.options(false))).toBe("accepted");
	expect(h.sent.map(({ version, key }) => ({ version, key }))).toEqual([
		{ version: "rv-7", key: "idempotency-1" },
		{ version: "rv-7", key: "idempotency-1" },
	]);
	expect(await h.store.readSavedAttempt(KEY)).toBeNull();

	// Discard instead removes an uncertain journal from this device.
	const other = harness();
	other.fail(new ApiClientNetworkError("timeout"));
	await expect(other.journal.send(uninstall(), other.options(true))).rejects.toThrow();
	const { attempt: pending } = await other.journal.read(KEY, "deployment-1");
	if (!pending) throw new Error("Missing uncertain journal");
	await other.journal.discard(KEY, pending, () => true);
	expect(await other.store.readSavedAttempt(KEY)).toBeNull();
	expect(other.sent).toHaveLength(1);
});

test("a definitive rejection settles the journal instead of leaving it uncertain", async () => {
	const h = harness();
	h.fail(new ApiClientError(412, "resource_version_mismatch"));
	expect(await h.journal.send(uninstall(), h.options(true))).toBe("settled");
	expect((await h.store.readSavedAttempt(KEY))?.status).toBe("rejected");
});

test("a journal read that overlaps a change is stale, so it can't resurrect a cleared attempt", async () => {
	const h = harness();
	h.fail(new ApiClientNetworkError("offline"));
	await expect(h.journal.send(uninstall(), h.options(true))).rejects.toThrow();
	const saved = (await h.journal.read(KEY, "deployment-1")).attempt;
	if (!saved) throw new Error("Missing uncertain journal");

	// A focus reread starts while the uncertain attempt is still saved…
	const release = h.hold();
	const reread = h.journal.read(KEY, "deployment-1");
	// …and Retry then clears it before the read finishes.
	h.fail(null);
	const retry = h.journal.send(saved, h.options(false));
	release();
	expect(await retry).toBe("accepted");
	const result = await reread;
	expect(result.attempt?.status).toBe("uncertain");
	expect(result.stale).toBe(true);
	expect(await h.journal.read(KEY, "deployment-1")).toEqual({ attempt: null, stale: false });
});
