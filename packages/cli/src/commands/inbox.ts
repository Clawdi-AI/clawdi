/**
 * `clawdi inbox ...` — incoming shares awaiting my action.
 *
 *   inbox                          # list pending invitations
 *   inbox accept <id-or-url> ...   # accept invitation OR redeem URL
 *   inbox decline <id>             # decline pending invitation
 *   inbox forget <id-or-alias>     # local-only: drop redeemed token
 *
 * Spec: docs/superpowers/specs/2026-05-11-scope-sharing-spec.md
 * § "clawdi inbox — incoming, awaiting my decision"
 */

import { rmSync } from "node:fs";

import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { pullSharedSkills } from "../share/eager-pull";
import { addToken, findToken, listTokens, removeToken, type ShareToken } from "../share/tokens";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Strip wrappers commonly left on URLs pasted from chat / Markdown:
 *   <https://…>      → https://…
 *   "https://…"      → https://…
 *   https://…,       → https://…
 *
 * Spec § "inbox accept polymorphism" normalize_accept_arg.
 */
function normalizeAcceptArg(raw: string): string {
	let s = raw.trim();
	if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
	s = s.replace(/[,.!;:]+$/, "");
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1);
	}
	return s;
}

/** Detect what shape a polymorphic accept argument has so the
 * dispatcher can route it (or surface the right error). The
 * anonymous-mode and authed-mode branches both run the same
 * detection on the positional argument; extracting it keeps the
 * "what does this string look like?" rule in one place. */
function detectAcceptArgShape(normalized: string): "uuid" | "url" | "raw_token" | "unknown" {
	if (UUID_RE.test(normalized)) return "uuid";
	if (RAW_TOKEN_RE.test(normalized)) return "raw_token";
	if (normalized.startsWith("http")) return "url";
	return "unknown";
}

function extractTokenFromUrl(input: string): string {
	if (RAW_TOKEN_RE.test(input)) return input;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Not a valid share link or raw token: ${input.slice(0, 60)}…`);
	}
	const match = url.pathname.match(/\/share\/([A-Za-z0-9_-]+)\/?$/);
	if (!match) {
		throw new Error(`URL is not a clawdi share link: ${input}`);
	}
	return match[1];
}

interface AcceptOpts {
	into?: string;
	alias?: string;
	noMount?: boolean;
	allowVaultConflicts?: boolean;
	invite?: string;
	url?: string;
}

interface ShareUpgradeResponse {
	scope_id: string;
	resolved_owner_handle: string;
	membership_id: string;
	mount_id?: string;
	mount_alias?: string;
	mount_parent_scope_id?: string;
	skill_count?: number;
}

interface SharePreview {
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	skill_count: number;
	vault_count: number;
}

interface InvitationItem {
	id: string;
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	created_at: string;
}

interface InvitationAcceptResponse {
	id: string;
	scope_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	mount_id?: string;
	mount_alias?: string;
	mount_parent_scope_id?: string;
}

// ────────────────────────────────────────────────────────────────
// inbox (list)
// ────────────────────────────────────────────────────────────────

export async function inboxListCommand(opts: { json?: boolean }): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();

	// Anonymous: server invitations require auth, but locally-redeemed
	// share-tokens (anonymous redeem path) live in ~/.clawdi/share-tokens.json
	// and ARE this device's inbox of un-claimed shares. Surface them so
	// the user can see what they redeemed before logging in.
	if (!auth?.apiKey) {
		const tokens = listTokens().filter((t) => !t.upgraded_at);
		if (opts.json) {
			// Redact the raw token — it's the bearer credential for the
			// scope and stdout / agent logs are not 0600. Consumers that
			// need the raw value can read ~/.clawdi/share-tokens.json directly.
			const redacted = tokens.map(({ token: _omit, ...rest }) => rest);
			console.log(JSON.stringify({ invitations: [], local_share_tokens: redacted }, null, 2));
			return;
		}
		if (tokens.length === 0) {
			console.log("Nothing in your inbox.");
			console.log(
				chalk.gray(
					"Sign in with `clawdi auth login` to see invitations and convert any " +
						"anonymous share-tokens to permanent memberships.",
				),
			);
			return;
		}
		console.log(chalk.bold(`Anonymous share-tokens on this device (${tokens.length}):`));
		for (const t of tokens) {
			console.log(
				`  ${chalk.bold(t.scope_name)}  ${chalk.gray(`— from ${t.owner_display} (@${t.owner_handle})`)}`,
			);
			console.log(chalk.gray(`    scope_id: ${t.scope_id}`));
		}
		console.log();
		console.log(
			chalk.gray("Run ") +
				chalk.cyan("clawdi auth login") +
				chalk.gray(" — pending tokens upgrade to permanent memberships automatically."),
		);
		return;
	}

	const r = await fetch(`${apiUrl}/api/me/invitations`, {
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	const items = (await r.json()) as InvitationItem[];

	if (opts.json) {
		console.log(JSON.stringify({ invitations: items }, null, 2));
		return;
	}

	if (items.length === 0) {
		console.log("No pending invitations.");
		return;
	}
	console.log(chalk.bold(`Pending invitations (${items.length}):`));
	for (const inv of items) {
		console.log(
			`  ${chalk.bold(inv.scope_name)}  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
				`\n    from ${inv.owner_display} ${chalk.gray(`@${inv.owner_handle}`)}` +
				chalk.gray(` · ${new Date(inv.created_at).toLocaleDateString()}`),
		);
	}
	console.log();
	console.log(
		chalk.gray("Accept: ") +
			chalk.cyan("clawdi inbox accept <id>") +
			chalk.gray("  (a share URL also works)"),
	);
}

