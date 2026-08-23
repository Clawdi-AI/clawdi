import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import type { EgressProfileBundle } from "./egress-profiles";
import { HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION, type RuntimeManifest } from "./manifest-contract";
import { makeEgressIdentityOwned } from "./manifest-secrets";
import { writeRuntimePrivateFileAtomic } from "./manifest-shared";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import { RUNTIME_USER_CLI_STATE_ROOT_MODE, type RuntimePaths } from "./paths";
import type { RuntimeEgressSystemdProgram } from "./runtime-systemd-reconciliation";
import { runningAsRoot, runtimeEgressGid } from "./runtime-user-command";
import {
	TRANSPARENT_EGRESS_TABLE,
	TRANSPARENT_EGRESS_TRANSPORT_VERSION,
} from "./transparent-egress";

export function ensureRuntimeUserCliStateRoot(
	path: string,
	identity: { uid: number; gid: number },
): void {
	mkdirSync(path, { recursive: true });
	let node = lstatSync(path);
	if (!node.isDirectory() || node.isSymbolicLink()) {
		throw new Error(`hosted CLAWDI_HOME must be a real directory: ${path}`);
	}
	if (runningAsRoot()) chownSync(path, identity.uid, identity.gid);
	chmodSync(path, RUNTIME_USER_CLI_STATE_ROOT_MODE);
	node = lstatSync(path);
	if (
		(node.mode & 0o777) !== RUNTIME_USER_CLI_STATE_ROOT_MODE ||
		node.uid !== identity.uid ||
		node.gid !== identity.gid
	) {
		throw new Error(`hosted CLAWDI_HOME ownership or mode is invalid: ${path}`);
	}
}
export function makeEgressIdentityPrivateDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeEgressIdentityOwned(path);
	try {
		chmodSync(path, 0o700);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
}
export function clearEgressProfileBundle(paths: RuntimePaths): null {
	rmSync(paths.egressProfileBundle, { force: true });
	return null;
}
export function requireV2EgressEngineReady(
	manifest: RuntimeManifest,
	profileBundlePath: string | null,
	engine: RuntimeMitmproxyEnsureResult | null,
): void {
	if (
		manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION &&
		profileBundlePath &&
		engine?.status !== "ready"
	) {
		throw new Error(
			`required egress engine is not ready: ${engine?.error ?? "status unavailable"}`,
		);
	}
}
export function writeEgressProfileBundle(bundle: EgressProfileBundle, paths: RuntimePaths): string {
	// Published handoff: the egress sidecar (clawdi-egress uid) reads this
	// bundle, so it lives under the traversable run root next to the other
	// sidecar inputs (addon, transparent env, CA) — never under a private
	// platform root the sidecar cannot traverse.
	writeRuntimePrivateFileAtomic(
		paths,
		paths.egressProfileBundle,
		`${JSON.stringify(bundle, null, 2)}\n`,
		{
			mode: 0o640,
			dirMode: 0o711,
		},
	);
	if (runningAsRoot()) chownSync(paths.egressProfileBundle, 0, runtimeEgressGid());
	return paths.egressProfileBundle;
}
export function writeEgressAddon(paths: RuntimePaths): { path: string; sha256: string } {
	const source = resolvePackagedEgressAddon();
	const content = readFileSync(source, "utf-8");
	writeRuntimePrivateFileAtomic(paths, paths.egressAddon, content, {
		mode: 0o640,
		dirMode: 0o711,
	});
	if (runningAsRoot()) chownSync(paths.egressAddon, 0, runtimeEgressGid());
	return { path: paths.egressAddon, sha256: sha256String(content) };
}
export function clearEgressAddon(paths: RuntimePaths): null {
	rmSync(paths.egressAddon, { force: true });
	return null;
}
function resolvePackagedEgressAddon(): string {
	const candidate = resolve(
		resolveCurrentCliResourceRoot(),
		"egress-addon",
		"clawdi_egress_addon.py",
	);
	if (existsSync(candidate)) return candidate;
	throw new Error("packaged egress addon is missing");
}
export function writeTransparentEgressEnvFile(input: {
	program: RuntimeEgressSystemdProgram | null;
	paths: RuntimePaths;
	runtimeUser: string;
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}): string | null {
	if (!input.program) {
		rmSync(input.paths.egressTransparentEnv, { force: true });
		return null;
	}
	const env: Record<string, string> = {
		CLAWDI_RUNTIME_USER: input.runtimeUser,
		CLAWDI_RUNTIME_UID: String(input.runtimeUid),
		CLAWDI_RUNTIME_GID: String(input.runtimeGid),
		CLAWDI_EGRESS_UID: String(input.egressUid),
		CLAWDI_EGRESS_GID: String(input.egressGid),
		CLAWDI_EGRESS_TRANSPARENT_PORT: String(input.program.transparentPort),
		CLAWDI_EGRESS_NFT_TABLE: TRANSPARENT_EGRESS_TABLE,
		CLAWDI_EGRESS_PROFILE_BUNDLE: input.program.profileBundlePath,
		CLAWDI_EGRESS_SECRET_FILE: input.program.secretFilePath ?? "",
		CLAWDI_EGRESS_CA_DIR: input.paths.egressCaDir,
		CLAWDI_EGRESS_CA_CERT: input.paths.egressCaCert,
		CLAWDI_EGRESS_SYSTEM_CA_BUNDLE: input.program.systemCaBundle,
		CLAWDI_EGRESS_TRANSPORT_VERSION: TRANSPARENT_EGRESS_TRANSPORT_VERSION,
		CLAWDI_EGRESS_ENGINE_TYPE: "mitmproxy",
		CLAWDI_EGRESS_ENGINE_VERSION: input.program.engine.version,
		CLAWDI_EGRESS_ENGINE_URL: input.program.engine.url,
		CLAWDI_EGRESS_ENGINE_SHA256: input.program.engine.sha256,
		CLAWDI_EGRESS_ENGINE_BINARY_PATH: input.paths.egressServiceBinary,
		CLAWDI_EGRESS_ADDON_PATH: input.program.addonPath,
		CLAWDI_EGRESS_ADDON_SHA256: input.program.addonSha256,
	};
	const lines = Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${runtimeEnvironmentFileQuote(value)}`);
	writeRuntimePrivateFileAtomic(
		input.paths,
		input.paths.egressTransparentEnv,
		`${lines.join("\n")}\n`,
		{
			mode: 0o640,
			dirMode: 0o711,
		},
	);
	if (runningAsRoot()) chownSync(input.paths.egressTransparentEnv, 0, input.egressGid);
	return input.paths.egressTransparentEnv;
}
function runtimeEnvironmentFileQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("runtime environment files only support single-line values");
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function sha256String(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
