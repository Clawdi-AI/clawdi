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
import { ApiClient, unwrap } from "../lib/api-client";
import { getClawdiDir, isLoggedIn } from "../lib/config";
import { errMessage } from "../lib/errors";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { isInteractive } from "../lib/tty";
import {
	install as installDaemonService,
	listInstalledAgents,
	uninstall as uninstallDaemonService,
} from "../serve/installer";

interface SetupOpts {
	agent?: string;
	yes?: boolean;
	/** Commander sets this to false for --no-daemon. Undefined means default-on. */
	daemon?: boolean;
}

export async function setup(opts: SetupOpts) {
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
		if (!(await registerEnv(api, type, null, machineId, machineName))) {
			process.exitCode = 1;
			return;
		}
		await registerMcpServer(type);
		await installBuiltinSkill(type);
		if (await shouldInstallDaemons(opts)) installDaemonsForRegisteredAgents();
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
				// Hint when an agent dir exists but the binary isn't on PATH —
				// the user sees WHY it's unchecked instead of guessing.
				...(d.version ? {} : { hint: "data only — binary not on PATH" }),
			})),
			// Only pre-select agents whose binary is actually reachable
			// (`getVersion()` non-null). Stale `~/.openclaw/` etc. data dirs
			// from old installs still show — but unchecked, so they're not
			// registered by accident.
			initialValues: detected.filter((d) => d.version !== null).map((d) => d.adapter.agentType),
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
	let registeredCount = 0;
	let failedCount = 0;
	for (const { adapter, version } of toRegister) {
		if (!(await registerEnv(api, adapter.agentType, version, machineId, machineName))) {
			failedCount += 1;
			continue;
		}
		registeredCount += 1;
		await registerMcpServer(adapter.agentType);
		await installBuiltinSkill(adapter.agentType);
	}
	if (registeredCount > 0 && (await shouldInstallDaemons(opts))) {
		installDaemonsForRegisteredAgents();
	}
	if (failedCount > 0) process.exitCode = 1;
}

async function registerEnv(
	api: ApiClient,
	agentType: AgentType,
	agentVersion: string | null,
	machineId: string,
	machineName: string,
): Promise<boolean> {
	try {
		const env = unwrap(
			await api.POST("/v1/agents", {
				body: {
					machine_id: machineId,
					machine_name: machineName,
					agent_type: agentType,
					agent_version: agentVersion,
					os: process.platform,
				},
			}),
		);

		const envDir = join(getClawdiDir(), "environments");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, `${agentType}.json`),
			`${JSON.stringify({ id: env.id, agentType, machineId, machineName }, null, 2)}\n`,
			{ mode: 0o600 },
		);

		console.log(chalk.green(`✓ ${adapterRegistry[agentType].displayName} registered`));
		return true;
	} catch (e) {
		console.log(
			chalk.red(`  Failed to register ${adapterRegistry[agentType].displayName}: ${errMessage(e)}`),
		);
		return false;
	}
}

function installDaemonForAllRegisteredAgents() {
	try {
		const result = installDaemonService();
		const verb = result.replaced ? "updated" : "installed";
		console.log(chalk.green(`✓ Singleton daemon ${verb}`));
		console.log(chalk.gray(`  ${result.instructions}`));
		const failed = cleanupLegacyDaemonUnits();
		if (failed > 0) process.exitCode = 1;
	} catch (e) {
		console.log(chalk.yellow(`⚠ Could not install daemon: ${errMessage(e)}`));
		console.log(chalk.gray("  Run manually: clawdi daemon install"));
	}
}

function cleanupLegacyDaemonUnits(): number {
	let failed = 0;
	for (const agentType of listInstalledAgents()) {
		try {
			const result = uninstallDaemonService({ agent: agentType });
			if (result.removed) {
				console.log(chalk.green(`✓ Removed legacy per-agent daemon unit for ${agentType}`));
			}
		} catch (e) {
			console.log(
				chalk.yellow(
					`⚠ Could not remove legacy per-agent daemon unit for ${agentType}: ${errMessage(e)}`,
				),
			);
			failed += 1;
		}
	}
	return failed;
}

async function shouldInstallDaemons(opts: SetupOpts): Promise<boolean> {
	if (opts.daemon === false) {
		console.log(chalk.gray("Daemon install skipped (--no-daemon)."));
		return false;
	}
	if (opts.yes || !isInteractive()) return true;

	const result = await p.confirm({
		message: "Install and start background sync daemons for all registered agents?",
		initialValue: true,
	});
	if (p.isCancel(result)) {
		console.log(chalk.gray("Daemon install skipped."));
		return false;
	}
	return result === true;
}

