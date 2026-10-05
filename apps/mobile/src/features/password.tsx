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
import { PasswordFormView } from "../ui/settings/account-forms";

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
		<PasswordFormView
			action={action}
			reverification={reverification}
			enabled={enabled}
			oldPassword={oldPassword}
			newPassword={newPassword}
			confirmationPassword={confirmationPassword}
			otherSessions={otherSessions}
			success={success}
			setOldPassword={setOldPassword}
			setNewPassword={setNewPassword}
			setConfirmationPassword={setConfirmationPassword}
			setOtherSessions={setOtherSessions}
			edit={edit}
			update={update}
			confirmRemove={confirmRemove}
		/>
	);
}
