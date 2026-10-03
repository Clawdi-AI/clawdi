import { expect, test } from "bun:test";
import { createProjectSharingClient } from "./project-sharing-client";

test("sharing client preserves authenticated owner routes, payloads and encoded IDs", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const client = createProjectSharingClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async (request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			const body = await request.text();
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: body ? JSON.parse(body) : null,
			});
			return Response.json({});
		},
	});
	const id = "project/a?b";
	await client.getProject(id);
	await client.listLinks(id);
	await client.createLink(id, { label: "Friends" });
	await client.revokeLink(id, "link/a");
	await client.listInvitations(id);
	await client.invite(id, { email: "friend@example.test" });
	await client.cancelInvitation(id, "invite/a");
	await client.listMembers(id);
	await client.removeMember(id, "user/a");
	await client.stopSharing(id);
	await client.leaveProject(id);
	await client.listReceivedInvitations();
	await client.acceptInvitation("invite/a");
	await client.declineInvitation("invite/a");
	await client.previewLink("token/a");
	await client.joinLink("token/a");
	const path = "/v1/projects/project%2Fa%3Fb";
	expect(requests).toEqual([
		{ method: "GET", path, body: null },
		{ method: "GET", path: `${path}/share-links`, body: null },
		{ method: "POST", path: `${path}/share-links`, body: { label: "Friends" } },
		{ method: "DELETE", path: `${path}/share-links/link%2Fa`, body: null },
		{ method: "GET", path: `${path}/invitations`, body: null },
		{ method: "POST", path: `${path}/invitations`, body: { email: "friend@example.test" } },
		{ method: "DELETE", path: `${path}/invitations/invite%2Fa`, body: null },
		{ method: "GET", path: `${path}/members`, body: null },
		{ method: "DELETE", path: `${path}/members/user%2Fa`, body: null },
		{ method: "POST", path: `${path}/unshare`, body: null },
		{ method: "POST", path: `${path}/leave`, body: null },
		{ method: "GET", path: "/v1/me/invitations", body: null },
		{ method: "POST", path: "/v1/me/invitations/invite%2Fa/accept", body: { use_as: "attached" } },
		{ method: "POST", path: "/v1/me/invitations/invite%2Fa/decline", body: null },
		{ method: "GET", path: "/v1/share/token%2Fa/preview", body: null },
		{ method: "POST", path: "/v1/share/token%2Fa/upgrade", body: { use_as: "attached" } },
	]);
});