// ────────────────────────────────────────────────────────────────
// inbox accept
// ────────────────────────────────────────────────────────────────

export async function inboxAcceptCommand(
	posArg: string | undefined,
	opts: AcceptOpts,
): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		// Anonymous: only URL path makes sense (invitations require auth).
		if (!posArg && !opts.url) {
			console.error(
				chalk.red(
					"Not signed in. For invitations, run `clawdi auth login` first. " +
						"For share URLs, pass the link as the positional argument.",
				),
			);
			process.exitCode = 1;
			return;
		}
		// Friendlier error when the arg is shaped like an invitation UUID:
		// these REQUIRE auth, so direct the user at `auth login` rather than
		// letting the URL parser fail with "Not a valid share link".
		const normalized = opts.url ?? normalizeAcceptArg(posArg ?? "");
		if (detectAcceptArgShape(normalized) === "uuid" && !opts.url) {
			console.error(
				chalk.red(
					"That looks like an invitation id. Invitations require an account — " +
						"run `clawdi auth login` first, then re-run.",
				),
			);
			process.exitCode = 1;
			return;
		}
		await acceptAnonymousUrl(apiUrl, normalized);
		return;
	}

	// Logged in — pick the shape.
	if (opts.invite) {
		await acceptInvitation(apiUrl, auth.apiKey, opts.invite, opts);
		return;
	}
	if (opts.url) {
		await acceptUrl(apiUrl, auth.apiKey, opts.url, opts);
		return;
	}
	if (!posArg) {
		console.error(
			chalk.red(
				"Pass an invitation id or share URL.\n" +
					"  clawdi inbox accept <invitation-uuid>\n" +
					"  clawdi inbox accept <https://.../share/...>\n" +
					"  clawdi inbox accept --invite <uuid>   # explicit\n" +
					"  clawdi inbox accept --url <link>      # explicit",
			),
		);
		process.exitCode = 1;
		return;
	}

	const normalized = normalizeAcceptArg(posArg);
	const shape = detectAcceptArgShape(normalized);
	if (shape === "uuid") {
		await acceptInvitation(apiUrl, auth.apiKey, normalized, opts);
	} else if (shape === "url" || shape === "raw_token") {
		await acceptUrl(apiUrl, auth.apiKey, normalized, opts);
	} else {
		console.error(
			chalk.red(
				`Can't tell whether '${normalized.slice(0, 60)}…' is an invitation id or a URL.\n` +
					"  Invitation id shape:  1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d\n" +
					"  Share URL shape:      https://.../share/<43-char-token>\n" +
					"  Use --invite <id> or --url <link> to be explicit.",
			),
		);
		process.exitCode = 1;
	}
}

// ────────────────────────────────────────────────────────────────
// inbox decline
// ────────────────────────────────────────────────────────────────

