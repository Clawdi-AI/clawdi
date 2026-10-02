import { ActivityIndicator } from "react-native";
import { useI18n } from "../i18n";
import { AppText, AppView } from "./primitives";

export function LoadingScreen({ label }: { label?: string }) {
	const t = useI18n();
	return (
		<AppView className="flex-1 items-center justify-center gap-4 bg-background px-6">
			<ActivityIndicator accessibilityLabel={label ?? t("loading.app")} color="#2454d9" size="large" />
			<AppText className="text-center text-base text-muted">{label ?? t("loading.app")}</AppText>
		</AppView>
	);
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
	const t = useI18n();
	return (
		<AppView className="items-center gap-3 rounded-3xl bg-surface p-6">
			<AppText className="text-center text-xl font-semibold text-foreground">{t("error.genericTitle")}</AppText>
			<AppText className="text-center text-base text-muted">{t("error.genericMessage")}</AppText>
			{onRetry ? (
				<AppText accessibilityRole="button" onPress={onRetry} className="text-base font-semibold text-primary">
					{t("error.tryAgain")}
				</AppText>
			) : null}
		</AppView>
	);
}

export function ConfigurationErrorScreen({ reason }: { reason: "missing" | "invalid" }) {
	const t = useI18n();
	return (
		<AppView className="flex-1 justify-center gap-4 bg-background px-6">
			<AppText className="text-3xl font-semibold text-foreground">{t("configuration.title")}</AppText>
			<AppText className="text-base leading-6 text-muted">{t("configuration.message")}</AppText>
			<AppText className="text-sm text-danger">
				{reason === "missing" ? t("configuration.missing") : t("configuration.invalid")}
			</AppText>
		</AppView>
	);
}
