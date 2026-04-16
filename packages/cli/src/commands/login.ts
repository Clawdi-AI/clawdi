import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { clearAuth, getAuth, getConfig, isLoggedIn, setAuth } from "../lib/config";

export async function login() {
	if (isLoggedIn()) {
		const auth = getAuth()!;
		console.log(chalk.yellow(`Already logged in as ${auth.email || auth.userId || "unknown"}`));
		console.log(chalk.gray("Run `clawdi logout` first to switch accounts."));
		return;
	}

	const config = getConfig();
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		console.log(chalk.white("To get an API key:"));
		console.log(chalk.gray("  1. Go to the Clawdi Cloud dashboard"));
		console.log(chalk.gray("  2. Open user menu → API Keys"));
		console.log(chalk.gray("  3. Create a new key and copy it"));
		console.log();

		const apiKey = await rl.question(chalk.cyan("Paste your API key: "));
		if (!apiKey.trim()) {
			console.log(chalk.red("No API key provided."));
			return;
		}

		// Verify the key works
		const res = await fetch(`${config.apiUrl}/api/auth/me`, {
			headers: { Authorization: `Bearer ${apiKey.trim()}` },
		});

		if (!res.ok) {
			console.log(chalk.red(`Authentication failed: ${res.status}`));
			return;
		}

		const me = (await res.json()) as { id: string; email: string; name: string };
		setAuth({ apiKey: apiKey.trim(), userId: me.id, email: me.email });

		console.log();
		console.log(chalk.green(`✓ Logged in as ${me.email || me.name || me.id}`));
		console.log(chalk.gray("  Credentials saved to ~/.clawdi/auth.json"));
	} finally {
		rl.close();
	}
}

export async function logout() {
	if (!isLoggedIn()) {
		console.log(chalk.gray("Not logged in."));
		return;
	}

	clearAuth();
	console.log(chalk.green("✓ Logged out. Credentials removed."));
}
