import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSkillsRemove } from "../../src/commands/agent-skills";
import { inboxForgetCommand } from "../../src/commands/inbox";
import { projectInvitesCommand } from "../../src/commands/project-invites";
import { projectShareLinksCommand } from "../../src/commands/project-share-links";
import { vaultDetach } from "../../src/commands/vault";
import { jsonResponse, mockFetch } from "./helpers";

const agentId = "00000000-0000-0000-0000-000000000101";
const projectId = "00000000-0000-0000-0000-000000000102";
const linkId = "00000000-0000-0000-0000-000000000103";
const invitationId = "00000000-0000-0000-0000-000000000104";
const notice = "--yes will be required in a non-interactive shell starting in 0.16";
let tmpHome: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	originalApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = mkdtempSync(join(tmpdir(), "clawdi-tier-d-"));
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "https://api.test";
	process.exitCode = 0;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalApiUrl === undefined) delete process.env.CLAWDI_API_URL;
	else process.env.CLAWDI_API_URL = originalApiUrl;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("Tier D destructive confirmations", () => {
	const cases = [
		{
			name: "agent skills rm",
			setup: () =>
				mockFetch([
					{
						method: "GET",
						path: `/v1/agents/${agentId}/skills`,
						response: () =>
							jsonResponse({
								skills: [{ skill_key: "library-key", authority: "cloud", skill_id: "library-id" }],
							}),
					},
					{
						method: "DELETE",
						path: `/v1/agents/${agentId}/skill-references/library-id`,
						response: () => jsonResponse({ desired_state: "removed" }),
					},
				]),
			run: () => agentSkillsRemove(agentId, "library-key"),
			mutation: `/v1/agents/${agentId}/skill-references/library-id`,
		},
		{
			name: "project share-links --revoke",
			setup: () =>
				mockFetch([
					{
						method: "DELETE",
						path: `/v1/projects/${projectId}/share-links/${linkId}`,
						response: () => jsonResponse({ status: "revoked" }),
					},
				]),
			run: () => projectShareLinksCommand(projectId, { revoke: linkId }),
			mutation: `/v1/projects/${projectId}/share-links/${linkId}`,
		},
		{
			name: "project invites --cancel",
			setup: () =>
				mockFetch([
					{
						method: "DELETE",
						path: `/v1/projects/${projectId}/invitations/${invitationId}`,
						response: () => jsonResponse({ status: "canceled" }),
					},
				]),
			run: () => projectInvitesCommand(projectId, { cancel: invitationId }),
			mutation: `/v1/projects/${projectId}/invitations/${invitationId}`,
		},
		{
			name: "vault detach",
			setup: () =>
				mockFetch([
					{
						method: "GET",
						path: "/v1/projects",
						response: () =>
							jsonResponse([{ id: projectId, slug: "engineering", name: "Engineering" }]),
					},
					{
						method: "GET",
						path: "/v1/vault",
						response: () =>
							jsonResponse({
								items: [
									{
										id: "vault-id",
										slug: "providers",
										name: "Providers",
										project_ids: [projectId],
									},
								],
								total: 1,
								page: 1,
								page_size: 200,
							}),
					},
					{
						method: "DELETE",
						path: "/v1/vault/providers",
						response: () => new Response(null, { status: 204 }),
					},
				]),
			run: () => vaultDetach("providers", { project: projectId }),
			mutation: "/v1/vault/providers",
		},
		{
			name: "inbox forget",
			setup: () => {
				writeFileSync(
					join(tmpHome, ".clawdi", "share-tokens.json"),
					JSON.stringify({
						version: 1,
						tokens: [
							{
								project_id: projectId,
								project_name: "Engineering",
								owner_display: "Alice",
								owner_handle: "alice",
								token: "a".repeat(43),
								redeemed_at: "2026-08-27T12:00:00Z",
							},
						],
					}),
				);
				return mockFetch([]);
			},
			run: () => inboxForgetCommand(projectId),
			mutation: null,
		},
	] as const;

	it.each(cases)("warns and proceeds for $name without --yes", async (testCase) => {
		const { captured, restore } = testCase.setup();
		const errors: string[] = [];
		const output: string[] = [];
		const originalError = console.error;
		const originalLog = console.log;
		console.error = (value?: unknown) => errors.push(String(value));
		console.log = (value?: unknown) => output.push(String(value));
		try {
			await testCase.run();
		} finally {
			console.error = originalError;
			console.log = originalLog;
			restore();
		}

		expect(errors).toContain(notice);
		expect(output.join("\n")).not.toContain(notice);
		if (testCase.mutation)
			expect(captured.some((request) => request.path.startsWith(testCase.mutation))).toBe(true);
	});
});
