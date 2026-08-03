import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import process from "node:process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WhatsAppOnboardingSession } from "./channel-types";

process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
const { WhatsAppSessionState } = await import("./whatsapp-device-onboarding");

const source = readFileSync(new URL("./whatsapp-device-onboarding.tsx", import.meta.url), "utf8");
const connectDialog = readFileSync(new URL("./connect-bot-dialog.tsx", import.meta.url), "utf8");

function session(overrides: Partial<WhatsAppOnboardingSession> = {}): WhatsAppOnboardingSession {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		channel_account_id: null,
		name: "A very long WhatsApp account name that must wrap safely on a narrow viewport",
		state: "ready",
		method: "qr",
		qr: "test-device-qr",
		qr_expires_at: "2026-08-02T12:00:20Z",
		pairing_code: null,
		manual_pairing_code_supported: true,
		started_at: "2026-08-02T12:00:00Z",
		expires_at: "2026-08-02T12:05:00Z",
		completed_at: null,
		...overrides,
	};
}

function render(state: WhatsAppOnboardingSession): string {
	return renderToStaticMarkup(
		createElement(WhatsAppSessionState, {
			session: state,
			nowMs: Date.parse("2026-08-02T12:00:00Z"),
			phoneNumber: "",
			onPhoneNumberChange: () => undefined,
			onRequestPairingCode: () => undefined,
			pairingCodePending: false,
		}),
	);
}

describe("WhatsApp linked-device onboarding", () => {
	test("keeps Custom WhatsApp setup flat and separate from Clawdi-managed bots", () => {
		expect(source).toContain('data-hosted="true"');
		expect(source).toContain('data-v2="true"');
		expect(source).toContain("Your WhatsApp");
		expect(source).not.toContain("Clawdi WhatsApp");
		expect(source).not.toContain("WhatsAppOptionCard");
		expect(source).not.toContain("sm:grid-cols-2");
		expect(source).toContain("This adds the account under Custom bots");
		expect(source).toContain("linked-device QR");
		expect(source).toMatch(/<Alert\s+data-whatsapp-account-warning/);
		const warningMarkerIndex = source.indexOf("data-whatsapp-account-warning");
		expect(warningMarkerIndex).toBeLessThan(source.indexOf("Connect your account"));
		expect(connectDialog).toContain("<WhatsAppDeviceOnboarding");
		expect(connectDialog).toContain("whitespace-normal break-words");
		expect(connectDialog).not.toContain("min-w-0 truncate text-left");
		expect(connectDialog).not.toContain("phone-number ID");
		expect(connectDialog).not.toContain("Graph API");
	});

	test("renders QR instructions, rotation, mobile warning, and secondary code fallback", () => {
		const markup = render(session());
		expect(markup).toContain('aria-label="WhatsApp linked-device QR code"');
		expect(markup).toContain(
			"WhatsApp &gt; Settings/Menu &gt; Linked devices &gt; Link a device &gt; scan.",
		);
		expect(markup).toContain("QR refreshes in 20s");
		expect(markup).toContain("sm:hidden");
		expect(markup).toContain("cannot scan a QR shown on the same phone");
		expect(markup).toContain("Can&#x27;t scan? Use a pairing code");
		expect(markup).toContain("digits only");
	});

	test("does not finish at scanned and gives explicit connected next steps", () => {
		const scanned = render(session({ state: "scanned", qr: null, qr_expires_at: null }));
		expect(scanned).toContain("Device approved");
		expect(scanned).toContain("Finishing the encrypted WhatsApp connection");
		expect(scanned).not.toContain("WhatsApp account connected");

		const connected = render(
			session({
				state: "connected",
				channel_account_id: "00000000-0000-4000-8000-000000000002",
				qr: null,
				qr_expires_at: null,
				completed_at: "2026-08-02T12:00:15Z",
			}),
		);
		expect(connected).toContain("WhatsApp account connected");
		expect(connected).toContain("is not ready on an Agent");
		expect(connected).toContain("under Custom bots");
		expect(connected).toContain("Agent Link and chat Pair remain gated");
	});

	test("renders a directly copyable manual code and terminal recovery states", () => {
		const code = render(
			session({
				method: "code",
				qr: null,
				qr_expires_at: null,
				pairing_code: "1234-5678",
			}),
		);
		expect(code).toContain('aria-label="Copy WhatsApp pairing code"');
		expect(code).toContain("1234-5678");
		expect(code).toContain("phone number you entered");
		expect(render(session({ state: "expired" }))).toContain("Connection expired");
		expect(render(session({ state: "error" }))).toContain("Couldn&#x27;t connect WhatsApp");
		expect(render(session({ state: "canceled" }))).toContain("Connection canceled");
	});
});
