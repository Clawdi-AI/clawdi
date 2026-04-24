import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import { getHermesHome } from "../adapters/paths";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	allAdapterEntries,
	builtinSkillTargetDir,
} from "../adapters/registry";
import { ApiClient } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { isInteractive } from "../lib/tty";

export async function setup(opts: { agent?: string; yes?: boolean }) {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exitCode = 1;
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
			process.exitCode = 1;
			return;
		}
		const type = opts.agent as AgentType;
		await registerEnv(api, type, null, machineId, machineName);
		await registerMcpServer(type);
		await installBuiltinSkill(type);
		return;
	}

	// Auto-detect
	console.log(chalk.cyan("Detecting installed agents..."));
	const detected: { adapter: AgentAdapter; version: string | null }[] = [];

	for (const entry of allAdapterEntries()) {
		const adapter = entry.create();
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

	// Select which detected agents to register. --yes auto-picks all;
	// non-interactive (CI / piped) also picks all so scripts can run setup.
	let toRegister: typeof detected;
	if (opts.yes || !isInteractive()) {
		toRegister = detected;
	} else {
		console.log();
		const result = await p.multiselect<string>({
			message: "Register which agents?",
			options: detected.map((d) => ({
				value: d.adapter.agentType as string,
				label: `${adapterRegistry[d.adapter.agentType].displayName}${d.version ? ` (${d.version})` : ""}`,
			})),
			initialValues: detected.map((d) => d.adapter.agentType),
			required: false,
		});
		if (p.isCancel(result)) {
			p.cancel("Cancelled.");
			return;
		}
		const picked = new Set(result as string[]);
		toRegister = detected.filter((d) => picked.has(d.adapter.agentType));
	}

	if (toRegister.length === 0) {
		console.log(chalk.gray("No agents selected."));
		return;
	}

	console.log();
	for (const { adapter, version } of toRegister) {
		await registerEnv(api, adapter.agentType, version, machineId, machineName);
		await registerMcpServer(adapter.agentType);
		await installBuiltinSkill(adapter.agentType);
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
			`${JSON.stringify({ id: env.id, agentType, machineId, machineName }, null, 2)}\n`,
			{ mode: 0o600 },
		);

		console.log(chalk.green(`✓ ${adapterRegistry[agentType].displayName} registered`));
	} catch (e) {
		console.log(
			chalk.red(
				`  Failed to register ${adapterRegistry[agentType].displayName}: ${(e as Error).message}`,
			),
		);
	}
}

async function installBuiltinSkill(agentType: AgentType) {
	const targetDir = builtinSkillTargetDir(agentType);
	if (!targetDir) return;
	const label = adapterRegistry[agentType].displayName;

	// Support both dev (src/commands/) and build (dist/) paths
	let sourceDir = resolve(import.meta.dirname, "../../skills/clawdi");
	if (!existsSync(sourceDir)) {
		sourceDir = resolve(import.meta.dirname, "skills/clawdi");
	}
	if (!existsSync(sourceDir)) {
		console.log(chalk.yellow("⚠ Built-in skill not found, skipping."));
		return;
	}

	const alreadyInstalled = existsSync(join(targetDir, "SKILL.md"));

	try {
		mkdirSync(targetDir, { recursive: true });
		// Always overwrite — the bundled skill content evolves with each CLI
		// release (better trigger language, new tool descriptions), and users
		// who ran setup once should get those improvements on re-run without
		// having to manually delete the old copy.
		cpSync(sourceDir, targetDir, { recursive: true, force: true });
		console.log(
			chalk.green(`✓ Clawdi skill ${alreadyInstalled ? "updated" : "installed"} in ${label}`),
		);
	} catch {
		console.log(chalk.yellow("⚠ Could not install Clawdi skill."));
	}
}

async function registerMcpServer(agentType: AgentType) {
	if (agentType === "hermes") return registerHermesMcp();
	if (agentType === "openclaw") return registerOpenClawMcp();
	if (agentType === "codex") return registerCodexMcp();
	if (agentType !== "claude_code") return;

	// Check if already registered. `claude mcp list` prints entries like
	// `  clawdi:   stdio  ...` — match the name as its own token at the start
	// of a line to avoid false hits from unrelated server names containing
	// the substring "clawdi:".
	try {
		const list = execSync("claude mcp list", { encoding: "utf-8", stdio: "pipe" });
		if (/^\s*clawdi:\s/m.test(list)) {
			console.log(chalk.gray("✓ MCP server already registered"));
			return;
		}
	} catch {
		// claude command not found or failed, try registering anyway
	}

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
		console.log(
			chalk.gray(`  Run manually: claude mcp add-json clawdi '${mcpConfig}' --scope user`),
		);
	}
}

