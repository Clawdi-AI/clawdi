import { type components, searchExcerpt } from "@clawdi/shared/api";
import { memoriesSurfaceClasses } from "@clawdi/shared/ui";
import { MEMORY_CATEGORY_COLORS, memoryDisplayName, relativeTime } from "@clawdi/shared/view";
import { Laptop, Trash2 } from "lucide-react-native";
import { Badge } from "../badge";
import { Button } from "../button";
import { EntityCardActions, EntityCardChassis, EntityCardLink, EntityMeta } from "../entity-card";
import { Icon } from "../icon";
import { SearchHighlightedText } from "../search-highlighted-text";
import { Text } from "../text";
import { WebText, WebView, webBoth, webView } from "../web-layout";
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
	const visibleContent = searchQuery
		? searchExcerpt(memory.content, searchQuery, 320)
		: memory.content;
	return (
		<EntityCardChassis variant="resource" interactive>
			<EntityCardLink
				variant="resource"
				to={{ pathname: "/memories/[memoryId]", params: { memoryId: memory.id } }}
				ariaLabel={`Open memory: ${memoryDisplayName(memory.content)}`}
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
							<Text>{memory.category}</Text>
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
						accessibilityLabel={`Delete memory: ${memoryDisplayName(memory.content)}`}
					>
						<Icon as={Trash2} className={webBoth(memoriesSurfaceClasses.smallIcon)} />
					</Button>
				</EntityCardActions>
			) : null}
		</EntityCardChassis>
	);
}
