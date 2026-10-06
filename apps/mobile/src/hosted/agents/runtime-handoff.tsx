import {
	type DeploymentRead,
	hermesOidcLoginUrl,
	isRuntimeUiEndpointInfo,
} from "@clawdi/shared/api";
import { hostedAgentOverviewClasses } from "@clawdi/shared/ui";
import {
	agentOverviewCopy,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
	runtimeBrowserUiLabel,
} from "@clawdi/shared/view";
import * as WebBrowser from "expo-web-browser";
import { PanelsTopLeft } from "lucide-react-native";
import { useRef } from "react";
import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-layout";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function RuntimeBrowser({
	deployment,
	overview = false,
}: {
	deployment: DeploymentRead;
	overview?: boolean;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(`${scope.identity}:${deployment.resource.id}`);
	const { hosted, deploymentMutations } = useMobileApi();
	const confirmation = useRef(0);
	const nativeConfirmation = useConfirmation();
	const endpoint = deployment.runtime_ui_endpoint;
	const available =
		deploymentRuntimeUiIsReady(deployment) &&
		isRuntimeUiEndpointInfo(endpoint) &&
		Boolean(hosted && deploymentMutations);
	const open = () => {
		if (!available || !endpoint || !hosted || !deploymentMutations || action.busy) return;
		const reviewedUrl = endpoint.url;
		const id = deployment.resource.id;
		const signal = scope.signal;
		const visible = capture();
		const ticket = ++confirmation.current;
		nativeConfirmation.show(
			t("deployments.openDashboard"),
			`${reviewedUrl}\n\n${t("deployments.browserWarning")}`,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("deployments.openDashboard"),
					onPress: () => {
						if (
							ticket !== confirmation.current ||
							signal.aborted ||
							!scope.isCurrent() ||
							!visible()
						)
							return;
						return action.runOrThrow(async (active) => {
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
								throw new Error("Runtime endpoint changed");
							let url: string;
							if (target.runtime === "hermes") {
								// Browser owns its OIDC cookies. Never send the native Clerk token through a URL.
								url = hermesOidcLoginUrl(target.url);
								if (url === target.url) throw new Error("Runtime login unavailable");
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
							if (!current()) return;
							// The capability is local to this explicit action, never Router/query/storage state.
							await WebBrowser.openBrowserAsync(url);
							// Browser dismissal is not proof of authentication or a usable runtime session.
						});
					},
				},
			],
		);
	};
	if (overview)
		return (
			<>
				{nativeConfirmation.dialog}
				<OverviewNavigationCard
					title={agentOverviewCopy.chatOnWeb}
					description={
						deploymentRuntimeUiWithdrawn(deployment.resource.status)
							? `${runtimeBrowserUiLabel(deployment.resource.spec.runtime)} is unavailable. Your agent keeps running.`
							: runtimeBrowserUiLabel(deployment.resource.spec.runtime)
					}
					icon={PanelsTopLeft}
					tint={hostedAgentOverviewClasses.browserTint}
					disabled={!available || action.busy}
					onPress={available && !action.busy ? open : undefined}
				/>
				{action.error ? (
					<AppText accessibilityRole="alert">{t("deployments.browserFailed")}</AppText>
				) : null}
			</>
		);
	return (
		<>
			{nativeConfirmation.dialog}
			<ActionButton
				label={t("deployments.openDashboard")}
				disabled={!available || action.busy}
				onPress={open}
			/>
			{!available ? <AppText>{t("deployments.browserUnavailable")}</AppText> : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("deployments.browserFailed")}</AppText>
			) : null}
		</>
	);
}
