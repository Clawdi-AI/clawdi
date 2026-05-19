import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { injectCommand } from "../../src/commands/inject";
import { readCommand } from "../../src/commands/read";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let tmpRoot: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpRoot = join(tmpdir(), `clawdi-ref-${Date.now()}-${Math.random().toString(36)}`);
	tmpHome = join(tmpRoot, "home");
	const clawdiHome = join(tmpRoot, "state");
	mkdirSync(clawdiHome, { recursive: true });
	writeFileSync(join(clawdiHome, "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpRoot, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("readCommand", () => {
	it("prints plaintext only for the explicit read target", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/stripe/secret_key",
						value: "sk-live",
						source_project_id: "project-prod",
						source_alias: "prod",
					}),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await readCommand("clawdi://prod/stripe/secret_key");
		} finally {
			console.log = origLog;
			restore();
		}

		expect(out.trim()).toBe("sk-live");
		expect(captured[0].path).toContain("vault_slug=prod");
		expect(captured[0].path).toContain("section=stripe");
		expect(captured[0].path).toContain("field=secret_key");
	});
});

describe("injectCommand", () => {
	it("renders references and redacts the summary", async () => {
		const input = join(tmpRoot, "config.template");
		const output = join(tmpRoot, "config");
		writeFileSync(input, "token=clawdi://prod/stripe/secret_key\n");
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/stripe/secret_key",
						value: "sk-live",
						source_project_id: "project-prod",
						source_alias: "prod",
					}),
			},
		]);
		const origErr = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err += `${args.map(String).join(" ")}\n`;
		};
		try {
			await injectCommand({ in: input, out: output });
		} finally {
			console.error = origErr;
			restore();
		}

		expect(readFileSync(output, "utf8")).toBe("token=sk-live\n");
		expect(err).toContain("Resolved 1 clawdi reference");
		expect(err).toContain("redacted");
		expect(err).not.toContain("sk-live");
	});

	it("refuses to overwrite output without --force", async () => {
		const input = join(tmpRoot, "config.template");
		const output = join(tmpRoot, "config");
		writeFileSync(input, "token=clawdi://prod/stripe/secret_key\n");
		writeFileSync(output, "existing");
		const origErr = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err += `${args.map(String).join(" ")}\n`;
		};
		try {
			await injectCommand({ in: input, out: output });
		} finally {
			console.error = origErr;
		}

		expect(readFileSync(output, "utf8")).toBe("existing");
		expect(err).toContain("Refusing to overwrite");
		expect(process.exitCode).toBe(1);
		expect(existsSync(output)).toBe(true);
	});
});
