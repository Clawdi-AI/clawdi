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
import { getRuntimePaths } from "./paths";

const LEDGER_FILE = "managed-skills.json";
const LEDGER_SCHEMA = "clawdi.managedSkillReservations.v1";
const MANAGED_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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
	"ad94e96e9eb1f83c034997e1b2bdcc74b37289264565ef13c81c549d2ece5c72",
	"fc37cc249b6f040e9e6f2022ff7a9bff3c127d21aac1e776a7770d88873cd3d5",
]);

export type ManagedSkillReservationManager = "hosted-manifest" | "local-setup";

interface ManagedSkillReservation {
	target: string;
	id: string;
	version: number;
	digest: string;
	manager: ManagedSkillReservationManager;
}

interface ManagedSkillReservationLedger {
	schemaVersion: typeof LEDGER_SCHEMA;
	reservations: Record<string, ManagedSkillReservation>;
	localSetupMigrations: Record<string, { target: string; id: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerPath(): string {
	const root = process.env.CLAWDI_SERVICE_STATE_DIR?.trim();
	const mode = process.env.CLAWDI_RUNTIME_MODE?.trim().toLowerCase();
	if (mode === "hosted" || root) {
		return join(root || "/var/lib/clawdi", "config", "projections", LEDGER_FILE);
	}
	return join(getClawdiDir(), "managed-resources", LEDGER_FILE);
}

function emptyLedger(): ManagedSkillReservationLedger {
	return { schemaVersion: LEDGER_SCHEMA, reservations: {}, localSetupMigrations: {} };
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
		(value.localSetupMigrations !== undefined && !isRecord(value.localSetupMigrations))
	) {
		throw new Error("managed Skill ownership state is invalid");
	}
	const reservations: Record<string, ManagedSkillReservation> = {};
	for (const [target, raw] of Object.entries(value.reservations)) {
		if (
			!isRecord(raw) ||
			raw.target !== target ||
			resolve(target) !== target ||
			typeof raw.id !== "string" ||
			basename(target) !== raw.id ||
			!MANAGED_SKILL_ID_PATTERN.test(raw.id) ||
			typeof raw.version !== "number" ||
			!Number.isSafeInteger(raw.version) ||
			raw.version <= 0 ||
			typeof raw.digest !== "string" ||
			!SHA256_PATTERN.test(raw.digest) ||
			(raw.manager !== "hosted-manifest" && raw.manager !== "local-setup")
		) {
			throw new Error("managed Skill ownership state is invalid");
		}
		reservations[target] = {
			target,
			id: raw.id,
			version: raw.version,
			digest: raw.digest,
			manager: raw.manager,
		};
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
	return { schemaVersion: LEDGER_SCHEMA, reservations, localSetupMigrations };
}

function writeLedger(path: string, ledger: ManagedSkillReservationLedger): void {
	writePrivateFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
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

export function shouldIgnoreUserSkill(targetDir: string, skillId = basename(targetDir)): boolean {
	const state = managedSkillReservationState(targetDir, skillId);
	if (state === "indeterminate") {
		throw new Error("managed Skill ownership state is invalid");
	}
	return state === "reserved";
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
	version: number;
	digest: string;
	manager: ManagedSkillReservationManager;
}): "created" | "existing" {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	if (
		basename(target) !== input.id ||
		!MANAGED_SKILL_ID_PATTERN.test(input.id) ||
		!Number.isSafeInteger(input.version) ||
		input.version <= 0 ||
		!SHA256_PATTERN.test(input.digest)
	) {
		throw new Error("managed Skill reservation identity is invalid");
	}
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const previous = ledger.reservations[target];
		const manager = input.manager;
		if (previous && previous.manager !== manager) {
			throw new Error(`managed Skill ${input.id} is owned by a different manager`);
		}
		ledger.reservations[target] = {
			target,
			id: input.id,
			version: input.version,
			digest: input.digest,
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
		version: number;
		digest: string;
		manager: ManagedSkillReservationManager;
	},
	install: () => T,
): T {
	const path = ledgerPath();
	const target = resolve(input.targetDir);
	if (
		basename(target) !== input.id ||
		!MANAGED_SKILL_ID_PATTERN.test(input.id) ||
		!Number.isSafeInteger(input.version) ||
		input.version <= 0 ||
		!SHA256_PATTERN.test(input.digest)
	) {
		throw new Error("managed Skill reservation identity is invalid");
	}
	return withLedgerWriteLock(input.manager, () => {
		const ledger = readLedger(path);
		const previous = ledger.reservations[target];
		if (previous && previous.manager !== input.manager) {
			throw new Error(`managed Skill ${input.id} is owned by a different manager`);
		}
		ledger.reservations[target] = {
			target,
			id: input.id,
			version: input.version,
			digest: input.digest,
			manager: input.manager,
		};
		writeLedger(path, ledger);
		try {
			return install();
		} catch (error) {
			if (previous) ledger.reservations[target] = previous;
			else delete ledger.reservations[target];
			writeLedger(path, ledger);
			throw error;
		}
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
	const previousTarget = join(
		parent,
		`.${basename(targetDir)}-previous-${process.pid}-${randomUUID()}`,
	);
	try {
		cpSync(sourceDir, stagedTarget, { recursive: true });
		activateManagedSkillDirectory({ stagedTarget, targetDir, previousTarget, options });
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

export interface ManagedSkillDirectoryActivationOptions {
	beforeActivate?: () => void;
	beforeRestore?: () => void;
	beforeCleanup?: () => void;
}

export function activateManagedSkillDirectory(input: {
	stagedTarget: string;
	targetDir: string;
	previousTarget: string;
	options?: ManagedSkillDirectoryActivationOptions;
}): void {
	const hadPrevious = existsSync(input.targetDir);
	if (hadPrevious) renameSync(input.targetDir, input.previousTarget);
	try {
		input.options?.beforeActivate?.();
		renameSync(input.stagedTarget, input.targetDir);
	} catch (activationError) {
		if (!hadPrevious) throw activationError;
		try {
			input.options?.beforeRestore?.();
			renameSync(input.previousTarget, input.targetDir);
		} catch (restoreError) {
			const activationMessage =
				activationError instanceof Error ? activationError.message : String(activationError);
			const restoreMessage =
				restoreError instanceof Error ? restoreError.message : String(restoreError);
			throw new Error(
				`Skill activation failed: ${activationMessage}; restoring the previous version failed: ${restoreMessage}; previous version retained as a recovery artifact`,
				{ cause: activationError },
			);
		}
		throw activationError;
	}

	// Renaming the staged target is the commit point. Cleanup is GC only and
	// must never make callers roll back ownership after the new target is live.
	if (hadPrevious) {
		try {
			input.options?.beforeCleanup?.();
			rmSync(input.previousTarget, { recursive: true, force: true });
		} catch {
			// Best effort. The uniquely named sibling is safe to collect later.
		}
	}
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

export function isReservedSkillArchivePath(path: string): boolean {
	return path.split(/[\\/]/).some((segment) => segment.toLowerCase().startsWith(".clawdi-managed"));
}
