import { ActivityIndicator } from "react-native";
import { useCSSVariable } from "uniwind";
import { useI18n } from "@/lib/i18n";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";

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

/** Compatibility adapter for existing feature screens. */
export function ErrorState({
	onRetry,
	title,
	error,
}: {
	onRetry?: () => void;
	title?: string;
	error?: unknown;
}) {
	return <ApiErrorPanel error={error} onRetry={onRetry} title={title} />;
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
