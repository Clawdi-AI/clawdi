import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	claimLegacyHostedBundledSkill,
	hostedBundledSkillIds,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import type { HostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import type { HostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
	type PreparedHostedSourcedSkill,
	prepareHostedBundledSkillArchive,
} from "./hosted-sourced-skill-archive";
import {
	ManagedSkillResourceError,
	migrateLegacyManagedSkillReceiptDirectory,
} from "./managed-skill-delivery";
import {
	installReservedManagedSkill,
	type ManagedSkillReservationSnapshot,
	managedSkillReservationOwner,
	managedSkillReservations,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import type { HostedSkillSource } from "./manifest-resources";
import { detectRuntimeMode } from "./paths";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

function hostedBundledSkillsEnabled(): boolean {
	return detectRuntimeMode() === "hosted";
}
type HostedSkillDesired =
	| { enabled: boolean; version: number }
	| { enabled: boolean; source: HostedSkillSource };
interface HostedSkillProjectionDriver {
	name: "hermes" | "openclaw";
	enabled: boolean;
	skillsRoot: string | null;
	install(
		skill: PreparedHostedSourcedSkill,
		previouslyReserved: boolean,
	): "installed" | "unchanged";
	anchorOwnership(skillId: string, ownershipIdentity: string): void;
	hasOwnershipReceipt(skill: PreparedHostedSourcedSkill): boolean;
	remove(reservation: ManagedSkillReservationSnapshot): void;
}
function preparedSkillMatchesDesired(
	prepared: PreparedHostedSourcedSkill | undefined,
	desired: HostedSkillDesired,
	skillId: string,
): prepared is PreparedHostedSourcedSkill {
	if (!prepared || prepared.skillId !== skillId) return false;
	if ("source" in desired) {
		return JSON.stringify(prepared.source) === JSON.stringify(desired.source);
	}
	const catalogEntry = resolveHostedBundledSkill(skillId, desired.version);
	return (
		prepared.source.type === "bundled" &&
		prepared.source.version === desired.version &&
		prepared.source.digest === catalogEntry.digest &&
		prepared.source.assetDirectory === catalogEntry.assetDirectory
	);
}
function completePreparedHostedSkills(
	manifest: RuntimeManifest,
	prepared: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): ReadonlyMap<string, PreparedHostedSourcedSkill> {
	if (!hostedBundledSkillsEnabled()) return prepared;
	const complete = new Map(prepared);
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if (!desired.enabled || "source" in desired) continue;
		const existing = complete.get(skillId);
		if (preparedSkillMatchesDesired(existing, desired, skillId)) continue;
		complete.set(skillId, prepareHostedBundledSkillArchive(skillId, desired.version));
	}
	return complete;
}
function preparedReservationIdentity(skill: PreparedHostedSourcedSkill): {
	version?: number;
	digest?: string;
	sourceIdentity?: string;
} {
	return skill.source.type === "bundled"
		? { version: skill.source.version, digest: skill.source.digest }
		: { sourceIdentity: skill.sourceIdentity };
}
function reservationOwnershipIdentity(reservation: ManagedSkillReservationSnapshot): string {
	if (reservation.sourceIdentity) return reservation.sourceIdentity;
	if (reservation.digest) return `content-sha256\0${reservation.digest}`;
	throw new Error(`managed Skill ${reservation.id} has no ownership identity`);
}
function hostedSkillProjectionDrivers(input: {
	manifest: RuntimeManifest;
	home: string;
	managedResourceRoot: string;
	openClawWorkspaceRoot: string | null;
	hermesDriver: HostedHermesSkillExactSourceDriver;
	openClawDriver: HostedOpenClawSkillDriver;
}): HostedSkillProjectionDriver[] {
	const appRoot = join(input.home, ".hermes", "hermes-agent");
	const hermesSkillsRoot = join(input.home, ".hermes", "skills");
	const openClawSkillsRoot = input.openClawWorkspaceRoot
		? join(input.openClawWorkspaceRoot, "skills")
		: null;
	return [
		{
			name: "hermes",
			enabled: input.manifest.runtimes.hermes?.enabled === true,
			skillsRoot: hermesSkillsRoot,
			install: (skill, previouslyReserved) =>
				input.hermesDriver.install({
					home: input.home,
					appRoot,
					managedResourceRoot: input.managedResourceRoot,
					skill,
					previouslyReserved,
				}),
			anchorOwnership: (skillId, ownershipIdentity) =>
				input.hermesDriver.anchorOwnership({
					home: input.home,
					managedResourceRoot: input.managedResourceRoot,
					skillId,
					ownershipIdentity,
				}),
			hasOwnershipReceipt: (skill) =>
				input.hermesDriver.hasOwnershipReceipt({
					home: input.home,
					managedResourceRoot: input.managedResourceRoot,
					skillId: skill.skillId,
					ownershipIdentity: skill.sourceIdentity,
				}),
			remove: (reservation) => {
				const ownershipIdentity = reservationOwnershipIdentity(reservation);
				if (reservation.digest) {
					input.hermesDriver.cleanupManifestOwned({
						home: input.home,
						managedResourceRoot: input.managedResourceRoot,
						skillId: reservation.id,
						ownershipIdentity,
					});
					return;
				}
				input.hermesDriver.uninstall({
					home: input.home,
					appRoot,
					managedResourceRoot: input.managedResourceRoot,
					skillId: reservation.id,
					ownershipIdentity,
				});
			},
		},
		{
			name: "openclaw",
			enabled: input.manifest.runtimes.openclaw?.enabled === true,
			skillsRoot: openClawSkillsRoot,
			install: (skill, previouslyReserved) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				return input.openClawDriver.install({
					home: input.home,
					workspaceRoot: input.openClawWorkspaceRoot,
					managedResourceRoot: input.managedResourceRoot,
					skill,
					previouslyReserved,
				});
			},
			anchorOwnership: (skillId, ownershipIdentity) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				input.openClawDriver.anchorOwnership({
					workspaceRoot: input.openClawWorkspaceRoot,
					managedResourceRoot: input.managedResourceRoot,
					skillId,
					ownershipIdentity,
				});
			},
			hasOwnershipReceipt: (skill) => {
				if (!input.openClawWorkspaceRoot) return false;
				return input.openClawDriver.hasOwnershipReceipt({
					workspaceRoot: input.openClawWorkspaceRoot,
					managedResourceRoot: input.managedResourceRoot,
					skillId: skill.skillId,
					ownershipIdentity: skill.sourceIdentity,
				});
			},
			remove: (reservation) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				input.openClawDriver.cleanupManifestOwned({
					workspaceRoot: input.openClawWorkspaceRoot,
					managedResourceRoot: input.managedResourceRoot,
					skillId: reservation.id,
					ownershipIdentity: reservationOwnershipIdentity(reservation),
				});
			},
		},
	];
}

