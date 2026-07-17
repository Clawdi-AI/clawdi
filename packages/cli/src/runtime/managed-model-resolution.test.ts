import { describe, expect, test } from "bun:test";
import {
	buildManagedModelsEndpoint,
	extractManagedLiveModelIds,
	extractManagedLiveModels,
	resolveManagedPrimaryModel,
} from "./managed-model-resolution";

describe("managed model resolution", () => {
	test("keeps a configured managed model when it is still live", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.5",
				liveModelIds: ["gpt-5.4", "gpt-5.5", "gpt-5.6"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.5",
			reason: "kept_valid_seed",
		});
	});

	test("upgrades an invalid or absent managed seed to the latest live model", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.4",
				liveModelIds: ["gpt-5.5", "gpt-5.6", "gpt-5.6-pro"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.6-pro",
			reason: "upgraded_to_latest",
		});

		expect(
			resolveManagedPrimaryModel({
				seedModel: null,
				liveModelIds: ["gpt-5.5", "gpt-5.6"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.6",
			reason: "upgraded_to_latest",
		});
	});

	test("keeps the existing seed when the live fetch fails", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.5",
				liveModelIds: null,
			}),
		).toEqual({
			resolvedModel: "gpt-5.5",
			reason: "kept_seed_after_fetch_failure",
		});
	});

	test("builds the managed OpenAI-compatible /v1/models endpoint and parses live ids", () => {
		expect(buildManagedModelsEndpoint("https://api.example.test/v1/")).toBe(
			"https://api.example.test/v1/models",
		);
		expect(
			extractManagedLiveModelIds({
				data: [{ id: "gpt-5.5" }, { id: "gpt-5.6" }, { id: "gpt-5.6" }, { bad: true }],
			}),
		).toEqual(["gpt-5.5", "gpt-5.6"]);
	});

	test("preserves canonical capabilities and ignores unknown discovery fields", () => {
		expect(
			extractManagedLiveModels({
				data: [
					{
						id: "k3",
						label: "Kimi K3",
						context_length: 1_048_576,
						max_input_tokens: 1_048_576,
						input_modalities: ["text", "image", "unknown", "image"],
						supports_vision: true,
						supports_tools: true,
						supports_reasoning: true,
						future_capability: { mode: "turbo" },
					},
					{
						id: "kimi-for-coding",
						context_window: 262_144,
						max_input_tokens: 262_144,
						supports_tools: true,
					},
					{
						id: "kimi-for-coding-highspeed",
						context_window: 262_144,
						max_input_tokens: 262_144,
						supports_tools: true,
						unknown_extra: true,
					},
				],
			}),
		).toEqual([
			{
				id: "k3",
				label: "Kimi K3",
				context_window: 1_048_576,
				max_input_tokens: 1_048_576,
				input_modalities: ["text", "image"],
				supports_vision: true,
				supports_tools: true,
				supports_reasoning: true,
			},
			{
				id: "kimi-for-coding",
				context_window: 262_144,
				max_input_tokens: 262_144,
				supports_tools: true,
			},
			{
				id: "kimi-for-coding-highspeed",
				context_window: 262_144,
				max_input_tokens: 262_144,
				supports_tools: true,
			},
		]);
	});

	test("prefers canonical limits over OpenAI-compatible discovery aliases", () => {
		expect(
			extractManagedLiveModels({
				data: [
					{
						id: "canonical-wins",
						context_window: 1_048_576,
						context_length: 262_144,
						max_tokens: 32_768,
						max_output_tokens: 16_384,
					},
					{
						id: "generic-output-alias",
						context_length: 400_000,
						max_input_tokens: 350_000,
						max_output_tokens: 16_384,
					},
				],
			}),
		).toEqual([
			{
				id: "canonical-wins",
				context_window: 1_048_576,
				max_tokens: 32_768,
			},
			{
				id: "generic-output-alias",
				context_window: 400_000,
				max_input_tokens: 350_000,
				max_tokens: 16_384,
			},
		]);
	});
});
