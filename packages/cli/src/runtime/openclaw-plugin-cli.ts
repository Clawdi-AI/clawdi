type PluginCommandResult = {
	status: number | null;
	stdout: string;
	stderr: string;
};

type PluginCommandRunner = (args: string[]) => PluginCommandResult;

const ACCEPT_CAPABILITIES_OPTION = "--accept-capabilities";

export function openClawPluginCapabilityConsentArgs(
	action: "enable" | "install",
	run: PluginCommandRunner,
): string[] {
	const result = run(["plugins", action, "--help"]);
	if (result.status !== 0) return [];
	const output = `${result.stdout}\n${result.stderr}`;
	return output.includes(ACCEPT_CAPABILITIES_OPTION) ? [ACCEPT_CAPABILITIES_OPTION] : [];
}

export function openClawAgentPluginCapabilityConsentArgs(run: PluginCommandRunner): {
	install: string[];
	enable: string[];
} {
	const install = openClawPluginCapabilityConsentArgs("install", run);
	const enable = openClawPluginCapabilityConsentArgs("enable", run);
	if (install.length === 0 || enable.length === 0) {
		throw new Error(
			"OpenClaw runtime does not support Hosted Agent Plugins; upgrade OpenClaw before applying this Agent Plugin",
		);
	}
	return { install, enable };
}
