import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
let origGhConfigDir: string | undefined;
let origXdgConfigHome: string | undefined;
let agentEnvSnapshot: AgentHomeOverrideSnapshot;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	origGhConfigDir = process.env.GH_CONFIG_DIR;
	origXdgConfigHome = process.env.XDG_CONFIG_HOME;
	agentEnvSnapshot = snapshotAndClearAgentHomeOverrides();
	tmpHome = join(tmpdir(), `clawdi-agent-creds-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	mkdirSync(join(tmpHome, ".codex"), { recursive: true });
	mkdirSync(join(tmpHome, ".claude"), { recursive: true });
	mkdirSync(join(tmpHome, ".config", "gh"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	delete process.env.GH_CONFIG_DIR;
	delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	if (origGhConfigDir) process.env.GH_CONFIG_DIR = origGhConfigDir;
	else delete process.env.GH_CONFIG_DIR;
	if (origXdgConfigHome) process.env.XDG_CONFIG_HOME = origXdgConfigHome;
	else delete process.env.XDG_CONFIG_HOME;
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
				path: "/v1/vault/credential-profiles",
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

	it("dry-runs an explicit Keychain source without reading or uploading a secret", async () => {
		const { captured, restore } = mockFetch([]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await agentCredentialsImportCommand("claude-code", {
				source: "keychain",
				keychainService: "com.example.ClaudeCode",
				keychainAccount: "user@example.test",
				dryRun: true,
				json: true,
			});
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(0);
		expect(out).toContain('"source": "keychain"');
		expect(out).toContain("keychain://com.example.ClaudeCode/user@example.test");
		expect(out).not.toContain("secret");
	});

	it("requires explicit Keychain service and account names", async () => {
		await expect(
			agentCredentialsImportCommand("claude-code", {
				source: "keychain",
				yes: true,
				json: true,
			}),
		).rejects.toThrow("does not guess credential-store item names");
	});

	it("rejects unsafe Keychain service/account metadata", async () => {
		await expect(
			agentCredentialsImportCommand("claude-code", {
				source: "keychain",
				keychainService: "com.example.ClaudeCode\nspoof",
				keychainAccount: "user@example.test",
				dryRun: true,
				json: true,
			}),
		).rejects.toThrow("must not contain control characters");
	});

	it("fails clearly for Keychain import on non-macOS", async () => {
		if (process.platform === "darwin") return;
		const { restore } = mockFetch([]);
		const origLog = console.log;
		console.log = () => {};
		try {
			await expect(
				agentCredentialsImportCommand("claude-code", {
					source: "keychain",
					keychainService: "com.example.ClaudeCode",
					keychainAccount: "user@example.test",
					yes: true,
					json: true,
				}),
			).rejects.toThrow("macOS Keychain import is only available on macOS");
		} finally {
			console.log = origLog;
			restore();
		}
	});

	it("materializes a stored Codex profile to the local Codex auth path with backup", async () => {
		const codexAuthPath = join(tmpHome, ".codex", "auth.json");
		writeFileSync(codexAuthPath, "old-auth");
		if (process.platform !== "win32") {
			chmodSync(codexAuthPath, 0o644);
		}
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
					mode: 0o644,
					size: 8,
				},
			],
		};
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/credential-profiles/resolve",
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
		if (process.platform !== "win32") {
			expect(statSync(codexAuthPath).mode & 0o777).toBe(0o600);
		}
		const backups = readdirSync(join(tmpHome, ".codex")).filter((name) =>
			name.startsWith("auth.json.bak-"),
		);
		expect(backups).toHaveLength(1);
		const backup = join(tmpHome, ".codex", backups[0]);
		expect(existsSync(backup)).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(backup).mode & 0o777).toBe(0o600);
		}
	});

	it("imports Claude Code credentials using the built-in adapter alias", async () => {
		const claudeCredentialsPath = join(tmpHome, ".claude", ".credentials.json");
		writeFileSync(claudeCredentialsPath, JSON.stringify({ accessToken: "claude-secret" }));
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/credential-profiles",
				response: () =>
					jsonResponse({
						id: "profile-2",
						project_id: "project-1",
						tool: "claude-code",
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
			await agentCredentialsImportCommand("claude_code", { yes: true, json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(out).not.toContain("claude-secret");
		expect(captured).toHaveLength(1);
		expect(captured[0].body).toMatchObject({
			tool: "claude-code",
			profile: "default",
		});
		const body = captured[0].body as { payload: string };
		const payload = JSON.parse(body.payload);
		expect(payload.files[0].logicalName).toBe(".credentials.json");
		expect(payload.files[0].targetStrategy).toBe("adapter_default");
		expect(payload.files[0].content).toContain("claude-secret");
	});

	it("materializes a stored GitHub CLI hosts.yml profile to the gh config path", async () => {
		const ghHostsPath = join(tmpHome, ".config", "gh", "hosts.yml");
		writeFileSync(ghHostsPath, "github.com:\n  user: old\n");
		const payload = {
			schemaVersion: 1,
			kind: "local_agent_profile",
			tool: "gh",
			profile: "default",
			importedAt: new Date().toISOString(),
			files: [
				{
					logicalName: "hosts.yml",
					sourcePath: "/source/.config/gh/hosts.yml",
					targetStrategy: "adapter_default",
					content: "github.com:\n  oauth_token: gh-secret\n",
					mode: 0o600,
					size: 37,
				},
			],
		};
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/credential-profiles/resolve",
				response: () =>
					jsonResponse({
						id: "profile-3",
						project_id: "project-1",
						tool: "gh",
						profile: "default",
						updated_at: new Date().toISOString(),
						payload: JSON.stringify(payload),
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};
		try {
			await agentCredentialsMaterializeCommand("github-cli", { yes: true, json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(readFileSync(ghHostsPath, "utf-8")).toBe("github.com:\n  oauth_token: gh-secret\n");
		const backups = readdirSync(join(tmpHome, ".config", "gh")).filter((name) =>
			name.startsWith("hosts.yml.bak-"),
		);
		expect(backups).toHaveLength(1);
		expect(existsSync(join(tmpHome, ".config", "gh", backups[0]))).toBe(true);
	});

	it("rejects stored credential payloads that do not match the requested profile", async () => {
		const payload = {
			schemaVersion: 1,
			kind: "local_agent_profile",
			tool: "gh",
			profile: "default",
			importedAt: new Date().toISOString(),
			files: [
				{
					logicalName: "hosts.yml",
					sourcePath: "/source/.config/gh/hosts.yml",
					targetStrategy: "adapter_default",
					content: "github.com:\n  oauth_token: gh-secret\n",
					mode: 0o600,
					size: 37,
				},
			],
		};
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/vault/credential-profiles/resolve",
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
		try {
			await expect(
				agentCredentialsMaterializeCommand("codex", { yes: true, json: true }),
			).rejects.toThrow("metadata does not match");
		} finally {
			restore();
		}
	});
});
