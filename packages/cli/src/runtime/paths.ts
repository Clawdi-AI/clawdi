import { homedir } from "node:os";
import { join } from "node:path";
import { getClawdiDir } from "../lib/config";

export type RuntimeMode = "local" | "hosted";

export interface RuntimePaths {
	mode: RuntimeMode;
	userHome: string;
	clawdiHome: string;
	localConfig: string;
	localAuth: string;
	localPendingAuth: string;
	localEnvironments: string;
	serveState: string;
	imageShim: string;
	hostPolicy: string;
	runtimeSource: string;
	shareRoot: string;
	serviceStateRoot: string;
	managedConfig: string;
	syncState: string;
	cliShim: string;
	cliManagedBin: string;
	cliNpmPrefix: string;
	cliNpmCache: string;
	cliBootstrapStatus: string;
	cliUpgradeState: string;
	providerHealthStatus: string;
	egressEngineStatus: string;
	maintainedRoot: string;
	egressEngineMaintainedRoot: string;
	cacheRoot: string;
	manifestLastGood: string;
	appliedState: string;
	manifestEtag: string;
	channelsEtag: string;
	managedSecretCacheFile: string;
	runConfigRoot: string;
	egressProfileRoot: string;
	egressProfileBundle: string;
	systemdSystemRoot: string;
	systemdUserRoot: string;
	systemdEnvRoot: string;
	bootRoot: string;
	bootStatus: string;
	runtimeWatchStatus: string;
	cloudStatus: string;
	cloudResult: string;
	instanceRoot: string;
	installInventory: string;
	projectionRoot: string;
	runRoot: string;
	managedSecretRoot: string;
	managedSecretFile: string;
	runtimeSecretFileRoot: string;
	egressRoot: string;
	egressScratchRoot: string;
	egressTransparentEnv: string;
	egressAddon: string;
	egressCaDir: string;
	egressCaCert: string;
	egressSystemCaFile: string;
	daemonAuthToken: string;
	instanceData: string;
	sensitiveInstanceData: string;
	workspaceRoot: string;
}

