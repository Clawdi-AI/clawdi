import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimePaths } from "./paths";
import { readProviderOwnership, writeProviderOwnership } from "./provider-ownership";

test("failed authority preserves pending catalog ownership, but never reclaims transferred models", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-provider-ownership-"));
	const paths = { ...getRuntimePaths(), serviceStateRoot: root };
	try {
		const ownership = readProviderOwnership(paths, "instance", "/home/agent", {});
		ownership.providers = { openclaw: ["custom-provider"], hermes: ["custom-provider"] };
		writeProviderOwnership(paths, "instance", "/home/agent", ownership);
		// Config committed, but authority did not: the next process still owns cleanup.
		const retry = readProviderOwnership(paths, "instance", "/home/agent", {});
		expect(retry.providers).toEqual(ownership.providers);
		for (const runtime of ["openclaw", "hermes"]) {
			retry.transfers[runtime] = {
				"custom-provider": {
					envName: "CUSTOM_API_KEY",
					baseUrl: "https://provider.example/v1",
					apiMode: "openai_chat",
				},
			};
		}
		writeProviderOwnership(paths, "instance", "/home/agent", retry);
		// An old applied state must not restore whole-row ownership after handoff.
		const unbound = readProviderOwnership(paths, "instance", "/home/agent", ownership.providers);
		expect(unbound.providers).toEqual({ openclaw: [], hermes: [] });
		writeProviderOwnership(paths, "instance", "/home/agent", unbound);
		expect(readProviderOwnership(paths, "instance", "/home/agent", {}).transfers).toEqual(
			retry.transfers,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("foreign or damaged ownership evidence cannot authorize config deletion", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-provider-ownership-"));
	const paths = { ...getRuntimePaths(), serviceStateRoot: root };
	try {
		const ownership = readProviderOwnership(paths, "instance", "/home/agent", {});
		writeProviderOwnership(paths, "instance", "/home/agent", ownership);
		expect(() => readProviderOwnership(paths, "other", "/home/agent", {})).toThrow(
			"another runtime",
		);
		expect(() => readProviderOwnership(paths, "instance", "/home/other", {})).toThrow(
			"another runtime",
		);
		writeFileSync(join(root, "provider-ownership.json"), "{broken");
		expect(() => readProviderOwnership(paths, "instance", "/home/agent", {})).toThrow(
			"journal is invalid",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
