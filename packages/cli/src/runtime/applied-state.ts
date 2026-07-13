import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";

const appliedContentSourceSchema = z
	.object({
		sourcePath: z.string().min(1),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

const projectedProviderIdsSchema = z.record(
	z.string().min(1),
	z
		.array(z.string().min(1))
		.refine((providerIds) => new Set(providerIds).size === providerIds.length, {
			message: "projected provider IDs must be unique",
		}),
);

export const runtimeAppliedStateSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeAppliedState.v1"),
		appliedAt: z.string().datetime({ offset: true }),
		instanceId: z.string().min(1),
		observedManifestEtag: z.string().min(1).nullable(),
		observedChannelsEtag: z.string().min(1).nullable(),
		observedConfigGeneration: z.number().int().nonnegative(),
		contentIdentity: z
			.object({
				manifest: appliedContentSourceSchema.extend({
					source: z.enum(["fixture-file", "remote-datasource", "last-good-cache"]),
				}),
				channels: appliedContentSourceSchema.nullable(),
			})
			.strict(),
		projectedProviderIds: projectedProviderIdsSchema,
	})
	.strict()
	.superRefine((state, context) => {
		if (state.contentIdentity.channels === null && state.observedChannelsEtag !== null) {
			context.addIssue({
				code: "custom",
				path: ["observedChannelsEtag"],
				message: "observed channels ETag requires applied channels content",
			});
		}
	});

export type RuntimeAppliedState = z.infer<typeof runtimeAppliedStateSchema>;
export type RuntimeAppliedContentSource = z.infer<typeof appliedContentSourceSchema>;
export type RuntimeAppliedContentIdentity = RuntimeAppliedState["contentIdentity"];

export function runtimeContentSha256(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

export function readRuntimeAppliedState(paths: RuntimePaths): RuntimeAppliedState | null {
	if (!existsSync(paths.appliedState)) return null;
	try {
		const parsed = runtimeAppliedStateSchema.safeParse(
			JSON.parse(readFileSync(paths.appliedState, "utf-8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function writeRuntimeAppliedState(state: RuntimeAppliedState, paths: RuntimePaths): string {
	const parsed = runtimeAppliedStateSchema.parse(state);
	writePrivateFileAtomic(paths.appliedState, `${JSON.stringify(parsed, null, 2)}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
	return paths.appliedState;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalize(record[key])]),
		);
	}
	return value;
}
