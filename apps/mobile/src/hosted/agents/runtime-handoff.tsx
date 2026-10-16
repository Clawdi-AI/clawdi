import {
	type DeploymentRead,
	hermesDashboardHandoffFailure,
	isRuntimeUiEndpointInfo,
	RuntimeEndpointChangedError,
} from "@clawdi/shared/api";
import { hostedAgentOverviewClasses } from "@clawdi/shared/ui";
import {
	agentOverviewCopy,
	browserHandoffFailureMessage,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
	runtimeBrowserUiLabel,
	runtimeConsoleCopy,
} from "@clawdi/shared/view";
import * as WebBrowser from "expo-web-browser";
import PanelsTopLeft from "lucide-react-native/icons/panels-top-left";
import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-layout";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/**
 * Chat on the web: opens the agent's dashboard in the system browser directly, like Web's
 * new-window open. Hermes mints a one-time handoff; OpenClaw keeps its credential handoff.
 */
export function RuntimeBrowser({
	deployment,
	overview = false,
}: {
	deployment: DeploymentRead;
	overview?: boolean;
}) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(`${scope.identity}:${deployment.resource.id}`);
	const { hosted, deploymentMutations } = useMobileApi();
	const endpoint = deployment.runtime_ui_endpoint;
	const label = runtimeBrowserUiLabel(deployment.resource.spec.runtime);
	const available =
		deploymentRuntimeUiIsReady(deployment) &&
		isRuntimeUiEndpointInfo(endpoint) &&
		Boolean(hosted && deploymentMutations);
	const open = async () => {
		if (!available || !endpoint || !hosted || !deploymentMutations || action.busy) return;
		const reviewedUrl = endpoint.url;
		const id = deployment.resource.id;
		const signal = scope.signal;
		const visible = capture();
		await action.run(async (active) => {
			const current = () => active() && visible() && !signal.aborted && scope.isCurrent();
			if (!current()) return;
			const fresh = await read((s) => hosted.getDeployment(id, s), signal);
			if (!current()) return;
			const target = fresh.runtime_ui_endpoint;
			if (
				fresh.resource.id !== id ||
				!isRuntimeUiEndpointInfo(target) ||
				target.url !== reviewedUrl ||
				target.runtime !== endpoint.runtime
			)
				throw new RuntimeEndpointChangedError();
			let url: string;
			if (target.runtime === "hermes") {
				// The shared client pins the Hosted API origin.
				const handoff = await read(
					(s) =>
						deploymentMutations.createHermesDashboardHandoff(
							id,
							fresh.resource.metadata.resourceVersion,
							s,
						),
					signal,
				);
				if (!current()) return;
				url = handoff.url;
			} else {
				const credentials = await read(
					(s) =>
						deploymentMutations.runtimeCredentials(
							id,
							fresh.resource.metadata.resourceVersion,
							target.url,
							s,
						),
					signal,
				);
				if (!current()) return;
				url = credentials.handoff_url;
			}
			// The capability is local to this explicit action, never Router/query/storage state.
			await WebBrowser.openBrowserAsync(url);
			// Browser dismissal is not proof of authentication or a usable runtime session.
		});
	};
	const failure = action.error ? (
		<WebView recipe="flex flex-col items-center gap-1" accessibilityRole="alert">
			<AppText className="font-medium">{runtimeConsoleCopy.openFailed(label)}</AppText>
			<AppText>
				{browserHandoffFailureMessage(hermesDashboardHandoffFailure(action.failure), label)}
			</AppText>
		</WebView>
	) : null;
	if (overview)
		return (
			<>
				<OverviewNavigationCard
					title={agentOverviewCopy.chatOnWeb}
					description={
						deploymentRuntimeUiWithdrawn(deployment.resource.status)
							? `${label} is unavailable. Your agent keeps running.`
							: label
					}
					icon={PanelsTopLeft}
					tint={hostedAgentOverviewClasses.browserTint}
					disabled={!available || action.busy}
					onPress={available && !action.busy ? open : undefined}
				/>
				{failure}
			</>
		);
	return (
		<>
			<ActionButton
				label={runtimeConsoleCopy.open(label)}
				disabled={!available || action.busy}
				onPress={open}
			/>
			{failure}
		</>
	);
}
