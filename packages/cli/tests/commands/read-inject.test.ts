import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { injectCommand } from "../../src/commands/inject";
import { readCommand } from "../../src/commands/read";
import { setProjectFolderLink } from "../../src/lib/project-folders";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let tmpRoot: string;
let projectRoot: string;
let origCwd: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origCwd = process.cwd();
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpRoot = join(tmpdir(), `clawdi-ref-${Date.now()}-${Math.random().toString(36)}`);
	tmpHome = join(tmpRoot, "home");
	projectRoot = join(tmpRoot, "project");
	const clawdiHome = join(tmpRoot, "state");
	mkdirSync(clawdiHome, { recursive: true });
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(join(clawdiHome, "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.chdir(projectRoot);
});

afterEach(() => {
	process.chdir(origCwd);
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

	it("uses the linked Project folder when no explicit project is passed", async () => {
		setProjectFolderLink(projectRoot, {
			project_id: "project-linked",
			project_label: "engineering",
			project_name: "Engineering",
			project_slug: "engineering",
			owner_handle: null,
			owner_display: null,
		});
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://default/OPENAI_API_KEY",
						value: "sk-linked",
						source_project_id: "project-linked",
						source_alias: "engineering",
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};
		try {
			await readCommand("clawdi://default/OPENAI_API_KEY");
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured[0].path).toContain("project_id=project-linked");
	});

	it("uses the project encoded in an exact reference instead of the folder link", async () => {
		setProjectFolderLink(projectRoot, {
			project_id: "project-linked",
			project_label: "engineering",
			project_name: "Engineering",
			project_slug: "engineering",
			owner_handle: null,
			owner_display: null,
		});
		const exact =
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY";
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: exact,
						value: "sk-exact",
						source_project_id: "00000000-0000-0000-0000-000000000123",
						source_alias: "production",
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};
		try {
			await readCommand(exact);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured[0].path).toContain("project_id=00000000-0000-0000-0000-000000000123");
		expect(captured[0].path).not.toContain("project_id=project-linked");
	});

	it("rejects an explicit --project that conflicts with an exact reference", async () => {
		const exact =
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "00000000-0000-0000-0000-000000000999",
							name: "Staging",
							slug: "staging",
							kind: "workspace",
						},
					]),
			},
		]);
		const origErr = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err += `${args.map(String).join(" ")}\n`;
		};
		try {
			await readCommand(exact, { project: "staging" });
		} finally {
			console.error = origErr;
			restore();
		}

		expect(captured.some((request) => request.path.startsWith("/api/vault/resolve"))).toBe(false);
		expect(err).toContain("Reference points to Project 00000000-0000-0000-0000-000000000123");
		expect(err).toContain("but --project resolved to 00000000-0000-0000-0000-000000000999");
		expect(process.exitCode).toBe(1);
	});

	it("dry-runs a reference without fetching or printing plaintext", async () => {
		const exact =
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/prod/section/stripe/field/secret_key";
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: exact,
						value: "sk-live",
						source_project_id: "00000000-0000-0000-0000-000000000123",
						source_alias: "prod",
						vault_slug: "prod",
						section: "stripe",
						item_name: "secret_key",
					}),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};
		try {
			await readCommand(exact, { dryRun: true, json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const body = JSON.parse(out) as { source_alias: string; value?: string };
		expect(body.source_alias).toBe("prod");
		expect(body.value).toBeUndefined();
		expect(out).not.toContain("sk-live");
		expect(captured[0].path).toContain("preview=true");
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
		expect(err).toContain("token line 1");
		expect(err).toContain("redacted");
		expect(err).not.toContain("sk-live");
	});

	it("uses the linked Project folder when resolving template references", async () => {
		setProjectFolderLink(projectRoot, {
			project_id: "project-linked",
			project_label: "engineering",
			project_name: "Engineering",
			project_slug: "engineering",
			owner_handle: null,
			owner_display: null,
		});
		const input = join(tmpRoot, "linked.template");
		const output = join(tmpRoot, "linked.env");
		writeFileSync(input, "token=clawdi://default/OPENAI_API_KEY\n");
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://default/OPENAI_API_KEY",
						value: "sk-linked",
						source_project_id: "project-linked",
						source_alias: "engineering",
					}),
			},
		]);
		const origErr = console.error;
		console.error = () => {};
		try {
			await injectCommand({ in: input, out: output });
		} finally {
			console.error = origErr;
			restore();
		}

		expect(captured[0].path).toContain("project_id=project-linked");
		expect(readFileSync(output, "utf8")).toBe("token=sk-linked\n");
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

	it("dry-runs references without writing output or fetching plaintext", async () => {
		const input = join(tmpRoot, "config.template");
		const output = join(tmpRoot, "config");
		writeFileSync(input, "token=clawdi://prod/stripe/secret_key\n");
		writeFileSync(output, "existing");
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/stripe/secret_key",
						source_project_id: "project-prod",
						source_alias: "prod",
						vault_slug: "prod",
						section: "stripe",
						item_name: "secret_key",
					}),
			},
		]);
		const origErr = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err += `${args.map(String).join(" ")}\n`;
		};
		try {
			await injectCommand({ in: input, out: output, dryRun: true });
		} finally {
			console.error = origErr;
			restore();
		}

		expect(readFileSync(output, "utf8")).toBe("existing");
		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("preview=true");
		expect(err).toContain("Dry run");
		expect(err).toContain("token line 1");
		expect(err).toContain("prod");
		expect(err).toContain("redacted");
		expect(err).not.toContain("sk-live");
	});

	it("keeps generated secret files owner-only when forcing an overwrite", async () => {
		const input = join(tmpRoot, "config.template");
		const output = join(tmpRoot, "config");
		writeFileSync(input, "token=clawdi://prod/stripe/secret_key\n");
		writeFileSync(output, "existing");
		if (process.platform !== "win32") chmodSync(output, 0o644);
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
		console.error = () => {};
		try {
			await injectCommand({ in: input, out: output, force: true });
		} finally {
			console.error = origErr;
			restore();
		}

		expect(readFileSync(output, "utf8")).toBe("token=sk-live\n");
		if (process.platform !== "win32") {
			expect(statSync(output).mode & 0o777).toBe(0o600);
		}
	});
});
