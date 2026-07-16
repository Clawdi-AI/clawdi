"use client";

import { createContext, useContext, useEffect, useRef } from "react";

export interface SettingsEditState {
	dirty: boolean;
	busy: boolean;
}

export type RegisterSettingsEditState = (token: symbol, state: SettingsEditState | null) => void;

export const SettingsEditStateContext = createContext<RegisterSettingsEditState | null>(null);

export function useSettingsEditState(state: SettingsEditState): void {
	const register = useContext(SettingsEditStateContext);
	const tokenRef = useRef<symbol | null>(null);
	if (tokenRef.current === null) tokenRef.current = Symbol("settings-edit-state");
	const token = tokenRef.current;

	useEffect(() => {
		if (!register) return;
		register(token, state);
		return () => register(token, null);
	}, [register, state.busy, state.dirty, token]);
}
