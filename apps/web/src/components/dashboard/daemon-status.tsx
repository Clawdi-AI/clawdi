"use client";

import {
	type DaemonStatusKind,
	type DaemonStatusSource,
	daemonStatusVisual,
	FRESH_WINDOW_MS,
	formatErrorForDisplay,
	isPermanentError,
	isRetryExhaustedError,
} from "@clawdi/shared/view";
/**
 * Live-sync indicator for agents on the dashboard.
 *
 * One badge component for compact status surfaces such as the sidebar.
 * The visual status mapping is exported so non-interactive surfaces can
 * render the same dot without drifting from this badge.
 */

import type { components } from "@clawdi/shared/api";
import { agentTypeLabel, relativeTime } from "@clawdi/shared/view";
import { Rocket, Terminal } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

type Env = components["schemas"]["AgentResponse"];
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
				<TooltipTrigger
					render={
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
						/>
					}
				>
					{inner}
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
						? "Sync paused"
						: "Sync paused — background service isn't reporting";

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
									Live sync activates automatically with this agent&apos;s next update.
								</p>
								<p className="text-xs text-muted-foreground">
									No action needed. This should change to{" "}
									<span className="font-medium">Live sync</span> within a few minutes.
								</p>
							</div>
						) : (
							<>
								<p className="text-sm text-muted-foreground">
									A background service keeps this agent in sync.
								</p>
								<SyncSetupSnippet env={env} />
							</>
						)
					) : (
						<>
							{status === "live" ? (
								<p className="text-sm text-muted-foreground">
									Changes sync in both directions within about a second.
								</p>
							) : null}

							{status === "errored" && env.last_sync_error ? (
								<div className="space-y-2">
									<p className="text-sm font-medium text-destructive">What went wrong</p>
									{isHosted ? (
										<p className="text-sm text-destructive/90">
											Clawdi couldn&apos;t sync the latest changes.
										</p>
									) : (
										<code className="block rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive/90">
											{formatErrorForDisplay(env.last_sync_error)}
										</code>
									)}
									{isErroredAndStale ? (
										isHosted ? (
											<>
												<p className="text-xs text-muted-foreground">
													Sync stopped after this error. Restart the agent from agent settings.
												</p>
												<ManageOnClawdiLink manageHref={manageHref} />
											</>
										) : (
											<>
												<p className="text-xs text-muted-foreground">
													Background sync stopped after this error. Check:
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
												{isHosted
													? "This change couldn't be synced. Confirm that each skill is under 25 MB, then save again."
													: "This change couldn't be synced. Correct the source, then save again to retry."}
											</p>
											{isHosted ? null : <CommandLine command="clawdi daemon status" />}
										</>
									) : isRetryExhaustedError(env.last_sync_error) ? (
										<>
											<p className="text-xs text-muted-foreground">
												Sync will resume automatically when the connection recovers.
												{isHosted ? null : " If the connection is working, check:"}
											</p>
											{isHosted ? null : <CommandLine command="clawdi daemon status" />}
										</>
									) : isHosted ? (
										<>
											<p className="text-xs text-muted-foreground">
												Clawdi will continue retrying. If the error persists, restart the agent from
												agent settings.
											</p>
											<ManageOnClawdiLink manageHref={manageHref} />
										</>
									) : (
										<>
											<p className="text-xs text-muted-foreground">
												Sync will continue retrying. If the issue persists:
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
											Sync status is unavailable. The agent may be starting, stopped, or temporarily
											unavailable.
										</p>
										<ManageOnClawdiLink manageHref={manageHref} />
									</div>
								) : (
									<div className="space-y-2">
										<p className="text-sm text-muted-foreground">
											The background sync service is not reporting. In the terminal where it was
											installed:
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
										Usually a brief network issue. The next sync should catch up; otherwise restart
										the background sync service.
									</p>
								</div>
							) : null}

							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Technical details
								</p>
								<dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
									<TechRow label="Last heartbeat" value={lastSyncRel} />
									<TechRow
										label="Queue peak (since sync service started)"
										value={queuePeak.toString()}
									/>
									<TechRow
										label="Latest skills revision received"
										value={env.last_revision_seen?.toString() ?? "—"}
									/>
									<TechRow
										label="Events dropped (since sync service started)"
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
 * `<AddAgentSetup>` in the Add-agent dialog so the user sees the
 * same prompt / manual setup pattern everywhere setup is offered. */
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
		`Turn on Clawdi live sync for ${typeLabel} on this machine.`,
		"Run `clawdi daemon install`; one per-user daemon syncs every Clawdi-registered agent here.",
		"Then run `clawdi daemon status` and report whether the daemon is live.",
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
				<CommandLine command={installCmd} hint="one sync service for every agent on this machine" />
			</div>
			<p className="text-xs text-muted-foreground">
				Installs a launchd (macOS) or systemd (Linux) unit so sync continues after a reboot.
			</p>
		</div>
	);
}

export function PromptBlock({ text }: { text: string }) {
	const { copied, copy } = useCopyToClipboard({
		success: false,
		error: "Couldn't copy. Select the prompt and copy it manually.",
	});
	// Match the visual treatment of <AgentTab>'s prompt block in
	// add-agent-setup.tsx — same Copy chip, same border + muted bg —
	// so the dialog reads as a peer to the onboarding card, not a
	// separate one-off design.
	return (
		<div className="rounded-lg border bg-muted/30">
			<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
				<span className="text-xs uppercase tracking-wide text-muted-foreground">Prompt</span>
				<span className="sr-only" aria-live="polite">
					{copied ? "Copied" : ""}
				</span>
				<button
					type="button"
					onClick={() => copy(text)}
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
			Token turned off or expired? Sign in again with{" "}
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
				Open agent settings to restart or check this Cloud Agent.
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
