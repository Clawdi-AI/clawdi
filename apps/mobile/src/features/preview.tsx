import { Alert } from "react-native";
import { useI18n } from "../i18n";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppView } from "../ui/primitives";

const previewStats = [
	["Agents", "3"],
	["Sessions", "18"],
	["Projects", "4"],
	["Skills", "12"],
] as const;

export function PreviewHome() {
	const t = useI18n();
	const showPreviewNotice = () => Alert.alert(t("preview.badge"), t("preview.navigationNotice"));
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="gap-5 px-4 pb-10 pt-5">
				<AppText className="text-2xl font-semibold tracking-tight text-foreground">
					{t("preview.greeting")}
				</AppText>
				<PreviewSection title={t("preview.agents")} action={t("preview.viewAll")}>
					{["Hermes", "OpenClaw"].map((name, index) => (
						<AppView
							className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4"
							key={name}
						>
							<AppView className="h-3 w-3 rounded-full bg-success" />
							<AppView className="flex-1 gap-1">
								<AppText className="font-medium text-foreground">{name}</AppText>
								<AppText className="text-sm text-muted-foreground">
									{index ? t("preview.attention") : t("preview.connected")}
								</AppText>
							</AppView>
							<AppText className="text-sm text-muted-foreground">{t("preview.open")}</AppText>
						</AppView>
					))}
				</PreviewSection>
				<AppView className="gap-3 rounded-2xl border border-border bg-card p-4">
					<AppView className="flex-row items-center justify-between">
						<AppText className="text-base font-semibold text-foreground">
							{t("preview.activity")}
						</AppText>
						<AppText className="text-sm text-muted-foreground">{t("preview.last7Days")}</AppText>
					</AppView>
					<AppView className="flex-row gap-1">
						{Array.from({ length: 42 }, (_, index) => (
							<AppView
								className={`h-3 flex-1 rounded-sm ${index % 7 === 0 ? "bg-primary" : "bg-muted"}`}
								key={index}
							/>
						))}
					</AppView>
					<AppText className="text-sm text-muted-foreground">
						{t("preview.sessionsThisWeek")}
					</AppText>
				</AppView>
				<PreviewSection title={t("preview.library")}>
					{previewStats.slice(2).map(([label, value]) => (
						<AppView
							className="flex-row items-center justify-between border-b border-border py-2"
							key={label}
						>
							<AppText className="text-sm text-foreground">{label}</AppText>
							<AppText className="text-sm font-semibold text-foreground">{value}</AppText>
						</AppView>
					))}
				</PreviewSection>
				<PreviewSection title={t("preview.recentSessions")}>
					{[t("preview.activityRunning"), t("preview.activityAttention")].map((item) => (
						<AppText className="border-b border-border py-2 text-sm text-foreground" key={item}>
							{item}
						</AppText>
					))}
				</PreviewSection>
				<NativeButton label={t("navigation.createAgent")} onPress={showPreviewNotice} />
			</AppView>
		</AppScrollView>
	);
}

function PreviewSection({
	title,
	action,
	children,
}: {
	title: string;
	action?: string;
	children: React.ReactNode;
}) {
	return (
		<AppView className="gap-3 rounded-2xl border border-border bg-card p-4">
			<AppView className="flex-row items-center justify-between">
				<AppText className="text-base font-semibold text-foreground">{title}</AppText>
				{action ? <AppText className="text-sm text-muted-foreground">{action}</AppText> : null}
			</AppView>
			{children}
		</AppView>
	);
}

export function PreviewAccount() {
	const t = useI18n();
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="gap-5 px-6 pb-10 pt-8">
				<AppText className="text-3xl font-semibold text-foreground">Account</AppText>
				<AppView className="gap-2 rounded-3xl bg-card p-5">
					<AppText className="text-lg font-semibold text-foreground">
						{t("preview.accountName")}
					</AppText>
					<AppText className="text-base text-muted-foreground">{t("preview.accountEmail")}</AppText>
				</AppView>
				<AppText className="text-base leading-6 text-muted-foreground">
					{t("preview.bypassNotice")}
				</AppText>
			</AppView>
		</AppScrollView>
	);
}
