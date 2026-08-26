import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
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
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	migrateLegacyLocalSetupSkill,
	releaseManagedSkill,
} from "../runtime/managed-skill-reservation";

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
	const adapter = adapterRegistry[agentType].create();

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
	const skillDir = adapter.skills ? builtinSkillTargetDir(agentType) : null;
	if (skillDir) {
		try {
			migrateLegacyLocalSetupSkill({
				targetDir: skillDir,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			});
			const result = releaseManagedSkill({
				targetDir: skillDir,
				id: "clawdi",
				manager: "local-setup",
				removeTarget: () => {
					if (!opts.keepSkill) rmSync(skillDir, { recursive: true, force: true });
				},
			});
			if (!opts.keepSkill) {
				if (result === "absent") throw new Error("Skill is not owned by local setup");
				p.log.success(`${label}: removed bundled skill (${skillDir})`);
			}
		} catch (e) {
			p.log.warn(`${label}: could not remove skill (${errMessage(e)})`);
		}
	}

	// 4. MCP registration
	if (!opts.keepMcp) {
		await adapterRegistry[agentType].mcpLifecycle?.unregister();
	}
}
