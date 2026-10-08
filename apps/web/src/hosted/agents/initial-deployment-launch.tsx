import {
	initialDeploymentClasses as classes,
	initialDeploymentCircleStops,
} from "@clawdi/shared/ui";
import {
	formatElapsedClock,
	type HostedRuntime,
	type InitialDeploymentTone,
	initialDeploymentCopy,
} from "@clawdi/shared/view";
import { AlertCircle, Check } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { cn } from "@/lib/utils";

/** The circle backdrop as a CSS gradient of the page background, from the shared stops. */
const CIRCLE_BACKDROP = `radial-gradient(closest-side, ${initialDeploymentCircleStops()
	.map(
		(stop) =>
			`color-mix(in oklab, var(--background) ${stop.opacity * 100}%, transparent) ${stop.offset * 100}%`,
	)
	.join(", ")})`;

/** A phase is announced only after it holds this long, so quick successions stay quiet. */
const ANNOUNCEMENT_SETTLE_MS = 1_000;

export type InitialDeploymentLaunchTone = InitialDeploymentTone | "failed";

/**
 * Keeps the real overview mounted behind the setup status, under a light glass layer.
 * When setup completes, the overlay (glass, scrim, and status) fades as one layer over
 * the same tree, so the overview is revealed in place without a remount or layout shift.
 */
export function InitialDeploymentStage({
	preview,
	overlay,
	leaving,
	children,
}: {
	/** Setup in progress: hide the overview from input and assistive tech. */
	preview: boolean;
	overlay: ReactNode;
	/** The completed state was shown: fade the overlay out on the reveal timeline. */
	leaving: boolean;
	children: ReactNode;
}) {
	return (
		<div className={classes.stage}>
			<div
				data-setup-preview={preview || undefined}
				inert={preview}
				aria-hidden={preview || undefined}
				className={preview ? classes.preview : undefined}
			>
				{children}
			</div>
			{overlay ? (
				<div
					data-setup-overlay={leaving ? "leaving" : "shown"}
					className={cn(classes.overlay, leaving && classes.overlayLeaving)}
				>
					<div aria-hidden="true" className={classes.glass} />
					<div className={cn(classes.position, leaving && classes.positionLeaving)}>{overlay}</div>
				</div>
			) : null}
		</div>
	);
}

/**
 * The setup module inside one soft-edged circle: the agent avatar and one status line
 * with the expectation and elapsed time, plus the failure detail and an action when
 * setup is slow or failed.
 */
export function InitialDeploymentLaunch({
	agentName,
	runtime,
	avatarUrl,
	tone,
	title,
	expectation = null,
	startedAtMs = null,
	detail = null,
	actions,
}: {
	agentName: string;
	runtime: HostedRuntime;
	avatarUrl?: string | null;
	tone: InitialDeploymentLaunchTone;
	title: string;
	expectation?: string | null;
	startedAtMs?: number | null;
	detail?: string | null;
	actions?: ReactNode;
}) {
	const BadgeIcon = tone === "ready" ? Check : tone === "progress" ? null : AlertCircle;
	// Readiness is announced once by the page and a failure as an alert; this region
	// speaks the phases in between once each has settled.
	const announcement = useSettledAnnouncement(tone === "ready" || tone === "failed" ? null : title);
	return (
		<div data-testid="hosted-initial-deployment-panel" className={classes.content}>
			<span
				aria-hidden="true"
				data-setup-circle-fill
				className={classes.circleFill}
				style={{ backgroundImage: CIRCLE_BACKDROP }}
			/>
			<h1 className="sr-only">{agentName}</h1>
			<div className={classes.hero} aria-hidden="true">
				{tone === "progress" ? (
					<>
						<span className={classes.halo} />
						<span className={cn(classes.halo, classes.haloDelayed)} />
					</>
				) : null}
				<div className={cn(classes.frame, classes.frameTone[tone])}>
					<AgentIcon agent={runtime} avatarUrl={avatarUrl} size="xl" shape="circle" />
					{BadgeIcon && tone !== "progress" ? (
						<span className={cn(classes.badge, classes.badgeTone[tone])}>
							<BadgeIcon strokeWidth={tone === "ready" ? 3 : 2.5} />
						</span>
					) : null}
				</div>
			</div>
			<p className="sr-only" role="status" aria-live="polite">
				{announcement}
			</p>
			<div className={classes.statusLine} role={tone === "failed" ? "alert" : undefined}>
				<h2 className={cn(classes.status, classes.statusTone[tone])}>{title}</h2>
				{expectation || startedAtMs !== null ? (
					<p className={classes.statusMeta}>
						{expectation}
						{expectation && startedAtMs !== null ? <span aria-hidden="true"> · </span> : null}
						{startedAtMs !== null ? (
							<ElapsedClock startedAtMs={startedAtMs} running={tone !== "ready"} />
						) : null}
					</p>
				) : null}
				{detail ? <p className={classes.detail}>{detail}</p> : null}
			</div>
			{actions ? <div className={classes.actions}>{actions}</div> : null}
		</div>
	);
}

/**
 * The latest phase once it has held for a moment. The phase present on mount is not
 * announced; the visible heading already carries it.
 */
function useSettledAnnouncement(text: string | null): string | null {
	const [baseline] = useState(text);
	const [announcement, setAnnouncement] = useState<string | null>(null);
	const changed = text !== null && (announcement !== null || text !== baseline);
	useEffect(() => {
		if (!changed || text === null) return;
		const timeout = window.setTimeout(() => setAnnouncement(text), ANNOUNCEMENT_SETTLE_MS);
		return () => window.clearTimeout(timeout);
	}, [changed, text]);
	return announcement;
}

function ElapsedClock({ startedAtMs, running }: { startedAtMs: number; running: boolean }) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const tick = () => setNowMs(Date.now());
		tick();
		const interval = window.setInterval(tick, 1000);
		return () => window.clearInterval(interval);
	}, [running]);
	return (
		<>
			<span className="sr-only">{initialDeploymentCopy.elapsed} </span>
			<time suppressHydrationWarning className={classes.elapsed}>
				{formatElapsedClock(nowMs - startedAtMs)}
			</time>
		</>
	);
}
