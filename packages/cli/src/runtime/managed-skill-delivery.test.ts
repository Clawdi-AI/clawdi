import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectManagedSkillTree, withManagedTargetRollback } from "./managed-skill-delivery";

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
