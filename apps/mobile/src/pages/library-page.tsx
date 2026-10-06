import { libraryNavigationClasses } from "@clawdi/shared/ui";
import {
	CONSOLE_NAVIGATION_ITEMS,
	type ConsoleNavigationItemId,
	consoleNavigationGroups,
} from "@clawdi/shared/view";
import type { Href } from "expo-router";
import { router } from "expo-router";
import {
	Brain,
	BrainCircuit,
	FolderKanban,
	Key,
	MessagesSquare,
	Plug,
	Sparkles,
} from "lucide-react-native";
import { IconChip } from "@/components/icon-chip";
import { SectionLabel } from "@/components/section-label";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

const routes = {
	memories: "/memories",
	projects: "/projects",
	skills: "/skills",
	vaults: "/vault",
	connectors: "/connectors",
	channels: "/channels",
	"ai-providers": "/ai-providers",
} satisfies Partial<Record<ConsoleNavigationItemId, Href>>;
const icons = {
	memories: Brain,
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	connectors: Plug,
	channels: MessagesSquare,
	"ai-providers": BrainCircuit,
};
export default function LibraryRoute() {
	const t = useI18n();
	const library = consoleNavigationGroups(true).find((g) => g.id === "library");
	const items = [CONSOLE_NAVIGATION_ITEMS.memories, ...(library?.items ?? [])];
	return (
		<SafeAreaScreen>
			<NativeHeader title={t("navigation.library")} />
			<NativeList
				data={items}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) => {
					if (!(item.id in routes)) return null;
					const id = item.id as keyof typeof routes;
					return (
						<WebView key={id} recipe="">
							{id === "projects" ? <SectionLabel>{library?.label}</SectionLabel> : null}
							<AppPressable
								accessibilityRole="link"
								onPress={() => router.push(routes[id])}
								className={webView(
									`${libraryNavigationClasses.item} ${libraryNavigationClasses.row}`,
								)}
							>
								<IconChip size="xs" tint={item.tint}>
									<Icon as={icons[id]} />
								</IconChip>
								<WebView recipe={libraryNavigationClasses.body}>
									<WebText recipe={webText(libraryNavigationClasses.item)}>{item.label}</WebText>
									<WebText recipe={libraryNavigationClasses.subtitle}>{item.description}</WebText>
								</WebView>
							</AppPressable>
						</WebView>
					);
				}}
			/>
		</SafeAreaScreen>
	);
}
