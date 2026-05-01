/**
 * Live-sync indicator for agents on the dashboard.
 *
 * One badge component used everywhere an agent renders — overview
 * tile, agent detail hero meta line, picker. Four states (live /
 * set-up / errored / paused) each get a colored dot + short label
 * in muted tone so the badge reads as one more meta item next to
 * "darwin · last seen 16m ago". Clicking opens `<SyncHelpDialog>`
 * with the install command, last error, restart instructions —
 * whatever's relevant to the current state.
 */

"use client";

import type { components } from "@clawdi/shared/api";
import { Rocket, Terminal } from "lucide-react";
import { useState } from "react";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, relativeTime } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

const FRESH_WINDOW_MS = 90_000;

type Status = "live" | "set-up" | "errored" | "paused";

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
function formatErrorForDisplay(raw: string): string {
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
function isPermanentError(raw: string | null | undefined): boolean {
	return typeof raw === "string" && raw.startsWith("permanent: ");
}

/** Daemon stamps `retry_exhausted: <msg>` when MAX_QUEUE_ATTEMPTS
 * retries have failed for a transient condition (network outage,
 * 5xx, 408/429). Distinct from `permanent:` because the periodic
 * rescan auto-re-enqueues the same content once the underlying
 * condition clears — no user action required. UI shows "the
 * daemon gave up retrying for now; next sync cycle will pick
 * this up automatically when connectivity is back." */
function isRetryExhaustedError(raw: string | null | undefined): boolean {
	return typeof raw === "string" && raw.startsWith("retry_exhausted: ");
}

function classify(env: Env): Status {
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

const STATUS_TOOLTIP: Record<Status, string> = {
	live: "Sync is live.",
	"set-up": "Run setup to enable sync.",
	errored: "Last sync failed.",
	paused: "Daemon isn't checking in.",
};

const DOT_TONE: Record<Status, string> = {
	live: "bg-emerald-500 ring-2 ring-emerald-500/20",
	"set-up": "border-dashed border border-muted-foreground/50 bg-transparent",
	errored: "bg-amber-500 ring-2 ring-amber-500/20",
	paused: "bg-rose-500 ring-2 ring-rose-500/20",
};

const TEXT_TONE: Record<Status, string> = {
	live: "text-foreground",
	"set-up": "text-muted-foreground",
	errored: "text-amber-700 dark:text-amber-300 font-medium",
	paused: "text-rose-700 dark:text-rose-300 font-medium",
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
const SHORT_LABEL: Record<Status, string> = {
	live: "Live sync",
	"set-up": "Set up live sync",
	errored: "Sync error",
	paused: "Sync paused",
};

export function DaemonStatusBadge({ env }: { env: Env }) {
	const status = classify(env);
	const [open, setOpen] = useState(false);
	const inner = (
		<span
			className={cn(
				"inline-flex items-center gap-1.5",
				status === "live" ? "text-muted-foreground" : TEXT_TONE[status],
				"cursor-pointer hover:text-foreground",
			)}
		>
			<span aria-hidden className={cn("inline-block size-1.5 rounded-full", DOT_TONE[status])} />
			<span>{SHORT_LABEL[status]}</span>
		</span>
	);
	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={(e) => {
							// Tile is wrapped in <Link>/<a>; without these
							// the badge click both navigates AND opens the
							// dialog over the next page.
							e.preventDefault();
							e.stopPropagation();
							setOpen(true);
						}}
						// `appearance-none` strips the native button chrome
						// for visual fit in the meta line; pair it with an
						// explicit focus-visible ring so keyboard users
						// still see where they are.
						className="appearance-none rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						{inner}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					{STATUS_TOOLTIP[status]}
				</TooltipContent>
			</Tooltip>
			{/* Dialog content portals into document.body, but React events
			    bubble through the COMPONENT tree, not the DOM tree — so a
			    click on the X / backdrop / inside-content still bubbles
			    up to the wrapping <Link> and navigates. The wrapper here
			    catches everything before the Link sees it. Without this,
			    closing the help dialog would silently send the user to
			    the agent detail page they thought they were dismissing. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: this div
			    intentionally swallows bubbled events from the portaled
			    Dialog so the wrapping <Link> doesn't navigate when the
			    user closes the help modal. It's a propagation barrier,
			    not a real interactive control. */}
			<div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
				<SyncHelpDialog env={env} status={status} open={open} onOpenChange={setOpen} />
			</div>
		</>
	);
}

function TechRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-3 py-0.5">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-mono tabular-nums">{value}</dd>
		</div>
	);
}

