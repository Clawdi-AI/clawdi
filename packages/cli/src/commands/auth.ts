import * as p from "@clack/prompts";
import chalk from "chalk";
import { clearAuth, getAuth, getConfig, isLoggedIn, setAuth } from "../lib/config";

export async function authLogin() {
	const existing = getAuth();
	if (existing) {
		p.log.warn(`Already logged in as ${existing.email || existing.userId || "unknown"}`);
		p.log.info("Run `clawdi auth logout` first to switch accounts.");
		return;
	}

	const config = getConfig();

	p.intro(chalk.bold("clawdi auth login"));
	p.log.message(
		"To get an API key:\n" +
			chalk.gray("  1. Go to the Clawdi Cloud dashboard\n") +
			chalk.gray("  2. Open user menu → API Keys\n") +
			chalk.gray("  3. Create a new key and copy it"),
	);

	const apiKey = await p.password({
		message: "Paste your API key",
		validate: (v) => (v?.trim() ? undefined : "API key cannot be empty"),
	});
	if (p.isCancel(apiKey)) {
		p.cancel("Cancelled.");
		return;
	}

	const verifySpinner = p.spinner();
	verifySpinner.start("Verifying...");

	const res = await fetch(`${config.apiUrl}/api/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey.trim()}` },
	});

	if (!res.ok) {
		verifySpinner.stop(chalk.red(`Authentication failed: ${res.status}`));
		p.outro(chalk.red("Aborted."));
		return;
	}

	const me = (await res.json()) as { id: string; email: string; name: string };
	setAuth({ apiKey: apiKey.trim(), userId: me.id, email: me.email });
	verifySpinner.stop(chalk.green(`Logged in as ${me.email || me.name || me.id}`));
	p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"));
}

export async function authLogout() {
	if (!isLoggedIn()) {
		p.log.info("Not logged in.");
		return;
	}

	clearAuth();
	p.log.success("Logged out. Credentials removed.");
}
