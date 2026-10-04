import { useRouter } from "expo-router";
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
	const router = useRouter();
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="gap-6 px-6 pb-10 pt-8">
				<AppView className="gap-1">
					<AppText className="text-sm font-semibold uppercase tracking-widest text-primary">
						{t("preview.badge")}
					</AppText>
					<AppText className="text-base text-muted">{t("home.greeting")}</AppText>
					<AppText className="text-3xl font-semibold text-foreground">Alex</AppText>
				</AppView>
				<AppView className="gap-3 rounded-3xl bg-primary p-5">
					<AppText className="text-xl font-semibold text-white">{t("preview.heroTitle")}</AppText>
					<AppText className="text-base leading-6 text-white/80">
						{t("preview.heroDescription")}
					</AppText>
					<NativeButton
						label={t("navigation.createAgent")}
						onPress={() => router.push("/agents/new")}
					/>
				</AppView>
				<AppView className="flex-row flex-wrap gap-3 rounded-3xl bg-surface p-5">
					{previewStats.map(([label, value]) => (
						<AppView className="min-w-[40%] flex-1 gap-1" key={label}>
							<AppText className="text-2xl font-semibold text-foreground">{value}</AppText>
							<AppText className="text-sm text-muted">{label}</AppText>
						</AppView>
					))}
				</AppView>
				<AppView className="gap-3">
					<AppText className="text-xl font-semibold text-foreground">
						{t("preview.quickActions")}
					</AppText>
					<NativeButton
						label={t("navigation.createAgent")}
						onPress={() => router.push("/agents")}
					/>
					<NativeButton
						label={t("navigation.deployments")}
						onPress={() => router.push("/sessions")}
					/>
					<NativeButton label={t("navigation.billing")} onPress={() => router.push("/billing")} />
				</AppView>
				<AppView className="gap-3">
					<AppText className="text-xl font-semibold text-foreground">
						{t("preview.recentActivity")}
					</AppText>
					{[
						t("preview.activityRunning"),
						t("preview.activityAttention"),
						t("preview.activitySession"),
					].map((item) => (
						<AppView className="rounded-2xl bg-surface px-4 py-4" key={item}>
							<AppText className="text-base text-foreground">{item}</AppText>
						</AppView>
					))}
				</AppView>
			</AppView>
		</AppScrollView>
	);
}

export function PreviewAccount() {
	const t = useI18n();
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="gap-5 px-6 pb-10 pt-8">
				<AppText className="text-3xl font-semibold text-foreground">Account</AppText>
				<AppView className="gap-2 rounded-3xl bg-surface p-5">
					<AppText className="text-lg font-semibold text-foreground">
						{t("preview.accountName")}
					</AppText>
					<AppText className="text-base text-muted">{t("preview.accountEmail")}</AppText>
				</AppView>
				<AppText className="text-base leading-6 text-muted">{t("preview.bypassNotice")}</AppText>
			</AppView>
		</AppScrollView>
	);
}
