import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCurrentCliInvocation } from "./current-cli-invocation";

const root = mkdtempSync(join(tmpdir(), "clawdi-invocation-"));
const executable = join(root, "bun");
const entry = join(root, "clawdi.mjs");
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
		});

		expect(invocation).toEqual({
			command: realpathSync(executable),
			args: [realpathSync(entry), "daemon", "run"],
			entryPath: realpathSync(entry),
		});
	});

	it("requires a script entrypoint", () => {
		expect(() =>
			resolveCurrentCliInvocation([], {
				execPath: executable,
				argv: [executable],
			}),
		).toThrow("process.argv[1]");
	});
});
