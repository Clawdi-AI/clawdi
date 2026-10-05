import { libraryNavigationClasses, projectsSurfaceClasses } from "@clawdi/shared/ui";
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
import { useI18n } from "../../src/i18n";
import { LibraryPage } from "../../src/ui/detail/layout";
import { Icon } from "../../src/ui/icon";
import { IconChip } from "../../src/ui/icon-chip";
import { PageHeader } from "../../src/ui/page-header";
import { SectionLabel } from "../../src/ui/section-label";
import { AppPressable } from "../../src/ui/view";
import { WebText, WebView, webText, webView } from "../../src/ui/web-layout";

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
		<LibraryPage>
			<PageHeader title={t("navigation.library")} />
			<WebView recipe={projectsSurfaceClasses.section}>
				{items.map((item) => {
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
				})}
			</WebView>
		</LibraryPage>
	);
}
