import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { CodexAdapter } from "../adapters/codex";
import { HermesAdapter } from "../adapters/hermes";
import { OpenClawAdapter } from "../adapters/openclaw";
import { adapterRegistry } from "../adapters/registry";
import { ApiClient, ApiError } from "../lib/api-client";
import { getAuth, getClawdiDir, getConfig, isLoggedIn } from "../lib/config";

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

async function checkAuth(): Promise<Check> {
	const auth = getAuth();
	if (!auth) {
		return {
			name: "Auth",
			ok: false,
			detail: "not logged in",
			hint: "Run `clawdi auth login`",
		};
	}
	return {
		name: "Auth",
		ok: true,
		detail: auth.email || auth.userId || "logged in",
	};
}

async function checkApiReachable(): Promise<Check> {
	const config = getConfig();
	if (!isLoggedIn()) {
		return { name: "API reachability", ok: false, detail: "skipped (not logged in)" };
	}
	try {
		const api = new ApiClient();
		await api.get("/api/auth/me");
		return { name: "API reachability", ok: true, detail: config.apiUrl };
	} catch (e) {
		const msg =
			e instanceof ApiError ? `${config.apiUrl} → ${e.status || "network error"}` : String(e);
		return {
			name: "API reachability",
			ok: false,
			detail: msg,
			hint: e instanceof ApiError ? e.hint : "Check CLAWDI_API_URL",
		};
	}
}

async function checkAgents(): Promise<Check[]> {
	const adapters: AgentAdapter[] = [
		new ClaudeCodeAdapter(),
		new HermesAdapter(),
		new OpenClawAdapter(),
		new CodexAdapter(),
	];
	const results: Check[] = [];
	for (const a of adapters) {
		const label = adapterRegistry[a.agentType].displayName;
		const detected = await a.detect();
		if (!detected) {
			results.push({ name: `Agent: ${label}`, ok: false, detail: "not installed" });
			continue;
		}
		const version = await a.getVersion();
		results.push({
			name: `Agent: ${label}`,
			ok: true,
			detail: version ?? "detected",
		});
	}
	return results;
}

function checkRegisteredEnvs(): Check {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) {
		return {
			name: "Environments",
			ok: false,
			detail: "none registered",
			hint: "Run `clawdi setup` to register this machine",
		};
	}
	const files = readdirSync(envDir).filter((f) => f.endsWith(".json"));
	if (files.length === 0) {
		return {
			name: "Environments",
			ok: false,
			detail: "none registered",
			hint: "Run `clawdi setup`",
		};
	}
	return {
		name: "Environments",
		ok: true,
		detail: files.map((f) => f.slice(0, -".json".length)).join(", "),
	};
}

async function checkVault(): Promise<Check> {
	if (!isLoggedIn()) {
		return { name: "Vault resolve", ok: false, detail: "skipped (not logged in)" };
	}
	try {
		const api = new ApiClient();
		const env = await api.post<Record<string, string>>("/api/vault/resolve");
		return {
			name: "Vault resolve",
			ok: true,
			detail: `${Object.keys(env).length} secrets resolved`,
		};
	} catch (e) {
		return {
			name: "Vault resolve",
			ok: false,
			detail: e instanceof ApiError ? `status ${e.status}` : String(e),
			hint: e instanceof ApiError ? e.hint : undefined,
		};
	}
}

async function checkMcp(): Promise<Check> {
	if (!isLoggedIn()) {
		return { name: "MCP connectors", ok: false, detail: "skipped (not logged in)" };
	}
	try {
		const api = new ApiClient();
		await api.get("/api/connectors/mcp-config");
		return { name: "MCP connectors", ok: true, detail: "config reachable" };
	} catch (e) {
		return {
			name: "MCP connectors",
			ok: false,
			detail: e instanceof ApiError ? `status ${e.status}` : String(e),
			hint: e instanceof ApiError ? e.hint : undefined,
		};
	}
}

export async function doctor(opts: { json?: boolean } = {}) {
	const checks: Check[] = [];
	checks.push(await checkAuth());
	checks.push(await checkApiReachable());
	checks.push(...(await checkAgents()));
	checks.push(checkRegisteredEnvs());
	checks.push(await checkVault());
	checks.push(await checkMcp());

	const failed = checks.filter((c) => !c.ok).length;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(checks, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	console.log(chalk.bold("clawdi doctor"));
	console.log();
	for (const c of checks) {
		const icon = c.ok ? chalk.green("✓") : chalk.red("✗");
		const name = c.ok ? chalk.white(c.name) : chalk.red(c.name);
		const detail = c.detail ? chalk.gray(` — ${c.detail}`) : "";
		console.log(`  ${icon} ${name}${detail}`);
		if (!c.ok && c.hint) {
			console.log(chalk.gray(`     ${c.hint}`));
		}
	}
	console.log();

	if (failed === 0) {
		console.log(chalk.green("All checks passed."));
	} else {
		console.log(chalk.yellow(`${failed} check${failed === 1 ? "" : "s"} failed.`));
		process.exitCode = 1;
	}
}