async function registerHermesMcp() {
	const configPath = join(getHermesHome(), "config.yaml");

	if (!existsSync(configPath)) {
		console.log(chalk.yellow("⚠ Hermes config.yaml not found, skipping MCP registration."));
		return;
	}

	const { readFileSync: readFs, writeFileSync: writeFs } = await import("node:fs");
	const content = readFs(configPath, "utf-8");

	// Clawdi entry already present under mcp_servers.
	if (/^mcp_servers:/m.test(content) && /^\s+clawdi:/m.test(content)) {
		console.log(chalk.gray("✓ MCP server already registered in Hermes"));
		return;
	}

	const clawdiChild = `  clawdi:\n    command: "clawdi"\n    args: ["mcp"]`;
	const newSection = `mcp_servers:\n${clawdiChild}\n`;

	try {
		const HEADER_RE = /^mcp_servers:\s*(.*)$/m;
		const headerMatch = content.match(HEADER_RE);

		let updated: string;
		if (!headerMatch) {
			// No mcp_servers section at all — append a fresh block.
			updated = `${content.trimEnd()}\n\n${newSection}`;
		} else {
			const inlineValue = (headerMatch[1] ?? "").trim();
			if (inlineValue.startsWith("{") && inlineValue !== "{}") {
				// Inline flow map with existing entries — too risky to patch.
				throw new Error("mcp_servers uses inline flow map; edit config.yaml manually.");
			}
			// For empty map ({}, ~, null) or block map with children:
			// replace the header line with a block-style header followed by our child.
			// The regex's `m` flag anchors to line start, avoiding false matches like
			// `other_mcp_servers:`. Existing block children after the header line are
			// preserved because only the matched line is substituted.
			updated = content.replace(HEADER_RE, `mcp_servers:\n${clawdiChild}`);
		}

		writeFs(configPath, updated);
		console.log(chalk.green("✓ MCP server registered in Hermes"));
	} catch (e) {
		console.log(
			chalk.yellow(`⚠ Could not register MCP server in Hermes config: ${(e as Error).message}`),
		);
		console.log(chalk.gray(`  Edit ${configPath} and add under mcp_servers:`));
		console.log(chalk.gray(clawdiChild));
	}
}

function registerCodexMcp() {
	const cliPath = resolve(import.meta.dirname, "../../src/index.ts");

	try {
		const list = execSync("codex mcp list", { encoding: "utf-8", stdio: "pipe" });
		if (/^\s*clawdi\b/m.test(list)) {
			console.log(chalk.gray("✓ MCP server already registered in Codex"));
			return;
		}
	} catch {
		// codex not on PATH or subcommand failed — fall through and try `add` anyway.
	}

	try {
		execSync(`codex mcp add clawdi -- bun run ${cliPath} mcp`, { stdio: "pipe" });
		console.log(chalk.green("✓ MCP server registered in Codex"));
	} catch {
		console.log(chalk.yellow("⚠ Could not auto-register MCP server in Codex."));
		console.log(chalk.gray(`  Run manually: codex mcp add clawdi -- bun run ${cliPath} mcp`));
	}
}

function registerOpenClawMcp() {
	// OpenClaw's ACP bridge rejects per-session mcpServers and delegates MCP
	// registration to whatever downstream agent it wraps (typically Claude Code
	// via --mcp-config). There's no clawdi-safe config file to patch here.
	console.log(chalk.yellow("⚠ OpenClaw has no native MCP registration point."));
	console.log(chalk.gray("  If you also run `clawdi setup --agent claude_code` on this machine,"));
	console.log(chalk.gray("  OpenClaw will inherit the clawdi MCP server through Claude Code."));
	console.log(
		chalk.gray("  Otherwise, add the clawdi MCP server to your OpenClaw gateway config manually."),
	);
}
