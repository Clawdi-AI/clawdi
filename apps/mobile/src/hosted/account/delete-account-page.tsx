import {
	type DeletedAccountSessionEnd,
	deleteAccountThenSignOut,
	endDeletedAccountSession,
	STORE_SUBSCRIPTIONS_URL,
} from "@clawdi/shared/view";
import { useClerk, useUser } from "@clerk/expo";
import { TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Linking, Platform } from "react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { LoadingScreen, Spinner } from "@/components/ui/feedback";
import { Text } from "@/components/ui/text";
import { AppScrollView, AppView } from "@/components/ui/view";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const STORE_SUBSCRIPTIONS = Platform.select({
	ios: { url: STORE_SUBSCRIPTIONS_URL.appStore, label: "accountDeletion.manageAppStore" } as const,
	android: {
		url: STORE_SUBSCRIPTIONS_URL.googlePlay,
		label: "accountDeletion.manageGooglePlay",
	} as const,
});

/** Clerk `UserProfileView` custom page that replaces the built-in delete once self-deletion is off. */
export function DeleteAccountPage() {
	const scope = useAccountScope();
	const { user } = useUser();
	if (!user || !scope.isReady || user.id !== scope.accountKey) return <LoadingScreen />;
	return (
		<DeleteAccount
			key={`${scope.identity}:${scope.generation}`}
			email={user.primaryEmailAddress?.emailAddress ?? user.id}
		/>
	);
}

function DeleteAccount({ email }: { email: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { compute } = useMobileApi();
	const clerk = useClerk();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [outcome, setOutcome] = useState<"idle" | "deleting" | "uncertain" | "accepted">("idle");
	// Sign-out reaches the auth gates through the synced JS session; the native view follows.
	const endSession = async (): Promise<DeletedAccountSessionEnd> =>
		scope.sessionId && scope.isCurrent()
			? endDeletedAccountSession(clerk, { sessionId: scope.sessionId })
			: "signed-out";
	const leave = () =>
		void action.run(async () => {
			if ((await endSession()) === "failed") throw new Error("sign_out_failed");
		});
	const confirm = () => {
		if (!compute || outcome !== "idle" || action.busy) return;
		const signal = scope.signal;
		const visible = capture();
		return action.run(async (current) => {
			if (signal.aborted || !scope.isCurrent() || !visible()) return;
			setOutcome("deleting");
			// A lost response cannot prove that termination was rejected. No automatic retry.
			const result = await deleteAccountThenSignOut({
				deleteAccount: () => read((requestSignal) => compute.deleteAccount(requestSignal), signal),
				endSession,
			});
			if (!current()) return;
			if (result.outcome === "uncertain") {
				setOutcome("uncertain");
				return;
			}
			setOutcome("accepted");
			if (result.session === "failed") throw new Error("sign_out_failed");
		});
	};
	return (
		<AppScrollView
			className="flex-1 bg-background"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="gap-4 p-5"
		>
			<Text className="text-sm text-muted-foreground">{email}</Text>
			<Text className="text-sm">{t("accountDeletion.warning")}</Text>
			<Text className="text-sm">{t("accountDeletion.billing")}</Text>
			<Alert
				variant="destructive"
				icon={TriangleAlert}
				title={t("accountDeletion.storeNoticeTitle")}
			>
				{t("accountDeletion.storeNotice")}
			</Alert>
			{STORE_SUBSCRIPTIONS ? (
				<Button
					variant="outline"
					onPress={() => {
						const visible = capture();
						if (visible()) void Linking.openURL(STORE_SUBSCRIPTIONS.url).catch(() => undefined);
					}}
				>
					<Text>{t(STORE_SUBSCRIPTIONS.label)}</Text>
				</Button>
			) : null}
			{outcome === "idle" ? (
				!compute ? (
					<Alert>{t("accountDeletion.unavailable")}</Alert>
				) : (
					<ConfirmAction
						title={t("accountDeletion.confirmTitle")}
						description={`${email}\n\n${t("accountDeletion.warning")}\n\n${t("accountDeletion.billing")}`}
						cancelLabel={t("accountDeletion.cancel")}
						confirmLabel={t("accountDeletion.confirm")}
						destructive
						onConfirm={confirm}
					>
						<Button variant="destructive" disabled={action.busy}>
							<Text>{t("accountDeletion.action")}</Text>
						</Button>
					</ConfirmAction>
				)
			) : outcome === "deleting" ? (
				<AppView className="flex-row items-center gap-2">
					<Spinner label={t("accountDeletion.deleting")} />
					<Text className="text-sm">{t("accountDeletion.deleting")}</Text>
				</AppView>
			) : (
				<>
					<Alert variant="destructive">
						{t(outcome === "accepted" ? "accountDeletion.accepted" : "accountDeletion.uncertain")}
					</Alert>
					<Button variant="outline" disabled={action.busy} onPress={leave}>
						<Text>{t("accountDeletion.signOut")}</Text>
					</Button>
				</>
			)}
			{action.error ? (
				<Alert variant="destructive">{t("accountDeletion.signOutFailed")}</Alert>
			) : null}
		</AppScrollView>
	);
}
