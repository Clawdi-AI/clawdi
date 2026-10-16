import { expect, test } from "bun:test";
import { ApiClientError, ApiClientResponseError } from "./read-transport";
import { createSupportChatClient } from "./support-chat-client";

function client(response: Response) {
	const requests: Request[] = [];
	return {
		requests,
		client: createSupportChatClient({
			baseUrl: "https://cloud.example.test/",
			getToken: async () => "session-token",
			fetch: async (request) => {
				requests.push(request);
				return response;
			},
		}),
	};
}

test("reads the identity hash from Web with the session token", async () => {
	const { client: support, requests } = client(Response.json({ identifierHash: "abc123" }));
	expect(await support.getIdentifierHash()).toBe("abc123");
	expect(requests.map((request) => request.url)).toEqual([
		"https://cloud.example.test/api/chatwoot/identity",
	]);
	expect(requests[0]?.headers.get("Authorization")).toBe("Bearer session-token");
});

test("rejects missing live chat configuration and malformed bodies", async () => {
	await expect(
		client(new Response(null, { status: 404 })).client.getIdentifierHash(),
	).rejects.toBeInstanceOf(ApiClientError);
	await expect(client(Response.json({})).client.getIdentifierHash()).rejects.toBeInstanceOf(
		ApiClientResponseError,
	);
});
