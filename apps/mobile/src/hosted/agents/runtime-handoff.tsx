import {
	type DeploymentRead,
	type HermesDashboardHandoffFailure,
	hermesDashboardHandoffFailure,
	isRuntimeUiEndpointInfo,
	RuntimeEndpointChangedError,
} from "@clawdi/shared/api";
import { hostedAgentOverviewClasses } from "@clawdi/shared/ui";
import {
	agentOverviewCopy,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
	runtimeBrowserUiLabel,
} from "@clawdi/shared/view";
import * as WebBrowser from "expo-web-browser";
import PanelsTopLeft from "lucide-react-native/icons/panels-top-left";
import { useRef, useState } from "react";
import { OverviewNavigationCard } from "@/components/dashboard/agent-overview-layout";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const failureMessage = {
	changed: "deployments.browserFailedChanged",
	unavailable: "deployments.browserFailedUnavailable",
	signed_out: "deployments.browserFailedSignedOut",
	rate_limited: "deployments.browserFailedRateLimited",
	offline: "deployments.browserFailedOffline",
	failed: "deployments.browserFailed",
} as const satisfies Record<HermesDashboardHandoffFailure, TranslationKey>;

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
	const [failure, setFailure] = useState<HermesDashboardHandoffFailure>("failed");
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
							setFailure("failed");
							try {
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
									throw endpoint.runtime === "hermes"
										? new RuntimeEndpointChangedError()
										: new Error("Runtime endpoint changed");
								let url: string;
								if (target.runtime === "hermes") {
									// Mint only after confirmation; the shared client pins the Hosted API origin.
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
								if (!current()) return;
								// The capability is local to this explicit action, never Router/query/storage state.
								await WebBrowser.openBrowserAsync(url);
								// Browser dismissal is not proof of authentication or a usable runtime session.
							} catch (error) {
								if (current()) setFailure(hermesDashboardHandoffFailure(error));
								throw error;
							}
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
					<AppText accessibilityRole="alert">
						{t(
							endpoint?.runtime === "hermes"
								? failureMessage[failure]
								: "deployments.browserFailed",
						)}
					</AppText>
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
				<AppText accessibilityRole="alert">
					{t(
						endpoint?.runtime === "hermes" ? failureMessage[failure] : "deployments.browserFailed",
					)}
				</AppText>
			) : null}
		</>
	);
}
