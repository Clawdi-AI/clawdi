/**
 * `clawdi serve` orchestrator.
 *
 * Wires the background tasks that make up a sync daemon:
 *
 *   - watcher          — local skill-dir change events (fs.watch / poll)
 *   - sse              — server-pushed `skill_changed` / `skill_deleted`
 *                        events for instant cloud→machine propagation
 *   - drainQueue       — flush queued skill_push items to the cloud
 *   - reconcile        — 60s sweep: catches anything SSE missed
 *                        (replica restart, transient disconnect)
 *   - scope-refresh    — periodic re-fetch of the env's default_scope_id
 *                        so a runtime scope reassignment converges
 *   - heartbeat        — periodic POST to /api/agents/{env}/sync-heartbeat
 *
 * Single-writer model: the daemon (and any CLI command run on
 * the same machine) is the only content writer for its env's
 * scope. Dashboard is read-only for skill *content* but can
 * install new skills (marketplace) and delete existing ones —
 * both originate as cloud writes that propagate to the machine
 * via SSE within ~2s, with the 60s reconcile loop as the safety
 * net for missed events. No If-Match, no conflict resolution UI:
 * with one content writer per scope there is nothing to merge.
 *
 * Push side:
 *   1. Watcher fires for skill_key X
 *   2. Hash X's local content; if same as last-pushed, skip
 *   3. Enqueue skill_push{key=X, scope_id, new=hash}
 *   4. drainQueue picks it up, tars + uploads to scope-explicit URL
 *   5. 200: mark done, update last-pushed cache
 *   6. 4xx: drop with a warn. 5xx / network: bump attempts and
 *      leave in queue with backoff.
 *
 * Pull side (SSE primary, reconcile fallback):
 *   1. SSE event arrives for skill_key X (scope filter applied
 *      server-side; daemon-side filter is defense-in-depth).
 *      `skill_changed` → download + writeSkillArchive.
 *      `skill_deleted` → removeLocalSkill.
 *   2. Every 60s, reconcile lists /api/skills with If-None-Match;
 *      pulls anything cloud-side that disagrees with local;
 *      sweeps previously-observed keys now missing from cloud.
 *
 * Echo suppression: after writing a cloud-originated tar, we
 * recompute the local hash and stash it as last_pushed. The
 * watcher's next tick sees `current_hash == last_pushed_hash`
 * and dedups.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import type { AgentAdapter } from "../adapters/base";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { computeLastActivityIso } from "../lib/session-activity";
import { cacheKey, readSessionsLock, writeSessionsLock } from "../lib/sessions-lock";
import {
	computeSkillFolderHash,
	readSkillsLock,
	skillCacheKey,
	writeSkillsLock,
} from "../lib/skills-lock";
import { tarSkillDir } from "../lib/tar";
import { getCliVersion } from "../lib/version";
import { log, toErrorMessage } from "./log";
import { getServeStateDir } from "./paths";
import { type QueueItem, RetryQueue } from "./queue";
import { watchSessions } from "./sessions-watcher";
import { consumeSse, type ServerEvent } from "./sse-client";
import { watchSkills } from "./watcher";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

const HEARTBEAT_INTERVAL_MS = 30_000;
// Reconcile cadence. The reconcile loop is how cloud-side changes
// (dashboard install / delete) propagate to the machine; 60s is
// the worst-case lag a user sees after acting on the dashboard.
const RECONCILE_INTERVAL_MS = 60_000;
// Backoff between retry attempts when the queue has items but the
// last drain attempt failed. Keeps the daemon from hammering a
// dead network. Per-item attempts counter caps the work too.
const QUEUE_RETRY_INTERVAL_MS = 15_000;
// Idle poll when the queue is empty. Short — we don't want a
// fresh enqueue from the watcher to sit unnoticed for 15s. Tight
// loop is fine; the queue.peek() is cheap (in-memory check).
const QUEUE_EMPTY_POLL_MS = 500;
const MAX_QUEUE_ATTEMPTS = 30;

interface EngineOpts {
	environmentId: string;
	adapter: AgentAdapter;
	abort: AbortSignal;
	/** Used by the SSE consumer to abort the whole engine on a 401
	 * — there's no recovery from a revoked deploy-key, so the
	 * daemon should exit and let its supervisor decide whether to
	 * restart. */
	abortController: AbortController;
	/** Force the watcher into poll mode. Set by serve.ts based on
	 * CLAWDI_SERVE_MODE=container. */
	forcePollWatcher?: boolean;
}

