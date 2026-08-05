import { describe, expect, test } from "bun:test";
import { GET, sanitizeFilesReturnPath } from "./files-authorize-route";

const CALLBACK =
	"https://cloud.clawdi.ai/api/files/authorize?deployment_id=42&return_to=%2Ffiles%3Fview%3Dgrid";

function dependencies(
	overrides: {
		token?: string | null;
		response?: Response;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
	} = {},
) {
	return {
		getToken: async () => ("token" in overrides ? (overrides.token ?? null) : "session-token"),
		fetch:
			overrides.fetch ??
			(async () =>
				overrides.response ??
				new Response(
					JSON.stringify({
						resource: { id: "42" },
						files_endpoint: { url: "https://agent-9120.node.clawdi.ai/" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)),
		deployApiUrl: "https://api.clawdi.ai",
	};
}

describe("Files owner authorize callback", () => {
	test("uses the hosted ForwardAuth root-relative callback contract when signed out", async () => {
		let fetched = false;
		const response = await GET(
			new Request(CALLBACK),
			dependencies({
				token: null,
				fetch: async () => {
					fetched = true;
					return new Response(null, { status: 500 });
				},
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"/sign-in?redirect_url=%2Fapi%2Ffiles%2Fauthorize%3Fdeployment_id%3D42%26return_to%3D%252Ffiles%253Fview%253Dgrid",
		);
		expect(response.headers.get("cache-control")).toBe("no-store, private");
		expect(fetched).toBe(false);
	});

	test("rechecks ownership and returns only to the current exact Files origin", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const response = await GET(
			new Request(CALLBACK),
			dependencies({
				fetch: async (url, init) => {
					requests.push({ url, init });
					return new Response(
						JSON.stringify({
							resource: { id: "42" },
							files_endpoint: { url: "https://agent-9120.node.clawdi.ai/" },
						}),
						{ status: 200 },
					);
				},
			}),
		);

		const ownerRequest = requests[0];
		expect(ownerRequest?.url).toBe("https://api.clawdi.ai/v2/deployments/42");
		expect(new Headers(ownerRequest?.init.headers).get("authorization")).toBe(
			"Bearer session-token",
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://agent-9120.node.clawdi.ai/files?view=grid",
		);
	});

	test("fails closed for mismatched deployments and malformed endpoint origins", async () => {
		for (const payload of [
			{ resource: { id: "41" }, files_endpoint: { url: "https://agent.example/" } },
			{ resource: { id: "42" }, files_endpoint: { url: "http://agent.example/" } },
			{ resource: { id: "42" }, files_endpoint: { url: "https://agent.example/path" } },
			{ resource: { id: "42" }, files_endpoint: null },
		]) {
			const response = await GET(
				new Request(CALLBACK),
				dependencies({ response: Response.json(payload) }),
			);
			expect(response.status).toBe(403);
			expect(response.headers.get("location")).toBeNull();
		}
	});

	test("rejects unsafe return paths before authentication", async () => {
		for (const value of [
			"//attacker.example",
			"https://attacker.example",
			"/ok#fragment",
			"/bad\\path",
		]) {
			expect(sanitizeFilesReturnPath(value)).toBeNull();
		}
		const response = await GET(
			new Request(
				"https://cloud.clawdi.ai/api/files/authorize?deployment_id=42&return_to=%2Fok%23bad",
			),
			dependencies(),
		);
		expect(response.status).toBe(400);
	});

	test("sanitizes owner API failures without exposing upstream details", async () => {
		for (const [status, expected] of [
			[403, 403],
			[404, 404],
			[500, 503],
		] as const) {
			const response = await GET(
				new Request(CALLBACK),
				dependencies({ response: new Response("private detail", { status }) }),
			);
			expect(response.status).toBe(expected);
			expect(await response.text()).not.toContain("private detail");
		}
	});
});
