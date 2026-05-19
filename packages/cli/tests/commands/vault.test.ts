import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultList } from "../../src/commands/vault";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

const PROJECT_ID = "00000000-0000-0000-0000-000000000123";

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
		const { restore } = mockVaultListFetch();
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
			items: Record<string, string[]>;
			references: Array<{ key: string; section: string; field: string; reference: string }>;
		}>;
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

		expect(out).toContain(`default project=${PROJECT_ID}`);
		expect(out).toContain(`clawdi://project/${PROJECT_ID}/vault/default/field/OPENAI_API_KEY`);
		expect(out).toContain(
			`clawdi://project/${PROJECT_ID}/vault/default/section/openai/field/api%20key`,
		);
	});
});

function mockVaultListFetch() {
	return mockFetch([
		{
			method: "GET",
			path: "/api/vault/default/items",
			response: () =>
				jsonResponse({
					"(default)": ["OPENAI_API_KEY"],
					openai: ["api key"],
				}),
		},
		{
			method: "GET",
			path: "/api/vault",
			response: () =>
				jsonResponse({
					items: [{ id: "vault-1", slug: "default", name: "Default", project_id: PROJECT_ID }],
					total: 1,
				}),
		},
	]);
}