export async function runSyncEngine(opts: EngineOpts): Promise<void> {
	// Pass the engine's abort signal so any in-flight HTTP call
	// (heartbeat, scope refresh, skill download, etc.) unwinds
	// immediately when SSE auth fails or shutdown is requested,
	// instead of running its own per-request timeout to
	// completion.
	const api = new ApiClient({ abortSignal: opts.abort });
	// Shutdown-path client: NO abort signal. Used for the final
	// auth-failure heartbeat below. The daemon-wide abort fires on
	// the same call site that wants to send this heartbeat, so
	// reusing `api` would have the abort cancel the request before
	// it reaches the server — the dashboard then sees the daemon
	// go stale with no `last_sync_error`, exactly the signal the
	// heartbeat is meant to deliver. Keeping a small unsignalled
	// client around is cheaper than recomputing the auth header
	// inside `triggerAuthFailureAbort` itself.
	const shutdownApi = new ApiClient();
	// `inFlightSessionHash` is consumed by the watcher's enqueue
	// dedup AND by the queue's onEvict hook below. Declared up-front
	// so the queue's eviction callback can clear stale entries: when
	// the queue evicts a session_push (only happens when the offline
	// queue is full of session_push items), we MUST clear the in-
	// flight hash so the next watcher tick re-enqueues. Without it,
	// the dedup map keeps the dropped session out forever.
	const inFlightSessionHash = new Map<string, string>();
	const queue = new RetryQueue({
		agentType: opts.adapter.agentType,
		onEvict: (item) => {
			if (item.kind === "session_push") {
				const cur = inFlightSessionHash.get(item.local_session_id);
				if (cur === item.content_hash) {
					inFlightSessionHash.delete(item.local_session_id);
				}
			}
		},
	});
	queue.load();

	// last_pushed_hash per skill_key — the hash this daemon last
	// successfully shipped to the cloud (either as a push from
	// local edit, or as a pull confirming "what's on disk now").
	// Hydrated at boot from `~/.clawdi/skills-lock.json` so the
	// initial reconcile can disambiguate "cloud edited while we
	// were offline" (cloud != lastShipped, local == lastShipped →
	// PULL) from "local edited while we were offline" (local !=
	// lastShipped, cloud == lastShipped → PUSH). Without this
	// reference, boot-time divergence defaulted to PUSH and any
	// dashboard edit made while the daemon was off was silently
	// overwritten on next start.
	const lastPushedHash = new Map<string, string>();
	{
		const lock = readSkillsLock();
		const prefix = `${opts.adapter.agentType}:`;
		// Two passes so v2 partitioned entries always win over a
		// v1 flat fallback. The v1 entry might belong to a
		// different agent for multi-agent users (v1 didn't track
		// which agent shipped what); only fall back when no v2
		// entry exists for the same skill_key.
		for (const [k, v] of Object.entries(lock.skills)) {
			if (k.startsWith(prefix) && v?.hash) {
				lastPushedHash.set(k.slice(prefix.length), v.hash);
			}
		}
		// v1 fallback: keys without `${agent}:` prefix are pre-
		// version-bump entries. Hydrate them ONLY when this is
		// a single-agent install — for a multi-agent user, the
		// v1 entry belongs to whichever daemon shipped it, NOT
		// necessarily the daemon currently booting. Pre-fix the
		// fallback applied the v1 hash to every agent that
		// lacked a v2 record, so daemon B's first boot after
		// upgrade saw a phantom `lastShipped` for skills that A
		// had shipped — and `initialSync`'s local-only-with-
		// lastShipped branch then DELETED B's local copy on the
		// premise that "we shipped this before, cloud now
		// missing → remove local". The destructive-remove
		// branch is what makes this hazardous; reading v2-only
		// for multi-agent installs costs a one-time re-push of
		// shared skills (bounded, non-destructive) but
		// guarantees no agent loses state to a sibling's lock.
		const registeredAgents = listRegisteredAgentTypes();
		if (registeredAgents.length <= 1) {
			for (const [k, v] of Object.entries(lock.skills)) {
				if (!k.includes(":") && v?.hash && !lastPushedHash.has(k)) {
					lastPushedHash.set(k, v.hash);
				}
			}
		}
		log.info("engine.skills_lock_loaded", { skill_count: lastPushedHash.size });
	}
	// Skills currently being written by a pull (boot initialSync,
	// reconcile, or sweep). The adapter's writeSkillArchive does
	// `rm -rf <dir> + extract` — for a few ms the dir is empty,
	// the watcher fires on the rm and mkdir events,
	// computeSkillFolderHash returns the empty hash, and
	// enqueueIfChanged would happily push that empty content
	// back to the server.
	//
	// Reference-counted because boot pulls and the reconcile loop
	// can both target the same skill_key in narrow windows; the
	// count tracks how many writes are in flight, and the gate
	// stays closed until ALL of them drain.
	const pullsInFlight = new Map<string, number>();
	// Set of skill_keys we've observed in a cloud listing during
	// this daemon's lifetime. Sweeping (delete-local-when-cloud-
	// gone) only ever considers keys in this set, so a daemon
	// that's never seen the cloud has no authority to delete
	// anything local — and a cloud listing limited to page 1
	// can't trigger a delete of skills that live on page 2+.
	const cloudObservedKeys = new Set<string>();
	let lastSeenRevision: number | null = null;
	// Full ETag string from the last successful /api/skills
	// response. Includes the scope_id (e.g. `"42:abc-uuid"`) so a
	// scope reassignment forces the next listing to round-trip
	// rather than collide on revision alone. We replay the raw
	// string in `If-None-Match` instead of constructing it from
	// `lastSeenRevision`, since the server's format is opaque to
	// the daemon — it could grow more components and we'd silently
	// regress to false 304s on every change.
	let lastListingEtag: string | null = null;
	let lastSyncError: string | null = null;

	// Last content hash we pushed for each session, keyed by
	// local_session_id. Lets the sessions watcher dedup: if the
	// adapter re-enumerates and reports the same content hash we
	// already shipped, we skip enqueue. Hydrated at boot from the
	// same `~/.clawdi/sessions-lock.json` `clawdi push` writes,
	// so a daemon restart doesn't re-push every session it
	// already shipped.
	//
	// Two-map split: `lastPushedSessionHash` is the source of truth
	// — only written after a successful upload (on disk via the
	// session lock). `inFlightSessionHash` is a touch-storm guard
	// for the watcher: once a hash is enqueued we suppress re-
	// enqueue of the same hash on subsequent ticks, but we DO
	// remove the in-flight entry on drop / evict / scope-mismatch
	// so the next watcher tick re-enqueues fresh.
	//
	// Pre-split the code stamped `lastPushedSessionHash` at enqueue
	// time. If the queue then dropped (4xx, max attempts, FIFO
	// eviction during a long offline window) the watcher's dedup
	// kept skipping that session FOREVER — silent permanent loss.
	const lastPushedSessionHash = new Map<string, string>();
	// `inFlightSessionHash` was declared up-front (above queue
	// construction) so the queue's onEvict hook can clear stale
	// hashes when a session_push gets evicted. Reference is the
	// same Map instance.
	{
		const lock = readSessionsLock();
		for (const [k, v] of Object.entries(lock.sessions)) {
			// Lock keys are `<agent_type>:<local_session_id>`. We
			// only care about entries for the agent we're serving.
			const prefix = `${opts.adapter.agentType}:`;
			if (k.startsWith(prefix) && v?.hash) {
				lastPushedSessionHash.set(k.slice(prefix.length), v.hash);
			}
		}
		log.info("engine.sessions_lock_loaded", {
			session_count: lastPushedSessionHash.size,
		});
	}

	const rootDir = opts.adapter.getSkillsRootDir();

	const stateDir = getServeStateDir(opts.adapter.agentType);
	await mkdir(stateDir, { recursive: true });

	log.info("engine.start", {
		environment_id: opts.environmentId,
		agent_type: opts.adapter.agentType,
		root_dir: rootDir,
		state_dir: stateDir,
	});

	// Fetch this env's default_scope_id at boot. The daemon writes
	// to `/api/scopes/{scope_id}/skills/upload`, so we need the
	// scope_id before any upload can run. Throw on missing so the
	// supervisor restarts — without a scope_id we can't tell which
	// SSE events belong to us.
	const fetchDefaultScopeId = async (): Promise<string> => {
		const envInfo = unwrap(
			await api.GET("/api/environments/{environment_id}", {
				params: { path: { environment_id: opts.environmentId } },
			}),
		);
		const scopeId = envInfo.default_scope_id;
		if (!scopeId) {
			throw new Error(`environment ${opts.environmentId} has no default_scope_id; cannot upload`);
		}
		return scopeId;
	};
	// Boot-time auth-failure handling: `fetchDefaultScopeId()`
	// throws ApiError on 401/403 if the daemon was started with a
	// revoked / forbidden key. Pre-fix this bubbled up as a
	// generic fatal — `serve()` set process.exitCode=1, which
	// systemd's `RestartPreventExitStatus=2` doesn't suppress, so
	// the daemon respawned every 10s in a tight loop with no
	// auth_revoked heartbeat for the dashboard to surface. Exit
	// with code 2 so systemd stops respawning + log the canonical
	// `engine.auth_failed` event so /api/health and operators see
	// a clean reason. (No best-effort heartbeat from this point
	// because the daemon hasn't established its scope/queue state
	// yet — there's nothing meaningful to report beyond "auth dead
	// at boot".)
	let defaultScopeId: string;
	try {
		defaultScopeId = await fetchDefaultScopeId();
	} catch (e) {
		if (isAuthFailure(e)) {
			log.error("engine.auth_failed", { origin: "boot_scope_fetch" });
			process.exitCode = 2;
			// Same launchd self-unload as the main auth-failure
			// handler below — boot-time auth failure also needs
			// supervision removal on macOS or launchd respawns
			// the daemon every 10s.
			if (process.platform === "darwin" && opts.adapter.agentType) {
				try {
					const { execFile } = await import("node:child_process");
					execFile("launchctl", ["remove", `ai.clawdi.serve.${opts.adapter.agentType}`], () => {});
				} catch {
					/* launchctl missing, fall through */
				}
			}
			opts.abortController.abort();
			return;
		}
		throw e;
	}
	log.info("engine.scope_resolved", { default_scope_id: defaultScopeId });

	// Single auth-failure exit path. SSE consumer wires this directly
	// via `onAuthFailure`; pull-side catches (SSE skill_changed handler
	// and reconcile loop) detect 401/403 via `isAuthFailure` and call
	// this on their own — without it, a daemon doing only pulls (no
	// pending pushes) would loop indefinitely on a revoked key,
	// surfacing nothing to the user. The flag prevents redundant
	// heartbeats / log spam if multiple callsites trip at once.
	let authFailureFired = false;
	const triggerAuthFailureAbort = (origin: string): void => {
		if (authFailureFired) return;
		authFailureFired = true;
		log.error("engine.auth_failed", { origin });
		// Set the user-visible error BEFORE the abort so a final-
		// best-effort heartbeat (sent on the way down) carries the
		// reason. Without this the dashboard just shows "paused" / no
		// error and the user has no idea their key was revoked.
		lastSyncError = "auth_revoked: api key rejected by server";
		// Best-effort final heartbeat. We don't await — the abort
		// fires on the same tick — but kicking off the POST before
		// the abort gives the request a fighting chance to land.
		// Use the shutdownApi (no abortSignal) so the daemon-wide
		// abort below doesn't cancel this exact request mid-flight;
		// otherwise the dashboard never sees the
		// `auth_revoked` `last_sync_error` and the daemon just
		// "goes stale" silently.
		void shutdownApi
			.POST("/api/agents/{environment_id}/sync-heartbeat", {
				params: { path: { environment_id: opts.environmentId } },
				body: {
					// Report the peak since boot, not current depth.
					// The dashboard's "queue depth high water"
					// indicator should reflect transient spikes the
					// daemon saw between heartbeats; sampling
					// `queue.depth` at heartbeat time misses spikes
					// that drained before the next sample.
					queue_depth: queue.highWaterMark,
					dropped_count_delta: 0,
					last_revision_seen: lastSeenRevision,
					last_sync_error: lastSyncError,
				},
			})
			.catch(() => {
				/* best effort */
			});
		// Exit 2: the systemd unit (see installer.ts) carries
		// `RestartPreventExitStatus=2` to opt out of restart for
		// genuinely-broken configs. Auth-revoked is the canonical
		// such state — the key won't fix itself, restarting every
		// 10s in a tight loop just spams the journal and the
		// /api/sync/events endpoint with handshakes that 401. Code
		// 1 (default failure) would have been respawned forever.
		process.exitCode = 2;
		// macOS launchd has no `RestartPreventExitStatus` equivalent
		// — its `KeepAlive=true` respawns on ANY exit, including our
		// deliberate 2. Self-unload via `launchctl remove <label>`
		// before exiting so launchd drops us from supervision and
		// the same revoked key isn't retried every 10s. Best-effort:
		// failures (non-installed daemon, no launchctl in PATH) just
		// fall through to the abort + exit 2 path below.
		if (process.platform === "darwin" && opts.adapter.agentType) {
			void (async () => {
				try {
					const { execFile } = await import("node:child_process");
					execFile("launchctl", ["remove", `ai.clawdi.serve.${opts.adapter.agentType}`], () => {
						// fire-and-forget; the daemon is exiting anyway
					});
				} catch {
					/* launchctl missing, ignore — the manual
					 * `launchctl unload` from the user is the
					 * fallback. */
				}
			})();
		}
		opts.abortController.abort();
	};

	// Periodically re-fetch the env's default_scope_id so a
	// runtime reassignment (rare in v1's 1:1 model, but possible
	// after multi-scope-per-env ships) converges within one
	// heartbeat cycle. Without refresh, the daemon would keep
	// the boot-time value forever and silently drop SSE events
	// for the new scope. Transient fetch errors keep the
	// last-known-good value but escalate to error-level logging
	// after STALE_SCOPE_THRESHOLD consecutive failures so a
	// long-running scope-filter outage shows up in metrics.
	const STALE_SCOPE_THRESHOLD = 3;
	const refreshDefaultScopeIdLoop = async (abort: AbortSignal): Promise<void> => {
		let consecutiveFailures = 0;
		while (!abort.aborted) {
			await sleep(HEARTBEAT_INTERVAL_MS, abort);
			if (abort.aborted) return;
			try {
				const fresh = await fetchDefaultScopeId();
				if (fresh !== defaultScopeId) {
					log.info("engine.scope_changed", { from: defaultScopeId, to: fresh });
					defaultScopeId = fresh;
					// Cached ETag was bound to the OLD scope; sending it
					// after the scope flip would always miss anyway
					// (server now bakes scope_id into the tag), but
					// clearing here saves the wasted round-trip and
					// makes the intent explicit. lastSeenRevision can
					// stay — the server's revision counter is account-
					// wide, and the next listing will refresh both.
					lastListingEtag = null;
					// Re-scan local skills against `lastPushedHash` so
					// any pending divergence (including queue items the
					// drain dropped after a scope change) gets re-
					// enqueued under the new scope. Without this, an
					// edit captured under scope A that was dropped
					// during a brief A→B→A reassignment would sit
					// unsynced until the user touched the file again.
					await rescanLocalSkillsForChanges(
						opts,
						queue,
						lastPushedHash,
						pullsInFlight,
						() => fresh,
					).catch((e) => {
						log.warn("engine.scope_change_rescan_failed", {
							error: toErrorMessage(e),
						});
					});
				}
				consecutiveFailures = 0;
			} catch (e) {
				if (isAuthFailure(e)) {
					triggerAuthFailureAbort("scope_refresh");
					return;
				}
				consecutiveFailures += 1;
				const fields = {
					error: toErrorMessage(e),
					consecutive_failures: consecutiveFailures,
					stale_scope_id: defaultScopeId,
				};
				if (consecutiveFailures >= STALE_SCOPE_THRESHOLD) {
					log.error("engine.scope_filter_stale", fields);
				} else {
					log.warn("engine.scope_filter_refresh_failed", fields);
				}
			}
		}
	};

	// Initial sync: enumerate local AND fetch cloud, then resolve
	// per skill_key (push, pull, no-op). Done inline before any
	// loops so the first tick's watcher events don't trip
	// echo-suppression on stale cache. If the cloud listing fails,
	// fail closed — without a baseline we can't tell user edits
	// from new pulls and could blind-overwrite the cloud.
	//
	// Auth failures during initialSync (token revoked between the
	// env lookup and /api/skills, or a deploy key with
	// `skills:read` removed) MUST route through
	// `triggerAuthFailureAbort` so the daemon exits with code 2
	// — supervised installs depend on
	// `RestartPreventExitStatus=2` (systemd) and the launchd
	// self-unload to break the restart loop. Pre-fix the 401/403
	// bubbled out as a generic Error, serve() exited with code 1,
	// and launchd / systemd kept respawning indefinitely.
	try {
		await initialSync(
			opts,
			api,
			queue,
			lastPushedHash,
			cloudObservedKeys,
			pullsInFlight,
			defaultScopeId,
			(rev) => {
				lastSeenRevision = rev;
			},
			(etag) => {
				lastListingEtag = etag;
			},
		);
	} catch (e) {
		if (isAuthFailure(e)) {
			triggerAuthFailureAbort("initial_sync");
			// Wait for the abort to propagate so the heartbeat lands
			// before the process exits. The same shape SSE / drain /
			// reconcile use after triggerAuthFailureAbort.
			return;
		}
		throw e;
	}
	lastSyncError = null;

	// Push side: wire watcher → enqueue.
	const onLocalChange = (skillKey: string) => {
		if (pullsInFlight.has(skillKey)) {
			// Our own writeSkillArchive is in progress for this
			// skill. Watcher events fired during that window
			// reflect intermediate states (empty dir between
			// rm and extract), not user edits.
			return;
		}
		void enqueueIfChanged(opts, queue, lastPushedHash, skillKey, () => defaultScopeId).catch(
			(e) => {
				log.warn("engine.enqueue_failed", { skill_key: skillKey, error: toErrorMessage(e) });
			},
		);
	};

	// Pull side: SSE event → fetch + writeSkillArchive (or rm).
	// Server-side broker already filters events to scopes the
	// caller has visibility into; the per-event scope check below
	// is defense-in-depth in case a future broker bug fans out
	// without filtering.
	const onServerEvent = async (event: ServerEvent) => {
		if (event.scope_id !== defaultScopeId) {
			log.debug("engine.sse_event_other_scope", {
				type: event.type,
				skill_key: event.skill_key,
				event_scope: event.scope_id,
				my_scope: defaultScopeId,
			});
			// Do NOT advance `lastSeenRevision` here. For unbound
			// multi-agent CLI keys the SSE stream interleaves events
			// across sibling scopes; advancing on a sibling event
			// would let the next reconcile send `If-None-Match:
			// <sibling-rev>` and get 304 even if WE missed an
			// earlier event for our own scope (e.g. brief SSE
			// disconnect). The reconcile would then never pull the
			// missed change, and the safety-net poll silently
			// misses it. `lastSeenRevision` represents
			// "highest revision we've fully reconciled FOR OUR
			// SCOPE"; sibling events don't grant that.
			return;
		}
		log.info("engine.sse_event", { type: event.type, skill_key: event.skill_key });
		// `lastSeenRevision` is the conditional-GET ETag the
		// reconcile uses. Advance it ONLY after local state has
		// converged to the event's revision; if the pull/delete
		// fails transiently, leave it stale so the next reconcile
		// re-fetches the listing (won't 304) and the safety-net
		// sweep / pull retries the failed item. Pre-fix this line
		// advanced unconditionally, so a transient
		// download/extract/remove failure was silently dropped
		// until some unrelated cloud change next bumped the
		// revision.
		if (event.type === "skill_deleted") {
			addInFlight(pullsInFlight, event.skill_key);
			let applied = false;
			try {
				await opts.adapter.removeLocalSkill(event.skill_key);
				lastPushedHash.delete(event.skill_key);
				// Drop the on-disk lock entry too; otherwise a future
				// daemon restart would see "shipped before, cloud
				// missing" and re-enter the boot remove-or-push
				// branch on a key that's already been deleted.
				const lock = readSkillsLock();
				delete lock.skills[skillCacheKey(opts.adapter.agentType, event.skill_key)];
				writeSkillsLock(lock);
				log.info("engine.skill_deleted_local", { skill_key: event.skill_key });
				applied = true;
			} catch (e) {
				log.warn("engine.skill_delete_failed", {
					skill_key: event.skill_key,
					error: toErrorMessage(e),
				});
			} finally {
				releaseInFlight(pullsInFlight, event.skill_key);
			}
			if (applied) lastSeenRevision = event.skills_revision;
			return;
		}
		// skill_changed: echo suppression. If the event's
		// content_hash matches what we last successfully pushed for
		// this key, the cloud is just bouncing our own upload back
		// at us via SSE — pulling would clobber a fresher local
		// edit (the user might have already typed past the bytes
		// we sent) with the bytes we just shipped. The reconcile
		// loop catches anything we suppress here in error.
		// Local state is already at this revision (we wrote it),
		// so it IS safe to advance lastSeenRevision here.
		if (event.content_hash && lastPushedHash.get(event.skill_key) === event.content_hash) {
			log.debug("engine.sse_self_echo_suppressed", {
				skill_key: event.skill_key,
				content_hash: event.content_hash,
			});
			lastSeenRevision = event.skills_revision;
			return;
		}
		addInFlight(pullsInFlight, event.skill_key);
		let pulled = false;
		try {
			await pullSkill(opts, api, event.skill_key, lastPushedHash, defaultScopeId);
			// Track the SSE-pulled skill in cloudObservedKeys so the
			// reconcile sweep can later remove it if its delete event
			// is missed. Without this, an SSE-installed skill that
			// later gets a missed `skill_deleted` would never be
			// swept locally — `cloudObservedKeys` is the safety-net
			// boundary the sweep uses to avoid wiping local-only
			// skills, so anything we pulled needs to be in it.
			cloudObservedKeys.add(event.skill_key);
			pulled = true;
		} catch (e) {
			// 401/403 here means the key the daemon's been using is
			// now rejected. Without an explicit abort the catch just
			// log-warns and the daemon keeps trying — a pull-only
			// daemon (push queue empty) would never trip the queue
			// drain's auth-abort path. Trigger the same exit the SSE
			// channel uses so the user actually sees "paused".
			if (isAuthFailure(e)) {
				triggerAuthFailureAbort("sse_skill_pull");
				return;
			}
			log.warn("engine.pull_failed", {
				skill_key: event.skill_key,
				error: toErrorMessage(e),
			});
		} finally {
			releaseInFlight(pullsInFlight, event.skill_key);
		}
		if (pulled) lastSeenRevision = event.skills_revision;
	};

	// Triggered by the sessions watcher after a path has been
	// quiet for `STABLE_AFTER_MS`. Re-enumerates the adapter's
	// sessions, hashes each, and enqueues a `session_push` for any
	// whose content_hash has changed since we last pushed. The
	// watcher itself doesn't know which session changed; this
	// function is the source-of-truth diff against the in-memory
	// + persisted lock.
	const onSessionsStable = async () => {
		try {
			const { sessions } = await opts.adapter.collectSessions();
			let enqueued = 0;
			for (const s of sessions) {
				const hash = createHash("sha256").update(JSON.stringify(s.messages)).digest("hex");
				// Skip if confirmed-shipped OR currently in flight with
				// the same content. Both are dedup signals; the in-flight
				// map gets cleared on drop/evict so the next watcher
				// tick re-enqueues if upload didn't actually land.
				if (lastPushedSessionHash.get(s.localSessionId) === hash) continue;
				if (inFlightSessionHash.get(s.localSessionId) === hash) continue;
				queue.enqueue({
					kind: "session_push",
					local_session_id: s.localSessionId,
					content_hash: hash,
					enqueued_at: new Date().toISOString(),
					attempts: 0,
				});
				inFlightSessionHash.set(s.localSessionId, hash);
				enqueued += 1;
			}
			if (enqueued > 0) {
				log.info("engine.sessions_enqueued", { count: enqueued });
			}
		} catch (e) {
			log.warn("engine.sessions_enumerate_failed", { error: toErrorMessage(e) });
		}
	};

	// Run all background tasks concurrently.
	await Promise.all([
		watchSkills({
			rootDir,
			abort: opts.abort,
			onSkillChanged: onLocalChange,
			forcePoll: opts.forcePollWatcher,
			// Map a changed path-from-root to its owning skill_key.
			// Walks up from the leaf looking for SKILL.md so a
			// Hermes nested edit at `category/foo/SKILL.md`
			// resolves to `category/foo` (not `category`). For
			// flat adapters the path's first component already has
			// SKILL.md, so the walk returns immediately. Returns
			// `null` for paths that don't live inside any skill yet
			// (e.g. a freshly-mkdir'd category before its SKILL.md
			// lands) — the caller skips emission rather than
			// pushing a bogus key.
			resolveSkillKey: (pathFromRoot) => resolveOwningSkillKey(rootDir, pathFromRoot),
			// Same intent as `resolveSkillKey` but for poll-mode
			// snapshots. Poll mode samples the full set of
			// skill_keys instead of resolving from a changed
			// path, so it needs the adapter's own enumerator
			// (Hermes recurses into category dirs; flat adapters
			// do a top-level walk). Without this the poll
			// snapshot tracks only `category` (a directory
			// without its own SKILL.md) and any nested edit
			// either reports the wrong key OR is missed entirely
			// because the dir's own mtime didn't change.
			listSkillKeys: () => opts.adapter.listSkillKeys(),
		}),
		watchSessions({
			paths: opts.adapter.getSessionsWatchPaths(),
			abort: opts.abort,
			onPathStable: () => {
				// Fire-and-forget — onPathStable is a sync callback
				// from the watcher, but the enumeration can be slow
				// (hundreds of JSONLs). Catch errors here so a
				// transient FS error never breaks the watcher loop.
				void onSessionsStable();
			},
			forcePoll: opts.forcePollWatcher,
		}),
		consumeSse({
			apiUrl: api.baseUrl,
			apiKey: api.apiKey,
			abort: opts.abort,
			onEvent: onServerEvent,
			onConnect: () => {
				lastSyncError = null;
			},
			onDisconnect: (reason) => {
				lastSyncError = `sse_disconnect:${reason}`;
			},
			onAuthFailure: () => triggerAuthFailureAbort("sse_channel"),
		}),
		drainQueueLoop(
			opts,
			api,
			queue,
			lastPushedHash,
			lastPushedSessionHash,
			inFlightSessionHash,
			() => defaultScopeId,
			(err) => {
				lastSyncError = err;
			},
			triggerAuthFailureAbort,
		),
		reconcileLoop(
			opts,
			api,
			lastPushedHash,
			cloudObservedKeys,
			pullsInFlight,
			opts.abort,
			() => defaultScopeId,
			() => lastListingEtag,
			(rev) => {
				lastSeenRevision = rev;
			},
			(etag) => {
				lastListingEtag = etag;
			},
			triggerAuthFailureAbort,
		),
		heartbeatLoop(opts, api, queue, opts.abort, () => ({
			last_revision_seen: lastSeenRevision,
			last_sync_error: lastSyncError,
		})),
		refreshDefaultScopeIdLoop(opts.abort),
		// Safety-net periodic sessions rescan. After a 4xx drop we
		// clear inFlightSessionHash, but the watcher only fires on
		// fs change — if the file isn't rewritten the session
		// stays unsynced forever. A 5min full re-enumerate catches
		// these. Cheap (just stat + hash) and the inFlight/lastPushed
		// dedup keeps it from re-enqueuing unchanged content.
		(async () => {
			while (!opts.abort.aborted) {
				await sleep(5 * 60_000, opts.abort);
				if (opts.abort.aborted) return;
				await onSessionsStable();
			}
		})(),
		// Symmetric safety-net for SKILLS. The queue evicts
		// `skill_push` items first when offline buffers fill, but
		// the watcher only emits on fs changes; an evicted edit
		// would never be re-enqueued until the user touched the
		// skill again. `rescanLocalSkillsForChanges` walks every
		// skill dir, hashes it, compares against `lastPushedHash`,
		// and enqueues whatever's drifted. Same 5min cadence as
		// the sessions rescan; same cheap (stat+hash) shape with
		// the same dedup short-circuit.
		(async () => {
			while (!opts.abort.aborted) {
				await sleep(5 * 60_000, opts.abort);
				if (opts.abort.aborted) return;
				await rescanLocalSkillsForChanges(
					opts,
					queue,
					lastPushedHash,
					pullsInFlight,
					() => defaultScopeId,
				).catch((e) => {
					log.warn("engine.skills_rescan_failed", { error: toErrorMessage(e) });
				});
			}
		})(),
	]);

	log.info("engine.stop", {});
}

