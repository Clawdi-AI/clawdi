import {
	type DeploymentRead,
	FilesEndpointChangedError,
	filesHandoffFailure,
} from "@clawdi/shared/api";
import {
	agentToolSectionCopy,
	browserHandoffFailureMessage,
	deploymentFilesUrl,
	runtimeConsoleCopy,
} from "@clawdi/shared/view";
import * as WebBrowser from "expo-web-browser";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** Running Files: one-time hosted handoff into the system browser, with Terminal as fallback. */
export function FilesBrowser({
	deployment,
	onTerminal,
}: {
	deployment: DeploymentRead;
	onTerminal: () => void;
}) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const action = useAuthAction(`${scope.identity}:${deployment.resource.id}:files`);
	const { hosted, deploymentMutations } = useMobileApi();
	const label = agentToolSectionCopy.files.label;
	const filesUrl = deploymentFilesUrl(deployment);
	const available = Boolean(filesUrl && hosted && deploymentMutations);
	const open = async () => {
		if (!filesUrl || !hosted || !deploymentMutations || action.busy) return;
		const reviewedUrl = filesUrl;
		const id = deployment.resource.id;
		const signal = scope.signal;
		const visible = capture();
		await action.run(async (active) => {
			const current = () => active() && visible() && !signal.aborted && scope.isCurrent();
			if (!current()) return;
			const fresh = await read((s) => hosted.getDeployment(id, s), signal);
			if (!current()) return;
			if (fresh.resource.id !== id || deploymentFilesUrl(fresh) !== reviewedUrl)
				throw new FilesEndpointChangedError();
			// The shared client pins the Files origin.
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
		});
	};
	return (
		<>
			<WebView recipe="flex flex-wrap justify-center gap-2" className="flex-row">
				<ActionButton
					label={runtimeConsoleCopy.open(label)}
					variant="default"
					disabled={!available || action.busy}
					onPress={open}
				/>
				<ActionButton label={runtimeConsoleCopy.terminal} onPress={onTerminal} />
			</WebView>
			{action.error ? (
				<WebView recipe="flex flex-col items-center gap-1" accessibilityRole="alert">
					<AppText className="font-medium">{runtimeConsoleCopy.openFailed(label)}</AppText>
					<AppText>
						{browserHandoffFailureMessage(filesHandoffFailure(action.failure), label)}
					</AppText>
				</WebView>
			) : null}
		</>
	);
}
