import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { authedJson, projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";

/**
 * `clawdi project share-links <project> [--revoke <id|prefix>]`
 *
 * Default = list all links on the project, freshest first, with
 * revoke status + redeem counts + last-used timestamps.
 *
 * `--revoke <id-or-prefix>`: soft-revoke that link. Idempotent on
 * an already-revoked one. The `<prefix>` shorthand matches when
 * exactly one link in the listing starts with that prefix — saves
 * the user from copy-pasting full UUIDs from a fresh list.
 */

interface ShareLinkRow {
	id: string;
	prefix: string;
	label: string | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	redeem_count: number;
	last_redeemed_at: string | null;
}

async function fetchLinks(
	apiUrl: string,
	bearer: string,
	projectId: string,
): Promise<ShareLinkRow[]> {
	return authedJson<ShareLinkRow[]>(apiUrl, bearer, `/api/projects/${projectId}/share-links`);
}

function formatRow(link: ShareLinkRow): string {
	const created = new Date(link.created_at).toLocaleDateString();
	const status = link.revoked_at ? chalk.red("revoked") : chalk.green("active");
	const last = link.last_redeemed_at
		? chalk.gray(` · last used ${new Date(link.last_redeemed_at).toLocaleDateString()}`)
		: "";
	const label = link.label ? ` ${chalk.dim(`[${link.label}]`)}` : "";
	return (
		`  ${chalk.bold(link.prefix)}…${label}  ` +
		`${status}  ${chalk.gray(created)}  ` +
		`${chalk.gray(`${link.redeem_count} accept${link.redeem_count === 1 ? "" : "s"}`)}` +
		last
	);
}

export async function projectShareLinksCommand(
	projectArg: string,
	opts: { revoke?: string },
): Promise<void> {
	const ctx = projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);

	if (opts.revoke) {
		// Resolve the link-id from a prefix shorthand if necessary.
		let linkId = opts.revoke;
		const looksLikeUUID = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(linkId);
		if (!looksLikeUUID) {
			const all = await fetchLinks(apiUrl, apiKey, projectId);
			const matches = all.filter((l) => l.prefix.startsWith(linkId));
			if (matches.length === 0) {
				console.error(chalk.red(`No link starts with prefix '${linkId}'.`));
				process.exitCode = 1;
				return;
			}
			if (matches.length > 1) {
				console.error(
					chalk.red(`Prefix '${linkId}' matches ${matches.length} links. Use the full id.`),
				);
				process.exitCode = 1;
				return;
			}
			linkId = matches[0].id;
		}
		const r = await fetch(`${apiUrl}/api/projects/${projectId}/share-links/${linkId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (r.status === 404) {
			console.error(chalk.red("Link not found on that project."));
			process.exitCode = 1;
			return;
		}
		if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
		console.log(`${chalk.green("✓")} Share link revoked.`);
		console.log(chalk.gray("  Existing members keep access until you remove them."));
		return;
	}

	const links = await fetchLinks(apiUrl, apiKey, projectId);
	if (links.length === 0) {
		console.log("No share links on this project yet.");
		console.log();
		console.log(`Create a read-only link: ${chalk.cyan(`clawdi project share ${projectArg}`)}`);
		return;
	}
	console.log(chalk.bold(`Project share links (${links.length})`));
	console.log(chalk.gray("  Links grant viewer access after accept. Agent use stays separate."));
	for (const link of links) {
		console.log(formatRow(link));
	}
	console.log();
	console.log(
		chalk.gray("Revoke: ") +
			chalk.cyan(`clawdi project share-links ${projectArg} --revoke <prefix>`),
	);
}
