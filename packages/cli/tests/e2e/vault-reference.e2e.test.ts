import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const srcEntry = join(cliRoot, "src", "index.ts");
const REFERENCE = "clawdi://prod/openai/api_key";
const SECRET = "sk-e2e-vault-reference";

interface ApiCall {
	method: string;
	path: string;
	auth: string | null;
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
		fetch(req) {
			const url = new URL(req.url);
			apiCalls.push({
				method: req.method,
				path: `${url.pathname}${url.search}`,
				auth: req.headers.get("authorization"),
			});

			if (req.method !== "POST" || url.pathname !== "/api/vault/resolve") {
				return json({ detail: "not found" }, 404);
			}

			if (
				url.searchParams.get("vault_slug") !== "prod" ||
				url.searchParams.get("section") !== "openai" ||
				url.searchParams.get("field") !== "api_key"
			) {
				return json({ detail: "unexpected reference" }, 404);
			}

			return json({
				reference: REFERENCE,
				value: SECRET,
				source_project_id: "project-e2e",
				source_alias: "prod",
				vault_slug: "prod",
				section: "openai",
				item_name: "api_key",
			});
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
