import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installReservedManagedSkill,
	managedSkillReservationState,
	releaseManagedSkill,
	replaceManagedSkillDirectoryAtomic,
	reserveManagedSkill,
	shouldIgnoreUserSkill,
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

	it("reports malformed ownership state instead of silently hiding Skills", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const path = target();
		const ledger = join(root, ".clawdi", "managed-resources", "managed-skills.json");
		mkdirSync(join(ledger, ".."), { recursive: true });
		writeFileSync(ledger, "not-json\n");

		expect(managedSkillReservationState(path, "example")).toBe("indeterminate");
		expect(() => shouldIgnoreUserSkill(path, "example")).toThrow(
			"managed Skill ownership state is invalid",
		);
	});

	it("atomically replaces stale files under an active reservation", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const source = join(root, "source");
		const path = target();
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "SKILL.md"), "# Updated\n");
		writeFileSync(join(path, "removed.txt"), "stale\n");

		installReservedManagedSkill(
			{
				targetDir: path,
				id: "example",
				version: 2,
				digest: "e".repeat(64),
				manager: "local-setup",
			},
			() => replaceManagedSkillDirectoryAtomic(source, path),
		);

		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("# Updated\n");
		expect(existsSync(join(path, "removed.txt"))).toBe(false);
		expect(managedSkillReservationState(path, "example")).toBe("reserved");
	});

	it("restores target and ownership when activation fails", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const source = join(root, "source");
		const path = target();
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "SKILL.md"), "# Updated\n");

		expect(() =>
			installReservedManagedSkill(
				{
					targetDir: path,
					id: "example",
					version: 2,
					digest: "f".repeat(64),
					manager: "local-setup",
				},
				() =>
					replaceManagedSkillDirectoryAtomic(source, path, {
						beforeActivate: () => {
							throw new Error("injected activation failure");
						},
					}),
			),
		).toThrow("injected activation failure");

		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("# Example\n");
		expect(managedSkillReservationState(path, "example")).toBe("unreserved");
	});

	it("serializes local writers so rollback cannot lose a concurrent reservation", async () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		const firstTarget = join(root, "skills", "first");
		const secondTarget = join(root, "skills", "second");
		const ready = join(root, "first-ready");
		const moduleUrl = new URL("./managed-skill-reservation.ts", import.meta.url).href;
		const childEnv = {
			...process.env,
			HOME: root,
			CLAWDI_RUNTIME_MODE: "",
			CLAWDI_SERVICE_STATE_DIR: "",
		};
		const first = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { writeFileSync } from "node:fs";
const { installReservedManagedSkill } = await import(${JSON.stringify(moduleUrl)});
try {
  installReservedManagedSkill(${JSON.stringify({
		targetDir: firstTarget,
		id: "first",
		version: 1,
		digest: "1".repeat(64),
		manager: "local-setup",
	})}, () => {
    writeFileSync(${JSON.stringify(ready)}, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    throw new Error("rollback");
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== "rollback") throw error;
}`,
			],
			{ env: childEnv, stdout: "pipe", stderr: "pipe" },
		);
		for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
			await Bun.sleep(10);
		}
		expect(existsSync(ready)).toBe(true);
		const second = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { reserveManagedSkill } = await import(${JSON.stringify(moduleUrl)});
reserveManagedSkill(${JSON.stringify({
					targetDir: secondTarget,
					id: "second",
					version: 1,
					digest: "2".repeat(64),
					manager: "local-setup",
				})});`,
			],
			{ env: childEnv, stdout: "pipe", stderr: "pipe" },
		);

		expect(await first.exited).toBe(0);
		expect(await second.exited).toBe(0);
		process.env.HOME = root;
		delete process.env.CLAWDI_RUNTIME_MODE;
		delete process.env.CLAWDI_SERVICE_STATE_DIR;
		expect(managedSkillReservationState(firstTarget, "first")).toBe("unreserved");
		expect(managedSkillReservationState(secondTarget, "second")).toBe("reserved");
	});
});
