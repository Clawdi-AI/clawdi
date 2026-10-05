import { APPEARANCE_MODES, isAppearanceMode } from "@clawdi/shared/consts";
import { generalPanelClasses as styles } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { UserCog } from "lucide-react-native";
import { useCurrentUser } from "../../auth/auth-client";
import { useI18n } from "../../i18n";
import { useAppearance } from "../../providers/appearance-provider";
import { Avatar } from "../avatar";
import { Button } from "../button";
import { Icon } from "../icon";
import { Label } from "../input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";
import { Text } from "../text";
import { WebText, WebView, webView } from "../web-layout";
import { SettingsPanelHeader, SettingsSection } from "./section";

export function GeneralPanel() {
	const t = useI18n();
	const { user } = useCurrentUser();
	const appearance = useAppearance();
	const router = useRouter();
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";
	return (
		<WebView recipe={styles.panel}>
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
							<WebText recipe={styles.name}>{user?.fullName ?? "Anonymous"}</WebText>
							<WebText recipe={styles.email}>{user?.primaryEmailAddress?.emailAddress}</WebText>
						</WebView>
					</WebView>
					<Button variant="outline" size="sm" onPress={() => router.push("/account-settings")}>
						<Icon as={UserCog} />
						<Text>{t("settingsParity.manageAccount")}</Text>
					</Button>
				</WebView>
			</SettingsSection>
			<SettingsSection title={t("settingsParity.appearance")}>
				<WebView recipe={styles.appearanceRow}>
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
