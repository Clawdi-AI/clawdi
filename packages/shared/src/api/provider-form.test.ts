import { expect, test } from "bun:test";
import type { components } from "./api.generated";
import { providerEditOperation } from "./provider-form";

const provider = {
	id: "row",
	provider_id: "work",
	label: "Work",
	scope: "account",
	type: "openai",
	base_url: "https://api.openai.com/v1",
	api_mode: "openai_responses",
	auth: { type: "api_key", source: "managed" },
	managed_by: "user",
	usable: true,
	configuration_mode: "connection",
	runtime_env_name: "WORK_KEY",
	models: [{ id: "owned-model" }],
	created_at: "2026-10-03T00:00:00Z",
	updated_at: "2026-10-03T00:00:00Z",
} satisfies components["schemas"]["AiProviderResponse"];

test("connection edits rotate credentials atomically without changing model ownership or runtime identity", () => {
	const result = providerEditOperation(
		provider,
		{ ...provider, label: "Personal", base_url: "https://proxy.example/v1" },
		" replacement ",
	);
	expect(result).toEqual({
		kind: "connection",
		body: {
			label: "Personal",
			base_url: "https://proxy.example/v1",
			credential: { type: "api_key", value: "replacement" },
		},
	});
	expect(providerEditOperation(provider, { ...provider, label: "Personal" }, "")).toEqual({
		kind: "connection",
		body: { label: "Personal" },
	});
});

test("native and catalog credentials use explicit replacement, while settings-only edits preserve auth and models", () => {
	const native = { ...provider, configuration_mode: "native" as const, native_provider: "openai" };
	expect(providerEditOperation(native, { ...native, label: "Personal" }, "")).toEqual({
		kind: "settings",
		body: { label: "Personal" },
	});
	const fields = { ...native, label: "Personal" };
	expect(providerEditOperation(native, fields, " replacement ")).toEqual({
		kind: "accept",
		body: {
			provider: fields,
			replace: true,
			credential: { type: "api_key", value: "replacement" },
		},
	});
});
