import { afterEach, describe, expect, test } from "bun:test";
import { runSyntheticSmoke } from "../synthetic-smoke";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function startServer(handler: (request: Request) => Response): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return server.url.toString();
}

describe("synthetic smoke", () => {
	test("uses GET only and adds auth only to the read-only API probes", async () => {
		const requests: Array<{ authorization: string | null; method: string; path: string }> = [];
		const baseUrl = startServer((request) => {
			const url = new URL(request.url);
			requests.push({
				authorization: request.headers.get("authorization"),
				method: request.method,
				path: url.pathname,
			});
			return Response.json({ status: "ok" });
		});

		await runSyntheticSmoke({ apiBaseUrl: baseUrl, webBaseUrl: baseUrl, token: "test-token" });

		expect(requests).toEqual([
			{ authorization: null, method: "GET", path: "/health" },
			{ authorization: null, method: "GET", path: "/sign-in" },
			{ authorization: "Bearer test-token", method: "GET", path: "/v1/agents" },
			{ authorization: "Bearer test-token", method: "GET", path: "/v1/projects" },
		]);
	});

	test("omits authenticated probes when the token is absent", async () => {
		const paths: string[] = [];
		const baseUrl = startServer((request) => {
			paths.push(new URL(request.url).pathname);
			return new Response("ok");
		});

		await runSyntheticSmoke({ apiBaseUrl: baseUrl, webBaseUrl: baseUrl });
		expect(paths).toEqual(["/health", "/sign-in"]);
	});

	test("fails on a non-success response without exposing its body", async () => {
		const baseUrl = startServer(() => new Response("internal secret", { status: 503 }));
		expect(runSyntheticSmoke({ apiBaseUrl: baseUrl, webBaseUrl: baseUrl })).rejects.toThrow(
			"API health returned HTTP 503",
		);
	});

	test("rejects non-HTTP and credential-bearing targets", async () => {
		expect(
			runSyntheticSmoke({ apiBaseUrl: "file:///tmp/api", webBaseUrl: "https://example.com" }),
		).rejects.toThrow("apiBaseUrl must use HTTP or HTTPS");
		expect(
			runSyntheticSmoke({
				apiBaseUrl: "https://user:password@example.com",
				webBaseUrl: "https://example.com",
			}),
		).rejects.toThrow("apiBaseUrl must not contain credentials");
	});
});
