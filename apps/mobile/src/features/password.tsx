import { useUser } from "@clerk/expo";
import type { UserResource } from "@clerk/expo/types";
import { Redirect, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useNativeReverification } from "../auth/use-native-reverification";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton, NativeSwitch } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function PasswordScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <PasswordForm key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function PasswordForm({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const [enabled, setEnabled] = useState(user.passwordEnabled);
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmationPassword, setConfirmationPassword] = useState("");
	const [otherSessions, setOtherSessions] = useState(false);
	const [success, setSuccess] = useState(false);
	const edit = (setter: (value: string) => void) => (value: string) => {
		setter(value);
		setSuccess(false);
	};
	const clear = useCallback(() => {
		setOldPassword("");
		setNewPassword("");
		setConfirmationPassword("");
	}, []);
	useFocusEffect(useCallback(() => clear, [clear]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => listener.remove();
	}, [clear]);
	const update = (remove: boolean) =>
		void action.run(async (active) => {
			const visible = capture();
			const current = () =>
				active() &&
				scope.isCurrent() &&
				!scope.signal.aborted &&
				user.id === scope.accountKey &&
				visible();
			if (!current()) return;
			setSuccess(false);
			if (!remove && (!newPassword || newPassword !== confirmationPassword))
				throw new Error("Passwords do not match");
			try {
				await reverification.execute(async () => {
					if (!current()) throw new Error("Account action retired");
					await user.reload();
					if (!current()) throw new Error("Account action retired");
					setEnabled(user.passwordEnabled);
					if (user.passwordEnabled && !oldPassword) throw new Error("Current password required");
					if (remove && !user.passwordEnabled) throw new Error("Password already absent");
					const updated = remove
						? await user.removePassword({ currentPassword: oldPassword })
						: await user.updatePassword({
								currentPassword: oldPassword || undefined,
								newPassword,
								signOutOfOtherSessions: otherSessions,
							});
					if (!current()) return;
					if (updated.id !== user.id || updated.passwordEnabled !== !remove)
						throw new Error("Password change not confirmed");
					setEnabled(updated.passwordEnabled);
					setSuccess(true);
				});
			} finally {
				if (active()) clear();
			}
		});
	const confirmRemove = () => {
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("password.remove"), t("password.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("password.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					update(true);
				},
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("password.title")}
				</AppText>
				<AppText>{t("password.description")}</AppText>
				<AppText>{t(enabled ? "password.enabled" : "password.absent")}</AppText>
				{reverification.prompt}
				{enabled ? (
					<AppTextInput
						accessibilityLabel={t("password.current")}
						placeholder={t("password.current")}
						value={oldPassword}
						onChangeText={edit(setOldPassword)}
						editable={!action.busy}
						secureTextEntry
						autoComplete="current-password"
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={256}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
				) : null}
				<AppTextInput
					accessibilityLabel={t("password.new")}
					placeholder={t("password.new")}
					value={newPassword}
					onChangeText={edit(setNewPassword)}
					editable={!action.busy}
					secureTextEntry
					autoComplete="new-password"
					autoCapitalize="none"
					autoCorrect={false}
					maxLength={256}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
				<AppTextInput
					accessibilityLabel={t("password.confirm")}
					placeholder={t("password.confirm")}
					value={confirmationPassword}
					onChangeText={edit(setConfirmationPassword)}
					editable={!action.busy}
					secureTextEntry
					autoComplete="new-password"
					autoCapitalize="none"
					autoCorrect={false}
					maxLength={256}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
				<NativeSwitch
					label={t("password.otherSessions")}
					value={otherSessions}
					onValueChange={setOtherSessions}
					disabled={action.busy}
				/>
				<NativeButton
					label={t(enabled ? "password.update" : "password.add")}
					disabled={
						action.busy ||
						!newPassword ||
						newPassword !== confirmationPassword ||
						(enabled && !oldPassword)
					}
					onPress={() => update(false)}
				/>
				{enabled ? (
					<NativeButton
						label={t("password.remove")}
						disabled={action.busy || !oldPassword}
						onPress={confirmRemove}
					/>
				) : null}
				{action.error ? <AppText accessibilityRole="alert">{t("password.failed")}</AppText> : null}
				{success ? <AppText accessibilityRole="alert">{t("password.saved")}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
