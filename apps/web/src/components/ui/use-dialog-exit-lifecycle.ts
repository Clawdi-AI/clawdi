"use client";

import { useCallback, useReducer } from "react";

export type DialogExitPhase = "open" | "closing" | "closed";

export interface DialogExitState<T> {
	phase: DialogExitPhase;
	snapshot: T;
}

type DialogExitAction<T> =
	| { type: "open" }
	| { type: "close"; snapshot: T }
	| { type: "complete"; emptySnapshot: T };

export function reduceDialogExitState<T>(
	state: DialogExitState<T>,
	action: DialogExitAction<T>,
): DialogExitState<T> {
	switch (action.type) {
		case "open":
			return { ...state, phase: "open" };
		case "close":
			return {
				phase: "closing",
				snapshot: action.snapshot,
			};
		case "complete":
			return { ...state, phase: "closed", snapshot: action.emptySnapshot };
	}
}

export function dialogExitRenderedValue<T>(input: {
	open: boolean;
	state: DialogExitState<T>;
	value: T;
}): T {
	return !input.open && input.state.phase === "closing" ? input.state.snapshot : input.value;
}

/**
 * Owns the state boundary between a controlled popup and Base UI's exit window.
 * `beginClose` only captures the rendered value before the caller closes. The caller
 * must synchronously invalidate or cancel its async work before or while closing.
 * `completeClose` clears the snapshot only after Base UI has completed either its
 * animation or reduced-motion close path.
 */
export function useDialogExitLifecycle<T>(input: { open: boolean; value: T; emptyValue: T }) {
	const { open, value, emptyValue } = input;
	const [state, dispatch] = useReducer(reduceDialogExitState<T>, {
		phase: open ? "open" : "closed",
		snapshot: open ? value : emptyValue,
	});

	const beginOpen = useCallback(() => {
		dispatch({ type: "open" });
	}, []);
	const beginClose = useCallback(() => {
		dispatch({ type: "close", snapshot: value });
	}, [value]);
	const completeClose = useCallback(() => {
		dispatch({ type: "complete", emptySnapshot: emptyValue });
	}, [emptyValue]);
	return {
		beginOpen,
		beginClose,
		completeClose,
		phase: state.phase,
		renderedValue: dialogExitRenderedValue({ open, state, value }),
	};
}
