import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	vaultAttach,
	vaultDetach,
	vaultImport,
	vaultList,
	vaultRm,
	vaultSet,
} from "../../src/commands/vault";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

const PROJECT_ID = "00000000-0000-0000-0000-000000000123";
const OTHER_PROJECT_ID = "00000000-0000-0000-0000-000000000456";

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-vault-list-${Date.now()}-${Math.random().toString(36)}`);
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

describe("vaultList", () => {
	it("includes exact references in JSON output", async () => {
		const { captured, restore } = mockVaultListFetch();
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};

		try {
			await vaultList({ json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const rows = JSON.parse(out) as Array<{
			project_id: string | null;
			project_ids: string[];
			items: Record<string, string[]>;
			references: Array<{ key: string; section: string; field: string; reference: string }>;
		}>;
		expect(rows[0].project_id).toBe(PROJECT_ID);
		expect(rows[0].project_ids).toEqual([PROJECT_ID]);
		expect(rows[0].items["(default)"]).toEqual(["OPENAI_API_KEY"]);
		expect(rows[0].references).toEqual([
			{
				key: "OPENAI_API_KEY",
				section: "",
				field: "OPENAI_API_KEY",
				reference: `clawdi://project/${PROJECT_ID}/vault/default/field/OPENAI_API_KEY`,
			},
			{
				key: "openai/api key",
				section: "openai",
				field: "api key",
				reference: `clawdi://project/${PROJECT_ID}/vault/default/section/openai/field/api%20key`,
			},
		]);
		const itemsRequest = captured.find((request) => request.path.includes("/items"));
		expect(itemsRequest?.path).toContain("vault_id=vault-1");
	});

	it("hides empty vaults in JSON output", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/vault/default/items",
				response: () => jsonResponse({ "(default)": ["OPENAI_API_KEY"] }),
			},
			{
				method: "GET",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({}),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID },
							{ id: "vault-2", slug: "prod", name: "prod", project_id: PROJECT_ID },
						],
						total: 2,
					}),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};

		try {
			await vaultList({ json: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const rows = JSON.parse(out) as Array<{ slug: string }>;
		expect(rows.map((row) => row.slug)).toEqual(["default"]);
	});

	it("prints copyable exact references in human output", async () => {
		const { restore } = mockVaultListFetch();
		const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultList({});
		} finally {
			console.log = origLog;
			if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(out).toContain(`Project personal (${PROJECT_ID})`);
		expect(out).toContain("Vault default");
		expect(out).toContain(`clawdi://project/${PROJECT_ID}/vault/default/field/OPENAI_API_KEY`);
		expect(out).toContain(
			`clawdi://project/${PROJECT_ID}/vault/default/section/openai/field/api%20key`,
		);
	});

	it("groups multiple vaults under one project in human output", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/vault/default/items",
				response: () => jsonResponse({ "(default)": ["OPENAI_API_KEY"] }),
			},
			{
				method: "GET",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ stripe: ["SECRET_KEY"] }),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID },
							{ id: "vault-2", slug: "prod", name: "prod", project_id: PROJECT_ID },
						],
						total: 2,
					}),
			},
			...mockProjectList(),
		]);
		const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultList({});
		} finally {
			console.log = origLog;
			if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(out.match(/Project personal/g)?.length).toBe(1);
		expect(out).toContain("Vault default");
		expect(out).toContain("Vault prod");
	});

	it("marks vaults attached to multiple projects in human output", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/vault/shared/items",
				response: () => jsonResponse({ "(default)": ["TOKEN"] }),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "vault-1",
								slug: "shared",
								name: "shared",
								project_ids: [PROJECT_ID, OTHER_PROJECT_ID],
							},
						],
						total: 1,
					}),
			},
			...mockProjectList(),
		]);
		const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultList({});
		} finally {
			console.log = origLog;
			if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(out).toContain("Vault shared (2 attached Projects)");
	});

	it("hides empty vaults in human output", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({}),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "prod", name: "prod", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
		]);
		const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultList({});
		} finally {
			console.log = origLog;
			if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(out).toContain("No vaults.");
		expect(out).not.toContain("Vault prod");
	});
});

