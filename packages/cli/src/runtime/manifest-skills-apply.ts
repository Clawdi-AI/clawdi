import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostedBundledSkillIds, resolveHostedBundledSkill } from "./hosted-bundled-skill";
import type { HostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import type { HostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
	type PreparedHostedSourcedSkill,
	prepareHostedBundledSkillArchive,
} from "./hosted-sourced-skill-archive";
import { installedTreeMatches, ManagedSkillResourceError } from "./managed-skill-delivery";
import {
	installReservedManagedSkill,
	type ManagedSkillReservationSnapshot,
	managedSkillReservationOwner,
	managedSkillReservations,
	type PendingManagedSkillReservationSnapshot,
	pendingManagedSkillReservations,
	recoverPendingManagedSkillInstallation,
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
	installedTreeExcludes?: ReadonlySet<string>;
	target(skill: PreparedHostedSourcedSkill): string;
	install(skill: PreparedHostedSourcedSkill, targetDir: string): "installed" | "unchanged";
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
		: { sourceIdentity: skill.sourceIdentity, digest: skill.archiveSha256 };
}
function hostedSkillProjectionDrivers(input: {
	manifest: RuntimeManifest;
	home: string;
	openClawWorkspaceRoot: string | null;
	hermesDriver: HostedHermesSkillExactSourceDriver;
	openClawDriver: HostedOpenClawSkillDriver;
}): HostedSkillProjectionDriver[] {
	const hermesSkillsRoot = join(input.home, ".hermes", "skills");
	const openClawSkillsRoot = input.openClawWorkspaceRoot
		? join(input.openClawWorkspaceRoot, "skills")
		: null;
	return [
		{
			name: "hermes",
			enabled: input.manifest.runtimes.hermes?.enabled === true,
			skillsRoot: hermesSkillsRoot,
			target: (skill) => input.hermesDriver.target({ home: input.home, skill }),
			install: (skill, targetDir) =>
				input.hermesDriver.install({
					home: input.home,
					skill,
					targetDir,
				}),
		},
		{
			name: "openclaw",
			enabled: input.manifest.runtimes.openclaw?.enabled === true,
			skillsRoot: openClawSkillsRoot,
			installedTreeExcludes: new Set([".openclaw/source-origin.json"]),
			target: (skill) => {
				if (!openClawSkillsRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				return join(openClawSkillsRoot, skill.skillId);
			},
			install: (skill, targetDir) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				void targetDir;
				return input.openClawDriver.install({
					home: input.home,
					workspaceRoot: input.openClawWorkspaceRoot,
					skill,
				});
			},
		},
	];
}

function pendingReservationMatchesPrepared(
	reservation: PendingManagedSkillReservationSnapshot,
	skill: PreparedHostedSourcedSkill,
): boolean {
	const identity = preparedReservationIdentity(skill);
	return (
		reservation.id === skill.skillId &&
		reservation.version === identity.version &&
		reservation.digest === identity.digest &&
		reservation.sourceIdentity === identity.sourceIdentity
	);
}

function discardPendingHostedSkill(targetDir: string): void {
	withRuntimeUserFileAccess(() => rmSync(targetDir, { recursive: true, force: true }));
}

function recoverPendingHostedSkillInstallations(
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled() || !driver.skillsRoot) return;
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const pendingReservations = pendingManagedSkillReservations("hosted-manifest").filter(
		(reservation) => dirname(reservation.targetDir) === driver.skillsRoot,
	);
	for (const reservation of pendingReservations) {
		const desired = desiredEntries[reservation.id];
		const prepared = preparedSkills.get(reservation.id);
		const promotable =
			driver.enabled &&
			desired?.enabled === true &&
			preparedSkillMatchesDesired(prepared, desired, reservation.id) &&
			pendingReservationMatchesPrepared(reservation, prepared)
				? prepared
				: null;
		recoverPendingManagedSkillInstallation({
			targetDir: reservation.targetDir,
			id: reservation.id,
			manager: "hosted-manifest",
			verify: () =>
				promotable !== null &&
				installedTreeMatches(promotable, reservation.targetDir, {
					exclude: driver.installedTreeExcludes,
				}),
			discard: () => discardPendingHostedSkill(reservation.targetDir),
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
		let targetDir: string;
		try {
			targetDir = driver.target(prepared);
		} catch (error) {
			if (error instanceof ManagedSkillResourceError) continue;
			throw error;
		}
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
	const reservationsById = new Map<string, ManagedSkillReservationSnapshot>();
	for (const reservation of reservations) {
		if (reservationsById.has(reservation.id)) {
			throw new Error(`managed Skill ${reservation.id} has multiple ownership reservations`);
		}
		reservationsById.set(reservation.id, reservation);
	}
	const skillIds = new Set([
		...Object.keys(desiredEntries),
		...reservations.map((reservation) => reservation.id),
		...hostedBundledSkillIds(),
	]);
	for (const skillId of [...skillIds].sort()) {
		const reservation = reservationsById.get(skillId);
		const desired = desiredEntries[skillId];
		if (!driver.enabled || desired?.enabled !== true) {
			if (!reservation) continue;
			try {
				releaseManagedSkill({
					targetDir: reservation.targetDir,
					id: skillId,
					manager: "hosted-manifest",
					removeTarget: () => {
						withRuntimeUserFileAccess(() =>
							rmSync(reservation.targetDir, { recursive: true, force: true }),
						);
					},
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
		let targetDir: string;
		try {
			targetDir = driver.target(prepared);
		} catch (error) {
			if (!(error instanceof ManagedSkillResourceError)) throw error;
			failures.push(`${skillId}: ${error.message}`);
			continue;
		}
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (withRuntimeUserFileAccess(() => existsSync(targetDir)) && owner !== "hosted-manifest") {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
		const reservationIdentity = preparedReservationIdentity(prepared);
		if (
			reservation?.targetDir === targetDir &&
			reservation.digest === reservationIdentity.digest &&
			installedTreeMatches(prepared, targetDir, {
				exclude: driver.installedTreeExcludes,
			})
		) {
			if (
				reservation.version !== reservationIdentity.version ||
				reservation.sourceIdentity !== reservationIdentity.sourceIdentity
			) {
				reserveManagedSkill({
					targetDir,
					id: skillId,
					manager: "hosted-manifest",
					...reservationIdentity,
				});
			}
			continue;
		}
		try {
			installReservedManagedSkill(
				{
					targetDir,
					id: skillId,
					manager: "hosted-manifest",
					...preparedReservationIdentity(prepared),
				},
				() => {
					return driver.install(prepared, targetDir);
				},
				{
					verify: () =>
						installedTreeMatches(prepared, targetDir, {
							exclude: driver.installedTreeExcludes,
						}),
					discard: () => discardPendingHostedSkill(targetDir),
				},
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
		openClawWorkspaceRoot,
		hermesDriver,
		openClawDriver,
	});
	rmSync(join(managedResourceRoot, "skill-receipts"), { recursive: true, force: true });
	for (const driver of drivers) {
		const skillsRoot = driver.skillsRoot;
		if (skillsRoot) {
			withRuntimeUserFileAccess(() =>
				rmSync(join(skillsRoot, ".clawdi-manifest-receipts"), {
					recursive: true,
					force: true,
				}),
			);
		}
	}
	runHostedSkillProjectionStep("runtime Skill projection planning failed", () => {
		for (const driver of drivers) {
			recoverPendingHostedSkillInstallations(driver, manifest, preparedSkills);
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
