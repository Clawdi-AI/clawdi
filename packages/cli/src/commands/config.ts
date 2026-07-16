import chalk from "chalk";
import {
	CONFIG_KEYS,
	type ConfigKey,
	getClawdiDir,
	getConfig,
	getStoredConfig,
	setConfigKey,
	unsetConfigKey,
} from "../lib/config";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";

function isKnownKey(k: string): k is ConfigKey {
	return (CONFIG_KEYS as readonly string[]).includes(k);
}

function unknownKey(k: string) {
	console.log(chalk.red(`Unknown config key: ${k}`));
	console.log(chalk.gray(`  Known keys: ${CONFIG_KEYS.join(", ")}`));
}

export function configList() {
	const stored = getStoredConfig();
	if (Object.keys(stored).length === 0) {
		console.log(chalk.gray("(no configuration set — using defaults)"));
	} else {
		for (const [k, v] of Object.entries(stored)) {
			console.log(`  ${chalk.cyan(k)} = ${v}`);
		}
	}

	// Surface the env override so users aren't confused by a set-in-disk
	// value being ignored at runtime.
	if (process.env.CLAWDI_API_URL) {
		console.log();
		console.log(
			chalk.gray(`  note: CLAWDI_API_URL=${process.env.CLAWDI_API_URL} overrides apiUrl`),
		);
	}
}

export function configGet(key: string) {
	if (!isKnownKey(key)) {
		unknownKey(key);
		process.exit(1);
	}
	const value = getStoredConfig()[key];
	if (value === undefined) {
		// Exit code 1 matches `git config --get` behavior for unset keys.
		process.exit(1);
	}
	console.log(value);
}

export function configSet(key: string, value: string) {
	if (!isKnownKey(key)) {
		unknownKey(key);
		process.exit(1);
	}
	setConfigKey(key, value);
	console.log(chalk.green(`✓ Set ${key}`));
}

export function configUnset(key: string) {
	if (!isKnownKey(key)) {
		unknownKey(key);
		process.exit(1);
	}
	unsetConfigKey(key);
	console.log(chalk.green(`✓ Unset ${key}`));
}

function apiUrlSource(): "CLAWDI_API_URL" | "config.json" | "default" {
	if (process.env.CLAWDI_API_URL) return "CLAWDI_API_URL";
	if (getStoredConfig().apiUrl) return "config.json";
	return "default";
}

export function configPaths(opts: { json?: boolean } = {}) {
	const mode = detectRuntimeMode();
	const paths = getRuntimePaths({ mode });
	const hostedPaths = getRuntimePaths({ mode: "hosted" });
	const payload = {
		schemaVersion: "clawdi.configPaths.v1",
		runtimeMode: mode,
		apiUrl: getConfig().apiUrl,
		apiUrlSource: apiUrlSource(),
		local: {
			clawdiHome: getClawdiDir(),
			config: paths.localConfig,
			auth: paths.localAuth,
			pendingAuth: paths.localPendingAuth,
			environments: paths.localEnvironments,
			serveState: paths.serveState,
		},
		hosted: {
			imageShim: hostedPaths.imageShim,
			hostPolicy: hostedPaths.hostPolicy,
			shareRoot: hostedPaths.shareRoot,
			serviceStateRoot: hostedPaths.serviceStateRoot,
			managedConfig: hostedPaths.managedConfig,
			syncState: hostedPaths.syncState,
			managedCliBin: hostedPaths.cliManagedBin,
			cliNpmPrefix: hostedPaths.cliNpmPrefix,
			cliBootstrapStatus: hostedPaths.cliBootstrapStatus,
			runRoot: hostedPaths.runRoot,
			persistentHome: hostedPaths.userHome,
			workspaceRoot: hostedPaths.workspaceRoot,
		},
	};

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold("clawdi config paths"));
	console.log();
	console.log(chalk.bold("  Local"));
	console.log(chalk.gray(`    clawdiHome: ${payload.local.clawdiHome}`));
	console.log(chalk.gray(`    config:     ${payload.local.config}`));
	console.log(chalk.gray(`    auth:       ${payload.local.auth}`));
	console.log(chalk.gray(`    envs:       ${payload.local.environments}`));
	console.log();
	console.log(chalk.bold("  Hosted"));
	console.log(chalk.gray(`    policy:     ${payload.hosted.hostPolicy}`));
	console.log(chalk.gray(`    state:      ${payload.hosted.serviceStateRoot}`));
	console.log(chalk.gray(`    config:     ${payload.hosted.managedConfig}`));
	console.log(chalk.gray(`    run:        ${payload.hosted.runRoot}`));
	console.log(chalk.gray(`    home:       ${payload.hosted.persistentHome}`));
	console.log();
	console.log(chalk.gray(`  API URL: ${payload.apiUrl} (${payload.apiUrlSource})`));
}
