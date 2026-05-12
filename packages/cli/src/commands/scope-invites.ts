import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveScopeId } from "../lib/scope-resolver";

/**
 * `clawdi scope invites [<scope>] [--accept ID | --decline ID | --cancel ID]`
 *
 * No <scope> argument:
 *   * Default → list MY pending invitations (inbox view).
 *   * --accept / --decline → invitee action on an inbox entry.
 *
 * With <scope> argument:
 *   * Default → list invitations the OWNER has sent on that scope.
 *   * --cancel → owner cancels a pending invitation.
 *
 * The accept path also synchronously pulls shared skills + writes
 * them to every adapter, same as `share accept` — so the demo on a
 * fresh agent machine lights up immediately after accepting.
 */

interface InvitationItem {
	id: string;
	scope_id: string;
	scope_name: string;
	scope_kind: string;
	owner_display: string;
	owner_handle: string;
	invitee_email: string;
	invited_by_user_id: string;
	invited_by_display: string | null;
	created_at: string;
}

interface SkillSummary {
	skill_key: string;
	scope_id?: string | null;
	is_active?: boolean;
}

async function authedGet<T>(apiUrl: string, bearer: string, path: string): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	return r.json() as Promise<T>;
}

async function authedPost<T>(apiUrl: string, bearer: string, path: string): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		method: "POST",
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

/** Eagerly pull the shared scope's skills to every adapter — same
 * shape as the share-accept eager pull, factored out for reuse. */
async function pullSharedSkills(
	apiUrl: string,
	bearer: string,
	scopeId: string,
	ownerHandle: string,
): Promise<number> {
	const PAGE_SIZE = 200;
	const items: SkillSummary[] = [];
	let page = 1;
	while (true) {
		const url = new URL(`${apiUrl}/api/skills`);
		url.searchParams.set("scope_id", scopeId);
		url.searchParams.set("page", String(page));
		url.searchParams.set("page_size", String(PAGE_SIZE));
		const r = await fetch(url, {
			headers: { Authorization: `Bearer ${bearer}` },
		});
		if (!r.ok) throw new Error(`Skill listing failed: HTTP ${r.status}`);
		const body = (await r.json()) as { items: SkillSummary[] };
		items.push(...body.items);
		if (body.items.length < PAGE_SIZE) break;
		page += 1;
		if (page > 50) break;
	}
	const active = items.filter((s) => s.is_active !== false);
	if (active.length === 0) return 0;

	const adapters = allAdapterEntries().map((e) => e.create());
	let written = 0;
	for (const skill of active) {
		const dl = await fetch(
			`${apiUrl}/api/scopes/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(skill.skill_key)}/download`,
			{ headers: { Authorization: `Bearer ${bearer}` } },
		);
		if (!dl.ok) continue;
		const buf = Buffer.from(await dl.arrayBuffer());
		for (const adapter of adapters) {
			await adapter.writeSharedSkillArchive(skill.skill_key, ownerHandle, buf).catch(() => {});
		}
		written += 1;
	}
	return written;
}

function formatInvite(inv: InvitationItem): string {
	const when = new Date(inv.created_at).toLocaleDateString();
	return (
		`  ${chalk.bold(inv.scope_name)}` +
		`  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
		`\n    from ${inv.owner_display} ${chalk.gray(`@${inv.owner_handle}`)}` +
		chalk.gray(` · ${when}`)
	);
}

export async function scopeInvitesCommand(
	scopeArg: string | undefined,
	opts: { accept?: string; decline?: string; cancel?: string },
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	// --- Invitee paths (no scope arg) ---
	if (!scopeArg) {
		if (opts.accept) {
			const body = await authedPost<{
				scope_id: string;
				resolved_owner_handle: string;
				joined_at: string;
			}>(apiUrl, auth.apiKey, `/api/me/invitations/${opts.accept}/accept`);
			console.log(chalk.green("✓") + " Accepted invitation, joined as viewer.");
			console.log(`  ${chalk.gray("Scope ID:")} ${body.scope_id}`);
			console.log(`  ${chalk.gray("Owner handle:")} @${body.resolved_owner_handle}`);
			const written = await pullSharedSkills(
				apiUrl,
				auth.apiKey,
				body.scope_id,
				body.resolved_owner_handle,
			).catch((e) => {
				console.log(
					chalk.yellow(
						`  (Couldn't pull shared skills yet: ${e instanceof Error ? e.message : String(e)}. ` +
							"Run `clawdi pull` or restart `clawdi serve` to retry.)",
					),
				);
				return 0;
			});
			if (written > 0) {
				console.log(
					chalk.gray(
						`  Pulled ${written} skill${written === 1 ? "" : "s"} into your local agents.`,
					),
				);
			}
			return;
		}
		if (opts.decline) {
			await authedPost(apiUrl, auth.apiKey, `/api/me/invitations/${opts.decline}/decline`);
			console.log(chalk.green("✓") + " Invitation declined.");
			return;
		}
		// Default: list MY inbox.
		const items = await authedGet<InvitationItem[]>(apiUrl, auth.apiKey, "/api/me/invitations");
		if (items.length === 0) {
			console.log("No pending invitations.");
			return;
		}
		console.log(chalk.bold(`Pending invitations (${items.length}):`));
		for (const inv of items) console.log(formatInvite(inv));
		console.log();
		console.log(chalk.gray("Accept: ") + chalk.cyan(`clawdi scope invites --accept <id>`));
		console.log(chalk.gray("Decline: ") + chalk.cyan(`clawdi scope invites --decline <id>`));
		return;
	}

	// --- Owner paths (scope arg present) ---
	const scopeId = await resolveScopeId(apiUrl, auth.apiKey, scopeArg);
	if (opts.cancel) {
		await authedDelete(apiUrl, auth.apiKey, `/api/scopes/${scopeId}/invitations/${opts.cancel}`);
		console.log(chalk.green("✓") + " Invitation cancelled.");
		return;
	}
	const items = await authedGet<InvitationItem[]>(
		apiUrl,
		auth.apiKey,
		`/api/scopes/${scopeId}/invitations`,
	);
	if (items.length === 0) {
		console.log("No invitations on this scope.");
		console.log();
		console.log("Send one: " + chalk.cyan(`clawdi scope invite ${scopeArg} --email <addr>`));
		return;
	}
	console.log(chalk.bold(`Invitations on this scope (${items.length}):`));
	for (const inv of items) {
		console.log(
			`  ${chalk.bold(inv.invitee_email)}  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
				chalk.gray(` · sent ${new Date(inv.created_at).toLocaleDateString()}`),
		);
	}
	console.log();
	console.log(
		chalk.gray("Cancel: ") + chalk.cyan(`clawdi scope invites ${scopeArg} --cancel <id>`),
	);
}
