import chalk from "chalk";
import { commandMessage, commandResult } from "../lib/command-output";

import { authedJson, projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";

/**
 * `clawdi project invites <project> [--cancel <id>]` — owner-side view
 * of pending invitations on a project you own.
 *
 *   default → list pending invitations on the project
 *   --cancel <id> → cancel one of them
 *
 * The recipient-side `--accept` / `--decline` flags that lived here in v1
 * are gone — `clawdi inbox accept` / `clawdi inbox decline` is the
 * canonical recipient surface (publishes the same backend endpoints).
 * Recipient-side listing also lives under `clawdi inbox`.
 */

interface InvitationItem {
	id: string;
	project_id: string;
	project_name: string;
	project_kind: string;
	owner_display: string;
	owner_handle: string;
	invitee_email: string;
	invited_by_user_id: string;
	invited_by_display: string | null;
	created_at: string;
}

export async function projectInvitesCommand(
	projectArg: string,
	opts: { cancel?: string; yes?: boolean; json?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);

	if (opts.cancel) {
		if (
			!(await confirmOrRequireYes(`Cancel invitation ${opts.cancel}?`, {
				yes: opts.yes,
				action: "cancel this project invitation",
			}))
		) {
			commandResult(opts.json, "clawdi.projectInvites.v1", {
				project_id: projectId,
				id: opts.cancel,
				status: "cancelled",
			});
			return;
		}
		await authedJson<{ status: string }>(
			apiUrl,
			apiKey,
			`/v1/projects/${projectId}/invitations/${opts.cancel}`,
			{ method: "DELETE" },
		);
		commandMessage(opts.json, `${chalk.green("✓")} Invitation canceled.`);
		commandMessage(opts.json, chalk.gray("  The recipient will no longer see it in their inbox."));
		commandResult(opts.json, "clawdi.projectInvites.v1", {
			project_id: projectId,
			id: opts.cancel,
			status: "canceled",
		});
		return;
	}

	const items = await authedJson<InvitationItem[]>(
		apiUrl,
		apiKey,
		`/v1/projects/${projectId}/invitations`,
	);
	if (opts.json) {
		commandResult(true, "clawdi.projectInvites.v1", { project_id: projectId, invitations: items });
		return;
	}
	if (items.length === 0) {
		console.log("No pending invites on this project.");
		console.log();
		console.log(
			`Invite a viewer: ${chalk.cyan(`clawdi project invite ${projectArg} --email <addr>`)}`,
		);
		return;
	}
	console.log(chalk.bold(`Pending project invites (${items.length})`));
	console.log(
		chalk.gray(
			"  Accepting grants viewer read access, including CLI vault runtime reads. Agent use is separate.",
		),
	);
	for (const inv of items) {
		console.log(
			`  ${chalk.bold(inv.invitee_email)}  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
				chalk.gray(` · sent ${new Date(inv.created_at).toLocaleDateString()}`),
		);
	}
	console.log();
	console.log(
		chalk.gray("Cancel: ") + chalk.cyan(`clawdi project invites ${projectArg} --cancel <id> --yes`),
	);
}
