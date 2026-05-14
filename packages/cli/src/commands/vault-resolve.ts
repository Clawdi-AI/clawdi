import chalk from "chalk";
import { getAuth, getConfig } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";

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
		reason: "match" | "not-found" | "skipped";
		mounted_at?: string;
	}>;
}

export async function vaultResolveCommand(
	key: string,
	opts: { project?: string; debug?: boolean; json?: boolean } = {},
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not logged in. Run `clawdi auth login` first."));
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
	if (opts.debug) params.set("debug", "true");

	const r = await fetch(`${apiUrl}/api/vault/resolve?${params.toString()}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	const body = (await r.json().catch(() => ({}))) as VaultResolveHit | { detail?: unknown };

	if (!r.ok) {
		if (opts.json) {
			console.log(JSON.stringify(body, null, 2));
		} else if (r.status === 404) {
			console.error(chalk.red(`No vault value found for ${key}.`));
		} else if (r.status === 403) {
			console.error(chalk.red("vault resolve requires CLI authentication."));
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
					: entry.reason === "skipped"
						? chalk.yellow("skipped")
						: chalk.gray("not found");
			const mounted = entry.mounted_at ? chalk.gray(` mounted_at=${entry.mounted_at}`) : "";
			console.log(`    ${entry.alias} ${suffix}${mounted}`);
		}
	}
}
