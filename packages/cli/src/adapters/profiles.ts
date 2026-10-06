import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { hermesManagedPythonAsync } from "../runtime/hermes-python";
import { runtimeAppRoot } from "../runtime/manifest-install";
import { execRuntimeUserCommand } from "../runtime/runtime-user-command";
import { log } from "../serve/log";
import type { AgentAdapter, SessionModule } from "./base";
import { HermesAdapter } from "./hermes";
import { createOpenClawProfileReaders, OpenClawAdapter } from "./openclaw";
import { runOpenClawCommand } from "./openclaw-command";
import { openClawAgentId, parseOpenClawAgentWorkspaces } from "./openclaw-workspace";
import { getHermesHome, getOpenClawHome } from "./paths";

const upstreamKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const hermesProfileIdentity = z.object({ name: upstreamKey, home: z.string().refine(isAbsolute) });
const hermesProfileSchema = hermesProfileIdentity.extend({
	previous_names: z.array(upstreamKey),
	failed: z.boolean().optional(),
});

// Upstream owns identity filtering, tombstones, root resolution and rename history.
const HERMES_PROFILE_DISCOVERY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from hermes_cli import profiles
list_profile_names = profiles.list_profile_names
get_profile_dir = profiles.get_profile_dir
read_profile_meta = getattr(profiles, "read_profile_meta", lambda path: {})
rows = []
for name in list_profile_names():
    home = None
    try:
        home = get_profile_dir(name)
        previous = read_profile_meta(home).get("previous_names", [])
        rows.append({"name": name, "home": str(home), "previous_names": previous})
    except Exception:
        rows.append({"name": name, "home": str(home) if home else None, "previous_names": [], "failed": True})
print(json.dumps(rows))
`;

export interface LocalAgentProfile {
	profileKey: string;
	upstreamKey: string;
	isDefault: boolean;
	previousNames: string[];
	reader?: SessionModule;
	home?: string;
}
export interface ProfileDiscovery {
	complete: boolean;
	profiles: LocalAgentProfile[];
	watchPaths?: string[];
}

async function discoverHermesInventory(signal?: AbortSignal): Promise<{
	profiles: LocalAgentProfile[];
	root: string;
}> {
	const userHome = process.env.HOME || homedir();
	const appRoot = runtimeAppRoot("hermes", userHome);
	if (!appRoot || !existsSync(appRoot)) throw new Error("Hermes application path is unavailable");
	const result = await execRuntimeUserCommand(
		await hermesManagedPythonAsync(userHome, appRoot, signal),
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
			signal,
		},
	);
	const entries = z
		.array(z.unknown())
		.parse(JSON.parse(result.stdout))
		.flatMap((value) => {
			const parsed = hermesProfileSchema.safeParse(value);
			if (parsed.success) return [parsed.data];
			const identity = hermesProfileIdentity.safeParse(value);
			if (identity.success) return [{ ...identity.data, previous_names: [], failed: true }];
			const key = z.object({ name: upstreamKey }).safeParse(value);
			log.warn("profiles.read_failed", key.success ? { profile_key: key.data.name } : undefined);
			return [];
		});
	const upstreamDefault = entries.find((entry) => entry.name === "default");
	if (!upstreamDefault) throw new Error("Hermes default profile is missing");
	const legacyHome = resolve(getHermesHome());
	const selected = entries.find((entry) => resolve(entry.home) === legacyHome);
	const defaultName = selected?.name ?? "default";
	const remapped = resolve(upstreamDefault.home) !== legacyHome;
	const mapped: LocalAgentProfile[] = [];
	for (const entry of entries) {
		if (entry.failed) {
			log.warn("profiles.read_failed", { profile_key: entry.name });
			continue;
		}
		if (remapped && entry.name === "default" && defaultName === "default") {
			log.warn("profiles.default_conflict", { profile_key: "default" });
			continue;
		}
		const isDefault = resolve(entry.home) === legacyHome;
		mapped.push({
			profileKey: isDefault ? "" : entry.name,
			upstreamKey: entry.name,
			isDefault,
			previousNames: entry.previous_names,
			home: isDefault ? getHermesHome() : entry.home,
			reader: new HermesAdapter(isDefault ? getHermesHome() : entry.home).sessions,
		});
	}
	if (!mapped.some((profile) => profile.isDefault))
		mapped.unshift({
			profileKey: "",
			upstreamKey: defaultName,
			isDefault: true,
			previousNames: [],
			home: getHermesHome(),
			reader: new HermesAdapter(getHermesHome()).sessions,
		});
	return { profiles: mapped, root: upstreamDefault.home };
}

export async function discoverHermesProfiles(signal?: AbortSignal): Promise<LocalAgentProfile[]> {
	return (await discoverHermesInventory(signal)).profiles;
}

export async function discoverAgentProfiles(
	adapter: AgentAdapter,
	signal?: AbortSignal,
): Promise<ProfileDiscovery> {
	try {
		signal?.throwIfAborted();
		if (adapter.agentType === "hermes") {
			const { profiles, root } = await discoverHermesInventory(signal);
			return {
				complete: true,
				profiles,
				watchPaths: [join(root, "profiles")],
			};
		}
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
				!entries.some((entry) => entry.id === openClawAgentId()) ||
				new Set(entries.map((entry) => entry.id)).size !== entries.length
			)
				throw new Error("OpenClaw official profile roster is incomplete");
			const usable = entries.filter((entry) => {
				if (upstreamKey.safeParse(entry.id).success) return true;
				log.warn("profiles.read_failed");
				return false;
			});
			for (const value of raw) {
				const key = z.object({ id: upstreamKey }).safeParse(value);
				if (key.success && !usable.some((entry) => entry.id === key.data.id))
					log.warn("profiles.read_failed", { profile_key: key.data.id });
			}
			const readers = createOpenClawProfileReaders(
				usable.map((entry) => entry.id),
				getOpenClawHome(),
			);
			return {
				complete: true,
				profiles: usable.map((entry) => ({
					profileKey: entry.id === openClawAgentId() ? "" : upstreamKey.parse(entry.id),
					upstreamKey: upstreamKey.parse(entry.id),
					isDefault: entry.id === openClawAgentId(),
					previousNames: [],
					reader: readers.get(entry.id),
				})),
			};
		}
	} catch {
		signal?.throwIfAborted();
		log.warn("profiles.discovery_incomplete", { agent_type: adapter.agentType });
	}
	return {
		...legacyProfileDiscovery(adapter),
		complete: adapter.agentType !== "hermes" && adapter.agentType !== "openclaw",
	};
}

export function legacyProfileDiscovery(adapter: AgentAdapter): ProfileDiscovery {
	const reader =
		adapter.agentType === "openclaw" ? new OpenClawAdapter(null).sessions : adapter.sessions;
	return {
		complete: true,
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
	if (adapter.agentType === "openclaw")
		return [
			join(getOpenClawHome(), "agents"),
			process.env.OPENCLAW_CONFIG_PATH?.trim() || join(getOpenClawHome(), "openclaw.json"),
		];
	return [];
}
