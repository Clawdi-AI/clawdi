import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

/** Capture presentation permission before async work; blur/background retire it. */
export function useForegroundLease() {
	const focused = useRef(false);
	const epoch = useRef(0);
	useFocusEffect(
		useCallback(() => {
			focused.current = true;
			return () => {
				focused.current = false;
				epoch.current++;
			};
		}, []),
	);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") epoch.current++;
		});
		return () => listener.remove();
	}, []);
	return useCallback(() => {
		const captured = epoch.current;
		return () =>
			focused.current && epoch.current === captured && AppState.currentState === "active";
	}, []);
}
