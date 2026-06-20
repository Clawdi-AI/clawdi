import { describe, expect, test } from "bun:test";
import {
	ApiError,
	ApiNetworkError,
	formatApiError,
	isApiAuthError,
	isApiNetworkError,
	isApiServerError,
	normalizeApiError,
	parseApiDetail,
} from "./api-errors";

describe("API error details", () => {
	test("parses nested FastAPI details", () => {
		const detail = parseApiDetail(
			JSON.stringify({
				detail: {
					code: "vault_conflicts_blocked",
					message: "Source project has 1 vault key that already exists.",
					conflicts: [{ vault_slug: "prod", section: "api", item_name: "TOKEN" }],
				},
			}),
		);

		expect(detail).toEqual({
			code: "vault_conflicts_blocked",
			message: "Source project has 1 vault key that already exists.",
			conflicts: [{ vault_slug: "prod", section: "api", item_name: "TOKEN" }],
		});
	});

	test("formats structured API errors without exposing raw JSON", () => {
		const message = formatApiError(
			JSON.stringify({
				detail: {
					error: "already_member",
					message: "Already a member.",
				},
			}),
		);

		expect(message).toBe("Already a member.");
	});

	test("keeps plain text API errors readable", () => {
		expect(formatApiError("project not found")).toBe("project not found");
	});
});

describe("cloud-api error classification", () => {
	test("401 is an auth error, not server", () => {
		const e = new ApiError(401, "token expired");
		expect(isApiAuthError(e)).toBe(true);
		expect(isApiServerError(e)).toBe(false);
		expect(isApiNetworkError(e)).toBe(false);
	});

	test("5xx and 429 are server errors", () => {
		for (const status of [500, 502, 503, 429]) {
			expect(isApiServerError(new ApiError(status, "boom"))).toBe(true);
		}
	});

	test("network errors classify as transport failures", () => {
		for (const kind of ["timeout", "offline"] as const) {
			const e = new ApiNetworkError(kind);
			expect(isApiNetworkError(e)).toBe(true);
			expect(isApiAuthError(e)).toBe(false);
			expect(isApiServerError(e)).toBe(false);
		}
	});

	test("non-api errors classify as nothing", () => {
		const e = new Error("random");
		expect(isApiAuthError(e)).toBe(false);
		expect(isApiServerError(e)).toBe(false);
		expect(isApiNetworkError(e)).toBe(false);
	});
});

describe("normalizeApiError", () => {
	test("timeout → try-again guidance", () => {
		expect(normalizeApiError(new ApiNetworkError("timeout"))).toMatch(/taking longer than usual/i);
	});

	test("offline → connection guidance", () => {
		expect(normalizeApiError(new ApiNetworkError("offline"))).toMatch(
			/couldn't reach the service/i,
		);
	});

	test("401 → session expired prompt", () => {
		expect(normalizeApiError(new ApiError(401, "jwt expired"))).toMatch(/session has expired/i);
	});

	test("5xx → transient message, not the raw detail", () => {
		const msg = normalizeApiError(new ApiError(503, "upstream connect error"));
		expect(msg).toMatch(/having trouble/i);
		expect(msg).not.toMatch(/upstream connect error/);
	});

	test("snake_case codes become readable, real sentences pass through", () => {
		expect(normalizeApiError(new ApiError(400, "provider_not_found"))).toBe("Provider Not Found");
		expect(normalizeApiError(new ApiError(409, "That name is already in use."))).toBe(
			"That name is already in use.",
		);
	});

	test("nested FastAPI detail is unwrapped to its message", () => {
		const detail = JSON.stringify({
			detail: { error: "already_member", message: "Already a member." },
		});
		expect(normalizeApiError(new ApiError(403, detail))).toBe("Already a member.");
	});

	test("unknown shapes get a safe fallback", () => {
		expect(normalizeApiError(null)).toMatch(/something went wrong/i);
	});
});
