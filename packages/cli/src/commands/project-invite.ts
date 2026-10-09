import chalk from "chalk";
import { ApiClient, apiErrorField, unwrap } from "../lib/api-client";
import { commandResult } from "../lib/command-output";
import { projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";

/**
 * `clawdi project invite <project> --email <addr>` — send an email
 * invitation on a project. Recipient MUST already have a clawdi account
 * (email lookup); for unregistered emails the CLI suggests using
 * `clawdi project share` to send a public link instead.
 *
 * The invitation surfaces in the invitee's `clawdi inbox` and the
 * web dashboard's banner on /skills.
 */

const ALREADY_OWNER_HINT = "You're inviting yourself — already the owner.";
const NOT_REGISTERED_HINT =
	"No clawdi account found for that email. Send them a share link instead:";
const AMBIGUOUS_HINT = "Multiple accounts match that email. Send them a share link instead:";

export async function projectInviteCommand(
	projectArg: string,
	opts: { email: string; json?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;
	if (!opts.email || !/^\S+@\S+\.\S+$/.test(opts.email)) {
		console.error(chalk.red("--email must be a valid email address."));
		process.exitCode = 1;
		return;
	}

	const projectId = await resolveProjectId(apiUrl, apiKey, projectArg);
	const result = await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).POST(
		"/v1/projects/{project_id}/invitations",
		{
			params: { path: { project_id: projectId } },
			body: { email: opts.email },
		},
	);
	if ([400, 404, 409].includes(result.response.status)) {
		const err = apiErrorField(result.error, "error");
		if (err === "already_owner") {
			console.error(chalk.red(ALREADY_OWNER_HINT));
		} else if (err === "user_not_found") {
			console.error(chalk.red(NOT_REGISTERED_HINT));
			console.error(`  ${chalk.cyan(`clawdi project share ${projectArg}`)}`);
		} else if (err === "ambiguous_email") {
			console.error(chalk.red(AMBIGUOUS_HINT));
			console.error(`  ${chalk.cyan(`clawdi project share ${projectArg}`)}`);
		} else if (err === "already_member") {
			console.error(chalk.yellow("That user is already a member of this project."));
		} else if (err === "already_invited") {
			console.error(chalk.yellow("That user already has a pending invitation. Cancel it first."));
		} else if (err === "display_name_required") {
			console.error(chalk.red("Set a display name on your profile first — invitees see the name."));
		} else {
			unwrap(result);
		}
		process.exitCode = 1;
		return;
	}
	const body = unwrap(result);
	if (opts.json) {
		console.error("✓ Invitation sent");
		commandResult(true, "clawdi.projectInvite.v1", {
			id: body.id,
			project_id: body.project_id,
			project_name: body.project_name,
			invitee_email: body.invitee_email,
			owner_handle: body.owner_handle,
			created_at: body.created_at,
		});
		return;
	}
	console.log(`${chalk.green("✓")} Invitation sent to ${body.invitee_email}`);
	console.log(
		chalk.gray("  They will join as a viewer with read access, including CLI vault runtime reads."),
	);
	console.log(chalk.gray("  Linking it to an agent is separate; after accept they can run:"));
	console.log(`  ${chalk.cyan("clawdi project list --shared-with-me")}`);
	console.log(`  ${chalk.cyan("clawdi agent projects link <agent-id> --project <project>")}`);
}
