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
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function EmailAddressesScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <EmailAddresses key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function EmailAddresses({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const capture = useForegroundLease();
	const confirmation = useRef(0);
	const [emails, setEmails] = useState([...user.emailAddresses]);
	const [primary, setPrimary] = useState(user.primaryEmailAddressId);
	const [draft, setDraft] = useState("");
	const [verifying, setVerifying] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [saved, setSaved] = useState(false);
	useFocusEffect(useCallback(() => () => setCode(""), []));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") setCode("");
		});
		return () => listener.remove();
	}, []);
	const sync = () => {
		setEmails([...user.emailAddresses]);
		setPrimary(user.primaryEmailAddressId);
	};
	const run = (work: (current: () => boolean) => Promise<void>) =>
		void action.run(async (active) => {
			const visible = capture();
			const current = () =>
				active() && scope.isCurrent() && user.id === scope.accountKey && visible();
			if (!current()) return;
			setSaved(false);
			await reverification.execute(async () => {
				if (!current()) throw new Error("Account action retired");
				await work(current);
			});
		});
	const refresh = () =>
		run(async (current) => {
			await user.reload();
			if (current()) sync();
		});
	const add = () =>
		run(async (current) => {
			const emailAddress = draft.trim();
			if (
				!emailAddress ||
				emailAddress.length > 254 ||
				!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)
			)
				throw new Error("Invalid email address");
			// Reconcile before an explicit retry of an ambiguous create response.
			await user.reload();
			if (!current()) return;
			sync();
			const existing = user.emailAddresses.find(
				(email) => email.emailAddress.toLowerCase() === emailAddress.toLowerCase(),
			);
			const added = existing ?? (await user.createEmailAddress({ email: emailAddress }));
			if (!current()) return;
			if (!added.id || added.emailAddress.toLowerCase() !== emailAddress.toLowerCase())
				throw new Error("Email addition not confirmed");
			setEmails((values) => [...values.filter((email) => email.id !== added.id), added]);
			setDraft("");
			setSaved(true);
		});
	const sendCode = (id: string) =>
		run(async (current) => {
			const email = emails.find((item) => item.id === id);
			if (!email || email.verification.status === "verified") return;
			await email.prepareVerification({ strategy: "email_code" });
			if (!current()) return;
			setVerifying(id);
			setCode("");
		});
	const verify = () =>
		run(async (current) => {
			const email = emails.find((item) => item.id === verifying);
			if (!email || !code.trim()) return;
			const verified = await email.attemptVerification({ code: code.trim() });
			if (!current()) return;
			if (verified.verification.status !== "verified") throw new Error("Email not verified");
			setEmails((values) => values.map((item) => (item.id === verified.id ? verified : item)));
			setVerifying(null);
			setCode("");
			setSaved(true);
		});
	const confirm = (id: string, remove: boolean) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		const label = t(remove ? "emails.remove" : "emails.makePrimary");
		Alert.alert(label, t(remove ? "emails.removeWarning" : "emails.primaryWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: label,
				style: remove ? "destructive" : "default",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					run(async (current) => {
						await user.reload();
						if (!current()) return;
						sync();
						const email = user.emailAddresses.find((item) => item.id === id);
						if (!email || id === user.primaryEmailAddressId) throw new Error("Email changed");
						if (remove) {
							await email.destroy();
							if (!current()) return;
							await user.reload();
							if (!current()) return;
							if (user.emailAddresses.some((item) => item.id === id))
								throw new Error("Email removal not confirmed");
						} else {
							if (email.verification.status !== "verified") throw new Error("Email not verified");
							const updated = await user.update({ primaryEmailAddressId: id });
							if (updated.id !== user.id || updated.primaryEmailAddressId !== id)
								throw new Error("Primary email change not confirmed");
						}
						if (!current()) return;
						if (remove) setEmails((values) => values.filter((item) => item.id !== id));
						else setPrimary(id);
						if (verifying === id) {
							setVerifying(null);
							setCode("");
						}
						setSaved(true);
					});
				},
			},
		]);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("emails.title")}
				</AppText>
				<AppText>{t("emails.description")}</AppText>
				{reverification.prompt}
				<NativeButton label={t("inventory.refresh")} disabled={action.busy} onPress={refresh} />
				{emails.map((email) => (
					<AppView key={email.id} className="gap-2 rounded-xl bg-surface p-4">
						<AppText selectable>{email.emailAddress}</AppText>
						<AppText>
							{t(
								email.id === primary
									? "emails.primary"
									: email.verification.status === "verified"
										? "emails.verified"
										: "emails.unverified",
							)}
						</AppText>
						{email.verification.status !== "verified" ? (
							<NativeButton
								label={t("emails.sendCode")}
								disabled={action.busy}
								onPress={() => sendCode(email.id)}
							/>
						) : null}
						{email.id !== primary ? (
							<>
								<NativeButton
									label={t("emails.makePrimary")}
									disabled={action.busy || email.verification.status !== "verified"}
									onPress={() => confirm(email.id, false)}
								/>
								<NativeButton
									label={t("emails.remove")}
									disabled={action.busy}
									onPress={() => confirm(email.id, true)}
								/>
							</>
						) : null}
						{verifying === email.id ? (
							<>
								<AppText>{t("emails.codeSent")}</AppText>
								<AppTextInput
									accessibilityLabel={t("emails.code")}
									value={code}
									onChangeText={setCode}
									editable={!action.busy}
									autoComplete="one-time-code"
									keyboardType="number-pad"
									maxLength={12}
									className="rounded-xl bg-background p-3 text-foreground"
								/>
								<NativeButton
									label={t("emails.verify")}
									disabled={action.busy || !code.trim()}
									onPress={verify}
								/>
							</>
						) : null}
					</AppView>
				))}
				<AppTextInput
					accessibilityLabel={t("emails.newEmail")}
					placeholder={t("emails.newEmail")}
					value={draft}
					onChangeText={setDraft}
					editable={!action.busy}
					autoComplete="email"
					keyboardType="email-address"
					autoCapitalize="none"
					autoCorrect={false}
					maxLength={254}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
				<NativeButton
					label={t("emails.add")}
					disabled={action.busy || !draft.trim()}
					onPress={add}
				/>
				{action.error ? <AppText accessibilityRole="alert">{t("emails.failed")}</AppText> : null}
				{saved ? <AppText accessibilityRole="alert">{t("emails.saved")}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
