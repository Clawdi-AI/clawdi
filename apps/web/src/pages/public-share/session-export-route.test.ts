import { describe, expect, test } from "bun:test";
import { GET, publicSessionExportErrorMessage } from "./session-export-route";

const VALID_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST = new Request(`http://localhost/s/${VALID_SESSION_ID}.md`);

async function withFetchResponse(response: Response, run: () => Promise<void>): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(async () => response, {
		preconnect: originalFetch.preconnect,
	});

	try {
		await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("public session export errors", () => {
	test("maps known public access statuses without leaking backend details", () => {
		expect(publicSessionExportErrorMessage(401)).toBe("Authentication required.");
		expect(publicSessionExportErrorMessage(403)).toBe(
			"You do not have access to this shared session.",
		);
		expect(publicSessionExportErrorMessage(404)).toBe("Not found");
		expect(publicSessionExportErrorMessage(410)).toBe("This shared session link has expired.");
	});

	test("uses generic copy for internal and unknown errors", () => {
		expect(publicSessionExportErrorMessage(500)).toBe(
			"The service is having trouble right now. Please try again in a moment.",
		);
		expect(publicSessionExportErrorMessage(418)).toBe("Unable to export this shared session.");
	});
});

describe("public session export response headers", () => {
	test("prevents caching local validation errors", async () => {
		for (const params of [
			{ id: VALID_SESSION_ID, format: "txt" },
			{ id: "not-a-uuid", format: "md" },
		]) {
			const response = await GET(REQUEST, params);

			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.text()).toBe("Not found");
		}
	});

	test("prevents caching sanitized upstream errors", async () => {
		await withFetchResponse(
			new Response("sensitive upstream detail", { status: 503 }),
			async () => {
				const response = await GET(REQUEST, { id: VALID_SESSION_ID, format: "md" });

				expect(response.status).toBe(503);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
				expect(await response.text()).toBe(
					"The service is having trouble right now. Please try again in a moment.",
				);
			},
		);
	});

	test("prevents caching successful exports", async () => {
		await withFetchResponse(new Response("# Shared session", { status: 200 }), async () => {
			const response = await GET(REQUEST, { id: VALID_SESSION_ID, format: "md" });

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
			expect(await response.text()).toBe("# Shared session");
		});
	});
});