/** Modal that pops from the badge click. Single surface for all
 * states — set-up renders the install tutorial; live shows the
 * technical observability fields; errored adds the error blob +
 * fix command; paused adds restart guidance. Putting it all in
 * one dialog (instead of an always-on detail card on the agent
 * page) means the user only sees this when they actively ask
 * "what's the daemon doing?" by clicking the meta-line badge. */
function SyncHelpDialog({
	env,
	status,
	open,
	onOpenChange,
}: {
	env: Env;
	status: Status;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const dropped = env.dropped_count ?? 0;
	const queuePeak = env.queue_depth_high_water ?? 0;
	const lastSyncRel = env.last_sync_at ? relativeTime(env.last_sync_at) : "never";
	const ts = env.last_sync_at ? new Date(env.last_sync_at).getTime() : null;
	const isStale = ts !== null && Number.isFinite(ts) && Date.now() - ts > FRESH_WINDOW_MS;
	const isErroredAndStale = status === "errored" && isStale;

	const title =
		status === "live"
			? "Live sync details"
			: status === "set-up"
				? "Turn on live sync for this agent"
				: status === "errored"
					? "Sync hit an error"
					: "Sync paused — daemon isn't checking in";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					{status === "set-up" ? (
						<>
							<p className="text-sm text-muted-foreground">
								A small background service that keeps this agent in sync.
							</p>
							<SyncSetupSnippet env={env} />
						</>
					) : (
						<>
							{status === "live" ? (
								<p className="text-sm text-muted-foreground">
									Syncing in about a second either way.
								</p>
							) : null}

							{status === "errored" && env.last_sync_error ? (
								<div className="space-y-2">
									<p className="text-sm font-medium text-destructive">What went wrong</p>
									<code className="block rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive/90">
										{formatErrorForDisplay(env.last_sync_error)}
									</code>
									{isErroredAndStale ? (
										<>
											<p className="text-xs text-muted-foreground">
												Daemon stopped after this error. Inspect:
											</p>
											<CommandLine command="clawdi serve status" />
											<p className="text-xs text-muted-foreground">
												Token revoked? Log in again with{" "}
												<code className="rounded bg-muted px-1 py-0.5 text-[11px]">
													clawdi auth login
												</code>
												.
											</p>
										</>
									) : isPermanentError(env.last_sync_error) ? (
										<>
											<p className="text-xs text-muted-foreground">
												This won&apos;t auto-recover — the daemon dropped the change after the
												server rejected it. Common cause: skill folder bigger than the 25 MB upload
												cap (check for{" "}
												<code className="rounded bg-muted px-1 py-0.5 text-[11px]">
													node_modules
												</code>
												, <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.git</code>,
												build output). Fix the source and re-save to retry — the daemon is still
												healthy and will pick up the next edit.
											</p>
											<CommandLine command="clawdi serve status" />
										</>
									) : isRetryExhaustedError(env.last_sync_error) ? (
										<>
											<p className="text-xs text-muted-foreground">
												The daemon retried for a few minutes and gave up — usually a network outage
												or backend hiccup. The next 5-minute rescan re-queues the change
												automatically once connectivity is back; no source edit needed. If your
												network looks fine, inspect:
											</p>
											<CommandLine command="clawdi serve status" />
										</>
									) : (
										<>
											<p className="text-xs text-muted-foreground">
												It will keep retrying. If this persists:
											</p>
											<CommandLine command="clawdi serve status" />
											<p className="text-xs text-muted-foreground">
												Token revoked? Log in again with{" "}
												<code className="rounded bg-muted px-1 py-0.5 text-[11px]">
													clawdi auth login
												</code>
												.
											</p>
										</>
									)}
								</div>
							) : null}

							{status === "paused" ? (
								<div className="space-y-2">
									<p className="text-sm text-muted-foreground">
										Daemon isn&apos;t checking in. From the same terminal you set it up on:
									</p>
									<CommandLine command="clawdi serve status" />
									<p className="text-sm text-muted-foreground">If it&apos;s down, restart:</p>
									<CommandLine command={`clawdi serve install --agent ${env.agent_type}`} />
								</div>
							) : null}

							{dropped > 0 ? (
								<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
									<p className="font-medium text-amber-700 dark:text-amber-300">
										{dropped} change{dropped === 1 ? "" : "s"} dropped
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Usually a network blip. Next sync should catch up; otherwise restart the daemon.
									</p>
								</div>
							) : null}

							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Technical details
								</p>
								<dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
									<TechRow label="Last heartbeat" value={lastSyncRel} />
									<TechRow label="Queue peak (since daemon started)" value={queuePeak.toString()} />
									<TechRow
										label="Skills-revision the daemon last saw"
										value={env.last_revision_seen?.toString() ?? "—"}
									/>
									<TechRow
										label="Events dropped (since daemon started)"
										value={dropped.toString()}
									/>
								</dl>
							</div>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Install-tutorial body for the help dialog. Two modes mirroring
 * `<AddAgentSetup>` on the onboarding card so the user reads the
 * same Tabs (Send to Agent / Manual Setup) pattern everywhere a
 * Clawdi setup is offered. */
function SyncSetupSnippet({ env }: { env: Env }) {
	return (
		<Tabs defaultValue="agent">
			<TabsList>
				<TabsTrigger value="agent">
					<Rocket />
					Send to Agent
				</TabsTrigger>
				<TabsTrigger value="cli">
					<Terminal />
					Manual Setup
				</TabsTrigger>
			</TabsList>
			<TabsContent value="agent" className="mt-3">
				<SyncSetupAgentTab env={env} />
			</TabsContent>
			<TabsContent value="cli" className="mt-3">
				<SyncSetupCliTab env={env} />
			</TabsContent>
		</Tabs>
	);
}

/** Hand-off prompt the user pastes into Claude / Codex / etc. The
 * agent reads the prompt, runs `clawdi serve install --all`, and
 * confirms with `clawdi serve status`. Mirrors the prose tone and
 * structure of `useAgentPrompt` in add-agent-setup.tsx. */
function useSyncAgentPrompt(env: Env): string {
	const typeLabel = agentTypeLabel(env.agent_type);
	return [
		`Turn on Clawdi live sync on this machine for ${typeLabel}.`,
		"Run `clawdi serve install --all` to install the per-user daemon for every Clawdi-registered agent on this machine.",
		"Then confirm with `clawdi serve status` and report whether the daemon is live.",
	].join(" ");
}

function SyncSetupAgentTab({ env }: { env: Env }) {
	const prompt = useSyncAgentPrompt(env);
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">
				Paste this into the AI on this machine and it&apos;ll set itself up.
			</p>
			<PromptBlock text={prompt} />
		</div>
	);
}

function SyncSetupCliTab({ env }: { env: Env }) {
	const perAgentCmd = `clawdi serve install --agent ${env.agent_type}`;
	const allCmd = "clawdi serve install --all";
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">In a terminal on this machine, run either:</p>
			<div className="space-y-1.5">
				<CommandLine command={perAgentCmd} hint="this agent only" />
				<CommandLine command={allCmd} hint="every agent on this machine" />
			</div>
			<p className="text-xs text-muted-foreground">
				Installs a launchd (macOS) or systemd (Linux) unit so the daemon survives reboots.
			</p>
		</div>
	);
}

function PromptBlock({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	// Match the visual treatment of <AgentTab>'s prompt block in
	// add-agent-setup.tsx — same Copy chip, same border + muted bg —
	// so the dialog reads as a peer to the onboarding card, not a
	// separate one-off design.
	const onCopy = () => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	};
	return (
		<div className="rounded-lg border bg-muted/30">
			<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
				<span className="text-xs uppercase tracking-wide text-muted-foreground">Prompt</span>
				<button
					type="button"
					onClick={onCopy}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			<pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{text}</pre>
		</div>
	);
}

function CommandLine({ command, hint }: { command: string; hint?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				// `clipboard.writeText` rejects in non-secure contexts
				// (any http://, page-without-focus, older Safari). Without
				// awaiting we'd flash "Copied" while the actual copy
				// silently failed. Catch and only flip state on success.
				navigator.clipboard
					.writeText(command)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => {
						// Fall back to letting the user copy manually —
						// at least don't lie about the state.
					});
			}}
			title={hint}
			className="flex w-full items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-xs hover:bg-muted/60"
		>
			<code className="truncate">{command}</code>
			<span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
				{hint ? <span className="hidden font-sans not-italic sm:inline">{hint}</span> : null}
				<span>{copied ? "Copied" : "Copy"}</span>
			</span>
		</button>
	);
}