export async function inboxDeclineCommand(invitationId: string): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}
	const r = await fetch(`${apiUrl}/api/me/invitations/${invitationId}/decline`, {
		method: "POST",
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	console.log(`${chalk.green("✓")} Invitation declined.`);
}

// ────────────────────────────────────────────────────────────────
// inbox forget — local-only cleanup
// ────────────────────────────────────────────────────────────────

export function inboxForgetCommand(scopeIdOrAlias: string): void {
	const token = findToken(scopeIdOrAlias);
	if (!token) {
		console.error(chalk.red(`No local share-token entry found for '${scopeIdOrAlias}'.`));
		console.error(
			chalk.gray("Run `clawdi inbox` (signed-out) to list local share-tokens on this device."),
		);
		process.exitCode = 1;
		return;
	}

	// Best-effort skill folder cleanup (only the anonymous-pulled
	// content paths under each adapter's getSharedSkillPath).
	const skillKeys = token.last_seen_skill_keys ?? [];
	let removed = 0;
	for (const entry of allAdapterEntries()) {
		const adapter = entry.create();
		for (const key of skillKeys) {
			const path = adapter.getSharedSkillPath(key, token.owner_handle);
			try {
				rmSync(path, { recursive: true, force: true });
				removed++;
			} catch {
				// Best-effort
			}
		}
	}
	removeToken(token.scope_id);

	console.log(`${chalk.green("✓")} Forgot local share for "${chalk.bold(token.scope_name)}".`);
	if (removed > 0) {
		console.log(chalk.gray(`  Removed ${removed} local skill folder${removed === 1 ? "" : "s"}.`));
	}
	console.log(
		chalk.gray(
			"  This is a LOCAL operation only. Server-side membership (if any) " +
				"is unchanged — `clawdi scope leave <scope>` drops that.",
		),
	);
}

// ────────────────────────────────────────────────────────────────
// Internal: accept paths
// ────────────────────────────────────────────────────────────────

async function acceptAnonymousUrl(apiUrl: string, urlOrToken: string): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);

	const existing = listTokens().find((t) => t.token === token);
	if (existing) {
		console.log(
			chalk.gray(
				`Already accepted: ${existing.scope_name} (@${existing.owner_handle}). ` +
					`Run \`clawdi auth login\` to convert to permanent membership.`,
			),
		);
		return;
	}

	const r = await fetch(`${apiUrl}/api/share/${token}/redeem`, { method: "POST" });
	if (r.status === 404) {
		throw new Error("Share link not found. Ask the owner for a fresh one.");
	}
	if (r.status === 410) {
		throw new Error("Share link has been revoked or expired.");
	}
	if (!r.ok) throw new Error(`Redeem failed: HTTP ${r.status}`);
	const body = (await r.json()) as SharePreview;

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
			` Accepted "${chalk.bold(body.scope_name)}" from ${body.owner_display} (@${body.owner_handle}).`,
	);
	console.log(
		chalk.gray(
			`  ${body.skill_count} skill${body.skill_count === 1 ? "" : "s"}, ` +
				`${body.vault_count} vault secret${body.vault_count === 1 ? "" : "s"} (sign in to unlock).`,
		),
	);
	console.log();
	console.log(
		chalk.gray(
			"Token saved to ~/.clawdi/share-tokens.json (0600). " +
				"Run `clawdi auth login` to convert to a permanent mount.",
		),
	);
}

/** Build the JSON body shared by both /upgrade and /accept routes
 * from the CLI's AcceptOpts. Resolves `--into` to a UUID up-front
 * so the caller doesn't need to. */
async function buildAcceptRequestBody(
	apiUrl: string,
	bearer: string,
	opts: AcceptOpts,
): Promise<Record<string, unknown>> {
	const reqBody: Record<string, unknown> = {};
	if (opts.into) reqBody.parent_scope_id = await resolveScopeArg(apiUrl, bearer, opts.into);
	if (opts.alias) reqBody.alias = opts.alias;
	if (opts.noMount) reqBody.no_mount = true;
	return reqBody;
}

/** Render the 409 mount_target_ambiguous block. `retryHint` is the
 * caller-specific "how to mount later" line (URL re-accept vs
 * invitation re-accept) shown after the owned-scopes list. */
function renderMountAmbiguous(detail: Record<string, unknown>, retryHint: string): void {
	console.log(`${chalk.green("✓")} Joined as viewer (membership saved).`);
	console.log(chalk.yellow("⚠ Mount deferred — you have 2+ owned scopes."));
	console.log(chalk.gray("  Pick a parent for the mount:"));
	const owned = (detail.owned_scopes ?? []) as Array<{ slug: string; kind: string }>;
	for (const s of owned) console.log(chalk.gray(`    - ${s.slug}  (${s.kind})`));
	console.log();
	console.log(chalk.gray(`  ${retryHint}`));
	console.log(chalk.gray(`  Or: clawdi scope mount <source-slug> --into <parent-slug>`));
}

/** Print the "Joined — Mounted as @x/y" success block. `noMountHint`
 * controls whether the `--no-mount: capability only` line renders
 * (only applies on the share-URL upgrade path, where `--no-mount`
 * actually makes sense as a flag the user can pass). */
