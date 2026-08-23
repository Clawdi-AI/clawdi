import { readFileSync } from "node:fs";
import type { components } from "@clawdi/shared/api";
import { z } from "zod";
import type { RuntimeAppliedState } from "./applied-state";
import { resolveRuntimeApplyGeneration } from "./apply-identity";
import {
	type HostedAgentPluginReceipt,
	readHostedAgentPluginReceipt,
} from "./hosted-agent-plugin-package";
import type { RuntimeManifest } from "./manifest-contract";
import {
	agentPluginNameSchema,
	type HostedAgentPluginInstallation,
	hostedAgentPluginInstallationSchema,
} from "./manifest-resources";
import { hostedRuntimeBundleV2Schema } from "./manifest-source";
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

type ReceiptRead =
	| { status: "ok"; receipt: HostedAgentPluginReceipt }
	| { status: "missing" | "unreadable"; receipt: null };

function readReceipt(paths: RuntimePaths): ReceiptRead {
	try {
		const receipt = readHostedAgentPluginReceipt(paths);
		return receipt ? { status: "ok", receipt } : { status: "missing", receipt: null };
	} catch {
		return { status: "unreadable", receipt: null };
	}
}

function readAppliedManifest(
	paths: RuntimePaths,
	applied: RuntimeAppliedState,
): RuntimeManifest | null {
	try {
		const manifest = hostedRuntimeBundleV2Schema.parse(
			JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")),
		).manifest;
		return manifest.instanceId === applied.instanceId &&
			resolveRuntimeApplyGeneration(manifest) === resolveRuntimeApplyGeneration(applied)
			? manifest
			: null;
	} catch {
		return null;
	}
}

function installedObservation(
	name: string,
	installation: HostedAgentPluginInstallation,
	applied: RuntimeAppliedState,
): AgentPluginObservation {
	return agentPluginObservationSchema.parse({
		installationId: installation.installationId,
		name,
		version: installation.version,
		contentDigest: installation.contentDigest,
		sourceRevision: applied.sourceRevision,
		generation: resolveRuntimeApplyGeneration(applied),
		status: "installed",
	});
}

function unknownObservation(
	name: string,
	installation: HostedAgentPluginInstallation,
	applied: RuntimeAppliedState,
	errorCode: "receipt_missing" | "receipt_unreadable" | "receipt_mismatch",
): AgentPluginObservation {
	return agentPluginObservationSchema.parse({
		installationId: installation.installationId,
		name,
		version: installation.version,
		contentDigest: installation.contentDigest,
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
	const installations =
		receipt.status === "ok"
			? Object.entries(receipt.receipt.installations)
			: Object.entries(
					readAppliedManifest(paths, applied)?.projection?.agentPlugins?.installations ?? {},
				);
	if (installations.length === 0) return null;
	return agentPluginsObservationSchema.parse({
		schemaVersion: 1,
		installations: installations
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, installation]) =>
				receipt.status === "ok"
					? installedObservation(name, installation, applied)
					: unknownObservation(name, installation, applied, `receipt_${receipt.status}`),
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
		(observation) => observation.generation >= appliedGeneration,
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
			installationId: installation.installationId,
			name,
			version: installation.version,
			contentDigest: installation.contentDigest,
			sourceRevision,
			generation: resolveRuntimeApplyGeneration(manifest),
			status: "failed" as const,
			errorCode: "reconcile_failed" as const,
		}));
	if (installations.length === 0) return null;
	const parsed = agentPluginsObservationSchema.safeParse({ schemaVersion: 1, installations });
	return parsed.success ? parsed.data : null;
}
