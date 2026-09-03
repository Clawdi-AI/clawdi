import { describe, expect, test } from "bun:test";
import {
	allowsChildClipboard,
	allowsChildDownload,
	dashboardChildUrl,
	evaluateChildNavigation,
	strictHttpsUrl,
} from "./child-window-policy";

const FILES = { kind: "files", origin: "https://files.example.test" } as const;

describe("Dashboard child policy", () => {
	test("accepts only strict direct HTTPS targets", () => {
		expect(strictHttpsUrl("https://runtime.example.test/console")?.origin).toBe(
			"https://runtime.example.test",
		);
		for (const invalid of [
			"about:blank",
			"http://runtime.example.test",
			"https://user:password@runtime.example.test",
			"javascript:alert(1)",
		]) {
			expect(strictHttpsUrl(invalid)).toBeNull();
		}
	});

	test("keeps each typed IPC on its intended URL surface", () => {
		const dashboardOrigin = "https://cloud.clawdi.ai";
		expect(dashboardChildUrl("https://files.example.test/", "files", dashboardOrigin)?.href).toBe(
			"https://files.example.test/",
		);
		for (const invalid of [
			"https://files.example.test/path",
			"https://files.example.test/?download=1",
			"https://files.example.test/#fragment",
		]) {
			expect(dashboardChildUrl(invalid, "files", dashboardOrigin)).toBeNull();
		}
		expect(
			dashboardChildUrl(`${dashboardOrigin}/terminal/agent%201`, "terminal", dashboardOrigin)?.href,
		).toBe(`${dashboardOrigin}/terminal/agent%201`);
		for (const invalid of [
			`${dashboardOrigin}/settings`,
			`${dashboardOrigin}/terminal/one/two`,
			`${dashboardOrigin}/terminal/one?mode=raw`,
			`${dashboardOrigin}/terminal/one#token`,
			`${dashboardOrigin}/terminal/one%2Ftwo`,
			"https://other.example/terminal/one",
		]) {
			expect(dashboardChildUrl(invalid, "terminal", dashboardOrigin)).toBeNull();
		}
		expect(
			dashboardChildUrl(
				"https://runtime.example/ui/path?mode=1#bootstrapToken=secret",
				"runtime",
				dashboardOrigin,
			)?.href,
		).toBe("https://runtime.example/ui/path?mode=1#bootstrapToken=secret");
		expect(
			dashboardChildUrl(`https://runtime.example/${"x".repeat(8193)}`, "runtime", dashboardOrigin),
		).toBeNull();
	});

	test("pins navigation and capabilities to the validated child origin and type", () => {
		expect(evaluateChildNavigation("https://files.example.test/path", FILES)).toEqual({
			action: "allow",
		});
		expect(evaluateChildNavigation("https://docs.example.test/help", FILES)).toEqual({
			action: "external",
		});
		expect(evaluateChildNavigation("about:blank", FILES)).toEqual({ action: "deny" });
		expect(
			allowsChildClipboard(
				FILES,
				"https://files.example.test/a",
				"https://files.example.test/b",
				"https://files.example.test/c",
			),
		).toBe(true);
		expect(
			allowsChildClipboard(
				FILES,
				"https://files.example.test/a",
				"https://cloud.clawdi.ai",
				"https://cloud.clawdi.ai",
			),
		).toBe(false);
		expect(
			allowsChildDownload(
				FILES,
				"https://files.example.test/a",
				"https://files.example.test/archive.zip",
			),
		).toBe(true);
		expect(
			allowsChildDownload(
				{ kind: "terminal", origin: FILES.origin },
				"https://files.example.test/a",
				"https://files.example.test/archive.zip",
			),
		).toBe(false);
		expect(
			allowsChildDownload(
				FILES,
				"https://files.example.test/a",
				"https://other.example/archive.zip",
			),
		).toBe(false);
	});
});
