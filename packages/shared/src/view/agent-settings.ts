import { deploymentLifecycleAvailable } from "../api";
import { agentSurfaceCopy } from "./agent-surfaces";
import type { DeploymentStatus } from "./deployment-status";

/** Web's Cloud Agent Settings tab, below the profile: language, compute plan, controls, deletion. */
export const agentSettingsCopy = {
	languageTimezone: {
		title: "Language & timezone",
		description: agentSurfaceCopy.languageAndTimeZoneUsedByThisAgent,
		note: "Changes apply to this agent.",
		language: "Language",
		timezone: "Timezone",
		agentDefault: "Agent default",
		save: "Save changes",
	},
	computePlan: {
		title: "Compute plan",
		description: "Compute resources for this Cloud Agent.",
		chooseSubscription: "Choose a subscription",
		walletFallback: "Wallet fallback",
	},
	controls: {
		title: "Agent controls",
		description: agentSurfaceCopy.restartStopOrStartThisAgent,
		restart: "Restart",
		stop: "Stop",
		start: "Start",
	},
	dangerZone: {
		title: "Danger zone",
		description: agentSurfaceCopy.permanentlyDeleteThisAgent,
		deleteTitle: "Delete this agent",
		deleteDescription: "Deletes this agent and its saved data. This can’t be undone.",
		delete: "Delete",
	},
} as const;

/** Web's Agent controls show Restart, then Stop while the agent runs or is changing, else Start. */
export function deploymentPrimaryLifecycleAction(status: DeploymentStatus): "stop" | "start" {
	return deploymentLifecycleAvailable("stop", status.kind) ||
		status.kind === "stopping" ||
		status.kind === "restarting" ||
		status.kind === "updating"
		? "stop"
		: "start";
}

/** Web's agent profile settings: name and avatar. */
export const agentProfileSettingsCopy = {
	nameLabel: "Agent name",
	save: "Save",
	defaultName: (name: string) => `Default: ${name}`,
	useDefaultName: "Use default name",
	defaultAvatar: (runtimeLabel: string) => `${runtimeLabel} default`,
	uploadImage: "Upload image",
	remove: "Remove",
	updateFailed: "Couldn't update agent",
	uploadFailed: "Couldn't upload avatar",
	removeFailed: "Couldn't remove avatar",
	disconnectFailed: "Couldn't disconnect agent",
	unsupportedAvatar: {
		title: "Unsupported avatar file",
		description: "Upload a PNG, JPEG, or WebP image.",
	},
	avatarTooLarge: {
		title: "Avatar image is too large",
		description: "Upload an image up to 2 MB.",
	},
} as const;
