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
import { detectRuntimeMode, getRuntimePaths } from "./paths";
import { runtimePlatformRootForPath, writeRuntimePlatformFileAtomic } from "./state";

const LEDGER_FILE = "managed-skills.json";
const LEDGER_SCHEMA = "clawdi.managedSkillReservations.v1";
const MANAGED_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
}

type PendingManagedSkillReservation = ManagedSkillReservation;

export type PendingManagedSkillReservationSnapshot = ManagedSkillReservationSnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerPath(): string {
	if (detectRuntimeMode() === "hosted") {
		return join(getRuntimePaths({ mode: "hosted" }).managedResourceRoot, LEDGER_FILE);
	}
	return join(getClawdiDir(), "managed-resources", LEDGER_FILE);
}

export function managedSkillReservationLedgerPath(): string {
	return ledgerPath();
}

function emptyLedger(): ManagedSkillReservationLedger {
	return {
		schemaVersion: LEDGER_SCHEMA,
		reservations: {},
		pendingReservations: {},
	};
}

function reservationTargetMatchesIdentity(target: string, value: { id?: unknown }): boolean {
	return basename(target) === value.id;
}

function parseReservation(target: string, raw: unknown): ManagedSkillReservation | null {
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
		console.warn(`ignoring invalid managed Skill ownership entry at ${target}`);
		return null;
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
	if (!existsSync(path)) return emptyLedger();
	let value: unknown;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("managed Skill ownership state is invalid");
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== LEDGER_SCHEMA ||
		!isRecord(value.reservations) ||
		(value.pendingReservations !== undefined && !isRecord(value.pendingReservations))
	) {
		throw new Error("managed Skill ownership state is invalid");
	}
	const reservations: Record<string, ManagedSkillReservation> = {};
	for (const [target, raw] of Object.entries(value.reservations)) {
		const reservation = parseReservation(target, raw);
		if (reservation) reservations[target] = reservation;
	}
	const pendingReservations: Record<string, PendingManagedSkillReservation> = {};
	for (const [target, raw] of Object.entries(value.pendingReservations ?? {})) {
		const reservation = parseReservation(target, raw);
		if (reservation) pendingReservations[target] = reservation;
	}
	return { schemaVersion: LEDGER_SCHEMA, reservations, pendingReservations };
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
		const ledger = readLedger(ledgerPath());
		reservation =
			ledger.reservations[resolve(targetDir)] ?? ledger.pendingReservations[resolve(targetDir)];
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
	if (detectRuntimeMode() === "hosted") {
		return withRuntimeConvergeLock(getRuntimePaths({ mode: "hosted" }), commit);
	}
	return withPrivateDirectoryLockSync(join(getClawdiDir(), "locks", "managed-skills.lock"), commit);
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
		id: string;
		version?: number;
		digest?: string;
		sourceIdentity?: string;
		manager: ManagedSkillReservationManager;
	},
	install: () => T,
	verification: { verify: () => boolean; discard: () => void; nativeMutation?: boolean },
): T {
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
		if (previous && (previous.manager !== input.manager || previous.id !== input.id)) {
			throw new Error(`managed Skill ${input.id} is owned by a different manager`);
		}
		if (pending && !reservationMatches(pending, input)) {
			throw new Error(`managed Skill ${input.id} is pending for a different installation`);
		}
		ledger.pendingReservations[target] = {
			target,
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
			// Native installs may have committed files or provenance before failing.
			// Retain ownership for reconciliation; never roll back only their files.
			if (
				verification.nativeMutation &&
				(pending ||
					!(error instanceof ManagedSkillResourceError) ||
					error.targetMutationStarted !== false)
			)
				throw error;
			delete ledger.pendingReservations[target];
			writeLedger(path, ledger);
			throw error;
		}
		if (!verification.verify()) {
			if (verification.nativeMutation) {
				throw new ManagedSkillResourceError(
					`managed Skill ${input.id} native installation requires retry`,
				);
			}
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
	retryNative?: boolean;
}): "absent" | "promoted" | "discarded" | "retry" {
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
			delete ledger.pendingReservations[target];
			writeLedger(path, ledger);
			return "promoted";
		}
		if (input.retryNative) return "retry";
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
	mkdirSync(parent, { recursive: true });
	const stagingRoot = mkdtempSync(join(parent, `.${basename(targetDir)}-stage-`));
	const stagedTarget = join(stagingRoot, basename(targetDir));
	try {
		cpSync(sourceDir, stagedTarget, { recursive: true });
		withManagedTargetRollback({
			target: targetDir,
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
				options.beforeActivate?.();
				renameSync(stagedTarget, targetDir);
				options.afterActivate?.();
			},
		});
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
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
