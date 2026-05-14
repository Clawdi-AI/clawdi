import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveScopeId } from "../lib/scope-resolver";

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

async function fetchMembers(apiUrl: string, apiKey: string, scopeId: string): Promise<MemberRow[]> {
	return requestJson<MemberRow[]>(`${apiUrl}/api/projects/${scopeId}/members`, apiKey);
}

export async function scopeMembersCommand(
	scopeArg: string,
	opts: { json?: boolean; remove?: string },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const scopeId = await resolveScopeId(ctx.apiUrl, ctx.apiKey, scopeArg);
	if (opts.remove) {
		const members = await fetchMembers(ctx.apiUrl, ctx.apiKey, scopeId);
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
			`${ctx.apiUrl}/api/projects/${scopeId}/members/${matches[0].user_id}`,
			ctx.apiKey,
			{ method: "DELETE" },
		);
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						project_id: scopeId,
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
		return;
	}

	const members = await fetchMembers(ctx.apiUrl, ctx.apiKey, scopeId);
	if (opts.json) {
		console.log(JSON.stringify({ project_id: scopeId, members }, null, 2));
		return;
	}
	if (members.length === 0) {
		console.log(`No members on ${scopeArg}.`);
		console.log(
			chalk.gray(`Invite one: ${chalk.cyan(`clawdi project invite ${scopeArg} --email <addr>`)}`),
		);
		return;
	}
	console.log(chalk.bold(`Members on ${scopeArg} (${members.length}):`));
	for (const m of members) {
		const who = m.user_email ?? m.user_display ?? m.user_id;
		console.log(
			`  ${chalk.bold(who)} ${chalk.gray(`(${m.user_id.slice(0, 8)}…)`)}\n` +
				`    ${chalk.gray(`${m.role} · joined via ${m.joined_via} · ${new Date(m.joined_at).toLocaleDateString()}`)}`,
		);
	}
	console.log();
	console.log(
		chalk.gray("Remove: ") +
			chalk.cyan(`clawdi project members ${scopeArg} --remove <email|user_id>`),
	);
}

export async function scopeLeaveCommand(scopeArg: string, opts: { json?: boolean }): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const scopeId = await resolveScopeId(ctx.apiUrl, ctx.apiKey, scopeArg);
	const result = await requestJson<{ status: string }>(
		`${ctx.apiUrl}/api/projects/${scopeId}/leave`,
		ctx.apiKey,
		{ method: "POST" },
	);
	if (opts.json) {
		console.log(JSON.stringify({ project_id: scopeId, ...result }, null, 2));
		return;
	}
	console.log(`${chalk.green("✓")} Left ${scopeArg}.`);
}

export async function scopeUnshareCommand(
	scopeArg: string,
	opts: { json?: boolean },
): Promise<void> {
	const ctx = await requireAuth();
	if (!ctx) return;

	const scopeId = await resolveScopeId(ctx.apiUrl, ctx.apiKey, scopeArg);
	const result = await requestJson<{
		links_revoked: number;
		members_removed: number;
		invitations_cancelled: number;
	}>(`${ctx.apiUrl}/api/projects/${scopeId}/unshare`, ctx.apiKey, { method: "POST" });
	if (opts.json) {
		console.log(JSON.stringify({ project_id: scopeId, ...result }, null, 2));
		return;
	}
	console.log(`${chalk.green("✓")} Stopped sharing ${scopeArg}.`);
	console.log(
		chalk.gray(
			`  Revoked ${result.links_revoked} link(s), removed ${result.members_removed} member(s), ` +
				`cancelled ${result.invitations_cancelled} invitation(s).`,
		),
	);
}
