import { dashboardPageClasses } from "@clawdi/shared/ui";
import type { ReactElement } from "react";
import { FlatList, type FlatListProps, RefreshControl } from "react-native";
import { useResolveClassNames, useCSSVariable } from "uniwind";
import { webView } from "@/components/ui/web-layout";

/** One scroll owner: Web header/states stay in slots; data items are virtualized. */
export function NativeList<T>({
	refreshing = false,
	onRefresh,
	loadingMore = false,
	hasMore = false,
	onLoadMore,
	header,
	empty,
	footer,
	...props
}: Omit<
	FlatListProps<T>,
	| "refreshControl"
	| "onEndReached"
	| "ListHeaderComponent"
	| "ListEmptyComponent"
	| "ListFooterComponent"
> & {
	refreshing?: boolean;
	onRefresh?: () => void;
	loadingMore?: boolean;
	hasMore?: boolean;
	onLoadMore?: () => void;
	header?: ReactElement | null;
	empty?: ReactElement | null;
	footer?: ReactElement | null;
}) {
	const [tint, background] = useCSSVariable(["--color-foreground", "--color-background"]);
	const surface = useResolveClassNames("flex-1 bg-background");
	const content = useResolveClassNames(`${webView(dashboardPageClasses.root)} gap-2 pb-6 pt-5`);
	return (
		<FlatList<T>
			{...props}
			style={[surface, props.style]}
			contentContainerStyle={[content, props.contentContainerStyle]}
			contentInsetAdjustmentBehavior="automatic"
			keyboardShouldPersistTaps="handled"
			refreshControl={
				onRefresh ? (
					<RefreshControl
						refreshing={refreshing}
						onRefresh={onRefresh}
						tintColor={typeof tint === "string" ? tint : undefined}
						colors={typeof tint === "string" ? [tint] : undefined}
						progressBackgroundColor={typeof background === "string" ? background : undefined}
					/>
				) : undefined
			}
			onEndReached={() => {
				if (hasMore && !loadingMore && !refreshing) onLoadMore?.();
			}}
			onEndReachedThreshold={0.4}
			ListHeaderComponent={header}
			ListEmptyComponent={empty}
			ListFooterComponent={footer}
		/>
	);
}
