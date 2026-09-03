import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuth } from "./config";
import { readEnvironmentRegistration } from "./environment-registration";

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
