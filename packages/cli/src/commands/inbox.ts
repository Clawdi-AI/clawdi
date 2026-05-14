/**
 * `clawdi inbox ...` — incoming project shares awaiting my action.
 *
 *   inbox                          # list pending invitations
 *   inbox accept <id-or-url> ...   # accept invitation OR redeem URL
 *   inbox decline <id>             # decline pending invitation
 *   inbox forget <id-or-alias>     # local-only: drop redeemed token
 *
 * User-facing flow: docs/scenarios/project-sharing-agent-bindings-demo.md
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { listProjects } from "../lib/project-resolver";
import { pullSharedSkills } from "../share/eager-pull";
import { addToken, findToken, listTokens, removeToken, type ShareToken } from "../share/tokens";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Strip wrappers commonly left on URLs pasted from chat / Markdown:
 *   <https://…>      → https://…
 *   "https://…"      → https://…
 *   https://…,       → https://…
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

function redeemIdempotencyKey(token: string): string {
	return `redeem-${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

interface AcceptOpts {
	agent?: string[];
	useAs?: string;
	bindAs?: string;
	invite?: string;
	url?: string;
	json?: boolean;
}

interface ShareUpgradeResponse {
	membership_id: string;
	project_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

interface SharePreview {
	project_id: string;
	project_name: string;
	owner_display: string;
	owner_handle: string;
	skill_count: number;
	vault_count: number;
}

interface InvitationItem {
	id: string;
	project_id: string;
	project_name: string;
	owner_display: string;
	owner_handle: string;
	created_at: string;
}

interface InvitationAcceptResponse {
	id: string;
	project_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

interface JoinedProject {
	project_id: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

function normalizeAgentIds(values?: string[]): string[] {
	const out: string[] = [];
	for (const raw of values ?? []) {
		for (const piece of raw.split(",")) {
			const trimmed = piece.trim();
			if (trimmed.length > 0) out.push(trimmed);
		}
	}
	return [...new Set(out)];
}

async function buildAcceptRequestBody(opts: AcceptOpts): Promise<Record<string, unknown>> {
	const reqBody: Record<string, unknown> = {};
	const agentIds = normalizeAgentIds(opts.agent);
	const bindAs = normalizeAcceptBindAs(opts);
	if (agentIds.length === 0) {
		if (bindAs !== "context") {
			throw new Error("`--use-as home` requires at least one `--agent`.");
		}
		return reqBody;
	}
	if (bindAs !== "context" && bindAs !== "primary") {
		throw new Error("`--use-as` must be either `attached` or `home`.");
	}
	reqBody.agent_ids = agentIds;
	reqBody.bind_as = bindAs;
	return reqBody;
}

function normalizeAcceptBindAs(opts: AcceptOpts): "context" | "primary" {
	if (opts.useAs) {
		const useAs = opts.useAs.toLowerCase();
		if (useAs === "attached") return "context";
		if (useAs === "home") return "primary";
		throw new Error("`--use-as` must be either `attached` or `home`.");
	}

	if (opts.bindAs) {
		const bindAs = opts.bindAs.toLowerCase();
		if (bindAs === "context" || bindAs === "primary") return bindAs;
		throw new Error("`--bind-as` must be either `context` or `primary`.");
	}

	return "context";
}

// ────────────────────────────────────────────────────────────────
// inbox (list)
// ────────────────────────────────────────────────────────────────

export async function inboxListCommand(opts: { json?: boolean }): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();

	// Anonymous mode: server invitations require auth, but locally
	// redeemed share-tokens live in ~/.clawdi/share-tokens.json.
	if (!auth?.apiKey) {
		const tokens = listTokens().filter((t) => !t.upgraded_at);
		if (opts.json) {
			// Redact the raw token because it is a bearer credential.
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
				`  ${chalk.bold(t.project_name)}  ${chalk.gray(`— from ${t.owner_display} (@${t.owner_handle})`)}`,
			);
			console.log(chalk.gray(`    project_id: ${t.project_id}`));
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
			`  ${chalk.bold(inv.project_name)}  ${chalk.gray(`(${inv.id.slice(0, 8)}…)`)}` +
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
		await acceptAnonymousUrl(apiUrl, normalized, opts);
		return;
	}

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

export function inboxForgetCommand(projectIdOrAlias: string): void {
	const token = findToken(projectIdOrAlias);
	if (!token) {
		console.error(chalk.red(`No local share-token entry found for '${projectIdOrAlias}'.`));
		console.error(
			chalk.gray("Run `clawdi inbox` (signed-out) to list local share-tokens on this device."),
		);
		process.exitCode = 1;
		return;
	}

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
				// Best effort
			}
		}
	}
	removeToken(token.project_id);

	console.log(`${chalk.green("✓")} Forgot local share for "${chalk.bold(token.project_name)}".`);
	if (removed > 0) {
		console.log(chalk.gray(`  Removed ${removed} local skill folder${removed === 1 ? "" : "s"}.`));
	}
	console.log(
		chalk.gray(
			"  This is a LOCAL operation only. Server-side membership (if any) " +
				"is unchanged — `clawdi project leave <project>` drops that.",
		),
	);
}

// ────────────────────────────────────────────────────────────────
// Internal: accept paths
// ────────────────────────────────────────────────────────────────

async function acceptAnonymousUrl(
	apiUrl: string,
	urlOrToken: string,
	opts: AcceptOpts,
): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);

	const existing = listTokens().find((t) => t.token === token);
	if (existing) {
		if (opts.json) {
			const { token: _raw, ...safe } = existing;
			console.log(JSON.stringify({ status: "already_redeemed", local_share_token: safe }, null, 2));
			return;
		}
		console.log(
			chalk.gray(
				`Already accepted: ${existing.project_name} (@${existing.owner_handle}). ` +
					`Run \`clawdi auth login\` to convert to permanent membership.`,
			),
		);
		return;
	}

	const r = await fetch(`${apiUrl}/api/share/${token}/redeem`, {
		method: "POST",
		headers: { "Idempotency-Key": redeemIdempotencyKey(token) },
	});
	if (r.status === 404) {
		throw new Error("Share link not found. Ask the owner for a fresh one.");
	}
	if (r.status === 410) {
		throw new Error("Share link has been revoked or expired.");
	}
	if (!r.ok) throw new Error(`Redeem failed: HTTP ${r.status}`);
	const body = (await r.json()) as SharePreview;

	const record: ShareToken = {
		project_id: body.project_id,
		project_name: body.project_name,
		owner_display: body.owner_display,
		owner_handle: body.owner_handle,
		token,
		redeemed_at: new Date().toISOString(),
	};
	addToken(record);
	if (opts.json) {
		console.log(JSON.stringify({ status: "redeemed", share: body }, null, 2));
		return;
	}
	console.log(
		chalk.green("✓") +
			` Accepted "${chalk.bold(body.project_name)}" from ${body.owner_display} (@${body.owner_handle}).`,
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
				"Run `clawdi auth login` to convert to a permanent project membership.",
		),
	);
}

async function acceptedProjectAlias(
	apiUrl: string,
	bearer: string,
	body: JoinedProject,
): Promise<string> {
	const projects = await listProjects(apiUrl, bearer).catch(() => []);
	const project = projects.find((item) => item.id === body.project_id);
	if (project) {
		if (project.is_owner === false && project.owner_handle) {
			return `@${project.owner_handle}/${project.slug}`;
		}
		return project.slug;
	}
	return `@${body.resolved_owner_handle}/${body.project_id}`;
}

function renderJoinedSuccess(body: JoinedProject, opts: AcceptOpts, projectAlias: string): void {
	console.log(`${chalk.green("✓")} Accepted project access for ${projectAlias}.`);
	console.log(chalk.gray("  Role: viewer (read-only)."));
	const bound = body.bound_agent_ids ?? [];
	if (bound.length > 0) {
		const bindAs = normalizeAcceptBindAs(opts);
		const useLabel = bindAs === "primary" ? "Home Project" : "attached Project";
		console.log(
			chalk.gray(
				`  Attached to ${bound.length} agent${bound.length === 1 ? "" : "s"} as ${useLabel}.`,
			),
		);
	} else {
		console.log(
			chalk.gray(
				`  Use with agent: clawdi agent projects add-context <agent-id> --project ${projectAlias}`,
			),
		);
	}
}

async function eagerPullAndReport(
	apiUrl: string,
	bearer: string,
	projectId: string,
	ownerHandle: string,
	verboseError: boolean,
	report = true,
): Promise<number> {
	const written = await pullSharedSkills(apiUrl, bearer, projectId, ownerHandle).catch((e) => {
		if (verboseError && report) {
			console.log(
				chalk.yellow(
					`  (Couldn't pull shared skills yet: ${e instanceof Error ? e.message : String(e)}. ` +
						"Run `clawdi pull` later to retry.)",
				),
			);
		}
		return 0;
	});
	if (written > 0 && report) {
		console.log(
			chalk.gray(`  Pulled ${written} skill${written === 1 ? "" : "s"} into your local agents.`),
		);
	}
	return written;
}

async function acceptUrl(
	apiUrl: string,
	bearer: string,
	urlOrToken: string,
	opts: AcceptOpts,
): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);
	const reqBody = await buildAcceptRequestBody(opts);

	const r = await fetch(`${apiUrl}/api/share/${token}/upgrade`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
	});

	if (r.status === 409) {
		const detail = (await r.json().catch(() => ({})))?.detail ?? {};
		if (detail.error === "already_owner") {
			if (opts.json) {
				console.log(JSON.stringify({ status: "already_owner" }, null, 2));
				return;
			}
			console.log(chalk.yellow("This is your own project — nothing to accept."));
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(detail), hint: "" });
	}
	if (r.status === 404) throw new Error("Share link not found.");
	if (r.status === 410) throw new Error("Share link revoked or expired.");
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = (await r.json()) as ShareUpgradeResponse;
	const pulled = await eagerPullAndReport(
		apiUrl,
		bearer,
		body.project_id,
		body.resolved_owner_handle,
		true,
		!opts.json,
	);
	if (opts.json) {
		console.log(JSON.stringify({ status: "joined", pulled_skills: pulled, ...body }, null, 2));
		return;
	}
	const alias = await acceptedProjectAlias(apiUrl, bearer, body);
	renderJoinedSuccess(body, opts, alias);
}

async function acceptInvitation(
	apiUrl: string,
	bearer: string,
	invitationId: string,
	opts: AcceptOpts,
): Promise<void> {
	const reqBody = await buildAcceptRequestBody(opts);

	const r = await fetch(`${apiUrl}/api/me/invitations/${invitationId}/accept`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
		body: JSON.stringify(reqBody),
	});

	if (r.status === 410) {
		console.error(chalk.red("This invitation was revoked or already accepted."));
		process.exitCode = 1;
		return;
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = (await r.json()) as InvitationAcceptResponse;
	const pulled = await eagerPullAndReport(
		apiUrl,
		bearer,
		body.project_id,
		body.resolved_owner_handle,
		false,
		!opts.json,
	);
	if (opts.json) {
		console.log(JSON.stringify({ status: "joined", pulled_skills: pulled, ...body }, null, 2));
		return;
	}
	const alias = await acceptedProjectAlias(apiUrl, bearer, body);
	renderJoinedSuccess(body, opts, alias);
}
