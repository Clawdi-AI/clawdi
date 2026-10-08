import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			run: (yes?: boolean) => agentSkillsRemove(agentId, "library-key", { yes }),
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
			run: (yes?: boolean) => projectShareLinksCommand(projectId, { revoke: linkId, yes }),
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
			run: (yes?: boolean) => projectInvitesCommand(projectId, { cancel: invitationId, yes }),
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
			run: (yes?: boolean) => vaultDetach("providers", { project: projectId, yes }),
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
			run: (yes?: boolean) => inboxForgetCommand(projectId, { yes }),
			mutation: null,
		},
	] as const;

	for (const testCase of cases) {
		it.each([false, true])(`${testCase.name} enforces confirmation with yes=%s`, async (yes) => {
			const { captured, restore } = testCase.setup();
			const tokenPath = join(tmpHome, ".clawdi", "share-tokens.json");
			const originalTokens = testCase.mutation === null ? readFileSync(tokenPath, "utf8") : null;
			const originalError = console.error;
			const originalLog = console.log;
			console.error = () => {};
			console.log = () => {};
			try {
				if (yes) {
					await testCase.run(yes);
				} else {
					await expect(testCase.run()).rejects.toThrow(
						/Confirmation required to .+\. Re-run with --yes in a non-interactive shell\./,
					);
				}
			} finally {
				console.error = originalError;
				console.log = originalLog;
				restore();
			}

			const writes = captured.filter((request) => request.method !== "GET");
			if (yes && testCase.mutation) {
				expect(writes).toHaveLength(1);
				expect(new URL(writes[0].path, "https://api.test").pathname).toBe(testCase.mutation);
			} else {
				expect(writes).toEqual([]);
			}
			if (originalTokens !== null) {
				if (yes) expect(JSON.parse(readFileSync(tokenPath, "utf8")).tokens).toEqual([]);
				else expect(readFileSync(tokenPath, "utf8")).toBe(originalTokens);
			}
		});
	}
});
