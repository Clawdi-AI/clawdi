import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
let timerSpy = spyOn(globalThis, "setTimeout");

class FocusableElement {
	focus = mock(() => undefined);
}

const activeElement = new FocusableElement();
const textarea = {
	value: "",
	style: { position: "", opacity: "" },
	setAttribute: mock(() => undefined),
	select: mock(() => undefined),
	remove: mock(() => undefined),
};
const writeText = mock<(value: string) => Promise<void>>(() => Promise.resolve());
const execCommand = mock(() => true);
const appendChild = mock(() => undefined);

function copyFromHook(
	options?: Parameters<typeof useCopyToClipboard>[0],
	duration?: Parameters<typeof useCopyToClipboard>[1],
) {
	let copy: ReturnType<typeof useCopyToClipboard>["copy"] | undefined;
	function Harness() {
		copy = useCopyToClipboard(options, duration).copy;
		return null;
	}
	// Mount the hook with React's server renderer; only browser I/O is mocked.
	renderToStaticMarkup(createElement(Harness));
	if (!copy) throw new Error("Copy hook did not render");
	return copy;
}

beforeEach(() => {
	mock.clearAllMocks();
	writeText.mockImplementation(() => Promise.resolve());
	execCommand.mockImplementation(() => true);
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { clipboard: { writeText } },
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			activeElement,
			createElement: () => textarea,
			body: { appendChild },
			execCommand,
		},
	});
	Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FocusableElement });
	spyOn(toast, "success").mockImplementation(() => "test-success");
	spyOn(toast, "error").mockImplementation(() => "test-error");
	timerSpy = spyOn(globalThis, "setTimeout");
});

afterEach(() => {
	for (const result of timerSpy.mock.results) {
		if (result.type === "return") clearTimeout(result.value);
	}
	mock.restore();
	for (const [key, descriptor] of [
		["navigator", originalNavigator],
		["document", originalDocument],
		["HTMLElement", originalHTMLElement],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("useCopyToClipboard", () => {
	test("uses the clipboard API without selecting text when available", async () => {
		await copyFromHook()("setup prompt");
		expect(writeText).toHaveBeenCalledWith("setup prompt");
		expect(execCommand).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledWith("Copied to clipboard");
		expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 1500);
	});

	test("preserves the setup button's two-second success feedback without a toast", async () => {
		await copyFromHook({ success: false }, 2000)("setup prompt");
		expect(writeText).toHaveBeenCalledWith("setup prompt");
		expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
		expect(toast.success).not.toHaveBeenCalled();
	});

	test("falls back to selection after clipboard rejection and restores focus", async () => {
		writeText.mockRejectedValue(new Error("Internal clipboard details"));
		await copyFromHook()("setup prompt");
		expect(textarea.value).toBe("setup prompt");
		expect(appendChild).toHaveBeenCalledWith(textarea);
		expect(textarea.select).toHaveBeenCalled();
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(textarea.remove).toHaveBeenCalled();
		expect(activeElement.focus).toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledWith("Copied to clipboard");
		expect(toast.error).not.toHaveBeenCalled();
	});

	test("uses selection when the clipboard API is unavailable", async () => {
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
		await copyFromHook({ success: false })("setup prompt");
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(toast.success).not.toHaveBeenCalled();
	});

	test("reports a safe error if both copy paths fail", async () => {
		writeText.mockRejectedValue(new Error("Internal clipboard details"));
		execCommand.mockReturnValue(false);
		await copyFromHook()("setup prompt");
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith("Couldn't copy — select and copy manually.");
		expect(toast.success).not.toHaveBeenCalled();
		expect(textarea.remove).toHaveBeenCalled();
	});

	test("handles a throwing fallback with the surface's failure copy", async () => {
		writeText.mockRejectedValue(new Error("Internal clipboard details"));
		execCommand.mockImplementation(() => {
			throw new Error("Internal selection details");
		});
		await copyFromHook({ error: "Couldn't copy. Select the prompt and copy it manually." })(
			"setup prompt",
		);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(
			"Couldn't copy. Select the prompt and copy it manually.",
		);
		expect(textarea.remove).toHaveBeenCalled();
		expect(activeElement.focus).toHaveBeenCalled();
	});
});
