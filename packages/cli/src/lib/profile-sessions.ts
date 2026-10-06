import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
	parseProfileSessionKey,
	profileDiscoveryWatchPaths,
	profileSessionKey,
} from "../adapters/profiles";
import { reconcileLocalHermesMcp } from "../commands/hermes-mcp";
import { log } from "../serve/log";
import { type ApiClient, unwrap } from "./api-client";
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
): { refresh(context?: SyncReadContext): Promise<void>; sessions?: SessionModule } {
	let profiles: LocalAgentProfile[] = [];
	let supported = false;
	let inventoryComplete = false;
	const refresh = async (context?: SyncReadContext): Promise<void> => {
		const discovery = await discoverAgentProfiles(adapter, context?.signal);
		profiles = discovery.profiles;
		inventoryComplete = discovery.complete;
		if (options.readOnly || !environmentId) return;
		const prior = await api.GET("/v1/agents/{agent_id}/profiles", {
			params: { path: { agent_id: environmentId } },
		});
		if (prior.response.status === 404) {
			// MCP is account-wide and does not depend on Cloud profile support.
			if (adapter.agentType === "hermes")
				for (const profile of profiles) reconcileLocalHermesMcp(true, profile.upstreamKey);
			supported = false;
			profiles = profiles.filter((profile) => profile.isDefault);
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
		const roster = unwrap(
			await api.PUT("/v1/agents/{agent_id}/profiles", {
				params: { path: { agent_id: environmentId } },
				body: {
					complete: discovery.complete,
					profiles: profiles.map((profile) => ({
						upstream_key: profile.upstreamKey,
						is_default: profile.isDefault,
					})),
				},
			}),
		);
		supported = true;
		if (adapter.agentType === "hermes") {
			for (const rename of [...pending]) {
				const profile = profiles.find((row) => row.profileKey === rename.targetKey);
				if (!profile) continue;
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
					throw new Error("Pending Hermes rename destination does not preserve its Cloud identity");
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
			}
			for (const profile of profiles) reconcileLocalHermesMcp(true, profile.upstreamKey);
		}
	};
	const module: SessionModule = {
		contentProtocol: async (context) => {
			await refresh(context);
			for (const profile of profiles)
				if (profile.reader && (await profile.reader.contentProtocol(context)) === "events-v1")
					return "events-v1";
			return "snapshot-v1";
		},
		collect: collectFromScan((request, revisions, context) =>
			module.scan
				? module.scan(request, revisions, context)
				: Promise.reject(new Error("Profile scanner is unavailable")),
		),
		scan: async (request: SessionScanRequest, revisions, context) => {
			await refresh(context);
			const readers = profiles.filter(
				(profile): profile is LocalAgentProfile & { reader: SessionModule } =>
					profile.reader !== undefined,
			);
			async function* batches() {
				for (const profile of readers) {
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
							for (let offset = 0; offset < batch.observedLocalSessionIds.length; offset += 1000) {
								const ids = batch.observedLocalSessionIds.slice(offset, offset + 1000);
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
			if (profiles.length === 0) await refresh(context);
			const source = parseProfileSessionKey(key);
			const profile = profiles.find((row) => row.profileKey === source.profileKey);
			const session = await profile?.reader?.resolve(source.localSessionId, context);
			if (!session || !profile) return null;
			return {
				...session,
				contentProtocol: await profile.reader?.contentProtocol(context),
				...(supported ? { profileKey: source.profileKey } : {}),
			};
		},
		watchPaths: () => [
			...new Set([
				...profileDiscoveryWatchPaths(adapter),
				...profiles.flatMap((profile) => profile.reader?.watchPaths() ?? []),
			]),
		],
	};
	return { refresh, ...(adapter.sessions ? { sessions: module } : {}) };
}

export function profileSessionModule(
	adapter: AgentAdapter,
	api: ApiClient,
	environmentId: string | null,
	options: { readOnly?: boolean } = {},
): SessionModule | undefined {
	return createProfileSync(adapter, api, environmentId, options).sessions;
}
