import { readFileSync } from "node:fs";
import type { components } from "@clawdi/shared/api";
import { z } from "zod";
import type { RuntimeAppliedState } from "./applied-state";
import { resolveRuntimeApplyGeneration } from "./apply-identity";
import { readHostedAgentPluginReceipt } from "./hosted-agent-plugin-package";
import type { RuntimeManifest } from "./manifest-contract";
import {
	agentPluginNameSchema,
	hostedAgentPluginInstallationSchema,
	hostedAgentPluginsDesiredStateSchema,
} from "./manifest-resources";
import type { RuntimePaths } from "./paths";

type AgentPluginObservation = components["schemas"]["HostedRuntimeObservedAgentPluginV1"];
export type AgentPluginsObservation = components["schemas"]["HostedRuntimeObservedAgentPluginsV1"];

const observationErrorCodeSchema = z.enum([
	"reconcile_failed",
	"receipt_missing",
	"receipt_unreadable",
	"receipt_mismatch",
]);
const agentPluginObservationSchema: z.ZodType<AgentPluginObservation> =
	hostedAgentPluginInstallationSchema
		.pick({ version: true, contentDigest: true })
		.extend({
			installationId: z.uuid().max(200),
			name: agentPluginNameSchema,
			sourceRevision: z.string().regex(/^[0-9a-f]{64}$/),
			generation: z.number().int().positive().safe(),
			status: z.enum(["installed", "failed", "unknown"]),
			errorCode: observationErrorCodeSchema.nullable().optional(),
		})
		.strict()
		.superRefine((observation, ctx) => {
			if (observation.status === "installed" && observation.errorCode != null) {
				ctx.addIssue({ code: "custom", message: "installed observation cannot include errorCode" });
			}
			if (observation.status === "failed" && observation.errorCode !== "reconcile_failed") {
				ctx.addIssue({ code: "custom", message: "failed observation requires reconcile_failed" });
			}
			if (
				observation.status === "unknown" &&
				!(["receipt_missing", "receipt_unreadable", "receipt_mismatch"] as const).includes(
					observation.errorCode as "receipt_missing" | "receipt_unreadable" | "receipt_mismatch",
				)
			) {
				ctx.addIssue({ code: "custom", message: "unknown observation requires a receipt error" });
			}
		});

export const agentPluginsObservationSchema: z.ZodType<AgentPluginsObservation> = z
	.object({
		schemaVersion: z.literal(1),
		installations: z.array(agentPluginObservationSchema).max(128),
	})
	.strict()
	.superRefine((observation, ctx) => {
		const names = observation.installations.map((installation) => installation.name);
		const ids = observation.installations.map((installation) => installation.installationId);
		if (new Set(names).size !== names.length || new Set(ids).size !== ids.length) {
			ctx.addIssue({ code: "custom", message: "observation identities must be unique" });
		}
		if (!names.every((name, index) => index === 0 || (names[index - 1] ?? "") < name)) {
			ctx.addIssue({ code: "custom", message: "observations must be sorted by name" });
		}
	});

