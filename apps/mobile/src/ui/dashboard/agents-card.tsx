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
import { ApiErrorPanel } from "../api-error-panel";
import { EmptyState } from "../empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "../entity-card";
import { Text } from "../text";
import { AppPressable } from "../view";
import { WebView, webView } from "../web-layout";
import { AgentIcon } from "./agent-icon";
import { AgentSourceBadge } from "./agent-source-badge";

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
			) : isLoading ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{Array.from({ length: 4 }, (_, i) => (
						<EntityCardSkeleton key={i} iconSize="sm" statusDot titleBadge />
					))}
				</WebView>
			) : agents.length || hostedStatus?.isLoading ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{[...agents].sort(compareAgentTiles).map((tile) => (
						<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
					))}
					{hostedStatus?.isLoading ? (
						<EntityCardSkeleton iconSize="sm" statusDot titleBadge />
					) : null}
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
			style={{ height: "auto" }}
			accessibilityRole="link"
			accessibilityLabel={`Open ${tile.name}${statusVisual ? `. Status: ${statusVisual.label}` : ""}`}
			className={cn(ENTITY_CARD_BASE, webView(styles.card))}
			onPress={() => router.push({ pathname: "/agents/[agentId]", params: { agentId: tile.id } })}
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
