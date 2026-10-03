import { useClerk, useUser } from "@clerk/expo";
import { useQueryClient } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { clearAccountScope, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function DeleteAccountScreen() {
	const scope = useAccountScope();
	const { isLoaded, user } = useUser();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	if (user.id !== scope.accountKey) return <LoadingScreen />;
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
	const { signOut } = useClerk();
	const router = useRouter();
	const queries = useQueryClient();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const confirmation = useRef(0);
	const [phrase, setPhrase] = useState("");
	const [outcome, setOutcome] = useState<"idle" | "uncertain" | "accepted">("idle");
	const leave = () =>
		void action.run(async (current) => {
			if (!scope.sessionId || !scope.isCurrent()) return;
			await signOut({ sessionId: scope.sessionId });
			const wasCurrent = scope.isCurrent();
			clearAccountScope(scope, queries);
			if (current() && wasCurrent) router.replace("/(auth)/sign-in");
		});
	const confirm = () => {
		if (!compute || phrase !== t("deletion.phrase") || outcome !== "idle" || action.busy) return;
		const signal = scope.signal;
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("deletion.title"), `${email}\n\n${t("deletion.warning")}`, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("deletion.confirm"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || signal.aborted || !scope.isCurrent() || !visible())
						return;
					confirmation.current++;
					void action.run(async (current) => {
						if (signal.aborted || !scope.isCurrent() || !visible()) return;
						setPhrase("");
						// A lost response cannot prove that termination was rejected. No automatic retry.
						setOutcome("uncertain");
						try {
							await read((requestSignal) => compute.deleteAccount(requestSignal), signal);
							if (!current() || !scope.isCurrent()) return;
							setOutcome("accepted");
							clearAccountScope(scope, queries);
						} catch {
							// Keep the uncertainty notice; a 401/403 is not proof of completed deletion.
						}
					});
				},
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-5 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("deletion.title")}
				</AppText>
				<AppText>{email}</AppText>
				<AppText>{t("deletion.warning")}</AppText>
				{outcome === "idle" ? (
					!compute ? (
						<AppText accessibilityRole="alert">{t("deletion.unavailable")}</AppText>
					) : (
						<>
							<AppText>{t("deletion.typePhrase")}</AppText>
							<AppTextInput
								accessibilityLabel={t("deletion.typePhrase")}
								value={phrase}
								onChangeText={setPhrase}
								autoCapitalize="characters"
								autoCorrect={false}
								editable={!action.busy}
								className="rounded-xl bg-surface p-3 text-foreground"
							/>
							<NativeButton
								label={t("deletion.confirm")}
								disabled={action.busy || phrase !== t("deletion.phrase")}
								onPress={confirm}
							/>
						</>
					)
				) : (
					<AppText accessibilityRole="alert">
						{t(outcome === "accepted" ? "deletion.accepted" : "deletion.uncertain")}
					</AppText>
				)}
				{outcome !== "idle" ? (
					<NativeButton label={t("account.signOut")} disabled={action.busy} onPress={leave} />
				) : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("account.signOutFailed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
