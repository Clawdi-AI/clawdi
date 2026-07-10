import { describe, expect, test } from "bun:test";
import {
	openRuntimeUiWithRedemption,
	type RuntimeUiPopup,
	type RuntimeUiPopupOpen,
} from "@/hosted/agents/runtime-ui-redemption";

describe("runtime UI redemption open flow", () => {
	test("opens a blank popup synchronously and navigates it to the redemption URL", async () => {
		const popup = popupWindow();
		const opened: string[] = [];
		const result = await openRuntimeUiWithRedemption({
			redeem: async () => ({ url: "https://app-18789.example/control/?clawdi_code=code" }),
			openPopup: (url) => {
				opened.push(url);
				return popup;
			},
		});

		expect(result).toBe("opened_reserved_popup");
		expect(opened).toEqual(["about:blank"]);
		expect(popup.opener).toBeNull();
		expect(popup.location.href).toBe("https://app-18789.example/control/?clawdi_code=code");
	});

	test("falls back to direct open when the reserved popup is blocked", async () => {
		const opened: string[] = [];
		const openPopup: RuntimeUiPopupOpen = (url) => {
			opened.push(url);
			return url === "about:blank" ? null : popupWindow();
		};

		const result = await openRuntimeUiWithRedemption({
			redeem: async () => ({ url: "https://app-9119.example/dashboard?clawdi_code=code" }),
			openPopup,
		});

		expect(result).toBe("opened_direct");
		expect(opened).toEqual(["about:blank", "https://app-9119.example/dashboard?clawdi_code=code"]);
	});

	test("propagates redemption failures without opening a clean native URL", async () => {
		const opened: string[] = [];
		const popup = popupWindow();

		await expect(
			openRuntimeUiWithRedemption({
				redeem: async () => {
					throw new Error("forbidden");
				},
				openPopup: (url) => {
					opened.push(url);
					return popup;
				},
			}),
		).rejects.toThrow("forbidden");
		expect(opened).toEqual(["about:blank"]);
		expect(popup.closed).toBe(true);
	});
});

function popupWindow(): RuntimeUiPopup {
	return {
		opener: {},
		location: { href: "about:blank" },
		closed: false,
		close() {
			this.closed = true;
		},
	};
}
