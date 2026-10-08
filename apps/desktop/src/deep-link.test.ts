import { expect, test } from "bun:test";
import { connectViewFromArgv, connectViewFromDeepLink } from "./deep-link";

test.each(["clawdi-desktop://connect", "clawdi-desktop://connect/", "CLAWDI-DESKTOP://connect"])(
	"opens Connect for %s",
	(url) => {
		expect(connectViewFromDeepLink(url)).toBe("connect");
	},
);

test.each([
	"",
	"connect",
	"clawdi-desktop:connect",
	"clawdi-desktop:///connect",
	"clawdi-desktop://Connect",
	"clawdi-desktop://fix-sync",
	"clawdi-desktop://exclude-projects",
	"clawdi-desktop://connect/extra",
	"clawdi-desktop://connect?agent=codex",
	"clawdi-desktop://connect#fix-sync",
	"clawdi-desktop://user@connect",
	"clawdi-desktop://connect:8080",
	"clawdi-app://connect/renderer.html",
	"clawdi://connect",
	"https://connect",
])("ignores %s", (url) => {
	expect(connectViewFromDeepLink(url)).toBeNull();
});

test("reads the link from a launch command line", () => {
	expect(connectViewFromArgv(["/opt/Clawdi/clawdi-desktop", "clawdi-desktop://connect"])).toBe(
		"connect",
	);
	// Development launches and Chromium switches precede the URL.
	expect(
		connectViewFromArgv([
			"electron",
			"/repo/apps/desktop",
			"--allow-file-access-from-files",
			"clawdi-desktop://connect/",
		]),
	).toBe("connect");
});

test("ignores command lines without an accepted link", () => {
	expect(connectViewFromArgv([])).toBeNull();
	expect(connectViewFromArgv(["clawdi-desktop", "--hidden"])).toBeNull();
	expect(connectViewFromArgv(["clawdi-desktop", "clawdi-desktop://connect?x=1"])).toBeNull();
	// The OS passes one URL last; an earlier valid link cannot override it.
	expect(
		connectViewFromArgv(["clawdi-desktop", "clawdi-desktop://connect", "clawdi-desktop://other"]),
	).toBeNull();
});
