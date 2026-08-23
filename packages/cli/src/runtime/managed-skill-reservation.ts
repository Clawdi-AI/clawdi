import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getClawdiDir } from "../lib/config";
import { withPrivateDirectoryLockSync } from "../lib/private-directory-lock";
import { writePrivateFileAtomic } from "../lib/private-file";
import { withRuntimeConvergeLock } from "./converge-lock";
import { ManagedSkillResourceError, withManagedTargetRollback } from "./managed-skill-delivery";
import { getRuntimePaths } from "./paths";
import { withRuntimeUserFileAccess } from "./runtime-user-command";
import { runtimePlatformRootForPath, writeRuntimePlatformFileAtomic } from "./state";

const LEDGER_FILE = "managed-skills.json";
const LEDGER_SCHEMA = "clawdi.managedSkillReservations.v1";
const MANAGED_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCED_MANAGED_SKILL_TARGET_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_SOURCED_MANAGED_SKILL_TARGETS = new Set([
	"skill",
	"readme",
	"index",
	"unnamed-skill",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// Exact local bundled Skill trees shipped by published CLI releases before the
// ownership ledger. Pre-ledger installs had no marker, so content is the only
// durable identity proof available for one-time adoption.
const LEGACY_LOCAL_SETUP_SKILL_DIGESTS = new Set([
	"954d8b81e67138cb59385353490679d191451d5d36bfe461571f91db43fb4bb4",
	"b89cad1fa72e8b90b65b579e86e3fe57730b0d349710b13b192794d3862010bf",
	"5719cc8e5dbdf4f3b7ff732589d3b23883fbead713652434a5e765c17308708a",
	"2bb89a1ba5b546ea75cbc07351908aabdd19e3abc6fa4f3af0e83bb7fbda36d6",
	"c8ce517615d7d8919d6149afee7b5702c39e157c5684b94b6fb365e3fc9644e7",
	"ed7f4415a7a024990b7ce4d94040ce06621c5182ac42434b6eb6a19abefd5043",
	"cd66a3403006f5da4dfa61d8e03be0324e8a79ec9e0012e693d044fd8436cd40",
	"872c56a22685709fc6f7a77a167fe5695bce459a6cdba0551f88e00f1c53d814",
	"4350e8e0fa37b6a4825e11361f88c7849e9b76050586fcb765e8e19f77dec28c",
]);

export type ManagedSkillReservationManager = "hosted-manifest" | "local-setup";

interface ManagedSkillReservation {
	target: string;
	id: string;
	version?: number;
	/** Hosted archive SHA-256 after convergence, or a local-setup directory digest. */
	digest?: string;
	sourceIdentity?: string;
	manager: ManagedSkillReservationManager;
}

export interface ManagedSkillReservationSnapshot {
	targetDir: string;
	id: string;
	version?: number;
	digest?: string;
	sourceIdentity?: string;
}

interface ManagedSkillReservationLedger {
	schemaVersion: typeof LEDGER_SCHEMA;
	reservations: Record<string, ManagedSkillReservation>;
	pendingReservations: Record<string, PendingManagedSkillReservation>;
	localSetupMigrations: Record<string, { target: string; id: string }>;
}

interface PendingManagedSkillReservation extends ManagedSkillReservation {
	previousTarget?: string;
}

export interface PendingManagedSkillReservationSnapshot extends ManagedSkillReservationSnapshot {
	previousTargetDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerPath(): string {
	const root = process.env.CLAWDI_SERVICE_STATE_DIR?.trim();
	const mode = process.env.CLAWDI_RUNTIME_MODE?.trim().toLowerCase();
	if (mode === "hosted" || root) {
		return join(getRuntimePaths({ mode: "hosted" }).managedResourceRoot, LEDGER_FILE);
	}
	return join(getClawdiDir(), "managed-resources", LEDGER_FILE);
}

export function managedSkillReservationLedgerPath(): string {
	return ledgerPath();
}

function legacyHostedLedgerPath(path: string): string | null {
	const runtimePaths = getRuntimePaths({ mode: "hosted" });
	return path === join(runtimePaths.managedResourceRoot, LEDGER_FILE)
		? join(runtimePaths.projectionRoot, LEDGER_FILE)
		: null;
}

function emptyLedger(): ManagedSkillReservationLedger {
	return {
		schemaVersion: LEDGER_SCHEMA,
		reservations: {},
		pendingReservations: {},
		localSetupMigrations: {},
	};
}

function validSourcedManagedSkillTarget(value: string): boolean {
	const candidate = value.toLowerCase();
	return (
		SOURCED_MANAGED_SKILL_TARGET_PATTERN.test(candidate) &&
		!RESERVED_SOURCED_MANAGED_SKILL_TARGETS.has(candidate)
	);
}

function reservationTargetMatchesIdentity(
	target: string,
	value: { id?: unknown; sourceIdentity?: unknown; manager?: unknown },
): boolean {
	const targetName = basename(target);
	return (
		targetName === value.id ||
		(value.manager === "hosted-manifest" &&
			typeof value.sourceIdentity === "string" &&
			validSourcedManagedSkillTarget(targetName))
	);
}

function parseReservation(target: string, raw: unknown): ManagedSkillReservation {
	if (
		!isRecord(raw) ||
		raw.target !== target ||
		resolve(target) !== target ||
		typeof raw.id !== "string" ||
		!reservationTargetMatchesIdentity(target, raw) ||
		!MANAGED_SKILL_ID_PATTERN.test(raw.id) ||
		(raw.version !== undefined &&
			(typeof raw.version !== "number" ||
				!Number.isSafeInteger(raw.version) ||
				raw.version <= 0)) ||
		!reservationIdentityIsValid(raw) ||
		(raw.manager !== "hosted-manifest" && raw.manager !== "local-setup")
	) {
		throw new Error("managed Skill ownership state is invalid");
	}
	return {
		target,
		id: raw.id,
		version: raw.version,
		digest: typeof raw.digest === "string" ? raw.digest : undefined,
		sourceIdentity: typeof raw.sourceIdentity === "string" ? raw.sourceIdentity : undefined,
		manager: raw.manager,
	};
}

function readLedger(path: string): ManagedSkillReservationLedger {
	const legacyPath = legacyHostedLedgerPath(path);
	const sourcePath = existsSync(path)
		? path
		: legacyPath && existsSync(legacyPath)
			? legacyPath
			: null;
	if (!sourcePath) return emptyLedger();
	let value: unknown;
	try {
		const stat = lstatSync(sourcePath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
		value = JSON.parse(readFileSync(sourcePath, "utf8"));
	} catch {
		throw new Error("managed Skill ownership state is invalid");
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== LEDGER_SCHEMA ||
		!isRecord(value.reservations) ||
		(value.pendingReservations !== undefined && !isRecord(value.pendingReservations)) ||
		(value.localSetupMigrations !== undefined && !isRecord(value.localSetupMigrations))
	) {
		throw new Error("managed Skill ownership state is invalid");
	}
	const reservations: Record<string, ManagedSkillReservation> = {};
	for (const [target, raw] of Object.entries(value.reservations)) {
		reservations[target] = parseReservation(target, raw);
	}
	const pendingReservations: Record<string, PendingManagedSkillReservation> = {};
	try {
		for (const [target, raw] of Object.entries(value.pendingReservations ?? {})) {
			const reservation = parseReservation(target, raw);
			if (
				!isRecord(raw) ||
				(raw.previousTarget !== undefined &&
					(typeof raw.previousTarget !== "string" ||
						resolve(raw.previousTarget) !== raw.previousTarget))
			) {
				throw new Error("invalid pending reservation");
			}
			pendingReservations[target] = {
				...reservation,
				previousTarget: typeof raw.previousTarget === "string" ? raw.previousTarget : undefined,
			};
		}
	} catch {
		throw new Error("managed Skill ownership state is invalid");
	}
	const localSetupMigrations: Record<string, { target: string; id: string }> = {};
	for (const [target, raw] of Object.entries(value.localSetupMigrations ?? {})) {
		if (
			!isRecord(raw) ||
			raw.target !== target ||
			resolve(target) !== target ||
			typeof raw.id !== "string" ||
			basename(target) !== raw.id ||
			!MANAGED_SKILL_ID_PATTERN.test(raw.id)
		) {
			throw new Error("managed Skill ownership state is invalid");
		}
		localSetupMigrations[target] = { target, id: raw.id };
	}
	return { schemaVersion: LEDGER_SCHEMA, reservations, pendingReservations, localSetupMigrations };
}

function writeLedger(path: string, ledger: ManagedSkillReservationLedger): void {
	const content = `${JSON.stringify(ledger, null, 2)}\n`;
	const runtimePaths = getRuntimePaths({ mode: "hosted" });
	const options = { mode: 0o644, dirMode: 0o755 };
	if (runtimePlatformRootForPath(runtimePaths, path)) {
		writeRuntimePlatformFileAtomic(runtimePaths, path, content, options);
	} else {
		writePrivateFileAtomic(path, content, options);
	}
}

function withLedgerWriteLock<T>(manager: ManagedSkillReservationManager, write: () => T): T {
	// Hosted writers already run under the global runtime converge lock. Local
	// setup and teardown use a private user-state lock so concurrent commands
	// cannot lose reservations without chmod'ing the hosted projection parent.
	if (manager === "hosted-manifest") return write();
	return withPrivateDirectoryLockSync(join(getClawdiDir(), "locks", "managed-skills.lock"), () =>
		write(),
	);
}

export function managedSkillReservationState(
	targetDir: string,
	skillId = basename(targetDir),
): "unreserved" | "reserved" | "indeterminate" {
	const owner = managedSkillReservationOwner(targetDir, skillId);
	return owner === "unreserved" || owner === "indeterminate" ? owner : "reserved";
}

export function managedSkillReservationOwner(
	targetDir: string,
	skillId = basename(targetDir),
): ManagedSkillReservationManager | "unreserved" | "indeterminate" {
	const path = ledgerPath();
	try {
		const reservation = readLedger(path).reservations[resolve(targetDir)];
		return reservation?.id === skillId ? reservation.manager : "unreserved";
	} catch {
		return "indeterminate";
	}
}

export function managedSkillReservations(
	manager: ManagedSkillReservationManager,
): ManagedSkillReservationSnapshot[] {
	const ledger = readLedger(ledgerPath());
	return Object.values(ledger.reservations)
		.filter((reservation) => reservation.manager === manager)
		.map((reservation) => ({
			targetDir: reservation.target,
			id: reservation.id,
			version: reservation.version,
			digest: reservation.digest,
			sourceIdentity: reservation.sourceIdentity,
		}))
		.sort((left, right) => left.targetDir.localeCompare(right.targetDir));
}

export function pendingManagedSkillReservations(
	manager: ManagedSkillReservationManager,
): PendingManagedSkillReservationSnapshot[] {
	return Object.values(readLedger(ledgerPath()).pendingReservations)
		.filter((reservation) => reservation.manager === manager)
		.map((reservation) => ({
			targetDir: reservation.target,
			previousTargetDir: reservation.previousTarget,
			id: reservation.id,
			version: reservation.version,
			digest: reservation.digest,
			sourceIdentity: reservation.sourceIdentity,
		}))
		.sort((left, right) => left.targetDir.localeCompare(right.targetDir));
}

function reservationIdentityIsValid(value: {
	digest?: unknown;
	sourceIdentity?: unknown;
	manager?: unknown;
}): boolean {
	const hasDigest = typeof value.digest === "string" && SHA256_PATTERN.test(value.digest);
	const hasInvalidDigest = value.digest !== undefined && !hasDigest;
	const hasSourceIdentity =
		typeof value.sourceIdentity === "string" &&
		(value.sourceIdentity.startsWith("github\0") || value.sourceIdentity.startsWith("project\0")) &&
		value.sourceIdentity.length <= 2048;
	const hasInvalidSourceIdentity = value.sourceIdentity !== undefined && !hasSourceIdentity;
	if (hasInvalidDigest || hasInvalidSourceIdentity) return false;
	return value.manager === "local-setup"
		? hasDigest && !hasSourceIdentity
		: hasDigest || hasSourceIdentity;
}

function reservationMatches(
	reservation: ManagedSkillReservation,
	input: {
		id: string;
		version?: number;
		digest?: string;
		sourceIdentity?: string;
		manager: ManagedSkillReservationManager;
	},
): boolean {
	return (
		reservation.id === input.id &&
		reservation.version === input.version &&
		reservation.digest === input.digest &&
		reservation.sourceIdentity === input.sourceIdentity &&
		reservation.manager === input.manager
	);
}

export function shouldIgnoreUserSkill(targetDir: string, skillId = basename(targetDir)): boolean {
	let reservation: ManagedSkillReservation | undefined;
	try {
		reservation = readLedger(ledgerPath()).reservations[resolve(targetDir)];
	} catch {
		throw new Error("managed Skill ownership state is invalid");
	}
	if (!reservation) return false;
	if (reservation.id !== skillId && basename(resolve(targetDir)) === reservation.id) return false;
	return true;
}

export function assertUserSkillTargetMutable(
	targetDir: string,
	skillId = basename(targetDir),
): void {
	if (shouldIgnoreUserSkill(targetDir, skillId)) {
		throw new Error(`Skill ${skillId} is reserved by a managed Skill owner`);
	}
}

/** Linearize a user-owned target commit with reservation/install/release commits. */
export function mutateUserSkillTarget<T>(targetDir: string, skillId: string, mutation: () => T): T {
	const commit = () => {
		assertUserSkillTargetMutable(targetDir, skillId);
		return mutation();
	};
	if (
		process.env.CLAWDI_RUNTIME_MODE?.trim().toLowerCase() === "hosted" ||
		process.env.CLAWDI_SERVICE_STATE_DIR?.trim()
	) {
		return withRuntimeConvergeLock(getRuntimePaths({ mode: "hosted" }), commit);
	}
	return withPrivateDirectoryLockSync(join(getClawdiDir(), "locks", "managed-skills.lock"), commit);
}

export function migrateLegacyLocalSetupSkill(input: {
	targetDir: string;
	id: string;
	version: number;
	digest: (targetDir: string) => string;
}): "adopted" | "already_migrated" | "absent" | "unmanaged" | "hosted" {
	if (process.env.CLAWDI_RUNTIME_MODE?.trim().toLowerCase() === "hosted") return "hosted";
	if (process.env.CLAWDI_SERVICE_STATE_DIR?.trim()) return "hosted";
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	if (
		input.id !== "clawdi" ||
		basename(target) !== input.id ||
		!MANAGED_SKILL_ID_PATTERN.test(input.id) ||
		!Number.isSafeInteger(input.version) ||
		input.version <= 0
	) {
		throw new Error("managed Skill migration identity is invalid");
	}
	return withLedgerWriteLock("local-setup", () => {
		const ledger = readLedger(path);
		if (ledger.localSetupMigrations[target]) return "already_migrated";
		const existing = ledger.reservations[target];
		let outcome: "adopted" | "absent" | "unmanaged" = "absent";
		if (!existing && existsSync(target)) {
			let digest: string | undefined;
			try {
				digest = input.digest(target);
			} catch {
				// Unsupported entries cannot prove legacy bundled identity. Complete
				// migration without claiming user-owned content so scans can proceed.
				outcome = "unmanaged";
			}
			if (digest !== undefined && !SHA256_PATTERN.test(digest)) {
				throw new Error("managed Skill migration digest is invalid");
			}
			if (digest !== undefined && LEGACY_LOCAL_SETUP_SKILL_DIGESTS.has(digest)) {
				ledger.reservations[target] = {
					target,
					id: input.id,
					version: input.version,
					digest,
					manager: "local-setup",
				};
				outcome = "adopted";
			} else if (digest !== undefined) {
				outcome = "unmanaged";
			}
		}
		ledger.localSetupMigrations[target] = { target, id: input.id };
		writeLedger(path, ledger);
		return outcome;
	});
}

export function reserveManagedSkill(input: {
	targetDir: string;
	id: string;
	version?: number;
	digest?: string;
	sourceIdentity?: string;
	manager: ManagedSkillReservationManager;
}): "created" | "existing" {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	if (
		!reservationTargetMatchesIdentity(target, input) ||
		!MANAGED_SKILL_ID_PATTERN.test(input.id) ||
		(input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version <= 0)) ||
		!reservationIdentityIsValid(input)
	) {
		throw new Error("managed Skill reservation identity is invalid");
	}
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const previous = ledger.reservations[target];
		const pending = ledger.pendingReservations[target];
		const manager = input.manager;
		if (previous && (previous.manager !== manager || previous.id !== input.id)) {
			throw new Error(`managed Skill ${input.id} is owned by a different manager`);
		}
		if (pending) {
			throw new Error(
				`managed Skill ${input.id} has a pending installation that requires recovery`,
			);
		}
		ledger.reservations[target] = {
			target,
			id: input.id,
			version: input.version,
			digest: input.digest,
			sourceIdentity: input.sourceIdentity,
			manager,
		};
		writeLedger(path, ledger);
		return previous ? "existing" : "created";
	});
}

export function installReservedManagedSkill<T>(
	input: {
		targetDir: string;
		previousTargetDir?: string;
		id: string;
		version?: number;
		digest?: string;
		sourceIdentity?: string;
		manager: ManagedSkillReservationManager;
	},
	install: () => T,
	verification: { verify: () => boolean; discard: () => void },
): T {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	const previousTarget = input.previousTargetDir ? resolve(input.previousTargetDir) : target;
	if (
		!reservationTargetMatchesIdentity(target, input) ||
		!MANAGED_SKILL_ID_PATTERN.test(input.id) ||
		(input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version <= 0)) ||
		!reservationIdentityIsValid(input)
	) {
		throw new Error("managed Skill reservation identity is invalid");
	}
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const previous = ledger.reservations[target];
		const replaced = previousTarget === target ? previous : ledger.reservations[previousTarget];
		const pending = ledger.pendingReservations[target];
		if (previous && (previous.manager !== input.manager || previous.id !== input.id)) {
			throw new Error(`managed Skill ${input.id} is owned by a different manager`);
		}
		if (
			pending &&
			(!reservationMatches(pending, input) || (pending.previousTarget ?? target) !== previousTarget)
		) {
			throw new Error(`managed Skill ${input.id} is pending for a different installation`);
		}
		if (
			previousTarget !== target &&
			(!replaced || replaced.manager !== input.manager || replaced.id !== input.id)
		) {
			throw new Error(`managed Skill ${input.id} replacement reservation is invalid`);
		}
		ledger.pendingReservations[target] = {
			target,
			...(previousTarget !== target ? { previousTarget } : {}),
			id: input.id,
			version: input.version,
			digest: input.digest,
			sourceIdentity: input.sourceIdentity,
			manager: input.manager,
		};
		writeLedger(path, ledger);
		let result: T;
		try {
			result = install();
		} catch (error) {
			delete ledger.pendingReservations[target];
			writeLedger(path, ledger);
			throw error;
		}
		if (!verification.verify()) {
			verification.discard();
			if (previous?.id === input.id && previous.manager === input.manager) {
				delete ledger.reservations[target];
			}
			delete ledger.pendingReservations[target];
			writeLedger(path, ledger);
			throw new ManagedSkillResourceError(
				`managed Skill ${input.id} installation could not be verified`,
			);
		}
		ledger.reservations[target] = {
			target,
			id: input.id,
			version: input.version,
			digest: input.digest,
			sourceIdentity: input.sourceIdentity,
			manager: input.manager,
		};
		if (previousTarget !== target) delete ledger.reservations[previousTarget];
		delete ledger.pendingReservations[target];
		writeLedger(path, ledger);
		return result;
	});
}

