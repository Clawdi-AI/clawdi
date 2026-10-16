import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OFFICIAL_INSTALL_URLS, type RuntimeInstall } from "./manifest-contract";
import { observeRuntimeInstall, runtimeCommandVersion } from "./manifest-install";
import { getRuntimePaths } from "./paths";
import { RuntimeUserCommandTimeoutError } from "./runtime-user-command";

const savedEnv = { ...process.env };
const home = mkdtempSync(join(tmpdir(), "clawdi-hermes-version-test-"));

afterEach(() => {
	process.env = { ...savedEnv };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("official installers default Git stall detection and preserve caller values", () => {
	const installHome = join(home, "installer-env");
	mkdirSync(installHome, { recursive: true });
	const installer = join(installHome, "install.sh");
	writeFileSync(
		installer,
		'printf "limit=%s time=%s\\n" "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME"\nexit 1\n',
	);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(installHome, "state");
	process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
	process.env.CLAWDI_RUNTIME_TEST_HERMES_INSTALLER = installer;
	const paths = getRuntimePaths();
	mkdirSync(paths.serviceStateRoot, { recursive: true, mode: 0o700 });
	const install: RuntimeInstall = {
		authority: "official",
		method: "official-installer",
		url: OFFICIAL_INSTALL_URLS.hermes,
		home: installHome,
		args: [],
	};
	const identity = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
	for (const runtimeUser of ["root", "installer-test"]) {
		process.env.CLAWDI_RUNTIME_USER = runtimeUser;
		for (const values of [undefined, { limit: "2048", time: "120" }]) {
			delete process.env.GIT_HTTP_LOW_SPEED_LIMIT;
			delete process.env.GIT_HTTP_LOW_SPEED_TIME;
			if (values) {
				process.env.GIT_HTTP_LOW_SPEED_LIMIT = values.limit;
				process.env.GIT_HTTP_LOW_SPEED_TIME = values.time;
			}
			const result = observeRuntimeInstall(
				"hermes",
				{ enabled: true, install, services: {} },
				installHome,
				paths,
				identity,
			);
			expect(result.exitCode).toBe(1);
			expect(
				readFileSync(join(paths.statusRoot, "installer-logs", "hermes.log"), "utf8"),
			).toContain(`limit=${values?.limit ?? "102400"} time=${values?.time ?? "60"}\n`);
		}
	}
});

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
