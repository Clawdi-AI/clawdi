import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const srcEntry = join(cliRoot, "src", "index.ts");
const PROJECT_ID = "00000000-0000-0000-0000-000000000123";
const REFERENCE = `clawdi://project/${PROJECT_ID}/vault/prod/section/openai/field/api_key`;
const SECRET = "sk-e2e-vault-reference";

interface ApiCall {
	method: string;
	path: string;
	auth: string | null;
	body?: unknown;
}

interface Fixture {
	root: string;
	home: string;
	clawdiHome: string;
}

let server: ReturnType<typeof Bun.serve>;
let apiCalls: ApiCall[] = [];

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const requestBody =
				req.method === "POST" && url.pathname === "/v1/vault/resolve/bulk"
					? await readJsonBody(req)
					: undefined;
			apiCalls.push({
				method: req.method,
				path: `${url.pathname}${url.search}`,
				auth: req.headers.get("authorization"),
				body: requestBody,
			});

			if (req.method !== "POST") {
				return json({ detail: "not found" }, 404);
			}

			if (url.pathname === "/v1/vault/resolve/bulk") {
				if (!isExpectedBulkRequest(requestBody)) {
					return json({ detail: "unexpected reference" }, 404);
				}
				const body = referenceBody();
				const result =
					(requestBody as { preview?: unknown }).preview === true
						? body
						: { ...body, value: SECRET };
				return json({ results: { [REFERENCE]: result } });
			}

			if (url.pathname !== "/v1/vault/resolve") {
				return json({ detail: "not found" }, 404);
			}

			if (
				url.searchParams.get("vault_slug") !== "prod" ||
				url.searchParams.get("section") !== "openai" ||
				url.searchParams.get("field") !== "api_key" ||
				url.searchParams.get("project_id") !== PROJECT_ID
			) {
				return json({ detail: "unexpected reference" }, 404);
			}

			const body = referenceBody();
			if (url.searchParams.get("preview") === "true") {
				return json(body);
			}
			return json({ ...body, value: SECRET });
		},
	});
});

afterAll(() => {
	server.stop(true);
});

beforeEach(() => {
	apiCalls = [];
});

describe("vault reference process e2e", () => {
	it("reads a clawdi reference through the real CLI process", async () => {
		const fixture = createFixture();
		try {
			const result = await runCli(fixture, ["read", REFERENCE]);

			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe(SECRET);
			expect(result.stderr).not.toContain(SECRET);
			expect(apiCalls).toHaveLength(1);
			expect(apiCalls[0].auth).toBe("Bearer test-key");
			expect(apiCalls[0].path).toContain("vault_slug=prod");
			expect(apiCalls[0].path).toContain("section=openai");
			expect(apiCalls[0].path).toContain("field=api_key");
			expect(apiCalls[0].path).toContain(`project_id=${PROJECT_ID}`);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("injects template references without leaking secrets to diagnostics", async () => {
		const fixture = createFixture();
		const input = join(fixture.root, ".env.template");
		const output = join(fixture.root, ".env.local");
		writeFileSync(input, `OPENAI_API_KEY=${REFERENCE}\n`);

		try {
			const result = await runCli(fixture, ["inject", "--in", input, "--out", output]);

			expect(result.code).toBe(0);
			expect(readFileSync(output, "utf8")).toBe(`OPENAI_API_KEY=${SECRET}\n`);
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stderr).toContain("Resolved 1 clawdi reference");
			expect(result.stderr).toContain("redacted");
			expect(result.stderr).not.toContain(SECRET);
			expect(apiCalls).toHaveLength(1);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("runs a child command with env-file references resolved", async () => {
		const fixture = createFixture();
		const envFile = join(fixture.root, ".env");
		writeFileSync(envFile, `OPENAI_API_KEY=${REFERENCE}\nLITERAL_VALUE=kept\n`);
		const childScript = [
			`if (process.env.OPENAI_API_KEY !== ${JSON.stringify(SECRET)}) process.exit(42);`,
			'if (process.env.LITERAL_VALUE !== "kept") process.exit(43);',
			'console.log("env-ok");',
		].join("");

		try {
			const result = await runCli(fixture, [
				"run",
				"--env-file",
				envFile,
				"--no-inherit-env",
				"--no-project-folder",
				"--",
				process.execPath,
				"-e",
				childScript,
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Resolved 1 clawdi reference");
			expect(result.stdout).toContain("env-ok");
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stderr).not.toContain(SECRET);
			expect(apiCalls).toHaveLength(1);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("dry-runs a child command without launching or exposing plaintext", async () => {
		const fixture = createFixture();
		const envFile = join(fixture.root, ".env");
		writeFileSync(envFile, `OPENAI_API_KEY=${REFERENCE}\n`);
		const childScript = "process.exit(42);";

		try {
			const result = await runCli(fixture, [
				"run",
				"--dry-run",
				"--env-file",
				envFile,
				"--no-inherit-env",
				"--no-project-folder",
				"--",
				process.execPath,
				"-e",
				childScript,
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Dry run: command will not be launched.");
			expect(result.stdout).toContain("OPENAI_API_KEY");
			expect(result.stdout).toContain("redacted");
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stderr).not.toContain(SECRET);
			expect(apiCalls).toHaveLength(1);
			expect(apiCalls[0].body).toMatchObject({ preview: true });
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "clawdi-vault-e2e-"));
	const home = join(root, "home");
	const clawdiHome = join(root, "clawdi-state");
	mkdirSync(home, { recursive: true });
	mkdirSync(clawdiHome, { recursive: true });
	writeFileSync(join(clawdiHome, "auth.json"), `${JSON.stringify({ apiKey: "test-key" })}\n`, {
		mode: 0o600,
	});
	return { root, home, clawdiHome };
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

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readJsonBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return undefined;
	}
}

function isExpectedBulkRequest(body: unknown): boolean {
	if (body === null || typeof body !== "object") return false;
	const references = (body as { references?: unknown }).references;
	if (!Array.isArray(references) || references.length !== 1) return false;
	const ref = references[0] as Record<string, unknown>;
	return (
		ref.reference === REFERENCE &&
		ref.vault_slug === "prod" &&
		ref.section === "openai" &&
		ref.field === "api_key" &&
		ref.project_id === PROJECT_ID
	);
}

function referenceBody() {
	return {
		reference: REFERENCE,
		source_project_id: PROJECT_ID,
		source_alias: "prod",
		vault_slug: "prod",
		section: "openai",
		item_name: "api_key",
	};
}
