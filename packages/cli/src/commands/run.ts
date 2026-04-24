import { spawn } from "node:child_process";
import chalk from "chalk";
import { ApiClient, ApiError } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

export async function run(args: string[]) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}

	if (args.length === 0) {
		console.log(chalk.red("No command specified. Usage: clawdi run -- <command>"));
		process.exit(1);
	}

	// Fetch vault secrets
	const api = new ApiClient();
	let vaultEnv: Record<string, string> = {};

	try {
		vaultEnv = await api.post<Record<string, string>>("/api/vault/resolve");
	} catch (e) {
		if (e instanceof ApiError && e.status === 403) {
			console.log(chalk.red("vault/resolve requires CLI authentication (ApiKey)."));
			process.exit(1);
		}
		console.log(chalk.yellow(`⚠ Could not fetch vault secrets: ${(e as Error).message}`));
		console.log(chalk.gray("  Running without vault injection."));
	}

	const injectedCount = Object.keys(vaultEnv).length;
	if (injectedCount > 0) {
		console.log(chalk.green(`✓ Injected ${injectedCount} vault secrets`));
	}

	// Spawn child process with injected env
	const [cmd, ...cmdArgs] = args;
	const child = spawn(cmd, cmdArgs, {
		env: { ...process.env, ...vaultEnv },
		stdio: "inherit",
	});

	child.on("error", (err) => {
		console.log(chalk.red(`Failed to start: ${err.message}`));
		process.exit(1);
	});

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}
