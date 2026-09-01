import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateMachineId } from "./machine-identity";

const originalClawdiHome = process.env.CLAWDI_HOME;
const roots: string[] = [];

afterEach(() => {
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("machine identity", () => {
	test("creates one stable installation identity", () => {
		const root = isolatedClawdiHome();
		const first = getOrCreateMachineId();
		const second = getOrCreateMachineId();

		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
		expect(JSON.parse(readFileSync(join(root, "machine.json"), "utf8"))).toEqual({
			schemaVersion: "clawdi.machineIdentity.v1",
			id: first,
		});
	});

	test("adopts the previous registration identity instead of duplicating the machine", () => {
		const root = isolatedClawdiHome();
		const envDir = join(root, "environments");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, "codex.json"),
			JSON.stringify({ id: "env-codex", agentType: "codex", machineId: "legacy-machine" }),
		);

		expect(getOrCreateMachineId()).toBe("legacy-machine");
		expect(getOrCreateMachineId()).toBe("legacy-machine");
	});
});

function isolatedClawdiHome(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-machine-identity-"));
	roots.push(root);
	process.env.CLAWDI_HOME = root;
	return root;
}
