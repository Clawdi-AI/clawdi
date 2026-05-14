import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";

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

async function requireAuth(): Promise<{ apiUrl: string; apiKey: string } | null> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return null;
	}
	return { apiUrl, apiKey: auth.apiKey };
}

async function requestJson<T>(url: string, apiKey: string, init: RequestInit = {}): Promise<T> {
	const r = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(init.headers ?? {}),
		},
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	return r.json() as Promise<T>;
}

async function fetchMembers(
	apiUrl: string,
	apiKey: string,
	projectId: string,
): Promise<MemberRow[]> {
	return requestJson<MemberRow[]>(`${apiUrl}/api/projects/${projectId}/members`, apiKey);
}

export async function projectMembersCommand(
	projectArg: string,
	opts: { json?: boolean; remove?: string },
): Promise<void> {
	const ctx = await requireAuth();
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
		const removed = await requestJson<{ status: string }>(
			`${ctx.apiUrl}/api/projects/${projectId}/members/${matches[0].user_id}`,
			ctx.apiKey,
			{ method: "DELETE" },
		);
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						project_id: projectId,
						removed_user_id: matches[0].user_id,
						...removed,
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(`${chalk.green("✓")} Removed ${matches[0].user_email ?? matches[0].user_id}.`);
		console.log(chalk.gray("  Their agent bindings for this project will stop applying."));
		return;
	}

	const members = await fetchMembers(ctx.apiUrl, ctx.apiKey, projectId);
	if (opts.json) {
		console.log(JSON.stringify({ project_id: projectId, members }, null, 2));
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
			chalk.cyan(`clawdi project members ${projectArg} --remove <email|user_id>`),
	);
}

export async function projectLeaveCommand(
	projectArg: string,
	opts: { json?: boolean },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	const result = await requestJson<{ status: string }>(
		`${ctx.apiUrl}/api/projects/${projectId}/leave`,
		ctx.apiKey,
		{ method: "POST" },
	);
	if (opts.json) {
		console.log(JSON.stringify({ project_id: projectId, ...result }, null, 2));
		return;
	}
	console.log(`${chalk.green("✓")} Left ${projectArg}.`);
	console.log(
		chalk.gray("  Project membership removed. Any agent context binding for it stops applying."),
	);
}

export async function projectUnshareCommand(
	projectArg: string,
	opts: { json?: boolean },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	const result = await requestJson<{
		links_revoked: number;
		members_removed: number;
		invitations_cancelled: number;
	}>(`${ctx.apiUrl}/api/projects/${projectId}/unshare`, ctx.apiKey, { method: "POST" });
	if (opts.json) {
		console.log(JSON.stringify({ project_id: projectId, ...result }, null, 2));
		return;
	}
	console.log(`${chalk.green("✓")} Stopped project sharing for ${projectArg}.`);
	console.log(
		chalk.gray(
			`  Revoked ${result.links_revoked} link(s), removed ${result.members_removed} member(s), ` +
				`cancelled ${result.invitations_cancelled} invitation(s).`,
		),
	);
	console.log(chalk.gray("  Owned project content remains in place."));
}
