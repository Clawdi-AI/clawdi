import { describe, expect, test } from "bun:test";
import { API_ERROR_COPY, apiErrorCopy, isAccountSuspendedFailure } from "./api-error-copy";

describe("apiErrorCopy", () => {
	test("reads a suspended account on 401 and 403 without exposing its detail", () => {
		for (const status of [401, 403]) {
			const failure = {
				kind: "response",
				status,
				code: "account_suspended",
				detail: "internal suspension detail",
			} as const;
			expect(isAccountSuspendedFailure(failure)).toBe(true);
			expect(apiErrorCopy(failure)).toBe(API_ERROR_COPY.suspended);
		}
		expect(
			isAccountSuspendedFailure({ kind: "response", status: 409, code: "account_suspended" }),
		).toBe(false);
	});

	test("a plain 401 asks to sign in again", () => {
		expect(apiErrorCopy({ kind: "response", status: 401, detail: "jwt expired" })).toBe(
			API_ERROR_COPY.expired,
		);
	});

	test("5xx and 429 hide the server detail", () => {
		for (const status of [500, 503, 429])
			expect(apiErrorCopy({ kind: "response", status, detail: "upstream connect error" })).toBe(
				API_ERROR_COPY.serviceError,
			);
	});

	test("network failures get connection guidance", () => {
		expect(apiErrorCopy({ kind: "timeout" })).toBe(API_ERROR_COPY.timeout);
		expect(apiErrorCopy({ kind: "offline" })).toBe(API_ERROR_COPY.offline);
	});

	test("user-facing server sentences pass through; internal codes and blanks do not", () => {
		expect(
			apiErrorCopy({ kind: "response", status: 409, detail: "That name is already in use." }),
		).toBe("That name is already in use.");
		for (const detail of ["provider_not_found", "", null, undefined])
			expect(apiErrorCopy({ kind: "response", status: 400, detail })).toBe(
				API_ERROR_COPY.requestError,
			);
	});

	test("anything else gets the generic fallback", () => {
		expect(apiErrorCopy({ kind: "error" })).toBe(API_ERROR_COPY.genericError);
		expect(apiErrorCopy({ kind: "unknown" })).toBe(API_ERROR_COPY.genericError);
	});
});
