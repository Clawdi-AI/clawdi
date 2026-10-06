import { initialDeploymentClasses as classes } from "@clawdi/shared/ui";
import {
	type DeploymentFailurePresentation,
	type DeploymentStatus,
	initialDeploymentCopy,
	initialDeploymentPresentation,
} from "@clawdi/shared/view";
import { AlertCircle } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator } from "react-native";
import { DetailPanel } from "@/components/detail/layout";
import { Alert } from "@/components/ui/alert";
import { Text } from "@/components/ui/text";
import { WebIcon, WebText, WebView } from "@/components/ui/web-layout";

export function InitialDeploymentPage({
	status,
	runtimeLabel,
	failure,
	timedOut,
	escalated,
	actions,
}: {
	status: DeploymentStatus;
	runtimeLabel: string;
	failure: DeploymentFailurePresentation | null;
	timedOut: boolean;
	escalated: boolean;
	actions?: ReactNode;
}) {
	if (failure?.failedVerb === "create")
		return (
			<DetailPanel className={classes.failurePanel}>
				<WebView recipe={classes.failureBody} accessibilityRole="alert">
					<WebView recipe="">
						<WebView recipe={classes.title}>
							<WebIcon as={AlertCircle} recipe="size-5 text-destructive" />
							<WebText recipe={classes.title}>{initialDeploymentCopy.failureTitle}</WebText>
						</WebView>
						<WebText recipe={classes.description}>
							{initialDeploymentCopy.failureDescription}
						</WebText>
					</WebView>
					<Alert variant="destructive" icon={AlertCircle} title={failure.title}>
						<WebView recipe="space-y-1">
							<Text>{failure.reason}</Text>
							<Text>{failure.description}</Text>
						</WebView>
					</Alert>
					{actions}
				</WebView>
			</DetailPanel>
		);
	const view = initialDeploymentPresentation(status, runtimeLabel, timedOut, escalated);
	return (
		<DetailPanel
			className={`${classes.panel} ${timedOut || escalated ? classes.warningPanel : ""}`}
		>
			<WebView
				recipe={classes.body}
				accessibilityRole={timedOut || escalated ? "alert" : undefined}
			>
				<WebView recipe="">
					<WebView recipe={classes.title}>
						{timedOut || escalated ? <WebIcon as={AlertCircle} recipe="size-5" /> : null}
						<WebText recipe={classes.title}>{view.title}</WebText>
					</WebView>
					<WebText recipe={classes.description}>{view.description}</WebText>
				</WebView>
				<WebView recipe="">
					<WebView recipe={classes.stageHeader}>
						<WebView
							recipe={classes.activeLabel}
							className="flex-1"
							accessibilityLiveRegion="polite"
						>
							{!timedOut && !escalated && status.kind !== "running" ? (
								<ActivityIndicator size="small" />
							) : null}
							<WebText recipe={classes.activeLabel} className="flex-shrink">
								{view.activeStage.label}
							</WebText>
						</WebView>
						<WebText recipe={classes.step}>{view.step}</WebText>
					</WebView>
					<WebText recipe={classes.stageDescription}>{view.activeStage.description}</WebText>
					<WebView
						recipe={classes.stages}
						className="flex-row"
						accessibilityLabel={initialDeploymentCopy.progress}
					>
						{view.stages.map((stage) => (
							<WebView
								key={stage.status}
								recipe="flex-1"
								accessibilityLabel={`${stage.label}, ${stage.state}`}
							>
								<WebView
									recipe={`${classes.bar} ${stage.state === "active" ? classes.activeBar : stage.state === "completed" ? classes.completedBar : classes.pendingBar}`}
								/>
								<WebText
									recipe={`${classes.stageLabel} ${stage.state === "pending" ? classes.pendingLabel : classes.readyLabel}`}
								>
									{stage.label}
								</WebText>
							</WebView>
						))}
					</WebView>
				</WebView>
				{actions}
			</WebView>
		</DetailPanel>
	);
}
