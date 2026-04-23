import { describe, expect, it } from "bun:test";
import {
	isSubpathSafe,
	sanitizeMetadata,
	sanitizeName,
	sanitizeSubpath,
	stripTerminalEscapes,
} from "../src/lib/sanitize";

describe("stripTerminalEscapes", () => {
	it("strips CSI color codes", () => {
		expect(stripTerminalEscapes("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips CSI cursor movement", () => {
		expect(stripTerminalEscapes("before\x1b[2Kafter")).toBe("beforeafter");
	});

	it("strips OSC sequences (window title)", () => {
		expect(stripTerminalEscapes("\x1b]0;evil\x07hello")).toBe("hello");
		expect(stripTerminalEscapes("\x1b]8;;http://evil.com\x07hi\x1b]8;;\x07")).toBe("hi");
	});

	it("strips DCS/PM/APC sequences", () => {
		expect(stripTerminalEscapes("\x1bPq\x1b\\x")).toBe("x");
	});

	it("strips simple two-byte escapes", () => {
		expect(stripTerminalEscapes("\x1b7save\x1b8restore")).toBe("saverestore");
	});

	it("strips C1 control codes", () => {
		expect(stripTerminalEscapes("a\x9bb")).toBe("ab");
	});

	it("strips raw control chars but preserves tab/newline", () => {
		expect(stripTerminalEscapes("a\x07b")).toBe("ab");
		expect(stripTerminalEscapes("a\tb\nc")).toBe("a\tb\nc");
	});

	it("is idempotent and safe on plain strings", () => {
		expect(stripTerminalEscapes("hello world")).toBe("hello world");
		expect(stripTerminalEscapes("")).toBe("");
	});
});

describe("sanitizeMetadata", () => {
	it("strips escapes and collapses newlines", () => {
		expect(sanitizeMetadata("line1\nline2\r\nline3")).toBe("line1 line2 line3");
	});

	it("trims whitespace", () => {
		expect(sanitizeMetadata("  hello  ")).toBe("hello");
	});

	it("strips ANSI + newlines together", () => {
		expect(sanitizeMetadata("\x1b[31mbad\n\x1b[0mtext  ")).toBe("bad text");
	});
});

describe("sanitizeSubpath", () => {
	it("rejects literal '..' segments", () => {
		expect(() => sanitizeSubpath("foo/../bar")).toThrow();
		expect(() => sanitizeSubpath("..")).toThrow();
		expect(() => sanitizeSubpath("../etc/passwd")).toThrow();
	});

	it("accepts normal subpaths", () => {
		expect(sanitizeSubpath("foo/bar")).toBe("foo/bar");
		expect(sanitizeSubpath("skills/my-skill")).toBe("skills/my-skill");
	});

	it("normalizes Windows backslashes before checking", () => {
		expect(() => sanitizeSubpath("foo\\..\\bar")).toThrow();
	});

	it("does not reject dotfiles that aren't path traversal", () => {
		expect(sanitizeSubpath(".hidden")).toBe(".hidden");
		expect(sanitizeSubpath("a/.b/c")).toBe("a/.b/c");
	});
});

describe("isSubpathSafe", () => {
	it("returns true when subpath resolves inside base", () => {
		expect(isSubpathSafe("/tmp/base", "foo/bar")).toBe(true);
		expect(isSubpathSafe("/tmp/base", ".")).toBe(true);
	});

	it("returns false when subpath escapes base", () => {
		expect(isSubpathSafe("/tmp/base", "../etc")).toBe(false);
		expect(isSubpathSafe("/tmp/base", "../../../etc/passwd")).toBe(false);
	});
});

describe("sanitizeName", () => {
	it("kebab-cases user-supplied names", () => {
		expect(sanitizeName("My Cool Skill")).toBe("my-cool-skill");
		expect(sanitizeName("Hello, World!")).toBe("hello-world");
	});

	it("lowercases", () => {
		expect(sanitizeName("UPPER")).toBe("upper");
	});

	it("strips leading/trailing dots and hyphens", () => {
		expect(sanitizeName("-foo-")).toBe("foo");
		expect(sanitizeName(".hidden.")).toBe("hidden");
	});

	it("preserves dots and underscores in the middle", () => {
		expect(sanitizeName("my_skill.v1")).toBe("my_skill.v1");
	});

	it("falls back to unnamed-skill on empty", () => {
		expect(sanitizeName("")).toBe("unnamed-skill");
		expect(sanitizeName("---")).toBe("unnamed-skill");
		expect(sanitizeName("!@#$")).toBe("unnamed-skill");
	});

	it("caps at 255 chars", () => {
		const long = "a".repeat(300);
		expect(sanitizeName(long)).toHaveLength(255);
	});

	it("prevents path traversal attempts", () => {
		expect(sanitizeName("../etc/passwd")).toBe("etc-passwd");
		expect(sanitizeName("..")).toBe("unnamed-skill");
	});
});
