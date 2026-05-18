import chalk from "chalk";
import { readJson } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";
import { getEnvIdByAgent } from "../lib/select-adapter";

interface VaultResolveHit {
	key: string;
	value: string;
	source_project_id: string;
	source_alias: string;
	vault_slug?: string | null;
	section?: string;
	item_name?: string;
	precedence?: Array<{
		project_id: string;
		alias: string;
		hit: boolean;
		reason: "match" | "not-found" | "skipped" | "conflict";
		binding_type?: string;
		priority?: number;
	}>;
	conflicts?: Array<{
		project_id: string;
		alias: string;
		display?: string;
		binding_type?: string;
		priority?: number;
		vault_slug?: string | null;
	}>;
}

export async function vaultResolveCommand(
	key: string,
	opts: {
		project?: string;
		agent?: string;
		allowConflicts?: boolean;
		debug?: boolean;
		json?: boolean;
	} = {},
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}
	if (opts.project && opts.agent) {
		console.error(chalk.red("Pass either --project or --agent, not both."));
		process.exitCode = 1;
		return;
	}

	const params = new URLSearchParams({
		key,
	});
	if (opts.project) {
		const projectId = await resolveProjectId(apiUrl, auth.apiKey, opts.project);
		params.set("project_id", projectId);
	}
	if (opts.agent) {
		params.set("agent_id", resolveAgentId(opts.agent));
	}
	if (opts.allowConflicts) params.set("allow_conflicts", "true");
	if (opts.debug) params.set("debug", "true");

	const r = await fetch(`${apiUrl}/api/vault/resolve?${params.toString()}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	let body: VaultResolveHit | { detail?: unknown };
	try {
		body = await readJson<VaultResolveHit | { detail?: unknown }>(r, "/api/vault/resolve");
	} catch (e) {
		if (r.ok) throw e;
		body = {};
	}

	if (!r.ok) {
		if (opts.json) {
			console.log(JSON.stringify(body, null, 2));
		} else if (r.status === 404) {
			console.error(chalk.red(`No vault value found for ${key}.`));
		} else if (r.status === 403) {
			console.error(chalk.red("vault resolve requires CLI authentication."));
		} else if (r.status === 409) {
			const detail = (body as { detail?: { code?: string; message?: string } }).detail;
			console.error(chalk.red(detail?.message ?? "Vault conflict blocked."));
			console.error(
				chalk.gray("Re-run with --allow-conflicts to use the first project in agent order."),
			);
		} else {
			console.error(chalk.red(`vault resolve failed (${r.status}).`));
		}
		process.exitCode = 1;
		return;
	}

	if (opts.json) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}

	const hit = body as VaultResolveHit;
	console.log(`${hit.value}  ${chalk.gray(`(from ${hit.source_alias})`)}`);

	if (opts.debug && hit.precedence) {
		console.log(chalk.gray("  searched:"));
		for (const entry of hit.precedence) {
			const suffix =
				entry.reason === "match"
					? chalk.green("match")
					: entry.reason === "conflict"
						? chalk.red("conflict")
						: entry.reason === "skipped"
							? chalk.yellow("skipped")
							: chalk.gray("not found");
			const agentUse = entry.binding_type
				? chalk.gray(` ${formatAgentUse(entry.binding_type)}:${entry.priority}`)
				: "";
			console.log(`    ${entry.alias} ${suffix}${agentUse}`);
		}
	}
}

function resolveAgentId(agent: string): string {
	const localEnvId = getEnvIdByAgent(agent);
	return localEnvId ?? agent;
}

function formatAgentUse(value: string): string {
	if (value === "primary") return "agent-project";
	if (value === "context") return "attached";
	return value;
}
