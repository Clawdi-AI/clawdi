import { APPEARANCE_MODES, isAppearanceMode } from "@clawdi/shared/consts";
import { generalPanelClasses as styles } from "@clawdi/shared/ui";
import { settingsCopy } from "@clawdi/shared/view";
import { useRouter } from "expo-router";
import UserCog from "lucide-react-native/icons/user-cog";
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
import { isDevAuthBypass, useCurrentUser } from "@/platform/auth/auth-client";

/** Web's General settings: account identity, then app-wide preferences. */
export function GeneralPanel() {
	const t = useI18n();
	const router = useRouter();
	const appearance = useAppearance();
	const { user } = useCurrentUser();
	const email = user?.primaryEmailAddress?.emailAddress;
	return (
		<WebView testID="settings-general" recipe={styles.panel}>
			<SettingsPanelHeader
				title={settingsCopy.general}
				description={settingsCopy.generalDescription}
			/>
			<SettingsSection title={settingsCopy.account} description={settingsCopy.accountDescription}>
				<WebView testID="settings-account" recipe={styles.accountRow}>
					<WebView recipe={styles.identity} className="flex-row">
						<Avatar
							src={user?.imageUrl}
							fallback={user?.fullName?.[0] ?? email?.[0] ?? "U"}
							size="lg"
							className={webView(styles.avatar)}
						/>
						<WebView recipe={styles.identityText} className="flex-1">
							<WebText recipe={styles.name} numberOfLines={1}>
								{user?.fullName ?? settingsCopy.anonymous}
							</WebText>
							<WebText recipe={styles.email} numberOfLines={1}>
								{email}
							</WebText>
						</WebView>
					</WebView>
					{/* Clerk's native profile; the development identity has no Clerk session, as on Web. */}
					{isDevAuthBypass() ? null : (
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							onPress={() => router.push("/settings/account")}
						>
							<Icon as={UserCog} className={styles.manageIcon} />
							<Text>{settingsCopy.manageAccount}</Text>
						</Button>
					)}
				</WebView>
			</SettingsSection>
			<SettingsSection title={settingsCopy.appearance}>
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
