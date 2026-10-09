import {
	initialDeploymentClasses as classes,
	initialDeploymentCircleStops,
} from "@clawdi/shared/ui";
import {
	type DeploymentFailurePresentation,
	type DeploymentStatus,
	formatElapsedClock,
	type HostedRuntime,
	type InitialDeploymentTone,
	initialDeploymentCopy,
	initialDeploymentPresentation,
	type ProvisioningPath,
} from "@clawdi/shared/view";
import Check from "lucide-react-native/icons/check";
import AlertCircle from "lucide-react-native/icons/circle-alert";
import { type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EntityCardSkeleton } from "@/components/entity-card";
import { WebIcon, WebText, WebView } from "@/components/ui/web-layout";

type LaunchTone = InitialDeploymentTone | "failed";

export function InitialDeploymentPage({
	runtime,
	avatarUrl,
	status,
	provisioningPath,
	awaitingChat,
	failure,
	timedOut,
	escalated,
	startedAtMs,
	actions,
}: {
	runtime: HostedRuntime;
	avatarUrl?: string | null;
	status: DeploymentStatus;
	provisioningPath: ProvisioningPath;
	/** Running, but the web chat surface is not published yet. */
	awaitingChat: boolean;
	failure: DeploymentFailurePresentation | null;
	timedOut: boolean;
	escalated: boolean;
	startedAtMs: number | null;
	actions?: ReactNode;
}) {
	const identity = { runtime, avatarUrl };
	const view =
		failure?.failedVerb === "create"
			? null
			: initialDeploymentPresentation(status, timedOut, escalated, provisioningPath, awaitingChat);
	return (
		<WebView recipe="relative">
			{/* A dimmed placeholder of the overview this screen turns into. */}
			<WebView
				recipe={classes.nativePreview}
				pointerEvents="none"
				accessibilityElementsHidden
				importantForAccessibility="no-hide-descendants"
			>
				{["dashboard", "channels", "model", "compute"].map((key) => (
					<EntityCardSkeleton key={key} />
				))}
			</WebView>
			<WebView recipe={classes.nativeOverlay}>
				{view ? (
					<Launch
						{...identity}
						tone={view.tone}
						title={view.title}
						expectation={view.expectation}
						startedAtMs={startedAtMs}
						actions={actions}
					/>
				) : (
					<Launch
						{...identity}
						tone="failed"
						title={initialDeploymentCopy.failureTitle}
						detail={failure?.reason ?? null}
						actions={actions}
					/>
				)}
			</WebView>
		</WebView>
	);
}

/**
 * Same minimal composition as Web: the agent mark and one status line naming the
 * phase, with the expectation and elapsed time. The native header names the agent.
 */
function Launch({
	runtime,
	avatarUrl,
	tone,
	title,
	expectation = null,
	startedAtMs = null,
	detail = null,
	actions,
}: {
	runtime: HostedRuntime;
	avatarUrl?: string | null;
	tone: LaunchTone;
	title: string;
	expectation?: string | null;
	startedAtMs?: number | null;
	detail?: string | null;
	actions?: ReactNode;
}) {
	const BadgeIcon = tone === "ready" ? Check : tone === "progress" ? null : AlertCircle;
	// The detail screen announces readiness and a failure is an alert; the phases in
	// between are announced once each has settled.
	useSettledAnnouncement(tone === "ready" || tone === "failed" ? null : title);
	return (
		<WebView recipe={classes.nativeCircle}>
			<CircleFill />
			<WebView recipe={classes.hero} accessibilityElementsHidden importantForAccessibility="no">
				<WebView recipe={`${classes.frame} ${classes.frameTone[tone]}`}>
					<AgentIcon agent={runtime} avatarUrl={avatarUrl} size="xl" shape="circle" />
					{BadgeIcon && tone !== "progress" ? (
						<WebView recipe={`${classes.badge} ${classes.badgeTone[tone]}`}>
							<WebIcon as={BadgeIcon} recipe="size-4" />
						</WebView>
					) : null}
				</WebView>
			</WebView>
			<WebView recipe={classes.statusLine}>
				<WebText
					recipe={`${classes.status} ${classes.statusTone[tone]}`}
					accessibilityRole={tone === "failed" ? "alert" : "header"}
				>
					{title}
				</WebText>
				{expectation || startedAtMs !== null ? (
					<WebText recipe={classes.statusMeta}>
						{expectation}
						{expectation && startedAtMs !== null ? " · " : null}
						{startedAtMs !== null ? (
							<ElapsedClock startedAtMs={startedAtMs} running={tone !== "ready"} />
						) : null}
					</WebText>
				) : null}
			</WebView>
			{detail ? <WebText recipe={classes.detail}>{detail}</WebText> : null}
			{actions ? <WebView recipe={classes.actions}>{actions}</WebView> : null}
		</WebView>
	);
}

/**
 * The module's circle, as on Web: the page background at the shared fill opacity,
 * fading softly to transparent at the rim.
 */
function CircleFill() {
	const background = useCSSVariable("--color-background");
	const color = typeof background === "string" ? background : "transparent";
	return (
		<WebView recipe={classes.nativeCircleFill} pointerEvents="none">
			<Svg style={{ width: "100%", height: "100%" }} viewBox="0 0 100 100">
				<Defs>
					<RadialGradient
						id="initial-deployment-circle"
						cx="50"
						cy="50"
						r="50"
						gradientUnits="userSpaceOnUse"
					>
						{initialDeploymentCircleStops().map((stop) => (
							<Stop
								key={stop.offset}
								offset={stop.offset}
								stopColor={color}
								stopOpacity={stop.opacity}
							/>
						))}
					</RadialGradient>
				</Defs>
				<Circle cx="50" cy="50" r="50" fill="url(#initial-deployment-circle)" />
			</Svg>
		</WebView>
	);
}

/** Same rule as Web: a phase is announced once it holds, never the one on mount. */
const ANNOUNCEMENT_SETTLE_MS = 1_000;

function useSettledAnnouncement(text: string | null): void {
	const [baseline] = useState(text);
	const [announced, setAnnounced] = useState<string | null>(null);
	const changed = text !== null && text !== announced && (announced !== null || text !== baseline);
	useEffect(() => {
		if (!changed || text === null) return;
		const timeout = setTimeout(() => {
			AccessibilityInfo.announceForAccessibility(text);
			setAnnounced(text);
		}, ANNOUNCEMENT_SETTLE_MS);
		return () => clearTimeout(timeout);
	}, [changed, text]);
}

function ElapsedClock({ startedAtMs, running }: { startedAtMs: number; running: boolean }) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const tick = () => setNowMs(Date.now());
		tick();
		const interval = setInterval(tick, 1000);
		return () => clearInterval(interval);
	}, [running]);
	const elapsed = formatElapsedClock(nowMs - startedAtMs);
	return (
		<WebText
			recipe={classes.elapsed}
			accessibilityLabel={`${initialDeploymentCopy.elapsed} ${elapsed}`}
		>
			{elapsed}
		</WebText>
	);
}
