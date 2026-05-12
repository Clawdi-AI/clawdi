/**
 * `clawdi share accept <url>` — redeem a share link.
 *
 * Two paths depending on local auth state:
 *   - Logged in (CLI has an unbound api_key from `clawdi auth
 *     login`): POST /api/share/{token}/upgrade directly → creates
 *     a ScopeMembership. No token stored locally; this device
 *     uses the membership path via `scope_ids_visible_to` from now on.
 *   - Anonymous: POST /api/share/{token}/redeem → stores the raw
 *     token in `~/.clawdi/share-tokens.json`. Sync engine
 *     periodically pulls skill content via the share-token surface.
 *
 * The "logged-in fast path" matches spec § 4.3 — sharees who are
 * already authed shouldn't need to redeem-then-later-upgrade.
 */

import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { getAuth, getConfig } from "../lib/config";
import { addToken, listTokens, type ShareToken } from "../share/tokens";

const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function extractTokenFromUrl(input: string): string {
	const trimmed = input.trim();
	if (RAW_TOKEN_RE.test(trimmed)) return trimmed;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Not a valid share link or raw token: ${trimmed.slice(0, 60)}…`);
	}
	const match = url.pathname.match(/\/share\/([A-Za-z0-9_-]+)\/?$/);
	if (!match) {
		throw new Error(`URL is not a clawdi share link: ${trimmed}`);
	}
	return match[1];
}

export async function shareAcceptCommand(urlOrToken: string): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);
	const { apiUrl } = getConfig();
	const auth = getAuth();

	// Idempotency: if we already have this token AND we're
	// anonymous, return early. (When logged in we still want to
	// /upgrade so the server-side membership row is created.)
	const existing = listTokens().find((t) => t.token === token);
	if (existing && !auth?.apiKey) {
		console.log(
			chalk.gray(`Already accepted: ${existing.scope_name} (@${existing.owner_handle}). `) +
				chalk.gray(`Run \`clawdi share list\` to see all your shared scopes.`),
		);
		return;
	}

	if (auth?.apiKey) {
		// Logged-in direct upgrade.
		const r = await fetch(`${apiUrl}/api/share/${token}/upgrade`, {
			method: "POST",
			headers: { Authorization: `Bearer ${auth.apiKey}` },
		});
		if (r.status === 404) {
			throw new Error("Share link not found. Ask the owner for a fresh one.");
		}
		if (r.status === 410) {
			throw new Error("Share link has been revoked or expired. Ask the owner for a fresh one.");
		}
		if (r.status === 409) {
			// Already a member OR you're the owner. Server returns
			// existing membership row (or the already_owner error).
			const body = await r.json().catch(() => ({}));
			if (body?.detail?.error === "already_owner") {
				console.log(chalk.yellow("This is your own scope — nothing to accept."));
				return;
			}
			// Already a member: treat as success.
			console.log(chalk.gray("Already a member of this scope."));
			return;
		}
		if (!r.ok) {
			throw new Error(`Upgrade failed: HTTP ${r.status}`);
		}
		const body = (await r.json()) as {
			scope_id: string;
			resolved_owner_handle: string;
		};
		console.log(chalk.green("✓") + ` Joined as viewer — your dashboard now lists this scope.`);
		console.log(`  ${chalk.gray("Owner handle:")} @${body.resolved_owner_handle}`);
		console.log(`  ${chalk.gray("Scope ID:")} ${body.scope_id}`);
		console.log();
		// Eagerly pull the shared skills so the local agent sees
		// them immediately — daemon reconcile would do this on its
		// next cycle, but `share accept` should feel synchronous.
		// Falls back gracefully on network errors: the membership
		// row exists either way, so a later `clawdi pull` recovers.
		const skillsWritten = await pullSharedSkills(
			apiUrl,
			auth.apiKey,
			body.scope_id,
			body.resolved_owner_handle,
		).catch((e) => {
			console.log(
				chalk.yellow(
					`  (Couldn't pull shared skills yet: ${e instanceof Error ? e.message : String(e)}. ` +
						`Run \`clawdi pull\` or restart \`clawdi serve\` to retry.)`,
				),
			);
			return 0;
		});
		if (skillsWritten > 0) {
			console.log(
				chalk.gray(
					`  Pulled ${skillsWritten} skill${skillsWritten === 1 ? "" : "s"} ` +
						`from this scope into your local agents.`,
				),
			);
		}
		console.log();
		console.log(`Run \`clawdi scope list\` to see it alongside your own scopes.`);
		return;
	}

	// Anonymous path — store the token locally, daemon syncs on
	// next reconcile cycle.
	const r = await fetch(`${apiUrl}/api/share/${token}/redeem`, {
		method: "POST",
	});
	if (r.status === 404) {
		throw new Error("Share link not found. Ask the owner for a fresh one.");
	}
	if (r.status === 410) {
		throw new Error("Share link has been revoked or expired. Ask the owner for a fresh one.");
	}
	if (!r.ok) {
		throw new Error(`Redeem failed: HTTP ${r.status}`);
	}
	const body = (await r.json()) as {
		scope_id: string;
		scope_name: string;
		owner_display: string;
		owner_handle: string;
		skill_count: number;
		vault_count: number;
	};
	const record: ShareToken = {
		scope_id: body.scope_id,
		scope_name: body.scope_name,
		owner_display: body.owner_display,
		owner_handle: body.owner_handle,
		token,
		redeemed_at: new Date().toISOString(),
	};
	addToken(record);
	console.log(
		chalk.green("✓") +
			` Accepted "${chalk.bold(body.scope_name)}" from ${body.owner_display} (@${body.owner_handle})`,
	);
	console.log(
		`  ${body.skill_count} skill${body.skill_count === 1 ? "" : "s"}` +
			(body.vault_count > 0
				? chalk.gray(
						` · ${body.vault_count} vault secret${body.vault_count === 1 ? "" : "s"} (sign in to use)`,
					)
				: ""),
	);
	console.log(chalk.gray(`  Token saved to ~/.clawdi/share-tokens.json (0600).`));
	console.log();
	console.log(
		chalk.gray(
			"Daemon syncs shared scopes automatically. Run " +
				chalk.bold("`clawdi serve`") +
				" if you don't already have one running, or " +
				chalk.bold("`clawdi share list`") +
				" to see this and other accepted shares.",
		),
	);
	if (body.vault_count > 0) {
		console.log();
		console.log(
			chalk.dim(
				`To unlock vault secrets, sign in with ${chalk.bold("clawdi auth login")}. ` +
					"Your accepted shares auto-convert to permanent memberships.",
			),
		);
	}
}

