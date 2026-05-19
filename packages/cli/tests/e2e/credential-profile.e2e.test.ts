import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const srcEntry = join(cliRoot, "src", "index.ts");

interface ApiCall {
	method: string;
	path: string;
	auth: string | null;
	body: unknown;
}

interface Fixture {
	root: string;
	home: string;
	clawdiHome: string;
}

interface CredentialCase {
	tool: string;
	homeRelativePath: string;
	content: string;
	secretNeedle: string;
	expectedLogicalName: string;
}

const CASES: CredentialCase[] = [
	{
		tool: "codex",
		homeRelativePath: ".codex/auth.json",
		content: `${JSON.stringify({ token: "codex-e2e-secret" })}\n`,
		secretNeedle: "codex-e2e-secret",
		expectedLogicalName: "auth.json",
	},
	{
		tool: "claude-code",
		homeRelativePath: ".claude/.credentials.json",
		content: `${JSON.stringify({ accessToken: "claude-e2e-secret" })}\n`,
		secretNeedle: "claude-e2e-secret",
		expectedLogicalName: ".credentials.json",
	},
	{
		tool: "gh",
		homeRelativePath: ".config/gh/hosts.yml",
		content: "github.com:\n  oauth_token: gh-e2e-secret\n  user: octo\n",
		secretNeedle: "gh-e2e-secret",
		expectedLogicalName: "hosts.yml",
	},
];

let server: ReturnType<typeof Bun.serve>;
let apiCalls: ApiCall[] = [];
let storedProfiles = new Map<string, string>();

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = await readJsonBody(req);
			apiCalls.push({
				method: req.method,
				path: url.pathname,
				auth: req.headers.get("authorization"),
				body,
			});

			if (req.method === "POST" && url.pathname === "/api/vault/credential-profiles") {
				const bodyRecord = asRecord(body);
				const tool = asString(bodyRecord.tool);
				const profile = asString(bodyRecord.profile);
				const payload = asString(bodyRecord.payload);
				if (!tool || !profile || !payload) {
					return json({ detail: "invalid profile body" }, 400);
				}
				storedProfiles.set(profileKey(tool, profile), payload);
				return json({
					id: `profile-${tool}-${profile}`,
					project_id: "project-e2e",
					tool,
					profile,
					updated_at: new Date().toISOString(),
				});
			}

			if (req.method === "POST" && url.pathname === "/api/vault/credential-profiles/resolve") {
				const bodyRecord = asRecord(body);
				const tool = asString(bodyRecord.tool);
				const profile = asString(bodyRecord.profile);
				const payload = tool && profile ? storedProfiles.get(profileKey(tool, profile)) : undefined;
				if (!tool || !profile || !payload) {
					return json({ detail: "not found" }, 404);
				}
				return json({
					id: `profile-${tool}-${profile}`,
					project_id: "project-e2e",
					tool,
					profile,
					updated_at: new Date().toISOString(),
					payload,
				});
			}

			return json({ detail: "not found" }, 404);
		},
	});
});

afterAll(() => {
	server.stop(true);
});

beforeEach(() => {
	apiCalls = [];
	storedProfiles = new Map<string, string>();
});

describe("credential profile process e2e", () => {
	for (const testCase of CASES) {
		it(`imports and materializes ${testCase.tool} credentials across isolated homes`, async () => {
			const source = createFixture();
			const destination = createFixture();
			const sourcePath = join(source.home, testCase.homeRelativePath);
			const destinationPath = join(destination.home, testCase.homeRelativePath);
			writeCredentialFile(sourcePath, testCase.content);
			writeCredentialFile(destinationPath, "existing-local-credential");

			try {
				const profile = `e2e-${testCase.tool}`;
				const imported = await runCli(source, [
					"agent",
					"credentials",
					"import",
					testCase.tool,
					"--profile",
					profile,
					"--json",
					"--yes",
				]);

				expect(imported.code).toBe(0);
				expect(imported.stdout).not.toContain(testCase.secretNeedle);
				expect(imported.stderr).not.toContain(testCase.secretNeedle);
				const importCall = apiCalls.find((call) => call.path === "/api/vault/credential-profiles");
				expect(importCall?.auth).toBe("Bearer test-key");
				const importBody = asRecord(importCall?.body);
				const payload = JSON.parse(asString(importBody.payload) ?? "{}");
				expect(payload.kind).toBe("local_agent_profile");
				expect(payload.files[0].logicalName).toBe(testCase.expectedLogicalName);
				expect(payload.files[0].targetStrategy).toBe("adapter_default");
				expect(payload.files[0].content).toBe(testCase.content);

				const materialized = await runCli(destination, [
					"agent",
					"credentials",
					"materialize",
					testCase.tool,
					"--profile",
					profile,
					"--json",
					"--yes",
				]);

				expect(materialized.code).toBe(0);
				expect(materialized.stdout).not.toContain(testCase.secretNeedle);
				expect(materialized.stderr).not.toContain(testCase.secretNeedle);
				expect(readFileSync(destinationPath, "utf8")).toBe(testCase.content);
				expect(statSync(destinationPath).mode & 0o777).toBe(0o600);
				const destinationDir = dirname(destinationPath);
				const backupPrefix = `${basenameFromPath(testCase.homeRelativePath)}.bak-`;
				const backups = readdirSync(destinationDir).filter((name) => name.startsWith(backupPrefix));
				expect(backups).toHaveLength(1);
				expect(readFileSync(join(destinationDir, backups[0]), "utf8")).toBe(
					"existing-local-credential",
				);
			} finally {
				rmSync(source.root, { recursive: true, force: true });
				rmSync(destination.root, { recursive: true, force: true });
			}
		});
	}
});

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "clawdi-credential-e2e-"));
	const home = join(root, "home");
	const clawdiHome = join(root, "clawdi-state");
	mkdirSync(home, { recursive: true });
	mkdirSync(clawdiHome, { recursive: true });
	writeFileSync(join(clawdiHome, "auth.json"), `${JSON.stringify({ apiKey: "test-key" })}\n`, {
		mode: 0o600,
	});
	return { root, home, clawdiHome };
}

function writeCredentialFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { mode: 0o600 });
}

async function runCli(
	fixture: Fixture,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn([process.execPath, srcEntry, ...args], {
		cwd: fixture.root,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			CLAWDI_API_URL: server.url.origin,
			CLAWDI_HOME: fixture.clawdiHome,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			CI: "true",
			HOME: fixture.home,
			NO_COLOR: "1",
			PATH: process.env.PATH ?? "",
			TMPDIR: tmpdir(),
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

async function readJsonBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function profileKey(tool: string, profile: string): string {
	return `${tool}/${profile}`;
}

function basenameFromPath(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}
