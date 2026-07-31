"use client";

import { useCallback, useReducer } from "react";
import type { AuthMethod } from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import type { ApiMode, ProviderTypeId } from "@/hosted/v2/ai-providers/provider-types";

export interface ProviderFormState {
	type: ProviderTypeId;
	label: string;
	baseUrl: string;
	modelsText: string;
	apiMode: ApiMode;
	runtimeEnv: string;
	authMethod: AuthMethod;
	apiKey: string;
	presetId: string | null;
	regionId: string | null;
}

const INITIAL_STATE: ProviderFormState = {
	type: "openai",
	label: "",
	baseUrl: "",
	modelsText: "",
	apiMode: "openai_responses",
	runtimeEnv: "OPENAI_API_KEY",
	authMethod: "api_key",
	apiKey: "",
	presetId: null,
	regionId: null,
};

type ProviderFormAction =
	| { type: "reset"; value: ProviderFormState }
	| { type: "update"; value: Partial<ProviderFormState> };

function reducer(state: ProviderFormState, action: ProviderFormAction): ProviderFormState {
	if (action.type === "reset") return action.value;
	return { ...state, ...action.value };
}

export function useProviderForm() {
	const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
	const reset = useCallback((value: ProviderFormState) => {
		dispatch({ type: "reset", value });
	}, []);
	const update = useCallback((value: Partial<ProviderFormState>) => {
		dispatch({ type: "update", value });
	}, []);
	return { state, reset, update };
}
