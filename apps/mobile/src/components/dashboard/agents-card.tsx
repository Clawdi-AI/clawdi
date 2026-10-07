import { agentsCardClasses as styles } from "@clawdi/shared/ui";
import {
	type AgentTile,
	agentTileCardProjection,
	compareAgentTiles,
	OVERVIEW_COPY,
} from "@clawdi/shared/view";
import { cn } from "cn";
import { router } from "expo-router";
import { Cloud } from "lucide-react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadge } from "@/components/dashboard/agent-source-badge";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "@/components/entity-card";
import { Text } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";

export function AgentsCard({
	agents,
	isLoading,
	error,
	onRetry,
	hostedStatus,
}: {
	agents: AgentTile[];
	isLoading: boolean;
	error?: unknown;
	onRetry?: () => void;
	hostedStatus?: { isLoading: boolean; error?: unknown; onRetry?: () => void };
}) {
	return (
		<WebView recipe={styles.section}>
			{error ? (
				<ApiErrorPanel error={error} onRetry={onRetry} title={OVERVIEW_COPY.agentsError} />
			) : isLoading || hostedStatus?.isLoading ? (
				// One skeleton until every source resolves, matching Web.
				<WebView recipe={ENTITY_GRID_CLASS}>
					{Array.from({ length: 4 }, (_, i) => (
						<EntityCardSkeleton key={i} iconSize="sm" statusDot titleBadge />
					))}
				</WebView>
			) : agents.length ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{[...agents].sort(compareAgentTiles).map((tile) => (
						<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
					))}
				</WebView>
			) : hostedStatus?.error ? null : (
				<EmptyState
					variant="inset"
					title={OVERVIEW_COPY.agentsEmpty}
					description={OVERVIEW_COPY.agentsEmptyDescription}
				/>
			)}
			{hostedStatus?.error ? (
				<ApiErrorPanel
					error={hostedStatus.error}
					onRetry={hostedStatus.onRetry}
					title={OVERVIEW_COPY.cloudInventoryError}
				/>
			) : null}
		</WebView>
	);
}
export function AgentTileView({ tile }: { tile: AgentTile }) {
	const { meta, statusVisual } = agentTileCardProjection(tile);
	return (
		<AppPressable
			testID={`agent-card-${tile.id}`}
			style={{ height: "auto" }}
			accessibilityRole="link"
			accessibilityLabel={`Open ${tile.name}${statusVisual ? `. Status: ${statusVisual.label}` : ""}`}
			className={cn(ENTITY_CARD_BASE, webView(styles.card))}
			onPress={() => router.push({ pathname: "/agents/[id]", params: { id: tile.id } })}
		>
			<EntityHeader
				icon={<AgentIcon agent={tile.agentType} size="lg" avatarUrl={tile.avatarUrl} />}
				title={
					<WebView recipe={styles.title} className="flex-row">
						{statusVisual ? <WebView recipe={`${styles.dot} ${statusVisual.dotClass}`} /> : null}
						<Text numberOfLines={1} className={webView(styles.name)}>
							{tile.name}
						</Text>
					</WebView>
				}
				meta={meta}
				titleAdornment={
					tile.source === "self-managed" ? undefined : <AgentSourceBadge icon={Cloud} />
				}
			/>
		</AppPressable>
	);
}