function assertSkillsRootInTenantHome(home: string, skillsRoot: string): void {
	const candidate = relative(resolve(home), resolve(skillsRoot));
	if (candidate.startsWith("..") || isAbsolute(candidate) || basename(skillsRoot) !== "skills") {
		throw new Error(`managed Skill reservation is outside tenant HOME: ${skillsRoot}`);
	}
}

export function migrateLegacyHostedSkillReceipts(input: {
	manifest: RuntimeManifest;
	home: string;
	managedResourceRoot: string;
}): void {
	const hermesSkillsRoot = join(input.home, ".hermes", "skills");
	const roots = new Map<string, "hermes" | "openclaw">([
		[hermesSkillsRoot, "hermes"],
		[join(input.home, ".openclaw", "workspace", "skills"), "openclaw"],
	]);
	if (input.manifest.workspaceRoot) {
		const manifestSkillsRoot = join(input.manifest.workspaceRoot, "skills");
		assertSkillsRootInTenantHome(input.home, manifestSkillsRoot);
		roots.set(manifestSkillsRoot, "openclaw");
	}
	for (const reservation of managedSkillReservations("hosted-manifest")) {
		const skillsRoot = dirname(reservation.targetDir);
		assertSkillsRootInTenantHome(input.home, skillsRoot);
		roots.set(skillsRoot, skillsRoot === hermesSkillsRoot ? "hermes" : "openclaw");
	}
	for (const [skillsRoot, runtime] of [...roots].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		migrateLegacyManagedSkillReceiptDirectory({
			tenantHome: input.home,
			managedResourceRoot: input.managedResourceRoot,
			runtime,
			skillsRoot,
		});
	}
}
function recoverHostedSkillReservations(
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled() || !driver.skillsRoot) return;
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const skillIds = new Set([...Object.keys(desiredEntries), ...hostedBundledSkillIds()]);
	for (const skillId of [...skillIds].sort()) {
		const targetDir = join(driver.skillsRoot, skillId);
		if (
			!withRuntimeUserFileAccess(() => existsSync(targetDir)) ||
			managedSkillReservationOwner(targetDir, skillId) !== "unreserved"
		) {
			continue;
		}
		if (
			claimLegacyHostedBundledSkill({
				targetDir,
				skillId,
				reserve: (legacy) => {
					reserveManagedSkill({
						targetDir,
						id: skillId,
						manager: "hosted-manifest",
						version: legacy.version,
						digest: legacy.digest,
					});
				},
				anchorOwnership: (ownershipIdentity) => driver.anchorOwnership(skillId, ownershipIdentity),
			})
		) {
			continue;
		}
		const desired = desiredEntries[skillId];
		if (!driver.enabled || desired?.enabled !== true) continue;
		const prepared = preparedSkills.get(skillId);
		if (
			!preparedSkillMatchesDesired(prepared, desired, skillId) ||
			!driver.hasOwnershipReceipt(prepared)
		) {
			continue;
		}
		reserveManagedSkill({
			targetDir,
			id: skillId,
			manager: "hosted-manifest",
			...preparedReservationIdentity(prepared),
		});
	}
}
function validateHostedSkillsPlan(
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled()) return;
	if (driver.enabled && !driver.skillsRoot) {
		throw new Error("OpenClaw official agent workspace is unavailable");
	}
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if ("source" in desired && hostedBundledSkillIds().includes(skillId)) {
			throw new Error(`bundled hosted Skill ${skillId} must not declare a catalog source`);
		}
		if (!("source" in desired)) resolveHostedBundledSkill(skillId, desired.version);
		if (!driver.enabled || !driver.skillsRoot || !desired.enabled) continue;
		const prepared = preparedSkills.get(skillId);
		if (!preparedSkillMatchesDesired(prepared, desired, skillId)) {
			throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		}
		const targetDir = join(driver.skillsRoot, skillId);
		if (
			withRuntimeUserFileAccess(() => existsSync(targetDir)) &&
			managedSkillReservationOwner(targetDir, skillId) !== "hosted-manifest"
		) {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
	}
}
function applyHostedSkills(
	driver: HostedSkillProjectionDriver,
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): string[] {
	if (!hostedBundledSkillsEnabled() || !driver.skillsRoot) return [];
	const failures: string[] = [];
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const reservations = managedSkillReservations("hosted-manifest").filter(
		(reservation) => dirname(reservation.targetDir) === driver.skillsRoot,
	);
	const skillIds = new Set([
		...Object.keys(desiredEntries),
		...reservations.map((reservation) => reservation.id),
		...hostedBundledSkillIds(),
	]);
	for (const skillId of [...skillIds].sort()) {
		const targetDir = join(driver.skillsRoot, skillId);
		const desired = desiredEntries[skillId];
		if (!driver.enabled || desired?.enabled !== true) {
			const owner = managedSkillReservationOwner(targetDir, skillId);
			if (owner === "unreserved" || owner === "local-setup") continue;
			if (owner !== "hosted-manifest") {
				throw new Error(`managed Skill ${skillId} is owned by a different manager`);
			}
			const reservation = managedSkillReservations("hosted-manifest").find(
				(entry) => entry.targetDir === targetDir && entry.id === skillId,
			);
			if (!reservation) throw new Error(`managed Skill ${skillId} has no ownership reservation`);
			try {
				releaseManagedSkill({
					targetDir,
					id: skillId,
					manager: "hosted-manifest",
					removeTarget: () => driver.remove(reservation),
				});
			} catch (error) {
				if (!(error instanceof ManagedSkillResourceError)) throw error;
				failures.push(`${skillId}: ${error.message}`);
			}
			continue;
		}
		if (!observation?.enabled || observation.status === "install_failed") continue;
		const prepared = preparedSkills.get(skillId);
		if (!preparedSkillMatchesDesired(prepared, desired, skillId)) {
			throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		}
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (withRuntimeUserFileAccess(() => existsSync(targetDir)) && owner !== "hosted-manifest") {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
		try {
			installReservedManagedSkill(
				{
					targetDir,
					id: skillId,
					manager: "hosted-manifest",
					...preparedReservationIdentity(prepared),
				},
				() => driver.install(prepared, owner === "hosted-manifest"),
			);
		} catch (error) {
			if (!(error instanceof ManagedSkillResourceError)) throw error;
			failures.push(`${skillId}: ${error.message}`);
		}
	}
	return failures;
}
function runHostedSkillProjectionStep<T>(label: string, step: () => T): T {
	try {
		return step();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}
export function reconcileHostedSkillProjection(input: {
	manifest: RuntimeManifest;
	observations: ReadonlyMap<string, RuntimeInstallObservation>;
	home: string;
	managedResourceRoot: string;
	openClawWorkspaceRoot: string | null;
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>;
	hermesDriver: HostedHermesSkillExactSourceDriver;
	openClawDriver: HostedOpenClawSkillDriver;
}): string[] {
	const {
		manifest,
		observations,
		home,
		managedResourceRoot,
		openClawWorkspaceRoot,
		preparedSourcedSkills,
		hermesDriver,
		openClawDriver,
	} = input;
	const preparedSkills = completePreparedHostedSkills(manifest, preparedSourcedSkills);
	const drivers = hostedSkillProjectionDrivers({
		manifest,
		home,
		managedResourceRoot,
		openClawWorkspaceRoot,
		hermesDriver,
		openClawDriver,
	});
	runHostedSkillProjectionStep("runtime Skill projection planning failed", () => {
		for (const driver of drivers) {
			recoverHostedSkillReservations(driver, manifest, preparedSkills);
			validateHostedSkillsPlan(driver, manifest, preparedSkills);
		}
	});
	const failures: string[] = [];
	for (const driver of drivers) {
		const driverFailures = runHostedSkillProjectionStep(
			`runtime ${driver.name} Skill projection failed`,
			() => applyHostedSkills(driver, observations.get(driver.name), manifest, preparedSkills),
		);
		failures.push(
			...driverFailures.map(
				(failure) => `runtime ${driver.name} Skill projection failed: ${failure}`,
			),
		);
	}
	return failures;
}
