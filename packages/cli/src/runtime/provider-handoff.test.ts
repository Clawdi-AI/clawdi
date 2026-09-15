import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConnectionProviderEnvironments } from "./connection-provider-config";
import { hostedProviderEnvironment } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { getRuntimePaths } from "./paths";
import { applyProviderIdentityHandoff } from "./provider-handoff";
import { writeProviderOwnership } from "./provider-ownership";

const identity = { uid: process.geteuid?.() ?? -1, gid: process.getegid?.() ?? -1 };
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
for (const runtime of ["hermes", "openclaw"] as const) {
	test.each([
		"complete",
		"new-entry",
		"stale-journal",
		"stale-config",
		"stale-env",
		"wrong-incarnation",
		"no-intent",
		"native-parent-symlink",
		"journal-parent-symlink",
		"unsafe-env-mode",
	])(`explicit ${runtime} handoff: %s`, (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "provider-handoff-"));
		const paths = {
			...getRuntimePaths({ mode: "local" }),
			userHome: root,
			serviceStateRoot: join(root, "state"),
		};
		try {
			mkdirSync(join(root, `.${runtime}`), { recursive: true });
			mkdirSync(paths.serviceStateRoot);
			const configPath = join(
				root,
				`.${runtime}`,
				runtime === "hermes" ? "config.yaml" : "openclaw.json",
			);
			const envPath = join(root, `.${runtime}`, ".env");
			const journalPath = join(paths.serviceStateRoot, "provider-ownership.json");
			const appliedPath = join(paths.serviceStateRoot, "applied-proof");
			writeFileSync(appliedPath, "last-good-proof");
			writeFileSync(
				configPath,
				JSON.stringify(
					runtime === "hermes"
						? { providers: { work: { key_env: "NATIVE_KEY" } } }
						: {
								models: {
									providers: {
										work: { apiKey: { source: "env", provider: "default", id: "NATIVE_KEY" } },
									},
								},
							},
				),
			);
			writeFileSync(envPath, "NATIVE_KEY=existing-user-key\nUNRELATED=preserve\n", { mode: 0o600 });
			const cloudIdentity = { providerUuid: randomUUID(), incarnationId: randomUUID() };
			const transfer = {
				envName: "OLD_KEY",
				baseUrl: "https://provider.example/v1",
				apiMode: "openai_chat" as const,
				...(scenario === "wrong-incarnation"
					? { cloudIdentity: { ...cloudIdentity, incarnationId: randomUUID() } }
					: {}),
			};
			writeProviderOwnership(paths, "instance", root, {
				providers: { hermes: [], openclaw: [] },
				transfers: {
					hermes: {},
					openclaw: {},
					[runtime]: scenario === "new-entry" ? {} : { work: transfer },
				},
			});
			const handoffId = randomUUID();
			const manifest: RuntimeManifest = {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep",
				environmentId: "agent",
				instanceId: "instance",
				generation: 1,
				issuedAt: "2026-09-15T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud.example" },
				recovery: {},
				runtimes: {},
				providerHandoffs: [
					{
						handoffId,
						baseUrl: "https://provider.example/v1",
						apiMode: "openai_chat",
						providerId: "work",
						cloudIdentity,
						runtime,
						envName: "NATIVE_KEY",
						owned: true,
						expectedJournalSha256: digest(journalPath),
						expectedConfigSha256: digest(configPath),
						expectedEnvSha256: digest(envPath),
						journalEnvName: scenario === "new-entry" ? null : "OLD_KEY",
					},
				],
			};
			if (scenario === "stale-config") writeFileSync(configPath, "{}");
			if (scenario === "stale-env") writeFileSync(envPath, "NATIVE_KEY=newer-user-key\n");
			if (scenario === "stale-journal")
				writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}\n`);
			if (scenario === "no-intent") manifest.providerHandoffs = [];
			if (scenario === "unsafe-env-mode") chmodSync(envPath, 0o644);
			if (scenario === "native-parent-symlink" || scenario === "journal-parent-symlink") {
				const parent =
					scenario === "native-parent-symlink" ? join(root, `.${runtime}`) : paths.serviceStateRoot;
				renameSync(parent, `${parent}.actual`);
				symlinkSync(`${parent}.actual`, parent);
			}
			const before = {
				config: readFileSync(configPath),
				env: readFileSync(envPath),
				journal: readFileSync(journalPath),
			};
			if (scenario === "complete" || scenario === "new-entry") {
				expect(applyProviderIdentityHandoff(paths, manifest, handoffId, identity)).toBe("applied");
				const acknowledged = readFileSync(journalPath);
				expect(applyProviderIdentityHandoff(paths, manifest, handoffId, identity)).toBe(
					"already_applied",
				);
				expect(readFileSync(journalPath)).toEqual(acknowledged);
			} else {
				expect(() => applyProviderIdentityHandoff(paths, manifest, handoffId, identity)).toThrow();
				expect(readFileSync(journalPath)).toEqual(before.journal);
			}
			expect(readFileSync(configPath)).toEqual(before.config);
			expect(readFileSync(envPath)).toEqual(before.env);
			expect(readFileSync(appliedPath, "utf8")).toBe("last-good-proof");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("new Cloud incarnation cannot silently inherit a legacy journal by provider name", () => {
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep",
		environmentId: "agent",
		instanceId: "instance",
		generation: 1,
		issuedAt: "2026-09-15T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud.example" },
		recovery: {},
		runtimes: {
			hermes: { enabled: true, providerMode: "configured", provider_ids: ["work"], services: {} },
		},
		projection: {
			providers: {
				work: {
					kind: "openai-compatible",
					configurationMode: "custom",
					type: "custom_openai_compatible",
					managed_by: "user",
					baseUrl: "https://provider.example",
					apiMode: "openai_chat",
					runtimeEnvName: "OLD_KEY",
					apiKeySecretRef: "secret://provider.work.apiKey",
					cloudIdentity: { providerUuid: randomUUID(), incarnationId: randomUUID() },
				},
			},
		},
	};
	expect(() =>
		validateConnectionProviderEnvironments(manifest, "hermes", {
			work: { envName: "OLD_KEY", baseUrl: "https://provider.example", apiMode: "openai_chat" },
		}),
	).toThrow("explicit operator handoff");
	const provider = manifest.projection?.providers?.work;
	if (!provider?.cloudIdentity) throw new Error("Missing test provider");
	provider.credentialAuthority = "native";
	expect(hostedProviderEnvironment(manifest, "hermes").secretEnv).toEqual({});
	expect(() => validateConnectionProviderEnvironments(manifest, "hermes", {})).toThrow(
		"acknowledged identity handoff",
	);
});
