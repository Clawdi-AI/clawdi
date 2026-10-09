import type { components, paths } from "@clawdi/shared/api";
import chalk from "chalk";
import { ApiClient, apiErrorField, unwrap } from "../lib/api-client";
import { getClawdiAccessToken } from "../lib/clerk-oauth";
import { emit } from "../lib/command-output";
import { getConfig } from "../lib/config";
import { mapHttpError } from "../lib/errors";
import { resolveProjectId } from "../lib/project-resolver";
import { requireAuth } from "../lib/require-auth";
import { getEnvIdByAgent } from "../lib/select-adapter";
import {
	isVaultProjectNotFoundBody,
	VAULT_PROJECT_ACCESS_ERROR,
	VAULT_PROJECT_ACCESS_HINT,
} from "../lib/vault-errors";

type VaultResolveHit = components["schemas"]["VaultResolveResponse"];

export async function vaultResolveCommand(
	key: string,
	opts: {
		project?: string;
		agent?: string;
		allowConflicts?: boolean;
		debug?: boolean;
		json?: boolean;
		dryRun?: boolean;
	} = {},
): Promise<void> {
	const { apiUrl } = getConfig();
	requireAuth();
	const accessToken = await getClawdiAccessToken(apiUrl);
	if (opts.project && opts.agent) {
		console.error(chalk.red("Pass either --project or --agent, not both."));
		process.exitCode = 1;
		return;
	}

	const query: NonNullable<paths["/v1/vault/resolve"]["post"]["parameters"]["query"]> = { key };
	if (opts.project) {
		const projectId = await resolveProjectId(apiUrl, accessToken, opts.project);
		query.project_id = projectId;
	}
	if (opts.agent) {
		query.agent_id = resolveAgentId(opts.agent);
	}
	if (opts.allowConflicts) query.allow_conflicts = true;
	if (opts.debug) query.debug = true;
	if (opts.dryRun) query.preview = true;

	const result = await new ApiClient({ baseUrl: apiUrl, authToken: accessToken }).POST(
		"/v1/vault/resolve",
		{ params: { query } },
	);
	const r = result.response;
	const body = result.error;
	if (!r.ok) {
		const mapped = mapHttpError({ status: r.status });
		if (mapped?.exitCode === 4) unwrap(result);
		const code = apiErrorField(body, "code");
		const safeMessage =
			r.status === 404
				? isVaultProjectNotFoundBody(body)
					? VAULT_PROJECT_ACCESS_ERROR
					: "No vault value was found for this key."
				: r.status === 403
					? "Vault resolve requires CLI authentication."
					: r.status === 409
						? code === "ambiguous_vault_reference_slug"
							? "Vault namespace is ambiguous."
							: "Vault conflict blocked."
						: `Vault resolve failed (HTTP ${r.status}).`;
		if (opts.json) {
			emit(
				{
					schemaVersion: "clawdi.vaultResolve.v1",
					status: "error",
					error: { code: "vault_resolve_failed", status: r.status, message: safeMessage },
				},
				console.error,
			);
		} else if (r.status === 404) {
			if (isVaultProjectNotFoundBody(body)) {
				console.error(chalk.red(VAULT_PROJECT_ACCESS_ERROR));
				console.error(chalk.gray(VAULT_PROJECT_ACCESS_HINT));
			} else {
				console.error(chalk.red(`No vault value found for ${key}.`));
			}
		} else if (r.status === 403) {
			console.error(chalk.red("vault resolve requires CLI authentication."));
		} else if (r.status === 409) {
			console.error(chalk.red(safeMessage));
			if (code === "ambiguous_vault_reference_slug") {
				console.error(
					chalk.gray(
						"Repair or rename the conflicting vault namespace before resolving this reference.",
					),
				);
			} else {
				console.error(
					chalk.gray(
						"Re-run with --allow-conflicts to use the first project by vault resolution priority.",
					),
				);
			}
		} else {
			console.error(chalk.red(`vault resolve failed (${r.status}).`));
		}
		process.exitCode = 1;
		return;
	}

	const hit = unwrap(result);
	if (opts.json) {
		emit({ schemaVersion: "clawdi.vaultResolve.v1", ...hit });
		return;
	}

	if (opts.dryRun) {
		console.log(
			`${chalk.green("✓")} ${key} resolves from ${hit.source_alias} ${chalk.gray("(redacted)")}`,
		);
		if (opts.debug && hit.precedence) {
			printPrecedence(hit);
		}
		return;
	}
	if (typeof hit.value !== "string") {
		console.error(chalk.red("vault resolve returned no value."));
		process.exitCode = 1;
		return;
	}
	console.log(`${hit.value}  ${chalk.gray(`(from ${hit.source_alias})`)}`);

	if (opts.debug && hit.precedence) {
		printPrecedence(hit);
	}
}

function printPrecedence(hit: VaultResolveHit): void {
	if (!Array.isArray(hit.precedence)) return;
	console.log(chalk.gray("  searched:"));
	for (const value of hit.precedence) {
		if (typeof value !== "object" || value === null) continue;
		const entry: Record<string, unknown> = value;
		const suffix =
			entry.reason === "match"
				? chalk.green("match")
				: entry.reason === "conflict"
					? chalk.red("conflict")
					: entry.reason === "skipped"
						? chalk.yellow("skipped")
						: chalk.gray("not found");
		const agentUse = entry.binding_type
			? chalk.gray(` ${formatAgentUse(String(entry.binding_type))}:${entry.priority}`)
			: "";
		console.log(`    ${entry.alias} ${suffix}${agentUse}`);
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
