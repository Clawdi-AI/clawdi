import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeCommandVersion } from "./manifest-install";
import { RuntimeUserCommandTimeoutError } from "./runtime-user-command";

const savedEnv = { ...process.env };
const home = mkdtempSync(join(tmpdir(), "clawdi-hermes-version-test-"));

afterEach(() => {
	process.env = { ...savedEnv };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("Hermes version honors the runtime install timeout", () => {
	process.env.CLAWDI_RUNTIME_INSTALL_TIMEOUT = "200";
	const command = join(home, ".local", "bin", "hermes");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(command, "#!/bin/sh\nexec sleep 2\n", { mode: 0o755 });
	try {
		runtimeCommandVersion(command, home, home);
		throw new Error("Expected Hermes version to time out");
	} catch (error) {
		expect(error).toBeInstanceOf(RuntimeUserCommandTimeoutError);
		expect(error).toHaveProperty(
			"message",
			`runtime --version probe for ${command} timed out after 200ms`,
		);
	}
});
