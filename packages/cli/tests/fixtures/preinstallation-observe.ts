// Runs the normal installation observation against a real cloned anonymous home.

import { officialInstallArgs } from "../../src/runtime/manifest-contract";
import { observeRuntimeInstall } from "../../src/runtime/manifest-install";
import { getRuntimePaths } from "../../src/runtime/paths";

const runtime = process.argv[2];
if (runtime !== "openclaw" && runtime !== "hermes") throw new Error("unsupported runtime");
const expected = process.argv[3] ?? "present";
if (expected !== "present" && expected !== "installed") throw new Error("invalid expectation");
process.env.CLAWDI_RUNTIME_USER = "clawdi";
process.env.CLAWDI_RUNTIME_UID = "10001";
process.env.CLAWDI_RUNTIME_GID = "10001";
process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
if (expected === "installed") {
	process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
	process.env[`CLAWDI_RUNTIME_TEST_${runtime.toUpperCase()}_INSTALLER`] =
		"file:///opt/pinned-official-installer.sh";
}
const observation = observeRuntimeInstall(
	runtime,
	{
		enabled: true,
		services: {},
		install: {
			authority: "official",
			method: "official-installer",
			url:
				runtime === "openclaw"
					? "https://openclaw.ai/install-cli.sh"
					: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh",
			home: "/home/clawdi",
			args: officialInstallArgs(runtime, "/home/clawdi"),
		},
	},
	"/home/clawdi",
	getRuntimePaths({ mode: "hosted" }),
	{ uid: 10001, gid: 10001 },
);
if (
	observation.status !== expected ||
	(expected === "present" && observation.executedInstallerUrl !== null)
)
	throw new Error(JSON.stringify(observation));
console.log(JSON.stringify(observation));
