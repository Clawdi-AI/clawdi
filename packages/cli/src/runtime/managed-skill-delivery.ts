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
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";

const MAX_ENTRIES = 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;

export type ManagedSkillTree = ReadonlyMap<string, Buffer>;

export function collectManagedSkillTree(
	root: string,
	options: { exclude?: ReadonlySet<string> } = {},
): ManagedSkillTree | null {
	if (!existsSync(root)) return null;
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
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
		return files;
	} catch {
		return null;
	}
}

export function managedSkillTreeFingerprint(tree: ManagedSkillTree | null): string | null {
	if (!tree) return null;
	const hash = createHash("sha256");
	for (const [name, bytes] of [...tree].sort(([left], [right]) => left.localeCompare(right)))
		hash.update(name).update("\0").update(bytes).update("\0");
	return hash.digest("hex");
}

export function managedSkillTreesEqual(
	left: ManagedSkillTree | null,
	right: ManagedSkillTree | null,
): boolean {
	if (!left || !right || left.size !== right.size) return false;
	for (const [name, bytes] of left) if (!right.get(name)?.equals(bytes)) return false;
	return true;
}

type ManagedSkillReceipt = {
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	treeFingerprint: string;
};

export function writeManagedSkillReceipt(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): void {
	const treeFingerprint = managedSkillTreeFingerprint(
		collectManagedSkillTree(input.target, { exclude: input.exclude }),
	);
	if (!treeFingerprint) throw new Error("installed Skill tree is unsafe");
	const receipt: ManagedSkillReceipt = {
		schemaVersion: input.schemaVersion,
		skillId: input.skillId,
		ownershipIdentity: input.ownershipIdentity,
		treeFingerprint,
	};
	writePrivateFileAtomic(input.path, `${JSON.stringify(receipt)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
}

function readManagedSkillReceipt(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): ManagedSkillReceipt | null {
	try {
		const receipt = JSON.parse(readFileSync(input.path, "utf8")) as Record<string, unknown>;
		if (
			receipt.schemaVersion === input.schemaVersion &&
			receipt.skillId === input.skillId &&
			typeof receipt.ownershipIdentity === "string" &&
			receipt.ownershipIdentity.length > 0 &&
			receipt.ownershipIdentity.length <= 2048 &&
			typeof receipt.treeFingerprint === "string" &&
			/^[a-f0-9]{64}$/.test(receipt.treeFingerprint) &&
			receipt.treeFingerprint ===
				managedSkillTreeFingerprint(
					collectManagedSkillTree(input.target, { exclude: input.exclude }),
				)
		)
			return receipt as ManagedSkillReceipt;
		return null;
	} catch {
		return null;
	}
}

export function managedSkillReceiptOwnsTarget(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): boolean {
	return readManagedSkillReceipt(input) !== null;
}

export function managedSkillReceiptMatchesIdentity(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): boolean {
	return readManagedSkillReceipt(input)?.ownershipIdentity === input.ownershipIdentity;
}

export function withStagedManagedSkill<T>(
	skill: PreparedHostedSourcedSkill,
	operation: (sourceDir: string) => T,
): T {
	const root = mkdtempSync(join(tmpdir(), "clawdi-managed-skill-"));
	try {
		const extracted = spawnSync("tar", ["-xzf", "-", "-C", root], {
			input: skill.tarBytes,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 1024 * 1024,
		});
		if (extracted.status !== 0) throw new Error("prepared Skill archive could not be staged");
		const sourceDir = join(root, skill.skillId);
		if (!existsSync(join(sourceDir, "SKILL.md")) || !collectManagedSkillTree(sourceDir))
			throw new Error("prepared Skill archive is invalid");
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

export function withManagedTargetRollback<T>(input: {
	target: string;
	receipt: string;
	operation: () => T;
	rename?: typeof renameSync;
}): T {
	const rename = input.rename ?? renameSync;
	const suffix = randomBytes(8).toString("hex");
	const targetBackup = `${input.target}.clawdi-rollback-${suffix}`;
	const receiptBackup = `${input.receipt}.clawdi-rollback-${suffix}`;
	const hadTarget = existsSync(input.target);
	const hadReceipt = existsSync(input.receipt);
	let targetMoved = false;
	let receiptMoved = false;
	try {
		if (hadTarget) {
			rename(input.target, targetBackup);
			targetMoved = true;
		}
		if (hadReceipt) {
			rename(input.receipt, receiptBackup);
			receiptMoved = true;
		}
	} catch (error) {
		if (receiptMoved) rename(receiptBackup, input.receipt);
		if (targetMoved) rename(targetBackup, input.target);
		throw error;
	}
	try {
		const result = input.operation();
		rmSync(targetBackup, { recursive: true, force: true });
		rmSync(receiptBackup, { force: true });
		return result;
	} catch (error) {
		rmSync(input.target, { recursive: true, force: true });
		rmSync(input.receipt, { force: true });
		if (hadTarget) rename(targetBackup, input.target);
		if (hadReceipt) rename(receiptBackup, input.receipt);
		throw error;
	}
}

export function withTargetTreeRollback<T>(input: { target: string; operation: () => T }): T {
	const backup = `${input.target}.clawdi-rollback-${randomBytes(8).toString("hex")}`;
	const hadTarget = existsSync(input.target);
	if (hadTarget) renameSync(input.target, backup);
	try {
		const result = input.operation();
		rmSync(backup, { recursive: true, force: true });
		return result;
	} catch (error) {
		rmSync(input.target, { recursive: true, force: true });
		if (hadTarget) renameSync(backup, input.target);
		throw error;
	}
}
