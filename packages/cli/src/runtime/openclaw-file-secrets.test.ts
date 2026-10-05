import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openClawFileSecretEnvironmentKeys,
	projectOpenClawProviderFileSecrets,
} from "./openclaw-file-secrets";
import { openClawConfigCanHotReload } from "./openclaw-warm-gateway";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw file credentials", () => {
	test("writes private credentials and rotates the config path without embedding values", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-file-credentials-"));
		roots.push(home);
		const input = JSON.stringify({
			models: {
				providers: {
					clawdi: { apiKey: { source: "env", provider: "default", id: "CLAWDI_AI_API_KEY" } },
				},
			},
		});
		const first = JSON.parse(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "key-one" }, home),
		);
		const path = first.secrets.providers["clawdi-runtime"].path;
		expect(first.models.providers.clawdi.apiKey).toEqual({
			source: "file",
			provider: "clawdi-runtime",
			id: "/CLAWDI_AI_API_KEY",
		});
		expect(JSON.stringify(first)).not.toContain("key-one");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ CLAWDI_AI_API_KEY: "key-one" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".clawdi", "runtime-credentials")).mode & 0o777).toBe(0o700);
		const same = JSON.parse(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "key-one" }, home),
		);
		expect(same.secrets.providers["clawdi-runtime"].path).toBe(path);
		const next = JSON.parse(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "key-two" }, home),
		);
		expect(next.secrets.providers["clawdi-runtime"].path).not.toBe(path);
		// The old snapshot remains resolvable while a running gateway loads the candidate.
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ CLAWDI_AI_API_KEY: "key-one" });
		mkdirSync(join(home, ".openclaw"));
		writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify(next));
		expect([...openClawFileSecretEnvironmentKeys(home)]).toEqual(["CLAWDI_AI_API_KEY"]);
	});

	test("native reload preferences retain the normal restart boundary", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-reload-preferences-"));
		roots.push(home);
		mkdirSync(join(home, ".openclaw"));
		for (const mode of [undefined, "hybrid", "hot", "off", "restart"]) {
			writeFileSync(
				join(home, ".openclaw", "openclaw.json"),
				JSON.stringify({ gateway: { reload: { mode } } }),
			);
			expect(openClawConfigCanHotReload(home)).toBe(mode === undefined || mode === "hybrid");
		}
	});

	test("does not withdraw unrelated env credentials", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-file-credentials-"));
		roots.push(home);
		const input = JSON.stringify({
			models: {
				providers: { native: { apiKey: { source: "env", provider: "native", id: "USER_KEY" } } },
			},
		});
		expect(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "managed-key" }, home),
		).toBe(input);
		expect([...openClawFileSecretEnvironmentKeys(home)]).toEqual([]);
	});
});
