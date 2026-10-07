import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentAdapter,
	collectFromScan,
	type SessionBatchScan,
	type SessionModule,
	type SessionScanRequest,
	type SessionUserActivity,
	type SyncReadContext,
	scanSessionModule,
} from "../adapters/base";
import {
	discoverAgentProfiles,
	type LocalAgentProfile,
	legacyProfileDiscovery,
	parseProfileSessionKey,
	profileDiscoveryWatchPaths,
	profileSessionKey,
} from "../adapters/profiles";
import { classifyHermesMcpFailure, reconcileLocalHermesMcp } from "../commands/hermes-mcp";
import { log } from "../serve/log";
import { type ApiClient, ApiError, unwrap } from "./api-client";
import { canonicalApiOrigin } from "./api-origin";
import {
	isFencedSessionLockEntry,
	readSessionsLock,
	sessionFenceKey,
	writeSessionsLock,
} from "./sessions-lock";

/** Rename and attribution preserve content receipts, including pending generations. */
export function moveProfileSessionReceipts(
	api: ApiClient,
	environmentId: string,
	adapter: AgentAdapter["agentType"],
	oldKey: string,
	newKey: string,
	localSessionIds?: readonly string[],
): void {
	const lock = readSessionsLock();
	const ids = localSessionIds ? new Set(localSessionIds) : null;
	let changed = false;
	for (const [key, entry] of Object.entries(lock.sessions)) {
		if (
			!isFencedSessionLockEntry(entry) ||
			entry.api_origin !== canonicalApiOrigin(api.baseUrl) ||
			entry.environment_id !== environmentId ||
			entry.adapter !== adapter
		)
			continue;
		const source = parseProfileSessionKey(entry.source_session_key);
		if (source.profileKey !== oldKey || (ids && !ids.has(source.localSessionId))) continue;
		const sourceSessionKey = profileSessionKey(newKey, source.localSessionId);
		const next = { ...entry, source_session_key: sourceSessionKey, profile_key: newKey };
		lock.sessions[
			sessionFenceKey({ apiOrigin: entry.api_origin, environmentId, adapter, sourceSessionKey })
		] = next;
		delete lock.sessions[key];
		changed = true;
	}
	if (changed) writeSessionsLock(lock);
}

