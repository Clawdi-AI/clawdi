import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { requireUuid } from "../lib/cli-options";
import { commandResult, message } from "../lib/command-output";
import { projectAuthOrExit } from "../lib/project-command-utils";
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

export async function projectInvitesCommand(
	projectArg: string,
	opts: { cancel?: string; yes?: boolean; json?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);

	if (opts.cancel) {
		const invitationId = requireUuid(opts.cancel, "Invitation ID");
		if (
			!(await confirmOrRequireYes(`Cancel invitation ${opts.cancel}?`, {
				yes: opts.yes,
				action: "cancel this project invitation",
			}))
		) {
			commandResult(opts.json, "clawdi.projectInvites.v1", {
				project_id: projectId,
				id: invitationId,
				status: "canceled",
			});
			return;
		}
		unwrap(
			await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).DELETE(
				"/v1/projects/{project_id}/invitations/{invitation_id}",
				{
					params: { path: { project_id: projectId, invitation_id: invitationId } },
				},
			),
		);
		message(opts.json, `${chalk.green("✓")} Invitation canceled.`);
		message(opts.json, chalk.gray("  The recipient will no longer see it in their inbox."));
		commandResult(opts.json, "clawdi.projectInvites.v1", {
			project_id: projectId,
			id: invitationId,
			status: "canceled",
		});
		return;
	}

	const items = unwrap(
		await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).GET(
			"/v1/projects/{project_id}/invitations",
			{ params: { path: { project_id: projectId } } },
		),
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
