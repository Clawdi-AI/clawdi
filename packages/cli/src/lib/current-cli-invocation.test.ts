import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	detectDesktopManagedNativeLayout,
	detectHomebrewManagedNativeLayout,
	isMacApplicationBundleExecutable,
	resolveCurrentCliInvocation,
	resolveCurrentCliLayout,
} from "./current-cli-invocation";

const root = mkdtempSync(join(tmpdir(), "clawdi-invocation-"));
const executable = join(root, "bun");
const entry = join(root, "src", "index.ts");
mkdirSync(join(root, "src"));
writeFileSync(executable, "runtime\n");
writeFileSync(entry, "entry\n");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveCurrentCliInvocation", () => {
	it("keeps the script entrypoint for normal Node or Bun execution", () => {
		const invocation = resolveCurrentCliInvocation(["daemon", "run"], {
			execPath: executable,
			argv: [executable, entry, "daemon", "install"],
			nativeIdentity: null,
		});

		expect(invocation).toEqual({
			command: realpathSync(executable),
			args: [realpathSync(entry), "daemon", "run"],
			entryPath: realpathSync(entry),
		});
	});

	it("does not treat the first CLI argument as an entrypoint for a native executable", () => {
		const invocation = resolveCurrentCliInvocation(["sync", "push"], {
			execPath: executable,
			argv: [executable, "daemon", "run"],
			nativeIdentity: { version: "1.2.3", target: "linux-x64" },
		});

		expect(invocation).toEqual({
			command: realpathSync(executable),
			args: ["sync", "push"],
			entryPath: null,
		});
	});

	it("requires an entrypoint only for script execution", () => {
		expect(() =>
			resolveCurrentCliInvocation([], {
				execPath: executable,
				argv: [executable],
				nativeIdentity: null,
			}),
		).toThrow("process.argv[1]");
		expect(() =>
			resolveCurrentCliInvocation([], {
				execPath: executable,
				argv: [executable],
				nativeIdentity: { version: "1.2.3", target: "linux-x64" },
			}),
		).not.toThrow();
	});

	it("anchors source resources to the CLI package instead of the caller entry", () => {
		const nestedEntry = join(root, "src", "runtime", "manifest.test.ts");
		mkdirSync(join(root, "src", "runtime"), { recursive: true });
		writeFileSync(nestedEntry, "test entry\n");

		const layout = resolveCurrentCliLayout({
			execPath: executable,
			argv: [executable, nestedEntry],
			nativeIdentity: null,
		});
		expect(layout.resourceRoot).toBe(realpathSync(resolve(import.meta.dir, "../..")));
	});

	it("recognizes only the native CLI location owned by a macOS application bundle", () => {
		expect(
			isMacApplicationBundleExecutable("/Applications/Clawdi.app/Contents/Resources/native/clawdi"),
		).toBe(true);
		expect(isMacApplicationBundleExecutable("/Applications/Clawdi.app/Contents/MacOS/clawdi")).toBe(
			false,
		);
		expect(isMacApplicationBundleExecutable("/tmp/native/clawdi")).toBe(false);
	});

	it("recognizes Desktop-owned native layouts without launcher environment variables", () => {
		const macResources = join(root, "mac", "Clawdi.app", "Contents", "Resources");
		const macNative = join(macResources, "native");
		mkdirSync(macNative, { recursive: true });
		writeFileSync(join(macResources, "app.asar"), "desktop\n");
		expect(
			detectDesktopManagedNativeLayout(
				{
					kind: "native",
					executablePath: join(macNative, "clawdi"),
					resourceRoot: macNative,
					activationPath: join(macNative, "clawdi"),
					nativeOwnership: null,
				},
				"darwin",
			),
		).toEqual({});

		const windowsResources = join(root, "windows", "resources");
		const windowsNative = join(windowsResources, "native");
		mkdirSync(windowsNative, { recursive: true });
		writeFileSync(join(windowsResources, "app.asar"), "desktop\n");
		expect(
			detectDesktopManagedNativeLayout(
				{
					kind: "native",
					executablePath: join(windowsNative, "clawdi.exe"),
					resourceRoot: windowsNative,
					activationPath: join(windowsNative, "clawdi.exe"),
					nativeOwnership: null,
				},
				"win32",
			),
		).toEqual({});

		const appImageRuntime = join(root, "user-data", "runtimes", "1.2.3-beta.1");
		mkdirSync(join(appImageRuntime, "skills", "clawdi"), { recursive: true });
		writeFileSync(join(appImageRuntime, "desktop-runtime.json"), '{"version":"1.2.3-beta.1"}');
		writeFileSync(join(appImageRuntime, "skills", "clawdi", "SKILL.md"), "skill\n");
		expect(
			detectDesktopManagedNativeLayout(
				{
					kind: "native",
					executablePath: join(appImageRuntime, "clawdi"),
					resourceRoot: appImageRuntime,
					activationPath: join(appImageRuntime, "clawdi"),
					nativeOwnership: null,
				},
				"linux",
			),
		).toEqual({ runtimeRoot: appImageRuntime });
	});

	it("recognizes a complete Homebrew keg through its stable opt path", () => {
		const prefix = join(root, "homebrew");
		const libexec = join(prefix, "Cellar", "clawdi", "1.2.3", "libexec");
		const executable = join(libexec, "clawdi");
		mkdirSync(join(libexec, "egress-addon"), { recursive: true });
		mkdirSync(join(libexec, "skills", "clawdi"), { recursive: true });
		writeFileSync(executable, "binary\n");
		writeFileSync(join(libexec, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
		writeFileSync(join(libexec, "skills", "clawdi", "SKILL.md"), "skill\n");
		writeFileSync(join(dirname(libexec), "INSTALL_RECEIPT.json"), "{}\n");
		const optLibexec = join(prefix, "opt", "clawdi", "libexec");
		mkdirSync(dirname(optLibexec), { recursive: true });
		symlinkSync(libexec, optLibexec);

		expect(
			detectHomebrewManagedNativeLayout(
				{
					kind: "native",
					executablePath: executable,
					resourceRoot: libexec,
					activationPath: executable,
					nativeOwnership: null,
				},
				"darwin",
			),
		).toEqual({ activationPath: join(optLibexec, "clawdi") });
	});
});
