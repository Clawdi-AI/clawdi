import { useUser } from "@clerk/expo";
import type { EmailAddressResource, PhoneNumberResource, UserResource } from "@clerk/expo/types";
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

type Contact = EmailAddressResource | PhoneNumberResource;
type Kind = "emails" | "phones";
const contactValue = (contact: Contact) =>
	"emailAddress" in contact ? contact.emailAddress : contact.phoneNumber;

export function EmailAddressesScreen() {
	return <ContactAddressesScreen kind="emails" />;
}
export function PhoneNumbersScreen() {
	return <ContactAddressesScreen kind="phones" />;
}

function ContactAddressesScreen({ kind }: { kind: Kind }) {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return (
		<ContactAddresses
			key={`${scope.identity}:${scope.generation}:${kind}`}
			user={user}
			kind={kind}
		/>
	);
}

function ContactAddresses({ user, kind }: { user: UserResource; kind: Kind }) {
	const getContacts = (): Contact[] =>
		kind === "emails" ? user.emailAddresses : user.phoneNumbers;
	const getPrimary = (value: UserResource = user) =>
		kind === "emails" ? value.primaryEmailAddressId : value.primaryPhoneNumberId;
	const normalize = (value: string) => (kind === "emails" ? value.toLowerCase() : value);
	const create = (value: string) =>
		kind === "emails"
			? user.createEmailAddress({ email: value })
			: user.createPhoneNumber({ phoneNumber: value });
	const updatePrimary = (id: string) =>
		user.update(kind === "emails" ? { primaryEmailAddressId: id } : { primaryPhoneNumberId: id });
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const capture = useForegroundLease();
	const confirmation = useRef(0);
	const [contacts, setContacts] = useState<Contact[]>([...getContacts()]);
	const [primary, setPrimary] = useState(getPrimary());
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
		setContacts([...getContacts()]);
		setPrimary(getPrimary());
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
			const address = draft.trim();
			const valid =
				kind === "emails"
					? address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
					: /^\+[1-9]\d{1,14}$/.test(address);
			if (!valid) throw new Error("Invalid contact address");
			// Reconcile before an explicit retry of an ambiguous create response.
			await user.reload();
			if (!current()) return;
			sync();
			const existing = getContacts().find(
				(contact) => normalize(contactValue(contact)) === normalize(address),
			);
			const added = existing ?? (await create(address));
			if (!current()) return;
			if (!added.id || normalize(contactValue(added)) !== normalize(address))
				throw new Error("Email addition not confirmed");
			setContacts((values) => [...values.filter((contact) => contact.id !== added.id), added]);
			setDraft("");
			setSaved(true);
		});
	const sendCode = (id: string) =>
		run(async (current) => {
			const contact = contacts.find((item) => item.id === id);
			if (!contact || contact.verification.status === "verified") return;
			if ("emailAddress" in contact) await contact.prepareVerification({ strategy: "email_code" });
			else await contact.prepareVerification();
			if (!current()) return;
			setVerifying(id);
			setCode("");
		});
	const verify = () =>
		run(async (current) => {
			const contact = contacts.find((item) => item.id === verifying);
			if (!contact || !code.trim()) return;
			const verified = await contact.attemptVerification({ code: code.trim() });
			if (!current()) return;
			if (verified.verification.status !== "verified") throw new Error("Email not verified");
			setContacts((values) => values.map((item) => (item.id === verified.id ? verified : item)));
			setVerifying(null);
			setCode("");
			setSaved(true);
		});
	const confirm = (id: string, remove: boolean) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		const label = t(remove ? `${kind}.remove` : `${kind}.makePrimary`);
		Alert.alert(label, t(remove ? `${kind}.removeWarning` : `${kind}.primaryWarning`), [
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
						const contact = getContacts().find((item) => item.id === id);
						if (!contact || id === getPrimary()) throw new Error("Email changed");
						if (remove) {
							await contact.destroy();
							if (!current()) return;
							await user.reload();
							if (!current()) return;
							if (getContacts().some((item) => item.id === id))
								throw new Error("Email removal not confirmed");
						} else {
							if (contact.verification.status !== "verified") throw new Error("Email not verified");
							const updated = await updatePrimary(id);
							if (updated.id !== user.id || getPrimary(updated) !== id)
								throw new Error("Primary contact change not confirmed");
						}
						if (!current()) return;
						if (remove) setContacts((values) => values.filter((item) => item.id !== id));
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
					{t(`${kind}.title`)}
				</AppText>
				<AppText>{t(`${kind}.description`)}</AppText>
				{reverification.prompt}
				<NativeButton label={t("inventory.refresh")} disabled={action.busy} onPress={refresh} />
				{contacts.map((contact) => (
					<AppView key={contact.id} className="gap-2 rounded-xl bg-surface p-4">
						<AppText selectable>{contactValue(contact)}</AppText>
						<AppText>
							{t(
								contact.id === primary
									? `${kind}.primary`
									: contact.verification.status === "verified"
										? `${kind}.verified`
										: `${kind}.unverified`,
							)}
						</AppText>
						{contact.verification.status !== "verified" ? (
							<NativeButton
								label={t(`${kind}.sendCode`)}
								disabled={action.busy}
								onPress={() => sendCode(contact.id)}
							/>
						) : null}
						{contact.id !== primary ? (
							<>
								<NativeButton
									label={t(`${kind}.makePrimary`)}
									disabled={action.busy || contact.verification.status !== "verified"}
									onPress={() => confirm(contact.id, false)}
								/>
								<NativeButton
									label={t(`${kind}.remove`)}
									disabled={action.busy}
									onPress={() => confirm(contact.id, true)}
								/>
							</>
						) : null}
						{verifying === contact.id ? (
							<>
								<AppText>{t(`${kind}.codeSent`)}</AppText>
								<AppTextInput
									accessibilityLabel={t(`${kind}.code`)}
									value={code}
									onChangeText={setCode}
									editable={!action.busy}
									autoComplete="one-time-code"
									keyboardType="number-pad"
									className="rounded-xl bg-background p-3 text-foreground"
								/>
								<NativeButton
									label={t(`${kind}.verify`)}
									disabled={action.busy || !code.trim()}
									onPress={verify}
								/>
							</>
						) : null}
					</AppView>
				))}
				<AppTextInput
					accessibilityLabel={t(`${kind}.input`)}
					placeholder={t(`${kind}.input`)}
					value={draft}
					onChangeText={setDraft}
					editable={!action.busy}
					autoComplete={kind === "emails" ? "email" : "tel"}
					keyboardType={kind === "emails" ? "email-address" : "phone-pad"}
					autoCapitalize="none"
					autoCorrect={false}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
				<NativeButton
					label={t(`${kind}.add`)}
					disabled={action.busy || !draft.trim()}
					onPress={add}
				/>
				{action.error ? <AppText accessibilityRole="alert">{t(`${kind}.failed`)}</AppText> : null}
				{saved ? <AppText accessibilityRole="alert">{t(`${kind}.saved`)}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
