import { useUser } from "@clerk/expo";
import type { UserResource } from "@clerk/expo/types";
import { Redirect } from "expo-router";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useNativeReverification } from "../auth/use-native-reverification";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function PasskeysScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <Passkeys key={`${scope.identity}:${scope.generation}`} user={user} />;
}

type Change = { kind: "rename"; id: string; name: string } | { kind: "remove"; id: string };

function Passkeys({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const [passkeys, setPasskeys] = useState([...user.passkeys]);
	const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
	const [saved, setSaved] = useState(false);
	const run = (change?: Change) =>
		void action.run(async (active) => {
			const visible = capture();
			const signal = scope.signal;
			const current = () =>
				active() &&
				visible() &&
				!signal.aborted &&
				scope.isCurrent() &&
				user.id === scope.accountKey;
			if (!current()) return;
			setSaved(false);
			await reverification.execute(async () => {
				if (!current()) throw new Error("Account action retired");
				const refreshed = await user.reload();
				if (!current()) return;
				if (refreshed.id !== scope.accountKey) throw new Error("Account identity changed");
				setPasskeys([...refreshed.passkeys]);
				if (!change) return;
				const passkey = refreshed.passkeys.find((value) => value.id === change.id);
				if (change.kind === "rename") {
					const name = change.name.trim();
					if (!passkey || !name) throw new Error("Passkey unavailable or name missing");
					// A retry first reads current state, avoiding an unnecessary repeated mutation.
					if (passkey.name !== name) {
						const updated = await passkey.update({ name });
						if (!current()) return;
						if (updated.id !== change.id || updated.name !== name)
							throw new Error("Passkey rename not confirmed");
					}
				} else if (passkey) {
					await passkey.delete();
					if (!current()) return;
				}
				const confirmed = await user.reload();
				if (!current()) return;
				if (confirmed.id !== scope.accountKey) throw new Error("Account identity changed");
				setPasskeys([...confirmed.passkeys]);
				const remaining = confirmed.passkeys.find((value) => value.id === change.id);
				if (change.kind === "remove" ? Boolean(remaining) : remaining?.name !== change.name.trim())
					throw new Error("Passkey change not confirmed");
				setEdit(null);
				setSaved(true);
			});
		});
	const confirmRemove = (id: string) => {
		const visible = capture();
		const signal = scope.signal;
		const ticket = ++confirmation.current;
		Alert.alert(t("passkeys.remove"), t("passkeys.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("passkeys.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || signal.aborted || !scope.isCurrent())
						return;
					confirmation.current++;
					run({ kind: "remove", id });
				},
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("passkeys.title")}
				</AppText>
				<AppText>{t("passkeys.description")}</AppText>
				{reverification.prompt}
				<NativeButton label={t("inventory.refresh")} disabled={action.busy} onPress={() => run()} />
				{passkeys.length === 0 ? <AppText>{t("passkeys.empty")}</AppText> : null}
				{passkeys.map((passkey) => (
					<AppView key={passkey.id} className="gap-3 rounded-xl bg-surface p-4">
						<AppText className="text-lg font-semibold text-foreground">
							{passkey.name || t("passkeys.unnamed")}
						</AppText>
						<AppText>
							{t("passkeys.lastUsed")}{" "}
							{passkey.lastUsedAt && Number.isFinite(passkey.lastUsedAt.getTime())
								? passkey.lastUsedAt.toLocaleString()
								: t("passkeys.neverUsed")}
						</AppText>
						{edit?.id === passkey.id ? (
							<>
								<AppTextInput
									accessibilityLabel={t("passkeys.name")}
									value={edit.name}
									onChangeText={(name) => setEdit({ id: passkey.id, name })}
									editable={!action.busy}
									autoCorrect={false}
									className="rounded-xl bg-background p-3 text-foreground"
								/>
								<NativeButton
									label={t("passkeys.save")}
									disabled={action.busy || !edit.name.trim()}
									onPress={() => run({ kind: "rename", ...edit })}
								/>
								<NativeButton
									label={t("account.cancel")}
									disabled={action.busy}
									onPress={() => setEdit(null)}
								/>
							</>
						) : (
							<NativeButton
								label={t("passkeys.rename")}
								disabled={action.busy}
								onPress={() => {
									setSaved(false);
									action.clearError();
									setEdit({ id: passkey.id, name: passkey.name ?? "" });
								}}
							/>
						)}
						<NativeButton
							label={t("passkeys.remove")}
							disabled={action.busy}
							onPress={() => confirmRemove(passkey.id)}
						/>
					</AppView>
				))}
				<AppText>{t("passkeys.nativeUnavailable")}</AppText>
				{action.error ? <AppText accessibilityRole="alert">{t("passkeys.failed")}</AppText> : null}
				{saved ? <AppText accessibilityRole="alert">{t("passkeys.saved")}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
