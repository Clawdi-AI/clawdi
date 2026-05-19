import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentCredentialsImportCommand,
	agentCredentialsMaterializeCommand,
} from "../../src/commands/agent-credentials";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;
let agentEnvSnapshot: AgentHomeOverrideSnapshot;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	agentEnvSnapshot = snapshotAndClearAgentHomeOverrides();
	tmpHome = join(tmpdir(), `clawdi-agent-creds-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	mkdirSync(join(tmpHome, ".codex"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	restoreAgentHomeOverrides(agentEnvSnapshot);
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("agent credential profiles", () => {
	it("imports Codex auth.json as a credential profile without printing the secret", async () => {
		const codexAuthPath = join(tmpHome, ".codex", "auth.json");
		writeFileSync(codexAuthPath, JSON.stringify({ token: "codex-secret" }));
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/credential-profiles",
				response: () =>
					jsonResponse({
						id: "profile-1",
						project_id: "project-1",
						tool: "codex",
						profile: "default",
						updated_at: new Date().toISOString(),
					}),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await agentCredentialsImportCommand("codex", { yes: true, json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(out).not.toContain("codex-secret");
		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({
			tool: "codex",
			profile: "default",
		});
		const body = captured[0].body as { payload: string };
		const payload = JSON.parse(body.payload);
		expect(payload.kind).toBe("local_agent_profile");
		expect(payload.files[0].content).toContain("codex-secret");
		expect(payload.files[0].targetStrategy).toBe("adapter_default");
	});

	it("materializes a stored Codex profile to the local Codex auth path with backup", async () => {
		const codexAuthPath = join(tmpHome, ".codex", "auth.json");
		writeFileSync(codexAuthPath, "old-auth");
		const payload = {
			schemaVersion: 1,
			kind: "local_agent_profile",
			tool: "codex",
			profile: "default",
			importedAt: new Date().toISOString(),
			files: [
				{
					logicalName: "auth.json",
					sourcePath: "/source/.codex/auth.json",
					targetStrategy: "adapter_default",
					content: "new-auth",
					mode: 0o600,
					size: 8,
				},
			],
		};
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/credential-profiles/resolve",
				response: () =>
					jsonResponse({
						id: "profile-1",
						project_id: "project-1",
						tool: "codex",
						profile: "default",
						updated_at: new Date().toISOString(),
						payload: JSON.stringify(payload),
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};
		try {
			await agentCredentialsMaterializeCommand("codex", { yes: true, json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(readFileSync(codexAuthPath, "utf-8")).toBe("new-auth");
		const backups = readdirSync(join(tmpHome, ".codex")).filter((name) =>
			name.startsWith("auth.json.bak-"),
		);
		expect(backups).toHaveLength(1);
		expect(existsSync(join(tmpHome, ".codex", backups[0]))).toBe(true);
	});
});
