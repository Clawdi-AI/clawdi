import { generalPanelClasses } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { useI18n } from "../src/i18n";
import { Button } from "../src/ui/button";
import { ReadScreen } from "../src/ui/read-screen";
import { SettingsBackButton } from "../src/ui/settings/back-button";
import { SettingsPanelHeader, SettingsSection } from "../src/ui/settings/section";
import { Text } from "../src/ui/text";
import { AppScrollView } from "../src/ui/view";
import { webView } from "../src/ui/web-layout";
export default function AccountSettingsRoute() {
	const t = useI18n();
	const router = useRouter();
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(generalPanelClasses.panel)}>
				<SettingsBackButton />
				<SettingsPanelHeader
					title={t("settingsParity.account")}
					description={t("settingsParity.accountDescription")}
				/>
				<SettingsSection title={t("account.profile")}>
					{(
						[
							["profile.title", "/profile"],
							["emails.title", "/email-addresses"],
							["phones.title", "/phone-numbers"],
							["connections.title", "/connected-accounts"],
						] as const
					).map(([label, href]) => (
						<Button key={href} variant="ghost" onPress={() => router.push(href)}>
							<Text>{t(label)}</Text>
						</Button>
					))}
				</SettingsSection>
				<SettingsSection title={t("account.security")}>
					{(
						[
							["password.title", "/password"],
							["mfa.title", "/mfa"],
							["passkeys.title", "/passkeys"],
							["devices.title", "/device-sessions"],
						] as const
					).map(([label, href]) => (
						<Button key={href} variant="ghost" onPress={() => router.push(href)}>
							<Text>{t(label)}</Text>
						</Button>
					))}
				</SettingsSection>
				<SettingsSection destructive title={t("deletion.title")}>
					<Button variant="destructive" onPress={() => router.push("/delete-account")}>
						<Text>{t("deletion.title")}</Text>
					</Button>
				</SettingsSection>
			</AppScrollView>
		</ReadScreen>
	);
}