export function createProfileSync(
	adapter: AgentAdapter,
	api: ApiClient,
	environmentId: string | null,
	options: { readOnly?: boolean; manageLocalMcp?: boolean } = {},
): {
	refresh(context?: SyncReadContext): Promise<void>;
	refreshIfChanged(context?: SyncReadContext): Promise<void>;
	watchPaths(): string[];
	sessions?: SessionModule;
} {
	let profiles = legacyProfileDiscovery(adapter).profiles;
	let initialized = false;
	let refreshing: Promise<void> | null = null;
	let discoveryPaths = profileDiscoveryWatchPaths(adapter);
	let inventorySignature = "";
	const mcpSeen = new Set<string>();
	const mcpLoggedFailures = new Set<string>();
	const mcpFailedProfiles = new Set<string>();
	const failed = new Set<string>();
	const manageLocalMcp = options.manageLocalMcp ?? true;
	const attributed = new Map<string, Set<string>>();
	let supported = false;
	const fallback = () => {
		profiles = legacyProfileDiscovery(adapter).profiles;
		supported = false;
	};
	const signature = async () => {
		const paths = [...discoveryPaths];
		if (adapter.agentType === "hermes")
			for (const root of discoveryPaths) paths.push(join(root, ".deleted"));
		return JSON.stringify(
			await Promise.all(
				paths.map(async (path) => {
					try {
						const entry = await stat(path);
						return [path, entry.mtimeMs, entry.size];
					} catch {
						return [path, null];
					}
				}),
			),
		);
	};
	const failProfile = (profileKey: string) => {
		if (!failed.has(profileKey)) log.warn("profiles.sync_failed", { profile_key: profileKey });
		failed.add(profileKey);
	};
	const performRefresh = async (context?: SyncReadContext): Promise<void> => {
		const discovery = await discoverAgentProfiles(adapter, context?.signal);
		profiles = discovery.profiles;
		failed.clear();
		discoveryPaths = discovery.watchPaths ?? profileDiscoveryWatchPaths(adapter);
		if (!discovery.complete) {
			fallback();
			return;
		}
		if (options.readOnly || !environmentId) return;
		const prior = await api.GET("/v1/agents/{agent_id}/profiles", {
			params: { path: { agent_id: environmentId } },
		});
		if (prior.response.status === 404 || prior.response.status >= 500) {
			fallback();
			return;
		}
		const known = unwrap(prior);
		supported = true;
		if (adapter.agentType === "hermes") {
			const present = new Set(profiles.map((profile) => profile.profileKey));
			for (const profile of profiles) {
				if (profile.isDefault || known.some((row) => row.profile_key === profile.profileKey))
					continue;
				const removed = known.filter(
					(row) =>
						row.profile_key !== "" &&
						!present.has(row.profile_key) &&
						profile.previousNames.includes(row.profile_key),
				);
				// Hermes appends old names, so the last matching name preserves the most recent identity.
				const sourceKey = profile.previousNames.findLast((key) =>
					removed.some((row) => row.profile_key === key),
				);
				const source = removed.find((row) => row.profile_key === sourceKey);
				if (!source) continue;
				if (removed.length > 1)
					log.warn("profiles.rename_multiple_previous_names", {
						profile_key: profile.profileKey,
						selected_profile_key: source.profile_key,
						removed_profile_keys: removed
							.filter((row) => row !== source)
							.map((row) => row.profile_key),
					});
				try {
					unwrap(
						await api.POST("/v1/agents/{agent_id}/profiles/{profile_key}/rename", {
							params: { path: { agent_id: environmentId, profile_key: source.profile_key } },
							body: { new_upstream_key: profile.upstreamKey },
						}),
					);
					moveProfileSessionReceipts(
						api,
						environmentId,
						adapter.agentType,
						source.profile_key,
						profile.profileKey,
					);
					source.profile_key = profile.profileKey;
				} catch {
					context?.signal.throwIfAborted();
					failProfile(profile.profileKey);
				}
			}
		}
		// Keep failed rename detection available on the next upstream/Cloud refresh.
		// Inserting the destination now would hide a rename that did not commit.
		profiles = profiles.filter((profile) => !failed.has(profile.profileKey));
		const inventory = await api.PUT("/v1/agents/{agent_id}/profiles", {
			params: { path: { agent_id: environmentId } },
			body: {
				complete: true,
				profiles: profiles.map((profile) => ({
					upstream_key: profile.upstreamKey,
					is_default: profile.isDefault,
				})),
			},
		});
		if (inventory.response.status === 404 || inventory.response.status >= 500) {
			fallback();
			return;
		}
		unwrap(inventory);
		if (adapter.agentType === "hermes" && manageLocalMcp)
			for (const profile of profiles) {
				if (mcpSeen.has(profile.profileKey) || failed.has(profile.profileKey)) continue;
				try {
					await reconcileLocalHermesMcp(
						true,
						profile.isDefault ? undefined : profile.upstreamKey,
						context?.signal,
					);
					if (mcpFailedProfiles.delete(profile.profileKey))
						log.info("profiles.mcp_recovered", { profile_key: profile.profileKey });
					mcpSeen.add(profile.profileKey);
				} catch (error) {
					context?.signal.throwIfAborted();
					mcpFailedProfiles.add(profile.profileKey);
					const reason = classifyHermesMcpFailure(error);
					const failureKey = `${profile.profileKey}\u0000${reason}`;
					if (!mcpLoggedFailures.has(failureKey)) {
						mcpLoggedFailures.add(failureKey);
						log.warn("profiles.mcp_failed", {
							profile_key: profile.profileKey,
							reason,
						});
					}
				}
			}
	};
	const refresh = async (context?: SyncReadContext): Promise<void> => {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			try {
				await performRefresh(context);
			} catch (error) {
				context?.signal.throwIfAborted();
				// Auth failures retain the engine's established revocation behavior.
				if (error instanceof ApiError && (error.status === 401 || error.status === 403))
					throw error;
				fallback();
				log.warn("profiles.inventory_unavailable", { profile_key: "" });
			}
			initialized = true;
			inventorySignature = await signature();
		})().finally(() => {
			refreshing = null;
		});
		return refreshing;
	};
	const refreshIfChanged = async (context?: SyncReadContext) => {
		if (!initialized || (await signature()) !== inventorySignature) await refresh(context);
	};
	const module: SessionModule = {
		contentProtocol: async (context) => {
			if (!initialized) await refresh(context);
			for (const profile of profiles) {
				if (!profile.reader || failed.has(profile.profileKey)) continue;
				try {
					if ((await profile.reader.contentProtocol(context)) === "events-v1") return "events-v1";
				} catch (error) {
					context?.signal.throwIfAborted();
					if (profile.isDefault) throw error;
					failProfile(profile.profileKey);
				}
			}
			return "snapshot-v1";
		},
		collect: collectFromScan((request, revisions, context) =>
			module.scan
				? module.scan(request, revisions, context)
				: Promise.reject(new Error("Profile scanner is unavailable")),
		),
		scan: async (request: SessionScanRequest, revisions, context) => {
			await refreshIfChanged(context);
			context = {
				...context,
				signal: context?.signal ?? new AbortController().signal,
				profileScanToken: {},
			};
			const readers = profiles.filter(
				(profile): profile is LocalAgentProfile & { reader: SessionModule } =>
					profile.reader !== undefined && !failed.has(profile.profileKey),
			);
			async function* batches() {
				for (const profile of readers) {
					try {
						const knownRevisions = new Map<string, string>();
						for (const [key, revision] of revisions) {
							const source = parseProfileSessionKey(key);
							if (source.profileKey === profile.profileKey)
								knownRevisions.set(source.localSessionId, revision);
						}
						const contentProtocol = await profile.reader.contentProtocol(context);
						const scan = await scanSessionModule(profile.reader, request, knownRevisions, context);
						if (scan.coverage !== "complete") result.coverage = "partial";
						userActivity.complete &&= scan.userActivity?.complete ?? false;
						const lastInput = scan.userActivity?.lastUserInputAt;
						if (
							lastInput &&
							(!userActivity.lastUserInputAt || lastInput > userActivity.lastUserInputAt)
						)
							userActivity.lastUserInputAt = lastInput;
						for await (const batch of scan.batches) {
							context?.signal.throwIfAborted();
							if (
								supported &&
								environmentId &&
								adapter.agentType === "openclaw" &&
								profile.profileKey
							) {
								const seen = attributed.get(profile.profileKey) ?? new Set<string>();
								attributed.set(profile.profileKey, seen);
								const newlyObserved = batch.observedLocalSessionIds.filter((id) => !seen.has(id));
								for (let offset = 0; offset < newlyObserved.length; offset += 1000) {
									const ids = newlyObserved.slice(offset, offset + 1000);
									unwrap(
										await api.POST(
											"/v1/agents/{agent_id}/profiles/{profile_key}/attribute-sessions",
											{
												params: {
													path: { agent_id: environmentId, profile_key: profile.profileKey },
												},
												body: { local_session_ids: [...ids] },
											},
										),
									);
									for (const id of ids) seen.add(id);
									moveProfileSessionReceipts(
										api,
										environmentId,
										adapter.agentType,
										"",
										profile.profileKey,
										ids,
									);
								}
							}
							yield {
								...batch,
								sessions: batch.sessions.map((session) => ({
									...session,
									contentProtocol,
									...(supported || options.readOnly ? { profileKey: profile.profileKey } : {}),
								})),
								observedLocalSessionIds: batch.observedLocalSessionIds.map((id) =>
									profileSessionKey(profile.profileKey, id),
								),
							};
						}
					} catch (error) {
						context?.signal.throwIfAborted();
						if (profile.isDefault) throw error;
						result.coverage = "partial";
						userActivity.complete = false;
						failProfile(profile.profileKey);
					}
				}
			}
			const userActivity: SessionUserActivity = {
				complete: readers.length > 0,
				lastUserInputAt: null,
			};
			const result: SessionBatchScan = {
				coverage: request.kind === "complete" ? "complete" : "partial",
				userActivity,
				batches: batches(),
			};
			return result;
		},
		resolve: async (key, context) => {
			if (!initialized) await refresh(context);
			const source = parseProfileSessionKey(key);
			const profile = profiles.find((row) => row.profileKey === source.profileKey);
			if (!profile || failed.has(profile.profileKey)) return null;
			try {
				const session = await profile.reader?.resolve(source.localSessionId, context);
				if (!session) return null;
				return {
					...session,
					contentProtocol: await profile.reader?.contentProtocol(context),
					...(supported ? { profileKey: source.profileKey } : {}),
				};
			} catch (error) {
				context?.signal.throwIfAborted();
				if (profile.isDefault) throw error;
				failProfile(profile.profileKey);
				return null;
			}
		},
		watchPaths: () => [
			...new Set([
				...discoveryPaths,
				...profiles.flatMap((profile) => profile.reader?.watchPaths() ?? []),
			]),
		],
	};
	return {
		refresh,
		refreshIfChanged,
		watchPaths: () => [...discoveryPaths],
		...(adapter.sessions ? { sessions: module } : {}),
	};
}
