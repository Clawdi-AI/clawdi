import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyablePairingCode, PairingQrCode } from "./pairing-dialog-ui";

describe("pairing dialog primitives", () => {
	test("renders a semantic click-to-copy code control", () => {
		const markup = renderToStaticMarkup(
			createElement(CopyablePairingCode, {
				value: "/clawdi_pair BCDFGHJKLM",
				label: "Telegram pairing command",
			}),
		);

		expect(markup).toContain("<button");
		expect(markup).toContain('aria-label="Copy Telegram pairing command"');
		expect(markup).toContain('title="Copy Telegram pairing command"');
		expect(markup).toContain("<code");
		expect(markup).toContain("/clawdi_pair BCDFGHJKLM");
		expect(markup).toContain('aria-live="polite"');
		expect(markup).toContain(">Copy<");
	});

	test("uses one responsive QR treatment", () => {
		const markup = renderToStaticMarkup(
			createElement(PairingQrCode, { value: "https://example.com", label: "Pairing QR code" }),
		);

		expect(markup).toContain('aria-label="Pairing QR code"');
		expect(markup).toContain("data-pairing-qr-container");
		expect(markup).toContain("max-w-44 sm:max-w-48");
		expect(markup).toContain("bg-white");
	});
});
