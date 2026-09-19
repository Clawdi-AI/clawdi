import { expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateAppImageRuntime, pruneAppImageRuntimes } from "./appimage-runtime";
import { runCommand } from "./command-runner";

test("AppImage runtime survives unmount and activates the next immutable version", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-appimage-"));
	const source = join(root, "mount", "native");
	try {
		for (const resource of [
			"clawdi",
			"skills/clawdi/SKILL.md",
			"skills/hosted-versions/1/clawdi/SKILL.md",
			"egress-addon/clawdi_egress_addon.py",
		]) {
			mkdirSync(dirname(join(source, resource)), { recursive: true });
			writeFileSync(join(source, resource), "v1", { mode: resource === "clawdi" ? 0o755 : 0o644 });
		}
		const first = activateAppImageRuntime(source, join(root, "data"), "1.0.0");
		writeFileSync(join(source, "clawdi"), "v2");
		const second = activateAppImageRuntime(source, join(root, "data"), "1.0.1");
		rmSync(join(root, "mount"), { recursive: true });
		expect(readFileSync(join(first, "clawdi"), "utf8")).toBe("v1");
		expect(readFileSync(join(second, "clawdi"), "utf8")).toBe("v2");
		expect(activateAppImageRuntime(source, join(root, "data"), "1.0.1")).toBe(second);
		expect(existsSync(join(second, "skills/clawdi/SKILL.md"))).toBe(true);
		pruneAppImageRuntimes(join(root, "data"), "1.0.1", new Set(["1.0.0"]));
		expect(existsSync(first)).toBe(true);
		pruneAppImageRuntimes(join(root, "data"), "1.0.1");
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(true);
		expect(() => activateAppImageRuntime(source, join(root, "data"), "..")).toThrow();
		if (process.platform === "linux") {
			chmodSync(join(second, "clawdi"), 0o600);
			expect(() => activateAppImageRuntime(source, join(root, "data"), "1.0.1")).toThrow(
				"not executable",
			);
			chmodSync(join(second, "clawdi"), 0o755);
		}
		rmSync(join(second, "skills/hosted-versions/1/clawdi/SKILL.md"));
		expect(() => activateAppImageRuntime(source, join(root, "data"), "1.0.1")).toThrow(
			"incomplete",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "linux")(
	"concurrent runtime activation reuses a complete target",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-appimage-race-"));
		const source = join(root, "source");
		try {
			for (const resource of [
				"clawdi",
				"skills/clawdi/SKILL.md",
				"skills/hosted-versions/1/clawdi/SKILL.md",
				"egress-addon/clawdi_egress_addon.py",
			]) {
				mkdirSync(dirname(join(source, resource)), { recursive: true });
				writeFileSync(
					join(source, resource),
					resource === "clawdi" ? Buffer.alloc(16 * 1024 * 1024) : "fixture",
					{ mode: 0o755 },
				);
			}
			const script = `import {activateAppImageRuntime} from ${JSON.stringify(join(import.meta.dir, "appimage-runtime.ts"))}; console.log(activateAppImageRuntime(${JSON.stringify(source)}, ${JSON.stringify(join(root, "data"))}, "1.0.0"));`;
			const results = await Promise.allSettled([
				runCommand(process.execPath, ["-e", script]),
				runCommand(process.execPath, ["-e", script]),
			]);
			for (const result of results) if (result.status === "rejected") throw result.reason;
			const paths = results.map((result) =>
				result.status === "fulfilled" ? result.value.stdout : null,
			);
			expect(paths[0]).toBe(paths[1]);
			expect(readdirSync(join(root, "data/runtimes"))).toEqual(["1.0.0"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

const nativeBinary = process.env.CLAWDI_NATIVE_BINARY;
test.skipIf(process.platform !== "linux" || !nativeBinary)(
	"native AppImage CLI installs a durable unit after its mount disappears",
	async () => {
		if (!nativeBinary) throw new Error("Native binary is required.");
		const root = mkdtempSync(join(tmpdir(), "clawdi-appimage-unit-"));
		try {
			const mount = join(root, "mount");
			cpSync(dirname(nativeBinary), mount, { recursive: true });
			const runtime = activateAppImageRuntime(mount, join(root, "data"), "1.0.0");
			rmSync(mount, { recursive: true });
			const home = join(root, "home");
			const state = join(root, "state");
			const bin = join(root, "bin");
			mkdirSync(bin);
			mkdirSync(home);
			mkdirSync(join(state, "environments"), { recursive: true });
			writeFileSync(
				join(state, "environments/codex.json"),
				JSON.stringify({ id: "appimage-fixture", agentType: "codex" }),
			);
			// This checks the generated unit contract, not systemd execution.
			writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const env = {
				...process.env,
				HOME: home,
				CLAWDI_HOME: state,
				CLAWDI_DESKTOP_RUNTIME: runtime,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
				CLAWDI_API_URL: "http://127.0.0.1:1",
				CLAWDI_AUTH_TOKEN: "appimage-fixture",
				CLAWDI_AUTH_TOKEN_ORIGIN: "http://127.0.0.1:1",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			};
			const cli = join(runtime, "clawdi");
			await runCommand(cli, ["daemon", "install"], { env });
			const unit = readFileSync(join(home, ".config/systemd/user/clawdi-serve.service"), "utf8");
			expect(unit).toContain(`ExecStart=${cli} daemon run`);
			expect(unit).not.toContain(mount);
			expect((await runCommand(cli, ["update", "--native-identity"], { env })).stdout).toContain(
				`linux-${process.arch}`,
			);
			await runCommand(cli, ["daemon", "uninstall"], { env });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