interface SkillSummary {
	skill_key: string;
	scope_id?: string | null;
	is_active?: boolean;
}

/**
 * Pull the shared scope's skills synchronously and write to every
 * registered local adapter under its shared-skill path.
 *
 * Only valid for the logged-in upgrade path — the bearer token is
 * the user's CLI api_key and `scope_ids_visible_to` now includes
 * ScopeMembership, so the existing `/api/skills` and
 * `/api/scopes/{id}/skills/{key}/download` endpoints serve shared
 * content without a separate code path.
 *
 * Returns the count of skill folders written. Errors mid-pull are
 * not fatal: the membership already exists, a later daemon
 * reconcile will retry.
 */
async function pullSharedSkills(
	apiUrl: string,
	bearerToken: string,
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
			headers: { Authorization: `Bearer ${bearerToken}` },
		});
		if (!r.ok) throw new Error(`Skill listing failed: HTTP ${r.status}`);
		const body = (await r.json()) as { items: SkillSummary[]; total?: number };
		items.push(...body.items);
		if (body.items.length < PAGE_SIZE) break;
		page += 1;
		if (page > 50) break; // sanity cap, matches sync-engine
	}
	const active = items.filter((s) => s.is_active !== false);
	if (active.length === 0) return 0;

	const adapters = allAdapterEntries().map((e) => e.create());
	const seenKeys: string[] = [];
	for (const skill of active) {
		const dlUrl = `${apiUrl}/api/scopes/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(skill.skill_key)}/download`;
		const dl = await fetch(dlUrl, {
			headers: { Authorization: `Bearer ${bearerToken}` },
		});
		if (!dl.ok) {
			// Skip individual skill failures so one broken row
			// doesn't block the whole pull.
			continue;
		}
		const buf = Buffer.from(await dl.arrayBuffer());
		for (const adapter of adapters) {
			await adapter.writeSharedSkillArchive(skill.skill_key, ownerHandle, buf).catch(() => {
				// Adapter-level write failures (e.g. missing parent
				// dir on a host that's never used that agent) are
				// silent — other adapters still proceed.
			});
		}
		seenKeys.push(skill.skill_key);
	}

	// Stamp last_seen_skill_keys onto the local share-tokens.json
	// entry if one exists for this scope (anonymous path that later
	// upgraded). Scope-precise cleanup on `share remove` reads this.
	const tokens = listTokens();
	const existing = tokens.find((t) => t.scope_id === scopeId);
	if (existing) {
		const updated: ShareToken = {
			...existing,
			upgraded_at: new Date().toISOString(),
			last_seen_skill_keys: seenKeys,
		};
		addToken(updated);
	}

	return seenKeys.length;
}
