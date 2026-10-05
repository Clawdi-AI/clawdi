import { expect, test } from "bun:test";
import { ApiClientError } from "./read-transport";
import { createSessionSharingClient } from "./session-sharing-client";

test("Session deletion uses the authenticated canonical route and accepts its empty 204", async () => {
	const calls: Request[] = [];
	const client = createSessionSharingClient({
		baseUrl: "https://cloud.example.test",
		getToken: async () => "owner-token",
		fetch: async (request) => {
			calls.push(new Request(request));
			return new Response(null, { status: 204 });
		},
	});
	await expect(client.deleteSession("session-a")).resolves.toBeNull();
	expect(calls[0]?.url).toBe("https://cloud.example.test/v1/sessions/session-a");
	expect(calls[0]?.method).toBe("DELETE");
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer owner-token");
	await expect(client.deleteSession(" ")).rejects.toThrow();
	expect(calls).toHaveLength(1);
});
test("Session deletion preserves rejection and snapshots retain exact message ranges", async () => {
	const rejected = createSessionSharingClient({
		baseUrl: "https://cloud.example.test",
		getToken: async () => "owner-token",
		fetch: async () => Response.json({ detail: "Forbidden" }, { status: 403 }),
	});
	await expect(rejected.deleteSession("session-a")).rejects.toBeInstanceOf(ApiClientError);
	const shares = {
		shares: [
			{
				id: "share-a",
				session_id: "session-a",
				scope: "response",
				start_position: 7,
				end_position: 7,
				message_count: 1,
				share_url: "https://web.example.test/s/share-a",
				created_at: "2026-10-05T00:00:00Z",
			},
		],
	};
	const client = createSessionSharingClient({
		baseUrl: "https://cloud.example.test",
		getToken: async () => "owner-token",
		fetch: async (request) => {
			expect(new Request(request).url).toBe(
				"https://cloud.example.test/v1/sessions/session-a/shares",
			);
			return Response.json(shares);
		},
	});
	expect(await client.shares("session-a")).toEqual(shares);
});
