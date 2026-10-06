import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as clipboard from "@/hooks/use-copy-to-clipboard";
import { CopyButton } from "./add-agent-setup";
import { PromptBlock } from "./daemon-status";

afterEach(() => {
	mock.restore();
});

describe("onboarding copy feedback", () => {
	test.each([false, true])("keeps the setup button icon-only when copied=%s", (copied) => {
		const hook = spyOn(clipboard, "useCopyToClipboard").mockReturnValue({
			copied,
			copy: async () => undefined,
		});
		const markup = renderToStaticMarkup(
			createElement(CopyButton, { text: "setup prompt", label: "Copy setup prompt" }),
		);
		expect(hook).toHaveBeenCalledWith(
			{ success: false, error: "Couldn't copy. Select the prompt and copy it manually." },
			2000,
		);
		expect(markup).toContain(
			`<span aria-live="polite" class="sr-only">${copied ? "Copied" : ""}</span>`,
		);
		const visibleMarkup = markup.replace(/<span[^>]*class="sr-only"[^>]*>.*?<\/span>/g, "");
		expect(visibleMarkup).toStartWith("<button");
		expect(visibleMarkup).toEndWith("</button>");
		expect(visibleMarkup).toContain('aria-label="Copy setup prompt"');
		expect(visibleMarkup).toContain(copied ? "lucide-check" : "lucide-copy");
		expect(visibleMarkup).not.toContain("Copied");
	});

	test.each([false, true])(
		"preserves the prompt button's existing label when copied=%s",
		(copied) => {
			const hook = spyOn(clipboard, "useCopyToClipboard").mockReturnValue({
				copied,
				copy: async () => undefined,
			});
			const markup = renderToStaticMarkup(createElement(PromptBlock, { text: "setup prompt" }));
			expect(hook).toHaveBeenCalledWith({
				success: false,
				error: "Couldn't copy. Select the prompt and copy it manually.",
			});
			expect(markup).toContain(
				`<span class="sr-only" aria-live="polite">${copied ? "Copied" : ""}</span>`,
			);
			const visibleMarkup = markup.replace(/<span[^>]*class="sr-only"[^>]*>.*?<\/span>/g, "");
			expect(visibleMarkup).toContain(">Prompt</span><button");
			expect(visibleMarkup).toContain(`>${copied ? "Copied" : "Copy"}</button>`);
			expect(visibleMarkup.match(/Copied/g)?.length ?? 0).toBe(copied ? 1 : 0);
		},
	);
});
