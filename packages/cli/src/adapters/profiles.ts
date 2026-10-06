import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { hermesManagedPython } from "../runtime/hermes-python";
import { spawnRuntimeUserCommand } from "../runtime/runtime-user-command";
import { log } from "../serve/log";
import type { AgentAdapter, SessionModule } from "./base";
import { HermesAdapter } from "./hermes";
import { OpenClawAdapter } from "./openclaw";
import { runOpenClawCommand } from "./openclaw-command";
import { openClawAgentId, parseOpenClawAgentWorkspaces } from "./openclaw-workspace";
import { getHermesHome, getOpenClawHome } from "./paths";

const upstreamKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const hermesProfilesSchema = z.array(
	z.object({
		name: upstreamKey,
		home: z.string().refine(isAbsolute),
		previous_names: z.array(upstreamKey),
	}),
);

// Upstream owns identity filtering, tombstones, root resolution and rename history.
const HERMES_PROFILE_DISCOVERY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from hermes_cli import profiles
list_profile_names = profiles.list_profile_names
get_profile_dir = profiles.get_profile_dir
read_profile_meta = getattr(profiles, "read_profile_meta", lambda path: {})
print(json.dumps([{"name": name, "home": str(get_profile_dir(name)),
    "previous_names": read_profile_meta(get_profile_dir(name)).get("previous_names", [])}
    for name in list_profile_names()]))
`;

export interface LocalAgentProfile {
	profileKey: string;
	upstreamKey: string;
	isDefault: boolean;
	previousNames: string[];
	reader?: SessionModule;
}
export interface ProfileDiscovery {
	complete: boolean;
	profiles: LocalAgentProfile[];
}

export function discoverHermesProfiles(): LocalAgentProfile[] {
	const userHome = process.env.HOME || homedir();
	const appRoot = join(userHome, ".hermes", "hermes-agent");
	const result = spawnRuntimeUserCommand(
		hermesManagedPython(userHome),
		["-c", HERMES_PROFILE_DISCOVERY, appRoot],
		userHome,
		process.cwd(),
		{
			environmentOverrides: {
				HERMES_HOME: getHermesHome(),
				HERMES_PROFILE: "",
				HERMES_PROFILE_NAME: "",
			},
			timeoutMs: 30_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
	if (result.status !== 0 || result.error)
		throw new Error("Hermes official profile discovery failed");
	const entries = hermesProfilesSchema.parse(JSON.parse(String(result.stdout)));
	if (!entries.some((entry) => entry.name === "default"))
		throw new Error("Hermes default profile is missing");
	return entries.map((entry) => ({
		profileKey: entry.name === "default" ? "" : entry.name,
		upstreamKey: entry.name,
		isDefault: entry.name === "default",
		previousNames: entry.previous_names,
		reader: new HermesAdapter(entry.home).sessions,
	}));
}

export async function discoverAgentProfiles(
	adapter: AgentAdapter,
	signal?: AbortSignal,
): Promise<ProfileDiscovery> {
	try {
		signal?.throwIfAborted();
		if (adapter.agentType === "hermes")
			return { complete: true, profiles: discoverHermesProfiles() };
		if (adapter.agentType === "openclaw") {
			const output = await runOpenClawCommand(["agents", "list", "--json"], {
				signal,
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
			});
			const entries = parseOpenClawAgentWorkspaces(output);
			const raw: unknown = JSON.parse(output);
			if (
				!Array.isArray(raw) ||
				raw.length !== entries.length ||
				entries.length === 0 ||
				new Set(entries.map((entry) => entry.id)).size !== entries.length
			)
				throw new Error("OpenClaw official profile roster is incomplete");
			return {
				complete: true,
				profiles: entries.map((entry) => ({
					profileKey: entry.id === openClawAgentId() ? "" : upstreamKey.parse(entry.id),
					upstreamKey: upstreamKey.parse(entry.id),
					isDefault: entry.id === openClawAgentId(),
					previousNames: [],
					reader: new OpenClawAdapter(entry.id, getOpenClawHome()).sessions,
				})),
			};
		}
	} catch {
		signal?.throwIfAborted();
		log.warn("profiles.discovery_incomplete", { agent_type: adapter.agentType });
	}
	const reader =
		adapter.agentType === "openclaw"
			? new OpenClawAdapter(openClawAgentId(), getOpenClawHome()).sessions
			: adapter.sessions;
	return {
		complete: adapter.agentType !== "hermes" && adapter.agentType !== "openclaw",
		profiles: [
			{
				profileKey: "",
				upstreamKey:
					adapter.agentType === "hermes"
						? "default"
						: adapter.agentType === "openclaw"
							? openClawAgentId()
							: "default",
				isDefault: true,
				previousNames: [],
				reader,
			},
		],
	};
}

/** Default keys are deliberately byte-identical to pre-profile receipts. */
export function profileSessionKey(profileKey: string | undefined, localSessionId: string): string {
	return profileKey ? `${profileKey}:${localSessionId}` : localSessionId;
}

export function parseProfileSessionKey(key: string): {
	profileKey: string;
	localSessionId: string;
} {
	const separator = key.indexOf(":");
	return separator < 0
		? { profileKey: "", localSessionId: key }
		: { profileKey: key.slice(0, separator), localSessionId: key.slice(separator + 1) };
}

export function profileDiscoveryWatchPaths(adapter: AgentAdapter): string[] {
	if (adapter.agentType === "hermes") return [join(getHermesHome(), "profiles")];
	if (adapter.agentType === "openclaw") return [join(getOpenClawHome(), "agents")];
	return [];
}
