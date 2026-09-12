import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeRuntimeAppliedState } from "./applied-state";
import { readHostedRuntimeObserved, runtimeComponentIsReady } from "./observed";
import { getRuntimePaths } from "./paths";
import { writeRuntimeWatchStatus } from "./state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

test.skipIf(!process.env.CLAWDI_TEST_HERMES_DASHBOARD_VENV)(
	"native Hermes form-auth preserves UI admission through gateway failure",
	async () => {
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
		const child = Bun.spawn(
			[
				`${saved.CLAWDI_TEST_HERMES_DASHBOARD_VENV}/bin/python`,
				"tests/fixtures/hermes-dashboard-auth.py",
				state,
			],
			{ stdout: "ignore", stderr: "inherit" },
		);
		try {
			let ready = false;
			for (let i = 0; i < 100 && !ready; i++) {
				try {
					ready = (
						await fetch("http://127.0.0.1:9119/api/status", { signal: AbortSignal.timeout(100) })
					).ok;
				} catch {}
				if (!ready) await delay(25);
			}
			expect(ready).toBe(true);
			const redirect = await fetch("http://127.0.0.1:9119/", { redirect: "manual" });
			expect(redirect.status).toBe(302);
			expect(redirect.headers.get("location")).toMatch(/^\/login(?:\?|$)/);
			expect((await fetch("http://127.0.0.1:9119/login")).status).toBe(200);
			const paths = getRuntimePaths({ mode: "hosted" });
			mkdirSync(paths.serviceStateRoot, { recursive: true });
			mkdirSync(paths.systemdUserRoot, { recursive: true });
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
	},
);
