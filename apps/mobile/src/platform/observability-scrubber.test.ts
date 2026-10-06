import { describe, expect, test } from "bun:test";
import type { Event } from "@sentry/react-native";
import { scrubMobileBreadcrumb, scrubMobileEvent } from "./observability-scrubber";

describe("mobile crash-report privacy", () => {
	test("drops vault-request events, transactions and navigation breadcrumbs", () => {
		expect(scrubMobileEvent({ message: "Failed" }, "/vault-request")).toBeNull();
		expect(
			scrubMobileEvent({ request: { url: "clawdi://vault-request?token=private" } }, "/agents"),
		).toBeNull();
		expect(scrubMobileEvent({ type: "transaction", transaction: "/vault-request" }, "")).toBeNull();
		expect(
			scrubMobileBreadcrumb({ data: { from: "/vault-request", to: "/agents" } }, "/agents"),
		).toBeNull();
	});
	test("removes bodies, identity, credentials and queries from error and performance payloads", () => {
		const event: Event = {
			message: "Request failed: https://user:pass@api.example.test/v1/me?token=private#private",
			request: {
				url: "https://api.example.test/v1/me?clawdi_attempt=private&token=private",
				data: { password: "private" },
				query_string: "token=private",
				headers: { Authorization: "Bearer private" },
			},
			user: { id: "private", email: "private@example.test" },
			extra: { nested: { accessToken: "private", body: "private", status: 500 } },
			exception: { values: [{ value: "GET /v1/me?token=private" }] },
			spans: [
				{
					span_id: "123",
					trace_id: "456",
					start_timestamp: 0,
					data: { "http.method": "GET", url: "/v1/me?token=private", body: "private" },
					description: "GET /v1/me?token=private",
				},
			],
		};
		const scrubbed = scrubMobileEvent(event, "/agents");
		expect(scrubbed?.request).toEqual({ url: "https://api.example.test/v1/me" });
		expect(scrubbed?.message).toBe("Request failed: https://api.example.test/v1/me");
		expect(scrubbed?.extra).toEqual({ nested: { status: 500 } });
		expect(scrubbed?.exception?.values?.[0]?.value).toBe("GET /v1/me");
		expect(scrubbed?.spans?.[0]?.description).toBe("GET /v1/me");
		expect(scrubbed?.spans?.[0]?.data).toEqual({ "http.method": "GET", url: "/v1/me" });
		expect(JSON.stringify(scrubbed)).not.toContain("private");
		expect(event.request?.data).toEqual({ password: "private" });
	});
	test("scrubs HTTP and deep-link breadcrumbs without losing safe metadata", () => {
		expect(
			scrubMobileBreadcrumb(
				{
					category: "navigation",
					data: {
						to: "clawdi://sign-in-oauth?clawdi_attempt=private&token=private",
						from: "/share/private?token=private",
						body: "private",
						status_code: 200,
					},
				},
				"/agents",
			),
		).toEqual({
			category: "navigation",
			data: {
				to: "clawdi://sign-in-oauth",
				from: "/share/[Filtered]",
				status_code: 200,
			},
		});
	});
});
