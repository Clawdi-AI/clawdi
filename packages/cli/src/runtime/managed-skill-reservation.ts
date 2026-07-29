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

const LEDGER_FILE = "managed-skills.json";
const LEDGER_SCHEMA = "clawdi.managedSkillReservations.v1";
const MANAGED_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
	return { schemaVersion: LEDGER_SCHEMA, reservations: {} };
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
	if (!isRecord(value) || value.schemaVersion !== LEDGER_SCHEMA || !isRecord(value.reservations)) {
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
	return { schemaVersion: LEDGER_SCHEMA, reservations };
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
		throw new Error(`Skill ${skillId} is reserved by the hosted runtime manifest`);
	}
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
	options: { beforeActivate?: () => void } = {},
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
		const hadPrevious = existsSync(targetDir);
		if (hadPrevious) renameSync(targetDir, previousTarget);
		try {
			options.beforeActivate?.();
			renameSync(stagedTarget, targetDir);
		} catch (error) {
			if (hadPrevious) renameSync(previousTarget, targetDir);
			throw error;
		}
		if (hadPrevious) rmSync(previousTarget, { recursive: true, force: true });
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
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