async function enqueueIfChanged(
	opts: EngineOpts,
	queue: RetryQueue,
	lastPushedHash: Map<string, string>,
	skillKey: string,
	getScopeId: () => string,
): Promise<void> {
	const dir = join(opts.adapter.getSkillsRootDir(), skillKey);
	let hash: string;
	try {
		hash = await computeSkillFolderHash(dir);
	} catch (e) {
		// Directory disappeared (skill deleted). v1 doesn't
		// support push-deletes from daemon; the user does that
		// from the dashboard. Just stop tracking it.
		lastPushedHash.delete(skillKey);
		log.debug("engine.skill_dir_gone", { skill_key: skillKey, error: toErrorMessage(e) });
		return;
	}
	if (lastPushedHash.get(skillKey) === hash) {
		// Echo from a cloud-originated write or a no-op touch.
		log.debug("engine.skill_unchanged", { skill_key: skillKey });
		return;
	}
	// Stamp the current scope_id on the queue item. If the daemon's
	// default_scope_id changes between enqueue and drain (rare in
	// v1, but possible when multi-scope-per-env arrives), we drop
	// the stamped item rather than upload it under a different
	// scope. Without the stamp, a queue carrying writes under
	// scope A would silently get redirected to scope B on
	// reassignment.
	const version = queue.enqueue({
		kind: "skill_push",
		skill_key: skillKey,
		scope_id: getScopeId(),
		new_hash: hash,
		enqueued_at: new Date().toISOString(),
		attempts: 0,
	});
	log.info("engine.enqueue_skill_push", {
		skill_key: skillKey,
		new_hash: hash,
		version,
		queue_depth: queue.depth,
	});
}

