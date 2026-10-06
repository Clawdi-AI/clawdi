import { generalPanelClasses } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { SettingsBackButton } from "@/components/settings/back-button";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { ReadScreen } from "@/platform/safe-area-screen";
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