function installDaemonsForRegisteredAgents() {
	const registered = listRegisteredAgentTypes();
	if (registered.length === 0) {
		console.log(chalk.gray("No registered agents available for daemon install."));
		return;
	}
	console.log();
	console.log(chalk.cyan("Installing background sync daemon..."));
	installDaemonForAllRegisteredAgents();
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

	const mcpConfig = JSON.stringify({
		type: "stdio",
		command: "clawdi",
		args: ["mcp"],
	});

	try {
		// `--scope user` is Claude Code CLI terminology: register MCP
		// at user level (not project-local). This is unrelated to
		// Clawdi Project data boundaries.
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

	try {
		// Hermes has `hermes mcp add`, but it is discovery-first: it probes the
		// server and can prompt for overwrite/tool selection. For setup we need a
		// non-interactive, idempotent upsert that also cleans stale mixed blocks.
		const updated = upsertHermesStdioClawdiMcp(content);
		if (updated === content) {
			console.log(chalk.gray("✓ MCP server already registered in Hermes"));
			return;
		}

		writeFs(configPath, updated);
		console.log(chalk.green("✓ MCP server registered in Hermes"));
	} catch (e) {
		console.log(chalk.yellow(`⚠ Could not register MCP server in Hermes config: ${errMessage(e)}`));
		console.log(chalk.gray(`  Edit ${configPath} and add under mcp_servers:`));
		console.log(chalk.gray(HERMES_CLAUDI_MCP_CHILD));
	}
}

const HERMES_CLAUDI_MCP_CHILD = `  clawdi:\n    command: "clawdi"\n    args: ["mcp"]`;

function upsertHermesStdioClawdiMcp(content: string): string {
	const newSection = `mcp_servers:\n${HERMES_CLAUDI_MCP_CHILD}\n`;
	const HEADER_RE = /^mcp_servers:[ \t]*(.*)$/m;
	const headerMatch = content.match(HEADER_RE);

	if (!headerMatch) {
		return `${content.trimEnd()}\n\n${newSection}`;
	}

	const inlineValue = (headerMatch[1] ?? "").trim();
	if (!["", "{}", "~", "null"].includes(inlineValue)) {
		throw new Error("mcp_servers uses inline value; edit config.yaml manually.");
	}

	const blockContent = content.replace(HEADER_RE, "mcp_servers:");
	const section = getYamlBlock(blockContent, "mcp_servers");
	if (!section) return blockContent;

	// `clawdi mcp` is the canonical Hermes integration. Remove stale cloud HTTP
	// (`clawdi-mcp`) and any mixed/duplicate `clawdi` blocks, then insert one
	// stdio block so repeated setup runs converge to a single transport.
	let normalizedSection = removeAllYamlBlocks(section, "clawdi-mcp");
	normalizedSection = removeAllYamlBlocks(normalizedSection, "clawdi");
	normalizedSection = normalizedSection.replace(
		/^mcp_servers:[ \t]*\n?/,
		`mcp_servers:\n${HERMES_CLAUDI_MCP_CHILD}\n`,
	);

	return blockContent.replace(section, normalizedSection);
}

function removeAllYamlBlocks(content: string, key: string): string {
	let updated = content;
	while (true) {
		const block = getYamlBlock(updated, key);
		if (!block) return updated;
		updated = updated.replace(block, "");
	}
}

function getYamlBlock(content: string, key: string): string | null {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = content.match(
		new RegExp(`^([ \\t]*)${escaped}:[ \\t]*\\n((?:\\1[ \\t]+.*\\n?)*)`, "m"),
	);
	return match?.[0] ?? null;
}

function registerCodexMcp() {
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
		execSync("codex mcp add clawdi -- clawdi mcp", { stdio: "pipe" });
		console.log(chalk.green("✓ MCP server registered in Codex"));
	} catch {
		console.log(chalk.yellow("⚠ Could not auto-register MCP server in Codex."));
		console.log(chalk.gray("  Run manually: codex mcp add clawdi -- clawdi mcp"));
	}
}

function registerOpenClawMcp() {
	const mcpConfig = JSON.stringify({
		command: "clawdi",
		args: ["mcp"],
	});

	try {
		// OpenClaw exposes a non-interactive config setter, so prefer its native
		// CLI over editing ~/.openclaw/openclaw.json directly.
		execSync(`openclaw mcp set clawdi '${mcpConfig}'`, { stdio: "pipe", env: process.env });
		console.log(chalk.green("✓ MCP server registered in OpenClaw"));
	} catch {
		console.log(chalk.yellow("⚠ Could not auto-register MCP server in OpenClaw."));
		console.log(chalk.gray(`  Run manually: openclaw mcp set clawdi '${mcpConfig}'`));
	}
}
