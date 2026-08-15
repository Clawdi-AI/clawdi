import { lstatSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { PreparedHostedAgentPlugins } from "./hosted-agent-plugin-package";
import type { HostedAgentPluginBehavioralEvidence } from "./hosted-agent-plugin-runtime";
import { hostedAgentPluginCommands } from "./hosted-agent-plugin-runtime";
import type { RuntimePaths } from "./paths";
import { runtimeCommandCurrentRevision } from "./runtime-systemd-reconciliation";
import { writeRuntimePlatformFileAtomic } from "./state";

const CAPABILITY_PROOF_SCHEMA = "clawdi.hostedAgentPluginCapabilityProof.v1";
const MAX_CAPABILITY_PROOF_BYTES = 16 * 1024;

const capabilityProofSchema = z
	.object({
		schemaVersion: z.literal(CAPABILITY_PROOF_SCHEMA),
		runtime: z.enum(["openclaw", "hermes"]),
		command: z.string().refine(isAbsolute),
		commandRevision: z.string().regex(/^[0-9a-f]{64}$/),
		package: z
			.object({
				name: z.string().min(1).max(64),
				ownershipIdentity: z.string().regex(/^[0-9a-f]{64}$/),
				nativeId: z.string().min(1).max(128),
			})
			.strict(),
	})
	.strict();

type HostedAgentPluginPersistentCapabilityProof = z.infer<typeof capabilityProofSchema>;
type CommandRevisionResolver = (command: string, home: string) => string | null;

function defaultCommandRevision(command: string, home: string): string | null {
	return runtimeCommandCurrentRevision(command, home, home);
}

export function hostedAgentPluginCapabilityProofPath(paths: RuntimePaths): string {
	return join(paths.statusRoot, "runtime-agent-plugin-capability.json");
}

export function clearHostedAgentPluginCapabilityProof(paths: RuntimePaths): void {
	rmSync(hostedAgentPluginCapabilityProofPath(paths), { force: true });
}

export function clearHostedAgentPluginCapabilityProofUnlessOwned(
	prepared: PreparedHostedAgentPlugins | null,
	paths: RuntimePaths,
): void {
	const proof = readCapabilityProof(paths);
	if (
		proof &&
		prepared?.runtime === proof.runtime &&
		prepared.desired.get(proof.package.name)?.installation.ownershipIdentity ===
			proof.package.ownershipIdentity
	) {
		return;
	}
	clearHostedAgentPluginCapabilityProof(paths);
}

function readCapabilityProof(
	paths: RuntimePaths,
): HostedAgentPluginPersistentCapabilityProof | null {
	const path = hostedAgentPluginCapabilityProofPath(paths);
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size > MAX_CAPABILITY_PROOF_BYTES ||
			(stat.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		) {
			clearHostedAgentPluginCapabilityProof(paths);
			return null;
		}
		return capabilityProofSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		clearHostedAgentPluginCapabilityProof(paths);
		return null;
	}
}

export function writeHostedAgentPluginCapabilityProof(
	evidence: HostedAgentPluginBehavioralEvidence,
	paths: RuntimePaths,
	resolveCommandRevision: CommandRevisionResolver = defaultCommandRevision,
): void {
	const commandRevision = resolveCommandRevision(evidence.command, paths.userHome);
	if (!commandRevision)
		throw new Error("Agent Plugin runtime command identity could not be proven");
	const proof = capabilityProofSchema.parse({
		schemaVersion: CAPABILITY_PROOF_SCHEMA,
		runtime: evidence.runtime,
		command: evidence.command,
		commandRevision,
		package: {
			name: evidence.package.name,
			ownershipIdentity: evidence.package.ownershipIdentity,
			nativeId: evidence.package.nativeId,
		},
	});
	writeRuntimePlatformFileAtomic(
		paths,
		hostedAgentPluginCapabilityProofPath(paths),
		`${JSON.stringify(proof, null, 2)}\n`,
		{ mode: 0o600, dirMode: 0o755 },
	);
}

export function hostedAgentPluginCapabilityHeader(
	paths: RuntimePaths,
	resolveCommandRevision: CommandRevisionResolver = defaultCommandRevision,
): string | null {
	const proof = readCapabilityProof(paths);
	if (!proof) return null;
	const expectedCommand = hostedAgentPluginCommands(paths.userHome)[proof.runtime];
	let currentRevision: string | null = null;
	try {
		currentRevision = resolveCommandRevision(expectedCommand, paths.userHome);
	} catch {
		currentRevision = null;
	}
	if (
		proof.command !== expectedCommand ||
		!currentRevision ||
		currentRevision !== proof.commandRevision
	) {
		clearHostedAgentPluginCapabilityProof(paths);
		return null;
	}
	return `v1:${proof.runtime}:${proof.package.ownershipIdentity}:${proof.commandRevision}`;
}
