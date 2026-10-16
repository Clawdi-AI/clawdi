import { canCancelDeploymentOperation, type HostedDeployOperation } from "@clawdi/shared/api";
import { apiErrorCopy, computeStatusDetailsCopy as copy } from "@clawdi/shared/view";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import CircleStop from "lucide-react-native/icons/circle-stop";
import { useState } from "react";
import { ActionButton } from "@/components/dashboard/controls";
import { Icon } from "@/components/ui/icon";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useMobileApi } from "@/lib/api-provider";
import { requestFailure } from "@/lib/request-failure";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** Web's DeploymentCancelAction. A cancellation has one immutable target and cannot be undone;
 * deriving its key from account+operation makes a retry, even after app restart, the same request.
 */
export function CancelOperation({
	operation,
	onRequested,
}: {
	operation: HostedDeployOperation;
	onRequested: () => Promise<void>;
}) {
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { deploymentMutations } = useMobileApi();
	const [requested, setRequested] = useState(false);
	if (!canCancelDeploymentOperation(operation)) return null;
	const cancel = () => {
		if (action.busy || requested || !scope.isReady || !deploymentMutations) return;
		const visible = capture();
		const name = operation.name;
		void action.run(async (current) => {
			const key = `mobile-cancel-v1-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify([scope.accountKey, name]))}`;
			if (!current() || !visible()) return;
			await read((signal) => deploymentMutations.cancel(name, key, signal));
			if (!current()) return;
			setRequested(true);
			await onRequested();
		});
	};
	return (
		<AppView className="gap-1.5">
			<ActionButton
				label={copy.cancel}
				icon={<Icon as={CircleStop} />}
				className="self-start"
				disabled={action.busy || requested || !scope.isReady || !deploymentMutations}
				onPress={cancel}
			/>
			{requested ? (
				<AppView accessibilityLiveRegion="polite">
					<AppText className="font-medium text-foreground">{copy.cancelRequested}</AppText>
					<AppText className="text-muted-foreground">{copy.cancelRequestedDescription}</AppText>
				</AppView>
			) : null}
			{action.error ? (
				<AppView accessibilityRole="alert">
					<AppText className="font-medium text-destructive">{copy.cancelFailed}</AppText>
					<AppText className="text-muted-foreground">
						{apiErrorCopy(requestFailure(action.failure))}
					</AppText>
				</AppView>
			) : null}
		</AppView>
	);
}
