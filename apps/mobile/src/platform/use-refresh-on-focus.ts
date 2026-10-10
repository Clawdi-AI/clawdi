import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

/**
 * TanStack Query's React Native "Refresh on Screen focus" pattern. `refetchOnWindowFocus`
 * only follows app foregrounding (AppLifecycleBridge), so a screen that stays mounted in a
 * tab or stack would otherwise keep showing data that went stale while it was hidden.
 * The initial focus is skipped because mounting already fetches; `stale: true` keeps
 * revisits within `staleTime` free.
 */
export function useRefreshOnFocus(queryKeys: readonly QueryKey[]) {
	const queryClient = useQueryClient();
	const keys = useRef(queryKeys);
	const firstFocus = useRef(true);
	useEffect(() => {
		keys.current = queryKeys;
	});
	useFocusEffect(
		useCallback(() => {
			if (firstFocus.current) {
				firstFocus.current = false;
				return;
			}
			for (const queryKey of keys.current)
				void queryClient.refetchQueries({ queryKey, stale: true, type: "active" });
		}, [queryClient]),
	);
}
