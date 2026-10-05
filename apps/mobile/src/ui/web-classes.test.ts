import { expect, test } from "bun:test";
import { possibleNativeClasses, resolveWebClasses } from "./web-classes";

test("native borders inherit Web's global theme color", () => {
	expect(resolveWebClasses("border-y bg-card").view).toContain("border-border");
	expect(resolveWebClasses("p-4").view).not.toContain("border-border");
	expect(possibleNativeClasses("border-y")).toContain("border-border");
});

test("explicit and state border colors override the Web base", () => {
	const explicit = resolveWebClasses("border border-primary").view;
	expect(explicit).toContain("border-primary");
	expect(explicit).not.toContain("border-border");
	const conditional = resolveWebClasses("border hover:border-primary").view;
	expect(conditional).toContain("border-border");
	expect(conditional).toContain("active:border-primary");
});

test("ring-0 preserves an explicit card border", () => {
	const classes = resolveWebClasses("border border-foreground/10 ring-0").view;
	expect(classes).toContain("border");
	expect(classes).not.toContain("border-0");
});

test("Web viewport translations do not offset native modal centering", () => {
	const result = resolveWebClasses(
		"-translate-x-1/2 -translate-y-1/2 translate-x-2 -mx-4 p-6",
	).view;
	expect(result).not.toContain("translate");
	expect(result).toContain("-mx-4");
	expect(result).toContain("p-6");
});
