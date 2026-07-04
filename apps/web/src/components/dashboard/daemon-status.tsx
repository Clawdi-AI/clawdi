/**
 * Live-sync indicator for agents on the dashboard.
 *
 * One badge component for compact status surfaces such as the sidebar.
 * The visual status mapping is exported so non-interactive surfaces can
 * render the same dot without drifting from this badge.
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

type Env = components["schemas"]["AgentResponse"];

const FRESH_WINDOW_MS = 90_000;

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
 * condition clears — no user action required. UI shows that the
 * daemon stopped this retry cycle and will pick the item up again
 * automatically when connectivity is back. */
function isRetryExhaustedError(raw: string | null | undefined): boolean {
	return typeof raw === "string" && raw.startsWith("retry_exhausted: ");
}

function classify(env: Env | null | undefined): DaemonStatusKind {
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
	live: "bg-success ring-2 ring-success/20",
	"set-up": "border-dashed border border-muted-foreground/50 bg-transparent",
	errored: "bg-destructive ring-2 ring-destructive/20",
	paused: "bg-warning ring-2 ring-warning/20",
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
	env: Env | null | undefined,
	source: DaemonStatusSource = "self-managed",
): DaemonStatusVisual {
	const kind = classify(env);
	const isHosted = source === "on-clawdi";
	const setupLabel = isHosted ? "Sync pending" : DOT_LABEL[kind];
	const label = kind === "set-up" ? setupLabel : DOT_LABEL[kind];
	const badgeLabel = isHosted && kind === "set-up" ? "Sync pending" : SHORT_LABEL[kind];
	const compactLabel = isHosted && kind === "set-up" ? "Pending" : COMPACT_LABEL[kind];
	const tooltip = isHosted
		? kind === "set-up"
			? "Sync activates on the next image rollout."
			: kind === "paused"
				? "Pod isn't checking in. Manage it from agent settings."
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

export function DaemonStatusBadge({
	env,
	source = "self-managed",
	manageHref,
	compact = false,
	tooltipDetail,
	showDot = true,
	labelOverride,
}: {
	env: Env;
	/** "on-clawdi" tiles change the dialog copy across every non-
	 * live state: hosted users don't have a CLI to run
	 * `clawdi daemon install` / `clawdi daemon status` / `clawdi auth login`
	 * against — the supervised daemon ships in the hosted runtime image. All
	 * remediation copy points back at hosted agent settings
	 * (`manageHref`) instead. Self-managed installs see the
	 * existing CLI instructions across every state. */
	source?: DaemonStatusSource;
	/** When provided on a hosted (`source="on-clawdi"`) tile, errored /
	 * paused dialog branches render a link to this URL (the hosted
	 * agent settings page) so the dead-end
	 * "the daemon is broken and you can't fix it from here" UX
	 * becomes "click here to restart the hosted runtime." Self-managed callers
	 * omit it; hosted callers without a deployment link get a plain
	 * "contact support / check agent settings" message. */
	manageHref?: string;
	/** Use a one-word label in constrained layouts such as the sidebar header. */
	compact?: boolean;
	/** Extra context shown only in the tooltip for crowded layouts. */
	tooltipDetail?: string;
	/** Hosted compute-primary surfaces can render sync as text-only context. */
	showDot?: boolean;
	/** Hosted compute-primary surfaces may need the fully-qualified sync label
	 * even in compact layouts. */
	labelOverride?: string;
}) {
	const visual = daemonStatusVisual(env, source);
	const [open, setOpen] = useState(false);
	const label = labelOverride ?? (compact ? visual.compactLabel : visual.badgeLabel);
	const inner = (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 whitespace-nowrap",
				compact && "gap-1",
				visual.textClass,
				"cursor-pointer hover:text-foreground",
			)}
		>
			{showDot ? (
				<span aria-hidden className={cn("inline-block size-1.5 rounded-full", visual.dotClass)} />
			) : null}
			<span className="whitespace-nowrap">{label}</span>
		</span>
	);
	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={(e) => {
							// Some callers sit next to stretched links; keep
							// the status dialog click local to the badge.
							e.preventDefault();
							e.stopPropagation();
							setOpen(true);
						}}
						// `appearance-none` strips the native button chrome
						// for visual fit in the meta line; pair it with an
						// explicit focus-visible ring so keyboard users
						// still see where they are.
						className={cn(
							"appearance-none rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
							compact && "shrink-0 whitespace-nowrap",
						)}
					>
						{inner}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					<div className="flex flex-col gap-0.5">
						<span>{visual.tooltip}</span>
						{tooltipDetail ? (
							<span className="font-normal text-muted-foreground">{tooltipDetail}</span>
						) : null}
					</div>
				</TooltipContent>
			</Tooltip>
			{/* Dialog content portals into document.body, but React events
				    bubble through the COMPONENT tree, not the DOM tree. The
				    wrapper here catches propagated dialog clicks before a
				    nearby stretched link can see them. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: this div
				    intentionally swallows bubbled events from the portaled
				    Dialog. It's a propagation barrier, not a real interactive
				    control. */}
			<div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
				<SyncHelpDialog
					env={env}
					status={visual.kind}
					source={source}
					manageHref={manageHref}
					open={open}
					onOpenChange={setOpen}
				/>
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
	source,
	manageHref,
	open,
	onOpenChange,
}: {
	env: Env;
	status: DaemonStatusKind;
	source: DaemonStatusSource;
	manageHref?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isHosted = source === "on-clawdi";
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
				? isHosted
					? "Live sync is activating"
					: "Turn on live sync for this agent"
				: status === "errored"
					? "Sync hit an error"
					: isHosted
						? "Sync paused — hosted runtime isn't checking in"
						: "Sync paused — daemon isn't checking in";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					{status === "set-up" ? (
						isHosted ? (
							// Hosted runtimes get sync wired up automatically when
							// the agent image rolls out — there's nothing for the
							// user to configure. Explain the flow + point at the
							// hosted agent lifecycle UI for the rare manual
							// kick (Restart) so this dialog is informational, not
							// a dead-end.
							<div className="space-y-3">
								<p className="text-sm text-muted-foreground">
									This agent runs on Clawdi&apos;s infrastructure. Live sync activates automatically
									once the hosted runtime is on the latest agent image. New deploys are already on
									the latest image; older runtimes activate after their next restart.
								</p>
								<p className="text-xs text-muted-foreground">
									Nothing to install or configure on your side. The first heartbeat will flip this
									badge to <span className="font-medium">Live sync</span> within a minute or two of
									runtime start.
								</p>
							</div>
						) : (
							<>
								<p className="text-sm text-muted-foreground">
									A small background service that keeps this agent in sync.
								</p>
								<SyncSetupSnippet env={env} />
							</>
						)
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
										isHosted ? (
											<>
												<p className="text-xs text-muted-foreground">
													Daemon stopped after this error. The runtime runs on Clawdi&apos;s
													infrastructure — restart it from agent settings to recover.
												</p>
												<ManageOnClawdiLink manageHref={manageHref} />
											</>
										) : (
											<>
												<p className="text-xs text-muted-foreground">
													Daemon stopped after this error. Inspect:
												</p>
												<CommandLine command="clawdi daemon status" />
												<AuthLoginHint />
											</>
										)
									) : isPermanentError(env.last_sync_error) ? (
										// Same product story on both sides: permanent drop means the
										// daemon is still healthy and will pick up the next edit.
										// Self-managed offers `clawdi daemon status` as a sanity check;
										// hosted users have no CLI, so we just explain the daemon
										// state and let the next file save do the rest.
										<>
											<p className="text-xs text-muted-foreground">
												This won&apos;t auto-recover — the daemon dropped the change after the
												server rejected it. Common cause: skill folder bigger than the 25 MB upload
												cap (check for{" "}
												<code className="rounded bg-muted px-1 py-0.5 text-2xs">node_modules</code>,{" "}
												<code className="rounded bg-muted px-1 py-0.5 text-2xs">.git</code>, build
												output). Fix the source and re-save to retry — the daemon is still healthy
												and will pick up the next edit.
											</p>
											{isHosted ? null : <CommandLine command="clawdi daemon status" />}
										</>
									) : isRetryExhaustedError(env.last_sync_error) ? (
										<>
											<p className="text-xs text-muted-foreground">
												The daemon retried for a few minutes and gave up — usually a network outage
												or backend hiccup. The next 5-minute rescan re-queues the change
												automatically once connectivity is back; no source edit needed.
												{isHosted ? null : " If your network looks fine, check:"}
											</p>
											{isHosted ? null : <CommandLine command="clawdi daemon status" />}
										</>
									) : isHosted ? (
										<>
											<p className="text-xs text-muted-foreground">
												The daemon will keep retrying. If the error persists, restart the hosted
												runtime from agent settings.
											</p>
											<ManageOnClawdiLink manageHref={manageHref} />
										</>
									) : (
										<>
											<p className="text-xs text-muted-foreground">
												It will keep retrying. If this persists:
											</p>
											<CommandLine command="clawdi daemon status" />
											<AuthLoginHint />
										</>
									)}
								</div>
							) : null}

							{status === "paused" ? (
								isHosted ? (
									<div className="space-y-2">
										<p className="text-sm text-muted-foreground">
											The hosted runtime isn&apos;t checking in. It may be restarting, suspended, or
											out of memory — manage it from agent settings.
										</p>
										<ManageOnClawdiLink manageHref={manageHref} />
									</div>
								) : (
									<div className="space-y-2">
										<p className="text-sm text-muted-foreground">
											Daemon isn&apos;t checking in. From the same terminal you set it up on:
										</p>
										<CommandLine command="clawdi daemon status" />
										<p className="text-sm text-muted-foreground">If it&apos;s down, restart:</p>
										<CommandLine command="clawdi daemon install" />
									</div>
								)
							) : null}

							{dropped > 0 ? (
								<div className="rounded-md border border-warning/30 bg-warning-muted p-3 text-sm">
									<p className="font-medium text-warning-muted-foreground">
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
 * same Tabs (Send to agent / Manual setup) pattern everywhere a
 * Clawdi setup is offered. */
function SyncSetupSnippet({ env }: { env: Env }) {
	return (
		<Tabs defaultValue="agent">
			<TabsList>
				<TabsTrigger value="agent">
					<Rocket />
					Send to agent
				</TabsTrigger>
				<TabsTrigger value="cli">
					<Terminal />
					Manual setup
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
 * agent reads the prompt, runs `clawdi daemon install`, and
 * confirms with `clawdi daemon status`. Mirrors the prose tone and
 * structure of `useAgentPrompt` in add-agent-setup.tsx. */
function useSyncAgentPrompt(env: Env): string {
	const typeLabel = agentTypeLabel(env.agent_type);
	return [
		`Turn on Clawdi live sync on this machine for ${typeLabel}.`,
		"Run `clawdi daemon install` to install one per-user daemon that syncs every Clawdi-registered agent on this machine.",
		"Then confirm with `clawdi daemon status` and report whether the daemon is live.",
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

function SyncSetupCliTab(_props: { env: Env }) {
	const installCmd = "clawdi daemon install";
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">In a terminal on this machine, run:</p>
			<div className="space-y-1.5">
				<CommandLine command={installCmd} hint="single daemon for every agent on this machine" />
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

/** Two of the self-managed errored-state branches ("daemon stopped"
 * and the generic "keep retrying" branch) end with the same nudge to
 * `clawdi auth login`. Inline both was 8 lines of identical JSX. */
function AuthLoginHint() {
	return (
		<p className="text-xs text-muted-foreground">
			Token turned off or expired? Log in again with{" "}
			<code className="rounded bg-muted px-1 py-0.5 text-2xs">clawdi auth login</code>.
		</p>
	);
}

/** Affordance for hosted runtime remediation. Renders a button-styled link
 * to the hosted agent settings page (Restart / Stop / Delete) when
 * `manageHref` is provided. Without that link, render neutral support
 * guidance instead of self-managed CLI remediation. */
function ManageOnClawdiLink({ manageHref }: { manageHref?: string }) {
	if (!manageHref) {
		return (
			<p className="text-xs text-muted-foreground">
				Open agent settings to restart or check the hosted runtime.
			</p>
		);
	}
	const external = /^https?:\/\//i.test(manageHref);
	return (
		<a
			href={manageHref}
			target={external ? "_blank" : undefined}
			rel={external ? "noopener noreferrer" : undefined}
			className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
		>
			Open agent settings
		</a>
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
			className="flex w-full items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-left font-mono text-xs hover:bg-muted/50"
		>
			<code className="truncate">{command}</code>
			<span className="flex shrink-0 items-center gap-2 text-3xs text-muted-foreground">
				{hint ? <span className="hidden font-sans not-italic sm:inline">{hint}</span> : null}
				<span>{copied ? "Copied" : "Copy"}</span>
			</span>
		</button>
	);
}
