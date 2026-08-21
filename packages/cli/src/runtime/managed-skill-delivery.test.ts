import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	managedSkillReceiptMatchesIdentity,
	withManagedTargetRollback,
} from "./managed-skill-delivery";

test("restores an already-backed-up target when receipt backup establishment fails", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-rollback-"));
	try {
		const target = join(root, "skills", "review-pr");
		const receipt = join(root, "receipts", "review-pr.json");
		mkdirSync(target, { recursive: true });
		mkdirSync(join(root, "receipts"), { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "owned\n");
		writeFileSync(receipt, "receipt\n");
		let calls = 0;
		expect(() =>
			withManagedTargetRollback({
				target,
				receipt,
				operation: () => {
					throw new Error("must not run");
				},
				rename: (from, to) => {
					calls += 1;
					if (calls === 2) throw new Error("injected receipt backup failure");
					renameSync(from, to);
				},
			}),
		).toThrow("injected receipt backup failure");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("owned\n");
		expect(readFileSync(receipt, "utf8")).toBe("receipt\n");
		expect(existsSync(target)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("never treats a null fingerprint as ownership of an absent target", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-receipt-"));
	try {
		const receipt = join(root, "review-pr.json");
		writeFileSync(
			receipt,
			JSON.stringify({
				schemaVersion: "test.receipt.v2",
				skillId: "review-pr",
				ownershipIdentity: "github\0review-pr",
				treeFingerprint: null,
			}),
		);
		expect(
			managedSkillReceiptMatchesIdentity({
				path: receipt,
				schemaVersion: "test.receipt.v2",
				skillId: "review-pr",
				ownershipIdentity: "github\0review-pr",
				target: join(root, "absent-target"),
			}),
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("treats backup cleanup failure as GC after the operation commits", () => {
	const root = mkdtempSync(join(tmpdir(), "managed-skill-commit-"));
	try {
		const target = join(root, "skills", "review-pr");
		const receipt = join(root, "receipts", "review-pr.json");
		mkdirSync(target, { recursive: true });
		mkdirSync(join(root, "receipts"), { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "previous\n");
		writeFileSync(receipt, "previous receipt\n");

		expect(
			withManagedTargetRollback({
				target,
				receipt,
				operation: () => {
					mkdirSync(target, { recursive: true });
					writeFileSync(join(target, "SKILL.md"), "committed\n");
					writeFileSync(receipt, "committed receipt\n");
					return "installed" as const;
				},
				remove: () => {
					throw new Error("injected backup cleanup failure");
				},
			}),
		).toBe("installed");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("committed\n");
		expect(readFileSync(receipt, "utf8")).toBe("committed receipt\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
