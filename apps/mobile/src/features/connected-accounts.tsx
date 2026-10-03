import { useUser } from "@clerk/expo";
import type { UserResource } from "@clerk/expo/types";
import { randomUUID } from "expo-crypto";
import { Redirect, useFocusEffect } from "expo-router";
import { openAuthSessionAsync } from "expo-web-browser";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import {
	accountOAuthAuthorizationUrl,
	accountOAuthNonce,
	accountOAuthRedirect,
	accountOAuthReturnUrl,
} from "../auth/account-oauth";
import { useAuthAction } from "../auth/use-auth-action";
import { useNativeReverification } from "../auth/use-native-reverification";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function ConnectedAccountsScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <ConnectedAccounts key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function ConnectedAccounts({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const pageEpoch = useRef(0);
	useFocusEffect(
		useCallback(
			() => () => {
				pageEpoch.current++;
			},
			[],
		),
	);
	const [accounts, setAccounts] = useState([...user.externalAccounts]);
	const [saved, setSaved] = useState(false);
	const [reauthorized, setReauthorized] = useState(false);
	const reauthorize = (id: string) =>
		void action.run(async (active) => {
			const epoch = pageEpoch.current;
			const signal = scope.signal;
			const owned = () =>
				active() &&
				!signal.aborted &&
				scope.isCurrent() &&
				user.id === scope.accountKey &&
				pageEpoch.current === epoch;
			const visible = capture();
			if (!owned() || !visible()) return;
			setSaved(false);
			setReauthorized(false);
			const redirectUrl = accountOAuthRedirect(randomUUID());
			let authorizationUrl: string | undefined;
			await reverification.execute(async () => {
				if (!owned() || !visible()) throw new Error("Account action retired");
				await user.reload();
				if (!owned() || !visible()) return;
				const account = user.externalAccounts.find((value) => value.id === id);
				if (!account) throw new Error("Connection no longer exists");
				const result = await account.reauthorize({ redirectUrl });
				if (!owned() || !visible()) return;
				if (result.id !== id) throw new Error("Connection identity changed");
				authorizationUrl = accountOAuthAuthorizationUrl(
					result.verification?.externalVerificationRedirectURL,
				);
			});
			if (!authorizationUrl || !owned() || !visible()) return;
			// The system browser intentionally backgrounds the app; page/account changes still retire this operation.
			const result = await openAuthSessionAsync(authorizationUrl, accountOAuthReturnUrl);
			if (!owned() || result.type !== "success") return;
			const rotatingTokenNonce = accountOAuthNonce(result.url, redirectUrl);
			await user.reload({ rotatingTokenNonce });
			if (!owned() || !capture()()) return;
			setAccounts([...user.externalAccounts]);
			const updated = user.externalAccounts.find((value) => value.id === id);
			if (updated?.verification?.status !== "verified")
				throw new Error("Connection authorization incomplete");
			setReauthorized(true);
		});
	const run = (removeId?: string) =>
		void action.run(async (active) => {
			const visible = capture();
			const current = () =>
				active() && visible() && scope.isCurrent() && user.id === scope.accountKey;
			if (!current()) return;
			setSaved(false);
			setReauthorized(false);
			await reverification.execute(async () => {
				if (!current()) throw new Error("Account action retired");
				await user.reload();
				if (!current()) return;
				setAccounts([...user.externalAccounts]);
				if (!removeId) return;
				// Reconcile an ambiguous deletion before the explicit retry.
				const account = user.externalAccounts.find((value) => value.id === removeId);
				if (account) {
					await account.destroy();
					if (!current()) return;
					await user.reload();
					if (!current()) return;
					setAccounts([...user.externalAccounts]);
					if (user.externalAccounts.some((value) => value.id === removeId))
						throw new Error("Account unlink not confirmed");
				}
				setSaved(true);
			});
		});
	const confirmRemove = (id: string) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("connections.remove"), t("connections.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("connections.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					run(id);
				},
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("connections.title")}
				</AppText>
				<AppText>{t("connections.description")}</AppText>
				{reverification.prompt}
				<NativeButton label={t("inventory.refresh")} disabled={action.busy} onPress={() => run()} />
				{accounts.length === 0 ? <AppText>{t("connections.empty")}</AppText> : null}
				{accounts.map((account) => (
					<AppView key={account.id} className="gap-2 rounded-xl bg-surface p-4">
						<AppText>{account.providerTitle()}</AppText>
						<AppText selectable>{account.accountIdentifier()}</AppText>
						<AppText>
							{t(
								account.verification?.status === "verified"
									? "connections.verified"
									: "connections.unverified",
							)}
						</AppText>
						<NativeButton
							label={t("connections.reauthorize")}
							disabled={action.busy}
							onPress={() => void reauthorize(account.id)}
						/>
						<NativeButton
							label={t("connections.remove")}
							disabled={action.busy}
							onPress={() => confirmRemove(account.id)}
						/>
					</AppView>
				))}
				<AppText>{t("connections.linkingUnavailable")}</AppText>
				{action.error ? (
					<AppText accessibilityRole="alert">{t("connections.failed")}</AppText>
				) : null}
				{saved ? <AppText accessibilityRole="alert">{t("connections.saved")}</AppText> : null}
				{reauthorized ? (
					<AppText accessibilityRole="alert">{t("connections.reauthorized")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
