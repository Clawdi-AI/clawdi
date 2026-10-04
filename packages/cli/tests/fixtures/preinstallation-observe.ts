// Runs the normal installation observation against a real cloned anonymous home.
import { observeRuntimeInstall } from "../../src/runtime/manifest-install";
import { getRuntimePaths } from "../../src/runtime/paths";

const runtime = process.argv[2];
if (runtime !== "openclaw" && runtime !== "hermes") throw new Error("unsupported runtime");
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
			args: ["--no-onboard"],
		},
	},
	"/home/clawdi",
	getRuntimePaths({ mode: "hosted" }),
	{ uid: 10001, gid: 10001 },
);
if (observation.status !== "present" || observation.executedInstallerUrl !== null)
	throw new Error("cloned runtime did not bypass normal installation");
console.log(JSON.stringify(observation));
