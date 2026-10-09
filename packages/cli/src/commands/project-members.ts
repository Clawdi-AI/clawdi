import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { requireUuid } from "../lib/cli-options";
import { emit } from "../lib/command-output";
import { projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";

async function fetchMembers(apiUrl: string, apiKey: string, projectId: string) {
	return unwrap(
		await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).GET(
			"/v1/projects/{project_id}/members",
			{ params: { path: { project_id: projectId } } },
		),
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
		const removed = unwrap(
			await new ApiClient({ baseUrl: ctx.apiUrl, authToken: ctx.apiKey }).DELETE(
				"/v1/projects/{project_id}/members/{member_user_id}",
				{
					params: { path: { project_id: projectId, member_user_id: memberUserId } },
				},
			),
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
	const result = unwrap(
		await new ApiClient({ baseUrl: ctx.apiUrl, authToken: ctx.apiKey }).POST(
			"/v1/projects/{project_id}/leave",
			{ params: { path: { project_id: projectId } } },
		),
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
	const result = unwrap(
		await new ApiClient({ baseUrl: ctx.apiUrl, authToken: ctx.apiKey }).POST(
			"/v1/projects/{project_id}/unshare",
			{ params: { path: { project_id: projectId } } },
		),
	);
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
