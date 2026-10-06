import { type Href, router, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef } from "react";
import { useAccountScope } from "@/platform/account-lifecycle";

/** Mutations keep their existing fences. Results invalidate the parent before dismissal. */
export function useSheet<Result = void>({
	fallback,
	busy = false,
	onResult,
}: {
	fallback: Href;
	busy?: boolean;
	onResult?: (result: Result) => Promise<unknown>;
}) {
	const scope = useAccountScope();
	const navigation = useNavigation();
	const mounted = useRef(true);
	const closing = useRef(false);
	const completed = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	usePreventRemove(busy, ({ data }) => {
		// React Navigation permits redispatching the original, explicitly accepted action.
		if (completed.current) navigation.dispatch(data.action);
	});
	return {
		close: async (result?: Result) => {
			if (
				(busy && result === undefined) ||
				closing.current ||
				!scope.isCurrent() ||
				!navigation.isFocused()
			)
				return;
			closing.current = true;
			try {
				if (result !== undefined) await onResult?.(result);
				if (!mounted.current || !scope.isCurrent() || !navigation.isFocused()) return;
				completed.current = true;
				if (router.canDismiss()) router.dismiss();
				else router.replace(fallback);
			} finally {
				closing.current = false;
			}
		},
	};
}
