import { AlertCircle, RefreshCw } from "lucide-react-native";
import { ActivityIndicator } from "react-native";
import { useCSSVariable } from "uniwind";
import { useI18n } from "../i18n";
import { Alert } from "./alert";
import { Button } from "./button";
import { Icon } from "./icon";
import { Text } from "./text";
import { AppView } from "./view";

export function Spinner({ label }: { label?: string }) {
	const color = useCSSVariable("--color-muted-foreground");
	return (
		<ActivityIndicator
			accessibilityLabel={label}
			accessibilityRole="progressbar"
			color={typeof color === "string" ? color : undefined}
		/>
	);
}

export function LoadingScreen({ label }: { label?: string }) {
	const t = useI18n();
	return (
		<AppView className="flex-1 items-center justify-center gap-3 bg-background px-6">
			<Spinner label={label ?? t("loading.app")} />
			<Text className="text-center text-sm text-muted-foreground">{label ?? t("loading.app")}</Text>
		</AppView>
	);
}

/** Mirrors apps/web/src/components/api-error-panel.tsx. */
export function ErrorState({ onRetry, title }: { onRetry?: () => void; title?: string }) {
	const t = useI18n();
	return (
		<Alert variant="destructive" icon={AlertCircle} title={title ?? t("error.genericTitle")}>
			<AppView className="items-start gap-3">
				<Text>{t("error.genericMessage")}</Text>
				{onRetry ? (
					<Button size="sm" variant="outline" onPress={onRetry}>
						<Icon as={RefreshCw} />
						<Text>{t("error.tryAgain")}</Text>
					</Button>
				) : null}
			</AppView>
		</Alert>
	);
}

export function ConfigurationErrorScreen({ reason }: { reason: "missing" | "invalid" }) {
	const t = useI18n();
	return (
		<AppView className="flex-1 justify-center gap-4 bg-background px-6">
			<Text accessibilityRole="header" className="text-2xl font-semibold tracking-tight">
				{t("configuration.title")}
			</Text>
			<Text className="text-sm text-muted-foreground">{t("configuration.message")}</Text>
			<Text className="text-sm text-destructive">
				{reason === "missing" ? t("configuration.missing") : t("configuration.invalid")}
			</Text>
		</AppView>
	);
}
