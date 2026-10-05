import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	agentsCardClasses as styles,
} from "@clawdi/shared/ui";
import {
	type AgentTile,
	agentSurfaceCopy,
	agentTileCardProjection,
	compareAgentTiles,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { ApiErrorPanel } from "../api-error-panel";
import { EmptyState } from "../empty-state";
import { EntityCardSkeleton, EntityHeader } from "../entity-card";
import { AppPressable } from "../view";
import { WebText, WebView, webView } from "../web-layout";
import { AgentIcon } from "./agent-icon";

export function AgentsCard({
	agents,
	isLoading,
	error,
	onRetry,
}: {
	agents: AgentTile[];
	isLoading: boolean;
	error?: unknown;
	onRetry?: () => void;
}) {
	return (
		<WebView recipe={styles.spaceY}>
			{error ? (
				<ApiErrorPanel error={error} onRetry={onRetry} title={agentSurfaceCopy.couldnTLoadAgents} />
			) : isLoading ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{[0, 1, 2, 3].map((i) => (
						<EntityCardSkeleton key={i} iconSize="sm" statusDot titleBadge />
					))}
				</WebView>
			) : agents.length ? (
				<WebView recipe={ENTITY_GRID_CLASS}>
					{[...agents].sort(compareAgentTiles).map((tile) => (
						<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
					))}
				</WebView>
			) : (
				<EmptyState
					variant="inset"
					title={agentSurfaceCopy.noAgentsYet}
					description={agentSurfaceCopy.connectAnAgentToSeeItHere}
				/>
			)}
		</WebView>
	);
}
function AgentTileView({ tile }: { tile: AgentTile }) {
	const { meta, statusVisual } = agentTileCardProjection(tile);
	return (
		<AppPressable
			accessibilityRole="link"
			accessibilityLabel={`Open ${tile.name}${statusVisual ? `. Status: ${statusVisual.label}` : ""}`}
			className={webView(`${ENTITY_CARD_BASE} ${styles.tile.replace(/\bh-full\b/g, "")}`)}
			onPress={() => router.push({ pathname: "/agents/[agentId]", params: { agentId: tile.id } })}
		>
			<EntityHeader
				icon={<AgentIcon agent={tile.agentType} size="lg" avatarUrl={tile.avatarUrl} />}
				title={
					<WebView recipe={styles.flexMinWItems} className="flex-row">
						{statusVisual ? <WebView recipe={`${styles.dot} ${statusVisual.dotClass}`} /> : null}
						<WebText recipe={styles.minWTruncate} className="flex-shrink" numberOfLines={1}>
							{tile.name}
						</WebText>
					</WebView>
				}
				meta={meta}
				className={webView(styles.minWFlex)}
			/>
		</AppPressable>
	);
}