export function recoverPendingManagedSkillInstallation(input: {
	targetDir: string;
	id: string;
	manager: ManagedSkillReservationManager;
	verify: () => boolean;
	discard: () => void;
}): "absent" | "promoted" | "discarded" {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const pending = ledger.pendingReservations[target];
		if (!pending) return "absent";
		if (pending.id !== input.id || pending.manager !== input.manager) {
			throw new Error("pending managed Skill reservation identity mismatch");
		}
		if (input.verify()) {
			ledger.reservations[target] = {
				target,
				id: pending.id,
				version: pending.version,
				digest: pending.digest,
				sourceIdentity: pending.sourceIdentity,
				manager: pending.manager,
			};
			if (pending.previousTarget && pending.previousTarget !== target) {
				const replaced = ledger.reservations[pending.previousTarget];
				if (replaced && replaced.id === pending.id && replaced.manager === pending.manager) {
					delete ledger.reservations[pending.previousTarget];
				}
			}
			delete ledger.pendingReservations[target];
			writeLedger(path, ledger);
			return "promoted";
		}
		const committed = ledger.reservations[target];
		if (committed && committed.id === pending.id && committed.manager === pending.manager) {
			delete ledger.reservations[target];
		}
		input.discard();
		delete ledger.pendingReservations[target];
		writeLedger(path, ledger);
		return "discarded";
	});
}

