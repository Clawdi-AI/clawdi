import { expect, mock, test } from "bun:test";
import { openDashboardInBrowser } from "./dashboard-browser";

test("opens the hosted dashboard directly in the system browser", async () => {
	const open = mock(async (_url: string) => {});
	await openDashboardInBrowser(open);
	expect(open).toHaveBeenCalledWith("https://cloud.clawdi.ai/");
});

test("uses the configured dashboard and propagates a sanitized browser failure", async () => {
	const open = mock(async (_url: string) => {});
	await openDashboardInBrowser(open, "https://dashboard.example.test/");
	expect(open).toHaveBeenCalledWith("https://dashboard.example.test/");
	await openDashboardInBrowser(open, "http://127.0.0.1:3000/");
	expect(open).toHaveBeenCalledWith("http://127.0.0.1:3000/");
	await expect(
		openDashboardInBrowser(async () => {
			throw new Error("internal failure");
		}),
	).rejects.toThrow("Could not open the system browser");
});

test.each([
	"invalid",
	"javascript:alert(1)",
	"http://remote.test",
	"https://user:password@dashboard.test",
	"https://dashboard.test/#secret",
	"https://dashboard.test/?token=secret",
])("rejects unsafe dashboard configuration: %s", async (url) => {
	const open = mock(async (_url: string) => {});
	await expect(openDashboardInBrowser(open, url)).rejects.toThrow("dashboard URL");
	expect(open).not.toHaveBeenCalled();
});
