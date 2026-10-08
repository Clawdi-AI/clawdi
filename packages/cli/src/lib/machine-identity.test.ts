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

	test("ignores a legacy registration identity", () => {
		const root = isolatedClawdiHome();
		const envDir = join(root, "environments");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, "codex.json"),
			JSON.stringify({ id: "env-codex", agentType: "codex", machineId: "legacy-machine" }),
		);

		const first = getOrCreateMachineId();
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
		expect(first).not.toBe("legacy-machine");
		expect(getOrCreateMachineId()).toBe(first);
	});

	test("refuses to rotate a damaged installation identity silently", () => {
		const root = isolatedClawdiHome();
		const identityPath = join(root, "machine.json");
		writeFileSync(identityPath, "{damaged\n");

		expect(() => getOrCreateMachineId()).toThrow("clawdi agent reconnect");
		expect(readFileSync(identityPath, "utf8")).toBe("{damaged\n");
	});
});

function isolatedClawdiHome(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-machine-identity-"));
	roots.push(root);
	process.env.CLAWDI_HOME = root;
	return root;
}
