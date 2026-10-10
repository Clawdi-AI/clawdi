import { type components, searchExcerpt } from "@clawdi/shared/api";
import { memoriesSurfaceClasses } from "@clawdi/shared/ui";
import {
	MEMORY_CATEGORY_COLORS,
	memoryCategoryLabel,
	memoryDisplayName,
	relativeTime,
} from "@clawdi/shared/view";
import Laptop from "lucide-react-native/icons/laptop";
import Trash2 from "lucide-react-native/icons/trash";
import {
	EntityCardActions,
	EntityCardChassis,
	EntityCardLink,
	EntityMeta,
} from "@/components/entity-card";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAgentRouteId } from "@/platform/navigation/use-agent-route";
export function MemoryCard({
	memory,
	onDelete,
	onEdit,
	searchQuery = "",
}: {
	memory: components["schemas"]["MemoryResponse"];
	onDelete?: () => void;
	onEdit?: () => void;
	searchQuery?: string;
}) {
	const t = useI18n();
	const agentId = useAgentRouteId();
	const visibleContent = searchQuery
		? searchExcerpt(memory.content, searchQuery, 320)
		: memory.content;
	return (
		<EntityCardChassis variant="resource" interactive>
			<EntityCardLink
				variant="resource"
				to={
					agentId
						? {
								pathname: "/agents/[id]/memories/[memoryId]",
								params: { id: agentId, memoryId: memory.id },
							}
						: { pathname: "/memories/[id]", params: { id: memory.id } }
				}
				ariaLabel={t("labels.openMemory", { name: memoryDisplayName(memory.content) })}
			/>
			<WebView recipe="">
				<WebText recipe={memoriesSurfaceClasses.content} numberOfLines={8}>
					<SearchHighlightedText text={visibleContent} query={searchQuery} />
				</WebText>
				<EntityMeta
					className={webBoth(memoriesSurfaceClasses.footer)}
					items={[
						<Badge
							key="category"
							variant="secondary"
							className={webBoth(MEMORY_CATEGORY_COLORS[memory.category] ?? "")}
						>
							<Text>{memoryCategoryLabel(memory.category)}</Text>
						</Badge>,
						...(memory.tags?.slice(0, 3).map((tag) => `#${tag}`) ?? []),
						memory.created_at ? relativeTime(memory.created_at) : null,
						memory.source_machine_name ? (
							<WebView key="machine" recipe={memoriesSurfaceClasses.source}>
								<Icon as={Laptop} className={webBoth(memoriesSurfaceClasses.sourceIcon)} />
								<WebText recipe={memoriesSurfaceClasses.sourceName} numberOfLines={1}>
									{memory.source_machine_name}
								</WebText>
							</WebView>
						) : null,
					]}
				/>
			</WebView>
			{onDelete ? (
				<EntityCardActions className={webView(memoriesSurfaceClasses.actions)}>
					<Button
						variant="ghost"
						size="icon-sm"
						className={webView(memoriesSurfaceClasses.deleteAction)}
						onPress={onDelete}
						onLongPress={onEdit}
						accessibilityLabel={t("labels.deleteMemory", {
							name: memoryDisplayName(memory.content),
						})}
					>
						<Icon as={Trash2} className={webBoth(memoriesSurfaceClasses.deleteIcon)} />
					</Button>
				</EntityCardActions>
			) : null}
		</EntityCardChassis>
	);
}
