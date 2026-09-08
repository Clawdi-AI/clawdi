import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Use the pinned, unmodified native modules provisioned by the Docker test runner. */
export function installHermesNativeFixture(home: string): void {
	const venv = process.env.CLAWDI_TEST_HERMES_VENV;
	if (!venv) throw new Error("Run Hermes native tests through the Docker CLI test runner");
	const appRoot = join(home, ".hermes", "hermes-agent");
	mkdirSync(appRoot, { recursive: true });
	symlinkSync(venv, join(appRoot, "venv"));
}
