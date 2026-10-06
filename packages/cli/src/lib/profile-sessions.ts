import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
import { reconcileLocalHermesMcp } from "../commands/hermes-mcp";
import { log } from "../serve/log";
import { type ApiClient, ApiError, unwrap } from "./api-client";
import { canonicalApiOrigin } from "./api-origin";
import { getClawdiDir } from "./config";
import { writePrivateFileAtomic } from "./private-file";
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

const pendingRenameSchema = z.array(
	z.object({
		sourceKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
		targetKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
		sourceId: z.string().min(1),
	}),
);
type PendingRename = z.infer<typeof pendingRenameSchema>[number];

function renameJournal(api: ApiClient, environmentId: string) {
	const fence = createHash("sha256")
		.update(JSON.stringify([canonicalApiOrigin(api.baseUrl), environmentId, "hermes"]))
		.digest("hex");
	const path = join(getClawdiDir(), "profile-renames", `${fence}.json`);
	return {
		read: (): PendingRename[] =>
			existsSync(path) ? pendingRenameSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : [],
		write: (pending: PendingRename[]) =>
			writePrivateFileAtomic(path, JSON.stringify(pending), { dirMode: 0o700, durable: true }),
	};
}

export function createProfileSync(
	adapter: AgentAdapter,
	api: ApiClient,
	environmentId: string | null,
	options: { readOnly?: boolean } = {},
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
	const failed = new Set<string>();
	const attributed = new Map<string, Set<string>>();
	let supported = false;
	let inventoryComplete = true;
	const fallback = () => {
		profiles = legacyProfileDiscovery(adapter).profiles;
		supported = false;
		inventoryComplete = true;
	};
	const signature = async () => {
		const paths = [...discoveryPaths];
		if (adapter.agentType === "hermes") {
			for (const root of discoveryPaths) {
				paths.push(join(root, ".deleted"));
				try {
					// Watch metadata changes even in profiles skipped after a read failure.
					// Only upstream discovery determines which directories are identities.
					const entries = await readdir(root, { withFileTypes: true });
					for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
						if (entry.isDirectory() && entry.name !== ".deleted")
							paths.push(join(root, entry.name, "profile.yaml"));
				} catch {
					/* A missing inventory root remains observable through its own stat. */
				}
			}
		}
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
	const putInventory = (complete: boolean) =>
		api.PUT("/v1/agents/{agent_id}/profiles", {
			params: { path: { agent_id: environmentId ?? "" } },
			body: {
				complete,
				profiles: profiles
					.filter((profile) => !failed.has(profile.profileKey))
					.map((profile) => ({
						upstream_key: profile.upstreamKey,
						is_default: profile.isDefault,
					})),
			},
		});
	const failProfile = async (profileKey: string) => {
		if (!failed.has(profileKey)) log.warn("profiles.sync_failed", { profile_key: profileKey });
		failed.add(profileKey);
		if (supported && environmentId && !options.readOnly) {
			try {
				unwrap(await putInventory(true));
			} catch {
				/* Default sync remains available. */
			}
		}
	};
	const performRefresh = async (context?: SyncReadContext): Promise<void> => {
		const discovery = await discoverAgentProfiles(adapter, context?.signal);
		profiles = discovery.profiles;
		failed.clear();
		inventoryComplete = true;
		discoveryPaths = discovery.watchPaths ?? profileDiscoveryWatchPaths(adapter);
		if (options.readOnly || !environmentId) return;
		const prior = await api.GET("/v1/agents/{agent_id}/profiles", {
			params: { path: { agent_id: environmentId } },
		});
		if (prior.response.status === 404 || prior.response.status >= 500) {
			fallback();
			return;
		}
		const known = unwrap(prior);
		const journal = renameJournal(api, environmentId);
		let pending = adapter.agentType === "hermes" ? journal.read() : [];
		if (adapter.agentType === "hermes" && discovery.complete) {
			const present = new Set(profiles.map((profile) => profile.profileKey));
			for (const profile of profiles) {
				if (profile.isDefault || known.some((row) => row.profile_key === profile.profileKey))
					continue;
				if (pending.some((rename) => rename.targetKey === profile.profileKey)) continue;
				const removed = known.filter(
					(row) =>
						!row.is_default &&
						!present.has(row.profile_key) &&
						profile.previousNames.includes(row.profile_key),
				);
				// Hermes appends old names, so the last matching name preserves the most recent identity.
				const sourceKey = profile.previousNames.findLast((key) =>
					removed.some((row) => row.profile_key === key),
				);
				const source = removed.find((row) => row.profile_key === sourceKey);
				if (source) {
					if (removed.length > 1)
						log.warn("profiles.rename_multiple_previous_names", {
							profile_key: profile.profileKey,
							selected_profile_key: source.profile_key,
							removed_profile_keys: removed
								.filter((row) => row !== source)
								.map((row) => row.profile_key),
						});
					pending.push({
						sourceKey: source.profile_key,
						targetKey: profile.profileKey,
						sourceId: source.id,
					});
				}
			}
			// Record first-discovery identity before inventory/rename mutations. A retry
			// never infers a rename from session counts or overlapping session IDs.
			if (pending.length > 0) journal.write(pending);
		}
		// Mark missing identities removed before applying recorded upstream renames.
		const inventory = await putInventory(discovery.complete);
		if (inventory.response.status === 404 || inventory.response.status >= 500) {
			fallback();
			return;
		}
		const roster = unwrap(inventory);
		supported = true;
		if (adapter.agentType === "hermes") {
			for (const rename of [...pending]) {
				const profile = profiles.find((row) => row.profileKey === rename.targetKey);
				if (!profile) continue;
				try {
					const source = roster.find((row) => row.profile_key === rename.sourceKey);
					const target = roster.find((row) => row.profile_key === rename.targetKey);
					if (source) {
						if (source.id !== rename.sourceId || source.state !== "removed")
							throw new Error(
								"Pending Hermes rename no longer matches the recorded upstream identity",
							);
						unwrap(
							await api.POST("/v1/agents/{agent_id}/profiles/{profile_key}/rename", {
								params: { path: { agent_id: environmentId, profile_key: rename.sourceKey } },
								body: { new_upstream_key: profile.upstreamKey },
							}),
						);
					} else if (target?.id !== rename.sourceId) {
						throw new Error(
							"Pending Hermes rename destination does not preserve its Cloud identity",
						);
					}
					moveProfileSessionReceipts(
						api,
						environmentId,
						adapter.agentType,
						rename.sourceKey,
						rename.targetKey,
					);
					pending = pending.filter((entry) => entry !== rename);
					journal.write(pending);
				} catch {
					context?.signal.throwIfAborted();
					await failProfile(profile.profileKey);
				}
			}
			if (discovery.complete)
				for (const profile of profiles) {
					if (mcpSeen.has(profile.profileKey) || failed.has(profile.profileKey)) continue;
					mcpSeen.add(profile.profileKey);
					try {
						await reconcileLocalHermesMcp(
							true,
							profile.isDefault ? undefined : profile.upstreamKey,
							context?.signal,
						);
					} catch {
						context?.signal.throwIfAborted();
						if (profile.isDefault) log.warn("profiles.mcp_failed", { profile_key: "" });
						else await failProfile(profile.profileKey);
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
					await failProfile(profile.profileKey);
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
						await failProfile(profile.profileKey);
					}
				}
			}
			const userActivity: SessionUserActivity = {
				complete: readers.length > 0 && inventoryComplete,
				lastUserInputAt: null,
			};
			const result: SessionBatchScan = {
				coverage: request.kind === "complete" && inventoryComplete ? "complete" : "partial",
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
				await failProfile(profile.profileKey);
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
