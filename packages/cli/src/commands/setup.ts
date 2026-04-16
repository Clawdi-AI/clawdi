import chalk from "chalk";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TYPES, type AgentType } from "@clawdi-cloud/shared/consts";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";

const adapters = [new ClaudeCodeAdapter()];

export async function setup(opts: { agent?: string }) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		return;
	}

	let agentType: AgentType | null = null;
	let detectedAdapter = null;

	if (opts.agent) {
		if (!AGENT_TYPES.includes(opts.agent as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${opts.agent}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			return;
		}
		agentType = opts.agent as AgentType;
	} else {
		console.log(chalk.cyan("Detecting installed agents..."));
		for (const adapter of adapters) {
			if (await adapter.detect()) {
				detectedAdapter = adapter;
				agentType = adapter.agentType;
				const version = await adapter.getVersion();
				console.log(
					chalk.green(`  ✓ Found ${adapter.agentType}${version ? ` (${version})` : ""}`),
				);
				break;
			}
		}

		if (!agentType) {
			console.log(chalk.yellow("  No supported agent detected."));
			console.log(chalk.gray("  Use --agent to specify manually."));
			return;
		}
	}

	const machineId = createHash("sha256")
		.update(`${hostname()}-${process.platform}-${process.arch}`)
		.digest("hex")
		.slice(0, 16);
	const machineName = hostname();

	const api = new ApiClient();

	try {
		const env = await api.post<{ id: string }>("/api/environments", {
			machine_id: machineId,
			machine_name: machineName,
			agent_type: agentType,
			agent_version: detectedAdapter ? await detectedAdapter.getVersion() : null,
			os: process.platform,
		});

		// Save environment locally
		const envDir = join(getClawdiDir(), "environments");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, `${env.id}.json`),
			JSON.stringify(
				{ id: env.id, agentType, machineId, machineName },
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);

		// Save current environment ID
		const configPath = join(getClawdiDir(), "current-env.json");
		writeFileSync(configPath, JSON.stringify({ environmentId: env.id }) + "\n", { mode: 0o600 });

		console.log();
		console.log(chalk.green("✓ Environment registered"));
		console.log(chalk.gray(`  ID:      ${env.id}`));
		console.log(chalk.gray(`  Agent:   ${agentType}`));
		console.log(chalk.gray(`  Machine: ${machineName}`));
	} catch (e: any) {
		console.log(chalk.red(`Failed to register environment: ${e.message}`));
	}
}
