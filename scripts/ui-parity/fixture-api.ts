#!/usr/bin/env bun
/**
 * Deterministic fixture server that impersonates the Clawdi cloud API so the
 * web dashboard and the mobile app can be rendered side by side on identical
 * data. Fixtures are typed against the generated OpenAPI contract, so schema
 * drift fails `tsc` instead of silently rendering stale shapes.
 *
 * Usage: bun scripts/ui-parity/fixture-api.ts [--port 8787] [--host 0.0.0.0]
 */
import type { components, paths } from "../../packages/shared/src/api/api.generated";
import type {
	components as DeployComponents,
	paths as DeployPaths,
} from "../../packages/shared/src/api/deploy.generated";

type Schemas = components["schemas"];
type DeploySchemas = DeployComponents["schemas"];
type DeployGetPath = {
	[P in keyof DeployPaths]: DeployPaths[P] extends { get: { responses: { 200: unknown } } }
		? P
		: never;
}[keyof DeployPaths];
type DeployGetOk<P extends DeployGetPath> = DeployPaths[P] extends {
	get: { responses: { 200: infer R } };
}
	? JsonBody<R>
	: never;
type JsonBody<R> = R extends { content: { "application/json": infer B } } ? B : never;
type GetPath = {
	[P in keyof paths]: paths[P] extends { get: { responses: { 200: unknown } } } ? P : never;
}[keyof paths];
type PostOk<P extends keyof paths> = paths[P] extends { post: { responses: { 200: infer R } } }
	? JsonBody<R>
	: never;
type GetOk<P extends GetPath> = paths[P] extends { get: { responses: { 200: infer R } } }
	? JsonBody<R>
	: never;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readFlag(name: string, fallback: string): string {
	const args = process.argv.slice(2);
	const index = args.indexOf(`--${name}`);
	if (index >= 0 && args[index + 1]) return args[index + 1] ?? fallback;
	const inline = args.find((arg) => arg.startsWith(`--${name}=`));
	return inline ? inline.slice(name.length + 3) : fallback;
}

const port = Number(readFlag("port", "8787"));
const hostname = readFlag("host", "0.0.0.0");
const shareOrigin = new URL(readFlag("share-origin", "https://fixture.clawdi.test")).origin;
if (!shareOrigin.startsWith("https://")) {
	console.error("Invalid --share-origin; public fixture links require HTTPS");
	process.exit(1);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	console.error(`Invalid --port value: ${readFlag("port", "")}`);
	process.exit(1);
}

