import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrimaryModelPicker } from "@/hosted/billing/deploy/deploy-wizard";
import {
	MANAGED_AI_CHOICE,
	MANAGED_AI_CHOICE_LABEL,
	MANAGED_DEFAULT_MODEL_CHOICE,
	MANAGED_DEFAULT_MODEL_CHOICE_LABEL,
} from "@/hosted/v2/ai-providers/model-binding";

function selectValueLabels(markup: string): string[] {
	return [...markup.matchAll(/data-slot="select-value"[^>]*>([^<]*)<\/span>/g)].map(
		(match) => match[1] ?? "",
	);
}

describe("deploy wizard primary model picker", () => {
	test("renders friendly labels for managed sentinel values", () => {
		const markup = renderToStaticMarkup(
			createElement(PrimaryModelPicker, {
				providers: [],
				customProviders: [],
				selectedProviderChoices: [MANAGED_AI_CHOICE],
				primaryProviderChoice: MANAGED_AI_CHOICE,
				primaryModel: MANAGED_DEFAULT_MODEL_CHOICE,
				onPrimaryProviderChange: () => {},
				onPrimaryModelChange: () => {},
			}),
		);

		const visibleLabels = selectValueLabels(markup);
		expect(visibleLabels).toEqual([MANAGED_AI_CHOICE_LABEL, MANAGED_DEFAULT_MODEL_CHOICE_LABEL]);
		expect(visibleLabels).not.toContain(MANAGED_AI_CHOICE);
		expect(visibleLabels).not.toContain(MANAGED_DEFAULT_MODEL_CHOICE);
		expect(markup).toContain(`value="${MANAGED_AI_CHOICE}"`);
		expect(markup).toContain(`value="${MANAGED_DEFAULT_MODEL_CHOICE}"`);
	});
});
