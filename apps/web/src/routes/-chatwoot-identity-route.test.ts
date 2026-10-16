import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createChatwootIdentifierHash } from "@/lib/chatwoot-hmac.server";

let userId: string | null = null;
mock.module("@clerk/tanstack-react-start/server", () => ({ auth: async () => ({ userId }) }));

let GET: () => Promise<Response>;
const originalSecret = process.env.CHATWOOT_HMAC_SECRET;

beforeAll(async () => {
	({ GET } = await import("./api/chatwoot/identity"));
});

afterEach(() => {
	userId = null;
	process.env.CHATWOOT_HMAC_SECRET = originalSecret;
});

describe("GET /api/chatwoot/identity", () => {
	test("hashes the authenticated Clerk user and is never cached", async () => {
		userId = "user_123";
		process.env.CHATWOOT_HMAC_SECRET = "secret";
		const response = await GET();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			identifierHash: createChatwootIdentifierHash("user_123", "secret"),
		});
	});

	test("requires a signed-in session", async () => {
		process.env.CHATWOOT_HMAC_SECRET = "secret";
		const response = await GET();
		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	test("is unavailable without the server secret", async () => {
		userId = "user_123";
		delete process.env.CHATWOOT_HMAC_SECRET;
		expect((await GET()).status).toBe(404);
	});
});
