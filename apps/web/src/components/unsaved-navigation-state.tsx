"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";

type EditState = { dirty: boolean; busy: boolean };
type RegisterEditState = (token: symbol, state: EditState | null) => void;

const UnsavedNavigationStateContext = createContext<RegisterEditState | null>(null);

export function UnsavedNavigationBoundary({
	children,
	description,
}: {
	children: ReactNode;
	description?: string;
}) {
	const [states, setStates] = useState<Map<symbol, EditState>>(() => new Map());
	const register = useCallback((token: symbol, state: EditState | null) => {
		setStates((current) => {
			const next = new Map(current);
			if (state && (state.dirty || state.busy)) next.set(token, state);
			else next.delete(token);
			return next;
		});
	}, []);
	const dirty = [...states.values()].some((state) => state.dirty);
	const busy = [...states.values()].some((state) => state.busy);

	return (
		<UnsavedNavigationStateContext.Provider value={register}>
			{children}
			<UnsavedNavigationGuard dirty={dirty} busy={busy} description={description} />
		</UnsavedNavigationStateContext.Provider>
	);
}

export function useUnsavedNavigationState(state: EditState): boolean {
	const register = useContext(UnsavedNavigationStateContext);
	const tokenRef = useRef<symbol | null>(null);
	if (tokenRef.current === null) tokenRef.current = Symbol("unsaved-navigation-state");
	const token = tokenRef.current;

	useEffect(() => {
		if (!register) return;
		register(token, state);
		return () => register(token, null);
	}, [register, state.busy, state.dirty, token]);

	return register !== null;
}