for (const [name, allowed, fallback] of [
	["memory-provider", ["builtin", "mem0"], "builtin"],
	["mem0-configured", ["true", "false"], "false"],
	[
		"whatsapp-state",
		["generating", "ready", "scanned", "connected", "expired", "canceled", "error"],
		"ready",
	],
	["account-state", ["active", "suspended"], "active"],
	["reusable-subscriptions", ["none", "mixed"], "none"],
	["included-basic", ["available", "none"], "available"],
	["subscription-actions", ["false", "true"], "false"],
] satisfies [string, string[], string][]) {
	if (!allowed.includes(readFlag(name, fallback))) {
		console.error(`Invalid --${name}; expected ${allowed.join("|")}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Time + deterministic randomness
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * Fixtures are built relative to boot time; `json()` shifts every ISO
 * timestamp by the elapsed time so a long-running server still looks live.
 */
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const dateKey = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 10);

function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const USER_ID = "7d3c1a52-0b8e-4f61-9a2d-5c4e8f1b2a90";

const currentUser = {
	id: USER_ID,
	email: "avery@clawdi.dev",
	name: "Avery Chen",
	auth_type: "clerk",
} satisfies GetOk<"/v1/auth/me">;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT = {
	personal: "a0f1c2d3-0001-4a00-8000-000000000001",
	webapp: "a0f1c2d3-0002-4a00-8000-000000000002",
	research: "a0f1c2d3-0003-4a00-8000-000000000003",
	infra: "a0f1c2d3-0004-4a00-8000-000000000004",
	mbp: "a0f1c2d3-0005-4a00-8000-000000000005",
};

const projects = [
	{
		id: PROJECT.personal,
		name: "Personal",
		slug: "personal",
		kind: "personal",
		description: "Account-wide context shared with every agent.",
		origin_environment_id: null,
		archived_at: null,
		created_at: ago(120 * DAY),
		is_owner: true,
		owner_display: "Avery Chen",
		owner_handle: "avery",
		skill_count: 3,
		vault_count: 1,
		agent_count: 4,
		member_count: 1,
	},
	{
		id: PROJECT.webapp,
		name: "Acme Web App",
		slug: "acme-web-app",
		kind: "workspace",
		description: "Customer-facing dashboard, marketing site and design system.",
		origin_environment_id: null,
		archived_at: null,
		created_at: ago(64 * DAY),
		is_owner: true,
		owner_display: "Avery Chen",
		owner_handle: "avery",
		skill_count: 4,
		vault_count: 2,
		agent_count: 3,
		member_count: 3,
	},
	{
		id: PROJECT.research,
		name: "Market Research",
		slug: "market-research",
		kind: "workspace",
		description: "Competitive analysis notes and weekly digests.",
		origin_environment_id: null,
		archived_at: null,
		created_at: ago(41 * DAY),
		is_owner: false,
		owner_display: "Jordan Lee",
		owner_handle: "jordan",
		skill_count: 2,
		vault_count: 1,
		agent_count: 2,
		member_count: 4,
	},
	{
		id: PROJECT.infra,
		name: "Infra Runbooks",
		slug: "infra-runbooks",
		kind: "workspace",
		description: "On-call procedures, deploy scripts and incident templates.",
		origin_environment_id: null,
		archived_at: null,
		created_at: ago(23 * DAY),
		is_owner: true,
		owner_display: "Avery Chen",
		owner_handle: "avery",
		skill_count: 2,
		vault_count: 1,
		agent_count: 2,
		member_count: 2,
	},
	{
		id: PROJECT.mbp,
		name: "MacBook Pro",
		slug: "macbook-pro",
		kind: "environment",
		description: null,
		origin_environment_id: "c1a0de00-0001-4c00-8000-000000000001",
		archived_at: null,
		created_at: ago(90 * DAY),
		is_owner: true,
		owner_display: "Avery Chen",
		owner_handle: "avery",
		skill_count: 2,
		vault_count: 0,
		agent_count: 1,
		member_count: 1,
	},
] satisfies GetOk<"/v1/projects">;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const AGENT = {
	claude: "c1a0de00-0001-4c00-8000-000000000001",
	codex: "c0de0000-0002-4c00-8000-000000000002",
	hermes: "4e2e5000-0003-4c00-8000-000000000003",
	openclaw: "0c1a3000-0004-4c00-8000-000000000004",
};

const agents = [
	{
		id: AGENT.claude,
		name: "avery-mbp-claude",
		default_name: "Claude Code",
		machine_id: "machine-mbp",
		machine_name: "Averys-MacBook-Pro.local",
		display_name: "Claude Code",
		avatar_url: null,
		sort_order: 0,
		agent_type: "claude_code",
		agent_version: "2.1.4",
		os: "darwin",
		last_seen_at: ago(20_000),
		last_sync_at: ago(30_000),
		last_sync_error: null,
		last_revision_seen: 482,
		queue_depth_high_water: 3,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: PROJECT.mbp,
		adapter_modules: ["sessions", "skills"],
	},
	{
		id: AGENT.codex,
		name: "devbox-codex",
		default_name: "Codex",
		machine_id: "machine-devbox",
		machine_name: "devbox-01",
		display_name: "Codex",
		avatar_url: null,
		sort_order: 1,
		agent_type: "codex",
		agent_version: "0.48.0",
		os: "linux",
		last_seen_at: ago(40_000),
		last_sync_at: ago(MINUTE),
		last_sync_error: null,
		last_revision_seen: 219,
		queue_depth_high_water: 1,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: PROJECT.webapp,
		adapter_modules: ["sessions", "skills"],
	},
	{
		id: AGENT.hermes,
		name: "research-hermes",
		default_name: "Hermes",
		machine_id: "machine-research",
		machine_name: "research-vm",
		display_name: "Research Hermes",
		avatar_url: null,
		sort_order: 2,
		agent_type: "hermes",
		agent_version: "0.9.2",
		os: "linux",
		last_seen_at: ago(5 * HOUR),
		last_sync_at: ago(5 * HOUR),
		last_sync_error: null,
		last_revision_seen: 97,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: PROJECT.research,
		adapter_modules: ["sessions"],
	},
	{
		id: AGENT.openclaw,
		name: "homelab-openclaw",
		default_name: "OpenClaw",
		machine_id: "machine-homelab",
		machine_name: "homelab-nuc",
		display_name: "OpenClaw",
		avatar_url: null,
		sort_order: 3,
		agent_type: "openclaw",
		agent_version: "2026.9.1",
		os: "linux",
		last_seen_at: ago(4 * DAY),
		last_sync_at: ago(4 * DAY),
		last_sync_error: "Sync paused: daemon offline",
		last_revision_seen: 33,
		queue_depth_high_water: 0,
		dropped_count: 2,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: PROJECT.infra,
		adapter_modules: ["sessions"],
	},
] satisfies GetOk<"/v1/agents">;

type Agent = (typeof agents)[number];

const projectBindingsByAgent: Record<string, GetOk<"/v1/agents/{agent_id}/project-bindings">> = {
	[AGENT.claude]: [
		binding(AGENT.claude, PROJECT.mbp, "primary", 0, true),
		binding(AGENT.claude, PROJECT.personal, "context", 1, false),
		binding(AGENT.claude, PROJECT.webapp, "context", 2, false),
	],
	[AGENT.codex]: [
		binding(AGENT.codex, PROJECT.webapp, "primary", 0, true),
		binding(AGENT.codex, PROJECT.personal, "context", 1, false),
		binding(AGENT.codex, PROJECT.infra, "context", 2, false),
	],
	[AGENT.hermes]: [
		binding(AGENT.hermes, PROJECT.research, "primary", 0, true),
		binding(AGENT.hermes, PROJECT.personal, "context", 1, false),
	],
	[AGENT.openclaw]: [
		binding(AGENT.openclaw, PROJECT.infra, "primary", 0, true),
		binding(AGENT.openclaw, PROJECT.personal, "context", 1, false),
	],
};

function binding(
	agentId: string,
	projectId: string,
	type: "primary" | "context",
	priority: number,
	write: boolean,
): Schemas["AgentProjectBindingResponse"] {
	return {
		id: `binding-${agentId.slice(0, 8)}-${projectId.slice(-4)}`,
		agent_id: agentId,
		project_id: projectId,
		binding_type: type,
		priority,
		default_write_enabled: write,
		created_at: ago(30 * DAY),
	};
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type SessionSeed = {
	agent: Agent;
	summary: string;
	model: string;
	ageMs: number;
	minutes: number;
	messages: number;
	project: string;
	tags?: string[];
	automated?: boolean;
	/** Non-default Agent profile; omitted for the default profile (`""`). */
	profile?: string;
};

const claude = agents[0];
const codex = agents[1];
const hermes = agents[2];
const openclaw = agents[3];

const sessionSeeds: SessionSeed[] = [
	{
		agent: claude,
		summary: "Refactor billing webhooks into an idempotent queue",
		model: "claude-opus-4-5",
		ageMs: 25 * MINUTE,
		minutes: 42,
		messages: 38,
		project: "~/code/acme/api",
		tags: ["billing"],
	},
	{
		agent: codex,
		summary: "Fix flaky checkout e2e test on Safari",
		model: "gpt-5-codex",
		ageMs: 2 * HOUR,
		minutes: 18,
		messages: 14,
		project: "~/code/acme/web",
		tags: ["tests"],
	},
	{
		agent: claude,
		profile: "work",
		summary: "Design system: migrate buttons to new tokens",
		model: "claude-sonnet-4-5",
		ageMs: 5 * HOUR,
		minutes: 65,
		messages: 52,
		project: "~/code/acme/web",
	},
	{
		agent: hermes,
		profile: "research",
		summary: "Weekly competitor pricing digest",
		model: "claude-sonnet-4-5",
		ageMs: 9 * HOUR,
		minutes: 12,
		messages: 9,
		project: "~/research",
		tags: ["digest"],
	},
	{
		agent: codex,
		summary: "Add pagination to the invoices API",
		model: "gpt-5-codex",
		ageMs: 1 * DAY + 3 * HOUR,
		minutes: 31,
		messages: 22,
		project: "~/code/acme/api",
	},
	{
		agent: claude,
		summary: "Investigate memory leak in the websocket gateway",
		model: "claude-opus-4-5",
		ageMs: 1 * DAY + 8 * HOUR,
		minutes: 88,
		messages: 71,
		project: "~/code/acme/gateway",
		tags: ["perf", "incident"],
	},
	{
		agent: openclaw,
		summary: "Rotate staging TLS certificates",
		model: "gpt-5",
		ageMs: 2 * DAY + 1 * HOUR,
		minutes: 9,
		messages: 7,
		project: "~/infra",
		tags: ["ops"],
	},
	{
		agent: claude,
		profile: "work",
		summary: "Write onboarding guide for new contributors",
		model: "claude-sonnet-4-5",
		ageMs: 2 * DAY + 6 * HOUR,
		minutes: 27,
		messages: 19,
		project: "~/code/acme/docs",
	},
	{
		agent: codex,
		summary: "Upgrade React Router and fix type errors",
		model: "gpt-5-codex",
		ageMs: 3 * DAY + 2 * HOUR,
		minutes: 54,
		messages: 40,
		project: "~/code/acme/web",
	},
	{
		agent: hermes,
		summary: "Summarize customer interview transcripts",
		model: "claude-sonnet-4-5",
		ageMs: 3 * DAY + 10 * HOUR,
		minutes: 21,
		messages: 16,
		project: "~/research",
	},
	{
		agent: claude,
		summary: "Plan Q4 roadmap milestones",
		model: "claude-opus-4-5",
		ageMs: 4 * DAY + 4 * HOUR,
		minutes: 35,
		messages: 24,
		project: "~/notes",
	},
	{
		agent: claude,
		profile: "personal",
		summary: "Add dark mode to the marketing site",
		model: "claude-sonnet-4-5",
		ageMs: 5 * DAY + 1 * HOUR,
		minutes: 47,
		messages: 33,
		project: "~/code/acme/site",
	},
	{
		agent: codex,
		summary: "Speed up CI by caching the Bun install",
		model: "gpt-5-codex",
		ageMs: 6 * DAY + 2 * HOUR,
		minutes: 16,
		messages: 11,
		project: "~/code/acme/web",
		tags: ["ci"],
	},
	{
		agent: openclaw,
		summary: "Nightly backup verification",
		model: "gpt-5",
		ageMs: 6 * DAY + 20 * HOUR,
		minutes: 4,
		messages: 5,
		project: "~/infra",
		automated: true,
	},
	{
		agent: claude,
		summary: "Migrate cron jobs to the new scheduler",
		model: "claude-opus-4-5",
		ageMs: 8 * DAY,
		minutes: 59,
		messages: 45,
		project: "~/code/acme/api",
	},
	{
		agent: hermes,
		profile: "research",
		summary: "Draft blog post on agent memory",
		model: "claude-sonnet-4-5",
		ageMs: 9 * DAY + 5 * HOUR,
		minutes: 38,
		messages: 26,
		project: "~/research",
	},
	{
		agent: codex,
		summary: "Implement CSV export for reports",
		model: "gpt-5-codex",
		ageMs: 11 * DAY,
		minutes: 29,
		messages: 20,
		project: "~/code/acme/api",
	},
	{
		agent: claude,
		summary: "Review pull request #482: search filters",
		model: "claude-sonnet-4-5",
		ageMs: 13 * DAY + 3 * HOUR,
		minutes: 14,
		messages: 10,
		project: "~/code/acme/web",
		tags: ["review"],
	},
	{
		agent: claude,
		summary: "Debug Stripe tax calculation mismatch",
		model: "claude-opus-4-5",
		ageMs: 16 * DAY,
		minutes: 73,
		messages: 58,
		project: "~/code/acme/api",
		tags: ["billing"],
	},
	{
		agent: codex,
		summary: "Set up Playwright visual regression tests",
		model: "gpt-5-codex",
		ageMs: 19 * DAY,
		minutes: 44,
		messages: 31,
		project: "~/code/acme/web",
		tags: ["tests"],
	},
	{
		agent: hermes,
		summary: "Collect pricing pages for 12 competitors",
		model: "claude-sonnet-4-5",
		ageMs: 22 * DAY,
		minutes: 25,
		messages: 18,
		project: "~/research",
	},
	{
		agent: claude,
		summary: "Prototype offline sync for mobile app",
		model: "claude-opus-4-5",
		ageMs: 26 * DAY,
		minutes: 96,
		messages: 80,
		project: "~/code/acme/mobile",
	},
];

const sessions = sessionSeeds.map((seed, index) => {
	const number = String(index + 1).padStart(4, "0");
	const startedMs = seed.ageMs + seed.minutes * MINUTE;
	const input = seed.messages * 2_350 + index * 911;
	const output = seed.messages * 640 + index * 173;
	const isActive = index === 0;
	return {
		id: `5e550000-${number}-4000-8000-00000000${number}`,
		local_session_id: `local-${seed.agent.agent_type}-${number}`,
		project_path: seed.project,
		agent_name: seed.agent.name,
		agent_display_name: seed.agent.display_name,
		agent_default_name: seed.agent.default_name,
		agent_type: seed.agent.agent_type,
		profile_key: seed.profile ?? "",
		machine_name: seed.agent.machine_name,
		started_at: ago(startedMs),
		ended_at: isActive ? null : ago(seed.ageMs),
		updated_at: ago(seed.ageMs),
		last_activity_at: ago(seed.ageMs),
		duration_seconds: seed.minutes * 60,
		message_count: seed.messages,
		input_tokens: input,
		output_tokens: output,
		cache_read_tokens: Math.round(input * 3.2),
		model: seed.model,
		models_used: [seed.model],
		summary: seed.summary,
		tags: seed.tags ?? [],
		status: isActive ? "active" : "completed",
		content_hash: `sha256-fixture-${number}`,
		content_protocol: "snapshot-v1",
		event_head_hash: null,
		is_shared: index === 2,
		related_refs: null,
		automated: seed.automated ?? false,
		agent_id: seed.agent.id,
	};
}) satisfies (Schemas["SessionListItemResponse"] & { automated: boolean; agent_id: string })[];

type Session = (typeof sessions)[number];

/** Profiles that are no longer configured on the Agent's machine. */
const removedProfiles: Record<string, string[]> = { [AGENT.claude]: ["personal"] };
/** Configured profiles that have not synced a session yet. */
const idleProfiles: Record<string, string[]> = { [AGENT.claude]: ["staging"] };

/** Every Agent has its default profile; others come from its sessions or `idleProfiles`. */
function agentProfiles(agentId: string): GetOk<"/v1/agents/{agent_id}/profiles"> {
	const agentSessions = sessions.filter((session) => session.agent_id === agentId);
	const keys = [
		...new Set([
			"",
			...agentSessions.map((session) => session.profile_key),
			...(idleProfiles[agentId] ?? []),
		]),
	];
	const [prefix = "", segment = ""] = agentId.split("-");
	return keys.map((key, index) => ({
		id: `9f0f0000-${segment}-4000-8000-${prefix}${String(index + 1).padStart(4, "0")}`,
		profile_key: key,
		is_default: key === "",
		state: removedProfiles[agentId]?.includes(key) ? "removed" : "active",
		session_count: agentSessions.filter((session) => session.profile_key === key).length,
	}));
}

function toSessionListItem(session: Session): Schemas["SessionListItemResponse"] {
	const { automated: _automated, agent_id: _agentId, ...item } = session;
	return item;
}

function sessionDetail(session: Session): GetOk<"/v1/sessions/{session_id}"> {
	return { ...toSessionListItem(session), has_content: true };
}

function sessionTimeline(session: Session): Schemas["SessionTimelinePage"]["items"] {
	const start = Date.parse(session.started_at);
	const at = (offsetMinutes: number) => new Date(start + offsetMinutes * MINUTE).toISOString();
	const model = session.model;
	return [
		{
			kind: "message",
			position: 0,
			role: "user",
			content: `${session.summary}. Start by looking at the relevant files and propose a plan before changing anything.`,
			timestamp: at(0),
		},
		{
			kind: "message",
			position: 1,
			role: "assistant",
			model,
			content:
				"I'll start by mapping the current implementation.\n\n1. Read the entry points and tests\n2. Identify the smallest safe change\n3. Implement it and run the focused test suite",
			timestamp: at(1),
		},
		{
			kind: "tool_call",
			position: 2,
			call_id: "call-1",
			name: "Bash",
			arguments_json: JSON.stringify({ command: "rg -n 'TODO|FIXME' src | head -20" }),
			model,
			timestamp: at(2),
		},
		{
			kind: "tool_result",
			position: 3,
			call_id: "call-1",
			name: "Bash",
			status: "completed",
			content:
				"src/queue/worker.ts:42: // TODO: retry with backoff\nsrc/webhooks/handler.ts:118: // FIXME: not idempotent",
			timestamp: at(2),
		},
		{
			kind: "message",
			position: 4,
			role: "assistant",
			model,
			content:
				"Found two hotspots. The webhook handler re-processes duplicate deliveries, and the worker has no retry policy. I'll add an idempotency key table and exponential backoff.\n\n```ts\nawait queue.enqueue(event, { idempotencyKey: event.id });\n```",
			timestamp: at(4),
		},
		{
			kind: "message",
			position: 5,
			role: "user",
			content: "Looks good. Please also add a regression test.",
			timestamp: at(9),
		},
		{
			kind: "message",
			position: 6,
			role: "assistant",
			model,
			content:
				"Added `handler.test.ts` covering duplicate deliveries and transient failures. All 24 tests pass locally.",
			timestamp: at(14),
		},
	];
}

// ---------------------------------------------------------------------------
// Dashboard stats + contribution graph
// ---------------------------------------------------------------------------

function contributionDays(days: number): Schemas["ContributionDayResponse"][] {
	const random = seededRandom(20261005);
	const result: Schemas["ContributionDayResponse"][] = [];
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const weekday = new Date(NOW - offset * DAY).getUTCDay();
		const weekend = weekday === 0 || weekday === 6;
		const recencyBoost = offset < 60 ? 1.6 : offset < 180 ? 1 : 0.55;
		const roll = random();
		const quiet = roll < (weekend ? 0.55 : 0.18) / recencyBoost;
		const count = quiet ? 0 : Math.round((1 + random() * (weekend ? 4 : 11)) * recencyBoost);
		const level = count === 0 ? 0 : count < 3 ? 1 : count < 7 ? 2 : count < 11 ? 3 : 4;
		result.push({ date: dateKey(offset * DAY), count, level });
	}
	return result;
}

const contribution = contributionDays(365);

function dashboardStats(): GetOk<"/v1/dashboard/stats"> {
	const totalSessions = contribution.reduce((sum, day) => sum + day.count, 0);
	const activeDays = contribution.filter((day) => day.count > 0).length;
	let current = 0;
	for (let i = contribution.length - 1; i >= 0 && (contribution[i]?.count ?? 0) > 0; i -= 1) {
		current += 1;
	}
	let longest = 0;
	let run = 0;
	for (const day of contribution) {
		run = day.count > 0 ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	const lastWeek = sessions.filter(
		(session) => NOW - Date.parse(session.last_activity_at) < 7 * DAY,
	);
	return {
		total_sessions: totalSessions,
		total_messages: totalSessions * 27,
		total_tokens: totalSessions * 61_400,
		active_days: activeDays,
		current_streak: current,
		longest_streak: longest,
		peak_hour: 14,
		favorite_model: "claude-opus-4-5",
		projects_count: projects.length,
		skills_count: skills.length,
		memories_count: memories.length,
		vault_count: vaults.length,
		vault_keys_count: vaults.reduce((sum, vault) => sum + vault.item_count, 0),
		connectors_count: connectorConnections.length,
		manual_sessions_last_7_days: lastWeek.filter((session) => !session.automated).length,
		automated_sessions_last_7_days: lastWeek.filter((session) => session.automated).length,
		top_model_last_7_days: "claude-opus-4-5",
		sessions_today: sessions.filter((session) => NOW - Date.parse(session.last_activity_at) < DAY)
			.length,
		contribution,
	};
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

type SkillSeed = {
	key: string;
	name: string;
	description: string;
	project: string;
	authority: "agent_sync" | "cloud";
	source: string;
	agentTypes: string[];
	files: number;
	ageMs: number;
	machine?: string;
};

const skillSeeds: SkillSeed[] = [
	{
		key: "code-review",
		name: "Code Review",
		description: "Review diffs for bugs, regressions and missing tests before merge.",
		project: PROJECT.personal,
		authority: "cloud",
		source: "library",
		agentTypes: ["claude_code", "codex"],
		files: 3,
		ageMs: 2 * DAY,
	},
	{
		key: "release-notes",
		name: "Release Notes",
		description: "Draft user-facing release notes from merged pull requests.",
		project: PROJECT.webapp,
		authority: "cloud",
		source: "github",
		agentTypes: ["claude_code"],
		files: 2,
		ageMs: 6 * DAY,
	},
	{
		key: "design-tokens",
		name: "Design Tokens",
		description: "Apply the Acme design token scale when editing UI components.",
		project: PROJECT.webapp,
		authority: "cloud",
		source: "library",
		agentTypes: ["claude_code", "codex"],
		files: 4,
		ageMs: 11 * DAY,
	},
	{
		key: "api-conventions",
		name: "API Conventions",
		description: "Follow Acme REST naming, pagination and error envelope rules.",
		project: PROJECT.webapp,
		authority: "cloud",
		source: "github",
		agentTypes: ["claude_code", "codex"],
		files: 2,
		ageMs: 4 * DAY,
	},
	{
		key: "deploy-checklist",
		name: "Deploy Checklist",
		description: "Run pre-deploy checks, tag the release and watch error rates.",
		project: PROJECT.infra,
		authority: "cloud",
		source: "library",
		agentTypes: ["openclaw", "codex"],
		files: 1,
		ageMs: 7 * DAY,
	},
	{
		key: "interview-synthesis",
		name: "Interview Synthesis",
		description: "Turn customer interview transcripts into themes and quotes.",
		project: PROJECT.research,
		authority: "cloud",
		source: "library",
		agentTypes: ["hermes"],
		files: 2,
		ageMs: 12 * DAY,
	},
	{
		key: "incident-triage",
		name: "Incident Triage",
		description: "Collect logs, summarize impact and open an incident doc.",
		project: PROJECT.infra,
		authority: "cloud",
		source: "library",
		agentTypes: ["openclaw", "codex"],
		files: 2,
		ageMs: 9 * DAY,
	},
	{
		key: "competitor-digest",
		name: "Competitor Digest",
		description: "Summarize competitor pricing and feature changes into a weekly digest.",
		project: PROJECT.research,
		authority: "cloud",
		source: "library",
		agentTypes: ["hermes"],
		files: 1,
		ageMs: 15 * DAY,
	},
	{
		key: "git-commit",
		name: "Git Commit",
		description: "Write conventional commit messages that explain the why.",
		project: PROJECT.mbp,
		authority: "agent_sync",
		source: "local",
		agentTypes: ["claude_code"],
		files: 1,
		ageMs: 3 * DAY,
		machine: "Averys-MacBook-Pro.local",
	},
	{
		key: "pdf-extract",
		name: "PDF Extract",
		description: "Extract tables and text from PDF documents into Markdown.",
		project: PROJECT.mbp,
		authority: "agent_sync",
		source: "local",
		agentTypes: ["claude_code"],
		files: 5,
		ageMs: 20 * DAY,
		machine: "Averys-MacBook-Pro.local",
	},
];

const projectById = new Map(projects.map((project) => [project.id, project]));

function skillProjectFields(
	seed: SkillSeed,
): Pick<
	Schemas["SkillSummaryResponse"],
	"project_id" | "project_name" | "project_kind" | "machine_name" | "environment_id"
> {
	const project = projectById.get(seed.project);
	const kind = project?.kind;
	return {
		project_id: seed.project,
		project_name: project?.name ?? null,
		project_kind:
			kind === "environment" || kind === "personal" || kind === "workspace" ? kind : null,
		machine_name: seed.machine ?? null,
		environment_id: seed.machine ? AGENT.claude : null,
	};
}

const skills = skillSeeds.map((seed, index) => ({
	id: `5c111000-${String(index).padStart(4, "0")}-4000-8000-${String(index).padStart(12, "0")}`,
	skill_key: seed.key,
	name: seed.name,
	description: seed.description,
	version: 1 + (index % 3),
	source: seed.source,
	authority: seed.authority,
	source_repo: seed.source === "github" ? "acme/agent-skills" : null,
	agent_types: seed.agentTypes,
	file_count: seed.files,
	content_hash: `sha256-skill-${seed.key}`,
	is_active: true,
	created_at: ago(seed.ageMs + 10 * DAY),
	updated_at: ago(seed.ageMs),
	...skillProjectFields(seed),
})) satisfies Schemas["SkillSummaryResponse"][];

function skillContent(name: string, description: string) {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n\n## Steps\n\n1. Read the relevant context first.\n2. Make the smallest correct change.\n3. Verify with focused checks and report results.\n`;
}

function skillDetail(skill: (typeof skills)[number]): GetOk<"/v1/skills/{skill_key}"> {
	return {
		id: skill.id,
		skill_key: skill.skill_key,
		name: skill.name,
		description: skill.description,
		version: skill.version,
		source: skill.source,
		authority: skill.authority,
		source_repo: skill.source_repo,
		file_count: skill.file_count,
		content: skillContent(skill.name, skill.description),
		agent_types: skill.agent_types,
		created_at: skill.created_at,
		content_hash: skill.content_hash,
		updated_at: skill.updated_at,
		project_id: skill.project_id,
		project_name: skill.project_name,
		project_kind: skill.project_kind,
		machine_name: skill.machine_name,
		environment_id: skill.environment_id,
	};
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

const memorySeeds: [string, string, string[], number][] = [
	["Avery prefers TypeScript strict mode and Biome for formatting.", "preference", ["tooling"], 1],
	[
		"The Acme API deploys via GitHub Actions to Fly.io; staging auto-deploys from main.",
		"fact",
		["deploy", "acme"],
		3,
	],
	[
		"Billing webhooks must be idempotent; Stripe retries deliveries for up to 3 days.",
		"decision",
		["billing"],
		5,
	],
	["Use pnpm in the legacy monorepo and Bun everywhere else.", "preference", ["tooling"], 8],
	["Weekly competitor digest goes out Monday 9 AM PT to #research.", "context", ["research"], 10],
	["The design system uses an 8px spacing grid and Geist Sans.", "fact", ["design"], 13],
	["On-call rotation hands off every Wednesday at noon.", "context", ["ops"], 17],
	[
		"Avoid adding new dependencies to the web app without a bundle-size check.",
		"decision",
		["web"],
		21,
	],
];

const memories = memorySeeds.map(([content, category, tags, days], index) => {
	const source = sessions[index % sessions.length];
	return {
		id: `3e3e0000-000${index}-4000-8000-00000000000${index}`,
		content,
		category,
		source: index % 3 === 0 ? "web" : "agent",
		tags,
		access_count: 4 + index * 3,
		created_at: ago(days * DAY),
		source_session_id: index % 3 === 0 ? null : (source?.id ?? null),
		source_environment_id: index % 3 === 0 ? null : (source?.agent_id ?? null),
		source_machine_name: index % 3 === 0 ? null : (source?.machine_name ?? null),
	};
}) satisfies Schemas["MemoryResponse"][];

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

const vaults = [
	{
		id: "7a017000-0001-4000-8000-000000000001",
		slug: "personal",
		name: "Personal",
		project_id: PROJECT.personal,
		project_ids: [PROJECT.personal],
		is_owner: true,
		item_count: 4,
		created_at: ago(110 * DAY),
	},
	{
		id: "7a017000-0002-4000-8000-000000000002",
		slug: "acme-prod",
		name: "Acme Production",
		project_id: PROJECT.webapp,
		project_ids: [PROJECT.webapp],
		is_owner: true,
		item_count: 10,
		created_at: ago(60 * DAY),
	},
	{
		id: "7a017000-0003-4000-8000-000000000003",
		slug: "acme-staging",
		name: "Acme Staging",
		project_id: PROJECT.webapp,
		project_ids: [PROJECT.webapp, PROJECT.infra],
		is_owner: true,
		item_count: 5,
		created_at: ago(58 * DAY),
	},
	{
		id: "7a017000-0004-4000-8000-000000000004",
		slug: "research-apis",
		name: "Research APIs",
		project_id: PROJECT.research,
		project_ids: [PROJECT.research],
		is_owner: false,
		item_count: 2,
		created_at: ago(40 * DAY),
	},
] satisfies Schemas["VaultResponse"][];

const vaultSections: Record<string, GetOk<"/v1/vault/{slug}/items">> = {
	personal: {
		"(default)": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
		github: ["GITHUB_TOKEN"],
		npm: ["NPM_TOKEN"],
	},
	"acme-prod": {
		"(default)": [
			"DATABASE_URL",
			"REDIS_URL",
			"stripe/FIXTURE_KEY",
			"stripe/FIXTURE_WEBHOOK",
			"sentry/FIXTURE_DSN",
			"sentry/FIXTURE_AUTH",
		],
		stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
		sentry: ["SENTRY_DSN", "SENTRY_AUTH_TOKEN"],
	},
	"acme-staging": {
		"(default)": ["DATABASE_URL", "REDIS_URL"],
		stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
		fly: ["FLY_API_TOKEN"],
	},
	"research-apis": { "(default)": ["SERPAPI_KEY", "FIRECRAWL_API_KEY"] },
};

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const connectorCatalog = [
	["gmail", "Gmail", "Read, search and draft email.", "oauth"],
	["github", "GitHub", "Issues, pull requests and repository contents.", "oauth"],
	["slack", "Slack", "Send messages and read channels.", "oauth"],
	["notion", "Notion", "Search and edit pages and databases.", "oauth"],
	["linear", "Linear", "Create and triage issues.", "oauth"],
	["googlecalendar", "Google Calendar", "Read and schedule events.", "oauth"],
	["googledrive", "Google Drive", "Search and read files.", "oauth"],
	["jira", "Jira", "Track issues and sprints.", "oauth"],
	["figma", "Figma", "Inspect design files and comments.", "oauth"],
	["stripe", "Stripe", "Look up customers, invoices and payments.", "api_key"],
	["hubspot", "HubSpot", "CRM contacts, deals and companies.", "oauth"],
	["airtable", "Airtable", "Read and write bases and records.", "api_key"],
].map(([name, display, description, auth]) => ({
	name: name ?? "",
	display_name: display ?? "",
	logo: `https://logos.composio.dev/api/${name}`,
	description: description ?? "",
	auth_type: auth ?? "oauth",
	connect_disabled: false,
	connect_disabled_reason: null,
})) satisfies Schemas["ConnectorAvailableAppResponse"][];

const connectorConnections = [
	{
		id: "c0cc0000-0001-4000-8000-000000000001",
		app_name: "gmail",
		status: "ACTIVE",
		created_at: ago(45 * DAY),
		is_disabled: false,
		alias: null,
		account_display: "avery@clawdi.dev",
	},
	{
		id: "c0cc0000-0002-4000-8000-000000000002",
		app_name: "github",
		status: "ACTIVE",
		created_at: ago(80 * DAY),
		is_disabled: false,
		alias: null,
		account_display: "averychen",
	},
	{
		id: "c0cc0000-0003-4000-8000-000000000003",
		app_name: "slack",
		status: "ACTIVE",
		created_at: ago(30 * DAY),
		is_disabled: false,
		alias: "Acme workspace",
		account_display: "acme.slack.com",
	},
	{
		id: "c0cc0000-0004-4000-8000-000000000004",
		app_name: "notion",
		status: "ACTIVE",
		created_at: ago(12 * DAY),
		is_disabled: false,
		alias: null,
		account_display: "Acme Notion",
	},
	{
		id: "c0cc0000-0005-4000-8000-000000000005",
		app_name: "linear",
		status: "EXPIRED",
		created_at: ago(70 * DAY),
		is_disabled: false,
		alias: null,
		account_display: "acme",
	},
] satisfies GetOk<"/v1/connectors">;

const connectorTools = [
	{
		name: "SEARCH",
		display_name: "Search",
		description: "Search items in the connected account.",
		is_deprecated: false,
	},
	{
		name: "READ",
		display_name: "Read item",
		description: "Read a single item by identifier.",
		is_deprecated: false,
	},
	{
		name: "CREATE",
		display_name: "Create item",
		description: "Create a new item in the connected account.",
		is_deprecated: false,
	},
] satisfies GetOk<"/v1/connectors/{app_name}/tools">;

// ---------------------------------------------------------------------------
// AI providers, channels, settings, misc
// ---------------------------------------------------------------------------

const readiness = {
	credential_material: "available",
	runtime_compatibility: { openclaw: true, hermes: true, codex: true },
	deployable: true,
	endpoint_reachability: "verified",
	inference_verification: "verified",
} satisfies Schemas["AiProviderReadiness"];

const aiProviders = {
	providers: [
		{
			configuration_mode: "native",
			native_provider: "anthropic",
			type: "anthropic",
			label: "Anthropic",
			base_url: "https://api.anthropic.com",
			api_mode: "anthropic_messages",
			managed_by: "user",
			models: [
				{ id: "claude-opus-4-5", label: "Claude Opus 4.5" },
				{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
			],
			id: "a1a1a1a1-0001-4000-8000-000000000001",
			provider_id: "anthropic",
			scope: "user",
			auth: { type: "api_key", source: "vault", ref: "vault://personal/ANTHROPIC_API_KEY" },
			usable: true,
			readiness,
			created_at: ago(90 * DAY),
			updated_at: ago(4 * DAY),
		},
		{
			configuration_mode: "native",
			native_provider: "openai",
			type: "openai",
			label: "OpenAI",
			base_url: "https://api.openai.com/v1",
			api_mode: "openai_responses",
			managed_by: "user",
			models: [
				{ id: "gpt-5", label: "GPT-5" },
				{ id: "gpt-5-codex", label: "GPT-5 Codex" },
			],
			id: "a1a1a1a1-0002-4000-8000-000000000002",
			provider_id: "openai",
			scope: "user",
			auth: { type: "oauth_profile", provider: "openai-codex", profile: "default" },
			usable: true,
			readiness,
			created_at: ago(60 * DAY),
			updated_at: ago(9 * DAY),
		},
		{
			configuration_mode: "catalog",
			native_provider: "openrouter",
			type: "openrouter",
			label: "OpenRouter",
			base_url: "https://openrouter.ai/api/v1",
			api_mode: "openai_chat",
			managed_by: "user",
			models: [{ id: "deepseek/deepseek-chat", label: "DeepSeek V3" }],
			id: "a1a1a1a1-0003-4000-8000-000000000003",
			provider_id: "openrouter",
			scope: "user",
			auth: { type: "api_key", source: "env", ref: "OPENROUTER_API_KEY" },
			usable: true,
			readiness: { ...readiness, inference_verification: "not_tested" },
			created_at: ago(20 * DAY),
			updated_at: ago(20 * DAY),
		},
	],
} satisfies GetOk<"/v1/ai-providers">;

const channelAccounts = [
	{
		id: "c4a00000-0001-4000-8000-000000000001",
		provider: "telegram",
		name: "@acme_ops_bot",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud-api.clawdi.ai/v1/channels/webhooks/telegram/c4a00000",
		created_at: ago(35 * DAY),
	},
	{
		id: "c4a00000-0002-4000-8000-000000000002",
		provider: "discord",
		name: "Acme Discord",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud-api.clawdi.ai/v1/channels/webhooks/discord/c4a00000",
		created_at: ago(18 * DAY),
	},
] satisfies GetOk<"/v1/channels">;

const channelAgentLinks: Schemas["ChannelAgentLinkWithAccountResponse"][] = channelAccounts.map(
	(account, index) => ({
		id: `11c00000-000${index}-4000-8000-00000000000${index}`,
		account_id: account.id,
		agent_id: index === 0 ? AGENT.openclaw : AGENT.hermes,
		status: "active",
		runtime_status: "connected",
		created_at: account.created_at,
		agent_token: null,
		account,
		binding_count: 2 - index,
	}),
) satisfies GetOk<"/v1/channels/agent-links">;

const apiKeys: Schemas["ApiKeyResponse"][] = [
	{
		id: "a9100000-0001-4000-8000-000000000001",
		label: "MacBook Pro CLI",
		key_prefix: "clawdi_mbp4",
		created_at: ago(90 * DAY),
		last_used_at: ago(3 * MINUTE),
		expires_at: null,
		revoked_at: null,
		scopes: null,
	},
	{
		id: "a9100000-0002-4000-8000-000000000002",
		label: "devbox-01",
		key_prefix: "clawdi_dvb1",
		created_at: ago(40 * DAY),
		last_used_at: ago(47 * MINUTE),
		expires_at: null,
		revoked_at: null,
		scopes: null,
	},
] satisfies GetOk<"/v1/auth/keys">;

const members = [
	{
		id: "3e3be000-0001-4000-8000-000000000001",
		user_id: USER_ID,
		user_email: currentUser.email,
		user_display: currentUser.name,
		role: "owner",
		joined_via: "owner",
		joined_at: ago(64 * DAY),
		resolved_owner_handle: "avery",
	},
	{
		id: "3e3be000-0002-4000-8000-000000000002",
		user_id: "8a1b2c3d-0000-4000-8000-000000000002",
		user_email: "jordan@acme.dev",
		user_display: "Jordan Lee",
		role: "member",
		joined_via: "invitation",
		joined_at: ago(30 * DAY),
		resolved_owner_handle: "avery",
	},
] satisfies GetOk<"/v1/projects/{project_id}/members">;

// Stateful visual flows. These values are synthetic and never contact providers.
const settings: Schemas["SettingsResponse"] = {
	memory_provider: readFlag("memory-provider", "builtin"),
	mem0_api_key_configured: readFlag("mem0-configured", "false") === "true",
	mem0_api_key: readFlag("mem0-configured", "false") === "true" ? "fixture-mem0-configured" : null,
} satisfies Schemas["SettingsResponse"];

const invitedProjects = [
	{
		...projects[2],
		kind: "workspace",
		is_owner: false,
		origin_environment_id: null,
		id: "a0f1c2d3-0006-4a00-8000-000000000006",
		name: "Partner Research",
		slug: "partner-research",
		description: "Shared partner research notes.",
		skill_count: 0,
		vault_count: 0,
		agent_count: 0,
		member_count: 2,
	},
	{
		...projects[2],
		kind: "workspace",
		is_owner: false,
		origin_environment_id: null,
		id: "a0f1c2d3-0007-4a00-8000-000000000007",
		name: "Platform Operations",
		slug: "platform-operations",
		description: "Shared platform operations notes.",
		owner_display: "Morgan Park",
		owner_handle: "morgan",
		skill_count: 0,
		vault_count: 0,
		agent_count: 0,
		member_count: 2,
	},
] satisfies Schemas["ProjectResponse"][];

const invitationSeeds = [
	{
		id: "1a710000-0001-4000-8000-000000000001",
		project_id: PROJECT.webapp,
		project_name: "Acme Web App",
		project_kind: "workspace",
		owner_display: currentUser.name,
		owner_handle: "avery",
		invitee_email: "sam@acme.dev",
		invited_by_user_id: USER_ID,
		invited_by_display: currentUser.name,
		created_at: ago(DAY),
	},
	{
		id: "1a710000-0002-4000-8000-000000000002",
		project_id: invitedProjects[0].id,
		project_name: invitedProjects[0].name,
		project_kind: "workspace",
		owner_display: "Jordan Lee",
		owner_handle: "jordan",
		invitee_email: currentUser.email,
		invited_by_user_id: members[1].user_id,
		invited_by_display: "Jordan Lee",
		created_at: ago(2 * HOUR),
	},
	{
		id: "1a710000-0003-4000-8000-000000000003",
		project_id: invitedProjects[1].id,
		project_name: invitedProjects[1].name,
		project_kind: "workspace",
		owner_display: "Morgan Park",
		owner_handle: "morgan",
		invitee_email: currentUser.email,
		invited_by_user_id: "8a1b2c3d-0000-4000-8000-000000000003",
		invited_by_display: "Morgan Park",
		created_at: ago(HOUR),
	},
] satisfies Schemas["InvitationResponse"][];
let invitations: Schemas["InvitationResponse"][] = invitationSeeds;

const PROJECT_TOKEN = "fixture_project_acme_".padEnd(43, "0");
function projectTokenForId(id: string) {
	return `fixture_${id.replaceAll("-", "")}`.padEnd(43, "0");
}
const shareLinks: Record<string, Schemas["ShareLinkResponse"][]> = {
	[PROJECT.webapp]: [
		{
			id: "51aee000-0001-4000-8000-000000000001",
			prefix: PROJECT_TOKEN.slice(0, 12),
			label: "Design review",
			created_at: ago(2 * DAY),
			expires_at: ago(-7 * DAY),
			revoked_at: null,
			redeem_count: 2,
			last_redeemed_at: ago(HOUR),
		} satisfies Schemas["ShareLinkResponse"],
	],
};
const projectTokens = new Map([[PROJECT_TOKEN, PROJECT.webapp]]);

const VAULT_TOKEN = `v2_${"fixture_acme_".padEnd(43, "0")}`;
const vaultRequests: Schemas["VaultSecretRequestStatus"][] = [
	{
		id: "5ecae000-0001-4000-8000-000000000001",
		vault_id: vaults[1].id,
		project_id: PROJECT.webapp,
		vault_name: "Acme Production",
		project_name: "Acme Web App",
		slug: "acme-prod",
		section: "(default)",
		fields: ["DEPLOY_TOKEN", "DATABASE_URL"],
		extra_fields: [],
		update_fields: ["DATABASE_URL"],
		content_version: 1,
		status: "pending",
		expires_at: ago(-7 * DAY),
		supplied_at: null,
		references: {
			DEPLOY_TOKEN: "vault://acme-prod/DEPLOY_TOKEN",
			DATABASE_URL: "vault://acme-prod/DATABASE_URL",
		},
	} satisfies Schemas["VaultSecretRequestStatus"],
];
const vaultTokens = new Map([[VAULT_TOKEN, vaultRequests[0].id]]);

const pluginCatalog = {
	revision: "fixture-1",
	synced_at: ago(DAY),
	plugins: [
		{
			name: "fixture-notes",
			version: "1.0.0",
			display_name: "Project Notes",
			description: "Reusable project notes and recall tools.",
			publisher: "Clawdi Fixtures",
			category: "productivity",
			keywords: ["notes", "memory"],
			languages: ["en"],
			runtimes: ["openclaw", "hermes"],
			components: { skills: ["project-notes"], mcpServers: {} },
			installable: true,
		},
		{
			name: "fixture-review",
			version: "1.0.0",
			display_name: "Code Review",
			description: "Review changes against the project's conventions.",
			publisher: "Clawdi Fixtures",
			category: "development",
			keywords: ["review"],
			languages: ["en"],
			runtimes: ["openclaw", "hermes"],
			components: { skills: ["code-review"], mcpServers: {} },
			installable: true,
		},
	],
} satisfies GetOk<"/v1/plugin-catalog">;
const installedPlugins: Schemas["AgentPluginDesiredStateResponse"][] = [
	{
		installation_id: "91061000-0001-4000-8000-000000000001",
		agent_id: AGENT.openclaw,
		plugin_name: "fixture-notes",
		version: "1.0.0",
		catalog_revision: pluginCatalog.revision,
		desired_state: "present",
		convergence: "installed",
		observed_at: ago(MINUTE),
		created_at: ago(3 * DAY),
		updated_at: ago(MINUTE),
	} satisfies Schemas["AgentPluginDesiredStateResponse"],
];

const channelBindings: Schemas["ChannelBindingResponse"][] = channelAgentLinks.flatMap(
	(link, index) =>
		Array.from(
			{ length: link.binding_count },
			(_, chat) =>
				({
					id: `b1ad0000-000${index + 1}-4000-8000-00000000000${chat + 1}`,
					account_id: link.account_id,
					agent_link_id: link.id,
					external_chat_id: `fixture-chat-${index + 1}-${chat + 1}`,
					external_chat_type: chat === 0 ? "private" : "group",
					external_chat_name: chat === 0 ? "Avery Chen" : "Acme Ops",
					status: "active",
					created_at: ago(3 * DAY),
					last_message_at: ago(3 * MINUTE),
				}) satisfies Schemas["ChannelBindingResponse"],
		),
);

const WHATSAPP_ACCOUNT = "c4a00000-0003-4000-8000-000000000003";
const whatsappAccount: Schemas["ChannelAccountResponse"] = {
	id: WHATSAPP_ACCOUNT,
	provider: "whatsapp",
	name: "Acme WhatsApp",
	status: "disconnected",
	visibility: "private",
	has_provider_token: false,
	webhook_url: "",
	created_at: ago(7 * DAY),
} satisfies Schemas["ChannelAccountResponse"];

const replacementChannel = {
	...channelAccounts[0],
	id: "c4a00000-0004-4000-8000-000000000004",
	name: "@acme_review_bot",
	created_at: ago(DAY),
} satisfies Schemas["ChannelAccountResponse"];
function allChannelAccounts(): Schemas["ChannelAccountResponse"][] {
	return [...channelAccounts, whatsappAccount, replacementChannel];
}

function whatsappState(
	value: string | null,
): Schemas["ChannelWhatsAppOnboardingSessionResponse"]["state"] {
	switch (value) {
		case "generating":
		case "ready":
		case "scanned":
		case "connected":
		case "expired":
		case "canceled":
		case "error":
			return value;
		default:
			return "ready";
	}
}
function whatsappSession(
	id: string,
	name: string,
	state = whatsappState(readFlag("whatsapp-state", "ready")),
) {
	return {
		id,
		channel_account_id: WHATSAPP_ACCOUNT,
		name,
		state,
		method: "qr",
		qr: state === "ready" ? "fixture-only,never-scan,this-is-not-a-whatsapp-login" : null,
		qr_expires_at: ago(-5 * MINUTE),
		pairing_code: null,
		manual_pairing_code_supported: true,
		started_at: ago(MINUTE),
		expires_at: state === "expired" ? ago(MINUTE) : ago(-15 * MINUTE),
		completed_at: state === "connected" ? ago(0) : null,
	} satisfies Schemas["ChannelWhatsAppOnboardingSessionResponse"];
}
const whatsappSessions = new Map<string, Schemas["ChannelWhatsAppOnboardingSessionResponse"]>(
	["ready", "generating", "scanned", "connected", "expired", "canceled", "error"].map(
		(state, index) => [
			`fa000000-000${index + 1}-4000-8000-00000000000${index + 1}`,
			whatsappSession(
				`fa000000-000${index + 1}-4000-8000-00000000000${index + 1}`,
				"Fixture WhatsApp",
				whatsappState(state),
			),
		],
	),
);
const whatsappRequests = new Map<string, string>();

const FIXTURE_SESSION = "5e550000-0001-4000-8000-000000000001";
const sessionShares: Schemas["SessionShareResponse"][] = [
	{
		id: "5a4e0000-0001-4000-8000-000000000001",
		session_id: FIXTURE_SESSION,
		scope: "session",
		start_position: null,
		end_position: 3,
		message_count: 4,
		share_url: `${shareOrigin}/s/5a4e0000-0001-4000-8000-000000000001`,
		created_at: ago(DAY),
	} satisfies Schemas["SessionShareResponse"],
];
const sessionPermissions: (Schemas["SessionPermissionResponse"] & { session_id: string })[] = [
	{
		id: "9ea10000-0001-4000-8000-000000000001",
		session_id: FIXTURE_SESSION,
		kind: "link",
		role: "viewer",
		created_at: ago(DAY),
		expires_at: null,
	} satisfies Schemas["SessionPermissionResponse"] & { session_id: string },
];

// Add an eligible connected identity without changing the four original agents.
const disconnectAgent = {
	...agents[0],
	id: "c1a0de00-0005-4c00-8000-000000000005",
	name: "fixture-connected-claude",
	display_name: "Disconnect Demo",
	explicit_identity: false,
	sort_order: 4,
} satisfies Schemas["AgentResponse"];

function agentSkills(agentId: string): GetOk<"/v1/agents/{agent_id}/skills"> {
	const projectIds = new Set((projectBindingsByAgent[agentId] ?? []).map((b) => b.project_id));
	return {
		agent_id: agentId,
		skills: skills
			.filter((skill) => projectIds.has(skill.project_id ?? ""))
			.map((skill) => ({
				skill_key: skill.skill_key,
				name: skill.name,
				description: skill.description,
				source: "project",
				authority: "cloud",
				read_only: skill.authority === "agent_sync",
				skill_id: skill.id,
				project_id: skill.project_id,
				content_hash: skill.content_hash,
				source_identity: `project:${skill.project_id}:${skill.skill_key}`,
				source_skill_key: skill.skill_key,
				desired_state: "present",
				convergence: "installed",
				observed_at: ago(10 * MINUTE),
			})),
	};
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Non-200 reply; field names avoid overlapping any response schema. */
class Reply {
	constructor(
		readonly httpStatus: number,
		readonly payload: unknown,
	) {}
}

const notFound = (detail: string) => new Reply(404, { detail });

type Ctx = { params: Record<string, string>; url: URL; request: Request };
type Route = {
	method: string;
	pattern: RegExp;
	keys: string[];
	template: string;
	handler: (ctx: Ctx) => unknown;
};

const routes: Route[] = [];

function compile(template: string) {
	const keys: string[] = [];
	const source = template
		.split("/")
		.map((segment) => {
			const match = segment.match(/^\{(\w+)\}$/);
			if (!match?.[1]) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			keys.push(match[1]);
			// Skill keys may contain slashes; let the last param be greedy.
			return match[1] === "skill_key" ? "(.+)" : "([^/]+)";
		})
		.join("/");
	return { pattern: new RegExp(`^${source}$`), keys };
}

/** Untyped route for mutations and endpoints outside the generated contract. */
function on(method: string, template: string, handler: (ctx: Ctx) => unknown) {
	routes.push({ method, template, handler, ...compile(template) });
}

function paginate<T>(items: readonly T[], url: URL, defaultSize = 25) {
	const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
	const pageSize = Math.max(
		1,
		Number(url.searchParams.get("page_size") ?? defaultSize) || defaultSize,
	);
	const start = (page - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		total: items.length,
		page,
		page_size: pageSize,
	};
}

function matchesQuery(text: string | null | undefined, query: string | null) {
	if (!query) return true;
	return (text ?? "").toLowerCase().includes(query.toLowerCase());
}

async function readStringArray(request: Request, field: string): Promise<string[]> {
	try {
		const body: unknown = await request.json();
		if (typeof body !== "object" || body === null || !(field in body)) return [];
		const value: unknown = Reflect.get(body, field);
		return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function connectorMetadata(names: string[]): PostOk<"/v1/connectors/metadata:batchRead"> {
	const known = connectorCatalog.filter((app) => names.includes(app.name));
	return {
		items: known.map(({ name, display_name, logo, description }) => ({
			name,
			display_name,
			logo,
			description,
		})),
		missing: names.filter((name) => !known.some((app) => app.name === name)),
	};
}

/** Keep project counters consistent with the skill/vault/agent fixtures. */
function withResourceCounts(project: Schemas["ProjectResponse"]): Schemas["ProjectResponse"] {
	return {
		...project,
		skill_count: skills.filter((skill) => skill.project_id === project.id).length,
		vault_count: vaults.filter((vault) => vault.project_ids.includes(project.id)).length,
		agent_count: agents.filter((agent) =>
			(projectBindingsByAgent[agent.id] ?? []).some((b) => b.project_id === project.id),
		).length,
	};
}

function findAgent(id: string | undefined) {
	return [...agents, disconnectAgent, ...hostedStateAgents].find((agent) => agent.id === id);
}

// ---------------------------------------------------------------------------
// Hosted compute fixtures: the same origin serves both generated API contracts.
// ---------------------------------------------------------------------------

const hostedProfile = {
	id: "usr_parity",
	clerk_id: "dev_browser",
	email: currentUser.email,
	name: currentUser.name,
	created_at: ago(120 * DAY),
	updated_at: ago(DAY),
	settings: {},
	capabilities: { can_use_v1: true, can_use_v2: true, can_create_v1_deployment: false },
} satisfies DeployGetOk<"/v1/me">;

const computePlans = [
	{
		slug: "compute_basic",
		name: "Basic",
		price_cents: 1000,
		vcpu: 1,
		ram_gb: 2,
		disk_size: 20,
		signup_grant_usd: "5.00",
		offers: [
			{
				billing_term_months: 1,
				price_cents: 1000,
				effective_monthly_price_cents: 1000,
				discount_percent: 0,
			},
			{
				billing_term_months: 12,
				price_cents: 9600,
				effective_monthly_price_cents: 800,
				discount_percent: 20,
			},
		],
	},
	{
		slug: "compute_performance",
		name: "Performance",
		price_cents: 2500,
		vcpu: 2,
		ram_gb: 4,
		disk_size: 40,
		signup_grant_usd: "5.00",
		offers: [
			{
				billing_term_months: 1,
				price_cents: 2500,
				effective_monthly_price_cents: 2500,
				discount_percent: 0,
			},
			{
				billing_term_months: 12,
				price_cents: 24000,
				effective_monthly_price_cents: 2000,
				discount_percent: 20,
			},
		],
	},
] satisfies DeployGetOk<"/v2/subscription/plans">;

function hostedDeployment(
	id: string,
	agentId: string,
	runtime: "openclaw" | "hermes",
	name: string,
	included: boolean,
): DeploySchemas["V2HostedDeploymentReadResponse"] {
	return {
		agent_id: agentId,
		resource: {
			id,
			name,
			commercial_revision: 1,
			deployment_target: "saas",
			metadata: {
				generation: 1,
				manifestETag: `etag-${id}`,
				resourceVersion: `rv-${id}`,
				createdAt: ago(30 * DAY),
				updatedAt: ago(HOUR),
			},
			spec: {
				schema_version: 1,
				desired_lifecycle: "running",
				runtime,
				runtime_version: "latest",
				resources: included
					? { vcpu: 1, memory_mib: 2048, disk_gib: 20 }
					: { vcpu: 2, memory_mib: 4096, disk_gib: 40 },
				agents: [{ agent_id: agentId, enabled: true, secret_references: [] }],
				ports: [],
				runtime_configuration: {
					providers: [],
					features: [],
					language: "en",
					timezone: "America/Los_Angeles",
					primary_model: { provider_id: "clawdi-managed-v2", model: "openai/gpt-4o-mini" },
				},
				rollout_nonce: 0,
				secret_references: [],
			},
			status: {
				summary_state: "running",
				observedGeneration: 1,
				driver_acknowledged_generation: 1,
				driver_applied_generation: 1,
				driver_observation_sequence: 1,
				conditions: [
					{
						type: "Ready",
						status: "True",
						observedGeneration: 1,
						reason: "RuntimeReady",
						message: "Runtime observation",
						lastTransitionTime: ago(HOUR),
					},
				],
				endpoints: [],
				observed_at: ago(20_000),
			},
		},
		clawdi_cloud_environments: { [agentId]: agentId },
		ai_provider_auth_kinds: { [runtime]: "managed" },
		files_endpoint: { url: "https://files.example.test/" },
		runtime_ui_endpoint:
			runtime === "hermes"
				? {
						runtime,
						role: "control_ui",
						url: "https://hermes.example.test/",
						auth_mode: "oidc",
						browser_mode: "embedded_and_top_level",
						browser_session_url: `https://compute.example.test/v2/deployments/${id}/hermes-oidc/session`,
						access_revision: 1,
						serving_ready: true,
						serving_reason: "Ok",
					}
				: null,
		provisioning_path: "standard",
		current_plan_slug: included ? "compute_basic" : "compute_performance",
		upgrade_available: included,
		upgrade_eligibility: { eligible: included, reason: null },
		compute_slot_occupancy: {
			occupies_slot: true,
			backing_infra: "present",
			reason: "backing_infra_present",
		},
		commercial_display: {
			compute_subscription: {
				status: "active",
				funding_source: included ? null : "wallet",
				payment_state: "ok",
				billing_term_months: 1,
				price_cents: included ? 0 : 2500,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: ago(-20 * DAY),
			},
		},
	} satisfies DeploySchemas["V2HostedDeploymentReadResponse"];
}

const hostedStateSeeds = [
	{ id: "hdep_ParityStopped", name: "Stopped Hermes", state: "stopped", payment: "ok" },
	{ id: "hdep_ParityFailed", name: "Failed OpenClaw", state: "failed", payment: "ok" },
	{ id: "hdep_ParityStarting", name: "Starting Hermes", state: "starting", payment: "ok" },
	{ id: "hdep_ParityDunning", name: "Payment overdue", state: "stopped", payment: "past_due" },
] satisfies {
	id: string;
	name: string;
	state: DeploySchemas["HostedDeploymentStatus"]["summary_state"];
	payment: DeploySchemas["V2HostedComputeSubscriptionInfo"]["payment_state"];
}[];
const hostedStateAgents = hostedStateSeeds.map(
	(seed, index) =>
		({
			...agents[2],
			id: `4e2e5000-000${index + 5}-4c00-8000-00000000000${index + 5}`,
			name: seed.name,
			display_name: seed.name,
			agent_type: index === 1 ? "openclaw" : "hermes",
			machine_id: `machine-fixture-${seed.id}`,
			machine_name: "Clawdi Cloud",
			sort_order: index + 5,
			last_seen_at: null,
			last_sync_at: null,
			explicit_identity: true,
		}) satisfies Schemas["AgentResponse"],
);
const deployments: DeploySchemas["V2HostedDeploymentReadResponse"][] = [
	hostedDeployment("hdep_ParityOpenClaw", AGENT.openclaw, "openclaw", "OpenClaw", true),
	hostedDeployment("hdep_ParityHermes", AGENT.hermes, "hermes", "Research Hermes", false),
	...hostedStateSeeds.map((seed, index) => {
		const deployment = hostedDeployment(
			seed.id,
			hostedStateAgents[index].id,
			index === 1 ? "openclaw" : "hermes",
			seed.name,
			false,
		);
		if (!deployment.resource.status) throw new Error("Missing fixture deployment status");
		deployment.resource.spec.desired_lifecycle = seed.state === "stopped" ? "stopped" : "running";
		deployment.resource.status.summary_state = seed.state;
		deployment.resource.status.conditions = [
			{
				type: "Ready",
				status: "False",
				observedGeneration: 1,
				reason:
					seed.state === "failed"
						? "RuntimeStartFailed"
						: seed.state === "starting"
							? "RuntimeStarting"
							: "RuntimeStopped",
				message:
					seed.state === "failed"
						? "Fixture runtime could not start. Retry the deployment."
						: "Fixture runtime observation",
				lastTransitionTime: ago(MINUTE),
			},
		];
		deployment.commercial_display = {
			compute_subscription: {
				status: seed.payment === "past_due" ? "past_due" : "active",
				funding_source: "wallet",
				payment_state: seed.payment,
				billing_term_months: 1,
				price_cents: 2500,
				currency: "usd",
				// The failed row exercises a paid subscription already scheduled to stop.
				cancel_at_period_end: seed.state === "failed",
				current_period_end: ago(seed.payment === "past_due" ? DAY : -20 * DAY),
				next_payment_attempt_at: seed.payment === "past_due" ? ago(-DAY) : null,
				recovery_action: seed.payment === "past_due" ? "top_up" : null,
			},
		};
		return deployment;
	}),
] satisfies DeploySchemas["V2HostedDeploymentReadResponse"][];

const deploymentOperations = deployments.map(
	(deployment) =>
		({
			name: `operations/op-${deployment.resource.id}`,
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: deployment.resource.id,
				verb: "create",
				targetGeneration: 1,
				manifestETag: deployment.resource.metadata.manifestETag,
				createTime: ago(30 * DAY),
				updateTime: ago(30 * DAY),
			},
			done: deployment.resource.status?.summary_state !== "starting",
			...(deployment.resource.status?.summary_state === "starting"
				? {}
				: deployment.resource.status?.summary_state === "failed"
					? { error: { code: 13, message: "Fixture runtime could not start", details: [] } }
					: {
							response: {
								"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
								deployment: deployment.resource,
							},
						}),
		}) satisfies DeploySchemas["LongRunningOperation"],
);

const computeSubscriptions = {
	items: deployments.map(
		(deployment, index) =>
			({
				subscription_id:
					index === 0
						? "csub_ParityIncluded"
						: index === 1
							? "csub_ParityPerformance"
							: `csub_${deployment.resource.id.slice(5)}`,
				subscription_kind: index === 0 ? "included_basic" : "paid",
				plan_slug: deployment.current_plan_slug,
				funding_source: index === 0 ? null : "wallet",
				status: deployment.resource.id === "hdep_ParityDunning" ? "past_due" : "active",
				price_cents: index === 0 ? 0 : 2500,
				currency: "usd",
				billing_term_months: 1,
				current_period_end: ago(-20 * DAY),
				cancel_at_period_end:
					deployment.commercial_display?.compute_subscription?.cancel_at_period_end ?? false,
				deployment_id: deployment.resource.id,
				agent_name: deployment.resource.name,
				is_orphan: false,
				payment_state: deployment.commercial_display?.compute_subscription?.payment_state ?? "ok",
				latest_failed_invoice_hosted_url: null,
				next_payment_attempt_at:
					deployment.commercial_display?.compute_subscription?.next_payment_attempt_at ?? null,
				recovery_action:
					deployment.commercial_display?.compute_subscription?.recovery_action ?? null,
				pending_plan_slug: null,
				// Hosted's per-row commands; opt-in so default screenshots stay unchanged.
				...(readFlag("subscription-actions", "false") === "true" && index > 0
					? {
							actions: {
								cancel: deployment.commercial_display?.compute_subscription?.cancel_at_period_end
									? null
									: "cancel_at_period_end",
								resume:
									deployment.commercial_display?.compute_subscription?.cancel_at_period_end ??
									false,
								command_state: null,
							},
						}
					: {}),
			}) satisfies DeploySchemas["V2ComputeSubscriptionListItem"],
	),
	has_more: false,
	next_cursor: null,
} satisfies DeployGetOk<"/v2/subscriptions">;

/** `--reusable-subscriptions mixed`: unassigned card, Wallet and store rows for the deploy wizard. */
const reusableSubscriptions = {
	items:
		readFlag("reusable-subscriptions", "none") === "mixed"
			? [
					{
						subscription_id: "csub_ReuseCard",
						plan_slug: "compute_performance",
						billing_term_months: 12,
						funding_source: "stripe",
						status: "active",
						price_cents: 20_000,
						currency: "usd",
						current_period_end: ago(-200 * DAY),
						entitled_until: ago(-200 * DAY),
						cancel_at_period_end: false,
					},
					{
						subscription_id: "csub_ReuseWallet",
						plan_slug: "compute_basic",
						billing_term_months: 1,
						funding_source: "wallet",
						status: "canceling",
						price_cents: 1_000,
						currency: "usd",
						current_period_end: ago(-12 * DAY),
						entitled_until: ago(-12 * DAY),
						cancel_at_period_end: true,
					},
					{
						subscription_id: "csub_ReuseStore",
						plan_slug: "compute_basic",
						billing_term_months: 1,
						funding_source: "store",
						status: "active",
						price_cents: null,
						currency: "usd",
						current_period_end: ago(-25 * DAY),
						entitled_until: ago(-25 * DAY),
						cancel_at_period_end: false,
						store_management: {
							contract_id: "5a0e0000-0001-4000-8000-000000000001",
							provider: "play_store",
							product_id: "ai.clawdi.app.compute.basic.monthly",
							management_url: null,
							auto_renews: true,
							renews_or_ends_at: ago(-25 * DAY),
							state: "active",
						},
					},
				]
			: [],
	has_more: false,
	next_cursor: null,
} satisfies DeployGetOk<"/v2/subscriptions/reusable">;

const wallet = {
	balance_usd: "42.50",
	x402_enabled: false,
	x402_payment_status: "idle",
	auto_reload_enabled: false,
	auto_reload_has_payment_method: false,
	auto_reload_currency: "usd",
	auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
	auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
	auto_reload_threshold_usd: "5.00",
	auto_reload_amount_cents: 2500,
	auto_reload_monthly_cap_cents: 10000,
	auto_reload_monthly_spent_cents: 0,
	auto_reload_period_end: ago(-20 * DAY),
	auto_reload_status: "off",
} satisfies DeployGetOk<"/v2/wallet">;

const walletTransactions = {
	items: [
		{
			id: "wallet:parity-store-refund",
			kind: "store_refund",
			occurred_at: ago(HOUR),
			amount: "10.00",
			currency: "usd",
			direction: "debit",
			status: "applied",
			funding: "wallet",
		},
		{
			id: "wallet:parity-compute",
			kind: "compute_charge",
			occurred_at: ago(DAY),
			amount: "25.00",
			currency: "usd",
			direction: "debit",
			status: "applied",
			funding: "wallet",
			context: {
				plan: "compute_performance",
				agent_name: "Research Hermes",
				deployment_id: "hdep_ParityHermes",
				period_start: ago(10 * DAY),
				period_end: ago(-20 * DAY),
			},
		},
		{
			id: "wallet:parity-store-topup",
			kind: "store_topup",
			occurred_at: ago(2 * DAY),
			amount: "25.00",
			currency: "usd",
			direction: "credit",
			status: "applied",
			funding: "store",
		},
		{
			id: "wallet:parity-topup",
			kind: "topup",
			occurred_at: ago(3 * DAY),
			amount: "50.00",
			currency: "usd",
			direction: "credit",
			status: "applied",
			funding: "card",
			receipt_url: "https://pay.stripe.com/receipts/parity",
		},
	],
	has_more: false,
	next_cursor: null,
} satisfies DeployGetOk<"/v2/wallet/transactions">;

const managedModels = {
	models: [
		{
			id: "openai/gpt-4o-mini",
			display_name: "GPT-4o mini",
			provider_id: "clawdi-managed-v2",
			api_mode: "openai_chat",
			is_default: true,
			is_featured: true,
			description: "Fast, efficient model for everyday tasks.",
			capabilities: {
				context_window: 128000,
				max_context_window: 128000,
				max_input_tokens: 128000,
				max_output_tokens: 16384,
				input_modalities: ["text", "image"],
				supports_vision: true,
				supports_reasoning: false,
				supports_tools: true,
			},
		},
	],
} satisfies DeployGetOk<"/v2/ai-providers/managed/models">;

/**
 * AI usage, shaped like hosted `/v2/usage`: model rows carry managed-catalogue ids with
 * `provider: null`, totals equal the model and day sums, and a scoped read omits `by_agent`.
 */
const deletedUsageAgent = {
	id: "de1e7ed0-0009-4c00-8000-000000000009",
	name: "Old Hermes",
	type: "hermes",
} as const;
const usageWeights: Record<string, number> = {
	[AGENT.openclaw]: 3,
	[AGENT.hermes]: 2,
	[deletedUsageAgent.id]: 1,
};
const usageModels = [
	{ model: "openai/gpt-4o-mini", share: 49, requests: 41 },
	{ model: "anthropic/claude-sonnet-4.5", share: 46, requests: 12 },
	{ model: "deepseek/deepseek-chat", share: 5, requests: 9 },
] as const;

function usageSummary(url: URL): DeployGetOk<"/v2/usage"> | Reply {
	const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 90);
	const agentId = url.searchParams.get("agent_id");
	const knownAgents = new Set([
		...deployments.map((deployment) => deployment.agent_id),
		deletedUsageAgent.id,
	]);
	if (agentId && !knownAgents.has(agentId)) return notFound("Agent not found");
	const weight = agentId
		? (usageWeights[agentId] ?? 0)
		: Object.values(usageWeights).reduce((total, value) => total + value, 0);
	const end = new Date(NOW);
	end.setUTCHours(0, 0, 0, 0);
	const start = new Date(end.valueOf() - (days - 1) * DAY);
	const dollars = (cents: number) => (cents / 100).toFixed(2);
	const byDay: DeploySchemas["V2HostedUsageDay"][] = [];
	for (let index = 0; index < days; index += 1) {
		// Quiet Sundays and a few idle days keep the chart's zero-spend state visible.
		const date = new Date(start.valueOf() + index * DAY);
		const activity = (index * 7 + 3) % 11;
		const cents = weight * activity * 9;
		if (date.getUTCDay() === 0 || activity < 2 || !cents) continue;
		byDay.push({ date: date.toISOString().slice(0, 10), amount_usd: dollars(cents) });
	}
	const totalCents = byDay.reduce(
		(total, day) => total + Math.round(Number(day.amount_usd) * 100),
		0,
	);
	let remainingCents = totalCents;
	const byModel = totalCents
		? usageModels.map((model, index) => {
				const cents =
					index === usageModels.length - 1
						? remainingCents
						: Math.round((totalCents * model.share) / 100);
				remainingCents -= cents;
				return {
					model: model.model,
					provider: null,
					amount_usd: dollars(cents),
					requests: Math.round((model.requests * weight * days) / 6),
				};
			})
		: [];
	const totalRequests = byModel.reduce((total, model) => total + model.requests, 0);
	const agentRows = deployments
		.map((deployment) => ({
			id: deployment.agent_id,
			name: deployment.resource.name,
			type: deployment.resource.spec.runtime,
			deleted: false,
		}))
		.concat({ ...deletedUsageAgent, deleted: true })
		.filter((agent) => usageWeights[agent.id]);
	const allWeight = Object.values(usageWeights).reduce((total, value) => total + value, 0);
	return {
		period_start: start.toISOString(),
		period_end: end.toISOString(),
		availability: "complete",
		unavailable_sections: [],
		breakdown_limit: 100,
		truncated_sections: [],
		total_usd: dollars(totalCents),
		total_requests: totalRequests,
		by_agent: agentId
			? []
			: agentRows.map((agent) => ({
					agent_id: agent.id,
					agent_name: agent.name,
					agent_type: agent.type,
					agent_deleted: agent.deleted,
					amount_usd: dollars(Math.round((totalCents * usageWeights[agent.id]) / allWeight)),
					requests: Math.round((totalRequests * usageWeights[agent.id]) / allWeight),
				})),
		by_model: byModel,
		by_day: byDay,
	};
}

// Hosted account notifications (`/v1/me/notifications`), newest first. Read state, `read-all`
// and removal persist in memory until the server stops.
let accountNotifications: DeploySchemas["AccountNotificationResponse"][] = [
	{
		id: "a7700000-0004-4000-8000-000000000004",
		kind: "billing.payment_failed",
		title: "Payment failed for Payment overdue",
		description:
			"We couldn't renew this Agent's Performance subscription. Top up your Wallet to restart it.",
		category: "Billing",
		severity: "destructive",
		action_label: "Top up Wallet",
		action_url: "https://cloud.clawdi.ai/?settings=billing-wallet",
		created_at: ago(12 * MINUTE),
		read_at: null,
	},
	{
		id: "a7700000-0003-4000-8000-000000000003",
		kind: "agent.start_failed",
		title: "Failed OpenClaw couldn't start",
		description: "The runtime exited during startup. Review the Agent and start it again.",
		category: "Agents",
		severity: "warning",
		action_label: "Open Agent",
		action_url: "https://cloud.clawdi.ai/agents/4e2e5000-0006-4c00-8000-000000000006",
		created_at: ago(3 * HOUR),
		read_at: null,
	},
	{
		id: "a7700000-0002-4000-8000-000000000002",
		kind: "account.release_notes",
		title: "Agent profiles are here",
		description: "Separate sessions and memories per profile on one Agent.",
		category: "Product",
		severity: "info",
		action_label: "Read more",
		action_url: "https://www.clawdi.ai/changelog",
		created_at: ago(2 * DAY),
		read_at: ago(DAY),
	},
	{
		id: "a7700000-0001-4000-8000-000000000001",
		kind: "billing.subscription_canceled",
		title: "Subscription canceled",
		description: "Your Basic subscription for Staging ended at the close of the billing period.",
		category: "Billing",
		severity: "info",
		created_at: ago(9 * DAY),
		read_at: ago(8 * DAY),
	},
];

function notificationPage(url: URL): DeploySchemas["AccountNotificationListResponse"] | Reply {
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
	const cursor = url.searchParams.get("cursor");
	const after = cursor ? accountNotifications.findIndex((item) => item.id === cursor) : -1;
	if (cursor && after < 0) return new Reply(400, { detail: "Invalid notification cursor" });
	const start = after + 1;
	const items = accountNotifications.slice(start, start + limit);
	const next = accountNotifications[start + limit] ? items.at(-1)?.id : null;
	return {
		items,
		unread_count: accountNotifications.filter((item) => item.read_at == null).length,
		next_cursor: next ?? null,
	};
}

const computeGetRoutes = {
	"/v1/me": () => hostedProfile,
	"/v1/agent-environments": () => ({ environment_ids: [] }),
	"/v1/me/notifications": ({ url }) => notificationPage(url),
	"/v2/subscription/plans": () => computePlans,
	"/v2/deployments": ({ url }) =>
		url.searchParams.get("event_stream_handoff") === "true"
			? {
					snapshot_isolation: "REPEATABLE READ",
					read_only: true,
					deployments,
					operations: deploymentOperations,
					event_stream_cursor: "parity:1",
				}
			: deployments,
	"/v2/deployments/by-request/{deploy_request_id}": ({ params }) => {
		const walletDeploymentId = walletCheckouts.get(params.deploy_request_id ?? "")?.response
			.deployment_id;
		const deployment = deployments.find(
			(item) =>
				params.deploy_request_id === `request-${item.resource.id}` ||
				item.resource.id === walletDeploymentId,
		);
		if (!deployment) return notFound("Deploy request not found");
		return {
			deploy_request_id: params.deploy_request_id ?? "",
			request_status:
				deployment.resource.status?.summary_state === "starting"
					? "processing"
					: deployment.resource.status?.summary_state === "failed"
						? "failed"
						: "succeeded",
			lineage_tail: {
				deployment_id: deployment.resource.id,
				agent_id: deployment.agent_id,
				deployment_status: deployment.resource.status,
				lineage_version: 1,
				lineage_state:
					deployment.resource.status?.summary_state === "starting"
						? "processing"
						: deployment.resource.status?.summary_state === "failed"
							? "failed"
							: "succeeded",
				accepted_generation: 1,
				operation_name: `operations/op-${deployment.resource.id}`,
			},
		};
	},
	"/v2/deployments/{deployment_id}": ({ params }) =>
		deployments.find((item) => item.resource.id === params.deployment_id) ??
		notFound("Deployment not found"),
	"/v2/deployments/{deployment_id}/workspace-skills": ({ params }) => {
		const deployment = deployments.find((item) => item.resource.id === params.deployment_id);
		if (!deployment) return notFound("Deployment not found");
		return {
			deployment_id: deployment.resource.id,
			deployment_resource_version: deployment.resource.metadata.resourceVersion,
			manifest_generation: 1,
			capability: { available: true, reason: "available" },
			items: [],
		};
	},
	"/v2/operations/{operation_id}": ({ params }) =>
		deploymentOperations.find((item) => item.name === `operations/${params.operation_id}`) ??
		notFound("Operation not found"),
	"/v2/subscriptions": ({ url }) => ({
		...computeSubscriptions,
		items: computeSubscriptions.items.filter(
			(item) =>
				!url.searchParams.has("deployment_id") ||
				item.deployment_id === url.searchParams.get("deployment_id"),
		),
	}),
	"/v2/subscriptions/reusable": () => reusableSubscriptions,
	"/v2/subscriptions/included-basic": () =>
		readFlag("included-basic", "available") === "none"
			? { total_slots: 1, used_slots: 1, available_slots: 0 }
			: { total_slots: 2, used_slots: 1, available_slots: 1 },
	"/v2/wallet": () => wallet,
	"/v2/wallet/transactions": () => walletTransactions,
	"/v2/wallet/payment-methods": () => ({ items: [], has_more: false }),
	"/v2/ai-providers/managed/models": () => managedModels,
	"/v2/usage": ({ url }) => usageSummary(url),
} satisfies { [P in DeployGetPath]?: (ctx: Ctx) => DeployGetOk<P> | Reply };

for (const [template, handler] of Object.entries(computeGetRoutes)) {
	routes.push({ method: "GET", template, handler, ...compile(template) });
}
on("POST", "/v1/me/notifications/read-all", async ({ request }) => {
	const body = await bodyObject(request);
	const upTo = accountNotifications.findIndex((item) => item.id === body.up_to_id);
	if (body.up_to_id != null && upTo < 0) return notFound("Notification not found");
	const readAt = ago(0);
	let updated = 0;
	accountNotifications = accountNotifications.map((item, index) => {
		if (item.read_at != null || (upTo >= 0 && index < upTo)) return item;
		updated += 1;
		return { ...item, read_at: readAt };
	});
	return { updated_count: updated } satisfies DeploySchemas["AccountNotificationReadAllResponse"];
});
on("DELETE", "/v1/me/notifications/{notification_id}", ({ params }) => {
	if (!accountNotifications.some((item) => item.id === params.notification_id))
		return notFound("Notification not found");
	accountNotifications = accountNotifications.filter((item) => item.id !== params.notification_id);
	return new Reply(204, null);
});
// No live hosted stream or runtime infrastructure is simulated.
on("GET", "/v2/events", () => new Reply(204, null));
// One-time Files handoff stub; the fixture never serves the Files host itself.
on("POST", "/v2/deployments/{deployment_id}/files/handoff", ({ params, request }) => {
	const deployment = deployments.find((item) => item.resource.id === params.deployment_id);
	if (!deployment?.files_endpoint) return notFound("Deployment not found");
	if (request.headers.get("if-match") !== `"${deployment.resource.metadata.resourceVersion}"`)
		return new Reply(412, { detail: "Files handoff does not match the current deployment" });
	return {
		url: new URL("/__clawdi/files/handoff?code=fixture", deployment.files_endpoint.url).href,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		deployment_resource_version: deployment.resource.metadata.resourceVersion,
	} satisfies DeploySchemas["V2HostedFilesHandoff"];
});
// Hermes handoff stub; CI cancels confirmation and never opens the redeem URL.
on("POST", "/v2/deployments/{deployment_id}/hermes-oidc/handoff", ({ params, request }) => {
	const deployment = deployments.find((item) => item.resource.id === params.deployment_id);
	if (deployment?.runtime_ui_endpoint?.runtime !== "hermes")
		return notFound("Deployment not found");
	if (request.headers.get("if-match") !== `"${deployment.resource.metadata.resourceVersion}"`)
		return new Reply(412, { detail: "Dashboard handoff does not match the current deployment" });
	return {
		url: `https://compute.example.test/v2/hermes/oidc/handoff?code=${"A".repeat(43)}`,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		deployment_resource_version: deployment.resource.metadata.resourceVersion,
	} satisfies DeploySchemas["V2HostedHermesDashboardHandoff"];
});
// GitHub Workspace Skill install: checks the request's ETag and records nothing.
on("POST", "/v2/deployments/{deployment_id}/workspace-skills", async ({ params, request }) => {
	const deployment = deployments.find((item) => item.resource.id === params.deployment_id);
	if (!deployment) return notFound("Deployment not found");
	const version = deployment.resource.metadata.resourceVersion;
	if (request.headers.get("if-match") !== `"${version}"` || !request.headers.get("idempotency-key"))
		return new Reply(412, { detail: "Workspace Skill request does not match the deployment" });
	const body = await bodyObject(request);
	if (typeof body.repo !== "string" || !body.repo.includes("/"))
		return new Reply(400, { detail: "Invalid Workspace Skill source" });
	const path = typeof body.path === "string" ? body.path : "";
	return {
		deployment_id: deployment.resource.id,
		deployment_resource_version: version,
		manifest_generation: 2,
		skill_key: path.split("/").pop() || body.repo.split("/")[1] || "skill",
		desired_state: "present",
		status: "requested",
	} satisfies DeploySchemas["V2WorkspaceSkillMutationResponse"];
});
for (const [path, resume] of [
	["/v2/subscription/cancel", false],
	["/v2/subscription/resume", true],
] as const)
	on("POST", path, async ({ request }) => {
		const body = await bodyObject(request);
		const item = computeSubscriptions.items.find(
			(candidate) => candidate.subscription_id === body.subscription_id,
		);
		if (!item) return notFound("Subscription not found");
		return {
			status: resume ? "active" : "canceling",
			funding_source: item.funding_source,
			billing_term_months: item.billing_term_months,
			cancel_at_period_end: !resume,
			current_period_end: item.current_period_end,
		} satisfies DeploySchemas["V2ComputeSubscriptionActionResponse"];
	});
on("POST", "/v2/subscription/quote", async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Reply(400, { detail: "Invalid quote request" });
	}
	if (typeof body !== "object" || body === null)
		return new Reply(400, { detail: "Invalid quote request" });
	const planSlug: unknown = Reflect.get(body, "plan_slug");
	const term: unknown = Reflect.get(body, "billing_term_months");
	const funding: unknown = Reflect.get(body, "funding_source");
	if (
		(planSlug !== "compute_basic" && planSlug !== "compute_performance") ||
		(term !== 1 && term !== 12) ||
		(funding !== "stripe" && funding !== "wallet")
	)
		return new Reply(400, { detail: "Invalid quote request" });
	const offer = computePlans
		.find((plan) => plan.slug === planSlug)
		?.offers.find((item) => item.billing_term_months === term);
	if (!offer) return new Reply(400, { detail: "Plan offer unavailable" });
	const debit = offer.price_cents / 100;
	return {
		plan_slug: planSlug,
		billing_term_months: term,
		funding_source: funding,
		currency: "usd",
		term_price_cents: offer.price_cents,
		expires_at: new Date(NOW + 15 * MINUTE).toISOString(),
		preview_invoice_id: funding === "stripe" ? "preview_parity" : null,
		debit_amount_usd: funding === "wallet" ? debit.toFixed(2) : null,
		balance_before_usd: funding === "wallet" ? wallet.balance_usd : null,
		balance_after_usd:
			funding === "wallet" ? (Number(wallet.balance_usd) - debit).toFixed(2) : null,
	} satisfies DeploySchemas["V2ComputeSubscriptionQuoteResponse-Output"];
});

/**
 * Web's and the app's new Wallet subscription for a new Agent: hosted checks the confirmed
 * quote, debits the Wallet once per deploy request and accepts the deployment, which starts
 * and becomes ready a few seconds later. The same key and body replay the activation.
 */
const walletCheckouts = new Map<
	string,
	{ body: string; response: DeploySchemas["V2SubscriptionActivationResponse"] }
>();
on("POST", "/v2/subscription/checkout", async ({ request }) => {
	const key = request.headers.get("idempotency-key")?.trim();
	if (!key) return new Reply(400, { detail: { code: "idempotency_key_required" } });
	const body = await bodyObject(request);
	const replay = walletCheckouts.get(key);
	if (replay)
		return replay.body === JSON.stringify(body)
			? new Reply(202, replay.response)
			: new Reply(409, { detail: { code: "idempotency_key_reused" } });
	const config = body.deploy_config;
	const selection = body.subscription_selection;
	const quote = body.quote;
	if (
		body.funding_source !== "wallet" ||
		typeof selection !== "object" ||
		selection === null ||
		Reflect.get(selection, "mode") !== "new" ||
		typeof config !== "object" ||
		config === null ||
		typeof quote !== "object" ||
		quote === null
	)
		return new Reply(400, { detail: "Only new Wallet subscriptions are simulated" });
	if (Reflect.get(config, "deploy_request_id") !== key)
		return new Reply(409, { detail: { code: "deploy_request_id_mismatch" } });
	const planSlug = body.plan_slug;
	const term = body.billing_term_months;
	const offer = computePlans
		.find((plan) => plan.slug === planSlug)
		?.offers.find((item) => item.billing_term_months === term);
	if (!offer || Reflect.get(config, "compute_plan_slug") !== planSlug)
		return new Reply(400, { detail: "Plan offer unavailable" });
	const debit = offer.price_cents / 100;
	const balance = Number(wallet.balance_usd);
	const expiresAt = Reflect.get(quote, "expires_at");
	if (typeof expiresAt !== "string" || Date.parse(expiresAt) <= Date.now())
		return new Reply(409, { detail: "The wallet quote expired; request a fresh quote" });
	if (
		Number(Reflect.get(quote, "debit_amount_usd")) !== debit ||
		Number(Reflect.get(quote, "balance_before_usd")) !== balance
	)
		return new Reply(409, {
			detail: "The wallet quote changed; review a fresh quote before confirming",
		});
	if (balance < debit)
		return new Reply(402, {
			detail: {
				code: "insufficient_wallet_balance",
				required_usd: debit.toFixed(2),
				available_usd: wallet.balance_usd,
				shortfall_usd: (debit - balance).toFixed(2),
			},
		});
	const runtime = Reflect.get(config, "runtime") === "openclaw" ? "openclaw" : "hermes";
	const name = String(Reflect.get(config, "name") ?? "Wallet Agent");
	const sequence = walletCheckouts.size + 1;
	const deploymentId = `hdep_ParityWallet${sequence}`;
	const agentId = `4e2e5000-0100-4c00-8000-${String(sequence).padStart(12, "0")}`;
	const deployment = hostedDeployment(deploymentId, agentId, runtime, name, false);
	const status = deployment.resource.status;
	if (!status) throw new Error("Missing fixture deployment status");
	status.summary_state = "starting";
	deployment.current_plan_slug = planSlug === "compute_performance" ? planSlug : "compute_basic";
	if (planSlug === "compute_basic")
		deployment.resource.spec.resources = { vcpu: 1, memory_mib: 2048, disk_gib: 20 };
	deployment.resource.metadata.createdAt = new Date().toISOString();
	deployments.push(deployment);
	const operation = {
		name: `operations/op-${deploymentId}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId,
			verb: "create",
			targetGeneration: 1,
			manifestETag: deployment.resource.metadata.manifestETag,
			createTime: new Date().toISOString(),
			updateTime: new Date().toISOString(),
		},
		done: false,
	} satisfies DeploySchemas["LongRunningOperation"];
	deploymentOperations.push(operation);
	hostedStateAgents.push({
		...agents[2],
		id: agentId,
		name,
		display_name: name,
		agent_type: runtime,
		machine_id: `machine-fixture-${deploymentId}`,
		machine_name: "Clawdi Cloud",
		sort_order: 20 + sequence,
		last_seen_at: null,
		last_sync_at: null,
		explicit_identity: true,
	});
	setTimeout(() => {
		status.summary_state = "running";
		Object.assign(operation, {
			done: true,
			response: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
				deployment: deployment.resource,
			},
		});
	}, 15_000);
	wallet.balance_usd = (balance - debit).toFixed(2);
	const response = {
		flow_type: "subscription_activation",
		funding_source: "wallet",
		action_url: null,
		checkout_url: "",
		client_secret: null,
		subscription_id: `csub_ParityWallet${sequence}`,
		invoice_id: `in_ParityWallet${sequence}`,
		deployment_id: deploymentId,
		agent_id: agentId,
		deployment_name: name,
		metadata_generation: 1,
		deploy_request_id: key,
		debited_usd: debit.toFixed(2),
		balance_after_usd: wallet.balance_usd,
		current_period_start: new Date().toISOString(),
		current_period_end: new Date(Date.now() + 30 * DAY).toISOString(),
		entitled_until: new Date(Date.now() + 30 * DAY).toISOString(),
	} satisfies DeploySchemas["V2SubscriptionActivationResponse"];
	walletCheckouts.set(key, { body: JSON.stringify(body), response });
	return new Reply(202, response);
});

// ---------------------------------------------------------------------------
// Routes: identity + settings
// ---------------------------------------------------------------------------

const getRoutes: { [P in GetPath]?: (ctx: Ctx) => GetOk<P> | Reply } = {
	"/health": () => ({ status: "ok" }),
	"/ready": () => ({ status: "ok" }),
	"/v1/auth/me": () => currentUser,
	"/v1/auth/keys": () => apiKeys,
	"/v1/settings": () => settings,
	"/v1/capabilities": () => ({ memory_providers: ["builtin", "mem0"] }),
	"/v1/me/invitations": () =>
		invitations.filter((item) => item.invitee_email === currentUser.email),

	// Agents ---------------------------------------------------------------------

	"/v1/agents": ({ url }) => {
		const projectId = url.searchParams.get("project_id");
		if (!projectId) return [...agents, disconnectAgent, ...hostedStateAgents];
		return [...agents, disconnectAgent, ...hostedStateAgents].filter((agent) =>
			(projectBindingsByAgent[agent.id] ?? []).some((b) => b.project_id === projectId),
		);
	},
	"/v1/agents/{agent_id}": ({ params }) =>
		findAgent(params.agent_id) ?? notFound("Agent not found"),
	"/v1/agents/{agent_id}/project-bindings": ({ params }) =>
		findAgent(params.agent_id)
			? (projectBindingsByAgent[params.agent_id ?? ""] ?? [])
			: notFound("Agent not found"),
	"/v1/agents/{agent_id}/skills": ({ params }) =>
		findAgent(params.agent_id) ? agentSkills(params.agent_id ?? "") : notFound("Agent not found"),
	"/v1/agents/{agent_id}/skill-references/{skill_id}": ({ params }) => {
		const skill = skills.find((s) => s.id === params.skill_id || s.skill_key === params.skill_id);
		return skill ? skillDetail(skill) : notFound("Skill not found");
	},
	"/v1/agents/{agent_id}/agent-plugins": ({ params }) => ({
		plugins: installedPlugins.filter((item) => item.agent_id === params.agent_id),
	}),
	"/v1/agents/{agent_id}/agent-plugins/{plugin_name}": ({ params }) =>
		installedPlugins.find(
			(item) => item.agent_id === params.agent_id && item.plugin_name === params.plugin_name,
		) ?? notFound("Plugin not installed"),
	"/v1/agents/{agent_id}/profiles": ({ params }) =>
		findAgent(params.agent_id) ? agentProfiles(params.agent_id ?? "") : notFound("Agent not found"),
	"/v1/agents/{agent_id}/mcp": ({ params }) => ({
		agent_id: params.agent_id ?? "",
		availability: "unavailable",
		servers: [],
	}),
	"/v1/plugin-catalog": () => pluginCatalog,

	// Sessions -------------------------------------------------------------------

	"/v1/sessions": ({ url }) => {
		const q = url.searchParams.get("q");
		const agent = url.searchParams.get("agent");
		const environmentId = url.searchParams.get("environment_id");
		const automated = url.searchParams.get("automated");
		const profileKey = url.searchParams.get("profile_key");
		const filtered = sessions.filter(
			(session) =>
				matchesQuery(session.summary, q) &&
				(!agent || session.agent_name === agent || session.agent_id === agent) &&
				(!environmentId || session.agent_id === environmentId) &&
				(profileKey === null || session.profile_key === profileKey) &&
				(automated === null || String(session.automated) === automated),
		);
		return paginate(filtered.map(toSessionListItem), url);
	},
	"/v1/sessions/{session_id}": ({ params }) => {
		const session = sessions.find(
			(s) => s.id === params.session_id || s.local_session_id === params.session_id,
		);
		return session ? sessionDetail(session) : notFound("Session not found");
	},
	"/v1/sessions/{session_id}/messages": ({ params, url }) => {
		const session = sessions.find((s) => s.id === params.session_id);
		if (!session) return notFound("Session not found");
		const view = url.searchParams.get("view") ?? "messages";
		const include = new Set(url.searchParams.getAll("include"));
		const items = sessionTimeline(session).filter((item) => {
			const category = item.kind === "message" ? item.role : "tools";
			if (view === "messages") return item.kind === "message";
			if (view === "user" || view === "assistant" || view === "tools") return category === view;
			return include.size === 0 || include.has(category);
		});
		const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
		const limit = Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100);
		const direction = url.searchParams.get("direction");
		const ordered = direction === "desc" ? [...items].reverse() : items;
		return {
			// Must match the web client's `snapshot:<content_hash>` revision fence.
			content_revision: `snapshot:${session.content_hash}`,
			items: ordered.slice(offset, offset + limit),
			total: items.length,
			offset,
			limit,
		};
	},
	"/v1/sessions/{session_id}/shares": ({ params }) => ({
		shares: sessionShares.filter((item) => item.session_id === params.session_id),
	}),
	"/v1/public/session-shares/{share_id}": ({ params }) => {
		const share = sessionShares.find((item) => item.id === params.share_id);
		const session = sessions.find((item) => item.id === share?.session_id);
		if (!share || !session) return notFound("Snapshot not found");
		return {
			id: share.id,
			title: session.summary ?? "Fixture session",
			agent_type: session.agent_type,
			model: session.model,
			started_at: session.started_at,
			created_at: share.created_at,
			message_count: share.message_count,
			scope: share.scope,
		} satisfies Schemas["PublicSessionShareResponse"];
	},
	"/v1/public/session-shares/{share_id}/messages": ({ params }) => {
		const share = sessionShares.find((item) => item.id === params.share_id);
		const session = sessions.find((item) => item.id === share?.session_id);
		if (!share || !session) return notFound("Snapshot not found");
		return {
			items: sessionTimeline(session)
				.filter((item) => item.kind === "message")
				.slice(share.start_position ?? 0, share.end_position + 1),
			total: share.message_count,
			offset: 0,
			limit: 50,
		};
	},
	"/v1/public/sessions/{session_id}": ({ params }) => {
		const session = sessions.find((item) => item.id === params.session_id);
		if (
			!session ||
			!sessionPermissions.some((item) => item.session_id === session.id && item.kind === "link")
		)
			return notFound("Live link not found");
		return {
			...session,
			owner_name: currentUser.name,
			owner_avatar_url: null,
		} satisfies Schemas["PublicSessionResponse"];
	},
	"/v1/public/sessions/{session_id}/messages": ({ params }) => {
		const session = sessions.find((item) => item.id === params.session_id);
		if (
			!session ||
			!sessionPermissions.some((item) => item.session_id === session.id && item.kind === "link")
		)
			return notFound("Live link not found");
		return {
			items: sessionTimeline(session).filter((item) => item.kind === "message"),
			total: session.message_count,
			offset: 0,
			limit: 50,
		};
	},
	"/v1/sessions/{session_id}/permissions": ({ params }) => ({
		permissions: sessionPermissions
			.filter((item) => item.session_id === params.session_id)
			.map(({ session_id: _session, ...permission }) => permission),
	}),
	"/v1/session-shares": ({ url }) =>
		paginate(
			[
				...sessionShares.map(
					(share) =>
						({
							...share,
							kind: "snapshot",
							session_title:
								sessions.find((session) => session.id === share.session_id)?.summary ??
								"Fixture session",
						}) satisfies Schemas["SessionShareListItemResponse"],
				),
				...sessionPermissions
					.filter((permission) => permission.kind === "link")
					.map(
						(permission) =>
							({
								id: permission.id,
								session_id: permission.session_id,
								kind: "live",
								scope: "session",
								session_title:
									sessions.find((session) => session.id === permission.session_id)?.summary ??
									"Fixture session",
								message_count: 4,
								share_url: `${shareOrigin}/s/${permission.session_id}`,
								created_at: permission.created_at,
							}) satisfies Schemas["SessionShareListItemResponse"],
					),
			],
			url,
		),

	// Dashboard ------------------------------------------------------------------

	"/v1/dashboard/stats": () => dashboardStats(),
	"/v1/dashboard/contribution": ({ url }) => {
		const days = Number(url.searchParams.get("days") ?? "365") || 365;
		return contribution.slice(-days);
	},

	// Projects -------------------------------------------------------------------

	"/v1/projects": () => projects.map(withResourceCounts),
	"/v1/projects/default": () => ({ project_id: PROJECT.personal }),
	"/v1/projects/{project_id}": ({ params }) => {
		const project = projectById.get(params.project_id ?? "");
		return project ? withResourceCounts(project) : notFound("Project not found");
	},
	"/v1/projects/{project_id}/members": ({ params }) => {
		const project = invitedProjects.find((item) => item.id === params.project_id);
		if (!project) return members;
		return [
			{
				...members[0],
				role: "member",
				joined_via: "invitation",
				joined_at: ago(0),
				resolved_owner_handle: project.owner_handle,
			},
			{
				...members[1],
				role: "owner",
				joined_via: "owner",
				user_display: project.owner_display,
				user_email: `${project.owner_handle}@example.invalid`,
				resolved_owner_handle: project.owner_handle,
			},
		] satisfies Schemas["MemberResponse"][];
	},
	"/v1/projects/{project_id}/invitations": ({ params }) =>
		invitations.filter((item) => item.project_id === params.project_id),
	"/v1/projects/{project_id}/share-links": ({ params }) =>
		shareLinks[params.project_id ?? ""] ?? [],
	"/v1/share/{token}/preview": ({ params }) => projectPreview(params.token),

	"/v1/projects/{project_id}/skills/{skill_key}": ({ params }) => {
		const skill = skills.find(
			(s) =>
				s.skill_key === params.skill_key &&
				(s.project_id === params.project_id || !params.project_id),
		);
		return skill ? skillDetail(skill) : notFound("Skill not found");
	},

	// Skills ---------------------------------------------------------------------

	"/v1/skills": ({ url }) => {
		const q = url.searchParams.get("q");
		const projectId = url.searchParams.get("project_id");
		const includeContent = url.searchParams.get("include_content") === "true";
		const filtered = skills
			.filter((skill) => matchesQuery(`${skill.name} ${skill.description}`, q))
			.filter((skill) => !projectId || skill.project_id === projectId)
			.map((skill) =>
				includeContent ? { ...skill, content: skillContent(skill.name, skill.description) } : skill,
			);
		return paginate(filtered, url);
	},
	"/v1/skills/{skill_key}": ({ params }) => {
		const skill = skills.find((s) => s.skill_key === params.skill_key);
		return skill ? skillDetail(skill) : notFound("Skill not found");
	},

	// Memories -------------------------------------------------------------------

	"/v1/memories": ({ url }) => {
		const q = url.searchParams.get("q");
		const category = url.searchParams.get("category");
		return paginate(
			memories.filter((m) => matchesQuery(m.content, q) && (!category || m.category === category)),
			url,
		);
	},
	"/v1/memories/{memory_id}": ({ params }) =>
		memories.find((m) => m.id === params.memory_id) ?? notFound("Memory not found"),

	// Vaults ---------------------------------------------------------------------

	"/v1/vault": ({ url }) => {
		const q = url.searchParams.get("q");
		const projectId = url.searchParams.get("project_id");
		return paginate(
			vaults.filter(
				(vault) =>
					matchesQuery(vault.name, q) && (!projectId || vault.project_ids.includes(projectId)),
			),
			url,
		);
	},
	"/v1/vault/detail": ({ url }) => {
		const vaultId = url.searchParams.get("vault_id");
		const slug = url.searchParams.get("slug");
		const vault = vaults.find(
			(candidate) =>
				(slug || vaultId) &&
				(!slug || candidate.slug === slug) &&
				(!vaultId || candidate.id === vaultId),
		);
		return vault ?? notFound("Vault not found");
	},
	"/v1/vault/requests": ({ url }) =>
		vaultRequests.filter(
			(item) =>
				(!url.searchParams.has("vault_id") || item.vault_id === url.searchParams.get("vault_id")) &&
				(!url.searchParams.has("project_id") ||
					item.project_id === url.searchParams.get("project_id")),
		),
	"/v1/vault/requests/{request_id}": ({ params }) =>
		vaultRequests.find((item) => item.id === params.request_id) ?? notFound("Request not found"),
	"/v1/vault/{slug}/items": ({ params }) =>
		vaultSections[params.slug ?? ""] ?? notFound("Vault not found"),

	// Connectors -----------------------------------------------------------------

	"/v1/connectors": () => connectorConnections,
	"/v1/connectors/available": ({ url }) => {
		const search = url.searchParams.get("search");
		return paginate(
			connectorCatalog.filter((app) => matchesQuery(`${app.display_name} ${app.name}`, search)),
			url,
			24,
		);
	},
	"/v1/connectors/available/{app_name}": ({ params }) =>
		connectorCatalog.find((app) => app.name === params.app_name) ?? notFound("App not found"),
	"/v1/connectors/{app_name}/tools": () => connectorTools,
	"/v1/connectors/{app_name}/auth-fields": ({ params }) => ({
		auth_scheme:
			params.app_name === "stripe" || params.app_name === "airtable" ? "API_KEY" : "OAUTH2",
		expected_input_fields:
			params.app_name === "stripe" || params.app_name === "airtable"
				? [
						{
							name: "api_key",
							display_name: "API key",
							description:
								"Use a synthetic value for this fixture. No provider authentication is performed.",
							type: "string",
							required: true,
							is_secret: true,
							expected_from_customer: true,
						} satisfies Schemas["ConnectorAuthFieldResponse"],
					]
				: [],
	}),

	// AI providers + channels -----------------------------------------------------

	"/v1/ai-providers": () => aiProviders,
	"/v1/ai-providers/{provider_id}": ({ params }) =>
		aiProviders.providers.find(
			(p) => p.provider_id === params.provider_id || p.id === params.provider_id,
		) ?? notFound("Provider not found"),
	"/v1/channels": () => allChannelAccounts(),
	"/v1/channels/agent-links": ({ url }) =>
		channelAgentLinks.filter(
			(link) =>
				!url.searchParams.has("agent_id") || link.agent_id === url.searchParams.get("agent_id"),
		),
	"/v1/channels/{account_id}": ({ params }) =>
		allChannelAccounts().find((account) => account.id === params.account_id) ??
		notFound("Channel not found"),
	"/v1/channels/{account_id}/agent-links": ({ params }) =>
		channelAgentLinks
			.filter((link) => link.account_id === params.account_id)
			.map(({ account: _account, binding_count: _count, ...link }) => link),
	"/v1/channels/{account_id}/bindings": ({ params }) =>
		channelBindings.filter((item) => item.account_id === params.account_id),
	"/v1/channels/{account_id}/activity": () => ({ items: [] }),
	"/v1/channels/health": () => ({
		items: allChannelAccounts().map((account) => ({
			account_id: account.id,
			provider: account.provider,
			name: account.name,
			visibility: account.visibility,
			channel_status: account.status,
			health_status: "ok",
			pending_inbox: 0,
			pending_deliveries: 0,
			in_progress_deliveries: 0,
			failed_deliveries: 0,
			last_message_at: ago(3 * HOUR),
		})),
	}),
	"/v1/channels/bot-pool": () => {
		const providers: Schemas["ChannelBotPoolResponse"]["providers"] = {};
		for (const account of allChannelAccounts()) {
			providers[account.provider] ??= [];
			providers[account.provider].push({
				...account,
				access: "owner",
				available: true,
				max_links: null,
				link_count: channelAgentLinks.filter(
					(link) => link.account_id === account.id && link.status === "active",
				).length,
				capabilities: {
					link_agent: true,
					pair_chat: true,
					send_message: true,
					manage_account: true,
					sync_commands: account.provider !== "whatsapp",
				},
			} satisfies Schemas["ChannelBotPoolItem"]);
		}
		return { providers } satisfies Schemas["ChannelBotPoolResponse"];
	},
	"/v1/channels/whatsapp/onboarding/readiness": ({ url }) => ({
		available: url.searchParams.get("available") !== "false",
		manual_pairing_code_supported: true,
		reason: url.searchParams.get("available") === "false" ? "temporarily_unavailable" : null,
	}),
	"/v1/channels/whatsapp/onboarding/sessions/{session_id}": ({ params, url }) => {
		const session = whatsappSessions.get(params.session_id ?? "");
		if (!session) return notFound("Onboarding session not found");
		return url.searchParams.has("state")
			? whatsappSession(session.id, session.name, whatsappState(url.searchParams.get("state")))
			: session;
	},
};

for (const [template, handler] of Object.entries(getRoutes)) {
	routes.push({ method: "GET", template, handler, ...compile(template) });
}

on("PATCH", "/v1/agents/order", () => agents);
on("POST", "/v1/connectors/metadata:batchRead", async ({ request }) =>
	connectorMetadata(await readStringArray(request, "names")),
);
on(
	"PATCH",
	"/v1/agents/{agent_id}",
	({ params }) => findAgent(params.agent_id) ?? notFound("Agent not found"),
);

// Live session streaming is not simulated; the web client treats 404 as terminal.
on(
	"GET",
	"/v1/sessions/{session_id}/content-events",
	() => new Reply(404, { detail: "Not streamed" }),
);

// Read-after-write state is held only by this server process.
let mutationSequence = 0;
function fixtureId() {
	mutationSequence++;
	return `f1700000-0000-4000-8000-${String(mutationSequence).padStart(12, "0")}`;
}
async function bodyObject(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new Reply(400, { detail: "Invalid JSON body" });
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Reply(400, { detail: "Expected a JSON object" });
	}
	return Object.fromEntries(Object.entries(body));
}
function requiredString(body: Record<string, unknown>, field: string) {
	const value = body[field];
	if (typeof value !== "string" || !value.trim() || value.length > 4096) {
		throw new Reply(400, { detail: `Invalid ${field}` });
	}
	return value.trim();
}
function strings(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.some((item: unknown) => typeof item !== "string" || !item.trim())
	) {
		throw new Reply(400, { detail: "Expected a list of field names" });
	}
	return value.filter((item): item is string => typeof item === "string");
}
function removeWhere<T>(items: T[], predicate: (item: T) => boolean) {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) items.splice(index, 1);
	}
}
function projectPreview(token: string | undefined): Schemas["ShareRedeemResponse"] | Reply {
	const project = projects.find((item) => item.id === projectTokens.get(token ?? ""));
	if (!project) return notFound("Invite token not found");
	return {
		project_id: project.id,
		project_name: project.name,
		owner_display: project.owner_display,
		owner_handle: project.owner_handle,
		skill_count: project.skill_count,
		vault_count: project.vault_count,
		vault_locked: true,
	} satisfies Schemas["ShareRedeemResponse"];
}
function requestByToken(token: string) {
	const item = vaultRequests.find((row) => row.id === vaultTokens.get(token));
	if (!item) throw notFound("Supply token not found");
	return item;
}

on("PATCH", "/v1/settings", async ({ request }) => {
	const body = await bodyObject(request);
	const patch = body.settings;
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		return new Reply(400, { detail: "Invalid settings" });
	}
	const provider: unknown = Reflect.get(patch, "memory_provider");
	const key: unknown = Reflect.get(patch, "mem0_api_key");
	if (provider !== undefined && provider !== "builtin" && provider !== "mem0") {
		return new Reply(400, { detail: "Invalid memory provider" });
	}
	if (key !== undefined && key !== null && typeof key !== "string") {
		return new Reply(400, { detail: "Invalid Mem0 key" });
	}
	if (provider !== undefined) settings.memory_provider = provider;
	if (key !== undefined) {
		settings.mem0_api_key_configured = typeof key === "string" && key.trim().length > 0;
		settings.mem0_api_key = settings.mem0_api_key_configured ? "fixture-mem0-configured" : null;
	}
	return { status: "updated" } satisfies Schemas["SettingsUpdateResponse"];
});
// Personal API key creation is retired; the backend answers 410 with this detail.
on(
	"POST",
	"/v1/auth/keys",
	() =>
		new Reply(410, {
			detail:
				"API keys can no longer be created. Run `clawdi auth login` (use `--no-open` on a server). Existing keys keep working until revoked.",
		}),
);
on("DELETE", "/v1/auth/keys/{key_id}", ({ params }) => {
	removeWhere(apiKeys, (item) => item.id === params.key_id);
	return { status: "revoked" } satisfies Schemas["ApiKeyRevokeResponse"];
});
on("POST", "/v1/projects/{project_id}/invitations", async ({ params, request }) => {
	const project = projects.find((item) => item.id === params.project_id);
	if (!project) return notFound("Project not found");
	const email = requiredString(await bodyObject(request), "email");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Reply(400, { detail: "Invalid email" });
	const invitation = {
		...invitationSeeds[0],
		id: fixtureId(),
		project_id: project.id,
		project_name: project.name,
		invitee_email: email,
		created_at: ago(0),
	} satisfies Schemas["InvitationResponse"];
	invitations.push(invitation);
	return invitation;
});
on("DELETE", "/v1/projects/{project_id}/invitations/{invitation_id}", ({ params }) => {
	invitations = invitations.filter(
		(item) => !(item.id === params.invitation_id && item.project_id === params.project_id),
	);
	return { status: "cancelled" } satisfies Schemas["InvitationCancelResponse"];
});
for (const action of ["accept", "decline"]) {
	on("POST", `/v1/me/invitations/{invitation_id}/${action}`, ({ params }) => {
		const invitation = invitations.find(
			(item) => item.id === params.invitation_id && item.invitee_email === currentUser.email,
		);
		if (!invitation) return notFound("Invitation not found");
		invitations = invitations.filter((item) => item.id !== invitation.id);
		if (action === "decline")
			return { status: "declined" } satisfies Schemas["InvitationDeclineResponse"];
		const project = invitedProjects.find((item) => item.id === invitation.project_id);
		if (project && !projects.some((item) => item.id === project.id)) {
			projects.push(project);
			projectById.set(project.id, project);
		}
		return {
			id: fixtureId(),
			project_id: invitation.project_id,
			role: "member",
			joined_via: "invitation",
			joined_at: ago(0),
			resolved_owner_handle: invitation.owner_handle,
			bound_agent_ids: [],
		} satisfies Schemas["InvitationAcceptResponse"];
	});
}
on("POST", "/v1/projects/{project_id}/share-links", async ({ params, request }) => {
	const project = projects.find((item) => item.id === params.project_id);
	if (!project) return notFound("Project not found");
	const body = await bodyObject(request);
	const id = fixtureId();
	const token = projectTokenForId(id);
	const label = typeof body.label === "string" ? body.label : null;
	const created = {
		id,
		raw_token: token,
		url: `${shareOrigin}/share/${token}`,
		prefix: token.slice(0, 12),
		owner_handle: project.owner_handle,
		label,
		created_at: ago(0),
		expires_at: ago(-7 * DAY),
	} satisfies Schemas["ShareLinkCreated"];
	shareLinks[project.id] ??= [];
	shareLinks[project.id].push({
		id,
		prefix: created.prefix,
		label,
		created_at: created.created_at,
		expires_at: created.expires_at,
		revoked_at: null,
		redeem_count: 0,
		last_redeemed_at: null,
	} satisfies Schemas["ShareLinkResponse"]);
	projectTokens.set(token, project.id);
	return created;
});
on("DELETE", "/v1/projects/{project_id}/share-links/{link_id}", ({ params }) => {
	const links = shareLinks[params.project_id ?? ""] ?? [];
	const link = links.find((item) => item.id === params.link_id);
	if (!link) return notFound("Share link not found");
	link.revoked_at = ago(0);
	for (const [token, projectId] of projectTokens) {
		if (projectId === params.project_id && token === projectTokenForId(link.id))
			projectTokens.delete(token);
	}
	if (link.id === "51aee000-0001-4000-8000-000000000001") projectTokens.delete(PROJECT_TOKEN);
	return { status: "revoked" } satisfies Schemas["ShareLinkRevokeResponse"];
});
on("POST", "/v1/share/{token}/redeem", ({ params }) => projectPreview(params.token));
on("POST", "/v1/share/{token}/upgrade", ({ params }) => {
	const preview = projectPreview(params.token);
	if (preview instanceof Reply) return preview;
	return {
		membership_id: fixtureId(),
		project_id: preview.project_id,
		role: "member",
		joined_via: "link",
		joined_at: ago(0),
		resolved_owner_handle: preview.owner_handle,
		bound_agent_ids: [],
	} satisfies Schemas["ShareUpgradeResponse"];
});
on("POST", "/v1/vault/requests", async ({ request }) => {
	const body = await bodyObject(request);
	const vaultId = requiredString(body, "vault_id");
	const projectId = requiredString(body, "project_id");
	const vault = vaults.find((item) => item.id === vaultId && item.project_ids.includes(projectId));
	const project = projects.find((item) => item.id === projectId);
	if (!vault || !project) return notFound("Vault project attachment not found");
	const fields = strings(body.fields);
	if (!fields.length) return new Reply(400, { detail: "At least one field is required" });
	const section = requiredString(body, "section");
	const id = fixtureId();
	const token = `v2_${id.replaceAll("-", "").padEnd(43, "0")}`;
	const item = {
		...vaultRequests[0],
		id,
		vault_id: vault.id,
		project_id: project.id,
		vault_name: vault.name,
		project_name: project.name,
		slug: vault.slug,
		section,
		fields,
		extra_fields: [],
		update_fields: [],
		status: "pending",
		supplied_at: null,
		references: Object.fromEntries(
			fields.map((field) => [field, `vault://${vault.slug}/${field}`]),
		),
	} satisfies Schemas["VaultSecretRequestStatus"];
	vaultRequests.push(item);
	vaultTokens.set(token, id);
	return {
		...item,
		url: `${shareOrigin}/vault-request#${token}`,
	} satisfies Schemas["VaultSecretRequestCreated"];
});
on("POST", "/v1/vault/requests/inspect", async ({ request }) => {
	const body = await bodyObject(request);
	const item = requestByToken(requiredString(body, "token"));
	const requested = body.fields === undefined ? item.fields : strings(body.fields);
	return {
		...item,
		extra_fields: requested.filter((field) => !item.fields.includes(field)),
		update_fields: requested.filter((field) =>
			Object.values(vaultSections[item.slug] ?? {}).some((keys) => keys.includes(field)),
		),
	} satisfies Schemas["VaultSecretRequestStatus"];
});
on("POST", "/v1/vault/requests/supply", async ({ request }) => {
	const body = await bodyObject(request);
	const item = requestByToken(requiredString(body, "token"));
	const values = body.fields;
	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		return new Reply(400, { detail: "Invalid fields" });
	}
	const entries = Object.entries(values);
	if (
		entries.some(([name, value]) => !name.trim() || typeof value !== "string" || !value.trim()) ||
		item.fields.some((field) => !entries.some(([name]) => name === field))
	) {
		return new Reply(400, { detail: "Missing requested field values" });
	}
	item.extra_fields = entries.map(([name]) => name).filter((name) => !item.fields.includes(name));
	item.update_fields = entries
		.map(([name]) => name)
		.filter((name) =>
			Object.values(vaultSections[item.slug] ?? {}).some((keys) => keys.includes(name)),
		);
	// Values are intentionally discarded: only receipt metadata survives.
	item.status = "supplied";
	item.supplied_at = ago(0);
	item.content_version++;
	return item;
});

on("POST", "/v1/channels/whatsapp/onboarding/sessions", async ({ request }) => {
	const body = await bodyObject(request);
	const requestId = requiredString(body, "request_id");
	const previous = whatsappRequests.get(requestId);
	if (previous) return whatsappSessions.get(previous);
	const session = whatsappSession(fixtureId(), requiredString(body, "name"));
	whatsappSessions.set(session.id, session);
	if (session.state === "connected") {
		whatsappAccount.status = "active";
		whatsappAccount.has_provider_token = true;
	}
	whatsappRequests.set(requestId, session.id);
	return session;
});
for (const action of ["cancel", "retry", "pairing-code"]) {
	on(
		"POST",
		`/v1/channels/whatsapp/onboarding/sessions/{session_id}/${action}`,
		async ({ params, request }) => {
			const session = whatsappSessions.get(params.session_id ?? "");
			if (!session) return notFound("Onboarding session not found");
			if (action === "pairing-code") {
				const phone = requiredString(await bodyObject(request), "phone_number");
				if (!/^\+?\d{7,15}$/.test(phone)) return new Reply(400, { detail: "Invalid phone number" });
				session.state = "ready";
				session.method = "code";
				session.pairing_code = "1234-5678";
				session.qr = null;
			} else if (action === "cancel") {
				session.state = "canceled";
				session.qr = null;
				session.pairing_code = null;
			} else {
				Object.assign(session, whatsappSession(session.id, session.name));
			}
			return session;
		},
	);
}
on("POST", "/v1/channels/whatsapp/onboarding/accounts/{account_id}/repair", ({ params }) => {
	if (params.account_id !== WHATSAPP_ACCOUNT) return notFound("WhatsApp account not found");
	const session = whatsappSession(fixtureId(), whatsappAccount.name);
	whatsappSessions.set(session.id, session);
	if (session.state === "connected") {
		whatsappAccount.status = "active";
		whatsappAccount.has_provider_token = true;
	}
	return session;
});
on("POST", "/v1/channels/{account_id}/pair-codes", async ({ params, request }) => {
	const account = allChannelAccounts().find((item) => item.id === params.account_id);
	if (!account) return notFound("Channel not found");
	const body = await bodyObject(request);
	const link = channelAgentLinks.find(
		(item) =>
			item.account_id === account.id &&
			(body.agent_link_id
				? item.id === body.agent_link_id
				: !body.agent_id || item.agent_id === body.agent_id),
	);
	if (!link) return notFound("Agent link not found");
	return {
		id: fixtureId(),
		agent_link_id: link.id,
		agent_id: link.agent_id,
		code: "FIXTURE42",
		expires_at: ago(-5 * MINUTE),
		pairing_command: "/pair FIXTURE42",
		bot_username: account.provider === "telegram" ? "acme_ops_bot" : null,
		deep_link: account.provider === "telegram" ? "https://t.me/acme_ops_bot?start=FIXTURE42" : null,
		qr_payload:
			account.provider === "telegram"
				? "https://t.me/acme_ops_bot?start=FIXTURE42"
				: "fixture-only-pair-FIXTURE42",
		discord_install_url:
			account.provider === "discord" ? "https://example.invalid/fixture-discord" : null,
	} satisfies Schemas["ChannelPairCodeResponse"];
});
on("POST", "/v1/channels/{account_id}/agent-links", async ({ params, request }) => {
	const account = allChannelAccounts().find((item) => item.id === params.account_id);
	if (!account) return notFound("Channel not found");
	const body = await bodyObject(request);
	const agentId = requiredString(body, "agent_id");
	if (!findAgent(agentId)) return notFound("Agent not found");
	if (account.provider === "whatsapp" && account.status !== "active") {
		return new Reply(409, { detail: "whatsapp_repair_required" });
	}
	const link = {
		id: fixtureId(),
		account_id: account.id,
		agent_id: agentId,
		status: "active",
		runtime_status: "connected",
		created_at: ago(0),
		agent_token: null,
	} satisfies Schemas["ChannelAgentLinkResponse"];
	const previous = channelAgentLinks.filter(
		(item) => item.agent_id === agentId && item.account.provider === account.provider,
	);
	if (previous.length && body.replace_existing_provider_link !== true) {
		return new Reply(409, { detail: "Provider link replacement requires explicit consent" });
	}
	removeWhere(channelBindings, (binding) =>
		previous.some((item) => item.id === binding.agent_link_id),
	);
	// Replacement is confined to the same agent/provider, as in the API contract.
	removeWhere(
		channelAgentLinks,
		(item) => item.agent_id === agentId && item.account.provider === account.provider,
	);
	channelAgentLinks.push({ ...link, account, binding_count: 0 });
	return link;
});
on("DELETE", "/v1/channels/{account_id}/agent-links/{link_id}", ({ params }) => {
	removeWhere(
		channelAgentLinks,
		(item) => item.account_id === params.account_id && item.id === params.link_id,
	);
	removeWhere(channelBindings, (item) => item.agent_link_id === params.link_id);
	return new Reply(204, null);
});
on("DELETE", "/v1/channels/{account_id}/bindings/{binding_id}", ({ params }) => {
	const item = channelBindings.find(
		(binding) => binding.id === params.binding_id && binding.account_id === params.account_id,
	);
	if (!item) return notFound("Paired chat not found");
	removeWhere(channelBindings, (binding) => binding.id === item.id);
	const link = channelAgentLinks.find((candidate) => candidate.id === item.agent_link_id);
	if (link)
		link.binding_count = channelBindings.filter(
			(binding) => binding.agent_link_id === link.id,
		).length;
	return {
		binding_id: item.id,
		unpaired: true,
		notification_status: "sent",
		provider_cleanup_status: "succeeded",
		warning: null,
	} satisfies Schemas["ChannelBindingDeleteResponse"];
});
on("POST", "/v1/channels/{account_id}/commands/sync", ({ params }) => {
	const account = allChannelAccounts().find((item) => item.id === params.account_id);
	if (!account) return notFound("Channel not found");
	return {
		provider: account.provider,
		commands: [
			{ name: "ask", description: "Ask the linked Agent" },
			{ name: "new", description: "Start a new conversation" },
		],
	} satisfies Schemas["ChannelCommandSyncResponse"];
});
on("PUT", "/v1/agents/{agent_id}/agent-plugins/{plugin_name}", ({ params }) => {
	const plugin = pluginCatalog.plugins.find((item) => item.name === params.plugin_name);
	const agent = findAgent(params.agent_id);
	if (!agent || !plugin) return notFound("Agent or plugin not found");
	const item = {
		...installedPlugins[0],
		installation_id: fixtureId(),
		agent_id: agent.id,
		plugin_name: plugin.name,
		version: plugin.version,
		catalog_revision: pluginCatalog.revision,
		desired_state: "present",
		convergence: "installed",
		created_at: ago(0),
		updated_at: ago(0),
	} satisfies Schemas["AgentPluginDesiredStateResponse"];
	removeWhere(
		installedPlugins,
		(row) => row.agent_id === item.agent_id && row.plugin_name === item.plugin_name,
	);
	installedPlugins.push(item);
	return item;
});
on("DELETE", "/v1/agents/{agent_id}/agent-plugins/{plugin_name}", ({ params }) => {
	removeWhere(
		installedPlugins,
		(item) => item.agent_id === params.agent_id && item.plugin_name === params.plugin_name,
	);
	return {
		agent_id: params.agent_id ?? "",
		plugin_name: params.plugin_name ?? "",
		desired_state: "absent",
		convergence: "not_observed",
	} satisfies Schemas["AgentPluginDesiredStateDeleteResponse"];
});
on("POST", "/v1/sessions/{session_id}/shares", async ({ params, request }) => {
	const session = sessions.find((item) => item.id === params.session_id);
	if (!session) return notFound("Session not found");
	const body = await bodyObject(request);
	const scope = body.scope;
	if (scope !== "session" && scope !== "through" && scope !== "response")
		return new Reply(400, { detail: "Invalid scope" });
	const position =
		typeof body.position === "number" && Number.isInteger(body.position) ? body.position : 3;
	const id = fixtureId();
	const share = {
		id,
		session_id: session.id,
		scope,
		start_position: scope === "response" ? position : null,
		end_position: position,
		message_count: scope === "response" ? 1 : position + 1,
		share_url: `${shareOrigin}/s/${id}`,
		created_at: ago(0),
	} satisfies Schemas["SessionShareResponse"];
	sessionShares.push(share);
	return share;
});
on("DELETE", "/v1/session-shares/{share_id}", ({ params }) => {
	removeWhere(sessionShares, (item) => item.id === params.share_id);
	removeWhere(sessionPermissions, (item) => item.id === params.share_id);
	return new Reply(204, null);
});
on("DELETE", "/v1/sessions/{session_id}/permissions", ({ params }) => {
	removeWhere(sessionPermissions, (item) => item.session_id === params.session_id);
	return new Reply(204, null);
});
on("POST", "/v1/sessions/{session_id}/permissions", async ({ params, request }) => {
	const kind = (await bodyObject(request)).kind;
	if (kind !== "link" && kind !== "email" && kind !== "user")
		return new Reply(400, { detail: "Invalid permission kind" });
	const permission = {
		id: fixtureId(),
		kind,
		role: "viewer",
		created_at: ago(0),
		expires_at: null,
	} satisfies Schemas["SessionPermissionResponse"];
	sessionPermissions.push({ ...permission, session_id: params.session_id ?? "" });
	return permission;
});

on("POST", "/v1/connectors/{app_name}/connect-credentials", async ({ params, request }) => {
	if (params.app_name !== "stripe" && params.app_name !== "airtable")
		return notFound("Credential connector not found");
	await bodyObject(request); // Never retain submitted credential values.
	const id = fixtureId();
	connectorConnections.push({
		id,
		app_name: params.app_name,
		status: "ACTIVE",
		created_at: ago(0),
		is_disabled: false,
		alias: null,
		account_display: "Fixture account",
	});
	return {
		id,
		status: "ACTIVE",
		ok: true,
	} satisfies Schemas["ConnectorCredentialsConnectResponse"];
});

function oauthAuthorization(providerId: string) {
	return {
		flow: "device_code",
		provider_id: providerId,
		oauth_provider: "openai-codex",
		profile: "default",
		// Native validates this exact upstream URL; the fixture never opens it.
		verification_url: "https://auth.openai.com/codex/device",
		user_code: "FIXT-URE1",
		state: "fixture-oauth-ready",
		expires_at: ago(-15 * MINUTE),
		poll_interval_seconds: 2,
	} satisfies Schemas["AiProviderOAuthDeviceStartResponse"];
}
on("POST", "/v1/ai-providers/{provider_id}/auth/oauth/device/start", ({ params }) =>
	oauthAuthorization(params.provider_id ?? "openai"),
);
on("POST", "/v1/ai-providers/{provider_id}/auth/oauth/device/poll", async ({ params, request }) => {
	const body = await bodyObject(request);
	if (body.state !== "fixture-oauth-ready")
		return new Reply(400, { detail: "Invalid fixture OAuth state" });
	const provider = aiProviders.providers.find(
		(item) => item.provider_id === params.provider_id || item.id === params.provider_id,
	);
	if (!provider) return notFound("Provider not found");
	return { status: "ready", provider } satisfies Schemas["AiProviderOAuthDeviceReadyResponse"];
});
on("POST", "/v1/ai-providers/accept", async ({ request }) => {
	const body = await bodyObject(request);
	if (typeof body.credential !== "object" || body.credential === null)
		return new Reply(400, { detail: "Invalid credential" });
	const type: unknown = Reflect.get(body.credential, "type");
	const provider = aiProviders.providers[1];
	if (type === "oauth")
		return {
			status: "pending",
			provider,
			authorization: oauthAuthorization(provider.provider_id),
		} satisfies Schemas["AiProviderOAuthPendingAcceptResponse"];
	return { status: "ready", provider } satisfies Schemas["AiProviderReadyAcceptResponse"];
});

// Generic mutation fallbacks: plausible success, nothing persisted.
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
	on(method, "/v1/{rest}", ({ request }) =>
		request.method === "DELETE" ? new Reply(204, null) : { ok: true },
	);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function corsHeaders(request: Request): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": request.headers.get("origin") ?? "*",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers":
			request.headers.get("access-control-request-headers") ?? "authorization, content-type",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function json(request: Request, status: number, body: unknown) {
	const headers = corsHeaders(request);
	if (status === 204) return new Response(null, { status, headers });
	const elapsed = Date.now() - NOW;
	const text = JSON.stringify(body, (_key, value: unknown) =>
		typeof value === "string" && ISO_TIMESTAMP.test(value)
			? new Date(Date.parse(value) + elapsed).toISOString()
			: value,
	);
	return new Response(text, {
		status,
		headers: { ...headers, "Content-Type": "application/json" },
	});
}

const PUBLIC_PATHS = new Set(["/health", "/ready"]);

// `--account-state suspended`: every authenticated request answers like a suspended account.
// Cloud sends 401; hosted (clawdi-hosted `AccountSuspendedHTTPException`) sends the same body as 403.
const accountSuspended = readFlag("account-state", "active") === "suspended";
const accountSuspendedProblem = {
	type: "urn:clawdi:problem:account-suspended",
	title: "Account suspended",
	status: 401,
	detail: "Account is suspended",
	code: "account_suspended",
} satisfies Schemas["AccountSuspendedProblem"];

/** Hosted paths from deploy.generated.ts; cloud owns only runtime-internal `/v2/runtime/*`. */
function isHostedPath(pathname: string): boolean {
	return (
		(pathname.startsWith("/v2/") && !pathname.startsWith("/v2/runtime/")) ||
		pathname === "/v1/me" ||
		pathname === "/v1/agent-environments" ||
		pathname === "/v1/me/notifications" ||
		pathname.startsWith("/v1/me/notifications/")
	);
}

function resolve(method: string, pathname: string) {
	for (const route of routes) {
		if (route.method !== method) continue;
		// The generic `/v1/{rest}` fallback should accept nested paths.
		const match =
			route.template === "/v1/{rest}"
				? pathname.match(/^\/v1\/(.+)$/)
				: pathname.match(route.pattern);
		if (!match) continue;
		const params: Record<string, string> = {};
		route.keys.forEach((key, index) => {
			params[key] = decodeURIComponent(match[index + 1] ?? "");
		});
		return { route, params };
	}
	return null;
}

// Static collection subpaths must precede parameterized detail routes.
// Otherwise /channels/health and /channels/bot-pool resolve as account IDs.
routes.sort((a, b) => {
	const fallbackOrder = Number(a.template === "/v1/{rest}") - Number(b.template === "/v1/{rest}");
	return fallbackOrder || a.keys.length - b.keys.length;
});

const server = Bun.serve({
	port,
	hostname,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders(request) });
		}
		const authorization = request.headers.get("authorization") ?? "";
		if (
			!PUBLIC_PATHS.has(url.pathname) &&
			!url.pathname.startsWith("/v1/public/") &&
			!/^\/v1\/share\/[^/]+\/preview$/.test(url.pathname) &&
			!["/v1/vault/requests/inspect", "/v1/vault/requests/supply"].includes(url.pathname) &&
			!/^Bearer\s+\S+/i.test(authorization)
		) {
			return json(request, 401, { detail: "Missing bearer token" });
		}
		if (accountSuspended && /^Bearer\s+\S+/i.test(authorization)) {
			const status = isHostedPath(url.pathname) ? 403 : 401;
			return json(request, status, { ...accountSuspendedProblem, status });
		}
		const resolved = resolve(request.method, url.pathname);
		if (!resolved) {
			console.error(`[fixture-api] UNHANDLED ${request.method} ${url.pathname}${url.search}`);
			return json(request, 404, { detail: `No fixture for ${request.method} ${url.pathname}` });
		}
		try {
			const result = await resolved.route.handler({ params: resolved.params, url, request });
			if (result instanceof Reply) {
				if (result.httpStatus >= 400) {
					console.error(
						`[fixture-api] fixture ${result.httpStatus} ${request.method} ${url.pathname}`,
					);
				}
				return json(request, result.httpStatus, result.payload);
			}
			return json(request, 200, result);
		} catch (error) {
			if (error instanceof Reply) return json(request, error.httpStatus, error.payload);
			console.error(`[fixture-api] 500 ${request.method} ${url.pathname}`, error);
			return json(request, 500, { detail: "Fixture handler failed" });
		}
	},
});

console.log(`[fixture-api] listening on http://${hostname}:${server.port}`);
console.log(
	`[fixture-api] ${agents.length + hostedStateAgents.length + 1} agents, ${sessions.length} sessions, ${projects.length} projects, ${skills.length} skills`,
);
