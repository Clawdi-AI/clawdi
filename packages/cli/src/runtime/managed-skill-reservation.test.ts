import { afterEach, describe, expect, it } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { managedSkillDirectoryDigest } from "./hosted-bundled-skill";
import {
	installReservedManagedSkill,
	managedSkillReservationState,
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
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

	it("accepts the canonical Project Skill source identity", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		const path = target();
		const sourceIdentity = [
			"clawdi",
			"example",
			"22222222-2222-4222-8222-222222222222",
			"a".repeat(64),
		].join("\0");

		expect(
			reserveManagedSkill({
				targetDir: path,
				id: "example",
				manager: "hosted-manifest",
				sourceIdentity,
			}),
		).toBe("created");
		expect(managedSkillReservationState(path, "example")).toBe("reserved");
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

	it("records legacy migration independently for each canonical target", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const existing = join(root, "one", "skills", "clawdi");
		const absent = join(root, "two", "skills", "clawdi");
		cpSync(resolve(import.meta.dir, "../../skills/clawdi"), existing, { recursive: true });

		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: existing,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("adopted");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: absent,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("absent");
		expect(managedSkillReservationState(existing, "clawdi")).toBe("reserved");

		mkdirSync(absent, { recursive: true });
		writeFileSync(join(absent, "SKILL.md"), "# Future user Skill\n");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: absent,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");
		expect(managedSkillReservationState(absent, "clawdi")).toBe("unreserved");
	});

	it("records custom same-name content as unmanaged instead of adopting it", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const custom = join(root, "one", "skills", "clawdi");
		mkdirSync(custom, { recursive: true });
		writeFileSync(join(custom, "SKILL.md"), "---\nname: clawdi\ndescription: User Skill\n---\n");

		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: custom,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("unmanaged");
		expect(managedSkillReservationState(custom, "clawdi")).toBe("unreserved");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: custom,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");
	});

	it("completes legacy migration when custom same-name content cannot be digested", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const custom = join(root, "one", "skills", "clawdi");
		mkdirSync(custom, { recursive: true });
		writeFileSync(join(custom, "SKILL.md"), "# User Skill\n");
		symlinkSync("SKILL.md", join(custom, "unsupported-link"));

		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: custom,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("unmanaged");
		expect(managedSkillReservationState(custom, "clawdi")).toBe("unreserved");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: custom,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");
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

	it("preserves the previous target when activation and restore both fail", () => {
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
					digest: "3".repeat(64),
					manager: "local-setup",
				},
				() =>
					replaceManagedSkillDirectoryAtomic(source, path, {
						beforeActivate: () => {
							throw new Error("activation failed");
						},
						beforeRestore: () => {
							throw new Error("restore failed");
						},
					}),
			),
		).toThrow(
			/activation failed.*restore failed.*previous version retained as a recovery artifact/,
		);

		expect(existsSync(path)).toBe(false);
		const recovery = readdirSync(dirname(path)).find((entry) =>
			entry.startsWith(`.${basename(path)}-previous-`),
		);
		expect(recovery).toBeDefined();
		if (!recovery) throw new Error("expected recovery artifact");
		expect(readFileSync(join(dirname(path), recovery, "SKILL.md"), "utf8")).toBe("# Example\n");
		expect(managedSkillReservationState(path, "example")).toBe("unreserved");
	});

	it("keeps committed ownership when previous-target cleanup fails", () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		process.env.HOME = root;
		const source = join(root, "source");
		const path = target();
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "SKILL.md"), "# Updated\n");

		installReservedManagedSkill(
			{
				targetDir: path,
				id: "example",
				version: 2,
				digest: "4".repeat(64),
				manager: "local-setup",
			},
			() =>
				replaceManagedSkillDirectoryAtomic(source, path, {
					beforeCleanup: () => {
						throw new Error("cleanup failed");
					},
				}),
		);

		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("# Updated\n");
		expect(managedSkillReservationState(path, "example")).toBe("reserved");
		expect(
			readdirSync(dirname(path)).some((entry) => entry.startsWith(`.${basename(path)}-previous-`)),
		).toBe(true);
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

	it("linearizes user target commits after a concurrent reservation install", async () => {
		root = mkdtempSync(join(tmpdir(), "skill-reservation-"));
		const path = join(root, "skills", "example");
		const ready = join(root, "reservation-ready");
		const moduleUrl = new URL("./managed-skill-reservation.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { mkdirSync, writeFileSync } from "node:fs";
const { installReservedManagedSkill } = await import(${JSON.stringify(moduleUrl)});
installReservedManagedSkill(${JSON.stringify({
					targetDir: path,
					id: "example",
					version: 1,
					digest: "5".repeat(64),
					manager: "local-setup",
				})}, () => {
  mkdirSync(${JSON.stringify(path)}, { recursive: true });
  writeFileSync(${JSON.stringify(join(path, "SKILL.md"))}, "# Managed\\n");
  writeFileSync(${JSON.stringify(ready)}, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
});`,
			],
			{
				env: {
					...process.env,
					HOME: root,
					CLAWDI_RUNTIME_MODE: "",
					CLAWDI_SERVICE_STATE_DIR: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
			await Bun.sleep(10);
		}
		expect(existsSync(ready)).toBe(true);
		process.env.HOME = root;
		delete process.env.CLAWDI_RUNTIME_MODE;
		delete process.env.CLAWDI_SERVICE_STATE_DIR;

		expect(() =>
			mutateUserSkillTarget(path, "example", () => rmSync(path, { recursive: true, force: true })),
		).toThrow("reserved by a managed Skill owner");
		expect(await child.exited).toBe(0);
		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("# Managed\n");
		expect(() =>
			mutateUserSkillTarget(path, "example", () =>
				writeFileSync(join(path, "SKILL.md"), "# Overwritten\n"),
			),
		).toThrow("reserved by a managed Skill owner");

		releaseManagedSkill({
			targetDir: path,
			id: "example",
			manager: "local-setup",
			removeTarget: () => undefined,
		});
		mutateUserSkillTarget(path, "example", () => writeFileSync(join(path, "SKILL.md"), "# User\n"));
		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("# User\n");
	});
});