const appliedManifestPluginsSchema = z
	.object({
		instanceId: z.string().min(1),
		generation: z.number().int().nonnegative(),
		applyGeneration: z.number().int().positive().safe().optional(),
		projection: z
			.object({ agentPlugins: hostedAgentPluginsDesiredStateSchema.optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

interface InstallationIdentity {
	installationId: string;
	name: string;
	version: string;
	contentDigest: string;
}

type ReceiptRead =
	| { status: "ok"; installations: Map<string, InstallationIdentity> }
	| { status: "missing" | "unreadable"; installations: Map<string, InstallationIdentity> };

function installationIdentity(
	name: string,
	installation: {
		installationId: string;
		version: string;
		contentDigest: string;
	},
): InstallationIdentity {
	return {
		installationId: installation.installationId,
		name,
		version: installation.version,
		contentDigest: installation.contentDigest,
	};
}

function readReceipt(paths: RuntimePaths): ReceiptRead {
	try {
		const receipt = readHostedAgentPluginReceipt(paths);
		if (!receipt) return { status: "missing", installations: new Map() };
		return {
			status: "ok",
			installations: new Map(
				Object.entries(receipt.installations).map(([name, installation]) => [
					name,
					installationIdentity(name, installation),
				]),
			),
		};
	} catch {
		return { status: "unreadable", installations: new Map() };
	}
}

function readAppliedInstallations(
	paths: RuntimePaths,
	applied: RuntimeAppliedState,
): Map<string, InstallationIdentity> | null {
	try {
		const manifest = appliedManifestPluginsSchema.parse(
			JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")),
		);
		if (
			manifest.instanceId !== applied.instanceId ||
			resolveRuntimeApplyGeneration(manifest) !== resolveRuntimeApplyGeneration(applied)
		) {
			return null;
		}
		return new Map(
			Object.entries(manifest.projection?.agentPlugins?.installations ?? {}).map(
				([name, installation]) => [name, installationIdentity(name, installation)],
			),
		);
	} catch {
		return null;
	}
}

function sameIdentity(left: InstallationIdentity, right: InstallationIdentity): boolean {
	return (
		left.installationId === right.installationId &&
		left.name === right.name &&
		left.version === right.version &&
		left.contentDigest === right.contentDigest
	);
}

function installedObservation(
	identity: InstallationIdentity,
	applied: RuntimeAppliedState,
): AgentPluginObservation {
	return agentPluginObservationSchema.parse({
		...identity,
		sourceRevision: applied.sourceRevision,
		generation: resolveRuntimeApplyGeneration(applied),
		status: "installed",
	});
}

function unknownObservation(
	identity: InstallationIdentity,
	applied: RuntimeAppliedState,
	errorCode: "receipt_missing" | "receipt_unreadable" | "receipt_mismatch",
): AgentPluginObservation {
	return agentPluginObservationSchema.parse({
		...identity,
		sourceRevision: applied.sourceRevision,
		generation: resolveRuntimeApplyGeneration(applied),
		status: "unknown",
		errorCode,
	});
}

function failedWatchObservation(watchStatus: unknown): AgentPluginsObservation | null {
	if (!watchStatus || typeof watchStatus !== "object" || Array.isArray(watchStatus)) return null;
	const event = (watchStatus as Record<string, unknown>).event;
	if (!event || typeof event !== "object" || Array.isArray(event)) return null;
	const record = event as Record<string, unknown>;
	if (record.status !== "error") return null;
	const parsed = agentPluginsObservationSchema.safeParse(record.agentPlugins);
	if (!parsed.success || parsed.data.installations.some((item) => item.status !== "failed")) {
		return null;
	}
	return parsed.data;
}

function observationsForAppliedState(
	paths: RuntimePaths,
	applied: RuntimeAppliedState,
	receipt: ReceiptRead,
): AgentPluginsObservation | null {
	const desired = readAppliedInstallations(paths, applied);
	if (desired === null) {
		if (receipt.status !== "ok" || receipt.installations.size === 0) return null;
		return agentPluginsObservationSchema.parse({
			schemaVersion: 1,
			installations: [...receipt.installations.values()]
				.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
				.map((identity) => unknownObservation(identity, applied, "receipt_mismatch")),
		});
	}
	if (desired.size === 0 && receipt.installations.size === 0) return null;

	const receiptMatchesDesired =
		receipt.status === "ok" &&
		receipt.installations.size === desired.size &&
		[...desired].every(([name, identity]) => {
			const receiptIdentity = receipt.installations.get(name);
			return receiptIdentity !== undefined && sameIdentity(identity, receiptIdentity);
		});
	const unknownCode =
		receipt.status === "missing"
			? "receipt_missing"
			: receipt.status === "unreadable"
				? "receipt_unreadable"
				: "receipt_mismatch";
	return agentPluginsObservationSchema.parse({
		schemaVersion: 1,
		installations: [...desired.values()]
			.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
			.map((identity) =>
				receiptMatchesDesired
					? installedObservation(identity, applied)
					: unknownObservation(identity, applied, unknownCode),
			),
	});
}

export function readHostedAgentPluginsObservation(input: {
	paths: RuntimePaths;
	applied: RuntimeAppliedState;
	watchStatus: unknown;
}): AgentPluginsObservation | null {
	const receipt = readReceipt(input.paths);
	const applied = observationsForAppliedState(input.paths, input.applied, receipt);
	const failed = failedWatchObservation(input.watchStatus);
	if (!failed) return applied;

	const appliedGeneration = resolveRuntimeApplyGeneration(input.applied);
	const currentFailures = failed.installations.filter(
		(observation) =>
			observation.generation > appliedGeneration ||
			(observation.generation === appliedGeneration &&
				observation.sourceRevision === input.applied.sourceRevision),
	);
	if (currentFailures.length === 0) return applied;
	const failedNames = new Set(currentFailures.map((observation) => observation.name));
	return agentPluginsObservationSchema.parse({
		schemaVersion: 1,
		installations: [
			...(applied?.installations.filter((observation) => !failedNames.has(observation.name)) ?? []),
			...currentFailures,
		].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
	});
}

export function failedHostedAgentPluginsObservation(
	manifest: RuntimeManifest,
	sourceRevision: string,
	failedNames: readonly string[],
): AgentPluginsObservation | null {
	const names = new Set(failedNames);
	const installations = Object.entries(manifest.projection?.agentPlugins?.installations ?? {})
		.filter(([name]) => names.has(name))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, installation]) => ({
			...installationIdentity(name, installation),
			sourceRevision,
			generation: resolveRuntimeApplyGeneration(manifest),
			status: "failed" as const,
			errorCode: "reconcile_failed" as const,
		}));
	if (installations.length === 0) return null;
	const parsed = agentPluginsObservationSchema.safeParse({ schemaVersion: 1, installations });
	return parsed.success ? parsed.data : null;
}
