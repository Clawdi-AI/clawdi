import { useState } from "react";

/** RefreshControl state for a user's pull only; background polls and invalidations stay silent. */
export function usePullRefresh(refresh: () => Promise<unknown>) {
	const [refreshing, setRefreshing] = useState(false);
	const onRefresh = () => {
		setRefreshing(true);
		void refresh()
			.catch(() => undefined)
			.finally(() => setRefreshing(false));
	};
	return { refreshing, onRefresh };
}
