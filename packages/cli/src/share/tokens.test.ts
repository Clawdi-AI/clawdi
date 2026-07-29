import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	addToken,
	findToken,
	listTokens,
	readTokenStore,
	removeToken,
	type ShareToken,
} from "./tokens";

const ORIG_HOME = process.env.HOME;
let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "clawdi-tokens-"));
	mkdirSync(join(tempHome, ".clawdi"), { recursive: true });
	process.env.HOME = tempHome;
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
	process.env.HOME = ORIG_HOME;
});

const sample: ShareToken = {
	project_id: "abc-123",
	project_name: "Team Toolkit",
	owner_display: "Alice",
	owner_handle: "alice-a3b4",
	token: "x".repeat(43),
	redeemed_at: new Date().toISOString(),
};

describe("share-tokens.json", () => {
	it("returns empty list when file absent", () => {
		expect(listTokens()).toEqual([]);
	});

	it("addToken then listTokens round-trips", () => {
		addToken(sample);
		expect(listTokens()).toEqual([sample]);
	});

	it("addToken upserts on project_id", () => {
		addToken(sample);
		addToken({ ...sample, owner_handle: "alice-9999" });
		const all = listTokens();
		expect(all).toHaveLength(1);
		expect(all[0].owner_handle).toBe("alice-9999");
	});

	it("removeToken by project_id", () => {
		addToken(sample);
		addToken({ ...sample, project_id: "def-456" });
		removeToken("abc-123");
		const all = listTokens();
		expect(all).toHaveLength(1);
		expect(all[0].project_id).toBe("def-456");
	});

	it("findToken by project_id", () => {
		addToken(sample);
		expect(findToken("abc-123")?.token).toBe(sample.token);
		expect(findToken("ghost")).toBeUndefined();
	});

	it("writes file with 0600 perms", () => {
		addToken(sample);
		const stat = statSync(join(tempHome, ".clawdi", "share-tokens.json"));
		// 0o600 = mode bits 110_000_000; mask off file-type bits.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("survives empty / malformed file", () => {
		const path = join(tempHome, ".clawdi", "share-tokens.json");
		writeFileSync(path, "not-json", "utf-8");
		expect(listTokens()).toEqual([]);
	});

	it("round-trips upgraded_at + last_seen_skill_keys", () => {
		addToken({
			...sample,
			upgraded_at: "2026-05-12T10:00:00Z",
			last_seen_skill_keys: ["git-tools", "k8s-helpers"],
		});
		const [restored] = listTokens();
		expect(restored.upgraded_at).toBe("2026-05-12T10:00:00Z");
		expect(restored.last_seen_skill_keys).toEqual(["git-tools", "k8s-helpers"]);
	});

	it("normalizes released version:1 scope fields without dropping unknown fields", () => {
		const path = join(tempHome, ".clawdi", "share-tokens.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				tokens: [
					{
						scope_id: "legacy-project",
						scope_name: "Legacy Toolkit",
						owner_display: "Alice",
						owner_handle: "alice-a3b4",
						token: "l".repeat(43),
						redeemed_at: "2026-05-12T10:00:00Z",
						future_field: { enabled: true },
					},
				],
			}),
			"utf-8",
		);

		const [restored] = listTokens();
		expect(restored.project_id).toBe("legacy-project");
		expect(restored.project_name).toBe("Legacy Toolkit");
		addToken({ ...restored, upgraded_at: "2026-05-12T11:00:00Z" });

		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			tokens: Array<Record<string, unknown>>;
		};
		expect(raw.tokens[0].project_id).toBe("legacy-project");
		expect(raw.tokens[0].project_name).toBe("Legacy Toolkit");
		expect(raw.tokens[0].future_field).toEqual({ enabled: true });
	});

	it("skips malformed records at runtime but preserves them during unrelated writes", () => {
		const path = join(tempHome, ".clawdi", "share-tokens.json");
		const malformed = {
			project_id: "broken-project",
			project_name: "Broken Toolkit",
			owner_display: "Alice",
			owner_handle: "alice-a3b4",
			token: "undefined",
			redeemed_at: "2026-05-12T10:00:00Z",
			future_field: "keep-me",
		};
		writeFileSync(path, JSON.stringify({ version: 1, tokens: [malformed, sample] }), "utf-8");

		const store = readTokenStore();
		expect(store.tokens).toEqual([sample]);
		expect(store.issues).toEqual([
			{
				label: "Broken Toolkit",
				reason: "invalid 43-character share token",
			},
		]);

		addToken({ ...sample, owner_handle: "alice-updated" });
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			tokens: Array<Record<string, unknown>>;
		};
		expect(raw.tokens).toHaveLength(2);
		expect(raw.tokens[0]).toEqual(malformed);
		expect(raw.tokens[1].owner_handle).toBe("alice-updated");
	});

	it("preserves unknown future fields across read+write", () => {
		const path = join(tempHome, ".clawdi", "share-tokens.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				tokens: [{ ...sample, future_field: "x" }],
			}),
			"utf-8",
		);
		const [t] = listTokens();
		addToken({ ...t, redeemed_at: "2026-05-12T11:00:00Z" });
		const raw = readFileSync(path, "utf-8");
		expect(raw).toContain('"future_field"');
		expect(raw).toContain('"x"');
	});
});
