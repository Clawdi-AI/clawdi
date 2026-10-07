import { APPEARANCE_MODES, isAppearanceMode } from "@clawdi/shared/consts";
import { generalPanelClasses as styles } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { UserCog } from "lucide-react-native";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAppearance } from "@/platform/appearance-provider";
import { useCurrentUser } from "@/platform/auth/auth-client";

export function GeneralPanel() {
	const t = useI18n();
	const { user } = useCurrentUser();
	const appearance = useAppearance();
	const router = useRouter();
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";
	return (
		<WebView testID="settings-general" recipe={styles.panel}>
			<SettingsPanelHeader
				title={t("settingsParity.general")}
				description={t("settingsParity.generalDescription")}
			/>
			<SettingsSection
				title={t("settingsParity.account")}
				description={t("settingsParity.accountDescription")}
			>
				<WebView recipe={styles.accountRow}>
					<WebView recipe={styles.identity} className="flex-row">
						<Avatar src={user?.imageUrl} fallback={initial} className={webView(styles.avatar)} />
						<WebView recipe={styles.identityText}>
							<WebText testID="settings-user-name" recipe={styles.name}>
								{user?.fullName ?? "Anonymous"}
							</WebText>
							<WebText testID="settings-user-email" recipe={styles.email}>
								{user?.primaryEmailAddress?.emailAddress}
							</WebText>
						</WebView>
					</WebView>
					<Button variant="outline" size="sm" onPress={() => router.push("/settings/account")}>
						<Icon as={UserCog} />
						<Text>{t("settingsParity.manageAccount")}</Text>
					</Button>
				</WebView>
			</SettingsSection>
			<SettingsSection title={t("settingsParity.appearance")}>
				<WebView testID="settings-appearance" recipe={styles.appearanceRow}>
					<WebView recipe={styles.appearanceLabel}>
						<Label>{t("settingsParity.theme")}</Label>
						<WebText recipe={styles.description}>{t("settingsParity.themeDescription")}</WebText>
					</WebView>
					<Select
						value={appearance.mode}
						disabled={!appearance.ready || appearance.busy}
						onValueChange={(value) => {
							if (isAppearanceMode(value)) void appearance.select(value);
						}}
					>
						<SelectTrigger className={webView(styles.themeTrigger)}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{APPEARANCE_MODES.map((value) => (
								<SelectItem key={value} value={value} label={t(`settingsParity.${value}`)} />
							))}
						</SelectContent>
					</Select>
					{appearance.error ? (
						<WebText accessibilityRole="alert" recipe={styles.description}>
							{t("appearance.failed")}
						</WebText>
					) : null}
					{!appearance.ready && appearance.error ? (
						<Button variant="outline" onPress={appearance.reload}>
							<Text>{t("appearance.retry")}</Text>
						</Button>
					) : null}
				</WebView>
			</SettingsSection>
		</WebView>
	);
}
