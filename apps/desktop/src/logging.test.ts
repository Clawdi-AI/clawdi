import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DesktopFileLog,
	getDesktopLogDirectory,
	initializeDesktopLogging,
	redactDesktopLog,
} from "./logging";

const roots: string[] = [];
let restoreConsole: (() => void) | undefined;
afterEach(() => {
	restoreConsole?.();
	restoreConsole = undefined;
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-logs-"));
	roots.push(root);
	return root;
}

describe("Desktop file logging", () => {
	test("rotates by bytes in order and retains only the configured backups", () => {
		const root = directory();
		const log = new DesktopFileLog(root, { maxBytes: 128, backups: 2 });
		for (const name of ["first", "second", "third", "fourth"])
			log.write("info", `${name} ${"x".repeat(70)}`);
		expect(readdirSync(root).sort()).toEqual(["main.log", "main.log.1", "main.log.2"]);
		expect(readFileSync(log.path, "utf8")).toContain("fourth");
		expect(readFileSync(`${log.path}.1`, "utf8")).toContain("third");
		expect(readFileSync(`${log.path}.2`, "utf8")).toContain("second");
		for (const name of readdirSync(root))
			expect(statSync(join(root, name)).size).toBeLessThanOrEqual(128);
	});

	test("rotates a previous process's file and bounds oversized UTF-8 entries", () => {
		const root = directory();
		writeFileSync(join(root, "main.log"), "previous session\n");
		const log = new DesktopFileLog(root, { maxBytes: 128 });
		log.write("error", "✓".repeat(400));
		expect(readFileSync(`${log.path}.1`, "utf8")).toBe("previous session\n");
		expect(statSync(log.path).size).toBeLessThanOrEqual(128);
		expect(readFileSync(log.path, "utf8")).toContain("[truncated]\n");
	});

	test("redacts credential fields, flags, bearer/JWT/API tokens, URLs and device codes", () => {
		const messages = [
			'{"access_token":"secret-access","refreshToken":"secret-refresh","userCode":"shortcode"}',
			"{ authorization: 'private-header', verificationUri: 'https://example.com/?x=private' }",
			"--token private-flag Bearer private-bearer clawdi_privatekey eyJhbGci.eyJzdWI.signature ABCD-EFGH",
			"https://user:private-password@example.com/path?unknown=private-query",
			"user_code=private-code&device_code=private-device&code=private-oauth",
		];
		for (const message of messages) {
			const redacted = redactDesktopLog(message);
			expect(redacted).not.toMatch(
				/secret-|shortcode|private-|clawdi_privatekey|eyJhbGci|ABCD-EFGH/,
			);
			expect(redactDesktopLog(redacted)).toBe(redacted);
		}
	});

	test("routes all console levels without upstream error messages or causes", () => {
		const root = directory();
		restoreConsole = initializeDesktopLogging(root);
		console.debug("diagnostic");
		console.log("ordinary");
		console.info("structured", { userCode: "private-code", token: "private-token" });
		console.warn("warning");
		console.error(
			"CLI failure",
			new Error("failure\nunlabelled-private-data", { cause: "private-cause" }),
		);
		const content = readFileSync(join(root, "main.log"), "utf8");
		for (const level of ["debug", "log", "info", "warn", "error"])
			expect(content).toContain(`[${level}]`);
		expect(content).not.toMatch(/private-code|private-token|unlabelled-private-data|private-cause/);
	});

	test.each(["initialization", "write"])(
		"%s failure preserves the action and redacted console",
		(failure) => {
			const root = directory();
			if (failure === "initialization") {
				rmSync(root, { recursive: true });
				writeFileSync(root, "not a directory");
			}
			restoreConsole = initializeDesktopLogging(root);
			if (failure === "write") rmSync(root, { recursive: true });
			expect(() => console.error("operation failed", { token: "private-token" })).not.toThrow();
		},
	);

	test("the UI helper uses Electron's logs directory", () => {
		const paths: string[] = [];
		expect(
			getDesktopLogDirectory({
				getPath: (name) => {
					paths.push(name);
					return "logs-directory";
				},
			}),
		).toBe("logs-directory");
		expect(paths).toEqual(["logs"]);
	});
});
