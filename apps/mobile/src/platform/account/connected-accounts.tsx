import { useUser } from "@clerk/expo";
import type { OAuthProvider, UserResource } from "@clerk/expo/types";
import { randomUUID } from "expo-crypto";
import { Redirect, useFocusEffect } from "expo-router";
import { openAuthSessionAsync } from "expo-web-browser";
import { useCallback, useRef, useState } from "react";
import { ConnectedAccountsFormView } from "@/components/settings/account-forms";
import { LoadingScreen } from "@/components/ui/feedback";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import {
	accountOAuthAuthorizationUrl,
	accountOAuthNonce,
	accountOAuthRedirect,
	accountOAuthReturnUrl,
} from "@/platform/auth/account-oauth";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useNativeReverification } from "@/platform/auth/use-native-reverification";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ConnectedAccountsScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/sign-in" />;
	return <ConnectedAccounts key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function ConnectedAccounts({ user }: { user: UserResource }) {
	const t = useI18n();
	const config = useMobileRuntimeConfig();
	const providers = config.ok ? (config.value.clerkOauthProviders ?? []) : [];
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const confirmationDialog = useConfirmation();
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
	const authorize = (target: { id: string } | { provider: OAuthProvider }) =>
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
			let expectedId: string | undefined;
			await reverification.execute(async () => {
				if (!owned() || !visible()) throw new Error("Account action retired");
				await user.reload();
				if (!owned() || !visible()) return;
				const account = user.externalAccounts.find((value) =>
					"id" in target ? value.id === target.id : value.provider === target.provider,
				);
				if ("id" in target && !account) throw new Error("Connection no longer exists");
				if ("provider" in target && !providers.includes(target.provider))
					throw new Error("Provider is not configured");
				// Reuse pending resources after an ambiguous create; never blindly create another link.
				const result = account
					? await account.reauthorize({ redirectUrl })
					: "provider" in target
						? await user.createExternalAccount({
								strategy: `oauth_${target.provider}`,
								redirectUrl,
							})
						: undefined;
				if (!owned() || !visible()) return;
				if (
					!result?.id ||
					(account && result.id !== account.id) ||
					("provider" in target && result.provider !== target.provider)
				)
					throw new Error("Connection identity changed");
				expectedId = result.id;
				authorizationUrl = accountOAuthAuthorizationUrl(
					result.verification?.externalVerificationRedirectURL,
				);
			});
			if (!authorizationUrl || !expectedId || !owned() || !visible()) return;
			// The system browser intentionally backgrounds the app; page/account changes still retire this operation.
			const result = await openAuthSessionAsync(authorizationUrl, accountOAuthReturnUrl);
			if (!owned() || result.type !== "success") return;
			const rotatingTokenNonce = accountOAuthNonce(result.url, redirectUrl);
			await user.reload({ rotatingTokenNonce });
			if (!owned() || !capture()()) return;
			setAccounts([...user.externalAccounts]);
			const updated = user.externalAccounts.find((value) => value.id === expectedId);
			if (updated?.verification?.status !== "verified")
				throw new Error("Connection authorization incomplete");
			setReauthorized(true);
		});
	const run = (removeId?: string, propagate = false) =>
		(propagate ? action.runOrThrow : action.run)(async (active) => {
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
		confirmationDialog.show(t("connections.remove"), t("connections.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("connections.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					return run(id, true);
				},
			},
		]);
	};
	return (
		<>
			{confirmationDialog.dialog}
			<ConnectedAccountsFormView
				action={action}
				reverification={reverification}
				accounts={accounts}
				providers={providers}
				saved={saved}
				reauthorized={reauthorized}
				run={run}
				authorize={authorize}
				confirmRemove={confirmRemove}
			/>
		</>
	);
}
