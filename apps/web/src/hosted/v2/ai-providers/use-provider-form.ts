"use client";

import { useCallback, useState } from "react";
import type { AuthMethod } from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import type { ApiMode, ProviderTypeId } from "@/hosted/v2/ai-providers/provider-types";

export interface ProviderFormState {
	configurationMode: "native" | "custom" | "catalog" | "connection";
	type: ProviderTypeId;
	label: string;
	baseUrl: string;
	apiMode: ApiMode;
	authMethod: AuthMethod;
	apiKey: string;
	presetId: string | null;
	regionId: string | null;
}

const INITIAL_STATE: ProviderFormState = {
	configurationMode: "native",
	type: "openai",
	label: "",
	baseUrl: "",
	apiMode: "openai_responses",
	authMethod: "api_key",
	apiKey: "",
	presetId: null,
	regionId: null,
};

export function useProviderForm() {
	const [state, setState] = useState(INITIAL_STATE);
	const update = useCallback((value: Partial<ProviderFormState>) => {
		setState((current) => ({ ...current, ...value }));
	}, []);
	return { state, reset: setState, update };
}