export function replaceManagedSkillDirectoryAtomic(
	sourceDir: string,
	targetDir: string,
	options: ManagedSkillDirectoryActivationOptions = {},
): void {
	const parent = dirname(targetDir);
	const stagingRoot = withRuntimeUserFileAccess(() => {
		mkdirSync(parent, { recursive: true });
		return mkdtempSync(join(parent, `.${basename(targetDir)}-stage-`));
	});
	const stagedTarget = join(stagingRoot, basename(targetDir));
	const previousTarget = join(
		parent,
		`.${basename(targetDir)}-previous-${process.pid}-${randomUUID()}`,
	);
	try {
		withRuntimeUserFileAccess(() => cpSync(sourceDir, stagedTarget, { recursive: true }));
		withManagedTargetRollback({
			target: targetDir,
			targetBackup: previousTarget,
			beforeRestore: options.beforeRestore,
			beforeCleanup: options.beforeCleanup,
			restoreFailure: (activationError, restoreError) => {
				const activationMessage =
					activationError instanceof Error ? activationError.message : String(activationError);
				const restoreMessage =
					restoreError instanceof Error ? restoreError.message : String(restoreError);
				return new Error(
					`Skill activation failed: ${activationMessage}; restoring the previous version failed: ${restoreMessage}; previous version retained as a recovery artifact`,
					{ cause: activationError },
				);
			},
			operation: () => {
				withRuntimeUserFileAccess(() => {
					options.beforeActivate?.();
					renameSync(stagedTarget, targetDir);
				});
				options.afterActivate?.();
			},
		});
	} finally {
		withRuntimeUserFileAccess(() => rmSync(stagingRoot, { recursive: true, force: true }));
	}
}

export interface ManagedSkillDirectoryActivationOptions {
	beforeActivate?: () => void;
	afterActivate?: () => void;
	beforeRestore?: () => void;
	beforeCleanup?: () => void;
}

export function releaseManagedSkill(input: {
	targetDir: string;
	id: string;
	manager: ManagedSkillReservationManager;
	removeTarget: () => void;
}): "absent" | "removed" {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const reservation = ledger.reservations[target];
		if (!reservation) return "absent";
		if (reservation.id !== input.id || reservation.manager !== input.manager) {
			throw new Error("managed Skill reservation identity mismatch");
		}
		input.removeTarget();
		delete ledger.reservations[target];
		writeLedger(path, ledger);
		return "removed";
	});
}
