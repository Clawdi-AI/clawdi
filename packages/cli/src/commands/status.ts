import type { ModuleState } from "@clawdi-cloud/shared/types";
import chalk from "chalk";
import { getAuth, getConfig, isLoggedIn } from "../lib/config";
import { readModuleState } from "../lib/state";

interface StatusJson {
	loggedIn: boolean;
	user?: { email?: string; id?: string };
	apiUrl: string;
	activity: Record<string, { lastActivityAt: string }>;
}

function buildStatus(): StatusJson {
	const config = getConfig();
	const auth = getAuth();
	const state = (readModuleState() ?? {}) as ModuleState;
	const entries: Record<string, { lastActivityAt: string }> = {};
	for (const [k, v] of Object.entries(state)) {
		if (
			v &&
			typeof v === "object" &&
			"lastActivityAt" in v &&
			typeof v.lastActivityAt === "string"
		) {
			entries[k] = { lastActivityAt: v.lastActivityAt };
		}
	}
	return {
		loggedIn: isLoggedIn(),
		user: auth ? { email: auth.email, id: auth.userId } : undefined,
		apiUrl: config.apiUrl,
		activity: entries,
	};
}

export async function status(opts: { json?: boolean } = {}) {
	const s = buildStatus();

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(s, null, 2));
		return;
	}

	console.log(chalk.bold("Clawdi Cloud Status"));
	console.log();

	if (s.loggedIn) {
		console.log(chalk.green("  Auth:     ✓ logged in"));
		console.log(chalk.gray(`  User:     ${s.user?.email || s.user?.id || "unknown"}`));
		console.log(chalk.gray(`  API:      ${s.apiUrl}`));
	} else {
		console.log(chalk.red("  Auth:     ✗ not logged in"));
		console.log(chalk.gray("  Run `clawdi auth login` to authenticate."));
	}

	console.log();

	const activityEntries = Object.entries(s.activity);
	if (activityEntries.length > 0) {
		console.log(chalk.bold("  Activity:"));
		for (const [module, state] of activityEntries) {
			const ago = timeSince(new Date(state.lastActivityAt));
			console.log(chalk.gray(`    ${module}: last activity ${ago}`));
		}
	} else {
		console.log(chalk.gray("  Activity: no activity yet"));
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
