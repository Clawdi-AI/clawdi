import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import type { z } from "zod";
import { collectRegularFileTree, sha256TreeDigest } from "../lib/file-tree";
import type { RuntimeAppliedState } from "./applied-state";
import { resolveRuntimeApplyGeneration } from "./apply-identity";
import { MANAGED_SKILL_TREE_LIMITS } from "./hosted-bundled-skill";
import {
	hostedHermesSkillRecordMatches,
	readHostedHermesSkillRecords,
} from "./hosted-hermes-skill";
import type { HostedSkillEvidence } from "./hosted-skill-evidence";
import { hostedSkillArchiveSourceIdentity } from "./hosted-sourced-skill-archive";
import { collectManagedSkillTree } from "./managed-skill-delivery";
import { managedSkillReservations } from "./managed-skill-reservation";
import type { hostedSkillEntryDesiredStateSchema } from "./manifest-resources";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

type SkillsObservation = components["schemas"]["HostedRuntimeObservedSkillsV1"];
type SkillObservation = components["schemas"]["HostedRuntimeObservedSkillV1"];

export function hostedSkillSourceIdentity(
	skillKey: string,
	desired: z.infer<typeof hostedSkillEntryDesiredStateSchema>,
): string {
	if (!("source" in desired))
		return hashSkillIdentity(["bundled", skillKey, String(desired.version)].join("\0"));
	return hashSkillIdentity(hostedSkillArchiveSourceIdentity(skillKey, desired.source));
}

export function hashSkillIdentity(identity: string): string {
	return createHash("sha256").update(identity).digest("hex");
}

export function installedSkillTreeDigest(
	targetDir: string,
	runtime: HostedSkillEvidence["runtime"],
	sourceIdentity?: string,
): string {
	// Root Git installs also attest native provenance; changing only the origin
	// must invalidate heartbeat evidence even when the Skill bytes are unchanged.
	const identity = sourceIdentity?.split("\0");
	const includeOrigin = identity?.[0] === "github" && identity[3] === "";
	return withRuntimeUserFileAccess(() =>
		sha256TreeDigest(
			collectRegularFileTree(targetDir, {
				limits: MANAGED_SKILL_TREE_LIMITS,
				exclude: (path) =>
					runtime === "openclaw" && !includeOrigin && path === ".openclaw/source-origin.json",
				resourceLabel: "managed Skill tree",
			}),
		).slice("sha256-tree-v1:".length),
	);
}

export function readHostedSkillsObservation(
	applied: RuntimeAppliedState,
): SkillsObservation | null {
	if (!applied.skillEvidence?.length) return null;
	const hermesRecords = new Map<string, Record<string, unknown> | Error>();
	const nativeHermesMatches = (target: string, identity: string): boolean => {
		const home = resolve(target, "../../..");
		return withRuntimeUserFileAccess(() => {
			let records = hermesRecords.get(home);
			if (!records) {
				try {
					records = readHostedHermesSkillRecords(home);
				} catch {
					records = new Error("Hermes Hub provenance is unavailable");
				}
				hermesRecords.set(home, records);
			}
			if (records instanceof Error) throw records;
			return hostedHermesSkillRecordMatches(home, target, identity, records);
		});
	};
	let reservations: ReturnType<typeof managedSkillReservations> | null;
	try {
		reservations = managedSkillReservations("hosted-manifest");
	} catch {
		reservations = null;
	}
	const selected = [...applied.skillEvidence]
		.sort(
			(a, b) =>
				Number(b.status === "failed") - Number(a.status === "failed") ||
				a.runtime.localeCompare(b.runtime) ||
				a.skillKey.localeCompare(b.skillKey),
		)
		.slice(0, 2048);
	const entries: SkillObservation[] = selected.map((evidence) => {
		let status: SkillObservation["status"] = evidence.status;
		let errorCode: SkillObservation["errorCode"] = status === "failed" ? "reconcile_failed" : null;
		if (status !== "failed") {
			try {
				if (reservations === null) throw new Error("ownership evidence unavailable");
				const reservation = reservations.find(
					(item) => item.id === evidence.skillKey && item.targetDir === evidence.targetDir,
				);
				const matches =
					evidence.targetDir !== null &&
					(status === "installed"
						? reservation?.digest === evidence.digest &&
							hashSkillIdentity(
								reservation.sourceIdentity ??
									["bundled", reservation.id, String(reservation.version)].join("\0"),
							) === evidence.sourceIdentity &&
							evidence.treeDigest !== null &&
							installedSkillTreeDigest(
								evidence.targetDir,
								evidence.runtime,
								reservation.sourceIdentity,
							) === evidence.treeDigest &&
							(evidence.runtime !== "hermes" ||
								!reservation.sourceIdentity ||
								nativeHermesMatches(evidence.targetDir, reservation.sourceIdentity))
						: !reservation &&
							withRuntimeUserFileAccess(() => collectManagedSkillTree(evidence.targetDir ?? ""))
								.status === "absent");
				if (!matches) {
					status = "unknown";
					errorCode = "evidence_mismatch";
				}
			} catch {
				status = "unknown";
				errorCode = "evidence_missing";
			}
		}
		return {
			skillKey: evidence.skillKey,
			runtime: evidence.runtime,
			sourceIdentity: evidence.sourceIdentity,
			digest: evidence.digest,
			desiredState: evidence.desiredState,
			status,
			errorCode,
			sourceRevision: applied.sourceRevision,
			generation: resolveRuntimeApplyGeneration(applied),
		};
	});
	return {
		schemaVersion: 1,
		truncated: selected.length < applied.skillEvidence.length,
		entries: entries.sort((a, b) =>
			a.runtime < b.runtime
				? -1
				: a.runtime > b.runtime
					? 1
					: a.skillKey < b.skillKey
						? -1
						: a.skillKey > b.skillKey
							? 1
							: 0,
		),
	};
}
