import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { collectRegularFileTree } from "../lib/file-tree";
import { extractTarGzSync } from "../lib/tar";
import { MANAGED_SKILL_TREE_LIMITS, managedSkillDirectoryDigest } from "./hosted-bundled-skill";
import type { PreparedHostedSkill } from "./hosted-sourced-skill-archive";

export class ManagedSkillResourceError extends Error {}

export type ManagedSkillTree = ReadonlyMap<string, Buffer>;

export type ManagedSkillTreeCollection =
	| { status: "collected"; tree: ManagedSkillTree }
	| { status: "absent" }
	| { status: "unsafe" };

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function collectManagedSkillTree(
	root: string,
	options: { exclude?: ReadonlySet<string> } = {},
): ManagedSkillTreeCollection {
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(root);
	} catch (error) {
		return { status: isMissingPathError(error) ? "absent" : "unsafe" };
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { status: "unsafe" };
	try {
		const files = collectRegularFileTree(root, {
			limits: MANAGED_SKILL_TREE_LIMITS,
			exclude: (path) => options.exclude?.has(path) === true,
			resourceLabel: "managed Skill tree",
		});
		return { status: "collected", tree: new Map(files.map((file) => [file.path, file.bytes])) };
	} catch (error) {
		if (isMissingPathError(error)) {
			try {
				lstatSync(root);
			} catch (rootError) {
				if (isMissingPathError(rootError)) return { status: "absent" };
			}
		}
		return { status: "unsafe" };
	}
}

export function managedSkillTreesEqual(left: ManagedSkillTree, right: ManagedSkillTree): boolean {
	if (left.size !== right.size) return false;
	for (const [name, bytes] of left) if (!right.get(name)?.equals(bytes)) return false;
	return true;
}

export function managedSkillTargetMatchesSource(
	sourceDir: string,
	targetDir: string,
	options: { exclude?: ReadonlySet<string> } = {},
): boolean {
	const source = collectManagedSkillTree(sourceDir);
	const installed = collectManagedSkillTree(targetDir, options);
	return (
		source.status === "collected" &&
		installed.status === "collected" &&
		managedSkillTreesEqual(source.tree, installed.tree)
	);
}

export function withPreparedHostedSkill<T>(
	skill: PreparedHostedSkill,
	operation: (sourceDir: string) => T,
): T {
	const root = mkdtempSync(join(tmpdir(), "clawdi-managed-skill-"));
	try {
		const sourceDir = join(root, skill.id);
		if ("sourceDir" in skill) {
			try {
				if (
					!existsSync(join(skill.sourceDir, "SKILL.md")) ||
					managedSkillDirectoryDigest(skill.sourceDir) !== skill.identity.digest
				) {
					throw new ManagedSkillResourceError("prepared bundled Skill tree digest mismatch");
				}
				cpSync(skill.sourceDir, sourceDir, { recursive: true });
			} catch (error) {
				if (error instanceof ManagedSkillResourceError) throw error;
				throw new ManagedSkillResourceError("prepared bundled Skill could not be staged");
			}
		} else {
			if (createHash("sha256").update(skill.tarBytes).digest("hex") !== skill.identity.digest) {
				throw new ManagedSkillResourceError("prepared Skill archive digest mismatch");
			}
			try {
				extractTarGzSync(root, skill.tarBytes);
			} catch {
				throw new ManagedSkillResourceError("prepared Skill archive could not be staged");
			}
		}
		const sourceTree = collectManagedSkillTree(sourceDir);
		if (!existsSync(join(sourceDir, "SKILL.md")) || sourceTree.status !== "collected") {
			throw new ManagedSkillResourceError(`prepared Skill archive is ${sourceTree.status}`);
		}
		const makeReadable = (path: string): void => {
			const node = lstatSync(path);
			if (node.isDirectory()) {
				chmodSync(path, 0o755);
				for (const entry of readdirSync(path)) makeReadable(join(path, entry));
			} else chmodSync(path, node.mode & 0o111 ? 0o755 : 0o644);
		};
		makeReadable(root);
		return operation(sourceDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export function installedTreeMatches(
	skill: PreparedHostedSkill,
	targetDir: string,
	options: { exclude?: ReadonlySet<string> } = {},
): boolean {
	return withPreparedHostedSkill(skill, (sourceDir) =>
		managedSkillTargetMatchesSource(sourceDir, targetDir, options),
	);
}

export function withManagedTargetRollback<T>(input: {
	target: string;
	operation: () => T;
	targetBackup?: string;
	beforeRestore?: () => void;
	beforeCleanup?: () => void;
	restoreFailure?: (operationError: unknown, restoreError: unknown) => Error;
	rename?: typeof renameSync;
	remove?: typeof rmSync;
}): T {
	const rename = input.rename ?? renameSync;
	const remove = input.remove ?? rmSync;
	const suffix = randomBytes(8).toString("hex");
	const targetBackup =
		input.targetBackup ??
		join(dirname(input.target), `.${basename(input.target)}-clawdi-rollback-${suffix}`);
	const hadTarget = existsSync(input.target);
	let targetMoved = false;
	try {
		if (hadTarget) {
			rename(input.target, targetBackup);
			targetMoved = true;
		}
	} catch (error) {
		if (targetMoved) rename(targetBackup, input.target);
		throw error;
	}
	let result: T;
	try {
		result = input.operation();
	} catch (error) {
		remove(input.target, { recursive: true, force: true });
		try {
			if (hadTarget) {
				input.beforeRestore?.();
				rename(targetBackup, input.target);
			}
		} catch (restoreError) {
			if (input.restoreFailure) throw input.restoreFailure(error, restoreError);
			throw restoreError;
		}
		throw error;
	}
	// The operation returning is the commit point. Backup cleanup is GC and
	// must never roll back a live target.
	try {
		if (hadTarget) input.beforeCleanup?.();
		remove(targetBackup, { recursive: true, force: true });
	} catch {}
	return result;
}
