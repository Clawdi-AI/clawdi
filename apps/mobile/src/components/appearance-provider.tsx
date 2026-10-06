import { type AppearanceMode, isAppearanceMode } from "@clawdi/shared/consts";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Uniwind, useUniwind } from "uniwind";

const STORAGE_KEY = "clawdi.appearance";
type AppearanceContextValue = {
	mode: AppearanceMode;
	ready: boolean;
	busy: boolean;
	error: boolean;
	reload: () => void;
	select: (mode: AppearanceMode) => Promise<void>;
};
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/** Device-local preference, deliberately independent of account/token state. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
	const [mode, setMode] = useState<AppearanceMode>("system");
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const lease = useRef<object | null>(null);
	const saving = useRef(false);
	const { theme } = useUniwind();
	useEffect(() => {
		const current = {};
		lease.current = current;
		setReady(false);
		setError(false);
		void (async () => {
			try {
				const stored = await SecureStore.getItemAsync(STORAGE_KEY);
				if (lease.current !== current) return;
				const next = isAppearanceMode(stored) ? stored : "system";
				Uniwind.setTheme(next);
				setMode(next);
				setReady(true);
			} catch {
				if (lease.current === current) setError(true);
			}
		})();
		return () => {
			if (lease.current === current) lease.current = null;
		};
	}, [epoch]);
	const select = async (next: AppearanceMode) => {
		if (!ready || saving.current || !lease.current || !isAppearanceMode(next)) return;
		const current = lease.current;
		saving.current = true;
		setBusy(true);
		setError(false);
		try {
			// Persist before applying so a failed save never claims persistence.
			await SecureStore.setItemAsync(STORAGE_KEY, next);
			if (lease.current !== current) return;
			Uniwind.setTheme(next);
			setMode(next);
		} catch {
			if (lease.current === current) setError(true);
		} finally {
			saving.current = false;
			if (lease.current === current) setBusy(false);
		}
	};
	return (
		<AppearanceContext.Provider
			value={{
				mode,
				ready,
				busy,
				error,
				select,
				reload: () => {
					if (!saving.current) setEpoch((value) => value + 1);
				},
			}}
		>
			<StatusBar style={theme === "dark" ? "light" : "dark"} />
			{children}
		</AppearanceContext.Provider>
	);
}

export function useAppearance() {
	const context = useContext(AppearanceContext);
	if (!context) throw new Error("AppearanceProvider missing");
	return context;
}
