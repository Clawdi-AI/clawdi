import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("generic egress addon interpreter", () => {
	execFileSync(
		"python3",
		[fileURLToPath(new URL("./egress_addon/clawdi_egress_addon_test.py", import.meta.url)), "-v"],
		{ stdio: "inherit", timeout: 15_000 },
	);
});
