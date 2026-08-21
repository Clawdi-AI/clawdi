import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { managedSkillDirectoryDigest } from "./hosted-bundled-skill";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

const MAX_ENTRIES = 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MANAGED_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LEGACY_RECEIPT_DIRECTORY = ".clawdi-manifest-receipts";
const PLATFORM_RECEIPT_DIRECTORY = "skill-receipts";

export const HERMES_MANAGED_SKILL_RECEIPT_SCHEMA = "clawdi.hermesManifestSkillReceipt.v2";
export const OPENCLAW_MANAGED_SKILL_RECEIPT_SCHEMA = "clawdi.openclawManifestSkillReceipt.v2";
export type ManagedSkillReceiptRuntime = "hermes" | "openclaw";

export class ManagedSkillResourceError extends Error {}

function assertManagedSkillId(skillId: string): void {
	if (!MANAGED_SKILL_ID_PATTERN.test(skillId)) {
		throw new Error(`invalid managed Skill id: ${skillId}`);
	}
}

export function managedSkillReceiptPath(
	managedResourceRoot: string,
	runtime: ManagedSkillReceiptRuntime,
	skillId: string,
): string {
	assertManagedSkillId(skillId);
	return join(managedResourceRoot, PLATFORM_RECEIPT_DIRECTORY, runtime, `${skillId}.json`);
}

export function legacyManagedSkillReceiptPath(skillsRoot: string, skillId: string): string {
	assertManagedSkillId(skillId);
	return join(skillsRoot, LEGACY_RECEIPT_DIRECTORY, `${skillId}.json`);
}

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

export function managedSkillTreeFingerprint(tree: ManagedSkillTree): string {
	const hash = createHash("sha256");
	for (const [name, bytes] of [...tree].sort(([left], [right]) => left.localeCompare(right)))
		hash.update(name).update("\0").update(bytes).update("\0");
	return hash.digest("hex");
}

export function managedSkillTreesEqual(left: ManagedSkillTree, right: ManagedSkillTree): boolean {
	if (left.size !== right.size) return false;
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
	managedResourceRoot: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): void {
	const collection = collectRuntimeUserManagedSkillTree(input.target, { exclude: input.exclude });
	if (collection.status !== "collected") {
		throw new ManagedSkillResourceError(`installed Skill tree is ${collection.status}`);
	}
	const treeFingerprint = managedSkillTreeFingerprint(collection.tree);
	writeManagedSkillReceiptRecord(input.managedResourceRoot, input.path, {
		schemaVersion: input.schemaVersion,
		skillId: input.skillId,
		ownershipIdentity: input.ownershipIdentity,
		treeFingerprint,
	});
}

