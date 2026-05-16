import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
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

interface InvitationResponse {
	id: string;
	project_id: string;
	project_name: string;
	invitee_email: string;
	owner_handle: string;
	created_at: string;
}

const ALREADY_OWNER_HINT = "You're inviting yourself — already the owner.";
const NOT_REGISTERED_HINT =
	"No clawdi account found for that email. Send them a share link instead:";
const AMBIGUOUS_HINT = "Multiple accounts match that email. Send them a share link instead:";

export async function projectInviteCommand(
	projectArg: string,
	opts: { email: string },
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}
	if (!opts.email || !/^\S+@\S+\.\S+$/.test(opts.email)) {
		console.error(chalk.red("--email must be a valid email address."));
		process.exitCode = 1;
		return;
	}

	const projectId = await resolveProjectId(apiUrl, auth.apiKey, projectArg);
	const r = await fetch(`${apiUrl}/api/projects/${projectId}/invitations`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ email: opts.email }),
	});

	if (r.status === 400 || r.status === 404 || r.status === 409) {
		const body = (await r.json().catch(() => ({}))) as {
			detail?: { error?: string; message?: string };
		};
		const err = body.detail?.error;
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
			console.error(chalk.red(`Failed: ${body.detail?.message ?? r.status}`));
		}
		process.exitCode = 1;
		return;
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = (await r.json()) as InvitationResponse;
	console.log(`${chalk.green("✓")} Invitation sent to ${body.invitee_email}`);
	console.log(chalk.gray("  They will join as a read-only viewer after accepting."));
	console.log(chalk.gray("  Using it with an agent is separate; after accept they can run:"));
	console.log(`  ${chalk.cyan("clawdi project list --shared-with-me")}`);
	console.log(`  ${chalk.cyan("clawdi agent projects attach <agent-id> --project <project>")}`);
}