/** Auth failure on upload OR pull: not "permanent for this item"
 * — the api key is dead and EVERY request will fail the same way.
 * Pull-side callers (SSE skill_changed handler, reconcile loop)
 * use this to short-circuit log-and-continue retry storms; push-
 * side uses it to skip the queue-drop classifier.
 * Exported only for unit testing. */
export function isAuthFailure(e: unknown): boolean {
	if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return true;
	return false;
}

/**
 * Returns true when the failure is something that won't fix itself
 * by trying again later — typically a request the server rejected
 * on shape (size cap, malformed archive, schema-failed body) or a
 * client-side guard we threw before the request even left.
 *
 * Hot signals:
 *   - HTTP 4xx other than 408 (request timeout — transient), 429
 *     (rate limited — explicitly retry-friendly), 401/403 (auth
 *     dead — handled separately by `isAuthFailure`, NOT by drop)
 *   - Local errors with a known permanent shape: oversized tar,
 *     symlinks pointing outside the trust zone (the user has to
 *     edit the skill, no amount of retry helps)
 *
 * 5xx, network errors, timeouts → NOT permanent. Those are the
 * retry queue's whole reason to exist.
 */
function isPermanentUploadError(e: unknown): boolean {
	if (e instanceof ApiError) {
		if (e.status >= 400 && e.status < 500) {
			// 408 = server-side request timeout; the daemon should
			// retry. 429 = rate limit; retry with backoff (the queue
			// already paces). 401/403 = auth dead, handled separately
			// (drop would silently lose work; we abort instead).
			if (e.status === 408 || e.status === 429) return false;
			if (e.status === 401 || e.status === 403) return false;
			return true;
		}
		return false;
	}
	if (e instanceof Error) {
		// Match on message content for the two pre-flight rejections
		// thrown by `tarSkillDir`. These are pure client-side errors
		// — the request never even goes out, so retrying just
		// re-throws the same exception 30 times.
		const m = e.message;
		if (m.includes("symlink(s) pointing outside")) return true;
		if (m.includes("Skill tarball exceeds")) return true;
	}
	return false;
}

/**
 * Subset of permanent failures that mean "the skill is just too big
 * to sync" (server 413 or pre-flight size guard). These aren't user
 * misconfigurations — they're a known capacity limit. We still drop
 * the queue item (retrying won't shrink the tar) but at `warn` level
 * and without poisoning the heartbeat with `permanent:` — the
 * dashboard shouldn't scream at the user about a skill they didn't
 * ask to upload (e.g. the gstack meta-skill ships a 60 MB bundled
 * binary that's larger than the cap).
 */
export function isOversizedUploadError(e: unknown): boolean {
	if (e instanceof ApiError && e.status === 413) return true;
	if (e instanceof Error && e.message.includes("Skill tarball exceeds")) return true;
	return false;
}

async function drainQueueLoop(
	opts: EngineOpts,
	api: ApiClient,
	queue: RetryQueue,
	lastPushedHash: Map<string, string>,
	lastPushedSessionHash: Map<string, string>,
	inFlightSessionHash: Map<string, string>,
	getScopeId: () => string,
	setLastError: (err: string | null) => void,
	onAuthFailure: (origin: string) => void,
): Promise<void> {
	// Clear the in-flight stamp for a session_push item so the
	// next watcher tick will re-enqueue if the local content
	// hasn't already been confirmed shipped. Skill_push items have
	// their own `lastPushedHash` write inside upload-success and
	// don't need this — those hashes go to the on-disk lock only
	// after a 200, no separate in-flight map.
	const clearInFlight = (item: QueueItem) => {
		if (item.kind === "session_push") {
			const cur = inFlightSessionHash.get(item.local_session_id);
			if (cur === item.content_hash) {
				inFlightSessionHash.delete(item.local_session_id);
			}
		}
	};
	while (!opts.abort.aborted) {
		const item = queue.peek();
		if (!item) {
			await sleep(QUEUE_EMPTY_POLL_MS, opts.abort);
			continue;
		}
		try {
			await processQueueItem(
				opts,
				api,
				queue,
				item,
				lastPushedHash,
				lastPushedSessionHash,
				inFlightSessionHash,
				getScopeId(),
			);
			setLastError(null);
		} catch (e) {
			const msg = toErrorMessage(e);
			setLastError(msg);
			// Auth dead → daemon abort, not queue drop. Every
			// upload from this point will fail the same way
			// because the api key is revoked. Dropping the queue
			// item would lose its work; aborting the daemon makes
			// the OS supervisor's restart bring the user's
			// attention to it (status badge flips to "errored",
			// dialog shows "log in again with `clawdi auth login`").
			if (isAuthFailure(e)) {
				log.error("engine.queue_auth_failure", {
					item: redactItem(item),
					error: msg,
				});
				// Route through the unified auth-failure path so
				// `process.exitCode = 2` (systemd "don't respawn")
				// and the final `last_sync_error="auth_revoked"`
				// heartbeat both fire. Direct `abortController.abort()`
				// left the
				// daemon exiting with code 0 and the dashboard
				// showing "paused" instead of the revoke reason.
				// The item stays in the queue for when the daemon
				// comes back up with valid auth.
				onAuthFailure("queue_upload");
				return;
			}
			// Compute the post-bump attempt count from the item we
			// observed, NOT by re-fetching from the queue. Between
			// `bumpAttempts` and a fresh `.find`, the watcher can
			// have superseded this item with a v=N+1 (attempts=0),
			// so the .find returns the new item and the max-attempts
			// drop never fires. Trusting the local count keeps the
			// drop decision tied to the item we actually processed.
			const newAttempts = item.attempts + 1;
			queue.bumpAttempts(item);
			if (isOversizedUploadError(e)) {
				// Skill bigger than the server cap. Not a bug, not a
				// user misconfiguration — just a capacity limit. Drop
				// quietly (warn-level, no heartbeat poison) so the
				// dashboard doesn't scream and the daemon's queue
				// doesn't spin retrying a tar that will never shrink.
				log.warn("engine.queue_drop_oversized", {
					item: redactItem(item),
					error: msg,
				});
				// Override the eager `setLastError(msg)` at the top of
				// this catch — pre-fix the dashboard surfaced "API
				// error 413: Skill tarball exceeds 26214400 bytes /
				// It will keep retrying" because the raw msg leaked
				// into the heartbeat. The dropped-events counter
				// (incremented below) is the right signal for "we
				// skipped some content"; the heartbeat last_error
				// should stay clean so the user only sees alarms
				// for things that actually need attention.
				setLastError(null);
				queue.recordPermanentDrop();
				clearInFlight(item);
				queue.markDoneIfVersion(item);
			} else if (isPermanentUploadError(e)) {
				// 4xx that won't change on retry — malformed body,
				// schema validation, etc. Retrying 30 times costs the
				// user 7.5 minutes of log spam and network for
				// guaranteed-zero-progress; drop now and surface the
				// reason once so the user can fix it.
				log.error("engine.queue_drop_permanent", {
					item: redactItem(item),
					error: msg,
				});
				// Stamp the heartbeat error with a `permanent:`
				// prefix so the dashboard knows this is NOT going
				// to recover on its own — pre-fix the UI showed
				// the same "It will keep retrying" copy whether the
				// item was mid-retry or permanently dropped, which
				// is the opposite of what's true: retrying-zero
				// means the user has to fix the source (e.g. trim
				// a too-big skill) and re-push manually. Mirrors
				// the existing `auth_revoked:` / `sse_disconnect:`
				// prefix convention.
				setLastError(`permanent: ${msg}`);
				// Bump the dropped counter so the dashboard's
				// "dropped" pill shows non-evict drops too. Pre-fix
				// only FIFO eviction ticked the counter and a 4xx-
				// rejected session vanished without any UI signal.
				queue.recordPermanentDrop();
				clearInFlight(item);
				queue.markDoneIfVersion(item);
			} else if (newAttempts >= MAX_QUEUE_ATTEMPTS) {
				log.error("engine.queue_drop_max_attempts", {
					item: redactItem(item),
					error: msg,
				});
				// `retry_exhausted:` prefix is distinct from
				// `permanent:`. r12 originally lumped both under
				// `permanent:`, but the UI branch for that prefix
				// reads "fix the source and re-save" — wrong copy
				// for max-attempts because the periodic 5-minute
				// rescan re-enqueues the same content automatically
				// once the transient condition (network outage,
				// 5xx, 408/429) clears. Source files are unchanged;
				// no user action required. The dashboard branches
				// on this prefix separately to show "the daemon
				// gave up retrying for now; the next sync cycle
				// will pick this up automatically once connectivity
				// is back."
				setLastError(`retry_exhausted: ${msg}`);
				queue.recordPermanentDrop();
				clearInFlight(item);
				queue.markDoneIfVersion(item);
			} else {
				log.warn("engine.queue_retry", {
					item: redactItem(item),
					error: msg,
					attempts: newAttempts,
				});
				await sleep(QUEUE_RETRY_INTERVAL_MS, opts.abort);
			}
		}
	}
}