describe("vaultImport", () => {
	it("imports dotenv files with export, quotes, comments, and empty values", async () => {
		const envFile = join(tmpHome, ".env");
		writeFileSync(
			envFile,
			[
				"  # generated by a real deployment tool",
				'export OPENAI_API_KEY="test-secret-value # keep" # inline note',
				"DATABASE_URL=postgres://db # local dev",
				"EMPTY_VALUE=",
				"invalid line without equals",
				"",
			].join("\n"),
		);
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ id: "vault-1", slug: "default" }),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/default/items",
				response: () => jsonResponse({ status: "ok", fields: 3 }),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await vaultImport(envFile, { yes: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const put = captured.find((request) => request.method === "PUT");
		expect(put?.path).toContain("vault_id=vault-1");
		expect(put?.body).toEqual({
			section: "",
			fields: {
				OPENAI_API_KEY: "test-secret-value # keep",
				DATABASE_URL: "postgres://db",
				EMPTY_VALUE: "",
			},
		});
	});

	it("does not create a vault or resolve a project when the dotenv file has no keys", async () => {
		const envFile = join(tmpHome, ".env.empty");
		writeFileSync(envFile, ["# comments only", "invalid line without equals", ""].join("\n"));
		const { captured, restore } = mockFetch([]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultImport(envFile, { yes: true, project: "production" });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(0);
		expect(out).toContain("No keys found in file.");
	});

	it("warns about invalid dotenv identifiers without writing when none are valid", async () => {
		const envFile = join(tmpHome, ".env.invalid");
		writeFileSync(envFile, ["my-section/OPENAI_API_KEY=secret", "api.key=value", ""].join("\n"));
		const { captured, restore } = mockFetch([]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultImport(envFile, { yes: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(0);
		expect(out).toContain(
			"Skipped 2 keys with invalid identifiers: my-section/OPENAI_API_KEY, api.key",
		);
		expect(out).toContain("No valid keys found in file.");
	});

	it("caps long invalid identifier warnings", async () => {
		const envFile = join(tmpHome, ".env.many-invalid");
		writeFileSync(
			envFile,
			Array.from({ length: 12 }, (_, index) => `bad-key-${index}=secret`).join("\n"),
		);
		const { captured, restore } = mockFetch([]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultImport(envFile, { yes: true });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(0);
		expect(out).toContain(
			"Skipped 12 keys with invalid identifiers: bad-key-0, bad-key-1, bad-key-2, bad-key-3, bad-key-4, bad-key-5, bad-key-6, bad-key-7, bad-key-8, bad-key-9, +2 more",
		);
	});

	it("imports dotenv files into the requested vault section", async () => {
		const envFile = join(tmpHome, ".env.prod");
		writeFileSync(
			envFile,
			["STRIPE_SECRET_KEY=stripe-secret-placeholder", "bad-key=skipped"].join("\n"),
		);
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ detail: "already exists" }, 409),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "prod", name: "prod", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "ok", fields: 1 }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultImport(envFile, { yes: true, vault: "prod", section: "stripe" });
		} finally {
			console.log = origLog;
			restore();
		}

		const create = captured.find((request) => request.method === "POST");
		expect(create?.body).toEqual({ slug: "prod", name: "prod" });
		const put = captured.find((request) => request.method === "PUT");
		expect(put?.path).toContain("/v1/vault/prod/items");
		expect(put?.body).toEqual({
			section: "stripe",
			fields: { STRIPE_SECRET_KEY: "stripe-secret-placeholder" },
		});
		expect(out).toContain("Skipped 1 key with invalid identifiers: bad-key");
		expect(out).toContain(
			`Imported 1 keys to vault "prod" section "stripe" in default-write project "personal" (${PROJECT_ID})`,
		);
		expect(out).toContain(
			`clawdi://project/${PROJECT_ID}/vault/prod/section/stripe/field/STRIPE_SECRET_KEY`,
		);
	});

	it("rejects invalid import targets before writing", async () => {
		const envFile = join(tmpHome, ".env.bad-target");
		writeFileSync(envFile, "TOKEN=secret\n");
		const { captured, restore } = mockFetch([]);

		try {
			await expect(vaultImport(envFile, { yes: true, section: "api/keys" })).rejects.toThrow(
				"Vault section may contain only letters",
			);
		} finally {
			restore();
		}

		expect(captured).toHaveLength(0);
	});
});

describe("vault attach/detach", () => {
	it("attaches an existing vault to another project without touching keys", async () => {
		const { captured, restore } = mockFetch([
			...mockProjectList(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{ id: "vault-1", slug: "providers", name: "providers", project_ids: [PROJECT_ID] },
						],
						total: 1,
					}),
			},
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ id: "vault-1", slug: "providers" }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultAttach("providers", { project: OTHER_PROJECT_ID });
		} finally {
			console.log = origLog;
			restore();
		}

		const post = captured.find((request) => request.method === "POST");
		expect(post?.path).toContain(`/v1/vault?project_id=${OTHER_PROJECT_ID}`);
		expect(post?.body).toEqual({ slug: "providers", name: "providers" });
		expect(captured.some((request) => request.method === "PUT")).toBe(false);
		expect(out).toContain("Attached vault");
		expect(out).toContain("one shared key set");
	});

	it("attaches an existing but currently unattached vault", async () => {
		const { captured, restore } = mockFetch([
			...mockProjectList(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "vault-1",
								slug: "providers",
								name: "providers",
								project_ids: [],
							},
						],
						total: 1,
					}),
			},
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ id: "vault-1", slug: "providers" }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultAttach("providers", { project: OTHER_PROJECT_ID });
		} finally {
			console.log = origLog;
			restore();
		}

		const post = captured.find((request) => request.method === "POST");
		expect(post?.path).toContain(`/v1/vault?project_id=${OTHER_PROJECT_ID}`);
		expect(out).toContain("Attached vault");
		expect(out).toContain("1 Project");
		expect(out).not.toContain("1 Projects");
	});

	it("detaches a vault from one project without deleting keys", async () => {
		const { captured, restore } = mockFetch([
			...mockProjectList(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "vault-1",
								slug: "providers",
								name: "providers",
								project_ids: [PROJECT_ID, OTHER_PROJECT_ID],
							},
						],
						total: 1,
					}),
			},
			{
				method: "DELETE",
				path: "/v1/vault/providers",
				response: () => jsonResponse({ status: "deleted" }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultDetach("providers", { project: OTHER_PROJECT_ID });
		} finally {
			console.log = origLog;
			restore();
		}

		const del = captured.find((request) => request.method === "DELETE");
		expect(del?.path).toContain(`/v1/vault/providers?project_id=${OTHER_PROJECT_ID}`);
		expect(del?.path).toContain("vault_id=vault-1");
		expect(captured.some((request) => request.path.includes("/items"))).toBe(false);
		expect(out).toContain("Detached vault");
		expect(out).toContain("No keys were deleted");
	});

	it("refuses to attach a missing vault because attach should not create key bundles", async () => {
		const { captured, restore } = mockFetch([
			...mockProjectList(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () => jsonResponse({ items: [], total: 0 }),
			},
		]);

		try {
			await expect(vaultAttach("missing", { project: PROJECT_ID })).rejects.toThrow(
				'No Vault named "missing" was found',
			);
		} finally {
			restore();
		}

		expect(captured.some((request) => request.method === "POST")).toBe(false);
	});
});

