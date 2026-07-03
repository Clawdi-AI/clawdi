import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { getHermesHome } from "../adapters/paths";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	builtinSkillTargetDir,
} from "../adapters/registry";
import { getClawdiDir } from "../lib/config";
import { errMessage } from "../lib/errors";
import { askMulti, askYesNo } from "../lib/prompts";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { isInteractive } from "../lib/tty";

export async function teardown(opts: {
	agent?: string;
	all?: boolean;
	keepSkill?: boolean;
	keepMcp?: boolean;
	yes?: boolean;
}) {
	p.intro(chalk.bold("clawdi teardown"));

	const targets = await resolveTargets(opts);
	if (targets === null) {
		// resolveTargets already printed + set exitCode
		p.outro(chalk.red("Aborted."));
		return;
	}
	if (targets.length === 0) {
		p.outro(chalk.gray("Nothing to tear down."));
		return;
	}

	if (!opts.yes) {
		const labels = targets.map((t) => adapterRegistry[t].displayName).join(", ");
		p.log.info(`Will tear down: ${labels}`);
		const ok = await askYesNo("Proceed?");
		if (!ok) {
			p.outro(chalk.gray("Cancelled."));
			return;
		}
	}

	for (const type of targets) {
		await teardownOne(type, {
			keepSkill: opts.keepSkill ?? false,
			keepMcp: opts.keepMcp ?? false,
		});
	}

	p.outro(chalk.green("✓ Teardown complete"));
}

/**
 * Decide which agents to act on. Returns null on hard error (printed already)
 * with process.exitCode = 1; returns [] when nothing to do (handled by caller).
 */
async function resolveTargets(opts: {
	agent?: string;
	all?: boolean;
}): Promise<AgentType[] | null> {
	const registered = listRegisteredAgentTypes();

	if (opts.agent) {
		if (opts.all) {
			p.log.error("Pass either --agent or --all, not both.");
			process.exitCode = 1;
			return null;
		}
		if (!AGENT_TYPES.includes(opts.agent as AgentType)) {
			p.log.error(`Unknown agent type: ${opts.agent}`);
			p.log.info(`Valid types: ${AGENT_TYPES.join(", ")}`);
			process.exitCode = 1;
			return null;
		}
		const type = opts.agent as AgentType;
		if (!registered.includes(type)) {
			p.log.error(
				`${adapterRegistry[type].displayName} is not registered (no ~/.clawdi/environments/${type}.json).`,
			);
			process.exitCode = 1;
			return null;
		}
		return [type];
	}

	if (opts.all) {
		return registered;
	}

	// Neither flag — interactive picker, or hard error in non-TTY.
	if (registered.length === 0) {
		return [];
	}
	if (!isInteractive()) {
		p.log.error("Specify --agent <type> or --all when running non-interactively.");
		process.exitCode = 1;
		return null;
	}
	const picked = await askMulti<AgentType>(
		"Tear down which agents?",
		registered.map((t) => ({ value: t, label: adapterRegistry[t].displayName })),
		[],
	);
	if (!picked) return null;
	return picked;
}

async function teardownOne(agentType: AgentType, opts: { keepSkill: boolean; keepMcp: boolean }) {
	const label = adapterRegistry[agentType].displayName;

	// 1. Local env file
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	try {
		if (existsSync(envPath)) {
			unlinkSync(envPath);
			p.log.success(`${label}: removed environment registration`);
		}
	} catch (e) {
		p.log.warn(`${label}: could not remove env file (${errMessage(e)})`);
	}

	// 2. Backend env row — intentionally left as dangling metadata.
	//    With the local env file gone, push --agent X already errors out.
	//    A future --remote flag could DELETE /api/agents/{id}; backend
	//    needs to add that endpoint first.

	// 3. Bundled skill
	if (!opts.keepSkill) {
		const skillDir = builtinSkillTargetDir(agentType);
		if (skillDir && existsSync(skillDir)) {
			try {
				rmSync(skillDir, { recursive: true, force: true });
				p.log.success(`${label}: removed bundled skill (${skillDir})`);
			} catch (e) {
				p.log.warn(`${label}: could not remove skill (${errMessage(e)})`);
			}
		}
	}

	// 4. MCP registration
	if (!opts.keepMcp) {
		await unregisterMcpServer(agentType);
	}
}

async function unregisterMcpServer(agentType: AgentType) {
	if (agentType === "claude_code")
		return unregisterViaCli("Claude Code", "claude mcp remove clawdi");
	if (agentType === "codex") return unregisterViaCli("Codex", "codex mcp remove clawdi");
	if (agentType === "hermes") return unregisterHermesMcp();
	if (agentType === "openclaw") return unregisterViaCli("OpenClaw", "openclaw mcp unset clawdi");
}

function unregisterViaCli(label: string, cmd: string) {
	try {
		execSync(cmd, { stdio: "pipe", env: process.env });
		p.log.success(`${label}: removed MCP server registration`);
	} catch {
		// `mcp remove` returns non-zero if the entry didn't exist — that's fine.
		p.log.info(`${label}: MCP server already absent (or removal not supported)`);
	}
}

function unregisterHermesMcp() {
	const configPath = join(getHermesHome(), "config.yaml");
	if (!existsSync(configPath)) {
		p.log.info("Hermes: config.yaml not found, nothing to remove");
		return;
	}

	const content = readFileSync(configPath, "utf-8");

	const updated = removeAllYamlBlocks(removeAllYamlBlocks(content, "clawdi-mcp"), "clawdi");
	if (updated === content) {
		p.log.info("Hermes: clawdi entry not present in config.yaml");
		return;
	}

	try {
		writeFileSync(configPath, updated);
		p.log.success("Hermes: removed MCP server entry from config.yaml");
	} catch (e) {
		p.log.warn(`Hermes: could not edit config.yaml (${errMessage(e)})`);
		p.log.info(`  Edit ${configPath} manually and remove the clawdi block under mcp_servers`);
	}
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
