import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, setAuth } from "./config";
import {
	readEnvironmentRegistration,
	writeEnvironmentRegistration,
} from "./environment-registration";

const originalClawdiHome = process.env.CLAWDI_HOME;
const roots: string[] = [];

afterEach(() => {
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("environment registration account binding", () => {
	it("keeps a legacy registration readable until online ownership inspection", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-registration-account-"));
		roots.push(root);
		process.env.CLAWDI_HOME = root;
		mkdirSync(join(root, "environments"), { recursive: true });
		writeFileSync(
			join(root, "environments", "codex.json"),
			JSON.stringify({ id: "agent-a", agentType: "codex", machineId: "machine-a" }),
		);
		setAuth({ apiKey: "account-b-key", userId: "account-b" });

		expect(readEnvironmentRegistration("codex")).toMatchObject({ id: "agent-a" });
	});

	it("does not adopt a registration explicitly bound to another account", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-registration-account-"));
		roots.push(root);
		process.env.CLAWDI_HOME = root;
		mkdirSync(join(root, "environments"), { recursive: true });
		writeFileSync(
			join(root, "environments", "codex.json"),
			JSON.stringify({ id: "agent-a", agentType: "codex", userId: "account-a" }),
		);
		setAuth({ apiKey: "account-b-key", userId: "account-b" });

		expect(readEnvironmentRegistration("codex")).toBeNull();
	});
});

describe("explicit Vault workspace registration", () => {
	it("preserves only the same identity and refuses a duplicate real workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-vault-registration-"));
		roots.push(root);
		process.env.CLAWDI_HOME = root;
		setAuth({ apiKey: "fixture", userId: "user-a" });
		const workspace = join(root, "project");
		mkdirSync(workspace);
		const identity = {
			id: "agent-a",
			agentType: "codex" as const,
			machineId: "machine-a",
			machineName: "fixture",
			userId: "user-a",
		};
		writeEnvironmentRegistration({
			...identity,
			vaultWorkspace: { path: workspace, apiOrigin: getConfig().apiUrl },
		});
		writeEnvironmentRegistration(identity);
		expect(readEnvironmentRegistration("codex")?.vaultWorkspace?.path).toBe(
			realpathSync(workspace),
		);
		const alias = join(root, "alias");
		symlinkSync(workspace, alias);
		expect(() =>
			writeEnvironmentRegistration({
				...identity,
				id: "agent-b",
				agentType: "claude_code",
				vaultWorkspace: { path: alias, apiOrigin: getConfig().apiUrl },
			}),
		).toThrow("already bound");
		writeEnvironmentRegistration({ ...identity, machineId: "replacement" });
		expect(readEnvironmentRegistration("codex")?.vaultWorkspace).toBeUndefined();
		writeEnvironmentRegistration({
			...identity,
			vaultWorkspace: { path: workspace, apiOrigin: getConfig().apiUrl },
		});
		setAuth({ apiKey: "fixture-new", userId: "user-b" });
		writeEnvironmentRegistration({ ...identity, userId: "user-b" });
		expect(readEnvironmentRegistration("codex")?.vaultWorkspace).toBeUndefined();
	});
});
