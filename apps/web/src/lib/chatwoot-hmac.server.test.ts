import { describe, expect, test } from "bun:test";
import { createChatwootIdentifierHash } from "@/lib/chatwoot-hmac.server";

describe("createChatwootIdentifierHash", () => {
	test("creates the Chatwoot HMAC-SHA256 identifier hash", () => {
		expect(createChatwootIdentifierHash("user_123", "test-secret")).toBe(
			"ff93a3aa19dad74ff6356238e8d650d0aea3602bb8863fef184a4b50f0fc2641",
		);
	});

	test("returns null when the request has no authenticated Clerk user or configured secret", () => {
		expect(createChatwootIdentifierHash(null, "test-secret")).toBeNull();
		expect(createChatwootIdentifierHash("user_123", undefined)).toBeNull();
	});
});
