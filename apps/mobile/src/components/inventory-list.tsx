import type { ReactElement, Ref } from "react";
import { FlatList } from "react-native";
import { ErrorState } from "@/components/ui/feedback";
import { AppText, AppView } from "@/components/ui/primitives";
import { BackButton } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { NativeButton } from "@/platform/native-controls";
import { ReadScreen } from "@/platform/safe-area-screen";

export function InventoryList<Item extends { id: string }>({
	items,
	title,
	description,
	empty,
	header,
	renderItem,
	refreshing,
	onRefresh,
	error,
	onRetry,
	more,
	busy,
	onMore,
	listRef,
}: {
	items: Item[];
	title: string;
	description: string;
	empty: string;
	header?: ReactElement;
	renderItem: (item: Item) => ReactElement;
	refreshing: boolean;
	onRefresh: () => void;
	error: boolean;
	onRetry: () => void;
	more?: boolean;
	busy?: boolean;
	onMore?: () => void;
	listRef?: Ref<FlatList<Item>>;
}) {
	const t = useI18n();
	return (
		<ReadScreen>
			<FlatList
				ref={listRef}
				data={items}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) => renderItem(item)}
				contentContainerStyle={{ padding: 24, gap: 12, flexGrow: 1 }}
				refreshing={refreshing}
				onRefresh={onRefresh}
				initialNumToRender={10}
				windowSize={7}
				ListHeaderComponent={
					<AppView className="gap-3 pb-3">
						<BackButton />
						<AppText accessibilityRole="header" className="text-3xl font-semibold text-foreground">
							{title}
						</AppText>
						<AppText className="text-base text-muted-foreground">{description}</AppText>
						{header}
					</AppView>
				}
				ListEmptyComponent={
					!error ? (
						<AppText className="text-base text-muted-foreground">{empty}</AppText>
					) : undefined
				}
				ListFooterComponent={
					<AppView className="gap-3 py-4">
						{error ? <ErrorState onRetry={busy ? undefined : onRetry} /> : null}
						{more && onMore ? (
							<NativeButton disabled={busy} label={t("inventory.loadMore")} onPress={onMore} />
						) : null}
					</AppView>
				}
			/>
		</ReadScreen>
	);
}
