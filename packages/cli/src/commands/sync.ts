import chalk from "chalk";

export async function syncUp(opts: { modules?: string; since?: string; dryRun?: boolean }) {
	console.log(chalk.yellow("TODO: collect local data via adapter, upload to API"));
}

export async function syncDown(opts: { modules?: string; dryRun?: boolean }) {
	console.log(chalk.yellow("TODO: pull from API, write to local via adapter"));
}
