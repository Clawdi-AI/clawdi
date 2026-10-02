import { focusManager, onlineManager, useQueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import { type ReactNode, useEffect } from "react";
import { AppState } from "react-native";

function setOnlineState(isConnected: boolean | null, isInternetReachable: boolean | null) {
	onlineManager.setOnline(isConnected === true && isInternetReachable !== false);
}

export function AppLifecycleBridge({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	useEffect(() => {
		let mounted = true;
		const refreshNetworkState = async () => {
			try {
				const state = await Network.getNetworkStateAsync();
				if (mounted) setOnlineState(state.isConnected ?? null, state.isInternetReachable ?? null);
			} catch {
				if (mounted) onlineManager.setOnline(true);
			}
		};
		void refreshNetworkState();
		focusManager.setFocused(AppState.currentState === "active");
		const networkSubscription = Network.addNetworkStateListener((state) => {
			if (mounted) setOnlineState(state.isConnected ?? null, state.isInternetReachable ?? null);
		});
		const appStateSubscription = AppState.addEventListener("change", (state) => {
			const active = state === "active";
			focusManager.setFocused(active);
			if (!active) {
				void queryClient.cancelQueries().catch(() => undefined);
				return;
			}
			void refreshNetworkState().then(() => {
				if (mounted) {
					void queryClient.refetchQueries({ type: "active", stale: true }).catch(() => undefined);
				}
			});
		});
		return () => {
			mounted = false;
			networkSubscription.remove();
			appStateSubscription.remove();
			focusManager.setFocused(true);
			onlineManager.setOnline(true);
		};
	}, [queryClient]);

	return children;
}
