import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getClawdiDir } from "../lib/config";
import { runningAsRoot } from "./runtime-user-command";

export type RuntimeMode = "local" | "hosted";

export const SYSTEMD_PLATFORM_DIRECTORY = "clawdi";
export const SYSTEMD_FILE_BROWSER_STATE_DIRECTORY = "clawdi-files";

export const DEFAULT_CONFIGURATION_ROOT = "/etc/clawdi";
export const DEFAULT_SERVICE_STATE_ROOT = "/var/lib/clawdi";
export const DEFAULT_CACHE_ROOT = "/var/cache/clawdi";
export const DEFAULT_RUN_ROOT = "/run/clawdi";
export const DEFAULT_RUNTIME_USER_CLI_STATE_ROOT = "/var/lib/clawdi-user";
export const DEFAULT_FILE_BROWSER_STATE_ROOT = "/var/lib/clawdi-files";
export const DEFAULT_FILE_BROWSER_RUNTIME_ROOT = "/run/clawdi-files";
export const RUNTIME_USER_CLI_STATE_ROOT_MODE = 0o750;

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
	maintainedRoot: string;
	managedCliRoot: string;
	cliManagedBin: string;
	cliNpmPrefix: string;
	cliNpmCache: string;
	userNpmPrefix: string;
	cliBootstrapStatus: string;
	cliUpgradeState: string;
	providerHealthStatus: string;
	egressEngineMaintainedRoot: string;
	fileBrowserInstallRoot: string;
	fileBrowserConfigRoot: string;
	fileBrowserStateRoot: string;
	fileBrowserServiceBinary: string;
	fileBrowserConfig: string;
	cacheRoot: string;
	hostedSkillArchiveRoot: string;
	manifestLastGood: string;
	appliedState: string;
	managedSecretCacheFile: string;
	runConfigRoot: string;
	egressProfileRoot: string;
	egressProfileBundle: string;
	systemdSystemRoot: string;
	systemdUserRoot: string;
	systemdRuntimeRoot: string;
	systemdEnvRoot: string;
	bootStatus: string;
	runtimeWatchStatus: string;
	runtimeHeartbeatRoot: string;
	managedResourceRoot: string;
	runRoot: string;
	convergeLock: string;
	managedSecretRoot: string;
	daemonStateRoot: string;
	egressRoot: string;
	egressTransparentEnv: string;
	egressAddon: string;
	egressCaDir: string;
	egressCaCert: string;
	egressSystemCaFile: string;
	egressServiceBinary: string;
	daemonAuthToken: string;
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

function defaultClawdiHome(mode: RuntimeMode, serviceStateRoot: string): string {
	if (mode === "hosted") {
		const override = envPath("CLAWDI_HOME");
		if (override) return override;
		if (serviceStateRoot === DEFAULT_SERVICE_STATE_ROOT) {
			return DEFAULT_RUNTIME_USER_CLI_STATE_ROOT;
		}
		return join(dirname(serviceStateRoot), `${basename(serviceStateRoot)}-user`);
	}
	return getClawdiDir();
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
	const serviceStateRoot = envPath("CLAWDI_SERVICE_STATE_DIR") ?? DEFAULT_SERVICE_STATE_ROOT;
	const clawdiHome = defaultClawdiHome(mode, serviceStateRoot);
	const userLocalRoot = join(userHome, ".local");
	const userLocalBin = join(userLocalRoot, "bin");
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
		maintainedRoot,
		managedCliRoot,
		cliManagedBin: join(managedCliRoot, "bin", "clawdi"),
		cliNpmPrefix: npmRoot,
		cliNpmCache: join(cacheRoot, "npm"),
		userNpmPrefix: userLocalRoot,
		cliBootstrapStatus: join(statusRoot, "cli-bootstrap.json"),
		cliUpgradeState: join(statusRoot, "cli-upgrade-state.json"),
		providerHealthStatus: join(statusRoot, "provider-health.json"),
		egressEngineMaintainedRoot: join(maintainedRoot, "egress-engine", "mitmproxy"),
		fileBrowserInstallRoot: join(maintainedRoot, "filebrowser"),
		fileBrowserConfigRoot,
		fileBrowserStateRoot: DEFAULT_FILE_BROWSER_STATE_ROOT,
		fileBrowserServiceBinary: join(DEFAULT_FILE_BROWSER_RUNTIME_ROOT, "filebrowser"),
		fileBrowserConfig: join(fileBrowserConfigRoot, "filebrowser.yaml"),
		cacheRoot,
		hostedSkillArchiveRoot: join(cacheRoot, "workspace-skills"),
		manifestLastGood: join(cacheRoot, "manifest.last-good.json"),
		appliedState: join(statusRoot, "runtime-applied.json"),
		managedSecretCacheFile: join(cacheRoot, "runtime-secrets.last-good.json"),
		runConfigRoot: join(configurationRoot, "run"),
		egressProfileRoot: join(runRoot, "egress"),
		egressProfileBundle: join(runRoot, "egress", "profiles.json"),
		systemdSystemRoot:
			envPath("CLAWDI_SYSTEMD_SYSTEM_ROOT") ?? defaultSystemdSystemRoot(mode, runRoot),
		systemdUserRoot: join(userHome, ".config", "systemd", "user"),
		systemdRuntimeRoot: join(runRoot, "systemd"),
		systemdEnvRoot: join(runRoot, "systemd", "env"),
		bootStatus: join(statusRoot, "boot-status.json"),
		runtimeWatchStatus: join(statusRoot, "runtime-watch.json"),
		runtimeHeartbeatRoot: join(serviceStateRoot, "heartbeat"),
		managedResourceRoot: join(serviceStateRoot, "managed-resources"),
		runRoot,
		convergeLock: join(runRoot, "locks", "converge.lock"),
		managedSecretRoot: join(runRoot, "secrets"),
		daemonStateRoot: join(serviceStateRoot, "daemon"),
		egressRoot: join(runRoot, "egress"),
		egressTransparentEnv: join(runRoot, "egress", "transparent-egress.env"),
		egressAddon: join(runRoot, "egress", "clawdi_egress_addon.py"),
		egressCaDir: join(runRoot, "egress", "ca"),
		egressCaCert: join(runRoot, "egress", "ca", "mitmproxy-ca-cert.pem"),
		egressSystemCaFile: join(runRoot, "egress", "systemd", "ca.pem"),
		egressServiceBinary: join(runRoot, "egress", "systemd", "mitmdump"),
		daemonAuthToken: join(runRoot, "secrets", "auth-token"),
		workspaceRoot: mode === "hosted" ? userHome : join(userHome, "clawdi"),
	};
}
