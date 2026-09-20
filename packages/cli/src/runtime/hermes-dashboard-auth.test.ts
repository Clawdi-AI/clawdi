import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeRuntimeAppliedState } from "./applied-state";
import { readHostedRuntimeObserved, runtimeComponentIsReady } from "./observed";
import { getRuntimePaths } from "./paths";
import { writeRuntimeWatchStatus } from "./state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

test.skipIf(
	!process.env.CLAWDI_TEST_HERMES_DASHBOARD_VENV && process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1",
)("native Hermes form-auth preserves UI admission through gateway failure", async () => {
	const saved = { ...process.env };
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-dashboard-"));
	const state = join(root, "status.json");
	writeFileSync(state, JSON.stringify({ gateway: true }));
	const identity = userInfo();
	Object.assign(process.env, {
		HOME: root,
		HERMES_HOME: root,
		CLAWDI_RUNTIME_HOME: root,
		CLAWDI_SERVICE_STATE_DIR: join(root, "state"),
		CLAWDI_SYSTEMD_SYSTEM_ROOT: join(root, "system"),
		CLAWDI_RUNTIME_USER: identity.username,
		CLAWDI_RUNTIME_UID: String(identity.uid),
		CLAWDI_RUNTIME_GID: String(identity.gid),
	});
	const stderrPath = join(root, "dashboard.stderr.log");
	const startedAt = performance.now();
	const child = Bun.spawn(
		[
			`${saved.CLAWDI_TEST_HERMES_DASHBOARD_VENV}/bin/python`,
			fileURLToPath(new URL("../../tests/fixtures/hermes-dashboard-auth.py", import.meta.url)),
			state,
		],
		{ stdout: "ignore", stderr: Bun.file(stderrPath) },
	);
	try {
		let ready = false;
		let lastProbe = "not attempted";
		for (let i = 0; i < 100 && !ready; i++) {
			try {
				const response = await fetch("http://127.0.0.1:9119/api/status", {
					signal: AbortSignal.timeout(100),
				});
				lastProbe = `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`;
				ready = response.ok;
			} catch (error) {
				lastProbe = String(error);
			}
			if (!ready) await delay(25);
		}
		console.error(
			JSON.stringify({
				fixture: "Hermes dashboard startup",
				ready,
				elapsedMs: Math.round(performance.now() - startedAt),
				exitCode: child.exitCode,
				lastProbe,
				stderr: readFileSync(stderrPath, "utf8").slice(-8000),
			}),
		);
		expect(ready).toBe(true);
		const redirect = await fetch("http://127.0.0.1:9119/", { redirect: "manual" });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("location")).toMatch(/^\/login(?:\?|$)/);
		const login = await fetch("http://127.0.0.1:9119/login");
		expect(login.status).toBe(200);
		expect(login.headers.get("cache-control")).toContain("no-store");
		expect(await login.text()).toContain("/auth/password-login");
		expect(await (await fetch("http://127.0.0.1:9119/api/auth/providers")).json()).toMatchObject({
			providers: [{ name: "basic", supports_password: true }],
		});
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		mkdirSync(join(paths.userHome, ".hermes"), { recursive: true });
		writeFileSync(
			join(paths.userHome, ".hermes", "config.yaml"),
			"dashboard:\n  basic_auth:\n    username: admin\n",
		);
		writeFileSync(
			join(paths.systemdUserRoot, "clawdi-hermes-dashboard.service"),
			GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
		);
		const systemctl = join(root, "systemctl");
		writeFileSync(systemctl, "#!/bin/sh\nprintf 'ActiveState=active\\nSubState=running\\n'\n", {
			mode: 0o700,
		});
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: new Date().toISOString(),
				instanceId: "fixture",
				etag: '"fixture"',
				sourceRevision: "a".repeat(64),
				generation: 1,
				contentIdentity: { sourcePath: "fixture", sha256: "b".repeat(64) },
				activated: {},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		writeRuntimeWatchStatus({ status: "not_modified" }, paths);
		expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(true);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
		writeFileSync(state, JSON.stringify({ gateway: false }));
		expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(true);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		process.env = saved;
		rmSync(root, { recursive: true, force: true });
	}
});
