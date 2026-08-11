import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getClawdiDir } from "../lib/config";

export type RuntimeMode = "local" | "hosted";

export const SYSTEMD_PLATFORM_DIRECTORY = "clawdi";
export const SYSTEMD_FILE_BROWSER_STATE_DIRECTORY = "clawdi-files";

export const DEFAULT_CONFIGURATION_ROOT = "/etc/clawdi";
export const DEFAULT_SERVICE_STATE_ROOT = "/var/lib/clawdi";
export const DEFAULT_CACHE_ROOT = "/var/cache/clawdi";
export const DEFAULT_RUN_ROOT = "/run/clawdi";
export const DEFAULT_FILE_BROWSER_STATE_ROOT = "/var/lib/clawdi-files";
export const DEFAULT_FILE_BROWSER_RUNTIME_ROOT = "/run/clawdi-files";

export interface RuntimePaths {
	mode: RuntimeMode;
	userHome: string;
	clawdiHome: string;
	userLocalBin: string;
	localConfig: string;
	localAuth: string;
	localPendingAuth: string;
	localEnvironments: string;
	serveState: string;
	configurationRoot: string;
	runtimeContextFile: string;
	hostPolicy: string;
	serviceStateRoot: string;
	statusRoot: string;
	oauthCredentialRoot: string;
	managedConfig: string;
	syncState: string;
	maintainedRoot: string;
	managedCliRoot: string;
	cliManagedBin: string;
	cliNpmPrefix: string;
	cliNpmCache: string;
	codexInstallRoot: string;
	codexCommand: string;
	cliBootstrapStatus: string;
	cliUpgradeState: string;
	providerHealthStatus: string;
	egressEngineStatus: string;
	egressEngineMaintainedRoot: string;
	fileBrowserInstallRoot: string;
	fileBrowserConfigRoot: string;
	fileBrowserStateRoot: string;
	fileBrowserServiceBinary: string;
	fileBrowserConfig: string;
	cacheRoot: string;
	hostedSkillArchiveRoot: string;
	channelsEtag: string;
	manifestLastGood: string;
	appliedState: string;
	managedSecretCacheFile: string;
	runConfigRoot: string;
	egressProfileRoot: string;
	egressProfileBundle: string;
	liveSyncEnvironmentIndex: string;
	systemdSystemRoot: string;
	systemdUserRoot: string;
	systemdRuntimeRoot: string;
	systemdEnvRoot: string;
	bootStatus: string;
	runtimeWatchStatus: string;
	runtimeHeartbeatRoot: string;
	cloudStatus: string;
	cloudResult: string;
	instanceRoot: string;
	installInventory: string;
	installReceipts: string;
	managedResourceRoot: string;
	projectionRoot: string;
	runRoot: string;
	convergeLock: string;
	fileBrowserAclTempPrefix: string;
	managedSecretRoot: string;
	daemonStateRoot: string;
	egressRoot: string;
	egressScratchRoot: string;
	egressTransparentEnv: string;
	egressAddon: string;
	egressCaDir: string;
	egressCaCert: string;
	egressSystemCaFile: string;
	egressServiceBinary: string;
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

function defaultClawdiHome(mode: RuntimeMode, userHome: string): string {
	if (mode === "hosted") {
		// Keep the hosted user-state tree anchored to the resolved runtime home.
		return process.env.CLAWDI_HOME || join(userHome, ".clawdi");
	}
	return getClawdiDir();
}

function runningAsRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function defaultSystemdSystemRoot(mode: RuntimeMode, runRoot: string): string {
	if (mode === "hosted" && runningAsRoot()) return "/run/systemd/system";
	return join(runRoot, "systemd", "system");
}

function derivedPlatformRoot(
	serviceStateRoot: string,
	standardRoot: string,
	fallbackName: string,
): string {
	if (serviceStateRoot === DEFAULT_SERVICE_STATE_ROOT) return standardRoot;
	const stateParent = dirname(serviceStateRoot);
	const varRoot = dirname(stateParent);
	if (basename(stateParent) === "lib" && basename(varRoot) === "var") {
		const sandboxRoot = dirname(varRoot);
		return standardRoot === DEFAULT_CONFIGURATION_ROOT
			? join(sandboxRoot, "etc", basename(serviceStateRoot))
			: join(sandboxRoot, "var", "cache", basename(serviceStateRoot));
	}
	return join(stateParent, fallbackName);
}

export function getHostPolicyPath(configurationRoot = DEFAULT_CONFIGURATION_ROOT): string {
	return envPath("CLAWDI_HOST_POLICY_PATH") ?? join(configurationRoot, "host-policy.json");
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
	const clawdiHome = defaultClawdiHome(mode, userHome);
	const userLocalRoot = join(userHome, ".local");
	const userLocalBin = join(userLocalRoot, "bin");
	const userDataRoot = join(userLocalRoot, "share");
	const serviceStateRoot = envPath("CLAWDI_SERVICE_STATE_DIR") ?? DEFAULT_SERVICE_STATE_ROOT;
	const configurationRoot = derivedPlatformRoot(
		serviceStateRoot,
		DEFAULT_CONFIGURATION_ROOT,
		"config",
	);
	const cacheRoot = derivedPlatformRoot(serviceStateRoot, DEFAULT_CACHE_ROOT, "cache");
	const runRoot = envPath("CLAWDI_RUN_DIR") ?? DEFAULT_RUN_ROOT;
	const fileBrowserConfigRoot = join(runRoot, "files");
	const statusRoot = join(serviceStateRoot, "status");
	const maintainedRoot = join(serviceStateRoot, "maintained");
	const managedCliRoot = join(maintainedRoot, "clawdi");
	const npmRoot = join(managedCliRoot, "npm");
	const codexInstallRoot = join(userDataRoot, "clawdi", "codex");
	const instanceRoot = join(serviceStateRoot, "instances");

	return {
		mode,
		userHome,
		clawdiHome,
		userLocalBin,
		localConfig: join(clawdiHome, "config.json"),
		localAuth: join(clawdiHome, "auth.json"),
		localPendingAuth: join(clawdiHome, "pending-auth.json"),
		localEnvironments: join(clawdiHome, "environments"),
		serveState: join(clawdiHome, "serve"),
		configurationRoot,
		runtimeContextFile: join(configurationRoot, "runtime-context.json"),
		hostPolicy: getHostPolicyPath(configurationRoot),
		serviceStateRoot,
		statusRoot,
		oauthCredentialRoot: join(serviceStateRoot, "oauth-credentials"),
		managedConfig: join(configurationRoot, "clawdi.json"),
		syncState: join(serviceStateRoot, "sync", "runtimes.json"),
		maintainedRoot,
		managedCliRoot,
		cliManagedBin: join(managedCliRoot, "bin", "clawdi"),
		cliNpmPrefix: npmRoot,
		cliNpmCache: join(cacheRoot, "npm"),
		codexInstallRoot,
		codexCommand: join(userLocalBin, "codex"),
		cliBootstrapStatus: join(statusRoot, "cli-bootstrap.json"),
		cliUpgradeState: join(statusRoot, "cli-upgrade-state.json"),
		providerHealthStatus: join(statusRoot, "provider-health.json"),
		egressEngineStatus: join(statusRoot, "egress-engine.json"),
		egressEngineMaintainedRoot: join(maintainedRoot, "egress-engine", "mitmproxy"),
		fileBrowserInstallRoot: join(maintainedRoot, "filebrowser"),
		fileBrowserConfigRoot,
		fileBrowserStateRoot: DEFAULT_FILE_BROWSER_STATE_ROOT,
		fileBrowserServiceBinary: join(DEFAULT_FILE_BROWSER_RUNTIME_ROOT, "filebrowser"),
		fileBrowserConfig: join(fileBrowserConfigRoot, "filebrowser.yaml"),
		cacheRoot,
		hostedSkillArchiveRoot: join(cacheRoot, "workspace-skills"),
		channelsEtag: join(cacheRoot, "channels.etag"),
		manifestLastGood: join(cacheRoot, "manifest.last-good.json"),
		appliedState: join(statusRoot, "runtime-applied.json"),
		managedSecretCacheFile: join(cacheRoot, "runtime-secrets.last-good.json"),
		runConfigRoot: join(configurationRoot, "run"),
		egressProfileRoot: join(runRoot, "egress"),
		egressProfileBundle: join(runRoot, "egress", "profiles.json"),
		liveSyncEnvironmentIndex: join(configurationRoot, "runtime-live-sync-agents.json"),
		systemdSystemRoot:
			envPath("CLAWDI_SYSTEMD_SYSTEM_ROOT") ?? defaultSystemdSystemRoot(mode, runRoot),
		systemdUserRoot: join(userHome, ".config", "systemd", "user"),
		systemdRuntimeRoot: join(runRoot, "systemd"),
		systemdEnvRoot: join(runRoot, "systemd", "env"),
		bootStatus: join(statusRoot, "boot-status.json"),
		runtimeWatchStatus: join(statusRoot, "runtime-watch.json"),
		runtimeHeartbeatRoot: join(serviceStateRoot, "heartbeat"),
		cloudStatus: join(statusRoot, "cloud-status.json"),
		cloudResult: join(statusRoot, "cloud-result.json"),
		instanceRoot,
		installInventory: join(serviceStateRoot, "install-inventory"),
		installReceipts: join(statusRoot, "runtime-install-receipts.json"),
		managedResourceRoot: join(serviceStateRoot, "managed-resources"),
		projectionRoot: join(configurationRoot, "projections"),
		runRoot,
		convergeLock: join(runRoot, "locks", "converge.lock"),
		fileBrowserAclTempPrefix: join(runRoot, ".filebrowser-acl-"),
		managedSecretRoot: join(runRoot, "secrets"),
		daemonStateRoot: join(serviceStateRoot, "daemon"),
		egressRoot: join(runRoot, "egress"),
		egressScratchRoot: join(runRoot, "egress-scratch"),
		egressTransparentEnv: join(runRoot, "egress", "transparent-egress.env"),
		egressAddon: join(runRoot, "egress", "clawdi_egress_addon.py"),
		egressCaDir: join(runRoot, "egress", "ca"),
		egressCaCert: join(runRoot, "egress", "ca", "mitmproxy-ca-cert.pem"),
		egressSystemCaFile: join(runRoot, "egress", "systemd", "ca.pem"),
		egressServiceBinary: join(runRoot, "egress", "systemd", "mitmdump"),
		daemonAuthToken: join(runRoot, "secrets", "auth-token"),
		instanceData: join(runRoot, "instance-data.json"),
		sensitiveInstanceData: join(runRoot, "instance-data-sensitive.json"),
		workspaceRoot: mode === "hosted" ? userHome : join(userHome, "clawdi"),
	};
}
