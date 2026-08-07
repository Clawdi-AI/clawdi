import { describe, expect, test } from "bun:test";
import type { ApiKey } from "@/lib/api-schemas";
import { activeApiKeys, removeApiKeyFromList, restoreApiKeyToList } from "./api-keys-panel.logic";

function apiKey(id: string, overrides: Partial<ApiKey> = {}): ApiKey {
	return {
		id,
		label: `Key ${id}`,
		key_prefix: `clawdi_${id}`,
		created_at: "2026-07-28T12:00:00.000Z",
		last_used_at: null,
		expires_at: null,
		revoked_at: null,
		...overrides,
	};
}

describe("activeApiKeys", () => {
	test("defensively excludes revoked rows returned by an older backend", () => {
		const active = apiKey("active");
		const revoked = apiKey("revoked", { revoked_at: "2026-07-28T13:00:00.000Z" });

		expect(activeApiKeys([revoked, active])).toEqual([active]);
		expect(activeApiKeys(undefined)).toEqual([]);
	});
});

describe("optimistic API key revocation", () => {
	test("removes the selected row immediately", () => {
		const first = apiKey("first");
		const second = apiKey("second");

		expect(removeApiKeyFromList([first, second], first.id)).toEqual([second]);
	});

	test("rolls back only the failed removal when revokes overlap", () => {
		const older = apiKey("older", { created_at: "2026-07-27T12:00:00.000Z" });
		const newer = apiKey("newer", { created_at: "2026-07-28T12:00:00.000Z" });
		const afterFirstRevoke = removeApiKeyFromList([newer, older], newer.id);
		const afterSecondRevoke = removeApiKeyFromList(afterFirstRevoke, older.id);

		// The newer revoke failed while the older revoke succeeded.
		expect(restoreApiKeyToList(afterSecondRevoke, newer)).toEqual([newer]);
	});

	test("restores newest-first ordering without duplicating an existing row", () => {
		const older = apiKey("older", { created_at: "2026-07-27T12:00:00.000Z" });
		const newer = apiKey("newer", { created_at: "2026-07-28T12:00:00.000Z" });

		expect(restoreApiKeyToList([older], newer)).toEqual([newer, older]);
		expect(restoreApiKeyToList([newer, older], newer)).toEqual([newer, older]);
	});
});
