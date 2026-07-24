import { describe, expect, test } from "bun:test";
import { ApiError, ApiNetworkError } from "@/lib/api-errors";
import {
	fetchHostedProductAccessWithTimeout,
	HOSTED_PRODUCT_ACCESS_TIMEOUT_MS,
	hostedProductAccessRetry,
} from "@/lib/hosted-product-access-request";

describe("fetchHostedProductAccessWithTimeout", () => {
	test("uses the same 20 second application ceiling as the main clients", () => {
		expect(HOSTED_PRODUCT_ACCESS_TIMEOUT_MS).toBe(20_000);
	});

	test("aborts a hanging request and reports a timeout error", async () => {
		let aborted = false;
		const hangingFetch = (_request: Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("expected a request signal"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new DOMException("aborted", "AbortError"));
					},
					{ once: true },
				);
			});

		let thrown: unknown;
		try {
			await fetchHostedProductAccessWithTimeout(
				new Request("https://api.example.test/v1/me"),
				undefined,
				{ fetch: hangingFetch, timeoutMs: 5 },
			);
		} catch (error) {
			thrown = error;
		}

		expect(aborted).toBe(true);
		expect(thrown).toBeInstanceOf(ApiNetworkError);
		if (thrown instanceof ApiNetworkError) expect(thrown.kind).toBe("timeout");
	});
});

describe("hostedProductAccessRetry", () => {
	test("retries transient failures with a bounded budget", () => {
		expect(hostedProductAccessRetry(0, new ApiNetworkError("offline"))).toBe(true);
		expect(hostedProductAccessRetry(1, new ApiError(503, "unavailable"))).toBe(true);
		expect(hostedProductAccessRetry(2, new ApiError(503, "unavailable"))).toBe(false);
	});

	test("allows one fresh-token retry for 401 but not deterministic 4xx", () => {
		expect(hostedProductAccessRetry(0, new ApiError(401, "expired"))).toBe(true);
		expect(hostedProductAccessRetry(1, new ApiError(401, "expired"))).toBe(false);
		expect(hostedProductAccessRetry(0, new ApiError(403, "forbidden"))).toBe(false);
	});
});
