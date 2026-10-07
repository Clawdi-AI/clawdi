import { APPEARANCE_MODES, isAppearanceMode } from "@clawdi/shared/consts";
import { generalPanelClasses as styles } from "@clawdi/shared/ui";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { Button } from "@/components/ui/button";
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

export function GeneralPanel() {
	const t = useI18n();
	const appearance = useAppearance();
	return (
		<WebView testID="settings-general" recipe={styles.panel}>
			<SettingsPanelHeader
				title={t("settingsParity.general")}
				description={t("settingsMenu.generalDescription")}
			/>
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
