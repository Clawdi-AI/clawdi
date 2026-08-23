import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("runtime paths", () => {
	test("uses the systemd and FHS platform roots for Hosted runtime data", () => {
		delete process.env.CLAWDI_SERVICE_STATE_DIR;
		delete process.env.CLAWDI_RUN_DIR;
		delete process.env.CLAWDI_RUNTIME_HOME;
		delete process.env.CLAWDI_HOME;
		delete process.env.HOME;

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.configurationRoot).toBe("/etc/clawdi");
		expect(paths.fileBrowserConfigRoot).toBe("/run/clawdi/files");
		expect(paths.fileBrowserConfig).toBe("/run/clawdi/files/filebrowser.yaml");
		expect(paths.serviceStateRoot).toBe("/var/lib/clawdi");
		expect(paths.clawdiHome).toBe("/var/lib/clawdi-user");
		expect(paths.cacheRoot).toBe("/var/cache/clawdi");
		expect(paths.runRoot).toBe("/run/clawdi");
		expect(paths.bootStatus).toBe("/var/lib/clawdi/status/boot-status.json");
		expect(paths.cliManagedBin).toBe("/var/lib/clawdi/maintained/clawdi/bin/clawdi");
		expect(paths.cliNpmPrefix).toBe("/var/lib/clawdi/maintained/clawdi/npm");
		expect(paths.cliNpmCache).toBe("/var/cache/clawdi/npm");
		expect(paths.fileBrowserInstallRoot).toBe("/var/lib/clawdi/maintained/filebrowser");
		expect(paths.managedResourceRoot).toBe("/var/lib/clawdi/managed-resources");
		expect(paths.fileBrowserStateRoot).toBe("/var/lib/clawdi-files");
		expect(paths.egressServiceBinary).toBe("/run/clawdi/egress/systemd/mitmdump");
		expect(paths.fileBrowserServiceBinary).toBe("/run/clawdi-files/filebrowser");
		expect(paths.userNpmPrefix).toBe("/home/clawdi/.local");
	});

	test("derives isolated config and cache roots from a service-state fixture", () => {
		process.env.CLAWDI_SERVICE_STATE_DIR = "/tmp/runtime-fixture/var/lib/clawdi";
		process.env.CLAWDI_RUN_DIR = "/tmp/runtime-fixture/run/clawdi";

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.configurationRoot).toBe("/tmp/runtime-fixture/etc/clawdi");
		expect(paths.fileBrowserConfigRoot).toBe("/tmp/runtime-fixture/run/clawdi/files");
		expect(paths.fileBrowserConfig).toBe("/tmp/runtime-fixture/run/clawdi/files/filebrowser.yaml");
		expect(paths.cacheRoot).toBe("/tmp/runtime-fixture/var/cache/clawdi");
		expect(paths.clawdiHome).toBe("/tmp/runtime-fixture/var/lib/clawdi-user");
		expect(paths.fileBrowserStateRoot).toBe("/var/lib/clawdi-files");
	});

	test("keeps hosted CLI user state outside the default runtime home", () => {
		delete process.env.HOME;
		delete process.env.CLAWDI_RUNTIME_HOME;
		delete process.env.CLAWDI_HOME;

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.userHome).toBe("/home/clawdi");
		expect(paths.clawdiHome).toBe("/var/lib/clawdi-user");
		expect(paths.systemdUserRoot).toBe("/home/clawdi/.config/systemd/user");
	});

	test("keeps hosted CLI user state outside an explicit runtime home", () => {
		process.env.HOME = "/root";
		process.env.CLAWDI_RUNTIME_HOME = "/srv/clawdi";
		delete process.env.CLAWDI_HOME;

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.userHome).toBe("/srv/clawdi");
		expect(paths.clawdiHome).toBe("/var/lib/clawdi-user");
	});

	test("preserves the explicit Clawdi state override in hosted mode", () => {
		process.env.HOME = "/root";
		process.env.CLAWDI_RUNTIME_HOME = "/srv/clawdi";
		process.env.CLAWDI_HOME = "/var/lib/example-clawdi";

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.userHome).toBe("/srv/clawdi");
		expect(paths.clawdiHome).toBe("/var/lib/example-clawdi");
	});

	test("keeps local CLI paths based on HOME", () => {
		process.env.HOME = "/tmp/local-user";
		process.env.CLAWDI_RUNTIME_HOME = "/srv/ignored-hosted-home";
		delete process.env.CLAWDI_HOME;

		const paths = getRuntimePaths({ mode: "local" });

		expect(paths.userHome).toBe("/tmp/local-user");
		expect(paths.clawdiHome).toBe(join("/tmp/local-user", ".clawdi"));
	});
});
