import chalk from "chalk";
import { ApiClient, ApiError } from "../lib/api-client";
import { requireUuid } from "../lib/cli-options";
import { commandResult, message } from "../lib/command-output";
import { authedJson, projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";

/**
 * `clawdi project share-links <project> [--revoke <id>]`
 *
 * Default = list all links on the project, freshest first, with
 * revoke status + redeem counts + last-used timestamps.
 *
 * `--revoke <id>`: soft-revoke that link. Idempotent on an already-revoked one.
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
	return authedJson<ShareLinkRow[]>(
		apiUrl,
		bearer,
		`/v1/projects/${encodeURIComponent(projectId)}/share-links`,
	);
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
	opts: { revoke?: string; yes?: boolean; json?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);

	if (opts.revoke) {
		const linkId = requireUuid(opts.revoke, "Share link ID");
		if (
			!(await confirmOrRequireYes(`Revoke share link ${linkId}?`, {
				yes: opts.yes,
				action: "revoke this project share link",
			}))
		) {
			commandResult(opts.json, "clawdi.projectShareLinks.v1", {
				project_id: projectId,
				id: linkId,
				status: "cancelled",
			});
			return;
		}
		const r = await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).request(
			`/v1/projects/${encodeURIComponent(projectId)}/share-links/${encodeURIComponent(linkId)}`,
			{
				method: "DELETE",
			},
		);
		if (r.status === 404) {
			console.error(chalk.red("Link not found on that project."));
			process.exitCode = 1;
			return;
		}
		if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
		message(opts.json, `${chalk.green("✓")} Share link revoked.`);
		message(opts.json, chalk.gray("  Existing members keep access until you remove them."));
		commandResult(opts.json, "clawdi.projectShareLinks.v1", {
			project_id: projectId,
			id: linkId,
			status: "revoked",
		});
		return;
	}

	const links = await fetchLinks(apiUrl, apiKey, projectId);
	if (opts.json) {
		commandResult(true, "clawdi.projectShareLinks.v1", { project_id: projectId, links });
		return;
	}
	if (links.length === 0) {
		console.log("No share links on this project yet.");
		console.log();
		console.log(`Create a viewer link: ${chalk.cyan(`clawdi project share ${projectArg}`)}`);
		return;
	}
	console.log(chalk.bold(`Project share links (${links.length})`));
	console.log(
		chalk.gray(
			"  Links grant viewer read access after accept, including CLI vault runtime reads. Agent use stays separate.",
		),
	);
	for (const link of links) {
		console.log(formatRow(link));
	}
	console.log();
	console.log(
		chalk.gray("Revoke: ") +
			chalk.cyan(`clawdi project share-links ${projectArg} --revoke <id> --yes`),
	);
}
