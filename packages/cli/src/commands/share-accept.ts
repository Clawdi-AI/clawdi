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