async function processQueueItem(
	opts: EngineOpts,
	api: ApiClient,
	queue: RetryQueue,
	item: QueueItem,
	lastPushedHash: Map<string, string>,
	lastPushedSessionHash: Map<string, string>,
	inFlightSessionHash: Map<string, string>,
	scopeId: string,
): Promise<void> {
	if (item.kind === "skill_push") {
		// Legacy items (no scope_id stamp) inherit the current
		// scope — they were enqueued by an older binary that
		// didn't track scope. Items with a stamped scope that
		// no longer matches the daemon's current scope are
		// dropped: uploading to the old scope would land bytes
		// nobody is looking at, and uploading to the new scope
		// is wrong because the local content corresponds to
		// whatever the user edited under the OLD scope's view.
		// `rescanLocalSkillsForChanges` (called from
		// refreshDefaultScopeIdLoop on scope change) re-enqueues
		// any pending divergence under the new scope.
		if (item.scope_id !== undefined && item.scope_id !== scopeId) {
			log.warn("engine.queue_scope_mismatch_dropped", {
				skill_key: item.skill_key,
				stamped_scope: item.scope_id,
				current_scope: scopeId,
			});
			queue.markDoneIfVersion(item);
			return;
		}
		await uploadSkillFromQueue(opts, api, item, lastPushedHash, scopeId);
		// markDoneIfVersion — if a newer version of the same
		// skill_key was enqueued while we were uploading, leave
		// it in the queue so the next drain picks it up. The
		// upload we just finished was the OLD version; the new
		// one still needs to ship.
		const removed = queue.markDoneIfVersion(item);
		if (!removed) {
			log.info("engine.queue_superseded", {
				skill_key: item.skill_key,
				version: item.version,
			});
		}
		return;
	}
	if (item.kind === "session_push") {
		const result = await uploadSessionFromQueue(opts, api, item);
		// Move the hash from in-flight (touch-storm guard) to
		// confirmed-pushed (source of truth for re-enqueue dedup).
		// Doing this AFTER the upload returns means a queue evict /
		// drop / retry-exhaust path leaves no stale "we shipped this"
		// claim — the next watcher tick will re-enqueue the same
		// content because nothing has marked it confirmed.
		//
		// Use the hash uploadSessionFromQueue ACTUALLY uploaded —
		// not `item.content_hash` (the watcher's snapshot at
		// enqueue time). If a chat append landed between enqueue
		// and drain, the live `session.messages` we just shipped
		// has a different hash; stamping the stale value would
		// short-circuit a future re-push on the wrong hash. When
		// the session vanished mid-flight (`result === null`),
		// leave the in-memory state untouched so the next watcher
		// tick can decide.
		if (result !== null) {
			lastPushedSessionHash.set(item.local_session_id, result.actualHash);
		}
		const cur = inFlightSessionHash.get(item.local_session_id);
		if (cur === item.content_hash) {
			inFlightSessionHash.delete(item.local_session_id);
		}
		const removed = queue.markDoneIfVersion(item);
		if (!removed) {
			log.info("engine.queue_superseded", {
				local_session_id: item.local_session_id,
				version: item.version,
			});
		}
		return;
	}
	const _exhaustive: never = item;
	log.warn("engine.queue_unknown_kind", { item: _exhaustive });
}

/** Upload a single session via the same two-step `clawdi push`
 * uses: POST /api/sessions/batch (metadata) → POST
 * /api/sessions/{id}/upload (content) when the server says it
 * needs the bytes. Idempotent: if metadata + content_hash already
 * match what the server has, the batch returns "unchanged" and we
 * skip the content step.
 *
 * The daemon path doesn't carry user-visible spinners; we only
 * log success / failure. For the bigger picture see
 * `commands/push.ts:pushOneAgent` which is the user-facing
 * counterpart that this borrows from. */
async function uploadSessionFromQueue(
	opts: EngineOpts,
	api: ApiClient,
	item: Extract<QueueItem, { kind: "session_push" }>,
): Promise<{ actualHash: string } | null> {
	// Re-enumerate via the adapter so we always upload current
	// content. Filter to the single local_session_id we were asked
	// to push; if the user deleted the session between enqueue and
	// drain, we just no-op.
	const { sessions } = await opts.adapter.collectSessions();
	const session = sessions.find((s) => s.localSessionId === item.local_session_id);
	if (!session) {
		log.info("engine.session_gone", { local_session_id: item.local_session_id });
		return null;
	}
	if (session.messages.length === 0) {
		// Session file exists but parsed empty — push the metadata
		// row anyway so the dashboard knows the session existed,
		// but skip the content blob.
		log.debug("engine.session_empty", { local_session_id: item.local_session_id });
	}

	// Recompute the hash from the actual bytes we're about to
	// upload. The queued `item.content_hash` was captured by the
	// watcher; if a chat append landed between enqueue and drain
	// (active conversation, common case), `session.messages` is
	// the newer state but `item.content_hash` is stale. Sending
	// the stale hash + new bytes leaves the row's `content_hash`
	// describing different bytes than the blob — a future push
	// short-circuits on the cached hash and never re-uploads. The
	// skill_push path already follows this pattern (recompute at
	// upload time); align session_push.
	const actualHash = createHash("sha256").update(JSON.stringify(session.messages)).digest("hex");

	const result = unwrap(
		await api.POST("/api/sessions/batch", {
			body: {
				sessions: [
					{
						environment_id: opts.environmentId,
						local_session_id: session.localSessionId,
						project_path: session.projectPath,
						started_at: session.startedAt.toISOString(),
						ended_at: session.endedAt?.toISOString() ?? null,
						last_activity_at: computeLastActivityIso(session),
						duration_seconds: session.durationSeconds,
						message_count: session.messageCount,
						input_tokens: session.inputTokens,
						output_tokens: session.outputTokens,
						cache_read_tokens: session.cacheReadTokens,
						model: session.model,
						models_used: session.modelsUsed,
						summary: session.summary,
						status: "completed",
						content_hash: actualHash,
					},
				],
			},
		}),
	);

	// Server flagged this id as a cross-env race casualty (see
	// SessionBatchResponse.rejected). Don't upload content, don't
	// persist the lock, and crucially DON'T return the actualHash
	// — the caller treats `{ actualHash }` as success and writes
	// it to `lastPushedSessionHash`, which would then dedup the
	// next watcher / rescan tick and stick the daemon at "already
	// shipped" until restart. Returning `null` shares the same
	// "leave in-memory state untouched" path used for vanished
	// sessions: the queue item still gets removed, but
	// lastPushedSessionHash stays empty for this id, so the 5min
	// rescan re-enqueues and the next pre-fetch will see the
	// winner's row and return a clean 409 to retry against.
	if (result.rejected?.includes(session.localSessionId)) {
		log.warn("engine.session_push_rejected", {
			local_session_id: session.localSessionId,
			reason: "cross_env_race",
		});
		return null;
	}

	if (result.needs_content.includes(session.localSessionId) && session.messages.length > 0) {
		const contentBuf = Buffer.from(JSON.stringify(session.messages), "utf-8");
		await api.uploadSessionContent(
			session.localSessionId,
			contentBuf,
			`${session.localSessionId}.json`,
		);
	}

	// Persist the content_hash so a daemon restart doesn't re-push
	// every session it already shipped. Same lock file `clawdi push`
	// uses; reads/writes intentionally share state with the manual
	// command. Use the recomputed `actualHash` so the on-disk lock
	// matches what we actually uploaded — caching `item.content_hash`
	// (the stale watcher snapshot) would short-circuit a future
	// re-push on the wrong hash, leaving the cloud row out of sync
	// with the local file.
	const lock = readSessionsLock();
	lock.sessions[cacheKey(opts.adapter.agentType, session.localSessionId)] = {
		hash: actualHash,
	};
	writeSessionsLock(lock);

	log.info("engine.session_pushed", {
		local_session_id: session.localSessionId,
		message_count: session.messageCount,
		uploaded_content: result.needs_content.includes(session.localSessionId),
	});
	return { actualHash };
}

async function uploadSkillFromQueue(
	opts: EngineOpts,
	api: ApiClient,
	item: Extract<QueueItem, { kind: "skill_push" }>,
	lastPushedHash: Map<string, string>,
	scopeId: string,
): Promise<void> {
	const dir = join(opts.adapter.getSkillsRootDir(), item.skill_key);
	// Recompute the hash from the live directory at upload time
	// rather than trusting `item.new_hash`. The watcher's hash
	// could have aged out: enqueue stamps a hash, then the user
	// edits the file before drain reaches this item, then
	// `tarSkillDir` reads the post-edit content. Trusting the
	// stale hash makes the server store bytes whose tree-hash
	// disagrees with the DB's `content_hash` column.
	//
	// hashFirst → tar → hashAfter. If the disk shifted between
	// the two file walks, abort this upload — the watcher's next
	// tick re-enqueues with whatever the disk says now. Without
	// this check, the tar reflects post-edit content while the
	// hash we send reflects pre-edit, and the server's content_hash
	// column ends up out of sync with the bytes it stored.
	const hashFirst = await computeSkillFolderHash(dir);
	// Pass the full skill_key so a Hermes-nested key like
	// `category/foo` archives entries under `category/foo/...`
	// (matching the cloud row), not just `foo/...` which would
	// extract to the wrong path on other machines.
	const tarBytes = await tarSkillDir(dir, undefined, item.skill_key);
	const hashAfter = await computeSkillFolderHash(dir);
	if (hashFirst !== hashAfter) {
		log.warn("engine.skill_push_disk_shifted", {
			skill_key: item.skill_key,
			hash_first: hashFirst,
			hash_after: hashAfter,
		});
		// Surface as a non-permanent error so drainQueueLoop bumps
		// attempts + sleeps, then retries. The watcher will also
		// have re-enqueued by then with the latest content.
		throw new Error(
			`skill_push: ${item.skill_key} disk shifted mid-tar; will retry with latest content`,
		);
	}
	const actualHash = hashAfter;

	// Snapshot before the long-running upload await. If a
	// concurrent reconcile pull lands cloudHash into lastPushedHash
	// while we're uploading, the snapshot won't match on resume
	// and we skip the post-upload write — the pull's value is
	// the truth on disk now. CAS-style: only write if nothing
	// else moved it.
	const hashBeforeUpload = lastPushedHash.get(item.skill_key);
	const result = await api.uploadSkill(
		scopeId,
		item.skill_key,
		tarBytes,
		`${item.skill_key}.tar.gz`,
		actualHash,
	);
	const hashAfterUpload = lastPushedHash.get(item.skill_key);
	if (hashAfterUpload === hashBeforeUpload) {
		lastPushedHash.set(item.skill_key, actualHash);
		// Persist the last-shipped hash so a daemon restart can
		// disambiguate "cloud edited" vs "local edited" in
		// initialSync. Without this, divergence at boot defaulted
		// to push and clobbered offline dashboard edits.
		const lock = readSkillsLock();
		lock.skills[skillCacheKey(opts.adapter.agentType, item.skill_key)] = {
			hash: actualHash,
		};
		writeSkillsLock(lock);
	} else {
		// A pull completed for this skill while we were
		// uploading. The pull's content is what's on disk;
		// don't clobber its hash with our pre-upload value.
		log.info("engine.skill_pushed_pull_won", {
			skill_key: item.skill_key,
			upload_hash: actualHash,
			current_hash: hashAfterUpload,
		});
	}
	log.info("engine.skill_pushed", {
		skill_key: item.skill_key,
		content_hash: actualHash,
		version: result.version,
	});
}