function envPath(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function defaultHome(mode: RuntimeMode): string {
	if (mode === "hosted") {
		return envPath("CLAWDI_RUNTIME_HOME") ?? process.env.HOME ?? "/home/clawdi";
	}
	return process.env.HOME || homedir();
}

function runningAsRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function defaultSystemdSystemRoot(mode: RuntimeMode, runRoot: string): string {
	if (mode === "hosted" && runningAsRoot()) return "/run/systemd/system";
	return join(runRoot, "systemd", "system");
}

export function getHostPolicyPath(): string {
	return envPath("CLAWDI_HOST_POLICY_PATH") ?? "/etc/clawdi/host-policy.json";
}

export function getRuntimeSourcePath(): string {
	return envPath("CLAWDI_RUNTIME_SOURCE_PATH") ?? "/etc/clawdi/runtime-source.json";
}

export function detectRuntimeMode(): RuntimeMode {
	const explicit = process.env.CLAWDI_RUNTIME_MODE?.trim().toLowerCase();
	if (explicit === "hosted") return "hosted";
	if (explicit === "local") return "local";
	return "local";
}

export function getRuntimePaths(opts: { mode?: RuntimeMode } = {}): RuntimePaths {
	const mode = opts.mode ?? detectRuntimeMode();
	const userHome = defaultHome(mode);
	const clawdiHome = getClawdiDir();
	const serviceStateRoot = envPath("CLAWDI_SERVICE_STATE_DIR") ?? "/var/lib/clawdi";
	const runRoot = envPath("CLAWDI_RUN_DIR") ?? "/run/clawdi";
	const imageShim = envPath("CLAWDI_IMAGE_SHIM_PATH") ?? "/usr/local/bin/clawdi";
	const shareRoot = envPath("CLAWDI_SHARE_DIR") ?? "/usr/share/clawdi";
	const binRoot = join(serviceStateRoot, "bin");
	const npmRoot = join(serviceStateRoot, "npm");
	const cacheRoot = join(serviceStateRoot, "cache");
	const bootRoot = join(serviceStateRoot, "boot");
	const instanceRoot = join(serviceStateRoot, "instances");

	return {
		mode,
		userHome,
		clawdiHome,
		localConfig: join(clawdiHome, "config.json"),
		localAuth: join(clawdiHome, "auth.json"),
		localPendingAuth: join(clawdiHome, "pending-auth.json"),
		localEnvironments: join(clawdiHome, "environments"),
		serveState: join(clawdiHome, "serve"),
		imageShim,
		hostPolicy: getHostPolicyPath(),
		runtimeSource: getRuntimeSourcePath(),
		shareRoot,
		serviceStateRoot,
		managedConfig: join(serviceStateRoot, "config", "clawdi.json"),
		syncState: join(serviceStateRoot, "sync", "runtimes.json"),
		cliShim: imageShim,
		cliManagedBin: join(binRoot, "clawdi"),
		cliNpmPrefix: npmRoot,
		cliNpmCache: join(serviceStateRoot, "npm-cache"),
		cliBootstrapStatus: join(serviceStateRoot, "status", "cli-bootstrap.json"),
		cliUpgradeState: join(serviceStateRoot, "status", "cli-upgrade-state.json"),
		providerHealthStatus: join(serviceStateRoot, "status", "provider-health.json"),
		egressEngineStatus: join(serviceStateRoot, "status", "egress-engine.json"),
		maintainedRoot: join(serviceStateRoot, "maintained"),
		egressEngineMaintainedRoot: join(serviceStateRoot, "maintained", "egress-engine", "mitmproxy"),
		cacheRoot,
		manifestLastGood: join(cacheRoot, "manifest.last-good.json"),
		appliedState: join(serviceStateRoot, "status", "runtime-applied.json"),
		manifestEtag: join(cacheRoot, "manifest.etag"),
		channelsEtag: join(cacheRoot, "channels.etag"),
		managedSecretCacheFile: join(cacheRoot, "runtime-secrets.last-good.json"),
		runConfigRoot: join(serviceStateRoot, "config", "run"),
		egressProfileRoot: join(serviceStateRoot, "config", "egress"),
		egressProfileBundle: join(serviceStateRoot, "config", "egress", "profiles.json"),
		systemdSystemRoot:
			envPath("CLAWDI_SYSTEMD_SYSTEM_ROOT") ?? defaultSystemdSystemRoot(mode, runRoot),
		systemdUserRoot: join(userHome, ".config", "systemd", "user"),
		systemdEnvRoot: join(runRoot, "systemd", "env"),
		bootRoot,
		bootStatus: join(cacheRoot, "boot-status.json"),
		runtimeWatchStatus: join(serviceStateRoot, "status", "runtime-watch.json"),
		cloudStatus: join(bootRoot, "status.json"),
		cloudResult: join(bootRoot, "result.json"),
		instanceRoot,
		installInventory: join(serviceStateRoot, "install-inventory"),
		projectionRoot: join(serviceStateRoot, "config", "projections"),
		runRoot,
		managedSecretRoot: join(runRoot, "secrets"),
		managedSecretFile: join(runRoot, "secrets", "runtime-secrets.json"),
		runtimeSecretFileRoot: join(runRoot, "secrets", "runtimes"),
		egressRoot: join(runRoot, "egress"),
		egressScratchRoot: join(runRoot, "egress-scratch"),
		egressTransparentEnv: join(runRoot, "egress", "transparent-egress.env"),
		egressAddon: join(runRoot, "egress", "clawdi_egress_addon.py"),
		egressCaDir: join(runRoot, "egress", "ca"),
		egressCaCert: join(runRoot, "egress", "ca", "mitmproxy-ca-cert.pem"),
		egressSystemCaFile: join(runRoot, "egress", "systemd", "ca.pem"),
		daemonAuthToken: join(runRoot, "secrets", "auth-token"),
		instanceData: join(runRoot, "instance-data.json"),
		sensitiveInstanceData: join(runRoot, "instance-data-sensitive.json"),
		workspaceRoot: join(userHome, "clawdi"),
	};
}
