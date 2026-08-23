import { dirname, isAbsolute, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimeUserProcessRevisionAliases } from "./applied-state";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeManifestLoad } from "./manifest-source";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import { runtimePlatformRootForPath, writeRuntimePlatformFileAtomic } from "./state";

export interface RuntimeConvergenceResult {
	manifest: RuntimeManifest;
	source: RuntimeManifestLoad["source"];
	sourcePath: string;
	offline: boolean;
	mode: "normal" | "degraded-offline";
	enabledRuntimes: string[];
	installErrors: string[];
	resourceProjectionErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	agentPluginFailedNames: string[];
	outputs: {
		processManager: "systemd";
		workspaceRoot: string;
		manifestLastGood: string | null;
		appliedState: string | null;
		managedLocaleFiles: string[];
		runConfigs: string[];
		systemdSystemUnitRoot: string;
		systemdSystemUnits: string[];
		systemdUserUnitRoot: string;
		systemdUserUnits: string[];
		egressProfileBundle: string | null;
		egressSecretFile: string | null;
		egressEngine: RuntimeMitmproxyEnsureResult | null;
		egressTransparentEnv: string | null;
		egressAddon: string | null;
		liveSyncEnvironments: string[];
		daemonAuthTokenFile: string | null;
	};
}
type RuntimeSystemdApplyResult = {
	applied: boolean;
	systemUnitsChanged: string[];
	userUnitsChanged: string[];
};
interface RuntimeSystemdApplySignal {
	// Private, in-memory apply metadata. It must not enter convergence outputs,
	// status, diagnostics, logs, or any generated public artifact.
	restartDaemon: boolean;
	restartEgressSidecar: boolean;
	restartUserUnits: string[];
	staleSystemUnits: string[];
	staleUserUnits: string[];
}
export interface RuntimeSystemdApplyHooks {
	activateEgressPrerequisite: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	activate: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	transactionState: () => "pristine" | "mutated";
	installOfficialService: (unit: string, install: () => string | null) => string | null;
	quiesce: (affectedUserUnits: readonly string[]) => void;
	rollback: (signal: RuntimeSystemdApplySignal) => void;
}
export interface RuntimePrivateAppliedAuthority {
	// These private activation verifiers may only be persisted in the root-owned
	// 0600 applied-state authority.
	daemonAuthTokenRevision?: string;
	daemonProgramRevision?: string;
	egressSidecarSecretRevision?: string;
	userProcessRevisionAliases?: RuntimeUserProcessRevisionAliases;
	officialServiceCommandRevisions: Record<string, string>;
}
export function writeRuntimePrivateFileAtomic(
	paths: RuntimePaths,
	path: string,
	content: string | Uint8Array,
	options: { mode?: number; dirMode?: number } = {},
): void {
	const trustedRoot = runtimePlatformRootForPath(paths, path);
	if (trustedRoot) writeRuntimePlatformFileAtomic(paths, path, content, options);
	else writePrivateFileAtomic(path, content, options);
}
export function writeJsonFile(path: string, payload: unknown, paths?: RuntimePaths): void {
	const content = `${JSON.stringify(payload, null, 2)}\n`;
	if (paths) writeRuntimePrivateFileAtomic(paths, path, content);
	else writePrivateFileAtomic(path, content);
}
export function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
export function toWebSocketUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	else throw new Error("URL must use HTTP or HTTPS");
	if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
	return url.toString();
}
export function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}
export function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isPlainRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, canonicalJsonValue(entry)]),
	);
}
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function mutationAncestorMetadataTargets(
	targets: readonly string[],
	boundaries: readonly string[],
): string[] {
	const resolvedBoundaries = boundaries.map((boundary) => resolve(boundary));
	const metadata = new Set<string>();
	for (const target of targets) {
		const resolvedTarget = resolve(target);
		const resolvedBoundary = resolvedBoundaries.find((boundary) => {
			const relativeTarget = relative(boundary, resolvedTarget);
			return (
				relativeTarget === "" || (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
			);
		});
		if (!resolvedBoundary) {
			throw new Error(`runtime mutation target is outside managed user roots: ${resolvedTarget}`);
		}
		if (resolvedTarget === resolvedBoundary) continue;
		let parent = dirname(resolvedTarget);
		while (parent !== resolvedBoundary) {
			metadata.add(parent);
			parent = dirname(parent);
		}
	}
	return [...metadata];
}
