import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { managedSkillDirectoryDigest } from "./hosted-bundled-skill";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

const MAX_ENTRIES = 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;

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
	const files = new Map<string, Buffer>();
	let entries = 0;
	let totalBytes = 0;
	const visit = (directory: string, prefix = ""): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			entries += 1;
			if (entries > MAX_ENTRIES || entry.isSymbolicLink()) throw new Error("unsafe Skill tree");
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path, relative);
			else if (entry.isFile()) {
				const bytes = readFileSync(path);
				totalBytes += bytes.byteLength;
				if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TREE_BYTES)
					throw new Error("oversized Skill tree");
				if (!options.exclude?.has(relative)) files.set(relative, bytes);
			} else throw new Error("unsupported Skill entry");
		}
	};
	try {
		visit(root);
		return { status: "collected", tree: files };
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

export function collectRuntimeUserManagedSkillTree(
	root: string,
	options: { exclude?: ReadonlySet<string> } = {},
): ManagedSkillTreeCollection {
	return withRuntimeUserFileAccess(() => collectManagedSkillTree(root, options));
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
	const installed = collectRuntimeUserManagedSkillTree(targetDir, options);
	return (
		source.status === "collected" &&
		installed.status === "collected" &&
		managedSkillTreesEqual(source.tree, installed.tree)
	);
}

export function withStagedManagedSkill<T>(
	skill: PreparedHostedSourcedSkill,
	operation: (sourceDir: string) => T,
): T {
	if (createHash("sha256").update(skill.tarBytes).digest("hex") !== skill.archiveSha256) {
		throw new ManagedSkillResourceError("prepared Skill archive digest mismatch");
	}
	const root = mkdtempSync(join(tmpdir(), "clawdi-managed-skill-"));
	try {
		const extracted = spawnSync("tar", ["-xzf", "-", "-C", root], {
			input: skill.tarBytes,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 1024 * 1024,
		});
		if (extracted.status !== 0) {
			throw new ManagedSkillResourceError("prepared Skill archive could not be staged");
		}
		const sourceDir = join(root, skill.skillId);
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
		if (
			skill.source.type === "bundled" &&
			managedSkillDirectoryDigest(sourceDir) !== skill.source.digest
		) {
			throw new ManagedSkillResourceError("prepared bundled Skill tree digest mismatch");
		}
		return operation(sourceDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export function installedTreeMatches(
	skill: PreparedHostedSourcedSkill,
	targetDir: string,
	options: { exclude?: ReadonlySet<string> } = {},
): boolean {
	return withStagedManagedSkill(skill, (sourceDir) =>
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
	const hadTarget = withRuntimeUserFileAccess(() => existsSync(input.target));
	let targetMoved = false;
	try {
		if (hadTarget) {
			withRuntimeUserFileAccess(() => rename(input.target, targetBackup));
			targetMoved = true;
		}
	} catch (error) {
		if (targetMoved) withRuntimeUserFileAccess(() => rename(targetBackup, input.target));
		throw error;
	}
	let result: T;
	try {
		result = input.operation();
	} catch (error) {
		withRuntimeUserFileAccess(() => remove(input.target, { recursive: true, force: true }));
		try {
			if (hadTarget) {
				input.beforeRestore?.();
				withRuntimeUserFileAccess(() => rename(targetBackup, input.target));
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
		withRuntimeUserFileAccess(() => remove(targetBackup, { recursive: true, force: true }));
	} catch {}
	return result;
}