/** Walk every page of /api/skills. The endpoint caps page_size
 * at 200; without pagination, a user with >200 skills would
 * have skills past page 1 silently treated as "not in cloud"
 * by the sweep step. Returns the full SkillSummary list AND a
 * boolean indicating whether the listing was complete (false
 * if we hit a fetch error mid-walk; sweep must not run on a
 * partial listing). */
async function listAllCloudSkills(
	api: ApiClient,
	scopeId: string,
	knownEtag?: string | null,
): Promise<{
	skills: SkillSummary[];
	complete: boolean;
	total: number;
	revision: number | null;
	etag: string | null;
	notModified: boolean;
}> {
	const PAGE_SIZE = 200;
	const out: SkillSummary[] = [];
	let page = 1;
	let total = 0;
	let revision: number | null = null;
	let etag: string | null = null;
	while (true) {
		// Pin reads to the env's scope so a daemon booted with an
		// unbound CLI key + an explicit `--environment-id` doesn't
		// pull skills from whichever env the backend defaults to
		// (most-recently-active for unbound keys). Without the
		// scope_id pin, reconcile would fan out to every scope the
		// caller can read and write them under the wrong env.
		//
		// Conditional GET: replay the previous response's full
		// ETag (server's format is `"<rev>:<scope>"`) so a scope
		// reassignment naturally invalidates the tag — pre-fix the
		// client constructed `"<rev>"` itself, which would 304 on
		// a different scope at the same revision and silently skip
		// pulling the new scope's skills.
		const headerInit: Record<string, string> = {};
		if (page === 1 && knownEtag) {
			headerInit["If-None-Match"] = knownEtag;
		}
		const res = await api.GET("/api/skills", {
			params: { query: { page, page_size: PAGE_SIZE, scope_id: scopeId } },
			headers: headerInit,
		});
		// ETag header carries the user's `skills_revision` counter
		// followed by the requested scope tag, e.g. `"42:abc-uuid"`.
		// We track:
		//   - `revision` (numeric prefix, for heartbeat
		//     `last_revision_seen`)
		//   - `etag` (full string, for the next If-None-Match
		//     short-circuit; the format is opaque to the daemon)
		// Pulled from every response so the value follows the
		// latest page; the body's `total` is just the count of
		// skills, NOT the revision counter. The backend always
		// emits this header — its absence on a 200 is a server
		// regression worth noticing. Logged once per occurrence
		// rather than once per page so a chronic miss doesn't
		// flood the journal.
		const headerEtag = res.response.headers.get("ETag");
		if (headerEtag) {
			etag = headerEtag;
			const numericPrefix = headerEtag.replace(/"/g, "").split(":", 1)[0] ?? "";
			const parsed = Number.parseInt(numericPrefix, 10);
			if (Number.isFinite(parsed)) revision = parsed;
		} else if (res.response.status !== 304) {
			log.warn("engine.list_skills_etag_missing", {
				page,
				status: res.response.status,
			});
		}
		if (res.response.status === 304) {
			// Treat 304 as "no change since `knownEtag`" — caller
			// short-circuits sweep / pull. Without the explicit
			// flag, callers couldn't distinguish "empty cloud
			// listing" from "unchanged since last poll", and sweep
			// would treat the empty `skills` as the cloud's current
			// state and rm every locally-known key. We echo back
			// the caller's `knownEtag` so reconcile bookkeeping
			// stays in sync with the server's view.
			return {
				skills: out,
				complete: true,
				total,
				revision,
				etag: knownEtag ?? null,
				notModified: true,
			};
		}
		const data = unwrap(res);
		out.push(...data.items);
		total = data.total ?? out.length;
		if (out.length >= total || data.items.length === 0) break;
		page += 1;
		// Hard cap so a buggy server doesn't loop us forever.
		if (page > 50) {
			log.warn("engine.list_skills_page_cap", { page, total });
			return { skills: out, complete: false, total, revision, etag, notModified: false };
		}
	}
	return { skills: out, complete: true, total, revision, etag, notModified: false };
}

/** Boot-time merge: enumerate local skills, fetch cloud, and
 * resolve per skill_key. The four cases:
 *
 *   - both present, hashes match → no-op, prime lastPushedHash
 *   - both present, hashes differ → enqueue push (single-writer
 *     model: the daemon's local copy is the truth, push wins)
 *   - only local → enqueue push as new
 *   - only cloud → pull
 *
 * Crucially does NOT sweep local-only skills: a daemon booting
 * fresh has no authority to call them "stale". The user might
 * have authored a skill while the daemon was off; we want to
 * push it up, not delete it.
 */
async function initialSync(
	opts: EngineOpts,
	api: ApiClient,
	queue: RetryQueue,
	lastPushedHash: Map<string, string>,
	cloudObservedKeys: Set<string>,
	pullsInFlight: Map<string, number>,
	scopeId: string,
	setRevision: (rev: number) => void,
	setEtag: (etag: string | null) => void,
): Promise<void> {
	const rootDir = opts.adapter.getSkillsRootDir();

	// Local side. Delegate enumeration to the adapter — Hermes
	// nests skills under category dirs (`category/foo/SKILL.md`)
	// so a flat top-level walk would return `category` (not a
	// real skill, no SKILL.md) and miss the actual nested skills.
	// `listSkillKeys` returns the same shape the adapter's
	// `collectSkills` would emit `skillKey` (relative paths,
	// dotfile + bundled-`clawdi` filtering already applied).
	const localKeys = await opts.adapter.listSkillKeys();
	const localHashes = new Map<string, string>();
	for (const key of localKeys) {
		try {
			const hash = await computeSkillFolderHash(join(rootDir, key));
			localHashes.set(key, hash);
		} catch {
			// Skill dir present but unreadable (no SKILL.md, etc.).
			// Skip — the watcher will treat it as a non-skill.
		}
	}

	// Cloud side. `complete=false` means the listing was
	// truncated (per-page cap × max-pages, or a fetch error
	// mid-walk). We MUST NOT base local-delete decisions on a
	// truncated map: a previously-shipped skill that just
	// happens to be on a page we never fetched looks
	// indistinguishable from a cloud-deleted skill, so the
	// local-only branch below would rm valid skills from disk.
	// The pull / divergence branches stay safe (we only ever
	// add cloudObservedKeys + reconcile against keys we DID
	// see). Reconcile loop already gates its sweep on
	// `complete`; initialSync needs the same gate.
	const {
		skills: cloudSkills,
		revision,
		etag,
		complete: cloudComplete,
	} = await listAllCloudSkills(api, scopeId);
	for (const s of cloudSkills) cloudObservedKeys.add(s.skill_key);
	const cloudByKey = new Map(cloudSkills.map((s) => [s.skill_key, s]));

	// `allApplied` flips to false on the first per-skill pull /
	// remove failure. We only persist `revision` as
	// `lastSeenRevision` if EVERY operation succeeded — otherwise
	// the next reconcile would send `If-None-Match: <revision>`
	// and the server's 304 would skip the safety-net listing,
	// leaving the failed pull / undeleted skill stuck until some
	// unrelated cloud change bumps the revision. Leaving the
	// revision stale forces the next reconcile to fetch the full
	// listing and retry whatever this boot pass missed.
	let allApplied = true;

	// Resolve each cloud skill against local.
	for (const [key, cloud] of cloudByKey) {
		const localHash = localHashes.get(key);
		if (localHash === undefined) {
			// Only cloud — pull. The watcher hasn't started yet
			// at boot, but we still mark in-flight so a future
			// refactor that interleaves boot with the watcher
			// can't regress.
			addInFlight(pullsInFlight, key);
			try {
				await pullSkill(opts, api, key, lastPushedHash, scopeId);
			} catch (e) {
				allApplied = false;
				log.warn("engine.boot_pull_failed", {
					skill_key: key,
					error: toErrorMessage(e),
				});
			} finally {
				releaseInFlight(pullsInFlight, key);
			}
		} else if (localHash !== cloud.content_hash) {
			// Diverged. The single-writer model (one env = one
			// daemon writing this scope) is broken in two ways
			// the dashboard introduced:
			//   - Dashboard editor writes via /api/scopes/.../content
			//   - CLI commands (`clawdi skill add`, `clawdi push`)
			//     write while the daemon is offline
			// So divergence at boot can mean LOCAL is newer
			// (push) or CLOUD is newer (pull). Use the persisted
			// `lastShipped` (skills-lock) as the reference:
			//
			//   local == lastShipped, cloud != lastShipped → cloud changed → PULL
			//   cloud == lastShipped, local != lastShipped → local changed → PUSH
			//   both differ from lastShipped → conflict → PULL
			//     (cloud edits matter more; user can re-apply
			//     local. Pre-fix this case silently clobbered the
			//     dashboard edit.)
			//   no lastShipped record → unknown → PULL
			//     (safer default than overwriting an edit we
			//     can't prove we made.)
			const lastShipped = lastPushedHash.get(key);
			const localUnchanged = lastShipped !== undefined && lastShipped === localHash;
			const cloudUnchanged = lastShipped !== undefined && lastShipped === cloud.content_hash;
			const localChangedOnly = !localUnchanged && cloudUnchanged;

			if (localChangedOnly) {
				lastPushedHash.set(key, cloud.content_hash);
				const version = queue.enqueue({
					kind: "skill_push",
					skill_key: key,
					scope_id: scopeId,
					new_hash: localHash,
					enqueued_at: new Date().toISOString(),
					attempts: 0,
				});
				log.info("engine.boot_enqueue_diverged_push", {
					skill_key: key,
					local: localHash,
					cloud: cloud.content_hash,
					version,
				});
			} else {
				// Cloud-newer or both-changed or no record — pull
				// to safety. Mark in-flight so the watcher's
				// rm/extract storm doesn't trigger a re-push of
				// intermediate empty state.
				addInFlight(pullsInFlight, key);
				try {
					await pullSkill(opts, api, key, lastPushedHash, scopeId);
					log.info("engine.boot_pull_diverged", {
						skill_key: key,
						local: localHash,
						cloud: cloud.content_hash,
						reason: lastShipped === undefined ? "no_record" : "cloud_or_both_changed",
					});
				} catch (e) {
					allApplied = false;
					log.warn("engine.boot_pull_failed", {
						skill_key: key,
						error: toErrorMessage(e),
					});
				} finally {
					releaseInFlight(pullsInFlight, key);
				}
			}
		} else {
			// Match — record so subsequent watcher events dedup
			// AND persist to skills-lock so a daemon restart
			// before any push/pull writes one preserves the
			// `lastShipped` reference. Without the lock write,
			// the next boot's local-only branch would treat the
			// skill as "never shipped, push it" — which silently
			// resurrects a cloud-side delete that happened in
			// between (the dashboard's Uninstall button or a CLI
			// `clawdi skill rm` on another machine while this
			// daemon was offline).
			lastPushedHash.set(key, cloud.content_hash);
			const lock = readSkillsLock();
			lock.skills[skillCacheKey(opts.adapter.agentType, key)] = {
				hash: cloud.content_hash,
			};
			writeSkillsLock(lock);
		}
	}

	// Local-only skills: either fresh local content (PUSH) or
	// cloud-deleted-while-offline (REMOVE LOCAL). Use the same
	// `lastShipped` reference the divergence branch above uses:
	//   no record         → never shipped → fresh local → PUSH
	//   has record        → we shipped this before; cloud now
	//                       missing means dashboard / sibling
	//                       daemon deleted it while we were
	//                       offline → REMOVE LOCAL (the user
	//                       said "uninstall this", don't undo
	//                       their action by pushing it back)
	// Pre-fix this branch always pushed, resurrecting dashboard
	// uninstalls on the next daemon start.
	for (const [key, localHash] of localHashes) {
		if (cloudByKey.has(key)) continue;
		const lastShipped = lastPushedHash.get(key);
		if (lastShipped !== undefined && !cloudComplete) {
			// Cloud listing was truncated. We can't tell whether
			// this previously-shipped local skill was deleted on
			// the cloud or just sits on a page we never fetched.
			// Skip the destructive branch — the next reconcile
			// (or a later boot with a complete listing) will
			// classify correctly. Force `allApplied=false` so
			// the cloud's `revision` / `etag` aren't acked
			// either; otherwise the next reconcile would 304 and
			// the safety net would never get a chance to retry.
			allApplied = false;
			log.info("engine.boot_skip_remove_truncated_listing", { skill_key: key });
			continue;
		}
		if (lastShipped !== undefined) {
			// We shipped this before, cloud doesn't have it now.
			// Treat as cloud-side delete + remove the local copy.
			// (Fine to delete: the user's intent — when they
			// triggered the uninstall in the dashboard — was
			// "remove from this env's home". A push would undo
			// that.)
			addInFlight(pullsInFlight, key);
			try {
				await opts.adapter.removeLocalSkill(key);
				lastPushedHash.delete(key);
				// Drop the stale lock entry too so the next boot
				// doesn't re-trigger this branch on a key that's
				// already gone.
				const lock = readSkillsLock();
				delete lock.skills[skillCacheKey(opts.adapter.agentType, key)];
				writeSkillsLock(lock);
				log.info("engine.boot_remove_cloud_deleted", { skill_key: key });
			} catch (e) {
				allApplied = false;
				log.warn("engine.boot_remove_failed", {
					skill_key: key,
					error: toErrorMessage(e),
				});
			} finally {
				releaseInFlight(pullsInFlight, key);
			}
			continue;
		}
		// No record — brand-new local skill. Push as new.
		const version = queue.enqueue({
			kind: "skill_push",
			skill_key: key,
			scope_id: scopeId,
			new_hash: localHash,
			enqueued_at: new Date().toISOString(),
			attempts: 0,
		});
		log.info("engine.boot_enqueue_local_only", { skill_key: key, version });
	}

	// Only acknowledge the cloud's revision (and cache the
	// scope-bound ETag) if every per-skill pull / remove above
	// succeeded. Partial failure leaves both stale so the next
	// reconcile listing isn't 304'd, and the failed item is
	// retried on the next pass instead of silently dropped until
	// something else changes upstream.
	if (allApplied) {
		if (revision !== null) setRevision(revision);
		setEtag(etag);
	}
}

/** Periodic full reconciliation. Different from initialSync —
 * this runs after the daemon has already established what's in
 * the cloud, so it CAN sweep local skills the cloud has since
 * dropped. Sweep is bounded to keys observed in a prior cloud
 * listing (cloudObservedKeys) so a partial listing here can't
 * wipe out skills the daemon hasn't visited yet. */
async function reconcileLoop(
	opts: EngineOpts,
	api: ApiClient,
	lastPushedHash: Map<string, string>,
	cloudObservedKeys: Set<string>,
	pullsInFlight: Map<string, number>,
	abort: AbortSignal,
	getScopeId: () => string,
	getKnownEtag: () => string | null,
	setRevision: (rev: number) => void,
	setEtag: (etag: string | null) => void,
	onAuthFailure: (origin: string) => void,
): Promise<void> {
	while (!abort.aborted) {
		await sleep(RECONCILE_INTERVAL_MS, abort);
		if (abort.aborted) return;
		try {
			await reconcileFromCloud(
				opts,
				api,
				lastPushedHash,
				cloudObservedKeys,
				pullsInFlight,
				getScopeId(),
				getKnownEtag(),
				setRevision,
				setEtag,
				onAuthFailure,
			);
		} catch (e) {
			// listAllCloudSkills throws on 401/403 just like any other
			// non-2xx — if we don't escalate here the reconcile loop
			// just logs and sleeps, repeating forever on a revoked
			// key. Pull-only daemons depend on this to ever exit.
			if (isAuthFailure(e)) {
				onAuthFailure("reconcile_list");
				return;
			}
			log.warn("engine.reconcile_failed", { error: toErrorMessage(e) });
		}
	}
}

async function reconcileFromCloud(
	opts: EngineOpts,
	api: ApiClient,
	lastPushedHash: Map<string, string>,
	cloudObservedKeys: Set<string>,
	pullsInFlight: Map<string, number>,
	scopeId: string,
	knownEtag: string | null,
	setRevision: (rev: number) => void,
	setEtag: (etag: string | null) => void,
	onAuthFailure: (origin: string) => void,
): Promise<void> {
	const { skills, complete, revision, etag, notModified } = await listAllCloudSkills(
		api,
		scopeId,
		knownEtag,
	);
	if (notModified) {
		// Server confirmed nothing changed since `knownEtag` —
		// no skills to pull, no sweep work. Save the bandwidth +
		// pagination work; the local state is already consistent
		// with cloud. Without this short-circuit, every connected
		// daemon downloaded the full skill list once a minute on
		// quiet accounts. The etag stays cached as-is — server
		// confirmed it's still valid.
		if (revision !== null) setRevision(revision);
		return;
	}
	// Same all-or-nothing revision rule as initialSync: only
	// acknowledge the cloud's revision after every per-skill pull
	// and sweep succeeds in this pass. A pull that 5xx's or a
	// sweep that EBUSY's would otherwise be silently abandoned —
	// the next reconcile would send `If-None-Match: <revision>`
	// and the server's 304 would skip the listing, leaving the
	// failed item permanently stale until some other cloud change
	// bumps the revision.
	let allApplied = true;
	const cloudKeys = new Set(skills.map((s) => s.skill_key));
	for (const skill of skills) {
		cloudObservedKeys.add(skill.skill_key);
		const local = lastPushedHash.get(skill.skill_key);
		if (local === skill.content_hash) continue;
		// Skip if a cloud-pull is already mid-flight for this skill
		// (e.g. boot initialSync still draining). Concurrent rm +
		// tar extract on the same dir leaves it partially-extracted.
		// The in-flight pull will plant the right hash; on the next
		// reconcile cycle the equality check above short-circuits
		// this branch. We DON'T set allApplied=false here — the
		// in-flight pull will land its own revision update; this
		// reconcile pass deferring to it is intentional.
		if (pullsInFlight.has(skill.skill_key)) {
			allApplied = false;
			continue;
		}
		addInFlight(pullsInFlight, skill.skill_key);
		try {
			// Scope-explicit so the daemon doesn't pull a sibling
			// scope's bytes on a multi-agent unbound key. See
			// `pullSkill()` doc for the duplicate-skill_key case.
			const tarBytes = await api.getBytes(
				`/api/scopes/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(skill.skill_key)}/download`,
			);
			await opts.adapter.writeSkillArchive(skill.skill_key, tarBytes);
			lastPushedHash.set(skill.skill_key, skill.content_hash);
			// Persist the pulled hash to skills-lock too so a daemon
			// restart treats this as a known-shipped skill. Without
			// this, a cloud-side delete during a subsequent offline
			// window would surface at boot as "local-only, no record"
			// → PUSH back, undoing the deletion.
			const lock = readSkillsLock();
			lock.skills[skillCacheKey(opts.adapter.agentType, skill.skill_key)] = {
				hash: skill.content_hash,
			};
			writeSkillsLock(lock);
			log.info("engine.skill_pulled", {
				skill_key: skill.skill_key,
				content_hash: skill.content_hash,
			});
		} catch (e) {
			if (isAuthFailure(e)) {
				onAuthFailure("reconcile_pull");
				return;
			}
			allApplied = false;
			log.warn("engine.reconcile_pull_failed", {
				skill_key: skill.skill_key,
				error: toErrorMessage(e),
			});
		} finally {
			releaseInFlight(pullsInFlight, skill.skill_key);
		}
	}

	// Sweep handles cloud-side deletes (the dashboard's Uninstall
	// button or a CLI delete on another machine). The reconcile
	// loop is the only sync-from-cloud mechanism in the
	// single-writer model. Only fires on a complete listing, and
	// only for skill_keys we previously observed coming from the
	// cloud — never for local-only skills that haven't yet shipped.
	if (complete) {
		for (const knownKey of [...cloudObservedKeys]) {
			if (cloudKeys.has(knownKey)) continue;
			// Skip if a pull for this key is in flight. Without this,
			// the sweep can rm the directory while the pull is mid-
			// extract, and the pull's writeSkillArchive resurrects
			// what we just deleted. Same guard the pull loop uses
			// above (line 660); just hadn't propagated to sweep.
			// Mark the pass incomplete so the in-flight pull's
			// revision lands on a later pass after it converges.
			if (pullsInFlight.has(knownKey)) {
				allApplied = false;
				continue;
			}
			addInFlight(pullsInFlight, knownKey);
			try {
				await opts.adapter.removeLocalSkill(knownKey);
				lastPushedHash.delete(knownKey);
				cloudObservedKeys.delete(knownKey);
				// Drop the on-disk lock entry too — otherwise a
				// daemon restart would see the stale entry and
				// hit the boot "remove or push" branch again.
				const lock = readSkillsLock();
				delete lock.skills[skillCacheKey(opts.adapter.agentType, knownKey)];
				writeSkillsLock(lock);
				log.info("engine.skill_swept", { skill_key: knownKey });
			} catch (e) {
				allApplied = false;
				log.warn("engine.sweep_failed", {
					skill_key: knownKey,
					error: toErrorMessage(e),
				});
			} finally {
				releaseInFlight(pullsInFlight, knownKey);
			}
		}
	} else {
		// Listing was paginated/truncated. Some cloud-side deletes
		// could be hidden behind unfetched pages, so the sweep above
		// is a no-op — explicitly defer revision acknowledge so the
		// next reconcile re-fetches and the sweep can run.
		allApplied = false;
	}

	// All-or-nothing revision + etag update. See `allApplied`
	// comment above.
	if (allApplied) {
		if (revision !== null) setRevision(revision);
		setEtag(etag);
	}
}

/** Re-scan every local skill directory and re-enqueue any whose
 * current content hash disagrees with `lastPushedHash`. Called
 * when the daemon's scope changes — the previous queue's
 * scope-stamped items got dropped at drain time, so the user's
 * pending edits need to ride a fresh enqueue under the new scope.
 * Idempotent: skills already in sync produce no enqueue.
 *
 * `pullsInFlight` is the SAME guard the watcher uses. While a
 * cloud pull is mid-`writeSkillArchive` (rm + extract), the
 * directory is empty for a few ms — hashing it would yield the
 * empty hash, the rescan would enqueue an empty-content push,
 * and the queue could echo that transient state back to the
 * server before the pull finishes. Skip keys with a pull in
 * flight; the next reconcile picks them up after the pull
 * completes and lastPushedHash converges. */
async function rescanLocalSkillsForChanges(
	opts: EngineOpts,
	queue: RetryQueue,
	lastPushedHash: Map<string, string>,
	pullsInFlight: Map<string, number>,
	getScopeId: () => string,
): Promise<void> {
	const localKeys = await opts.adapter.listSkillKeys();
	for (const key of localKeys) {
		if (pullsInFlight.has(key)) {
			log.debug("engine.rescan_skipped_in_flight", { skill_key: key });
			continue;
		}
		await enqueueIfChanged(opts, queue, lastPushedHash, key, getScopeId).catch((e) => {
			log.warn("engine.rescan_enqueue_failed", { skill_key: key, error: toErrorMessage(e) });
		});
	}
}

/** Walk up from `pathFromRoot` until we find a directory
 * containing `SKILL.md`. The deepest such directory IS the
 * skill_key. Hermes places SKILL.md at the leaf
 * (`category/foo/SKILL.md`); flat adapters place it at the top
 * (`mySkill/SKILL.md`). The walk handles both — same code path
 * for "what changed" → "which skill". Returns `null` when no
 * ancestor has SKILL.md (e.g. a brand-new category dir before
 * its first nested skill is committed).
 */
export function resolveOwningSkillKey(rootDir: string, pathFromRoot: string): string | null {
	// Reject any change whose path passes through a dotfile-
	// prefixed component (e.g. `gstack/.agents/skills/<sub>`).
	// Server's SKILL_KEY_PATTERN requires every component to
	// start with `[A-Za-z0-9]`; pre-fix this triggered 728
	// `engine.queue_drop_permanent` 422 events in prod after
	// the daemon fired on gstack's bundled sub-skill artifacts.
	// An earlier draft walked UP past the dotfile component to
	// resolve to the outer skill (`gstack`) — but the outer
	// skill is the 1 GB folder that already trips upload's
	// 25 MB cap (413). Returning null here trades both 422
	// spam AND would-be 413 cascades for a silent no-op.
	// Companion fixes:
	//   - lib/tar.ts SKILL_TAR_EXCLUDE drops these dotfile
	//     subtrees from the outer skill's tarball so the outer
	//     skill itself stays under the cap.
	//   - Adapters' `listSkillKeys` already filter dotfiles at
	//     the top-level walk; this is the watcher-driven
	//     analog.
	// Split on BOTH `/` and `\` — Windows callers (the watcher
	// builds paths via `path.join` which yields backslashes on
	// win32) would otherwise sneak `gstack\.agents\skills\<sub>`
	// past a `/`-only split and re-enable the 422 spam this fix
	// is meant to stop.
	if (pathFromRoot.split(/[/\\]/).some((seg) => seg.startsWith("."))) {
		return null;
	}
	let cur = pathFromRoot;
	// Bound the walk: 6 levels is more than the regex permits
	// (4 components) so we'll always terminate even if the input
	// is pathological.
	for (let i = 0; i < 6; i++) {
		if (!cur || cur === "." || cur === "/") return null;
		if (existsSync(join(rootDir, cur, "SKILL.md"))) return cur;
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
	return null;
}

// Skill enumeration moved to `adapter.listSkillKeys()` —
// Hermes nests skills under category dirs (`category/foo/SKILL.md`)
// so a flat top-level walk silently dropped them; flat adapters
// (Claude Code / Codex / OpenClaw) implement the same dotfile +
// bundled-`clawdi` filtering inline. See base.ts AgentAdapter
// docstring for the contract.

/** Pull a single skill. Used by both boot initialSync, runtime
 * SSE `skill_changed` handler, and reconcile fallback.
 *
 * Scope-explicit by design: an unbound CLI key on a multi-agent
 * account can have the same `skill_key` in two different scopes,
 * and the legacy unscoped download endpoint resolves "most-
 * recently-updated across visible scopes" — that can plant
 * agent A's bytes on agent B's local disk. Always pin to the
 * env's resolved `scopeId`. */
async function pullSkill(
	opts: EngineOpts,
	api: ApiClient,
	skillKey: string,
	lastPushedHash: Map<string, string>,
	scopeId: string,
): Promise<void> {
	const tarBytes = await api.getBytes(
		`/api/scopes/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(skillKey)}/download`,
	);
	await opts.adapter.writeSkillArchive(skillKey, tarBytes);
	// Recompute the on-disk hash so the watcher's next tick
	// recognizes this as our own write and skips re-uploading.
	const dir = join(opts.adapter.getSkillsRootDir(), skillKey);
	try {
		const hash = await computeSkillFolderHash(dir);
		lastPushedHash.set(skillKey, hash);
		// Persist to skills-lock so a future daemon restart treats
		// this as a known-shipped skill. Without this, a cloud-side
		// delete that lands while the daemon is offline would
		// surface at boot as "local-only, no record" → PUSH back,
		// resurrecting the deletion. Mirrors the push-success path.
		const lock = readSkillsLock();
		lock.skills[skillCacheKey(opts.adapter.agentType, skillKey)] = { hash };
		writeSkillsLock(lock);
	} catch {
		// Directory state weird (extraction half-done?); next
		// reconcile fixes it.
	}
	log.info("engine.skill_pulled", { skill_key: skillKey });
}

/** Heartbeat sender. Fires immediately on boot then every
 * HEARTBEAT_INTERVAL_MS. The dashboard uses this to compute
 * "last seen" / "daemon offline" indicators — a daemon that
 * just started must show up as online within seconds, not
 * after the first 30s sleep elapses. */
async function heartbeatLoop(
	opts: EngineOpts,
	api: ApiClient,
	queue: RetryQueue,
	abort: AbortSignal,
	snapshot: () => { last_revision_seen: number | null; last_sync_error: string | null },
): Promise<void> {
	const send = async () => {
		const fields = snapshot();
		const dropped = queue.drainDroppedDelta();
		try {
			await api.POST("/api/agents/{environment_id}/sync-heartbeat", {
				params: { path: { environment_id: opts.environmentId } },
				body: {
					// Peak since boot rather than sampled current
					// depth — see the comment on the auth-failure
					// final heartbeat above. Backend takes max
					// across reports, so a monotonically-rising
					// high-water mark from the daemon makes the
					// dashboard's `queue_depth_high_water_since_start`
					// converge to the actual peak.
					queue_depth: queue.highWaterMark,
					dropped_count_delta: dropped,
					last_revision_seen: fields.last_revision_seen,
					last_sync_error: fields.last_sync_error,
				},
			});
			await touchHealthFile(opts.adapter.agentType);
		} catch (e) {
			// POST failed — restore the unsent dropped delta so the
			// next successful heartbeat carries it. Without this the
			// count is permanently lost on every flaky-network
			// cycle, which is precisely when drops are most likely.
			queue.restoreDroppedDelta(dropped);
			log.warn("engine.heartbeat_failed", { error: toErrorMessage(e) });
		}
	};

	// Eager first beat. If this fails (network down, env_id
	// unknown), the warn log surfaces it; subsequent retries
	// happen on the normal interval.
	await send();
	while (!abort.aborted) {
		// Per-cycle ±5s jitter so 10k daemons started by the same
		// rollout don't all heartbeat in the same wall-clock
		// second. Without jitter the backend sees a 30s sawtooth
		// at every interval boundary; with jitter the load
		// smooths into a flat ~33 writes/sec.
		const jitter = (Math.random() - 0.5) * 10_000;
		await sleep(HEARTBEAT_INTERVAL_MS + jitter, abort);
		if (abort.aborted) return;
		await send();
	}
}

async function touchHealthFile(agentType: string): Promise<void> {
	const p = join(getServeStateDir(agentType), "health");
	try {
		// JSON shape lets `serve status` / `serve doctor` surface
		// "your daemon is running an older CLI version, restart to
		// pick up the latest" without having to re-derive it from
		// the launchd plist or process tree. Pre-fix this was a
		// single ISO timestamp; `readHealth` parses both shapes.
		const payload = JSON.stringify({
			timestamp: new Date().toISOString(),
			version: getCliVersion(),
		});
		await writeFile(p, `${payload}\n`);
	} catch {
		/* state dir read-only? caller's problem, not ours */
	}
}

function redactItem(item: QueueItem): Record<string, unknown> {
	// Strip hash details to keep log lines small.
	if (item.kind === "skill_push") {
		return { kind: item.kind, skill_key: item.skill_key, attempts: item.attempts };
	}
	return { kind: item.kind, attempts: item.attempts };
}

/** Bump the in-flight refcount for a skill_key. Pair with
 * releaseInFlight in a finally block. */
export function addInFlight(m: Map<string, number>, key: string): void {
	m.set(key, (m.get(key) ?? 0) + 1);
}

/** Release one in-flight reference. Removes the entry once the
 * count hits zero so `m.has(key)` reports false again. */
export function releaseInFlight(m: Map<string, number>, key: string): void {
	const n = (m.get(key) ?? 0) - 1;
	if (n <= 0) m.delete(key);
	else m.set(key, n);
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		// Listener must be removed when the timer fires, otherwise
		// long-running daemon code paths (the 500ms queue empty
		// poll in particular) accumulate listeners on the shared
		// AbortSignal and eventually trip
		// MaxListenersExceededWarning. Same cleanup shape as
		// sse-client.ts:sleep.
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			abort.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		abort.addEventListener("abort", onAbort, { once: true });
	});
}
