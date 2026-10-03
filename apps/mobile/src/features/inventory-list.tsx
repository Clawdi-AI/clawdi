import type { ReactElement, Ref } from "react";
import { FlatList } from "react-native";
import { useI18n } from "../i18n";
import { ErrorState } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

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
						<AppText className="text-base text-muted">{description}</AppText>
						{header}
					</AppView>
				}
				ListEmptyComponent={
					!error ? <AppText className="text-base text-muted">{empty}</AppText> : undefined
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
