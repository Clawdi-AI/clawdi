import type { pairingQr } from "@clawdi/shared/qr";
import { apiKeysPanelClasses, generalPanelClasses, settingsDialogClasses } from "@clawdi/shared/ui";
import type { OAuthProvider } from "@clerk/expo/types";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import {
	ClerkAction as FormAction,
	ClerkInput as FormInput,
	ClerkSwitch as FormSwitch,
	ClerkText as FormText,
} from "@/components/auth/clerk-form";
import { SettingsBackButton } from "@/components/settings/back-button";
import { Avatar } from "@/components/ui/avatar";
import { QrImage } from "@/components/ui/qr-image";
import { Separator } from "@/components/ui/separator";
import { AppScrollView, AppView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

type ContactItem = {
	id: string;
	emailAddress?: string;
	phoneNumber?: string;
	verification: { status: string | null };
};
const contactValue = (contact: ContactItem) => contact.emailAddress ?? contact.phoneNumber ?? "";
type MfaPhone = {
	id: string;
	phoneNumber: string;
	verification: { status: string | null };
	reservedForSecondFactor: boolean;
	defaultSecondFactor: boolean;
};
type PasskeyItem = { id: string; name: string | null; lastUsedAt: Date | null };
type DeviceSessionItem = {
	id: string;
	lastActiveAt: Date;
	latestActivity: {
		deviceType?: string | null;
		browserName?: string | null;
		browserVersion?: string | null;
		city?: string | null;
		country?: string | null;
		ipAddress?: string | null;
	};
};
type ConnectedAccountItem = {
	id: string;
	provider: string;
	verification?: { status: string | null } | null;
	providerTitle: () => string;
	accountIdentifier: () => string;
};

type ProfileFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	firstName: string;
	lastName: string;
	username: string;
	success: false | "name" | "avatar";
	avatar: { url: string; custom: boolean };
	email: string | undefined;
	setFirstName: (value: string) => void;
	setLastName: (value: string) => void;
	setUsername: (value: string) => void;
	setSuccess: (value: false | "name" | "avatar") => void;
	updateAvatar: (remove: boolean) => void;
	removeAvatar: () => void;
	dirty: boolean;
	save: () => void;
};
export function ProfileFormView({
	action,
	reverification,
	firstName,
	lastName,
	username,
	success,
	avatar,
	email,
	setFirstName,
	setLastName,
	setUsername,
	setSuccess,
	updateAvatar,
	removeAvatar,
	dirty,
	save,
}: ProfileFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("profile.title")}</FormText>
				<FormText>{t("profile.description")}</FormText>
				<Separator />
				{reverification.prompt}
				<FormText>{email ?? t("account.accountUnavailable")}</FormText>
				<Avatar
					src={avatar.url.startsWith("https://") ? avatar.url : undefined}
					fallback={firstName[0] ?? "U"}
					className={webView(generalPanelClasses.avatar)}
				/>
				<FormText>{t("profile.avatarHint")}</FormText>
				<FormAction
					label={t("profile.uploadAvatar")}
					disabled={action.busy}
					onPress={() => updateAvatar(false)}
				/>
				<FormAction
					label={t("profile.removeAvatar")}
					disabled={action.busy || !avatar.custom}
					onPress={removeAvatar}
				/>
				<AppView className="gap-2">
					<FormInput
						accessibilityLabel={t("profile.firstName")}
						autoComplete="given-name"
						value={firstName}
						editable={!action.busy}
						maxLength={256}
						onChangeText={(value) => {
							setFirstName(value);
							setSuccess(false);
						}}
					/>
				</AppView>
				<AppView className="gap-2">
					<FormInput
						accessibilityLabel={t("profile.lastName")}
						autoComplete="family-name"
						value={lastName}
						editable={!action.busy}
						maxLength={256}
						onChangeText={(value) => {
							setLastName(value);
							setSuccess(false);
						}}
					/>
				</AppView>
				<AppView className="gap-2">
					<FormInput
						accessibilityLabel={t("profile.username")}
						autoComplete="username"
						autoCapitalize="none"
						autoCorrect={false}
						value={username}
						editable={!action.busy}
						maxLength={256}
						onChangeText={(value) => {
							setUsername(value);
							setSuccess(false);
						}}
					/>
					<FormText className="text-muted-foreground">{t("profile.usernameHint")}</FormText>
				</AppView>
				{action.error ? <FormText accessibilityRole="alert">{t("profile.failed")}</FormText> : null}
				{success ? (
					<FormText accessibilityRole="alert">
						{t(success === "avatar" ? "profile.avatarSaved" : "profile.saved")}
					</FormText>
				) : null}
				<FormAction
					variant="default"
					label={t("profile.save")}
					disabled={!dirty || action.busy}
					onPress={save}
				/>
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type PasswordFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	enabled: boolean;
	oldPassword: string;
	newPassword: string;
	confirmationPassword: string;
	otherSessions: boolean;
	success: boolean;
	setOldPassword: (value: string) => void;
	setNewPassword: (value: string) => void;
	setConfirmationPassword: (value: string) => void;
	setOtherSessions: (value: boolean) => void;
	edit: (setter: (value: string) => void) => (value: string) => void;
	update: (remove: boolean) => void;
	confirmRemove: () => void;
};
export function PasswordFormView({
	action,
	reverification,
	enabled,
	oldPassword,
	newPassword,
	confirmationPassword,
	otherSessions,
	success,
	setOldPassword,
	setNewPassword,
	setConfirmationPassword,
	setOtherSessions,
	edit,
	update,
	confirmRemove,
}: PasswordFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("password.title")}</FormText>
				<FormText>{t("password.description")}</FormText>
				<FormText>{t(enabled ? "password.enabled" : "password.absent")}</FormText>
				<Separator />
				{reverification.prompt}
				{enabled ? (
					<FormInput
						accessibilityLabel={t("password.current")}
						placeholder={t("password.current")}
						value={oldPassword}
						onChangeText={edit(setOldPassword)}
						editable={!action.busy}
						secureTextEntry
						autoComplete="current-password"
						autoCapitalize="none"
						autoCorrect={false}
					/>
				) : null}
				<FormInput
					accessibilityLabel={t("password.new")}
					placeholder={t("password.new")}
					value={newPassword}
					onChangeText={edit(setNewPassword)}
					editable={!action.busy}
					secureTextEntry
					autoComplete="new-password"
					autoCapitalize="none"
					autoCorrect={false}
				/>
				<FormInput
					accessibilityLabel={t("password.confirm")}
					placeholder={t("password.confirm")}
					value={confirmationPassword}
					onChangeText={edit(setConfirmationPassword)}
					editable={!action.busy}
					secureTextEntry
					autoComplete="new-password"
					autoCapitalize="none"
					autoCorrect={false}
				/>
				<FormSwitch
					label={t("password.otherSessions")}
					value={otherSessions}
					onValueChange={setOtherSessions}
					disabled={action.busy}
				/>
				<FormAction
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
					<FormAction
						label={t("password.remove")}
						disabled={action.busy || !oldPassword}
						onPress={confirmRemove}
					/>
				) : null}
				{action.error ? (
					<FormText accessibilityRole="alert">{t("password.failed")}</FormText>
				) : null}
				{success ? <FormText accessibilityRole="alert">{t("password.saved")}</FormText> : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type MfaFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	enabled: boolean;
	mfaEnabled: boolean;
	setup: { secret?: string } | null;
	qr: ReturnType<typeof pairingQr> | null;
	code: string;
	codes: string[] | null;
	phones: MfaPhone[];
	success: boolean;
	setCode: (value: string) => void;
	clear: () => void;
	run: (operation: "refresh" | "create" | "verify") => void;
	confirm: (operation: "disable" | "backup") => void;
	confirmSms: (id: string, operation: "sms-disable" | "sms-enable" | "sms-default") => void;
};
export function MfaFormView({
	action,
	reverification,
	enabled,
	mfaEnabled,
	setup,
	qr,
	code,
	codes,
	phones,
	success,
	setCode,
	clear,
	run,
	confirm,
	confirmSms,
}: MfaFormViewProps) {
	const t = useI18n();
	const router = useRouter();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("mfa.title")}</FormText>
				<FormText>{t("mfa.description")}</FormText>
				<FormText>{t(enabled ? "mfa.enabled" : "mfa.disabled")}</FormText>
				<Separator />
				{reverification.prompt}
				<FormAction
					label={t("inventory.refresh")}
					disabled={action.busy}
					onPress={() => run("refresh")}
				/>
				{!enabled ? (
					<>
						<FormAction
							label={t("mfa.setup")}
							disabled={action.busy || Boolean(setup)}
							onPress={() => run("create")}
						/>
						{setup ? (
							<AppView className={webView(apiKeysPanelClasses.card)}>
								<FormText>{t("mfa.setupInstructions")}</FormText>
								{qr ? <QrImage matrix={qr} label={t("mfa.qr")} /> : null}
								<FormText selectable>{setup.secret}</FormText>
							</AppView>
						) : null}
						<FormText>{t("mfa.codeHint")}</FormText>
						<FormInput
							accessibilityLabel={t("mfa.code")}
							placeholder={t("mfa.code")}
							value={code}
							onChangeText={setCode}
							editable={!action.busy}
							secureTextEntry
							autoComplete="one-time-code"
							keyboardType="number-pad"
							autoCorrect={false}
						/>
						<FormAction
							variant="default"
							label={t("mfa.verify")}
							disabled={action.busy || !code.trim()}
							onPress={() => run("verify")}
						/>
					</>
				) : null}
				<FormAction
					label={t(enabled ? "mfa.disable" : "mfa.discard")}
					disabled={action.busy}
					onPress={() => confirm("disable")}
				/>
				<FormAction
					label={t("mfa.backup")}
					disabled={action.busy || !mfaEnabled}
					onPress={() => confirm("backup")}
				/>
				{codes ? (
					<AppView className={webView(apiKeysPanelClasses.card)}>
						<FormText>{t("mfa.saveCodes")}</FormText>
						<FormText selectable>{codes.join("\n")}</FormText>
						<FormAction label={t("mfa.hide")} onPress={clear} />
					</AppView>
				) : null}
				<FormText accessibilityRole="header">{t("mfa.smsTitle")}</FormText>
				<FormText>{t("mfa.smsDescription")}</FormText>
				<FormAction
					label={t("phones.title")}
					disabled={action.busy}
					onPress={() => router.push("/settings/account/phone-numbers")}
				/>
				{phones
					.filter((phone) => phone.verification.status === "verified")
					.map((phone) => (
						<AppView key={phone.id} className={webView(apiKeysPanelClasses.card)}>
							<FormText selectable>{phone.phoneNumber}</FormText>
							<FormText>
								{t(phone.reservedForSecondFactor ? "mfa.smsEnabled" : "mfa.smsDisabled")}
							</FormText>
							{phone.reservedForSecondFactor && phone.defaultSecondFactor ? (
								<FormText>{t("mfa.smsPreferred")}</FormText>
							) : null}
							<FormAction
								label={t(phone.reservedForSecondFactor ? "mfa.smsDisable" : "mfa.smsEnable")}
								disabled={action.busy}
								onPress={() =>
									confirmSms(phone.id, phone.reservedForSecondFactor ? "sms-disable" : "sms-enable")
								}
							/>
							{phone.reservedForSecondFactor && !phone.defaultSecondFactor ? (
								<FormAction
									label={t("mfa.smsDefault")}
									disabled={action.busy}
									onPress={() => confirmSms(phone.id, "sms-default")}
								/>
							) : null}
						</AppView>
					))}
				{action.error ? <FormText accessibilityRole="alert">{t("mfa.failed")}</FormText> : null}
				{success ? <FormText accessibilityRole="alert">{t("mfa.saved")}</FormText> : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type PasskeysFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	passkeys: PasskeyItem[];
	edit: { id: string; name: string } | null;
	saved: boolean;
	setEdit: (value: { id: string; name: string } | null) => void;
	setSaved: (value: boolean) => void;
	run: (
		change?: { kind: "rename"; id: string; name: string } | { kind: "remove"; id: string },
	) => void;
	confirmRemove: (id: string) => void;
};
export function PasskeysFormView({
	action,
	reverification,
	passkeys,
	edit,
	saved,
	setEdit,
	setSaved,
	run,
	confirmRemove,
}: PasskeysFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("passkeys.title")}</FormText>
				<FormText>{t("passkeys.description")}</FormText>
				<Separator />
				{reverification.prompt}
				<FormAction label={t("inventory.refresh")} disabled={action.busy} onPress={() => run()} />
				{passkeys.length === 0 ? <FormText>{t("passkeys.empty")}</FormText> : null}
				{passkeys.map((passkey) => (
					<AppView key={passkey.id} className={webView(apiKeysPanelClasses.card)}>
						<FormText className="text-lg font-semibold text-foreground">
							{passkey.name || t("passkeys.unnamed")}
						</FormText>
						<FormText>
							{t("passkeys.lastUsed")}{" "}
							{passkey.lastUsedAt && Number.isFinite(passkey.lastUsedAt.getTime())
								? passkey.lastUsedAt.toLocaleString()
								: t("passkeys.neverUsed")}
						</FormText>
						{edit?.id === passkey.id ? (
							<>
								<FormInput
									accessibilityLabel={t("passkeys.name")}
									value={edit.name}
									onChangeText={(name) => setEdit({ id: passkey.id, name })}
									editable={!action.busy}
									autoCorrect={false}
								/>
								<FormAction
									label={t("passkeys.save")}
									disabled={action.busy || !edit.name.trim()}
									onPress={() => run({ kind: "rename", ...edit })}
								/>
								<FormAction
									label={t("account.cancel")}
									disabled={action.busy}
									onPress={() => setEdit(null)}
								/>
							</>
						) : (
							<FormAction
								label={t("passkeys.rename")}
								disabled={action.busy}
								onPress={() => {
									setSaved(false);

									setEdit({ id: passkey.id, name: passkey.name ?? "" });
								}}
							/>
						)}
						<FormAction
							label={t("passkeys.remove")}
							disabled={action.busy}
							onPress={() => confirmRemove(passkey.id)}
						/>
					</AppView>
				))}
				<FormText>{t("passkeys.nativeUnavailable")}</FormText>
				{action.error ? (
					<FormText accessibilityRole="alert">{t("passkeys.failed")}</FormText>
				) : null}
				{saved ? <FormText accessibilityRole="alert">{t("passkeys.saved")}</FormText> : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type AccountContactsFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	kind: "emails" | "phones";
	contacts: ContactItem[];
	primary: string | null;
	draft: string;
	verifying: string | null;
	code: string;
	saved: boolean;
	refresh: () => void;
	sendCode: (id: string) => void;
	confirm: (id: string, remove: boolean) => void;
	verify: () => void;
	setCode: (value: string) => void;
	setDraft: (value: string) => void;
	add: () => void;
};
export function AccountContactsFormView({
	action,
	reverification,
	kind,
	contacts,
	primary,
	draft,
	verifying,
	code,
	saved,
	refresh,
	sendCode,
	confirm,
	verify,
	setCode,
	setDraft,
	add,
}: AccountContactsFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t(`${kind}.title`)}</FormText>
				<FormText>{t(`${kind}.description`)}</FormText>
				<Separator />
				{reverification.prompt}
				<FormAction label={t("inventory.refresh")} disabled={action.busy} onPress={refresh} />
				{contacts.map((contact) => (
					<AppView key={contact.id} className={webView(apiKeysPanelClasses.card)}>
						<FormText selectable>{contactValue(contact)}</FormText>
						<FormText>
							{t(
								contact.id === primary
									? `${kind}.primary`
									: contact.verification.status === "verified"
										? `${kind}.verified`
										: `${kind}.unverified`,
							)}
						</FormText>
						{contact.verification.status !== "verified" ? (
							<FormAction
								label={t(`${kind}.sendCode`)}
								disabled={action.busy}
								onPress={() => sendCode(contact.id)}
							/>
						) : null}
						{contact.id !== primary ? (
							<>
								<FormAction
									label={t(`${kind}.makePrimary`)}
									disabled={action.busy || contact.verification.status !== "verified"}
									onPress={() => confirm(contact.id, false)}
								/>
								<FormAction
									label={t(`${kind}.remove`)}
									disabled={action.busy}
									onPress={() => confirm(contact.id, true)}
								/>
							</>
						) : null}
						{verifying === contact.id ? (
							<>
								<FormText>{t(`${kind}.codeSent`)}</FormText>
								<FormInput
									accessibilityLabel={t(`${kind}.code`)}
									value={code}
									onChangeText={setCode}
									editable={!action.busy}
									autoComplete="one-time-code"
									keyboardType="number-pad"
								/>
								<FormAction
									label={t(`${kind}.verify`)}
									disabled={action.busy || !code.trim()}
									onPress={verify}
								/>
							</>
						) : null}
					</AppView>
				))}
				<FormInput
					accessibilityLabel={t(`${kind}.input`)}
					placeholder={t(`${kind}.input`)}
					value={draft}
					onChangeText={setDraft}
					editable={!action.busy}
					autoComplete={kind === "emails" ? "email" : "tel"}
					keyboardType={kind === "emails" ? "email-address" : "phone-pad"}
					autoCapitalize="none"
					autoCorrect={false}
				/>
				<FormAction
					label={t(`${kind}.add`)}
					disabled={action.busy || !draft.trim()}
					onPress={add}
				/>
				{action.error ? <FormText accessibilityRole="alert">{t(`${kind}.failed`)}</FormText> : null}
				{saved ? <FormText accessibilityRole="alert">{t(`${kind}.saved`)}</FormText> : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type DeviceSessionsFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	sessions: DeviceSessionItem[] | null;
	scope: { sessionId: string | null };
	revoked: boolean;
	refresh: () => void;
	revoke: (id: string) => void;
};
export function DeviceSessionsFormView({
	action,
	reverification,
	sessions,
	scope,
	revoked,
	refresh,
	revoke,
}: DeviceSessionsFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("devices.title")}</FormText>
				<FormText>{t("devices.description")}</FormText>
				<Separator />
				{reverification.prompt}
				<FormAction label={t("devices.refresh")} disabled={action.busy} onPress={refresh} />
				{sessions === null ? <FormText>{t("devices.loadHint")}</FormText> : null}
				{sessions?.map((session) => (
					<AppView key={session.id} className={webView(apiKeysPanelClasses.card)}>
						<FormText>
							{[
								session.latestActivity.deviceType,
								session.latestActivity.browserName,
								session.latestActivity.browserVersion,
							]
								.filter(Boolean)
								.join(" · ") || t("devices.unknown")}
						</FormText>
						<FormText selectable>
							{[
								session.latestActivity.city,
								session.latestActivity.country,
								session.latestActivity.ipAddress,
							]
								.filter(Boolean)
								.join(" · ")}
						</FormText>
						<FormText>
							{t("devices.lastActive")}{" "}
							{Number.isFinite(session.lastActiveAt.getTime())
								? session.lastActiveAt.toLocaleString()
								: t("devices.unknown")}
						</FormText>
						{session.id === scope.sessionId ? (
							<FormText>{t("devices.current")}</FormText>
						) : (
							<FormAction
								label={t("devices.revoke")}
								disabled={action.busy}
								onPress={() => revoke(session.id)}
							/>
						)}
					</AppView>
				))}
				{action.error ? <FormText accessibilityRole="alert">{t("devices.failed")}</FormText> : null}
				{revoked ? <FormText accessibilityRole="alert">{t("devices.revoked")}</FormText> : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type ConnectedAccountsFormViewProps = {
	action: { busy: boolean; error: unknown };
	reverification: { prompt?: ReactNode };
	accounts: ConnectedAccountItem[];
	providers: readonly OAuthProvider[];
	saved: boolean;
	reauthorized: boolean;
	run: () => void;
	authorize: (target: { id: string } | { provider: OAuthProvider }) => void;
	confirmRemove: (id: string) => void;
};
export function ConnectedAccountsFormView({
	action,
	reverification,
	accounts,
	providers,
	saved,
	reauthorized,
	run,
	authorize,
	confirmRemove,
}: ConnectedAccountsFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("connections.title")}</FormText>
				<FormText>{t("connections.description")}</FormText>
				<Separator />
				{reverification.prompt}
				<FormAction label={t("inventory.refresh")} disabled={action.busy} onPress={() => run()} />
				{accounts.length === 0 ? <FormText>{t("connections.empty")}</FormText> : null}
				{accounts.map((account) => (
					<AppView key={account.id} className={webView(apiKeysPanelClasses.card)}>
						<FormText>{account.providerTitle()}</FormText>
						<FormText selectable>{account.accountIdentifier()}</FormText>
						<FormText>
							{t(
								account.verification?.status === "verified"
									? "connections.verified"
									: "connections.unverified",
							)}
						</FormText>
						<FormAction
							label={t("connections.reauthorize")}
							disabled={action.busy}
							onPress={() => void authorize({ id: account.id })}
						/>
						<FormAction
							label={t("connections.remove")}
							disabled={action.busy}
							onPress={() => confirmRemove(account.id)}
						/>
					</AppView>
				))}
				<FormText>{t("connections.browserHint")}</FormText>
				{providers.length === 0 ? <FormText>{t("connections.notConfigured")}</FormText> : null}
				{providers
					.filter(
						(provider) =>
							!accounts.some(
								(account) =>
									account.provider === provider && account.verification?.status === "verified",
							),
					)
					.map((provider) => (
						<FormAction
							key={provider}
							label={`${t("connections.connect")} · ${provider}`}
							disabled={action.busy}
							onPress={() => void authorize({ provider })}
						/>
					))}
				{action.error ? (
					<FormText accessibilityRole="alert">{t("connections.failed")}</FormText>
				) : null}
				{saved ? <FormText accessibilityRole="alert">{t("connections.saved")}</FormText> : null}
				{reauthorized ? (
					<FormText accessibilityRole="alert">{t("connections.reauthorized")}</FormText>
				) : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type DeleteAccountFormViewProps = {
	action: { busy: boolean; error: unknown };
	email: string;
	compute: unknown;
	phrase: string;
	outcome: "idle" | "uncertain" | "accepted";
	setPhrase: (value: string) => void;
	confirm: () => void;
	leave: () => void;
};
export function DeleteAccountFormView({
	action,
	email,
	compute,
	phrase,
	outcome,
	setPhrase,
	confirm,
	leave,
}: DeleteAccountFormViewProps) {
	const t = useI18n();

	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(
					`${generalPanelClasses.panel.replace("gap-8", "")} ${apiKeysPanelClasses.form} ${settingsDialogClasses.panel}`,
				)}
			>
				<SettingsBackButton />
				<FormText accessibilityRole="header">{t("deletion.title")}</FormText>
				<FormText>{email}</FormText>
				<FormText>{t("deletion.warning")}</FormText>
				{outcome === "idle" ? (
					!compute ? (
						<FormText accessibilityRole="alert">{t("deletion.unavailable")}</FormText>
					) : (
						<>
							<FormText>{t("deletion.typePhrase")}</FormText>
							<FormInput
								accessibilityLabel={t("deletion.typePhrase")}
								value={phrase}
								onChangeText={setPhrase}
								autoCapitalize="characters"
								autoCorrect={false}
								editable={!action.busy}
							/>
							<FormAction
								variant="destructive"
								label={t("deletion.confirm")}
								disabled={action.busy || phrase !== t("deletion.phrase")}
								onPress={confirm}
							/>
						</>
					)
				) : (
					<FormText accessibilityRole="alert">
						{t(outcome === "accepted" ? "deletion.accepted" : "deletion.uncertain")}
					</FormText>
				)}
				{outcome !== "idle" ? (
					<FormAction label={t("account.signOut")} disabled={action.busy} onPress={leave} />
				) : null}
				{action.error ? (
					<FormText accessibilityRole="alert">{t("account.signOutFailed")}</FormText>
				) : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
