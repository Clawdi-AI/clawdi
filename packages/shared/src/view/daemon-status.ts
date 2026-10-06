import type { components } from "../api/api.generated";

type Env = components["schemas"]["AgentResponse"];
type DaemonSyncEvidence = Pick<Env, "sync_enabled" | "last_sync_at" | "last_sync_error">;

// Runtime reports every 60 +/- 15 seconds. Match the backend's two-interval window.
export const FRESH_WINDOW_MS = 150_000;

export type DaemonStatusKind = "live" | "set-up" | "errored" | "paused";
export type DaemonStatusSource = "self-managed" | "on-clawdi";

export type DaemonStatusVisual = {
	kind: DaemonStatusKind;
	label: string;
	badgeLabel: string;
	compactLabel: string;
	tooltip: string;
	dotClass: string;
	textClass: string;
};

// Tolerate small clock skew between server and browser (server
// timestamps can land 1-2s ahead of `Date.now()` on a fast NTP
// drift). We only flip to "paused" when the future-ness exceeds
// this window; anything within is clamped to "fresh".
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

// `last_sync_error` is daemon-controlled (caps at 2KB server-side)
// and rendered raw inside <code>. JSX escapes HTML so XSS isn't
// the worry, but a 2 KB error with embedded newlines / ANSI codes
// would explode the card layout. Clamp client-side and replace
// control chars with a single space.
const ERROR_DISPLAY_MAX = 240;
export function formatErrorForDisplay(raw: string): string {
	// Strip the daemon-side `permanent:` / `retry_exhausted:`
	// prefix from the user-visible error string. The prefix is a
	// UI signal (drives which copy renders below) and showing it
	// verbatim in the error <code> block reads as a typo /
	// internal token. The error itself ("API error 413: ...")
	// still appears.
	const stripped = raw.startsWith("permanent: ")
		? raw.slice("permanent: ".length)
		: raw.startsWith("retry_exhausted: ")
			? raw.slice("retry_exhausted: ".length)
			: raw;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: targeting log noise
	const cleaned = stripped.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, " ");
	if (cleaned.length <= ERROR_DISPLAY_MAX) return cleaned;
	return `${cleaned.slice(0, ERROR_DISPLAY_MAX)}…`;
}

/** Daemon stamps `permanent: <msg>` on `last_sync_error` when a
 * queue item hits a 4xx that won't change on retry (skill too
 * big, malformed, validation reject). "It will keep retrying"
 * copy is wrong — the daemon has dropped the item and the user
 * must take action (trim the skill, fix auth, etc.). */
export function isPermanentError(raw: string | null | undefined): boolean {
	return typeof raw === "string" && raw.startsWith("permanent: ");
}

/** Daemon stamps `retry_exhausted: <msg>` when MAX_QUEUE_ATTEMPTS
 * retries have failed for a transient condition (network outage,
 * 5xx, 408/429). Distinct from `permanent:` because the periodic
 * rescan auto-re-enqueues the same content once the underlying
 * condition clears — no user action required. UI shows that the
 * daemon stopped this retry cycle and will pick the item up again
 * automatically when connectivity is back. */
export function isRetryExhaustedError(raw: string | null | undefined): boolean {
	return typeof raw === "string" && raw.startsWith("retry_exhausted: ");
}

export function classifyDaemonStatus(env: DaemonSyncEvidence | null | undefined): DaemonStatusKind {
	if (!env) return "set-up";
	// Treat "never heartbeated" the same as "sync disabled" from
	// the user's POV — both mean the daemon isn't running on this
	// machine, both have the same fix (install + run it).
	if (!env.sync_enabled || !env.last_sync_at) return "set-up";
	const ts = new Date(env.last_sync_at).getTime();
	// Malformed ISO → NaN. Treat as paused so the user notices,
	// rather than silently falling through to "live".
	if (!Number.isFinite(ts)) return "paused";
	const age = Date.now() - ts;
	// `errored` outranks `paused`: a daemon that last checked in
	// 3 minutes ago WITH an error should surface the error, not
	// the staleness. The error is the actionable signal; paused
	// is just "we haven't heard". Without this ordering the badge
	// said "paused" while the body still rendered the error,
	// which read inconsistently.
	if (env.last_sync_error) return "errored";
	// Future timestamps within the skew tolerance are normal NTP
	// drift; only flip to paused when the daemon is implausibly
	// far ahead (probably bad data, not legit state).
	if (age < -CLOCK_SKEW_TOLERANCE_MS) return "paused";
	if (age > FRESH_WINDOW_MS) return "paused";
	return "live";
}