describe("vaultSet", () => {
	it("stores a non-interactive --value without prompting", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ detail: "already exists" }, 409),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "prod", name: "prod", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "ok", fields: 1 }),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await vaultSet("prod/stripe/SECRET_KEY", { value: "test-secret-value" });
		} finally {
			console.log = origLog;
			restore();
		}

		const put = captured.find((request) => request.method === "PUT");
		expect(put?.path).toContain("/v1/vault/prod/items");
		expect(put?.path).toContain("vault_id=vault-1");
		expect(put?.body).toEqual({
			section: "stripe",
			fields: { SECRET_KEY: "test-secret-value" },
		});
	});

	it("stores a non-interactive --stdin value and strips one final newline", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ detail: "already exists" }, 409),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "prod", name: "prod", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "ok", fields: 1 }),
			},
		]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		const origLog = console.log;
		console.log = () => {};

		try {
			const run = vaultSet("prod/stripe/SECRET_KEY", { stdin: true });
			queueMicrotask(() => {
				process.stdin.emit("data", "test-secret-value\n");
				process.stdin.emit("end");
			});
			await run;
		} finally {
			console.log = origLog;
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		const put = captured.find((request) => request.method === "PUT");
		expect(put?.path).toContain("/v1/vault/prod/items");
		expect(put?.body).toEqual({
			section: "stripe",
			fields: { SECRET_KEY: "test-secret-value" },
		});
	});

	it("rejects empty --stdin before writing", async () => {
		const { captured, restore } = mockFetch([]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

		try {
			const run = vaultSet("SECRET_KEY", { stdin: true });
			queueMicrotask(() => {
				process.stdin.emit("end");
			});
			await expect(run).rejects.toThrow(
				"Refusing to store an empty secret from --stdin. Pass --allow-empty to store an empty value intentionally.",
			);
		} finally {
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("allows empty --stdin only when explicitly requested", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ detail: "already exists" }, 409),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/default/items",
				response: () => jsonResponse({ status: "ok", fields: 1 }),
			},
		]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		const origLog = console.log;
		console.log = () => {};

		try {
			const run = vaultSet("SECRET_KEY", { stdin: true, allowEmpty: true });
			queueMicrotask(() => {
				process.stdin.emit("end");
			});
			await run;
		} finally {
			console.log = origLog;
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		const put = captured.find((request) => request.method === "PUT");
		expect(put?.body).toEqual({
			section: "",
			fields: { SECRET_KEY: "" },
		});
	});

	it("rejects --stdin from an interactive TTY before writing", async () => {
		const { captured, restore } = mockFetch([]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

		try {
			await expect(vaultSet("SECRET_KEY", { stdin: true })).rejects.toThrow(
				"Refusing to read --stdin from an interactive TTY.",
			);
		} finally {
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("rejects --prompt outside an interactive TTY before writing", async () => {
		const { captured, restore } = mockFetch([]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTtyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

		try {
			await expect(vaultSet("SECRET_KEY", { prompt: true })).rejects.toThrow(
				"Cannot prompt for a vault value in a non-interactive shell. Use --stdin with piped input.",
			);
		} finally {
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			if (stdoutTtyDesc) Object.defineProperty(process.stdout, "isTTY", stdoutTtyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("deletes a key from the resolved vault project", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "shared-vault",
								slug: "prod",
								name: "Shared prod",
								project_ids: [OTHER_PROJECT_ID],
								is_owner: false,
							},
							{
								id: "vault-1",
								slug: "prod",
								name: "prod",
								project_ids: [PROJECT_ID],
								is_owner: true,
							},
						],
						total: 2,
					}),
			},
			{
				method: "DELETE",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "deleted" }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultRm("prod/stripe/SECRET_KEY", { yes: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const del = captured.find((request) => request.method === "DELETE");
		expect(del?.path).toContain(`/v1/vault/prod/items?project_id=${PROJECT_ID}`);
		expect(del?.path).toContain("vault_id=vault-1");
		expect(del?.path).toContain("global_delete=false");
		expect(del?.body).toEqual({
			section: "stripe",
			fields: ["SECRET_KEY"],
		});
		expect(out).toContain(
			`Deleted prod/stripe/SECRET_KEY from vault "prod" section "stripe" in default-write project "personal" (${PROJECT_ID})`,
		);
	});

	it("refuses to delete a shared vault key without --global", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "vault-1",
								slug: "prod",
								name: "prod",
								project_ids: [PROJECT_ID, OTHER_PROJECT_ID],
							},
						],
						total: 1,
					}),
			},
		]);

		try {
			await expect(vaultRm("prod/stripe/SECRET_KEY", { yes: true })).rejects.toThrow(
				"Refusing to delete prod/stripe/SECRET_KEY from shared vault",
			);
		} finally {
			restore();
		}

		expect(captured.some((request) => request.method === "DELETE")).toBe(false);
	});

	it("passes explicit global confirmation for shared vault key deletion", async () => {
		const { captured, restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "vault-1",
								slug: "prod",
								name: "prod",
								project_ids: [PROJECT_ID, OTHER_PROJECT_ID],
							},
						],
						total: 1,
					}),
			},
			{
				method: "DELETE",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "deleted" }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultRm("prod/stripe/SECRET_KEY", { yes: true, global: true });
		} finally {
			console.log = origLog;
			restore();
		}

		const del = captured.find((request) => request.method === "DELETE");
		expect(del?.path).toContain("global_delete=true");
		expect(out).toContain("globally from shared vault");
		expect(out).toContain("2 Projects attached");
	});

	it("rejects interactive deletion prompts outside a TTY", async () => {
		const { captured, restore } = mockFetch([]);
		const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTtyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

		try {
			await expect(vaultRm("SECRET_KEY")).rejects.toThrow(
				"Cannot prompt for vault deletion in a non-interactive shell. Pass --yes",
			);
		} finally {
			if (stdinTtyDesc) Object.defineProperty(process.stdin, "isTTY", stdinTtyDesc);
			else Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			if (stdoutTtyDesc) Object.defineProperty(process.stdout, "isTTY", stdoutTtyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("rejects ambiguous vault keys before writing", async () => {
		const { captured, restore } = mockFetch([]);

		try {
			await expect(
				vaultSet("prod/stripe/SECRET_KEY/extra", { value: "test-secret-value" }),
			).rejects.toThrow("Vault key must be KEY, vault/KEY, or vault/section/KEY.");
		} finally {
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("rejects conflicting non-interactive value sources before writing", async () => {
		const { captured, restore } = mockFetch([]);

		try {
			await expect(
				vaultSet("SECRET_KEY", { value: "test-secret-value", stdin: true }),
			).rejects.toThrow("Pass only one of --value, --stdin, or --prompt.");
			await expect(
				vaultSet("SECRET_KEY", { value: "test-secret-value", prompt: true }),
			).rejects.toThrow("Pass only one of --value, --stdin, or --prompt.");
		} finally {
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("prints a non-blocking hint for broad vault slugs", async () => {
		const { restore } = mockFetch([
			...mockDefaultProjectResolution(),
			{
				method: "POST",
				path: "/v1/vault",
				response: () => jsonResponse({ detail: "already exists" }, 409),
			},
			{
				method: "GET",
				path: "/v1/vault",
				response: () =>
					jsonResponse({
						items: [{ id: "vault-1", slug: "prod", name: "prod", project_id: PROJECT_ID }],
						total: 1,
					}),
			},
			{
				method: "PUT",
				path: "/v1/vault/prod/items",
				response: () => jsonResponse({ status: "ok", fields: 1 }),
			},
		]);
		const origLog = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out += `${args.map(String).join(" ")}\n`;
		};

		try {
			await vaultSet("prod/stripe/SECRET_KEY", { value: "test-secret-value" });
		} finally {
			console.log = origLog;
			restore();
		}

		expect(out).toContain(
			'Hint: consider using a service-specific vault slug instead of "prod" for shared project secrets.',
		);
		expect(out).toContain("Stored prod/stripe/SECRET_KEY");
	});
});

function mockVaultListFetch() {
	return mockFetch([
		{
			method: "GET",
			path: "/v1/vault/default/items",
			response: () =>
				jsonResponse({
					"(default)": ["OPENAI_API_KEY"],
					openai: ["api key"],
				}),
		},
		{
			method: "GET",
			path: "/v1/vault",
			response: () =>
				jsonResponse({
					items: [{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID }],
					total: 1,
				}),
		},
		{
			method: "GET",
			path: "/v1/projects",
			response: () =>
				jsonResponse([
					{
						id: PROJECT_ID,
						slug: "personal",
						name: "Personal",
						kind: "personal",
						is_owner: true,
					},
				]),
		},
	]);
}

function mockDefaultProjectResolution() {
	return [
		{
			method: "GET",
			path: "/v1/projects/default",
			response: () => jsonResponse({ project_id: PROJECT_ID }),
		},
		{
			method: "GET",
			path: "/v1/projects",
			response: () => jsonResponse(mockProjects()),
		},
	];
}

function mockProjectList() {
	return [
		{
			method: "GET",
			path: "/v1/projects",
			response: () => jsonResponse(mockProjects()),
		},
	];
}

function mockProjects() {
	return [
		{
			id: PROJECT_ID,
			slug: "personal",
			name: "Personal",
			kind: "personal",
			is_owner: true,
		},
		{
			id: OTHER_PROJECT_ID,
			slug: "redpill-providers",
			name: "Redpill Providers",
			kind: "workspace",
			is_owner: true,
		},
	];
}
