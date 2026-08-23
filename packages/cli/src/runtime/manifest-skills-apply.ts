import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostedBundledSkillIds, resolveHostedBundledSkill } from "./hosted-bundled-skill";
import { activateHostedHermesSkill } from "./hosted-hermes-skill";
import { activateHostedOpenClawSkill } from "./hosted-openclaw-skill";
import {
	type PreparedHostedSourcedSkill,
	prepareHostedBundledSkillArchive,
} from "./hosted-sourced-skill-archive";
import {
	installedTreeMatches,
	ManagedSkillResourceError,
	withStagedManagedSkill,
} from "./managed-skill-delivery";
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
	skillsRoot: string | null;
	activate(sourceDir: string, targetDir: string): void;
	exclude?: ReadonlySet<string>;
}
type HostedSkillRuntime = "hermes" | "openclaw";
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
	home: string;
	openClawWorkspaceRoot: string | null;
}): ReadonlyArray<readonly [HostedSkillRuntime, HostedSkillProjectionDriver]> {
	const hermesSkillsRoot = join(input.home, ".hermes", "skills");
	const openClawSkillsRoot = input.openClawWorkspaceRoot
		? join(input.openClawWorkspaceRoot, "skills")
		: null;
	return [
		[
			"hermes",
			{
				skillsRoot: hermesSkillsRoot,
				activate: activateHostedHermesSkill,
			},
		],
		[
			"openclaw",
			{
				skillsRoot: openClawSkillsRoot,
				exclude: new Set([".openclaw/source-origin.json"]),
				activate: (sourceDir, targetDir) => {
					if (!input.openClawWorkspaceRoot) {
						throw new Error("OpenClaw official agent workspace is unavailable");
					}
					activateHostedOpenClawSkill({
						home: input.home,
						workspaceRoot: input.openClawWorkspaceRoot,
						sourceDir,
						targetDir,
					});
				},
			},
		],
	];
}

function runtimeEnabled(manifest: RuntimeManifest, runtime: HostedSkillRuntime): boolean {
	return manifest.runtimes[runtime]?.enabled === true;
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
	runtime: HostedSkillRuntime,
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
			runtimeEnabled(manifest, runtime) &&
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
					exclude: driver.exclude,
				}),
			discard: () => discardPendingHostedSkill(reservation.targetDir),
		});
	}
}
function validateHostedSkillsPlan(
	runtime: HostedSkillRuntime,
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled()) return;
	if (runtimeEnabled(manifest, runtime) && !driver.skillsRoot) {
		throw new Error("OpenClaw official agent workspace is unavailable");
	}
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if ("source" in desired && hostedBundledSkillIds().includes(skillId)) {
			throw new Error(`bundled hosted Skill ${skillId} must not declare a catalog source`);
		}
		if (!("source" in desired)) resolveHostedBundledSkill(skillId, desired.version);
		if (!runtimeEnabled(manifest, runtime) || !driver.skillsRoot || !desired.enabled) continue;
		const prepared = preparedSkills.get(skillId);
		if (!preparedSkillMatchesDesired(prepared, desired, skillId)) {
			throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		}
		const targetDir = join(driver.skillsRoot, prepared.skillId);
		if (
			withRuntimeUserFileAccess(() => existsSync(targetDir)) &&
			managedSkillReservationOwner(targetDir, skillId) !== "hosted-manifest"
		) {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
	}
}
function applyHostedSkills(
	runtime: HostedSkillRuntime,
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
		if (!runtimeEnabled(manifest, runtime) || desired?.enabled !== true) {
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
		const targetDir = join(driver.skillsRoot, prepared.skillId);
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (withRuntimeUserFileAccess(() => existsSync(targetDir)) && owner !== "hosted-manifest") {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
		const reservationIdentity = preparedReservationIdentity(prepared);
		if (
			reservation?.targetDir === targetDir &&
			reservation.digest === reservationIdentity.digest &&
			installedTreeMatches(prepared, targetDir, {
				exclude: driver.exclude,
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
				() =>
					withStagedManagedSkill(prepared, (sourceDir) => driver.activate(sourceDir, targetDir)),
				{
					verify: () =>
						installedTreeMatches(prepared, targetDir, {
							exclude: driver.exclude,
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
}): string[] {
	const {
		manifest,
		observations,
		home,
		managedResourceRoot,
		openClawWorkspaceRoot,
		preparedSourcedSkills,
	} = input;
	const preparedSkills = completePreparedHostedSkills(manifest, preparedSourcedSkills);
	const drivers = hostedSkillProjectionDrivers({
		home,
		openClawWorkspaceRoot,
	});
	rmSync(join(managedResourceRoot, "skill-receipts"), { recursive: true, force: true });
	for (const [, driver] of drivers) {
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
		for (const [runtime, driver] of drivers) {
			recoverPendingHostedSkillInstallations(runtime, driver, manifest, preparedSkills);
			validateHostedSkillsPlan(runtime, driver, manifest, preparedSkills);
		}
	});
	const failures: string[] = [];
	for (const [runtime, driver] of drivers) {
		const driverFailures = runHostedSkillProjectionStep(
			`runtime ${runtime} Skill projection failed`,
			() => applyHostedSkills(runtime, driver, observations.get(runtime), manifest, preparedSkills),
		);
		failures.push(
			...driverFailures.map((failure) => `runtime ${runtime} Skill projection failed: ${failure}`),
		);
	}
	return failures;
}
