import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHostedBundledSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	ManagedSkillResourceError,
	withManagedTargetRollback,
	withPreparedHostedSkill,
} from "./managed-skill-delivery";

test("distinguishes an absent Skill tree from an unsafe tree", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-collection-"));
	try {
		const absent = join(root, "absent");
		const unsafe = join(root, "unsafe");
		symlinkSync(absent, unsafe);

		expect(collectManagedSkillTree(absent)).toEqual({ status: "absent" });
		expect(collectManagedSkillTree(unsafe)).toEqual({ status: "unsafe" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preserves the cause, errno, and path when bundled Skill staging fails", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-staging-error-"));
	const sourceDir = join(root, "clawdi");
	const blocked = join(sourceDir, "blocked");
	try {
		mkdirSync(blocked, { recursive: true });
		writeFileSync(join(sourceDir, "SKILL.md"), "# Clawdi\n");
		writeFileSync(join(blocked, "resource.txt"), "private\n");
		chmodSync(blocked, 0o000);
		const prepared = { ...prepareHostedBundledSkill("clawdi", 1), sourceDir };
		let failure: unknown;
		try {
			withPreparedHostedSkill(prepared, () => undefined);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ManagedSkillResourceError);
		if (!(failure instanceof ManagedSkillResourceError)) return;
		expect(failure.cause).toBeInstanceOf(Error);
		expect(failure.message).toContain("EACCES");
		expect(failure.message).toContain(blocked);
	} finally {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("treats backup cleanup failure as GC after the operation commits", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-commit-"));
	try {
		const target = join(root, "skills", "review-pr");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "previous\n");

		expect(
			withManagedTargetRollback({
				target,
				operation: () => {
					mkdirSync(target, { recursive: true });
					writeFileSync(join(target, "SKILL.md"), "committed\n");
					return "installed" as const;
				},
				remove: () => {
					throw new Error("injected backup cleanup failure");
				},
			}),
		).toBe("installed");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("committed\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
