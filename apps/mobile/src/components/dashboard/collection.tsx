import { agentsIndexClasses, connectedAgentDetailClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import type { ReactElement, ReactNode } from "react";
import type { ListRenderItem } from "react-native";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { AppScrollView } from "@/components/ui/view";
import { WebIcon, webView } from "@/components/ui/web-layout";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export function AgentCollection<T>({
	title,
	icon,
	iconTint,
	description,
	actions,
	navigation,
	children,
	data,
	renderItem,
	keyExtractor,
	empty,
	footer,
	refreshing,
	onRefresh,
	hasMore,
	loadingMore,
	onLoadMore,
}: {
	title: string;
	icon?: LucideIcon;
	iconTint?: string;
	description?: string;
	actions?: ReactNode;
	navigation?: ReactNode;
	children?: ReactNode;
	data?: T[];
	renderItem?: ListRenderItem<T>;
	keyExtractor?: (item: T, index: number) => string;
	empty?: ReactElement | null;
	footer?: ReactElement | null;
	refreshing?: boolean;
	onRefresh?: () => void;
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
}) {
	const header = (
		<>
			<PageHeader
				title={title}
				description={description}
				actions={actions}
				icon={
					icon && iconTint ? (
						<IconChip tint={iconTint}>
							<Icon as={icon} />
						</IconChip>
					) : icon ? (
						<WebIcon as={icon} recipe={connectedAgentDetailClasses.sectionIcon} />
					) : undefined
				}
			/>
			{children}
		</>
	);
	return (
		<SafeAreaScreen>
			{navigation}
			{data && renderItem ? (
				<NativeList
					data={data}
					renderItem={renderItem}
					keyExtractor={keyExtractor}
					header={header}
					empty={empty}
					footer={footer}
					refreshing={refreshing}
					onRefresh={onRefresh}
					hasMore={hasMore}
					loadingMore={loadingMore}
					onLoadMore={onLoadMore}
				/>
			) : (
				<AppScrollView
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={webView(agentsIndexClasses.page)}
				>
					{header}
				</AppScrollView>
			)}
		</SafeAreaScreen>
	);
}
