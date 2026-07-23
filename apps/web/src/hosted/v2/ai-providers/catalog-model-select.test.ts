import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogModelSelect } from "@/hosted/v2/ai-providers/catalog-model-select";
import {
	MANAGED_DEFAULT_MODEL_CHOICE,
	MANAGED_DEFAULT_MODEL_CHOICE_LABEL,
} from "@/hosted/v2/ai-providers/model-binding";

test("renders the hosted default as a friendly visible catalog model label", () => {
	const markup = renderToStaticMarkup(
		createElement(CatalogModelSelect, {
			id: "catalog-model",
			modelIds: [MANAGED_DEFAULT_MODEL_CHOICE],
			value: MANAGED_DEFAULT_MODEL_CHOICE,
			onValueChange: () => {},
		}),
	);
	const visibleValue = markup.match(/data-slot="select-value"[^>]*>([^<]*)<\/span>/)?.[1];

	expect(visibleValue).toBe(MANAGED_DEFAULT_MODEL_CHOICE_LABEL);
	expect(visibleValue).not.toBe(MANAGED_DEFAULT_MODEL_CHOICE);
});
