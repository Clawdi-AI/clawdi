import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Only the disposable privileged fixture owns this user and its manager.
test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
	"installs a real systemd user unit without network targets and completes its lifecycle",
	() => {
		const uid = 10001;
		const userHome = "/home/clawdi";
		const unit = "clawdi-serve.service";
		const unitPath = join(userHome, ".config", "systemd", "user", unit);
		expect(existsSync(unitPath)).toBe(false);
		const root = mkdtempSync(join(userHome, "daemon-user-e2e-"));
		chownSync(root, uid, uid);
		const entry = join(root, "clawdi.js");
		writeFileSync(entry, "setInterval(() => {}, 1000);\n", { mode: 0o644 });
		const installer = fileURLToPath(new URL("../../src/serve/installer.ts", import.meta.url));
		const userRun = (args: string[]) =>
			execFileSync(
				"runuser",
				[
					"-u",
					"clawdi",
					"--",
					"env",
					`HOME=${userHome}`,
					`XDG_RUNTIME_DIR=/run/user/${uid}`,
					`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
					`CLAWDI_HOME=${root}/state`,
					"CLAWDI_AUTH_TOKEN=",
					...args,
				],
				{ encoding: "utf8", timeout: 15_000 },
			);
		const installerRun = (action: "install" | "stop" | "restart" | "uninstall") =>
			userRun([
				"bun",
				"-e",
				`import { ${action} } from ${JSON.stringify(installer)}; process.argv[1] = ${JSON.stringify(entry)}; console.log(JSON.stringify(${action}()));`,
			]);
		const property = (name: string) =>
			userRun(["systemctl", "--user", "show", unit, `--property=${name}`, "--value"]).trim();
		try {
			execFileSync("systemctl", ["start", `user@${uid}.service`], { timeout: 15_000 });
			const installed = JSON.parse(installerRun("install"));
			expect(installed.replaced).toBe(false);
			expect(readFileSync(unitPath, "utf8")).not.toContain("network-online.target");
			expect(property("ActiveState")).toBe("active");
			expect(property("Restart")).toBe("always");
			expect(property("RestartUSec")).toBe("10s");
			expect(property("Wants")).not.toContain("network-online.target");
			expect(property("After")).not.toContain("network-online.target");
			const pid = property("MainPID");
			expect(Number(pid)).toBeGreaterThan(0);
			expect(JSON.parse(installerRun("install")).replaced).toBe(true);
			expect(property("MainPID")).not.toBe(pid);
			installerRun("stop");
			expect(property("ActiveState")).toBe("inactive");
			installerRun("restart");
			expect(property("ActiveState")).toBe("active");
			expect(JSON.parse(installerRun("uninstall")).removed).toBe(true);
			expect(JSON.parse(installerRun("uninstall")).removed).toBe(false);
			expect(existsSync(unitPath)).toBe(false);
		} finally {
			try {
				if (existsSync(unitPath)) installerRun("uninstall");
			} finally {
				execFileSync("systemctl", ["stop", `user@${uid}.service`], { timeout: 15_000 });
				rmSync(root, { recursive: true, force: true });
			}
		}
	},
	30_000,
);