function renderJoinedSuccess(
	body: { resolved_owner_handle: string; mount_alias?: string },
	noMountHint: boolean,
): void {
	console.log(
		chalk.green("✓") +
			` Joined as viewer — @${body.resolved_owner_handle}'s scope is in your workspace.`,
	);
	if (body.mount_alias) {
		console.log(
			chalk.gray("  Mounted as ") + chalk.bold(body.mount_alias) + chalk.gray(" into your scope."),
		);
	} else if (noMountHint) {
		console.log(chalk.gray("  (--no-mount: capability only, no mount edge.)"));
	}
}

/** Run the eager pull and print "Pulled N skills…". `verboseError`
 * controls whether a pull failure prints a "Run `clawdi pull` later
 * to retry" hint (matches the original per-path behavior). */
async function eagerPullAndReport(
	apiUrl: string,
	bearer: string,
	scopeId: string,
	ownerHandle: string,
	verboseError: boolean,
): Promise<void> {
	const written = await pullSharedSkills(apiUrl, bearer, scopeId, ownerHandle).catch((e) => {
		if (verboseError) {
			console.log(
				chalk.yellow(
					`  (Couldn't pull shared skills yet: ${e instanceof Error ? e.message : String(e)}. ` +
						"Run `clawdi pull` later to retry.)",
				),
			);
		}
		return 0;
	});
	if (written > 0) {
		console.log(
			chalk.gray(`  Pulled ${written} skill${written === 1 ? "" : "s"} into your local agents.`),
		);
	}
}

async function acceptUrl(
	apiUrl: string,
	bearer: string,
	urlOrToken: string,
	opts: AcceptOpts,
): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);
	const reqBody = await buildAcceptRequestBody(apiUrl, bearer, opts);

	const r = await fetch(`${apiUrl}/api/share/${token}/upgrade`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
	});

	if (r.status === 409) {
		const detail = (await r.json().catch(() => ({})))?.detail ?? {};
		if (detail.error === "mount_target_ambiguous") {
			renderMountAmbiguous(
				detail,
				`${chalk.cyan("clawdi inbox accept <same-url> --into <slug>")} → re-run to mount`,
			);
			process.exitCode = 4;
			return;
		}
		if (detail.error === "already_owner") {
			console.log(chalk.yellow("This is your own scope — nothing to accept."));
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(detail), hint: "" });
	}
	if (r.status === 404) throw new Error("Share link not found.");
	if (r.status === 410) throw new Error("Share link revoked or expired.");
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = (await r.json()) as ShareUpgradeResponse;
	renderJoinedSuccess(body, !!opts.noMount);
	await eagerPullAndReport(apiUrl, bearer, body.scope_id, body.resolved_owner_handle, true);
}

async function acceptInvitation(
	apiUrl: string,
	bearer: string,
	invitationId: string,
	opts: AcceptOpts,
): Promise<void> {
	const reqBody = await buildAcceptRequestBody(apiUrl, bearer, opts);

	const r = await fetch(`${apiUrl}/api/me/invitations/${invitationId}/accept`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
	});

	if (r.status === 409) {
		const detail = (await r.json().catch(() => ({})))?.detail ?? {};
		if (detail.error === "mount_target_ambiguous") {
			renderMountAmbiguous(detail, "Re-run with --into <slug> to mount.");
			process.exitCode = 4;
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(detail), hint: "" });
	}
	if (r.status === 410) {
		console.error(chalk.red("This invitation was revoked or already accepted."));
		process.exitCode = 1;
		return;
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = (await r.json()) as InvitationAcceptResponse;
	renderJoinedSuccess(body, false);
	await eagerPullAndReport(apiUrl, bearer, body.scope_id, body.resolved_owner_handle, false);
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function resolveScopeArg(apiUrl: string, bearer: string, raw: string): Promise<string> {
	// Resolve a UUID / slug / human-name to a UUID via /api/scopes.
	if (UUID_RE.test(raw)) return raw;
	const r = await fetch(`${apiUrl}/api/scopes`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	const scopes = (await r.json()) as Array<{ id: string; slug: string; name: string }>;
	const lower = raw.toLowerCase();
	const slug = scopes.filter((s) => s.slug.toLowerCase() === lower);
	const name = scopes.filter((s) => s.name.toLowerCase() === lower);
	const matches = slug.length > 0 ? slug : name;
	if (matches.length === 0) {
		throw new Error(`No scope matches '${raw}'. Try \`clawdi scope list\`.`);
	}
	if (matches.length > 1) {
		throw new Error(`'${raw}' matches ${matches.length} scopes; pass the UUID.`);
	}
	return matches[0].id;
}
