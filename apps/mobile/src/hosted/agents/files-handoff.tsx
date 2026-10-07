import {
	type DeploymentRead,
	FilesEndpointChangedError,
	type FilesHandoffFailure,
	filesHandoffFailure,
} from "@clawdi/shared/api";
import { deploymentFilesUrl, runtimeConsoleCopy } from "@clawdi/shared/view";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const failureMessage = {
	changed: "files.failedChanged",
	unavailable: "files.failedUnavailable",
	signed_out: "files.failedSignedOut",
	rate_limited: "files.failedRateLimited",
	offline: "files.failedOffline",
	failed: "files.failed",
} as const satisfies Record<FilesHandoffFailure, TranslationKey>;

/** Running Files: one-time hosted handoff into the system browser, with Terminal as fallback. */
export function FilesBrowser({
	deployment,
	onTerminal,
}: {
	deployment: DeploymentRead;
	onTerminal: () => void;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(`${scope.identity}:${deployment.resource.id}:files`);
	const { hosted, deploymentMutations } = useMobileApi();
	const confirmation = useRef(0);
	const nativeConfirmation = useConfirmation();
	const [failure, setFailure] = useState<FilesHandoffFailure>("failed");
	const filesUrl = deploymentFilesUrl(deployment);
	const available = Boolean(filesUrl && hosted && deploymentMutations);
	const open = () => {
		if (!filesUrl || !hosted || !deploymentMutations || action.busy) return;
		const reviewedUrl = filesUrl;
		const id = deployment.resource.id;
		const signal = scope.signal;
		const visible = capture();
		const ticket = ++confirmation.current;
		nativeConfirmation.show(
			t("files.open"),
			`${new URL(reviewedUrl).origin}\n\n${t("files.browserWarning")}`,
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("files.open"),
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
							try {
								if (!current()) return;
								const fresh = await read((s) => hosted.getDeployment(id, s), signal);
								if (!current()) return;
								if (fresh.resource.id !== id || deploymentFilesUrl(fresh) !== reviewedUrl)
									throw new FilesEndpointChangedError();
								// Minted only after confirmation; the shared client pins the reviewed origin.
								const handoff = await read(
									(s) =>
										deploymentMutations.createFilesHandoff(
											id,
											fresh.resource.metadata.resourceVersion,
											reviewedUrl,
											s,
										),
									signal,
								);
								if (!current()) return;
								// The one-time URL is local to this explicit action, never Router/query/storage state.
								await WebBrowser.openBrowserAsync(handoff.url);
								// Browser dismissal is not proof that the Files session was established.
							} catch (error) {
								if (current()) setFailure(filesHandoffFailure(error));
								throw error;
							}
						});
					},
				},
			],
		);
	};
	return (
		<>
			{nativeConfirmation.dialog}
			<WebView recipe="flex flex-wrap justify-center gap-2" className="flex-row">
				<ActionButton
					label={t("files.open")}
					variant="default"
					disabled={!available || action.busy}
					onPress={open}
				/>
				<ActionButton label={runtimeConsoleCopy.terminal} onPress={onTerminal} />
			</WebView>
			{action.error ? (
				<AppText accessibilityRole="alert">
					{`${t("files.failedTitle")}. ${t(failureMessage[failure])}`}
				</AppText>
			) : null}
		</>
	);
}
