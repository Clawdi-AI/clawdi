import chalk from "chalk";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENT_TYPES, AGENT_LABELS, type AgentType } from "@clawdi-cloud/shared/consts";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import type { AgentAdapter } from "../adapters/base";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";

const allAdapters: AgentAdapter[] = [new ClaudeCodeAdapter()];

export async function setup(opts: { agent?: string }) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	const machineId = createHash("sha256")
		.update(`${hostname()}-${process.platform}-${process.arch}`)
		.digest("hex")
		.slice(0, 16);
	const machineName = hostname();
	const api = new ApiClient();

	if (opts.agent) {
		if (!AGENT_TYPES.includes(opts.agent as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${opts.agent}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			return;
		}
		await registerEnv(api, opts.agent as AgentType, null, machineId, machineName);
		return;
	}

	// Auto-detect
	console.log(chalk.cyan("Detecting installed agents..."));
	const detected: { adapter: AgentAdapter; version: string | null }[] = [];

	for (const adapter of allAdapters) {
		if (await adapter.detect()) {
			const version = await adapter.getVersion();
			detected.push({ adapter, version });
		}
	}

	if (detected.length === 0) {
		console.log(chalk.yellow("  No supported agents detected."));
		console.log(chalk.gray("  Use --agent to specify manually."));
		return;
	}

	// Show detected and ask user to confirm each
	console.log();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const toRegister: typeof detected = [];

	try {
		for (const d of detected) {
			const label = `${AGENT_LABELS[d.adapter.agentType]}${d.version ? ` (${d.version})` : ""}`;
			const answer = await rl.question(chalk.cyan(`  Register ${label}? [Y/n] `));
			if (answer.toLowerCase() !== "n") {
				toRegister.push(d);
			}
		}
	} finally {
		rl.close();
	}

	if (toRegister.length === 0) {
		console.log(chalk.gray("No agents selected."));
		return;
	}

	console.log();
	for (const { adapter, version } of toRegister) {
		await registerEnv(api, adapter.agentType, version, machineId, machineName);
		await registerMcpServer(adapter.agentType);
	}
}

async function registerEnv(
	api: ApiClient,
	agentType: AgentType,
	agentVersion: string | null,
	machineId: string,
	machineName: string,
) {
	try {
		const env = await api.post<{ id: string }>("/api/environments", {
			machine_id: machineId,
			machine_name: machineName,
			agent_type: agentType,
			agent_version: agentVersion,
			os: process.platform,
		});

		const envDir = join(getClawdiDir(), "environments");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, `${agentType}.json`),
			JSON.stringify({ id: env.id, agentType, machineId, machineName }, null, 2) + "\n",
			{ mode: 0o600 },
		);

		console.log(chalk.green(`✓ ${AGENT_LABELS[agentType]} registered`));
	} catch (e: any) {
		console.log(chalk.red(`  Failed to register ${AGENT_LABELS[agentType]}: ${e.message}`));
	}
}

async function registerMcpServer(agentType: AgentType) {
	if (agentType !== "claude_code") return;

	// Find the CLI entry point
	const cliPath = resolve(import.meta.dirname, "../../src/index.ts");
	const mcpConfig = JSON.stringify({
		type: "stdio",
		command: "bun",
		args: ["run", cliPath, "mcp"],
	});

	try {
		execSync(`claude mcp add-json clawdi '${mcpConfig}' --scope user`, {
			stdio: "pipe",
		});
		console.log(chalk.green("✓ MCP server registered in Claude Code"));
	} catch {
		console.log(chalk.yellow("⚠ Could not auto-register MCP server."));
		console.log(chalk.gray(`  Run manually: claude mcp add-json clawdi '${mcpConfig}' --scope user`));
	}
}
