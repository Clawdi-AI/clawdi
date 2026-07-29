import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	managedSkillReservationState,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";

const originalHome = process.env.HOME;
const originalMode = process.env.CLAWDI_RUNTIME_MODE;
const originalState = process.env.CLAWDI_SERVICE_STATE_DIR;
let root = "";

function target(parent = "one"): string {
	const path = join(root, parent, "skills", "example");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), "# Example\n");
	return path;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalMode === undefined) delete process.env.CLAWDI_RUNTIME_MODE;
	else process.env.CLAWDI_RUNTIME_MODE = originalMode;
	if (originalState === undefined) delete process.env.CLAWDI_SERVICE_STATE_DIR;
	else process.env.CLAWDI_SERVICE_STATE_DIR = originalState;
});

describe("managed Skill reservations", () => {
	it("reserves the exact target path rather than every matching id", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		delete process.env.CLAWDI_RUNTIME_MODE;
		delete process.env.CLAWDI_SERVICE_STATE_DIR;
		const first = target("one");
		const second = target("two");
		reserveManagedSkill({
			targetDir: first,
			id: "example",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		expect(managedSkillReservationState(first, "example")).toBe("reserved");
		expect(managedSkillReservationState(second, "example")).toBe("unreserved");
	});

	it("does not treat a forged co-located marker as authority", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const path = target();
		writeFileSync(join(path, ".clawdi-managed.json"), '{"id":"example"}\n');
		expect(managedSkillReservationState(path, "example")).toBe("unreserved");
	});

	it("persists authority before target mutation and releases only after cleanup", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		const path = target();
		reserveManagedSkill({
			targetDir: path,
			id: "example",
			manager: "hosted-manifest",
			version: 2,
			digest: "b".repeat(64),
		});
		expect(managedSkillReservationState(path, "example")).toBe("reserved");
		releaseManagedSkill({
			targetDir: path,
			id: "example",
			manager: "hosted-manifest",
			removeTarget: () => {
				expect(managedSkillReservationState(path, "example")).toBe("reserved");
				rmSync(path, { recursive: true, force: true });
			},
		});
		expect(existsSync(path)).toBe(false);
		expect(managedSkillReservationState(path, "example")).toBe("unreserved");
	});

	it("does not let another manager replace or release ownership", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const path = target();
		reserveManagedSkill({
			targetDir: path,
			id: "example",
			manager: "local-setup",
			version: 1,
			digest: "c".repeat(64),
		});
		expect(() =>
			reserveManagedSkill({
				targetDir: path,
				id: "example",
				manager: "hosted-manifest",
				version: 1,
				digest: "c".repeat(64),
			}),
		).toThrow("different manager");
		expect(() =>
			releaseManagedSkill({
				targetDir: path,
				id: "example",
				manager: "hosted-manifest",
				removeTarget: () => rmSync(path, { recursive: true, force: true }),
			}),
		).toThrow("identity mismatch");
		expect(existsSync(path)).toBe(true);
	});

	it("rejects an invalid identity before it can poison the ledger", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const path = target();
		expect(() =>
			reserveManagedSkill({
				targetDir: path,
				id: "example",
				manager: "local-setup",
				version: 1,
				digest: "not-a-sha256",
			}),
		).toThrow("identity is invalid");
		expect(managedSkillReservationState(path, "example")).toBe("unreserved");
	});
});
