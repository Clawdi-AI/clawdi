import chalk from "chalk";

import { getAuth, getConfig } from "../lib/config";
import { listScopes } from "../lib/scope-resolver";

/**
 * `clawdi scope list` — every scope visible to the caller, with a
 * column marking whether it's owned or shared-with-me. Same data
 * `/api/scopes` returns to the dashboard, formatted for terminal
 * consumption.
 */
export async function scopeListCommand(): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const scopes = await listScopes(apiUrl, auth.apiKey);
	if (scopes.length === 0) {
		console.log("No scopes yet.");
		return;
	}

	const owned = scopes.filter((s) => s.is_owner !== false);
	const shared = scopes.filter((s) => s.is_owner === false);

	console.log(chalk.bold(`My scopes (${owned.length}):`));
	for (const s of owned) {
		console.log(
			`  ${chalk.cyan(s.slug.padEnd(24))} ${chalk.gray(s.id)}  ${chalk.dim(`(${s.kind})`)}`,
		);
		if (s.name && s.name !== s.slug) {
			console.log(`    ${chalk.dim(s.name)}`);
		}
	}

	if (shared.length === 0) return;
	console.log();
	console.log(chalk.bold(`Shared with me (${shared.length}):`));
	for (const s of shared) {
		console.log(
			`  ${chalk.magenta(s.slug.padEnd(24))} ${chalk.gray(s.id)}  ${chalk.dim(`(${s.kind})`)}`,
		);
		if (s.name && s.name !== s.slug) {
			console.log(`    ${chalk.dim(s.name)}`);
		}
	}
}
