import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("runtime paths", () => {
	test("anchors hosted user state to the default runtime home", () => {
		delete process.env.HOME;
		delete process.env.CLAWDI_RUNTIME_HOME;
		delete process.env.CLAWDI_HOME;

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.userHome).toBe("/home/clawdi");
		expect(paths.clawdiHome).toBe("/home/clawdi/.clawdi");
		expect(paths.systemdUserRoot).toBe("/home/clawdi/.config/systemd/user");
	});

	test("derives hosted user state from an explicit runtime home", () => {
		process.env.HOME = "/root";
		process.env.CLAWDI_RUNTIME_HOME = "/srv/clawdi";
		delete process.env.CLAWDI_HOME;

		const paths = getRuntimePaths({ mode: "hosted" });

		expect(paths.userHome).toBe("/srv/clawdi");
		expect(paths.clawdiHome).toBe("/srv/clawdi/.clawdi");
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
