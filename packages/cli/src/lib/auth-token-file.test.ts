import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthTokenFile } from "./auth-token-file";

describe("auth token files", () => {
	it("rejects group/world-readable files", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-auth-token-"));
		const path = join(root, "token");
		writeFileSync(path, "secret\n", { mode: 0o640 });
		chmodSync(path, 0o640);
		expect(() => loadAuthTokenFile(path)).toThrow("readable only by its owner");
	});
});
