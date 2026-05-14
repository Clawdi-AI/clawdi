import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";

/**
 * `clawdi project invites <project> [--cancel <id>]` — owner-side view
 * of pending invitations on a project you own.
 *
 *   default → list pending invitations on the project
 *   --cancel <id> → cancel one of them
 *
 * The sharee-side `--accept` / `--decline` flags that lived here in v1
 * are gone — `clawdi inbox accept` / `clawdi inbox decline` is the
 * canonical sharee surface (publishes the same backend endpoints).
 * Sharee-side listing also lives under `clawdi inbox`.
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

async function authedGet<T>(apiUrl: string, bearer: string, path: string): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	return r.json() as Promise<T>;
}

async function authedDelete(apiUrl: string, bearer: string, path: string): Promise<void> {
	const r = await fetch(`${apiUrl}${path}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
}

export async function projectInvitesCommand(
	projectArg: string,
	opts: { cancel?: string },
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const projectId = await resolveProjectId(apiUrl, auth.apiKey, projectArg);

	if (opts.cancel) {
		await authedDelete(
			apiUrl,
			auth.apiKey,
			`/api/projects/${projectId}/invitations/${opts.cancel}`,
		);
		console.log(`${chalk.green("✓")} Invitation cancelled.`);
		console.log(chalk.gray("  The recipient will no longer see it in their inbox."));
		return;
	}

	const items = await authedGet<InvitationItem[]>(
		apiUrl,
		auth.apiKey,
		`/api/projects/${projectId}/invitations`,
	);
	if (items.length === 0) {
		console.log("No pending invites on this project.");
		console.log();
		console.log(
			`Invite a viewer: ${chalk.cyan(`clawdi project invite ${projectArg} --email <addr>`)}`,
		);
		return;
	}
	console.log(chalk.bold(`Pending project invites (${items.length})`));
	console.log(chalk.gray("  Accepting grants read-only viewer access. Agent binding is separate."));
	for (const inv of items) {
		console.log(
			`  ${chalk.bold(inv.invitee_email)}  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
				chalk.gray(` · sent ${new Date(inv.created_at).toLocaleDateString()}`),
		);
	}
	console.log();
	console.log(
		chalk.gray("Cancel: ") + chalk.cyan(`clawdi project invites ${projectArg} --cancel <id>`),
	);
}
