import { afterEach, describe, expect, it } from "bun:test";
import { browserLanguage } from "@/hosted/billing/deploy/language-timezone-controls";

const original = globalThis.navigator;

function setLanguages(languages: string[]): void {
	Object.defineProperty(globalThis, "navigator", {
		value: { languages, language: languages[0] },
		configurable: true,
	});
}

afterEach(() => {
	Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
});

describe("browserLanguage", () => {
	it("matches an exact supported code", () => {
		setLanguages(["zh-TW"]);
		expect(browserLanguage()).toBe("zh-TW");
	});

	it("maps a region variant onto its base language", () => {
		setLanguages(["en-US"]);
		expect(browserLanguage()).toBe("en");
	});

	it("falls through preferred list to the first supported entry", () => {
		setLanguages(["xx-YY", "fr-FR"]);
		expect(browserLanguage()).toBe("fr");
	});

	it("returns unset when nothing is supported", () => {
		setLanguages(["xx-YY"]);
		expect(browserLanguage()).toBe("");
	});
});