function writeManagedSkillReceiptRecord(
	managedResourceRoot: string,
	path: string,
	receipt: ManagedSkillReceipt,
): void {
	writePrivateFileAtomic(path, `${JSON.stringify(receipt)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
		trustedRoot: managedResourceRoot,
	});
}

function runtimeUserTargetIsDirectory(path: string): boolean {
	return withRuntimeUserFileAccess(() => {
		try {
			const target = lstatSync(path);
			return !target.isSymbolicLink() && target.isDirectory();
		} catch {
			return false;
		}
	});
}

function readManagedSkillMarkerRaw(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): ManagedSkillReceipt | null {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const receiptStat = fstatSync(descriptor);
		const effectiveUid = process.geteuid?.();
		if (
			!receiptStat.isFile() ||
			(receiptStat.mode & 0o022) !== 0 ||
			(effectiveUid !== undefined && receiptStat.uid !== effectiveUid)
		)
			return null;
		const receipt = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
		if (
			receipt.schemaVersion === input.schemaVersion &&
			receipt.skillId === input.skillId &&
			typeof receipt.ownershipIdentity === "string" &&
			receipt.ownershipIdentity.length > 0 &&
			receipt.ownershipIdentity.length <= 2048 &&
			typeof receipt.treeFingerprint === "string" &&
			/^[a-f0-9]{64}$/.test(receipt.treeFingerprint)
		)
			return receipt as ManagedSkillReceipt;
		return null;
	} catch {
		return null;
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
}

function readManagedSkillMarker(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): ManagedSkillReceipt | null {
	if (!runtimeUserTargetIsDirectory(input.target)) return null;
	return readManagedSkillMarkerRaw(input);
}

function readManagedSkillReceipt(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}):
	| { status: "matched"; receipt: ManagedSkillReceipt }
	| { status: "absent" | "unsafe" | "mismatch" } {
	const collection = collectRuntimeUserManagedSkillTree(input.target, {
		exclude: input.exclude,
	});
	if (collection.status !== "collected") return collection;
	const marker = readManagedSkillMarkerRaw(input);
	if (!marker || marker.treeFingerprint !== managedSkillTreeFingerprint(collection.tree)) {
		return { status: "mismatch" };
	}
	return { status: "matched", receipt: marker };
}

function realDirectoryWithin(root: string, path: string): boolean {
	const trustedRoot = resolve(root);
	const target = resolve(path);
	const child = relative(trustedRoot, target);
	if (child.startsWith("..") || isAbsolute(child)) {
		throw new Error(`legacy managed Skill receipt root is outside tenant HOME: ${path}`);
	}
	let current = trustedRoot;
	for (const segment of child ? ["", ...child.split("/")] : [""]) {
		if (segment) current = join(current, segment);
		try {
			const node = lstatSync(current);
			if (node.isSymbolicLink() || !node.isDirectory()) {
				throw new Error(`legacy managed Skill receipt path is unsafe: ${current}`);
			}
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	}
	return true;
}

/**
 * SUNSET(#1148): remove after every supported hosted CLI has migrated
 * tenant-home Skill receipts into the platform managed-resource root.
 */
export function migrateLegacyManagedSkillReceiptDirectory(input: {
	tenantHome: string;
	managedResourceRoot: string;
	runtime: ManagedSkillReceiptRuntime;
	skillsRoot: string;
}): void {
	if (!realDirectoryWithin(input.tenantHome, input.skillsRoot)) return;
	const legacyDirectory = join(input.skillsRoot, LEGACY_RECEIPT_DIRECTORY);
	let directory: ReturnType<typeof lstatSync>;
	try {
		directory = lstatSync(legacyDirectory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	if (directory.isSymbolicLink() || !directory.isDirectory()) {
		rmSync(legacyDirectory, { recursive: true, force: true });
		return;
	}

	const schemaVersion =
		input.runtime === "hermes"
			? HERMES_MANAGED_SKILL_RECEIPT_SCHEMA
			: OPENCLAW_MANAGED_SKILL_RECEIPT_SCHEMA;
	for (const entry of readdirSync(legacyDirectory, { withFileTypes: true })) {
		const match = /^([a-z0-9][a-z0-9._-]{0,63})\.json$/.exec(entry.name);
		if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
		const skillId = match[1];
		const legacyPath = join(legacyDirectory, entry.name);
		const target = join(input.skillsRoot, skillId);
		const receipt = readManagedSkillReceipt({
			path: legacyPath,
			schemaVersion,
			skillId,
			target,
			...(input.runtime === "openclaw"
				? { exclude: new Set([".openclaw/source-origin.json"]) }
				: {}),
		});
		if (receipt.status !== "matched") continue;
		const destination = managedSkillReceiptPath(input.managedResourceRoot, input.runtime, skillId);
		if (!existsSync(destination)) {
			writeManagedSkillReceiptRecord(input.managedResourceRoot, destination, receipt.receipt);
		}
	}
	// This directory was always Clawdi metadata. Invalid or unknown entries are
	// deliberately not promoted into platform ownership authority.
	rmSync(legacyDirectory, { recursive: true, force: true });
}

export function managedSkillMarkerOwnsTarget(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): boolean {
	return readManagedSkillMarker(input) !== null;
}

export function managedSkillMarkerMatchesIdentity(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): boolean {
	return readManagedSkillMarker(input)?.ownershipIdentity === input.ownershipIdentity;
}

export function managedSkillReceiptMatchesIdentity(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): boolean {
	return managedSkillReceiptIdentityState(input) === "matched";
}

export function managedSkillReceiptIdentityState(input: {
	path: string;
	schemaVersion: string;
	skillId: string;
	ownershipIdentity: string;
	target: string;
	exclude?: ReadonlySet<string>;
}): "matched" | "absent" | "unsafe" | "mismatch" {
	const result = readManagedSkillReceipt(input);
	if (result.status !== "matched") return result.status;
	return result.receipt.ownershipIdentity === input.ownershipIdentity ? "matched" : "mismatch";
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

export function withManagedTargetRollback<T>(input: {
	target: string;
	receipt?: string;
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
	const receiptBackup = input.receipt
		? join(dirname(input.receipt), `.${basename(input.receipt)}-clawdi-rollback-${suffix}`)
		: undefined;
	const hadTarget = withRuntimeUserFileAccess(() => existsSync(input.target));
	const hadReceipt = input.receipt !== undefined && existsSync(input.receipt);
	let targetMoved = false;
	let receiptMoved = false;
	try {
		if (hadTarget) {
			withRuntimeUserFileAccess(() => rename(input.target, targetBackup));
			targetMoved = true;
		}
		if (hadReceipt && input.receipt && receiptBackup) {
			rename(input.receipt, receiptBackup);
			receiptMoved = true;
		}
	} catch (error) {
		if (receiptMoved && input.receipt && receiptBackup) rename(receiptBackup, input.receipt);
		if (targetMoved) withRuntimeUserFileAccess(() => rename(targetBackup, input.target));
		throw error;
	}
	let result: T;
	try {
		result = input.operation();
	} catch (error) {
		withRuntimeUserFileAccess(() => remove(input.target, { recursive: true, force: true }));
		if (input.receipt) remove(input.receipt, { force: true });
		try {
			if (hadTarget) {
				input.beforeRestore?.();
				withRuntimeUserFileAccess(() => rename(targetBackup, input.target));
			}
			if (hadReceipt && input.receipt && receiptBackup) rename(receiptBackup, input.receipt);
		} catch (restoreError) {
			if (input.restoreFailure) throw input.restoreFailure(error, restoreError);
			throw restoreError;
		}
		throw error;
	}
	// The operation returning is the commit point. Backup cleanup is GC and
	// must never roll back a live target or its ownership receipt.
	try {
		if (hadTarget) input.beforeCleanup?.();
		withRuntimeUserFileAccess(() => remove(targetBackup, { recursive: true, force: true }));
		if (receiptBackup) remove(receiptBackup, { force: true });
	} catch {}
	return result;
}