const STATUS_TOOLTIP: Record<DaemonStatusKind, string> = {
	live: "Sync is live.",
	"set-up": "Run setup to enable sync.",
	errored: "Last sync failed.",
	paused: "Daemon isn't checking in.",
};

const DOT_TONE: Record<DaemonStatusKind, string> = {
	live: "size-1.5 shrink-0 rounded-full bg-success",
	"set-up": "size-1.5 shrink-0 rounded-full bg-muted-foreground",
	errored: "size-1.5 shrink-0 rounded-full bg-destructive",
	paused: "size-1.5 shrink-0 rounded-full bg-warning",
};

const TEXT_TONE: Record<DaemonStatusKind, string> = {
	live: "text-muted-foreground",
	"set-up": "text-muted-foreground",
	errored: "text-destructive-muted-foreground font-medium",
	paused: "text-warning-muted-foreground font-medium",
};

/** Inline meta item — sits in the SAME meta/sub-line as
 * "Codex · darwin · last seen 16m ago", styled as a small dot +
 * short text in muted tone so it reads as one more entry in that
 * row, not as a competing visual element. The label is short on
 * purpose ("Live", "Set up", "Error", "Paused") because the row
 * is already crowded; full phrasing lives in the tooltip + dialog.
 *
 * Click on a non-live state opens the help dialog with the right
 * fix command. Click on `live` is a no-op (informational only). */
const SHORT_LABEL: Record<DaemonStatusKind, string> = {
	live: "Live sync",
	"set-up": "Set up live sync",
	errored: "Sync error",
	paused: "Sync paused",
};

const COMPACT_LABEL: Record<DaemonStatusKind, string> = {
	live: "Live",
	"set-up": "Setup",
	errored: "Error",
	paused: "Paused",
};

const DOT_LABEL: Record<DaemonStatusKind, string> = {
	live: "Live",
	"set-up": "Setup",
	errored: "Sync error",
	paused: "Sync paused",
};

export function daemonStatusVisual(
	env: DaemonSyncEvidence | null | undefined,
	source: DaemonStatusSource = "self-managed",
): DaemonStatusVisual {
	const kind = classifyDaemonStatus(env);
	const isHosted = source === "on-clawdi";
	const setupLabel = isHosted ? "Sync pending" : DOT_LABEL[kind];
	const label = kind === "set-up" ? setupLabel : DOT_LABEL[kind];
	const badgeLabel = isHosted && kind === "set-up" ? "Sync pending" : SHORT_LABEL[kind];
	const compactLabel = isHosted && kind === "set-up" ? "Pending" : COMPACT_LABEL[kind];
	const tooltip = isHosted
		? kind === "set-up"
			? "Sync will start with the agent's next update."
			: kind === "paused"
				? "Sync status is unavailable. Manage this agent in agent settings."
				: STATUS_TOOLTIP[kind]
		: STATUS_TOOLTIP[kind];

	return {
		kind,
		label,
		badgeLabel,
		compactLabel,
		tooltip,
		dotClass: DOT_TONE[kind],
		textClass: TEXT_TONE[kind],
	};
}

export type StatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

const DAEMON_STATUS_TONES: Record<DaemonStatusKind, StatusTone> = {
	live: "success",
	"set-up": "neutral",
	errored: "destructive",
	paused: "warning",
};

export function daemonStatusPresentation(
	env: DaemonSyncEvidence | null | undefined,
	source: DaemonStatusSource = "self-managed",
): { tone: StatusTone; label: string } {
	const visual = daemonStatusVisual(env, source);
	return { tone: DAEMON_STATUS_TONES[visual.kind], label: visual.label };
}
