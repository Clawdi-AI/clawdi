import { useUser } from "@clerk/expo";
import { Card, Chip } from "heroui-native";
import { useI18n } from "../../src/i18n";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

export default function HomeRoute() {
	const t = useI18n();
	const { isLoaded, user } = useUser();
	const displayName = user?.firstName ?? user?.primaryEmailAddress?.emailAddress;
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-6 px-6 pb-10 pt-8">
				<AppView className="gap-1">
					<AppText className="text-base text-muted">{t("home.greeting")}</AppText>
					<AppText className="text-3xl font-semibold text-foreground">
						{isLoaded && displayName ? displayName : t("app.name")}
					</AppText>
				</AppView>
				<Card>
					<AppView className="gap-4 p-5">
						<AppView className="flex-row items-center justify-between gap-3">
							<AppText className="flex-1 text-xl font-semibold text-foreground">
								{t("home.workspaceTitle")}
							</AppText>
							<Chip>
								<Chip.Label>{t("home.emptyTitle")}</Chip.Label>
							</Chip>
						</AppView>
						<AppText className="text-base leading-6 text-muted">{t("home.workspaceMessage")}</AppText>
						<AppText className="text-base leading-6 text-muted">{t("home.emptyMessage")}</AppText>
					</AppView>
				</Card>
			</AppView>
		</AppScrollView>
	);
}
