import { type Href, useRouter } from "expo-router";
import {
	Brain,
	BrainCircuit,
	ChevronRight,
	FolderKanban,
	Key,
	type LucideIcon,
	MessagesSquare,
	Plug,
	Sparkles,
} from "lucide-react-native";
import { useI18n } from "../../src/i18n";
import type { TranslationKey } from "../../src/i18n/en";
import { Card } from "../../src/ui/card";
import { Icon } from "../../src/ui/icon";
import { Separator } from "../../src/ui/separator";
import { Text } from "../../src/ui/text";
import { AppPressable, AppSafeAreaView, AppScrollView, AppView } from "../../src/ui/view";

type LibraryItem = {
	href: Href;
	icon: LucideIcon;
	/** Same identity tint as the Web sidebar chip (apps/web/src/lib/resource-identity.ts). */
	tint: string;
	label: TranslationKey;
	description: TranslationKey;
};

/** Web sidebar order: primary Memories, then the Library group. */
const LIBRARY_ITEMS: readonly LibraryItem[] = [
	{
		href: "/memories",
		icon: Brain,
		tint: "bg-identity-6-bg text-identity-6-fg",
		label: "navigation.memories",
		description: "navigation.memoriesDescription",
	},
	{
		href: "/projects",
		icon: FolderKanban,
		tint: "bg-identity-1-bg text-identity-1-fg",
		label: "navigation.projects",
		description: "navigation.projectsDescription",
	},
	{
		href: "/skills",
		icon: Sparkles,
		tint: "bg-identity-2-bg text-identity-2-fg",
		label: "navigation.skills",
		description: "navigation.skillsDescription",
	},
	{
		href: "/vault",
		icon: Key,
		tint: "bg-identity-4-bg text-identity-4-fg",
		label: "navigation.vaults",
		description: "navigation.vaultsDescription",
	},
	{
		href: "/connectors",
		icon: Plug,
		tint: "bg-identity-7-bg text-identity-7-fg",
		label: "navigation.connectors",
		description: "navigation.connectorsDescription",
	},
	{
		href: "/channels",
		icon: MessagesSquare,
		tint: "bg-identity-5-bg text-identity-5-fg",
		label: "navigation.channels",
		description: "navigation.channelsDescription",
	},
	{
		href: "/ai-providers",
		icon: BrainCircuit,
		tint: "bg-identity-2-bg text-identity-2-fg",
		label: "navigation.aiProviders",
		description: "navigation.aiProvidersDescription",
	},
];

export default function LibraryRoute() {
	const t = useI18n();
	const router = useRouter();
	return (
		<AppSafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-background">
			<AppScrollView contentContainerClassName="gap-5 px-4 pb-10 pt-4">
				<Text accessibilityRole="header" className="text-2xl font-semibold tracking-tight">
					{t("navigation.library")}
				</Text>
				<Card className="gap-0 py-0">
					{LIBRARY_ITEMS.map((item, index) => (
						<AppView key={item.label}>
							{index ? <Separator /> : null}
							<AppPressable
								accessibilityRole="link"
								onPress={() => router.push(item.href)}
								className="flex-row items-center gap-3 px-4 py-3 active:bg-muted/50"
							>
								<AppView className={`size-7 items-center justify-center rounded-lg ${item.tint}`}>
									<Icon as={item.icon} className={`size-3.5 ${item.tint}`} />
								</AppView>
								<AppView className="min-w-0 flex-1 gap-0.5">
									<Text className="text-sm font-medium">{t(item.label)}</Text>
									<Text numberOfLines={2} className="text-xs text-muted-foreground">
										{t(item.description)}
									</Text>
								</AppView>
								<Icon as={ChevronRight} className="size-4 text-muted-foreground" />
							</AppPressable>
						</AppView>
					))}
				</Card>
			</AppScrollView>
		</AppSafeAreaView>
	);
}
