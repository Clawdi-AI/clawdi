import { createHash } from "node:crypto";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import { TRANSPARENT_EGRESS_TRANSPORT_VERSION } from "./transparent-egress";

export interface RuntimeProgramRevisionInput {
	renderedProjection: {
		channels: unknown;
		gateway: unknown;
		locale: unknown;
		mcp: unknown;
		provider: string | null;
		skills: unknown;
	};
	desiredRuntime: RuntimeManifest["runtimes"][string] | undefined;
	secretValues: Record<string, string>;
}

interface RuntimeEgressIdentity {
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}

interface RuntimeServiceProgramImpact {
	runtime: string;
	service: string | null;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

interface RuntimeEgressProgramImpact {
	transparentPort: number;
	profileBundlePath: string;
	secretFilePath: string | null;
	engine: Extract<RuntimeMitmproxyEnsureResult, { status: "ready" }>;
	addonSha256: string;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const input = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(input)
				.sort()
				.map((key) => [key, canonicalize(input[key])]),
		);
	}
	return value;
}

export function runtimeImpactRevision(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex")
		.slice(0, 32);
}

export function runtimeProgramRevision(input: RuntimeProgramRevisionInput): string {
	const runtime = input.desiredRuntime
		? Object.fromEntries(
				Object.entries(input.desiredRuntime).filter(([field]) => field !== "services"),
			)
		: null;
	return runtimeImpactRevision({
		renderedProjection: input.renderedProjection,
		runtime,
		secretValues: input.secretValues,
	});
}

export function runtimeServiceProgramRevision(program: RuntimeServiceProgramImpact): string {
	return runtimeImpactRevision({
		runtime: program.runtime,
		service: program.service,
		command: program.command,
		args: program.args,
		cwd: program.cwd,
		env: program.env,
	});
}

export function daemonProgramRevision(
	manifest: Pick<RuntimeManifest, "controlPlane" | "liveSync">,
): string {
	return runtimeImpactRevision({
		controlPlane: manifest.controlPlane,
		liveSync: manifest.liveSync ?? null,
	});
}

export function runtimeSidecarProgramRevision(
	manifest: Pick<RuntimeManifest, "instanceId" | "egressProfiles">,
	egressProgram: RuntimeEgressProgramImpact | null = null,
	egressIdentity: RuntimeEgressIdentity | null = null,
): string {
	if (egressProgram && !egressIdentity) {
		throw new Error("runtime sidecar egress revision requires the configured numeric identity");
	}
	return runtimeImpactRevision({
		runtimeSidecar: "hosted-runtime-sidecar-v4",
		instanceId: manifest.instanceId,
		egressProfiles: manifest.egressProfiles ?? null,
		egress: egressProgram
			? {
					transparentPort: egressProgram.transparentPort,
					profileBundlePath: egressProgram.profileBundlePath,
					secretFilePath: egressProgram.secretFilePath,
					engine: egressProgram.engine,
					addonSha256: egressProgram.addonSha256,
					transport: TRANSPARENT_EGRESS_TRANSPORT_VERSION,
					identity: egressIdentity,
				}
			: null,
	});
}
