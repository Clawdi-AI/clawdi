import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCurrentCliInvocation, resolveCurrentCliLayout } from "./current-cli-invocation";

const root = mkdtempSync(join(tmpdir(), "clawdi-invocation-"));
const executable = join(root, "bun");
const entry = join(root, "src", "index.ts");
mkdirSync(join(root, "src"));
writeFileSync(executable, "runtime\n");
writeFileSync(entry, "entry\n");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveCurrentCliInvocation", () => {
	it("keeps the script entrypoint for normal Node or Bun execution", () => {
		const invocation = resolveCurrentCliInvocation(["daemon", "run"], {
			execPath: executable,
			argv: [executable, entry, "daemon", "install"],
			nativeIdentity: null,
		});

		expect(invocation).toEqual({
			command: realpathSync(executable),
			args: [realpathSync(entry), "daemon", "run"],
			entryPath: realpathSync(entry),
		});
	});

	it("does not treat the first CLI argument as an entrypoint for a native executable", () => {
		const invocation = resolveCurrentCliInvocation(["sync", "push"], {
			execPath: executable,
			argv: [executable, "daemon", "run"],
			nativeIdentity: { version: "1.2.3", target: "linux-x64" },
		});

		expect(invocation).toEqual({
			command: realpathSync(executable),
			args: ["sync", "push"],
			entryPath: null,
		});
	});

	it("requires an entrypoint only for script execution", () => {
		expect(() =>
			resolveCurrentCliInvocation([], {
				execPath: executable,
				argv: [executable],
				nativeIdentity: null,
			}),
		).toThrow("process.argv[1]");
		expect(() =>
			resolveCurrentCliInvocation([], {
				execPath: executable,
				argv: [executable],
				nativeIdentity: { version: "1.2.3", target: "linux-x64" },
			}),
		).not.toThrow();
	});

	it("anchors source resources to the CLI package instead of the caller entry", () => {
		const nestedEntry = join(root, "src", "runtime", "manifest.test.ts");
		mkdirSync(join(root, "src", "runtime"), { recursive: true });
		writeFileSync(nestedEntry, "test entry\n");

		const layout = resolveCurrentCliLayout({
			execPath: executable,
			argv: [executable, nestedEntry],
			nativeIdentity: null,
		});
		expect(layout.resourceRoot).toBe(realpathSync(resolve(import.meta.dir, "../..")));
	});
});
