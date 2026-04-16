import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAuth, getClawdiDir, getConfig, isLoggedIn } from "../lib/config";

export async function status() {
	const config = getConfig();

	console.log(chalk.bold("Clawdi Cloud Status"));
	console.log();

	// Auth
	if (isLoggedIn()) {
		const auth = getAuth()!;
		console.log(chalk.green("  Auth:    ✓ logged in"));
		console.log(chalk.gray(`  User:    ${auth.email || auth.userId || "unknown"}`));
		console.log(chalk.gray(`  API:     ${config.apiUrl}`));
	} else {
		console.log(chalk.red("  Auth:    ✗ not logged in"));
		console.log(chalk.gray('  Run `clawdi login` to authenticate.'));
	}

	console.log();

	// Sync state
	const syncPath = join(getClawdiDir(), "sync.json");
	if (existsSync(syncPath)) {
		const sync = JSON.parse(readFileSync(syncPath, "utf-8"));
		console.log(chalk.bold("  Sync:"));
		for (const [module, state] of Object.entries(sync) as [string, { lastSyncedAt: string }][]) {
			const ago = timeSince(new Date(state.lastSyncedAt));
			console.log(chalk.gray(`    ${module}: last synced ${ago}`));
		}
	} else {
		console.log(chalk.gray("  Sync:    no sync history"));
	}
}

function timeSince(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
