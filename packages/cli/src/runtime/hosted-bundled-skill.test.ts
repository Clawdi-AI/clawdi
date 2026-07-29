import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	adoptableLegacyHostedBundledSkill,
	reconcileHostedBundledSkill,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";

const catalogEntry = resolveHostedBundledSkill("clawdi", 1);
const bundledSourceDir = resolve(import.meta.dir, "../../skills/hosted-versions/1/clawdi");

describe("hosted bundled skill reconciliation", () => {
	let root: string;
	let targetDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clawdi-hosted-bundled-skill-"));
		targetDir = join(root, "target", "clawdi");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function reconcile(sourceDir = bundledSourceDir) {
		return reconcileHostedBundledSkill({
			skillId: "clawdi",
			version: 1,
			sourceDir,
			targetDir,
		});
	}

	it("does not write when id, version, digest, and actual target content are unchanged", () => {
		expect(reconcile()).toBe("replaced");
		const markerPath = join(targetDir, ".clawdi-managed.json");
		expect(JSON.parse(readFileSync(markerPath, "utf-8"))).toEqual({
			schema: "clawdi.hostedBundledSkillMarker.v1",
			owner: "clawdi runtime init",
			id: "clawdi",
			version: 1,
			digest: catalogEntry.digest,
		});
		const targetInode = statSync(targetDir).ino;
		const skillInode = statSync(join(targetDir, "SKILL.md")).ino;
		const markerInode = statSync(markerPath).ino;
		const markerBytes = readFileSync(markerPath);

		expect(reconcile()).toBe("unchanged");
		expect(statSync(targetDir).ino).toBe(targetInode);
		expect(statSync(join(targetDir, "SKILL.md")).ino).toBe(skillInode);
		expect(statSync(markerPath).ino).toBe(markerInode);
		expect(readFileSync(markerPath)).toEqual(markerBytes);
	});

	it("atomically replaces drift, a different marker version, and a legacy ownership marker", () => {
		expect(reconcile()).toBe("replaced");
		const markerPath = join(targetDir, ".clawdi-managed.json");
		const initialTargetInode = statSync(targetDir).ino;
		writeFileSync(join(targetDir, "SKILL.md"), "tampered\n");
		writeFileSync(join(targetDir, "unexpected.txt"), "tampered\n");

		expect(reconcile()).toBe("replaced");
		expect(readFileSync(join(targetDir, "SKILL.md"))).toEqual(
			readFileSync(join(bundledSourceDir, "SKILL.md")),
		);
		expect(existsSync(join(targetDir, "unexpected.txt"))).toBe(false);
		expect(statSync(targetDir).ino).not.toBe(initialTargetInode);

		const currentMarker = JSON.parse(readFileSync(markerPath, "utf-8"));
		writeFileSync(markerPath, `${JSON.stringify({ ...currentMarker, version: 2 })}\n`);
		expect(reconcile()).toBe("replaced");
		expect(JSON.parse(readFileSync(markerPath, "utf-8")).version).toBe(1);

		writeFileSync(
			markerPath,
			`${JSON.stringify({ managedBy: "clawdi runtime init", skillName: "clawdi" })}\n`,
		);
		expect(reconcile()).toBe("replaced");
		expect(JSON.parse(readFileSync(markerPath, "utf-8"))).toEqual({
			schema: "clawdi.hostedBundledSkillMarker.v1",
			owner: "clawdi runtime init",
			id: "clawdi",
			version: 1,
			digest: catalogEntry.digest,
		});
		expect(readdirSync(join(root, "target"))).toEqual(["clawdi"]);
	});

	it("adopts an old marker only when catalog identity and live content match exactly", () => {
		expect(reconcile()).toBe("replaced");
		writeFileSync(
			join(targetDir, ".clawdi-managed.json"),
			`${JSON.stringify({ managedBy: "clawdi runtime init", skillName: "clawdi" })}\n`,
		);
		expect(adoptableLegacyHostedBundledSkill(targetDir, "clawdi")).toEqual(catalogEntry);
		writeFileSync(join(targetDir, "SKILL.md"), "tampered\n");
		expect(adoptableLegacyHostedBundledSkill(targetDir, "clawdi")).toBeNull();
	});

	it("detects target symlink tampering without following or modifying its destination", () => {
		expect(reconcile()).toBe("replaced");
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside\n");
		rmSync(join(targetDir, "SKILL.md"));
		symlinkSync(outside, join(targetDir, "SKILL.md"));

		expect(reconcile()).toBe("replaced");
		expect(readFileSync(outside, "utf-8")).toBe("outside\n");
		expect(statSync(join(targetDir, "SKILL.md")).isFile()).toBe(true);
		expect(readFileSync(join(targetDir, "SKILL.md"))).toEqual(
			readFileSync(join(bundledSourceDir, "SKILL.md")),
		);
	});

	it("repairs target group-write drift to the canonical mode", () => {
		expect(reconcile()).toBe("replaced");
		const targetSkill = join(targetDir, "SKILL.md");
		chmodSync(targetSkill, 0o664);

		expect(reconcile()).toBe("replaced");
		expect(statSync(targetSkill).mode & 0o777).toBe(0o644);
	});

	it("repairs target directory permission drift to the canonical mode", () => {
		expect(reconcile()).toBe("replaced");
		chmodSync(targetDir, 0o700);

		expect(reconcile()).toBe("replaced");
		expect(statSync(targetDir).mode & 0o777).toBe(0o755);
	});

	it("normalizes source group-write mode without changing bundle identity", () => {
		const copiedSource = join(root, "group-write-source");
		cpSync(bundledSourceDir, copiedSource, { recursive: true });
		chmodSync(join(copiedSource, "SKILL.md"), 0o664);

		expect(reconcile(copiedSource)).toBe("replaced");
		expect(statSync(join(targetDir, "SKILL.md")).mode & 0o777).toBe(0o644);
		expect(JSON.parse(readFileSync(join(targetDir, ".clawdi-managed.json"), "utf-8")).digest).toBe(
			catalogEntry.digest,
		);
	});

	it("fails closed when source regular-file permissions differ from the catalog", () => {
		const copiedSource = join(root, "mode-drift-source");
		cpSync(bundledSourceDir, copiedSource, { recursive: true });
		const copiedSkill = join(copiedSource, "SKILL.md");
		const sourceMode = statSync(copiedSkill).mode & 0o777;
		chmodSync(copiedSkill, sourceMode === 0o755 ? 0o644 : 0o755);

		expect(() => reconcile(copiedSource)).toThrow("catalog digest mismatch");
		expect(existsSync(targetDir)).toBe(false);
	});

	it("fails closed for source symlinks and catalog digest mismatch", () => {
		const copiedSource = join(root, "source");
		cpSync(bundledSourceDir, copiedSource, { recursive: true });
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside\n");
		symlinkSync(outside, join(copiedSource, "linked.txt"));
		expect(() => reconcile(copiedSource)).toThrow("symbolic links are not supported");
		expect(existsSync(targetDir)).toBe(false);

		rmSync(join(copiedSource, "linked.txt"));
		writeFileSync(join(copiedSource, "SKILL.md"), "catalog drift\n");
		expect(() => reconcile(copiedSource)).toThrow("catalog digest mismatch");
		expect(existsSync(targetDir)).toBe(false);
	});

	it("fails closed for unknown ids, unknown versions, and unmanaged targets", () => {
		expect(() =>
			reconcileHostedBundledSkill({
				skillId: "unknown",
				version: 1,
				sourceDir: bundledSourceDir,
				targetDir,
			}),
		).toThrow("no bundled hosted skill is registered for unknown");
		expect(() =>
			reconcileHostedBundledSkill({
				skillId: "clawdi",
				version: 2,
				sourceDir: bundledSourceDir,
				targetDir,
			}),
		).toThrow("no bundled hosted skill clawdi version 2 is registered");

		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "SKILL.md"), "user owned\n");
		expect(() => reconcile()).toThrow(`refusing to replace unmanaged clawdi skill at ${targetDir}`);
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toBe("user owned\n");
		expect(existsSync(join(targetDir, ".clawdi-managed.json"))).toBe(false);
	});
});
