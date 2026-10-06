import chalk from "chalk";
import {
	CONFIG_KEYS,
	type ConfigKey,
	getClawdiDir,
	getConfig,
	getEffectiveConfig,
	getStoredConfig,
	setConfigKey,
	unsetConfigKey,
} from "../lib/config";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";

function isKnownKey(k: string): k is ConfigKey {
	return (CONFIG_KEYS as readonly string[]).includes(k);
}

function unknownKey(k: string) {
	console.error(chalk.red(`Unknown config key: ${k}`));
	console.error(chalk.gray(`  Known keys: ${CONFIG_KEYS.join(", ")}`));
}

export function configList(opts: { json?: boolean } = {}) {
	const effective = getEffectiveConfig();
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					schemaVersion: "clawdi.config.v1",
					values: effective,
				},
				null,
				2,
			),
		);
		return;
	}

	for (const key of CONFIG_KEYS) {
		const entry = effective[key];
		console.log(`  ${chalk.cyan(key)} = ${String(entry.value)} ${chalk.gray(`(${entry.source})`)}`);
	}
}

export function configGet(key: string) {
	if (!isKnownKey(key)) {
		unknownKey(key);
		process.exit(1);
	}
	console.log(getEffectiveConfig()[key].value);
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

function deployApiUrlSource(): "CLAWDI_DEPLOY_API_URL" | "config.json" | "default" {
	if (process.env.CLAWDI_DEPLOY_API_URL) return "CLAWDI_DEPLOY_API_URL";
	if (getStoredConfig().deployApiUrl) return "config.json";
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
		deployApiUrl: getConfig().deployApiUrl,
		deployApiUrlSource: deployApiUrlSource(),
		local: {
			clawdiHome: getClawdiDir(),
			config: paths.localConfig,
			auth: paths.localAuth,
			pendingAuth: paths.localPendingAuth,
			environments: paths.localEnvironments,
			serveState: paths.serveState,
		},
		hosted: {
			hostPolicy: hostedPaths.hostPolicy,
			serviceStateRoot: hostedPaths.serviceStateRoot,
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
	console.log(chalk.gray(`    run:        ${payload.hosted.runRoot}`));
	console.log(chalk.gray(`    home:       ${payload.hosted.persistentHome}`));
	console.log();
	console.log(chalk.gray(`  API URL: ${payload.apiUrl} (${payload.apiUrlSource})`));
	console.log(
		chalk.gray(`  Deploy API URL: ${payload.deployApiUrl} (${payload.deployApiUrlSource})`),
	);
}
