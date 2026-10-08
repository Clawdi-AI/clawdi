import {
	accountDeletionStoreNoticeCopy,
	type DeletedAccountSessionEnd,
	deleteAccountThenSignOut,
	endDeletedAccountSession,
	STORE_MANAGEMENT_URLS,
} from "@clawdi/shared/view";
import { useClerk, useUser } from "@clerk/expo";
import { TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Linking } from "react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction, RichConfirmAction } from "@/components/ui/confirm-action";
import { LoadingScreen, Spinner } from "@/components/ui/feedback";
import { Text } from "@/components/ui/text";
import { AppScrollView, AppView } from "@/components/ui/view";
import { mobileAccountDeletionStoreNotice } from "@/hosted/account/account-deletion-store";
import { uniqueBillingItems } from "@/hosted/billing/format";
import { useSubscriptions } from "@/hosted/billing/hooks";
import { useManageStoreSubscription } from "@/hosted/billing/store/compute-store";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { currentStorePlatform } from "@/platform/store/store-platform";
import { useMobileStore } from "@/platform/store/store-provider";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const MANAGE_LABELS = {
	app_store: "accountDeletion.manageAppStore",
	play_store: "accountDeletion.manageGooglePlay",
} as const;

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
	const [storeStep, setStoreStep] = useState(false);
	const [confirming, setConfirming] = useState(false);
	// Apple 5.1.1(v): a live store contract adds a "cancel it first" step. Not a hard block.
	const subscriptions = useSubscriptions();
	const { computeSlot } = useMobileStore();
	const storeNotice = mobileAccountDeletionStoreNotice(
		subscriptions.data
			? uniqueBillingItems(
					subscriptions.data.pages.flatMap((page) => page.items ?? []),
					(item) => item.subscription_id,
				)
			: null,
		Boolean(subscriptions.data) && !subscriptions.hasNextPage,
		computeSlot,
	);
	const storeCopy =
		storeNotice.kind === "store"
			? accountDeletionStoreNoticeCopy(storeNotice.management.provider)
			: null;
	const platform = currentStorePlatform();
	// A named contract uses the app's official store management path; it is only
	// actionable on the store that bills it. The generic notice links this device's store.
	const storeManage = useManageStoreSubscription(
		storeNotice.kind === "store" ? storeNotice.management : null,
	);
	const genericUrl =
		storeNotice.kind === "generic" && platform ? STORE_MANAGEMENT_URLS[platform] : null;
	const openGenericLink = () => {
		const visible = capture();
		if (genericUrl && visible()) void Linking.openURL(genericUrl).catch(() => undefined);
	};
	const manage = storeManage ?? (genericUrl ? { manage: openGenericLink, busy: false } : null);
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
			{storeNotice.kind !== "none" ? (
				<Alert
					variant="destructive"
					icon={TriangleAlert}
					title={storeCopy?.title ?? t("accountDeletion.storeNoticeTitle")}
				>
					{storeCopy?.description ?? t("accountDeletion.storeNotice")}
				</Alert>
			) : null}
			{manage && platform ? (
				<Button variant="outline" disabled={manage.busy} onPress={() => void manage.manage()}>
					<Text>{t(MANAGE_LABELS[platform])}</Text>
				</Button>
			) : null}
			{outcome === "idle" ? (
				!compute ? (
					<Alert>{t("accountDeletion.unavailable")}</Alert>
				) : (
					<>
						{storeCopy ? (
							<RichConfirmAction
								open={storeStep}
								onOpenChange={setStoreStep}
								title={storeCopy.title}
								description={storeCopy.description}
								cancelLabel={t("accountDeletion.cancel")}
								secondaryAction={
									manage ? { label: t("storeCompute.manage"), onAction: manage.manage } : undefined
								}
								confirmLabel={t("storeCompute.deletionContinue")}
								onConfirm={() => setConfirming(true)}
							/>
						) : null}
						<ConfirmAction
							open={confirming}
							onOpenChange={setConfirming}
							title={t("accountDeletion.confirmTitle")}
							description={`${email}\n\n${t("accountDeletion.warning")}\n\n${t("accountDeletion.billing")}`}
							cancelLabel={t("accountDeletion.cancel")}
							confirmLabel={t("accountDeletion.confirm")}
							destructive
							onConfirm={confirm}
						/>
						<Button
							variant="destructive"
							disabled={action.busy}
							onPress={() => (storeCopy ? setStoreStep(true) : setConfirming(true))}
						>
							<Text>{t("accountDeletion.action")}</Text>
						</Button>
					</>
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
