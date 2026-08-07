/**
 * `clawdi inbox ...` — incoming project shares awaiting my action.
 *
 *   inbox                          # list pending invitations and local shares
 *   inbox accept <id-or-url> ...   # accept invitation OR redeem URL
 *   inbox join <project-id> ...    # join one staged local share
 *   inbox decline <id>             # decline pending invitation
 *   inbox forget <project-id>      # local-only: drop redeemed token
 *
 * User-facing flow: docs/scenarios/project-sharing-agent-bindings-demo.md
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

import type { components } from "@clawdi/shared/api";
import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { ApiError, readJson } from "../lib/api-client";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import { getClawdiAccessToken } from "../lib/clerk-oauth";
import { getAuth, getConfig } from "../lib/config";
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
		throw new Error("Not a valid share link or 43-character token.");
	}
	const match = url.pathname.match(/\/share\/([A-Za-z0-9_-]+)\/?$/);
	if (!match) {
		throw new Error("URL is not a Clawdi share link.");
	}
	return match[1];
}

function redeemIdempotencyKey(token: string): string {
	return `redeem-${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

function upgradeIdempotencyKey(token: string): string {
	return `upgrade-${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

interface AcceptOpts {
	agent?: string[];
	useAs?: string;
	invite?: string;
	url?: string;
	json?: boolean;
}

type JoinOpts = Pick<AcceptOpts, "agent" | "useAs" | "json">;

type ShareUpgradeResponse = components["schemas"]["ShareUpgradeResponse"];
type SharePreview = components["schemas"]["ShareRedeemResponse"];
type InvitationItem = components["schemas"]["InvitationResponse"];
type InvitationAcceptResponse = components["schemas"]["InvitationAcceptResponse"];
type JoinedProject = Pick<
	ShareUpgradeResponse,
	"project_id" | "resolved_owner_handle" | "bound_agent_ids"
>;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseShareUpgradeResponse(value: unknown): ShareUpgradeResponse | null {
	if (typeof value !== "object" || value === null) return null;
	const body = value as Record<string, unknown>;
	if (
		!isNonEmptyString(body.membership_id) ||
		!isNonEmptyString(body.project_id) ||
		!isNonEmptyString(body.role) ||
		!isNonEmptyString(body.joined_via) ||
		!isNonEmptyString(body.joined_at) ||
		!Number.isFinite(Date.parse(body.joined_at)) ||
		!isNonEmptyString(body.resolved_owner_handle) ||
		!Array.isArray(body.bound_agent_ids) ||
		!body.bound_agent_ids.every(isNonEmptyString)
	) {
		return null;
	}
	return {
		membership_id: body.membership_id,
		project_id: body.project_id,
		role: body.role,
		joined_via: body.joined_via,
		joined_at: body.joined_at,
		resolved_owner_handle: body.resolved_owner_handle,
		bound_agent_ids: body.bound_agent_ids,
	};
}

function localPendingShares(): ShareToken[] {
	return listTokens().filter((token) => !token.upgraded_at);
}

function localLegacyShares(): ShareToken[] {
	return listTokens().filter((token) => token.upgraded_at);
}

function safeLocalShare(token: ShareToken): Omit<ShareToken, "token"> & { join_command: string } {
	const { token: _rawToken, ...safe } = token;
	return { ...safe, join_command: `clawdi inbox join ${token.project_id}` };
}

function safeLegacyLocalShare(
	token: ShareToken,
): Omit<ShareToken, "token"> & { cleanup_command: string } {
	const { token: _rawToken, ...safe } = token;
	return { ...safe, cleanup_command: `clawdi inbox forget ${token.project_id}` };
}

function renderLocalPendingShares(shares: ShareToken[], signedIn: boolean): void {
	console.log(chalk.bold(`Local pending project shares (${shares.length}):`));
	for (const share of shares) {
		console.log(
			`  ${chalk.bold(share.project_name)}  ${chalk.gray(`— from ${share.owner_display} (@${share.owner_handle})`)}`,
		);
		console.log(chalk.gray(`    project_id: ${share.project_id}`));
		console.log(
			chalk.gray(
				`    ${signedIn ? "Join" : "Join after sign-in"}: clawdi inbox join ${share.project_id}`,
			),
		);
	}
}

function renderLegacyLocalShares(shares: ShareToken[]): void {
	console.log(chalk.bold(`Old local share records — cleanup only (${shares.length}):`));
	for (const share of shares) {
		console.log(`  ${chalk.bold(share.project_name)}  ${chalk.gray(`(@${share.owner_handle})`)}`);
		console.log(chalk.gray(`    project_id: ${share.project_id}`));
		console.log(chalk.gray(`    Cleanup: clawdi inbox forget ${share.project_id}`));
	}
	console.log(chalk.gray("No automatic action occurs for these records."));
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
	if (agentIds.length === 0) {
		if (opts.useAs) {
			throw new Error("Pass --agent before choosing how to link the Project.");
		}
		return reqBody;
	}
	const useAs = normalizeAcceptMode(opts);
	reqBody.agent_ids = agentIds;
	reqBody.use_as = useAs;
	return reqBody;
}

function normalizeAcceptMode(opts: AcceptOpts): "attached" {
	if (opts.useAs) {
		const useAs = opts.useAs.toLowerCase();
		if (useAs === "attached") return "attached";
		if (useAs === "home") {
			throw new Error("`--use-as home` is no longer supported. Workspace is fixed.");
		}
		throw new Error("`--use-as` must be `attached`.");
	}

	return "attached";
}

// ────────────────────────────────────────────────────────────────
// inbox (list)
// ────────────────────────────────────────────────────────────────

export async function inboxListCommand(opts: { json?: boolean }): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	const localShares = localPendingShares();
	const legacyLocalShares = localLegacyShares();

	// Server invitations require auth. Local share records are always listed,
	// but never joined or cleaned up as a side effect of opening the inbox.
	if (!auth?.apiKey) {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						invitations: [],
						local_share_tokens: localShares.map(safeLocalShare),
						legacy_local_share_records: legacyLocalShares.map(safeLegacyLocalShare),
						next_command: "clawdi auth login",
					},
					null,
					2,
				),
			);
			return;
		}
		if (localShares.length === 0 && legacyLocalShares.length === 0) {
			console.log("Nothing in your inbox.");
			console.log(chalk.gray("Sign in with `clawdi auth login` to see server invitations."));
			return;
		}
		if (localShares.length > 0) renderLocalPendingShares(localShares, false);
		if (localShares.length > 0 && legacyLocalShares.length > 0) console.log();
		if (legacyLocalShares.length > 0) renderLegacyLocalShares(legacyLocalShares);
		console.log();
		if (localShares.length > 0) {
			console.log(chalk.gray("First sign in: ") + chalk.cyan("clawdi auth login"));
			console.log(chalk.gray("Then run the exact join command shown for the project you want."));
		} else {
			console.log(chalk.gray("Sign in: ") + chalk.cyan("clawdi auth login"));
			console.log(
				chalk.gray("Then inspect access: ") + chalk.cyan("clawdi project list --shared-with-me"),
			);
		}
		return;
	}
	const accessToken = await getClawdiAccessToken(apiUrl);

	const r = await fetch(`${apiUrl}/v1/me/invitations`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	const items = await readJson<InvitationItem[]>(r, "/v1/me/invitations");

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					invitations: items,
					local_share_tokens: localShares.map(safeLocalShare),
					legacy_local_share_records: legacyLocalShares.map(safeLegacyLocalShare),
				},
				null,
				2,
			),
		);
		return;
	}

	if (items.length === 0 && localShares.length === 0 && legacyLocalShares.length === 0) {
		console.log("Nothing in your inbox.");
		return;
	}
	if (items.length > 0) {
		console.log(chalk.bold(`Pending invitations (${items.length}):`));
		for (const inv of items) {
			console.log(
				`  ${chalk.bold(inv.project_name)}` +
					`\n    from ${inv.owner_display} ${chalk.gray(`@${inv.owner_handle}`)}` +
					chalk.gray(` · ${new Date(inv.created_at).toLocaleDateString()}`),
			);
			console.log(chalk.gray(`    Accept: clawdi inbox accept ${inv.id}`));
		}
	}
	if (items.length > 0 && (localShares.length > 0 || legacyLocalShares.length > 0)) console.log();
	if (localShares.length > 0) {
		renderLocalPendingShares(localShares, true);
	}
	if (localShares.length > 0 && legacyLocalShares.length > 0) console.log();
	if (legacyLocalShares.length > 0) renderLegacyLocalShares(legacyLocalShares);
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
		if (normalizeAgentIds(opts.agent).length > 0 || opts.useAs) {
			console.error(
				chalk.red(
					"Sign in before linking an accepted Project to an Agent. " +
						"Run `clawdi auth login`, then re-run with --agent.",
				),
			);
			process.exitCode = 1;
			return;
		}
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
	const accessToken = await getClawdiAccessToken(apiUrl);

	if (opts.invite) {
		await acceptInvitation(apiUrl, accessToken, opts.invite, opts);
		return;
	}
	if (opts.url) {
		await acceptUrl(apiUrl, accessToken, opts.url, opts);
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
		await acceptInvitation(apiUrl, accessToken, normalized, opts);
	} else if (shape === "url" || shape === "raw_token") {
		await acceptUrl(apiUrl, accessToken, normalized, opts);
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
// inbox join — explicitly upgrade one staged local share
// ────────────────────────────────────────────────────────────────

export async function inboxJoinCommand(projectId: string, opts: JoinOpts): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(
			chalk.red("Not signed in. Run `clawdi auth login`, then run this join command again."),
		);
		process.exitCode = 1;
		return;
	}

	const ticket = localPendingShares().find((entry) => entry.project_id === projectId);
	if (!ticket) {
		console.error(chalk.red(`No pending local share found for project '${projectId}'.`));
		console.error(chalk.gray("Run `clawdi inbox` to see exact pending project ids."));
		process.exitCode = 1;
		return;
	}

	const apiOrigin = normalizeCloudApiBaseUrl(apiUrl);
	if (ticket.api_origin && ticket.api_origin !== apiOrigin) {
		console.error(
			chalk.red(
				`This local share belongs to ${ticket.api_origin}, but the current API is ${apiOrigin}.`,
			),
		);
		console.error(
			chalk.gray("Switch to the matching API and retry. The local share was left unchanged."),
		);
		process.exitCode = 1;
		return;
	}

	const reqBody = await buildAcceptRequestBody(opts);
	let bearer: string;
	try {
		bearer = await getClawdiAccessToken(apiOrigin);
	} catch {
		throw new Error(
			"Could not authenticate to join this project. The local share was kept; sign in and retry.",
		);
	}

	let response: Response;
	try {
		response = await fetch(`${apiOrigin}/v1/share/${encodeURIComponent(ticket.token)}/upgrade`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${bearer}`,
				"Content-Type": "application/json",
				"Idempotency-Key": upgradeIdempotencyKey(ticket.token),
			},
			body: JSON.stringify(reqBody),
		});
	} catch {
		throw new Error(
			"Could not reach Clawdi to join this project. The local share was kept; check your connection and retry.",
		);
	}

	if (response.status === 404 || response.status === 410) {
		await removeToken(ticket.project_id, ticket.token);
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						status: "unavailable",
						project_id: ticket.project_id,
						local_ticket_removed: true,
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(
			`${chalk.yellow("!")} This share is unavailable; removed its local ticket from this device.`,
		);
		return;
	}

	if (response.status === 409) {
		const conflict = (await response.json().catch(() => null)) as {
			detail?: { error?: unknown };
		} | null;
		if (conflict?.detail?.error === "already_owner") {
			await removeToken(ticket.project_id, ticket.token);
			if (opts.json) {
				console.log(
					JSON.stringify(
						{
							status: "already_owner",
							project_id: ticket.project_id,
							local_ticket_removed: true,
						},
						null,
						2,
					),
				);
				return;
			}
			console.log(
				`${chalk.green("✓")} Project access already exists; cleared the local share ticket.`,
			);
			return;
		}
		throw new Error(
			"Could not join this project because its access state changed. The local share was kept; refresh your inbox and retry.",
		);
	}

	if (!response.ok) {
		if (response.status >= 500) {
			throw new Error(
				"Project joining is temporarily unavailable. The local share was kept; try again later.",
			);
		}
		throw new Error(
			"Clawdi could not join this project. The local share was kept; check your access and retry.",
		);
	}

	let body: ShareUpgradeResponse | null = null;
	try {
		body = parseShareUpgradeResponse(await readJson<unknown>(response, "join shared project"));
	} catch {
		// The server may already have created membership, but without a canonical
		// response the CLI cannot safely decide which exact local ticket to remove.
	}
	if (!body || body.project_id !== ticket.project_id) {
		throw new Error(
			"Clawdi returned an invalid project join response. The local share was kept; retry or contact support.",
		);
	}

	await removeToken(ticket.project_id, ticket.token);
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: "joined",
					...body,
					local_ticket_removed: true,
					next_command: `clawdi pull --project ${body.project_id}`,
				},
				null,
				2,
			),
		);
		return;
	}
	renderJoinedSuccess(body, body.project_id, true);
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
	const accessToken = await getClawdiAccessToken(apiUrl);
	const r = await fetch(`${apiUrl}/v1/me/invitations/${invitationId}/decline`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	console.log(`${chalk.green("✓")} Invitation declined.`);
}

// ────────────────────────────────────────────────────────────────
// inbox forget — local-only cleanup
// ────────────────────────────────────────────────────────────────

export async function inboxForgetCommand(projectId: string): Promise<void> {
	const token = findToken(projectId);
	if (!token) {
		console.error(chalk.red(`No local share record found for project '${projectId}'.`));
		console.error(chalk.gray("Run `clawdi inbox` to list local share records on this device."));
		process.exitCode = 1;
		return;
	}

	const skillKeys = token.last_seen_skill_keys ?? [];
	const sameOwnerTokens = listTokens().filter(
		(other) => other.project_id !== token.project_id && other.owner_handle === token.owner_handle,
	);
	const preserveAllForOwner = sameOwnerTokens.some((other) => !other.last_seen_skill_keys);
	const preservedKeys = new Set(
		sameOwnerTokens.flatMap((other) => other.last_seen_skill_keys ?? []),
	);
	let removed = 0;
	for (const entry of allAdapterEntries()) {
		const adapter = entry.create();
		for (const key of skillKeys) {
			if (preserveAllForOwner || preservedKeys.has(key)) continue;
			const path = adapter.getSharedSkillPath(key, token.owner_handle);
			try {
				rmSync(path, { recursive: true, force: true });
				removed++;
			} catch {
				// Best effort
			}
		}
	}
	const tokenRemoved = await removeToken(token.project_id, token.token);
	if (!tokenRemoved) {
		throw new Error("local share changed while it was being forgotten; retry the command");
	}

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
	const apiOrigin = normalizeCloudApiBaseUrl(apiUrl);

	const existing = listTokens().find((t) => t.token === token);
	if (existing?.upgraded_at) {
		const cleanupCommand = `clawdi inbox forget ${existing.project_id}`;
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						status: "legacy_local_share_record",
						membership_changed: false,
						action:
							"This share was handled by an older CLI. Review current access, then explicitly remove the local record if it is no longer needed.",
						local_share_record: safeLegacyLocalShare(existing),
						next_commands: [
							"clawdi auth login",
							"clawdi project list --shared-with-me",
							cleanupCommand,
						],
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(
			chalk.gray(
				`This share for ${existing.project_name} (@${existing.owner_handle}) was handled by an older Clawdi CLI.`,
			),
		);
		console.log(chalk.gray("No account or project membership was changed now."));
		console.log(`Next: ${chalk.cyan("clawdi auth login")}`);
		console.log(`Then: ${chalk.cyan("clawdi project list --shared-with-me")}`);
		console.log(`Cleanup: ${chalk.cyan(cleanupCommand)}`);
		return;
	}
	if (existing) {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						status: "already_redeemed",
						membership_changed: false,
						local_share_token: safeLocalShare(existing),
						next_commands: ["clawdi auth login", `clawdi inbox join ${existing.project_id}`],
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(
			chalk.gray(`Already staged: ${existing.project_name} (@${existing.owner_handle}).`),
		);
		console.log(chalk.gray("No account or project membership was changed."));
		console.log(`Next: ${chalk.cyan("clawdi auth login")}`);
		console.log(`Then: ${chalk.cyan(`clawdi inbox join ${existing.project_id}`)}`);
		return;
	}

	const r = await fetch(`${apiOrigin}/v1/share/${token}/redeem`, {
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
	const body = await readJson<SharePreview>(r, "redeem share link");

	const record: ShareToken = {
		project_id: body.project_id,
		project_name: body.project_name,
		owner_display: body.owner_display,
		owner_handle: body.owner_handle,
		token,
		redeemed_at: new Date().toISOString(),
		api_origin: apiOrigin,
	};
	await addToken(record);
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: "redeemed",
					membership_changed: false,
					share: body,
					next_commands: ["clawdi auth login", `clawdi inbox join ${body.project_id}`],
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		chalk.green("✓") +
			` Staged "${chalk.bold(body.project_name)}" from ${body.owner_display} (@${body.owner_handle}) on this device.`,
	);
	console.log(
		chalk.gray(
			`  ${body.skill_count} skill${body.skill_count === 1 ? "" : "s"}, ` +
				`${body.vault_count} vault${body.vault_count === 1 ? "" : "s"} (sign in to unlock names).`,
		),
	);
	console.log();
	console.log(chalk.gray("No account or project membership was changed."));
	console.log(`Next: ${chalk.cyan("clawdi auth login")}`);
	console.log(`Then: ${chalk.cyan(`clawdi inbox join ${body.project_id}`)}`);
}

function renderJoinedSuccess(
	body: JoinedProject,
	projectRef: string,
	localTicketRemoved: boolean,
): void {
	console.log(`${chalk.green("✓")} Joined project ${projectRef}.`);
	if (localTicketRemoved) console.log("Local share ticket removed from this device.");
	console.log(chalk.gray("  Role: viewer (read access)."));
	const bound = body.bound_agent_ids ?? [];
	if (bound.length > 0) {
		console.log(chalk.gray(`  Linked to ${bound.length} Agent${bound.length === 1 ? "" : "s"}.`));
	} else {
		console.log(
			chalk.gray(`  Link to Agent: clawdi agent projects link <agent-id> --project ${projectRef}`),
		);
	}
	console.log(chalk.gray(`  Next (optional): clawdi pull --project ${projectRef}`));
}

async function acceptUrl(
	apiUrl: string,
	bearer: string,
	urlOrToken: string,
	opts: AcceptOpts,
): Promise<void> {
	const token = extractTokenFromUrl(urlOrToken);
	const localTicket = localPendingShares().find((entry) => entry.token === token);
	const apiOrigin = normalizeCloudApiBaseUrl(apiUrl);
	if (localTicket?.api_origin && localTicket.api_origin !== apiOrigin) {
		throw new Error(
			`This local share belongs to ${localTicket.api_origin}, but the current API is ${apiOrigin}. Switch to the matching API and retry; the local share was left unchanged.`,
		);
	}
	const reqBody = await buildAcceptRequestBody(opts);

	const r = await fetch(`${apiOrigin}/v1/share/${token}/upgrade`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearer}`,
			"Content-Type": "application/json",
			"Idempotency-Key": upgradeIdempotencyKey(token),
		},
		body: JSON.stringify(reqBody),
	});

	if (r.status === 409) {
		const detail = (await r.json().catch(() => ({})))?.detail ?? {};
		if (detail.error === "already_owner") {
			if (localTicket) await removeToken(localTicket.project_id, localTicket.token);
			if (opts.json) {
				console.log(
					JSON.stringify(
						{
							status: "already_owner",
							local_ticket_removed: Boolean(localTicket),
						},
						null,
						2,
					),
				);
				return;
			}
			console.log(
				chalk.yellow(
					localTicket
						? "Project access already exists; cleared the local share ticket."
						: "This is your own project — nothing to accept.",
				),
			);
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(detail), hint: "" });
	}
	if (r.status === 404 || r.status === 410) {
		if (localTicket) await removeToken(localTicket.project_id, localTicket.token);
		throw new Error(
			r.status === 404
				? "Share link not found. Any matching local ticket was removed."
				: "Share link revoked or expired. Any matching local ticket was removed.",
		);
	}
	if (!r.ok) throw new ApiError({ status: r.status, body: await r.text(), hint: "" });

	const body = parseShareUpgradeResponse(await readJson<unknown>(r, "upgrade share link"));
	if (!body || (localTicket && localTicket.project_id !== body.project_id)) {
		throw new Error("Clawdi returned an invalid project join response.");
	}
	if (localTicket) await removeToken(localTicket.project_id, localTicket.token);
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: "joined",
					...body,
					local_ticket_removed: Boolean(localTicket),
					next_command: `clawdi pull --project ${body.project_id}`,
				},
				null,
				2,
			),
		);
		return;
	}
	renderJoinedSuccess(body, body.project_id, Boolean(localTicket));
}

async function acceptInvitation(
	apiUrl: string,
	bearer: string,
	invitationId: string,
	opts: AcceptOpts,
): Promise<void> {
	const reqBody = await buildAcceptRequestBody(opts);

	const r = await fetch(`${apiUrl}/v1/me/invitations/${invitationId}/accept`, {
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

	const body = await readJson<InvitationAcceptResponse>(r, "accept project invitation");
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					status: "joined",
					...body,
					next_command: `clawdi pull --project ${body.project_id}`,
				},
				null,
				2,
			),
		);
		return;
	}
	renderJoinedSuccess(body, body.project_id, false);
}
