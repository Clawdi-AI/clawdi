import { canCancelDeploymentOperation, type HostedDeployOperation } from "@clawdi/shared/api";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { ActionButton } from "@/components/dashboard/controls";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** A cancellation has one immutable target and cannot be undone. Deriving its
 * key from account+operation allows the same explicit retry after app restart.
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
	const t = useI18n();
	const confirmation = useRef(0);
	const [requested, setRequested] = useState(false);
	if (!canCancelDeploymentOperation(operation)) return null;
	const confirm = () => {
		if (action.busy || requested || !scope.isReady || !deploymentMutations) return;
		const visible = capture();
		const ticket = ++confirmation.current;
		const name = operation.name;
		Alert.alert(t("deployments.cancelChange"), t("deployments.cancelWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("deployments.cancelChange"),
				style: "destructive",
				onPress: () => {
					if (
						confirmation.current !== ticket ||
						!visible() ||
						!scope.isCurrent() ||
						scope.signal.aborted
					)
						return;
					confirmation.current++;
					void action.run(async (current) => {
						const key = `mobile-cancel-v1-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify([scope.accountKey, name]))}`;
						if (!current() || !visible()) return;
						await read((signal) => deploymentMutations.cancel(name, key, signal));
						if (!current()) return;
						setRequested(true);
						await onRequested();
					});
				},
			},
		]);
	};
	return (
		<AppView className="gap-3">
			<ActionButton
				label={t("deployments.cancelChange")}
				disabled={action.busy || requested || !scope.isReady || !deploymentMutations}
				onPress={confirm}
			/>
			{requested ? (
				<AppText accessibilityRole="alert">{t("deployments.cancelRequested")}</AppText>
			) : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("deployments.cancelUncertain")}</AppText>
			) : null}
		</AppView>
	);
}
