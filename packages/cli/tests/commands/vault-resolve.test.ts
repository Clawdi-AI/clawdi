import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultResolveCommand } from "../../src/commands/vault-resolve";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-vault-resolve-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("vaultResolveCommand", () => {
	it("resolves from the default project when no explicit project is passed", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						key: "OPENAI_API_KEY",
						value: "sk-local",
						source_project_id: "project-default",
						source_alias: "project-default",
						precedence: [
							{
								project_id: "project-default",
								alias: "project-default",
								hit: true,
								reason: "match",
							},
						],
					}),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await vaultResolveCommand("OPENAI_API_KEY", { debug: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured.length).toBe(1);
		expect(captured[0].path).toContain("key=OPENAI_API_KEY");
		expect(captured[0].path).not.toContain("project_id=");
		expect(captured[0].path).toContain("debug=true");
		expect(out).toContain("sk-local");
	});

	it("resolves through an explicit project and prints debug precedence", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects/default",
				response: () => jsonResponse({ project_id: "project-parent" }),
			},
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						key: "OPENAI_API_KEY",
						value: "sk-test",
						source_project_id: "project-source",
						source_alias: "@alice/engineering",
						precedence: [
							{
								project_id: "project-parent",
								alias: "personal",
								hit: false,
								reason: "not-found",
							},
							{
								project_id: "project-source",
								alias: "@alice/engineering",
								hit: true,
								reason: "match",
							},
						],
					}),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await vaultResolveCommand("OPENAI_API_KEY", { project: "default", debug: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured.at(-1)?.path).toContain("key=OPENAI_API_KEY");
		expect(captured.at(-1)?.path).toContain("project_id=project-parent");
		expect(captured.at(-1)?.path).toContain("debug=true");
		expect(out).toContain("sk-test");
		expect(out).toContain("@alice/engineering");
		expect(out).toContain("searched:");
	});

	it("emits raw JSON for agent consumers", async () => {
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => jsonResponse({ key: "OPENAI_API_KEY", value: "sk-test" }),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await vaultResolveCommand("OPENAI_API_KEY", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out).value).toBe("sk-test");
	});
});
