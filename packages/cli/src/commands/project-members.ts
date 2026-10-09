import chalk from "chalk";
import { requireUuid } from "../lib/cli-options";
import { emit } from "../lib/command-output";
import { authedJson, projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";

interface MemberRow {
	id: string;
	user_id: string;
	user_email: string | null;
	user_display: string | null;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
}

async function fetchMembers(
	apiUrl: string,
	apiKey: string,
	projectId: string,
): Promise<MemberRow[]> {
	return authedJson<MemberRow[]>(
		apiUrl,
		apiKey,
		`/v1/projects/${encodeURIComponent(projectId)}/members`,
	);
}

export async function projectMembersCommand(
	projectArg: string,
	opts: { json?: boolean; remove?: string; yes?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;

	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	if (opts.remove) {
		const members = await fetchMembers(ctx.apiUrl, ctx.apiKey, projectId);
		const needle = opts.remove.toLowerCase();
		const matches = members.filter(
			(m) =>
				m.user_id === opts.remove ||
				m.user_email?.toLowerCase() === needle ||
				m.user_display?.toLowerCase() === needle,
		);
		if (matches.length === 0) {
			console.error(chalk.red(`No member matches '${opts.remove}'.`));
			process.exitCode = 1;
			return;
		}
		if (matches.length > 1) {
			console.error(chalk.red(`'${opts.remove}' matches ${matches.length} members; pass user_id.`));
			process.exitCode = 1;
			return;
		}
		if (
			!(await confirmOrRequireYes(
				`Remove ${matches[0].user_email ?? matches[0].user_id} from ${projectArg}?`,
				{ yes: opts.yes, action: "remove this project member" },
			))
		) {
			return;
		}
		const memberUserId = requireUuid(matches[0].user_id, "Member user ID");
		const removed = await authedJson<{ status: string }>(
			ctx.apiUrl,
			ctx.apiKey,
			`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberUserId)}`,
			{ method: "DELETE" },
		);
		if (opts.json) {
			emit({
				schemaVersion: "clawdi.projectMembers.v1",
				project_id: projectId,
				removed_user_id: memberUserId,
				...removed,
			});
			return;
		}
		console.log(`${chalk.green("✓")} Removed ${matches[0].user_email ?? matches[0].user_id}.`);
		console.log(chalk.gray("  Their agents can no longer use this project through that access."));
		return;
	}

	const members = await fetchMembers(ctx.apiUrl, ctx.apiKey, projectId);
	if (opts.json) {
		emit({ schemaVersion: "clawdi.projectMembers.v1", project_id: projectId, members });
		return;
	}
	if (members.length === 0) {
		console.log(`No accepted viewers on ${projectArg}.`);
		console.log(
			chalk.gray(`Invite one: ${chalk.cyan(`clawdi project invite ${projectArg} --email <addr>`)}`),
		);
		return;
	}
	console.log(chalk.bold(`People with project access (${members.length})`));
	console.log(
		chalk.gray(`  ${projectArg} viewers are read-only. Remove access without deleting content.`),
	);
	for (const m of members) {
		const who = m.user_email ?? m.user_display ?? m.user_id;
		console.log(
			`  ${chalk.bold(who)} ${chalk.gray(`(${m.user_id.slice(0, 8)}…)`)}\n` +
				`    ${chalk.gray(`${m.role} · joined via ${m.joined_via} · ${new Date(m.joined_at).toLocaleDateString()}`)}`,
		);
	}
	console.log();
	console.log(
		chalk.gray("Remove access: ") +
			chalk.cyan(`clawdi project members ${projectArg} --remove <email|user_id> --yes`),
	);
}

export async function projectLeaveCommand(
	projectArg: string,
	opts: { json?: boolean; yes?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;

	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	if (
		!(await confirmOrRequireYes(`Leave project ${projectArg}?`, {
			yes: opts.yes,
			action: "leave this project",
		}))
	) {
		return;
	}
	const result = await authedJson<{ status: string }>(
		ctx.apiUrl,
		ctx.apiKey,
		`/v1/projects/${encodeURIComponent(projectId)}/leave`,
		{ method: "POST" },
	);
	if (opts.json) {
		emit({ schemaVersion: "clawdi.projectLeave.v1", project_id: projectId, ...result });
		return;
	}
	console.log(`${chalk.green("✓")} Left ${projectArg}.`);
	console.log(
		chalk.gray("  Project membership removed. Your agents can no longer use this project."),
	);
}

export async function projectUnshareCommand(
	projectArg: string,
	opts: { json?: boolean; yes?: boolean },
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;

	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	if (
		!(await confirmOrRequireYes(
			`Revoke all links, cancel all invites, and remove all viewers from ${projectArg}?`,
			{ yes: opts.yes, action: "stop sharing this project" },
		))
	) {
		return;
	}
	const result = await authedJson<{
		links_revoked: number;
		members_removed: number;
		invitations_cancelled: number;
	}>(ctx.apiUrl, ctx.apiKey, `/v1/projects/${encodeURIComponent(projectId)}/unshare`, {
		method: "POST",
	});
	if (opts.json) {
		emit({ schemaVersion: "clawdi.projectUnshare.v1", project_id: projectId, ...result });
		return;
	}
	console.log(`${chalk.green("✓")} Stopped project sharing for ${projectArg}.`);
	console.log(
		chalk.gray(
			`  Revoked ${result.links_revoked} link(s), removed ${result.members_removed} member(s), ` +
				`canceled ${result.invitations_cancelled} invitation(s).`,
		),
	);
	console.log(chalk.gray("  Owned project content remains in place."));
}
