/**
 * `clawdi daemon` orchestrator.
 *
 * Wires the background tasks that make up a sync daemon:
 *
 *   - watcher          — local skill-dir change events (fs.watch / poll)
 *   - sse              — Cloud events wake a local re-scan; they never write
 *                        or remove Agent filesystem content
 *   - drainQueue       — flush durable skill_push/skill_delete projections
 *   - reconcile        — periodic local inventory vs exact-claim diff
 *   - project-refresh    — periodic re-fetch of the env's default_project_id
 *                        so a runtime project reassignment converges
 *   - heartbeat        — periodic POST to /v1/agents/{agent_id}/sync-heartbeat
 *
 * Authority model: ordinary Agent-local Skills are filesystem-authored and
 * Cloud rows are projections. Project-owned Skills explicitly materialized by
 * pull remain source-Project references and are never reverse-projected.
 * Only an exact, durable Agent+Project claim can authorize deletion after
 * local absence; legacy hash caches cannot. Managed reservations are skipped
 * as content and cause any prior user projection to be deleted without
 * touching the managed target.
 *
 * Push side:
 *   1. Watcher fires for skill_key X
 *   2. Hash X's local content; if same as last-pushed, skip
 *   3. Enqueue an identity/project-fenced push or delete
 *   4. drainQueue uses the Agent-authoritative sync boundary
 *   5. 200: mark done, update last-pushed cache
 *   6. 4xx: drop with a warn. 5xx / network: bump attempts and
 *      leave in queue with backoff.
 *
 * A complete, project-scoped Cloud list is consulted only during migration to
 * report absence for unclaimed legacy Agent-Project rows. Failed/truncated
 * listings never authorize destructive inference.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import type {
	AgentAdapter,
	RawSession,
	SessionModule,
	SessionScanRequest,
	SkillModule,
} from "../adapters/base";
import { scanSessionModule } from "../adapters/base";
import { AgentSkillSyncNotFoundError, ApiClient, ApiError, unwrap } from "../lib/api-client";
import { canonicalApiOrigin } from "../lib/api-origin";
import { computeLastActivityIso } from "../lib/session-activity";
import {
	negotiateSessionProtocol,
	persistSuppressedSession,
	planSessionUpload,
	type SelectedSessionProtocol,
	sessionFence,
	sessionPlanIsDurablyBlocked,
	syncSessionContent,
} from "../lib/session-upload";
import {
	type FencedSessionLockEntry,
	type FencedSessionSourceRevisionUpdate,
	persistFencedSessionSourceRevisions,
	readSessionsLock,
	type SessionFence,
} from "../lib/sessions-lock";
import { isValidSkillKey, SkillKeyValidationError } from "../lib/skill-key";
import {
	computeSkillFolderHash,
	readProjectSkillMaterialization,
	readSkillProjectionClaimsForAgent,
	readSkillProjectionState,
	recordSkillProjectionClaim,
	removeSkillProjectionClaim,
} from "../lib/skills-lock";
import { snapshotSkillArchive } from "../lib/tar";
import { getCliVersion } from "../lib/version";
import { shouldIgnoreUserSkill } from "../runtime/managed-skill-reservation";
import { readHostedRuntimeObserved } from "../runtime/observed";

export { isSafelyTerminalRuntimeObservationFailure } from "../runtime/observation-producer";

import { log, toErrorMessage } from "./log";
import { getServeStateDir } from "./paths";
import { reconcileConnectedProjectSkills } from "./project-skill-reconcile";
import { hasSessionFence, type QueueItem, RetryQueue } from "./queue";
import { type SessionWatchEvent, watchSessions } from "./sessions-watcher";
import {
	consumeSse,
	type ServerEvent,
	type SkillServerEvent,
	type SseReconnectInfo,
} from "./sse-client";
import { watchSkills } from "./watcher";

export function isSkillSyncServerEvent(event: ServerEvent): event is SkillServerEvent {
	return (
		event.type === "skill_changed" ||
		event.type === "skill_deleted" ||
		event.type === "agent_skill_changed" ||
		event.type === "agent_skill_deleted"
	);
}

const AGENT_DISCONNECTED_ERROR_CODE = "agent_disconnected";

function agentLookupStopHint(error: unknown): string | null {
	if (!(error instanceof ApiError)) return null;
	// Older active-only Core versions returned 404 for the owner's archived
	// Agent. Keep that rolling-upgrade stop only at the exact lookup call, but
	// do not claim that an ambiguous 404 proves the Agent was disconnected.
	if (error.status === 404) {
		return "This installation's Agent was not found. Run clawdi setup to reconnect this installation.";
	}
	if (error.status !== 403) return null;
	try {
		const payload: unknown = JSON.parse(error.body);
		if (typeof payload !== "object" || payload === null || !("detail" in payload)) return null;
		const detail = payload.detail;
		const disconnected =
			typeof detail === "object" &&
			detail !== null &&
			"code" in detail &&
			detail.code === AGENT_DISCONNECTED_ERROR_CODE;
		return disconnected
			? "This installation is disconnected. Run clawdi setup to reconnect it with retained data."
			: null;
	} catch {
		return null;
	}
}

export function skillInvalidationKey(event: ServerEvent, projectId: string): string | null {
	if (!isSkillSyncServerEvent(event) || event.project_id !== projectId) return null;
	return event.skill_key;
}

export function staleSkillProjectionProjectIds(
	agentType: string,
	agentId: string,
	skillKey: string,
	currentProjectId: string,
): string[] {
	return readSkillProjectionClaimsForAgent(agentType, agentId)
		.filter((claim) => claim.skill_key === skillKey && claim.project_id !== currentProjectId)
		.map((claim) => claim.project_id)
		.sort();
}

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_JITTER_MS = 15_000;
// Local projection reconcile cadence. Watch events are primary; this sweep
// catches offline deletes, queue eviction, and filesystems that lose events.
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const RECONCILE_JITTER_MS = 60_000;
// Project reassignment is an administrative control-plane change,
// not a liveness signal. Keep it off the heartbeat cadence so a
// large daemon fleet does not double its steady-state request load.
const PROJECT_REFRESH_INTERVAL_MS = 5 * 60_000;
const PROJECT_REFRESH_JITTER_MS = 60_000;
const LAUNCHD_DAEMON_LABEL = "ai.clawdi.serve";

function removeLaunchdDaemonSupervision(agentType: string): void {
	if (process.platform !== "darwin") return;
	void (async () => {
		try {
			const { execFile } = await import("node:child_process");
			for (const label of [LAUNCHD_DAEMON_LABEL, `${LAUNCHD_DAEMON_LABEL}.${agentType}`]) {
				execFile("launchctl", ["remove", label], () => {
					// fire-and-forget; the daemon is exiting anyway
				});
			}
		} catch {
			/* launchctl missing, ignore — the manual `launchctl unload`
			 * from the user is the fallback. */
		}
	})();
}
// Backoff between retry attempts when the queue has items but the
// last drain attempt failed. Keeps the daemon from hammering a
// dead network. Per-item attempts counter caps the work too.
const QUEUE_RETRY_INTERVAL_MS = 15_000;
// Safety wakeup for an idle queue. enqueue() wakes the drain loop
// immediately; this timeout is only a backstop in case a wake signal
// is missed.
const QUEUE_IDLE_WAKEUP_MS = 30_000;
const MAX_QUEUE_ATTEMPTS = 30;
const TRANSIENT_HEARTBEAT_FAILURES = 3;

export function reconcileDelayMs(random: () => number = Math.random): number {
	const offset = (random() - 0.5) * 2 * RECONCILE_JITTER_MS;
	return Math.round(RECONCILE_INTERVAL_MS + offset);
}

export function connectedProjectSkillDeliveryEnabled(runtimeMode: string | undefined): boolean {
	// `hosted` covers both Legacy V1 and Hosted V2 deployment processes.
	// Neither deployment generation may use the Connected Agent capability lease.
	return runtimeMode?.trim().toLowerCase() !== "hosted";
}

export function projectRefreshDelayMs(random: () => number = Math.random): number {
	const offset = (random() - 0.5) * 2 * PROJECT_REFRESH_JITTER_MS;
	return Math.round(PROJECT_REFRESH_INTERVAL_MS + offset);
}

type FailureClassification = "transient" | "sustained";
type SyncHealthArea = "transport" | "push" | "projection";
interface SyncHealthError {
	message: string;
	transient: boolean;
}

/** Unresolved sync failures keyed by their owning source or resource. */
export class SyncHealth {
	private readonly errors: Record<SyncHealthArea, Map<string, SyncHealthError>> = {
		transport: new Map(),
		push: new Map(),
		projection: new Map(),
	};

	set(area: SyncHealthArea, resource: string, message: string, transient = false): void {
		this.errors[area].set(resource, { message, transient });
	}

	setIfAbsent(area: SyncHealthArea, resource: string, message: string, transient = false): void {
		if (!this.errors[area].has(resource)) {
			this.errors[area].set(resource, { message, transient });
		}
	}

	clear(area: SyncHealthArea, resource: string): void {
		this.errors[area].delete(resource);
	}

	clearTransient(area: SyncHealthArea, resource: string): void {
		if (this.errors[area].get(resource)?.transient) {
			this.errors[area].delete(resource);
		}
	}

	clearAbsent(area: SyncHealthArea, prefix: string, presentResources: ReadonlySet<string>): void {
		for (const resource of this.errors[area].keys()) {
			if (resource.startsWith(prefix) && !presentResources.has(resource)) {
				this.errors[area].delete(resource);
			}
		}
	}

	project(): string | null {
		const auth = this.errors.transport.get("auth");
		if (auth) return auth.message;
		for (const area of ["transport", "projection", "push"] as const) {
			const first = [...this.errors[area]]
				.filter(([resource]) => area !== "transport" || resource !== "auth")
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))[0];
			if (first) return first[1].message;
		}
		return null;
	}
}

interface StableSessionEnqueueOptions {
	abort: AbortSignal;
	sessions: readonly RawSession[];
	queue: Pick<RetryQueue, "enqueueWhenAvailable">;
	lastPushedHash: ReadonlyMap<string, string>;
	inFlightHash: Map<string, string>;
	protocol: SelectedSessionProtocol;
	fenceFor(session: RawSession): SessionFence;
	onBlocked?(session: RawSession, message: string): void;
}

interface StableSessionEnqueueResult {
	enqueued: number;
	confirmedSourceRevisions: FencedSessionSourceRevisionUpdate[];
}

export async function enqueueChangedSessionsAfterStability(
	opts: StableSessionEnqueueOptions,
): Promise<StableSessionEnqueueResult> {
	const confirmedSourceRevisions: FencedSessionSourceRevisionUpdate[] = [];
	if (opts.abort.aborted) return { enqueued: 0, confirmedSourceRevisions };
	let enqueued = 0;
	for (const session of opts.sessions) {
		if (opts.abort.aborted) return { enqueued, confirmedSourceRevisions };
		const plan = planSessionUpload(session, opts.protocol);
		const hash = plan.localHash;
		const fence = opts.fenceFor(session);
		const sourceRevisionUpdate = session.sourceRevision
			? {
					fence,
					protocol: plan.protocol,
					localHash: hash,
					sourceRevision: session.sourceRevision,
				}
			: null;
		const blocked = sessionPlanIsDurablyBlocked(fence, plan);
		if (blocked) {
			if (sourceRevisionUpdate) confirmedSourceRevisions.push(sourceRevisionUpdate);
			opts.onBlocked?.(session, blocked);
			continue;
		}
		if (opts.lastPushedHash.get(session.localSessionId) === hash) {
			if (sourceRevisionUpdate) confirmedSourceRevisions.push(sourceRevisionUpdate);
			continue;
		}
		if (opts.inFlightHash.get(session.localSessionId) === hash) continue;
		if (opts.abort.aborted) return { enqueued, confirmedSourceRevisions };
		const version = await opts.queue.enqueueWhenAvailable(
			{
				kind: "session_push",
				local_session_id: session.localSessionId,
				content_hash: hash,
				api_origin: fence.apiOrigin,
				environment_id: fence.environmentId,
				adapter: fence.adapter,
				source_session_key: fence.sourceSessionKey,
				enqueued_at: new Date().toISOString(),
				attempts: 0,
			},
			opts.abort,
		);
		if (version === null) return { enqueued, confirmedSourceRevisions };
		opts.inFlightHash.set(session.localSessionId, hash);
		enqueued += 1;
	}
	return { enqueued, confirmedSourceRevisions };
}

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
	const skills = opts.adapter.skills;
	const sessions = opts.adapter.sessions;
	if (!sessions && !skills) throw new Error(`${opts.adapter.agentType} has no sync modules`);

	const api = new ApiClient({ abortSignal: opts.abort });
	const shutdownApi = new ApiClient();
	const health = new SyncHealth();
	const inFlightSessionHash = new Map<string, string>();
	const queue = new RetryQueue({
		agentType: opts.adapter.agentType,
		onEvict: (item) => {
			if (item.kind !== "session_push") return;
			if (inFlightSessionHash.get(item.local_session_id) === item.content_hash) {
				inFlightSessionHash.delete(item.local_session_id);
			}
		},
	});
	queue.load();

	const stateDir = getServeStateDir(opts.adapter.agentType);
	await mkdir(stateDir, { recursive: true });
	log.info("engine.start", {
		environment_id: opts.environmentId,
		agent_type: opts.adapter.agentType,
		modules: [sessions ? "sessions" : null, skills ? "skills" : null].filter(Boolean),
		state_dir: stateDir,
	});

	let lastSeenRevision: number | null = null;
	const stopForDisconnectedAgent = (hint: string): void => {
		log.info("engine.agent_disconnected", {
			environment_id: opts.environmentId,
			hint,
		});
		process.exitCode = 2;
		removeLaunchdDaemonSupervision(opts.adapter.agentType);
		opts.abortController.abort();
	};

	let authFailureFired = false;
	const triggerAuthFailureAbort = (origin: string): void => {
		if (authFailureFired) return;
		authFailureFired = true;
		log.error("engine.auth_failed", { origin });
		health.set("transport", "auth", "auth_revoked: api key rejected by server");
		void shutdownApi
			.POST("/v1/agents/{agent_id}/sync-heartbeat", {
				params: { path: { agent_id: opts.environmentId } },
				body: {
					queue_depth: queue.highWaterMark,
					dropped_count_delta: 0,
					last_revision_seen: lastSeenRevision,
					last_sync_error: health.project(),
				},
			})
			.catch(() => {
				/* best effort */
			});
		process.exitCode = 2;
		removeLaunchdDaemonSupervision(opts.adapter.agentType);
		opts.abortController.abort();
	};

	const common: CommonSyncRuntime = {
		api,
		queue,
		health,
		inFlightSessionHash,
		stopForDisconnectedAgent,
		triggerAuthFailureAbort,
		setLastSeenRevision: (revision) => {
			lastSeenRevision = revision;
		},
	};
	const sessionSync = sessions ? await prepareSessionSync(opts, sessions, common) : null;
	const skillSync = skills ? await prepareSkillSync(opts, skills, common) : null;
	if (opts.abort.aborted) return;
	const moduleTasks: Promise<void>[] = [];
	if (sessions && sessionSync) moduleTasks.push(runSessionSync(opts, sessions, sessionSync));
	if (skills && skillSync) moduleTasks.push(runSkillSync(opts, skills, skillSync));

	await Promise.all([
		...moduleTasks,
		drainQueueLoop(
			opts,
			api,
			queue,
			{
				sessions: sessionSync?.queueModule ?? null,
				skills: skillSync?.queueModule ?? null,
			},
			skillSync?.lastPushedHash ?? new Map(),
			sessionSync?.lastPushedHash ?? new Map(),
			inFlightSessionHash,
			health,
			triggerAuthFailureAbort,
		),
		heartbeatLoop(opts, api, queue, opts.abort, () => ({
			last_revision_seen: lastSeenRevision,
			last_sync_error: health.project(),
		})),
	]);
	log.info("engine.stop", {});
}

interface CommonSyncRuntime {
	api: ApiClient;
	queue: RetryQueue;
	health: SyncHealth;
	inFlightSessionHash: Map<string, string>;
	stopForDisconnectedAgent(hint: string): void;
	triggerAuthFailureAbort(origin: string): void;
	setLastSeenRevision(revision: number | null): void;
}

interface PreparedSkillSync {
	queueModule: { module: SkillModule; getProjectId: () => string };
	lastPushedHash: Map<string, string>;
	run(): Promise<void>;
}

async function prepareSkillSync(
	opts: EngineOpts,
	skills: SkillModule,
	common: CommonSyncRuntime,
): Promise<PreparedSkillSync | null> {
	const connectedProjectSkillDelivery = connectedProjectSkillDeliveryEnabled(
		process.env.CLAWDI_RUNTIME_MODE,
	);
	const {
		api,
		queue,
		health: syncHealth,
		stopForDisconnectedAgent,
		triggerAuthFailureAbort,
	} = common;

	// Exact, identity-fenced projection claims. Unlike the legacy hash cache,
	// these entries prove that this Agent successfully projected a local key
	// into its current Project and therefore authorize an absence report.
	const lastPushedHash = new Map<string, string>();
	const updateLastSeenRevision = (revision: number | null): void => {
		common.setLastSeenRevision(revision);
	};
	let lastReconciledListingEtag: string | null = null;

	const rootDir = skills.rootDir();
	log.info("engine.skills_start", { root_dir: rootDir });

	// Fetch this Agent's default_project_id at boot. Projection requests are
	// Agent-scoped, while the durable claim and absence report are additionally
	// fenced to this Project. Throw on missing so the
	// supervisor restarts — without a project_id we can't tell which
	// SSE events belong to us.
	const fetchDefaultProjectId = async (): Promise<string> => {
		const envInfo = unwrap(
			await api.GET("/v1/agents/{agent_id}", {
				params: { path: { agent_id: opts.environmentId } },
			}),
		);
		const projectId = envInfo.default_project_id;
		if (!projectId) {
			throw new Error(`environment ${opts.environmentId} has no default_project_id; cannot upload`);
		}
		return projectId;
	};
	// Boot-time auth-failure handling: `fetchDefaultProjectId()`
	// throws ApiError on 401/403 if the daemon was started with a
	// revoked / forbidden key. Pre-fix this bubbled up as a
	// generic fatal — `serve()` set process.exitCode=1, which
	// systemd's `RestartPreventExitStatus=2` doesn't suppress, so
	// the daemon respawned every 10s in a tight loop with no
	// auth_revoked heartbeat for the dashboard to surface. Exit
	// with code 2 so systemd stops respawning + log the canonical
	// `engine.auth_failed` event so /api/health and operators see
	// a clean reason. (No best-effort heartbeat from this point
	// because the daemon hasn't established its project/queue state
	// yet — there's nothing meaningful to report beyond "auth dead
	// at boot".)
	let defaultProjectId: string;
	try {
		defaultProjectId = await fetchDefaultProjectId();
	} catch (e) {
		const stopHint = agentLookupStopHint(e);
		if (stopHint !== null) {
			stopForDisconnectedAgent(stopHint);
			return null;
		}
		if (isAuthFailure(e)) {
			log.error("engine.auth_failed", { origin: "boot_project_fetch" });
			process.exitCode = 2;
			// Same launchd self-unload as the main auth-failure
			// handler below — boot-time auth failure also needs
			// supervision removal on macOS or launchd respawns
			// the daemon every 10s.
			removeLaunchdDaemonSupervision(opts.adapter.agentType);
			opts.abortController.abort();
			return null;
		}
		throw e;
	}
	log.info("engine.project_resolved", { default_project_id: defaultProjectId });
	for (const [skillKey, hash] of readSkillProjectionState(
		opts.adapter.agentType,
		opts.environmentId,
		defaultProjectId,
	).claims) {
		lastPushedHash.set(skillKey, hash);
	}
	log.info("engine.skill_projection_claims_loaded", { skill_count: lastPushedHash.size });

	let projectSkillReconcileRunning: Promise<void> | null = null;
	let projectSkillReconcileRequested = false;
	const reconcileProjectSkills = (): Promise<void> => {
		if (!connectedProjectSkillDelivery) return Promise.resolve();
		projectSkillReconcileRequested = true;
		if (projectSkillReconcileRunning) return projectSkillReconcileRunning;
		projectSkillReconcileRunning = (async () => {
			while (projectSkillReconcileRequested && !opts.abort.aborted) {
				projectSkillReconcileRequested = false;
				await reconcileConnectedProjectSkills({
					api,
					agentId: opts.environmentId,
					agentType: opts.adapter.agentType,
					skills,
				});
			}
		})().finally(() => {
			projectSkillReconcileRunning = null;
		});
		return projectSkillReconcileRunning;
	};
	if (connectedProjectSkillDelivery) {
		try {
			await reconcileProjectSkills();
			syncHealth.clear("projection", "project_skills");
		} catch (error) {
			syncHealth.set("projection", "project_skills", `Project Skills: ${toErrorMessage(error)}`);
			log.warn("engine.project_skills_reconcile_failed", {
				origin: "startup",
				error: toErrorMessage(error),
			});
		}
	}

	// Periodically re-fetch the env's default_project_id so a
	// runtime reassignment (rare in v1's 1:1 model, but possible
	// after multi-project-per-env ships) eventually converges.
	// This is intentionally slower than heartbeat: liveness needs
	// minute-level freshness, while project reassignment is rare
	// administrative state. Transient fetch errors keep the
	// last-known-good value but escalate to error-level logging
	// after STALE_PROJECT_THRESHOLD consecutive failures so a
	// long-running project-filter outage shows up in metrics.
	const STALE_PROJECT_THRESHOLD = 3;
	const refreshDefaultProjectIdLoop = async (abort: AbortSignal): Promise<void> => {
		let consecutiveFailures = 0;
		while (!abort.aborted) {
			await sleep(projectRefreshDelayMs(), abort);
			if (abort.aborted) return;
			try {
				const fresh = await fetchDefaultProjectId();
				syncHealth.clear("transport", "project_refresh");
				if (fresh !== defaultProjectId) {
					log.info("engine.project_changed", { from: defaultProjectId, to: fresh });
					defaultProjectId = fresh;
					lastReconciledListingEtag = null;
					lastPushedHash.clear();
					for (const [skillKey, hash] of readSkillProjectionState(
						opts.adapter.agentType,
						opts.environmentId,
						fresh,
					).claims) {
						lastPushedHash.set(skillKey, hash);
					}
					// Re-scan under the new identity fence. A current push
					// first removes exact old-Project claims, then projects
					// the latest local bytes; it never redirects a stale item.
					await reconcileAgentSkillProjection({
						opts,
						skills,
						queue,
						claims: lastPushedHash,
						projectId: fresh,
					}).catch((e) => {
						log.warn("engine.project_change_rescan_failed", {
							error: toErrorMessage(e),
						});
					});
					try {
						const catchUp = await reconcileAgentSkillProjectionListing({
							api,
							opts,
							skills,
							queue,
							claims: lastPushedHash,
							projectId: fresh,
							previousEtag: null,
						});
						if (catchUp.complete) {
							lastReconciledListingEtag = catchUp.etag;
							updateLastSeenRevision(catchUp.revision);
						}
					} catch (error) {
						log.warn("engine.project_change_listing_failed", {
							error: toErrorMessage(error),
						});
					}
				}
				consecutiveFailures = 0;
			} catch (e) {
				const stopHint = agentLookupStopHint(e);
				if (stopHint !== null) {
					stopForDisconnectedAgent(stopHint);
					return;
				}
				if (isAuthFailure(e)) {
					triggerAuthFailureAbort("project_refresh");
					return;
				}
				consecutiveFailures += 1;
				const fields = {
					error: toErrorMessage(e),
					consecutive_failures: consecutiveFailures,
					stale_project_id: defaultProjectId,
				};
				if (consecutiveFailures >= STALE_PROJECT_THRESHOLD) {
					syncHealth.set("transport", "project_refresh", `project_refresh: ${toErrorMessage(e)}`);
					log.error("engine.project_filter_stale", fields);
				} else {
					log.warn("engine.project_filter_refresh_failed", fields);
				}
			}
		}
	};

	// Initial sync derives projection work from local inventory and exact
	// claims. A complete, strong-ETag project listing supplies only per-key
	// migration evidence for unclaimed legacy rows; it never supplies local
	// bytes. The same fenced comparison runs periodically for missed SSE.
	//
	// Auth failures during initial projection sync (token revoked between the
	// env lookup and /api/skills, or a deploy key with
	// `skills:read` removed) MUST route through
	// `triggerAuthFailureAbort` so the daemon exits with code 2
	// — supervised installs depend on
	// `RestartPreventExitStatus=2` (systemd) and the launchd
	// self-unload to break the restart loop. Pre-fix the 401/403
	// bubbled out as a generic Error, serve() exited with code 1,
	// and launchd / systemd kept respawning indefinitely.
	try {
		await initialAgentProjectionSync(
			opts,
			skills,
			api,
			queue,
			lastPushedHash,
			defaultProjectId,
			(rev, etag) => {
				updateLastSeenRevision(rev);
				lastReconciledListingEtag = etag;
			},
			syncHealth,
		);
	} catch (e) {
		if (isAuthFailure(e)) {
			triggerAuthFailureAbort("initial_sync");
			// Wait for the abort to propagate so the heartbeat lands
			// before the process exits. The same shape SSE / drain /
			// reconcile use after triggerAuthFailureAbort.
			return null;
		}
		throw e;
	}
	// Push side: wire watcher → enqueue.
	const onLocalChange = (skillKey: string) => {
		const scanResource = `skill_scan:${skillKey}`;
		void enqueueIfChanged(opts, skills, queue, lastPushedHash, skillKey, () => defaultProjectId)
			.then(() => {
				syncHealth.clear("push", scanResource);
			})
			.catch((e) => {
				syncHealth.set("push", scanResource, `skill ${skillKey} scan: ${toErrorMessage(e)}`);
				log.warn("engine.enqueue_failed", { skill_key: skillKey, error: toErrorMessage(e) });
			});
	};
	let inventoryScanRunning = false;
	let inventoryScanRequested = false;
	const onSkillInventoryChanged = () => {
		inventoryScanRequested = true;
		if (inventoryScanRunning) return;
		inventoryScanRunning = true;
		void (async () => {
			try {
				while (inventoryScanRequested && !opts.abort.aborted) {
					inventoryScanRequested = false;
					await reconcileAgentSkillProjection({
						opts,
						skills,
						queue,
						claims: lastPushedHash,
						projectId: defaultProjectId,
					});
				}
				syncHealth.clear("push", "skills_scan");
			} catch (error) {
				syncHealth.set("push", "skills_scan", `skills scan: ${toErrorMessage(error)}`);
				log.warn("engine.skills_rescan_failed", { error: toErrorMessage(error) });
			} finally {
				inventoryScanRunning = false;
			}
		})();
	};

	// Cloud events are invalidation hints only. Agent Skill content is authored
	// in this filesystem, so an SSE change/delete must never write or remove a
	// local target. Re-scan the key and project the latest local state instead.
	const onServerEvent = async (event: ServerEvent) => {
		if (event.type === "runtime_manifest_changed") {
			if (event.environment_id !== opts.environmentId || !connectedProjectSkillDelivery) return;
			try {
				await reconcileProjectSkills();
				syncHealth.clear("projection", "project_skills");
			} catch (error) {
				syncHealth.set("projection", "project_skills", `Project Skills: ${toErrorMessage(error)}`);
				log.warn("engine.project_skills_reconcile_failed", { error: toErrorMessage(error) });
			}
			return;
		}
		const invalidatedSkillKey = skillInvalidationKey(event, defaultProjectId);
		if (invalidatedSkillKey === null) {
			log.debug("engine.sse_event_other_project", {
				type: event.type,
				skill_key: event.skill_key,
				event_project_id: event.project_id,
				my_project_id: defaultProjectId,
			});
			return;
		}
		updateLastSeenRevision(event.skills_revision);
		log.debug("engine.sse_skill_invalidation", {
			type: event.type,
			skill_key: event.skill_key,
		});
		const scanResource = `skill_scan:${invalidatedSkillKey}`;
		try {
			// A current Agent-Project event is authenticated migration evidence
			// for this exact key. The current CLI can fall back to the generic
			// compatibility route: project current local bytes when present, or
			// report authoritative local absence. Never consume Cloud bytes.
			await reconcileAgentSkillProjection({
				opts,
				skills,
				queue,
				claims: lastPushedHash,
				projectId: defaultProjectId,
				trustedLegacyRemoteKeys: new Set([invalidatedSkillKey]),
			});
			syncHealth.clear("push", scanResource);
		} catch (error) {
			syncHealth.set(
				"push",
				scanResource,
				`skill ${invalidatedSkillKey} scan: ${toErrorMessage(error)}`,
			);
			log.warn("engine.enqueue_failed", {
				skill_key: invalidatedSkillKey,
				error: toErrorMessage(error),
			});
		}
	};

	return {
		queueModule: { module: skills, getProjectId: () => defaultProjectId },
		lastPushedHash,
		run: async () => {
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
					listSkillKeys: () => skills.listKeys(),
					onInventoryChanged: onSkillInventoryChanged,
				}),
				consumeSse({
					apiUrl: api.baseUrl,
					apiKey: api.apiKey,
					getAccessToken: () => api.getAccessToken(),
					abort: opts.abort,
					onEvent: onServerEvent,
					onConnect: () => {
						syncHealth.clear("transport", "sse");
					},
					onDisconnect: (info) => {
						const nextError = lastSyncErrorForSseReconnect(info);
						if (nextError !== null) syncHealth.set("transport", "sse", nextError);
					},
					onAuthFailure: () => triggerAuthFailureAbort("sse_channel"),
				}),
				refreshDefaultProjectIdLoop(opts.abort),
				// Safety-net for Skills. The local scan recovers evicted watcher work;
				// the strong-ETag Agent-Project listing catches mixed-version generic
				// alias writes whose live-only SSE event was missed during disconnect.
				// A 304 supplies no new per-key migration evidence. Periodic cycles force
				// a complete 200 so evicted or lost work can be derived again at the same
				// revision. Cloud bytes are never read or applied locally.
				(async () => {
					while (!opts.abort.aborted) {
						await sleep(reconcileDelayMs(), opts.abort);
						if (opts.abort.aborted) return;
						try {
							await reconcileProjectSkills();
							syncHealth.clear("projection", "project_skills");
							await reconcileAgentSkillProjection({
								opts,
								skills,
								queue,
								claims: lastPushedHash,
								projectId: defaultProjectId,
							});
							const catchUp = await reconcileAgentSkillProjectionListing({
								api,
								opts,
								skills,
								queue,
								claims: lastPushedHash,
								projectId: defaultProjectId,
								previousEtag: lastReconciledListingEtag,
								forceComplete: true,
							});
							if (catchUp.complete) {
								lastReconciledListingEtag = catchUp.etag;
								updateLastSeenRevision(catchUp.revision);
								syncHealth.clear("projection", "listing");
							} else {
								syncHealth.set(
									"projection",
									"listing",
									"reconcile: cloud skill listing was incomplete or unfenced",
								);
							}
							syncHealth.clear("push", "skills_scan");
						} catch (e) {
							syncHealth.set("push", "skills_scan", `skills scan: ${toErrorMessage(e)}`);
							log.warn("engine.skills_rescan_failed", { error: toErrorMessage(e) });
						}
					}
				})(),
			]);
		},
	};
}

async function runSkillSync(
	_opts: EngineOpts,
	skills: SkillModule,
	prepared: PreparedSkillSync,
): Promise<void> {
	if (prepared.queueModule.module !== skills)
		throw new Error("Skills module changed during startup");
	await prepared.run();
}

interface PreparedSessionSync {
	queueModule: { module: SessionModule; protocol: SelectedSessionProtocol };
	lastPushedHash: Map<string, string>;
	run(): Promise<void>;
}

async function prepareSessionSync(
	opts: EngineOpts,
	sessions: SessionModule,
	common: CommonSyncRuntime,
): Promise<PreparedSessionSync> {
	const { api, queue, health, inFlightSessionHash } = common;
	const protocol = await negotiateSessionProtocol(api, sessions);
	const lastPushedSessionHash = loadFencedSessionHashes(api, opts);
	for (const entry of currentFencedSessionEntries(api, opts)) {
		if (entry.blocked) {
			health.set(
				"push",
				`session:${entry.source_session_key}`,
				`blocked: ${entry.blocked.message}`,
			);
		}
	}
	let pendingScan: SessionScanRequest | null = null;
	let activeScan: Promise<void> | null = null;

	const executeScan = async (request: SessionScanRequest): Promise<void> => {
		if (opts.abort.aborted) return;
		try {
			const scan = await scanSessionModule(
				sessions,
				request,
				loadFencedSessionSourceRevisions(api, opts, protocol),
			);
			const observedResources = new Set<string>();
			const confirmedSourceRevisions: FencedSessionSourceRevisionUpdate[] = [];
			let enqueued = 0;
			for await (const batch of scan.batches) {
				for (const localSessionId of batch.observedLocalSessionIds) {
					observedResources.add(`session:${localSessionId}`);
				}
				const result = await enqueueChangedSessionsAfterStability({
					abort: opts.abort,
					sessions: batch.sessions,
					queue,
					lastPushedHash: lastPushedSessionHash,
					inFlightHash: inFlightSessionHash,
					protocol,
					fenceFor: (session) =>
						sessionFence(api, {
							environmentId: opts.environmentId,
							adapter: opts.adapter.agentType,
							sourceSessionKey: session.localSessionId,
						}),
					onBlocked: (session, message) => {
						health.set("push", `session:${session.localSessionId}`, `blocked: ${message}`);
						lastPushedSessionHash.set(
							session.localSessionId,
							planSessionUpload(session, protocol).localHash,
						);
					},
				});
				enqueued += result.enqueued;
				confirmedSourceRevisions.push(...result.confirmedSourceRevisions);
				if (opts.abort.aborted) return;
			}
			persistFencedSessionSourceRevisions(confirmedSourceRevisions);
			if (scan.coverage === "complete") {
				health.clearAbsent("push", "session:", observedResources);
			}
			health.clear("push", "session_scan");
			if (enqueued > 0) log.info("engine.sessions_enqueued", { count: enqueued });
		} catch (error) {
			if (opts.abort.aborted) return;
			health.set("push", "session_scan", `session scan: ${toErrorMessage(error)}`);
			log.warn("engine.sessions_enumerate_failed", { error: toErrorMessage(error) });
		}
	};

	const mergeScanRequest = (
		current: SessionScanRequest | null,
		next: SessionScanRequest,
	): SessionScanRequest => {
		if (!current || current.kind === "complete" || next.kind === "complete") {
			return current?.kind === "complete" ? current : next;
		}
		return { kind: "paths", paths: [...new Set([...current.paths, ...next.paths])] };
	};
	const requestScan = (event?: SessionWatchEvent): Promise<void> => {
		const request: SessionScanRequest = event?.kind === "paths" ? event : { kind: "complete" };
		pendingScan = mergeScanRequest(pendingScan, request);
		if (!activeScan) {
			activeScan = (async () => {
				while (pendingScan && !opts.abort.aborted) {
					const next = pendingScan;
					pendingScan = null;
					await executeScan(next);
				}
			})().finally(() => {
				activeScan = null;
			});
		}
		return activeScan;
	};

	return {
		queueModule: { module: sessions, protocol },
		lastPushedHash: lastPushedSessionHash,
		run: async () => {
			await Promise.all([
				requestScan(),
				watchSessions({
					paths: sessions.watchPaths(),
					abort: opts.abort,
					onPathStable: (change) => {
						if (!opts.abort.aborted) void requestScan(change);
					},
					forcePoll: opts.forcePollWatcher,
				}),
				(async () => {
					while (!opts.abort.aborted) {
						await sleep(RECONCILE_INTERVAL_MS, opts.abort);
						if (!opts.abort.aborted) await requestScan();
					}
				})(),
			]);
		},
	};
}

async function runSessionSync(
	_opts: EngineOpts,
	sessions: SessionModule,
	prepared: PreparedSessionSync,
): Promise<void> {
	if (prepared.queueModule.module !== sessions)
		throw new Error("Sessions module changed during startup");
	await prepared.run();
}

function loadFencedSessionHashes(api: ApiClient, opts: EngineOpts): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const value of currentFencedSessionEntries(api, opts)) {
		if (value.pending === undefined) {
			hashes.set(value.source_session_key, value.local_hash);
		}
	}
	return hashes;
}

function loadFencedSessionSourceRevisions(
	api: ApiClient,
	opts: EngineOpts,
	protocol: SelectedSessionProtocol,
): Map<string, string> {
	const revisions = new Map<string, string>();
	for (const value of currentFencedSessionEntries(api, opts)) {
		if (value.protocol === protocol && value.pending === undefined && value.source_revision) {
			revisions.set(value.source_session_key, value.source_revision);
		}
	}
	return revisions;
}

function currentFencedSessionEntries(api: ApiClient, opts: EngineOpts): FencedSessionLockEntry[] {
	const lock = readSessionsLock();
	if (lock.version !== 2) return [];
	const apiOrigin = canonicalApiOrigin(api.baseUrl);
	return Object.values(lock.sessions).filter(
		(value): value is FencedSessionLockEntry =>
			"local_hash" in value &&
			value.api_origin === apiOrigin &&
			value.environment_id === opts.environmentId &&
			value.adapter === opts.adapter.agentType,
	);
}

function enqueueMaterializedSkillClaimCleanup(
	opts: {
		environmentId: string;
		adapter: Pick<AgentAdapter, "agentType">;
	},
	queue: RetryQueue,
	skillKey: string,
): void {
	const claim = readSkillProjectionClaimsForAgent(opts.adapter.agentType, opts.environmentId)
		.filter((candidate) => candidate.skill_key === skillKey)
		.sort((left, right) => left.project_id.localeCompare(right.project_id))[0];
	if (!claim) return;
	const cleanupPending = queue
		.all()
		.some(
			(item) =>
				item.kind === "skill_delete" &&
				item.skill_key === skillKey &&
				item.agent_id === opts.environmentId,
		);
	if (cleanupPending) return;
	queue.enqueue({
		kind: "skill_delete",
		skill_key: skillKey,
		agent_id: opts.environmentId,
		project_id: claim.project_id,
		enqueued_at: new Date().toISOString(),
		attempts: 0,
	});
	log.info("engine.enqueue_project_materialization_claim_cleanup", {
		skill_key: skillKey,
		project_id: claim.project_id,
	});
}

async function enqueueIfChanged(
	opts: EngineOpts,
	skills: SkillModule,
	queue: RetryQueue,
	lastPushedHash: Map<string, string>,
	skillKey: string,
	getProjectId: () => string,
): Promise<void> {
	if (!isValidSkillKey(skillKey)) {
		log.warn("engine.invalid_skill_key_skipped", { skill_key: skillKey });
		return;
	}
	if (
		readProjectSkillMaterialization({
			agentType: opts.adapter.agentType,
			localSkillKey: skillKey,
		})
	) {
		enqueueMaterializedSkillClaimCleanup(opts, queue, skillKey);
		log.debug("engine.project_skill_materialization_skipped", { skill_key: skillKey });
		return;
	}
	const dir = join(skills.rootDir(), skillKey);
	const projectId = getProjectId();
	if (isReservedSkill(skills, skillKey) || !existsSync(join(dir, "SKILL.md"))) {
		if (!lastPushedHash.has(skillKey)) return;
		const version = queue.enqueue({
			kind: "skill_delete",
			skill_key: skillKey,
			agent_id: opts.environmentId,
			project_id: projectId,
			enqueued_at: new Date().toISOString(),
			attempts: 0,
		});
		log.info("engine.enqueue_skill_delete", {
			skill_key: skillKey,
			version,
			queue_depth: queue.depth,
		});
		return;
	}
	let hash: string;
	try {
		hash = await computeSkillFolderHash(dir, undefined, skillKey);
	} catch (e) {
		// The path can disappear between the existence check and hash walk.
		// Preserve the exact claim and enqueue its durable absence report.
		if (!existsSync(dir)) {
			if (lastPushedHash.has(skillKey)) {
				queue.enqueue({
					kind: "skill_delete",
					skill_key: skillKey,
					agent_id: opts.environmentId,
					project_id: projectId,
					enqueued_at: new Date().toISOString(),
					attempts: 0,
				});
			}
			return;
		}
		throw e;
	}
	if (lastPushedHash.get(skillKey) === hash) {
		// No-op local touch; the exact projection claim already matches.
		log.debug("engine.skill_unchanged", { skill_key: skillKey });
		return;
	}
	// Stamp the current project_id on the queue item. If the daemon's
	// default_project_id changes between enqueue and drain (rare in
	// v1, but possible when multi-project-per-env arrives), we drop
	// the stamped item rather than upload it under a different
	// project. Without the stamp, a queue carrying writes under
	// project A would silently get redirected to project B on
	// reassignment.
	const version = queue.enqueue({
		kind: "skill_push",
		skill_key: skillKey,
		agent_id: opts.environmentId,
		project_id: projectId,
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

/** Auth failure on projection/listing: not "permanent for this item"
 * — the api key is dead and EVERY request will fail the same way.
 * Callers use this to short-circuit log-and-continue retry storms; the
 * queue also uses it to skip the permanent-drop classifier.
 * Exported only for unit testing. */
export function isAuthFailure(e: unknown): boolean {
	if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return true;
	return false;
}

export function lastSyncErrorForSseReconnect(
	info: Pick<SseReconnectInfo, "reason" | "classification">,
): string | null {
	return info.classification === "sustained" ? `sse_disconnect:${info.reason}` : null;
}

export function classifyHeartbeatFailure(consecutiveFailures: number): FailureClassification {
	return consecutiveFailures <= TRANSIENT_HEARTBEAT_FAILURES ? "transient" : "sustained";
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
export function isPermanentUploadError(e: unknown): boolean {
	if (e instanceof SkillKeyValidationError) return true;
	// A dedicated Agent sync 404 is deliberately ambiguous between an older
	// backend without the route and a current backend hiding an unproven Agent
	// identity. Never redirect it to a generic Project write, release a claim,
	// or drop the durable operation as a terminal content error.
	if (e instanceof AgentSkillSyncNotFoundError) return false;
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
	modules: {
		sessions: { module: SessionModule; protocol: SelectedSessionProtocol } | null;
		skills: { module: SkillModule; getProjectId: () => string } | null;
	},
	lastPushedHash: Map<string, string>,
	lastPushedSessionHash: Map<string, string>,
	inFlightSessionHash: Map<string, string>,
	health: SyncHealth,
	onAuthFailure: (origin: string) => void,
): Promise<void> {
	const healthResource = (item: QueueItem): string =>
		item.kind === "session_push" ? `session:${item.local_session_id}` : `skill:${item.skill_key}`;
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

	// Common terminal-drop bookkeeping shared by oversized / permanent /
	// retry-exhausted branches. Each branch owns its health contract:
	// oversized clears only a same-resource transient, while permanent
	// and retry-exhausted failures remain unresolved until that exact
	// resource is later applied or disappears.
	const dropItem = (item: QueueItem) => {
		queue.recordPermanentDrop();
		clearInFlight(item);
		queue.markDoneIfVersion(item);
	};
	while (!opts.abort.aborted) {
		const item = queue.peek();
		if (!item) {
			await queue.waitForItem(opts.abort, QUEUE_IDLE_WAKEUP_MS);
			continue;
		}
		try {
			const outcome = await processQueueItem(
				opts,
				api,
				queue,
				item,
				modules,
				lastPushedHash,
				lastPushedSessionHash,
				inFlightSessionHash,
			);
			if (outcome === "applied" || outcome === "absent") {
				health.clear("push", healthResource(item));
			} else if (outcome === "blocked") {
				health.set(
					"push",
					healthResource(item),
					`blocked: ${item.kind === "session_push" ? `session ${item.local_session_id}` : `skill ${item.skill_key}`} exceeds an upload limit`,
				);
			} else {
				health.setIfAbsent(
					"push",
					healthResource(item),
					`${item.kind === "session_push" ? `session ${item.local_session_id}` : `skill ${item.skill_key}`} projection was not applied; awaiting rescan`,
					true,
				);
			}
		} catch (e) {
			const msg = toErrorMessage(e);
			const resource = healthResource(item);
			// Auth dead → daemon abort, not queue drop. Every
			// upload from this point will fail the same way
			// because the api key is revoked. Dropping the queue
			// item would lose its work; aborting the daemon makes
			// the OS supervisor's restart bring the user's
			// attention to it (status badge flips to "errored",
			// dialog shows "log in again with `clawdi auth login`").
			if (isAuthFailure(e)) {
				// Surface the raw failure on the heartbeat so the
				// next dashboard poll (before triggerAuthFailureAbort
				// overwrites with "auth_revoked: ...") still carries
				// signal. The unified path takes over on the next
				// poll, but this prevents the heartbeat from looking
				// healthy in the gap.
				health.set("push", resource, msg);
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
				// Oversized is terminal for this exact resource. Clear
				// only its prior transient push failure; the dropped
				// counter remains the user-visible oversized signal.
				health.clearTransient("push", resource);
				dropItem(item);
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
				health.set("push", resource, `permanent: ${msg}`);
				// `dropItem` bumps the dropped counter so the
				// dashboard's "dropped" pill shows non-evict drops
				// too. Pre-fix only FIFO eviction ticked the counter
				// and a 4xx-rejected session vanished without any UI
				// signal.
				dropItem(item);
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
				health.set("push", resource, `retry_exhausted: ${msg}`);
				dropItem(item);
			} else {
				log.warn("engine.queue_retry", {
					item: redactItem(item),
					error: msg,
					attempts: newAttempts,
				});
				// Surface the transient error on the heartbeat so
				// the dashboard reflects "something is going wrong
				// right now" while the daemon keeps retrying.
				// Cleared on the next successful drain (top of this
				// try block).
				health.set("push", resource, msg, true);
				await sleep(QUEUE_RETRY_INTERVAL_MS, opts.abort);
			}
		}
	}
}

type QueueProcessOutcome = "applied" | "absent" | "blocked" | "not_applied";

export async function processQueueItem(
	opts: EngineOpts,
	api: ApiClient,
	queue: RetryQueue,
	item: QueueItem,
	modules: {
		sessions: { module: SessionModule; protocol: SelectedSessionProtocol } | null;
		skills: { module: SkillModule; getProjectId: () => string } | null;
	},
	lastPushedHash: Map<string, string>,
	lastPushedSessionHash: Map<string, string>,
	inFlightSessionHash: Map<string, string>,
): Promise<QueueProcessOutcome> {
	if (item.kind === "skill_push" || item.kind === "skill_delete") {
		if (!modules.skills) {
			log.warn("engine.queue_module_missing_dropped", { kind: item.kind, module: "skills" });
			queue.markDoneIfVersion(item);
			return "not_applied";
		}
		const projectId = modules.skills.getProjectId();
		const materialization = readProjectSkillMaterialization({
			agentType: opts.adapter.agentType,
			localSkillKey: item.skill_key,
		});
		if (materialization && item.kind === "skill_push") {
			queue.markDoneIfVersion(item);
			log.info("engine.project_skill_queue_item_dropped", {
				kind: item.kind,
				skill_key: item.skill_key,
			});
			return "absent";
		}
		if (item.agent_id === undefined || item.project_id === undefined) {
			log.warn("engine.queue_identity_mismatch_dropped", {
				kind: item.kind,
				skill_key: item.skill_key,
				stamped_agent_id: item.agent_id,
				current_agent_id: opts.environmentId,
				stamped_project_id: item.project_id,
				current_project_id: projectId,
			});
			queue.markDoneIfVersion(item);
			return "not_applied";
		}
		if (item.agent_id !== opts.environmentId) {
			// A reused adapter home must never apply the previous Agent's work.
			// Drop only the queue item; its fenced claim remains durable and is
			// never reinterpreted as authority for the current Agent.
			log.warn("engine.queue_agent_mismatch_deferred", {
				kind: item.kind,
				skill_key: item.skill_key,
				stamped_agent_id: item.agent_id,
				current_agent_id: opts.environmentId,
			});
			queue.markDoneIfVersion(item);
			return "not_applied";
		}
		if (materialization && item.kind === "skill_delete") {
			// A pull may fence Project-owned bytes immediately after this key
			// held an Agent projection. Exact claims remain the sole deletion
			// authority; retire every one before releasing the durable task.
			const claims = readSkillProjectionClaimsForAgent(
				opts.adapter.agentType,
				opts.environmentId,
			).filter((claim) => claim.skill_key === item.skill_key);
			for (const claim of claims) {
				await api.deleteAgentSkill(opts.environmentId, item.skill_key, claim.project_id);
				removeSkillProjectionClaim({
					agentType: opts.adapter.agentType,
					agentId: opts.environmentId,
					projectId: claim.project_id,
					skillKey: item.skill_key,
				});
			}
			lastPushedHash.delete(item.skill_key);
			queue.markDoneIfVersion(item);
			log.info("engine.project_skill_projection_claims_retired", {
				skill_key: item.skill_key,
				claim_count: claims.length,
			});
			return claims.length > 0 ? "applied" : "absent";
		}
		for (const staleProjectId of staleSkillProjectionProjectIds(
			opts.adapter.agentType,
			opts.environmentId,
			item.skill_key,
			projectId,
		)) {
			await api.deleteAgentSkill(opts.environmentId, item.skill_key, staleProjectId);
			removeSkillProjectionClaim({
				agentType: opts.adapter.agentType,
				agentId: opts.environmentId,
				projectId: staleProjectId,
				skillKey: item.skill_key,
			});
		}
		if (item.project_id !== projectId && item.kind === "skill_push") {
			// Project reassignment is a two-step handoff: remove any projection
			// fenced to the stamped old Project, then re-scan so the latest local
			// state is enqueued for the current Project. Never redirect old bytes.
			await api.deleteAgentSkill(opts.environmentId, item.skill_key, item.project_id);
			removeSkillProjectionClaim({
				agentType: opts.adapter.agentType,
				agentId: opts.environmentId,
				projectId: item.project_id,
				skillKey: item.skill_key,
			});
			queue.markDoneIfVersion(item);
			await enqueueIfChanged(
				opts,
				modules.skills.module,
				queue,
				lastPushedHash,
				item.skill_key,
				() => projectId,
			);
			return "applied";
		}
		if (item.kind === "skill_delete") {
			await api.deleteAgentSkill(opts.environmentId, item.skill_key, item.project_id);
			removeSkillProjectionClaim({
				agentType: opts.adapter.agentType,
				agentId: opts.environmentId,
				projectId: item.project_id,
				skillKey: item.skill_key,
			});
			if (item.project_id === projectId) lastPushedHash.delete(item.skill_key);
			const removed = queue.markDoneIfVersion(item);
			if (!removed) {
				log.info("engine.queue_superseded", {
					skill_key: item.skill_key,
					version: item.version,
				});
			}
			log.info("engine.skill_projection_deleted", { skill_key: item.skill_key });
			if (item.project_id !== projectId) {
				await enqueueIfChanged(
					opts,
					modules.skills.module,
					queue,
					lastPushedHash,
					item.skill_key,
					() => projectId,
				);
			}
			return "applied";
		}
		if (isReservedSkill(modules.skills.module, item.skill_key)) {
			await api.deleteAgentSkill(opts.environmentId, item.skill_key, item.project_id);
			removeSkillProjectionClaim({
				agentType: opts.adapter.agentType,
				agentId: opts.environmentId,
				projectId: item.project_id,
				skillKey: item.skill_key,
			});
			lastPushedHash.delete(item.skill_key);
			queue.markDoneIfVersion(item);
			return "applied";
		}
		// Every accepted Skill item is Agent+Project fenced above. The current
		// item can now safely project the latest local bytes.
		await uploadSkillFromQueue(opts, modules.skills.module, api, item, lastPushedHash, projectId);
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
		return "applied";
	}
	if (item.kind === "session_push") {
		if (!modules.sessions) {
			log.warn("engine.queue_module_missing_dropped", { kind: item.kind, module: "sessions" });
			queue.markDoneIfVersion(item);
			return "not_applied";
		}
		const expectedFence = sessionFence(api, {
			environmentId: opts.environmentId,
			adapter: opts.adapter.agentType,
			sourceSessionKey: item.source_session_key ?? item.local_session_id,
		});
		if (
			!hasSessionFence(item) ||
			item.api_origin !== expectedFence.apiOrigin ||
			item.environment_id !== expectedFence.environmentId ||
			item.adapter !== expectedFence.adapter ||
			item.source_session_key !== expectedFence.sourceSessionKey
		) {
			log.warn("engine.queue_identity_mismatch_dropped", {
				kind: item.kind,
				local_session_id: item.local_session_id,
			});
			queue.markDoneIfVersion(item);
			return "not_applied";
		}
		const result = await uploadSessionFromQueue(
			opts,
			modules.sessions.module,
			modules.sessions.protocol,
			api,
			item,
			expectedFence,
		);
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
		// the session vanished or was rejected mid-flight, only an
		// applied result updates confirmed state; the outcome below
		// independently decides whether resource health is resolved.
		// Leave the in-memory state untouched so the next watcher
		// tick can decide.
		if (result.outcome === "applied" || result.outcome === "blocked") {
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
		return result.outcome;
	}
	const _exhaustive: never = item;
	log.warn("engine.queue_unknown_kind", { item: _exhaustive });
	return "not_applied";
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
	sessions: SessionModule,
	protocol: SelectedSessionProtocol,
	api: ApiClient,
	item: Extract<QueueItem, { kind: "session_push" }>,
	fence: SessionFence,
): Promise<
	| { outcome: "applied" | "blocked"; actualHash: string }
	| { outcome: "absent" }
	| { outcome: "not_applied" }
> {
	if (!hasSessionFence(item)) return { outcome: "not_applied" };
	const session = await sessions.resolve(item.source_session_key);
	if (!session) {
		log.info("engine.session_gone", { local_session_id: item.local_session_id });
		return { outcome: "absent" };
	}
	if (session.messages.length === 0) {
		// Session file exists but parsed empty — push the metadata
		// row anyway so the dashboard knows the session existed,
		// but skip the content blob.
		log.debug("engine.session_empty", { local_session_id: item.local_session_id });
	}

	// Resolve the current backing store and derive a fresh canonical plan. The
	// queued hash/cursor is only a wake-up hint and never an append fence.
	const plan = planSessionUpload(session, protocol);
	const actualHash = plan.localHash;

	const result = unwrap(
		await api.POST("/v1/sessions/batch", {
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
						content_protocol: plan.protocol,
						content_hash: plan.protocol === "snapshot-v1" ? plan.localHash : null,
					},
				],
			},
		}),
	);

	// Server flagged this id as a cross-env race casualty (see
	// SessionBatchResponse.rejected). Don't upload content, don't
	// persist the lock, and crucially return `not_applied` without
	// the actualHash. The queue item is removed, but confirmed state
	// and health remain unresolved so the 5-minute rescan re-enqueues
	// it and a later real success can clear the exact resource.
	if (result.rejected?.includes(session.localSessionId)) {
		log.warn("engine.session_push_rejected", {
			local_session_id: session.localSessionId,
			reason: "cross_env_race",
		});
		return { outcome: "not_applied" };
	}

	const suppressed = result.suppressed?.includes(session.localSessionId) ?? false;
	if (suppressed) {
		persistSuppressedSession(fence, session, plan);
	} else {
		const content = await syncSessionContent({
			api,
			fence,
			session,
			plan,
			needsSnapshotContent: result.needs_content.includes(session.localSessionId),
		});
		if (content.status === "blocked") {
			log.warn("engine.session_sync_blocked", {
				local_session_id: session.localSessionId,
				error: content.message,
			});
			return { outcome: "blocked", actualHash };
		}
	}

	if (suppressed) {
		log.info("engine.session_sync_suppressed", {
			local_session_id: session.localSessionId,
			desired_state: "cloud_deleted",
		});
	} else {
		log.info("engine.session_pushed", {
			local_session_id: session.localSessionId,
			message_count: session.messageCount,
			uploaded_content: result.needs_content.includes(session.localSessionId),
		});
	}
	return { outcome: "applied", actualHash };
}

async function uploadSkillFromQueue(
	opts: EngineOpts,
	skills: SkillModule,
	api: ApiClient,
	item: Extract<QueueItem, { kind: "skill_push" }>,
	lastPushedHash: Map<string, string>,
	projectId: string,
): Promise<void> {
	const dir = join(skills.rootDir(), item.skill_key);
	// Recompute the hash from the live directory at upload time
	// rather than trusting `item.new_hash`. The watcher's hash
	// could have aged out: enqueue stamps a hash, then the user
	// edits the file before drain reaches this item, then
	// `tarSkillDir` reads the post-edit content. Trusting the
	// stale hash makes the server store bytes whose tree-hash
	// disagrees with the DB's `content_hash` column.
	//
	// Take at most two complete snapshots. If the published path+bytes tree
	// shifted between them, retry; otherwise upload the second snapshot whose
	// hash was derived from that exact validated archive.
	const firstSnapshot = await snapshotSkillArchive(dir, undefined, item.skill_key);
	const uploadSnapshot = await snapshotSkillArchive(dir, undefined, item.skill_key);
	if (firstSnapshot.hash !== uploadSnapshot.hash) {
		log.warn("engine.skill_push_disk_shifted", {
			skill_key: item.skill_key,
			hash_first: firstSnapshot.hash,
			hash_after: uploadSnapshot.hash,
		});
		// Surface as a non-permanent error so drainQueueLoop bumps
		// attempts + sleeps, then retries. The watcher will also
		// have re-enqueued by then with the latest content.
		throw new Error(
			`skill_push: ${item.skill_key} disk shifted mid-tar; will retry with latest content`,
		);
	}
	const actualHash = uploadSnapshot.hash;

	const result = await api.uploadAgentSkill(
		opts.environmentId,
		projectId,
		item.skill_key,
		uploadSnapshot.archive,
		`${item.skill_key}.tar.gz`,
		actualHash,
	);
	lastPushedHash.set(item.skill_key, actualHash);
	recordSkillProjectionClaim({
		agentType: opts.adapter.agentType,
		agentId: opts.environmentId,
		projectId,
		skillKey: item.skill_key,
		hash: actualHash,
	});
	log.info("engine.skill_pushed", {
		skill_key: item.skill_key,
		content_hash: actualHash,
		version: result.version,
	});
}

/** List the exact Agent Project for boot migration and periodic SSE catch-up.
 * Only a complete, single-ETag result may be used as per-key migration
 * evidence; the list is never a source of local content. */
async function listAllCloudSkills(
	api: ApiClient,
	projectId: string,
	ifNoneMatch: string | null,
): Promise<{
	skills: SkillSummary[];
	complete: boolean;
	notModified: boolean;
	revision: number | null;
	etag: string | null;
}> {
	const out: SkillSummary[] = [];
	const seenSkillKeys = new Set<string>();
	const pageSize = 200;
	let page = 1;
	let total: number | null = null;
	let revision: number | null = null;
	while (true) {
		const res = await api.GET("/v1/skills", {
			params: {
				query: { page, page_size: pageSize, project_id: projectId },
				...(page === 1 && ifNoneMatch ? { header: { "If-None-Match": ifNoneMatch } } : {}),
			},
		});
		const etag = res.response.headers.get("ETag");
		if (res.response.status === 304) {
			return {
				skills: [],
				complete: etag !== null,
				notModified: true,
				revision: parseSkillsRevisionFromEtag(etag),
				etag,
			};
		}
		let pageRevision: number | null = null;
		pageRevision = parseSkillsRevisionFromEtag(etag);
		if (pageRevision === null || (revision !== null && pageRevision !== revision)) {
			log.warn("engine.list_skills_revision_unfenced", {
				page,
				first_revision: revision,
				page_revision: pageRevision,
			});
			return {
				skills: out,
				complete: false,
				notModified: false,
				revision: null,
				etag: null,
			};
		}
		if (page > 1 && etag !== ifNoneMatch && ifNoneMatch !== null) {
			// All pages of one complete inventory must share the first page's
			// strong representation fence.
			return {
				skills: out,
				complete: false,
				notModified: false,
				revision: null,
				etag: null,
			};
		}
		if (page === 1) ifNoneMatch = etag;
		revision = pageRevision;
		const data = unwrap(res);
		if (!Number.isSafeInteger(data.total) || data.total < 0) {
			log.warn("engine.list_skills_invalid_total", { page, total: data.total });
			return incompleteSkillListing(out);
		}
		if (total !== null && data.total !== total) {
			log.warn("engine.list_skills_total_changed", {
				page,
				first_total: total,
				page_total: data.total,
			});
			return incompleteSkillListing(out);
		}
		total = data.total;
		for (const skill of data.items) {
			if (seenSkillKeys.has(skill.skill_key)) {
				log.warn("engine.list_skills_duplicate_key", { page, skill_key: skill.skill_key });
				return incompleteSkillListing(out);
			}
			seenSkillKeys.add(skill.skill_key);
		}
		out.push(...data.items);
		if (out.length > total) {
			log.warn("engine.list_skills_exceeds_total", { page, listed: out.length, total });
			return incompleteSkillListing(out);
		}
		if (out.length === total) break;
		if (data.items.length < pageSize) {
			log.warn("engine.list_skills_ended_early", {
				page,
				page_count: data.items.length,
				listed: out.length,
				total,
			});
			return incompleteSkillListing(out);
		}
		page += 1;
		if (page > 50) {
			log.warn("engine.list_skills_page_cap", { page, total });
			return {
				skills: out,
				complete: false,
				notModified: false,
				revision,
				etag: null,
			};
		}
	}
	return {
		skills: out,
		complete: true,
		notModified: false,
		revision,
		etag: ifNoneMatch,
	};
}

function incompleteSkillListing(skills: SkillSummary[]): {
	skills: SkillSummary[];
	complete: false;
	notModified: false;
	revision: null;
	etag: null;
} {
	return {
		skills,
		complete: false,
		notModified: false,
		revision: null,
		etag: null,
	};
}

function parseSkillsRevisionFromEtag(etag: string | null): number | null {
	if (!etag) return null;
	const parsed = Number.parseInt(etag.replace(/"/g, "").split(":", 1)[0] ?? "", 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function reconcileAgentSkillProjectionListing(input: {
	api: ApiClient;
	opts: {
		environmentId: string;
		adapter: Pick<AgentAdapter, "agentType">;
	};
	skills: SkillModule;
	queue: RetryQueue;
	claims: Map<string, string>;
	projectId: string;
	previousEtag: string | null;
	/** Periodic safety cycles force a 200 so lost/evicted migration evidence
	 * can be re-derived even when the remote collection revision is unchanged. */
	forceComplete?: boolean;
}): Promise<{
	complete: boolean;
	changed: boolean;
	revision: number | null;
	etag: string | null;
}> {
	const listing = await listAllCloudSkills(
		input.api,
		input.projectId,
		input.forceComplete ? null : input.previousEtag,
	);
	if (!listing.complete || listing.revision === null || listing.etag === null) {
		return { complete: false, changed: false, revision: null, etag: null };
	}
	if (listing.notModified) {
		return {
			complete: true,
			changed: false,
			revision: listing.revision,
			etag: listing.etag,
		};
	}
	await reconcileAgentSkillProjection({
		opts: input.opts,
		skills: input.skills,
		queue: input.queue,
		claims: input.claims,
		projectId: input.projectId,
		trustedLegacyRemoteKeys: new Set(listing.skills.map((skill) => skill.skill_key)),
	});
	return {
		complete: true,
		changed: listing.etag !== input.previousEtag,
		revision: listing.revision,
		etag: listing.etag,
	};
}

export async function reconcileAgentSkillProjection(input: {
	opts: {
		environmentId: string;
		adapter: Pick<AgentAdapter, "agentType">;
	};
	skills: SkillModule;
	queue: RetryQueue;
	claims: Map<string, string>;
	projectId: string;
	/** Only pass keys from a complete, project-scoped remote listing. This is
	 * migration evidence for removing unclaimed legacy Agent-Project rows. */
	trustedLegacyRemoteKeys?: ReadonlySet<string>;
}): Promise<void> {
	const { opts, skills, queue, claims, projectId } = input;
	const rootDir = skills.rootDir();
	const localKeys = new Set(filterValidSkillKeysForSync(await skills.listKeys()));
	const exactAgentClaims = readSkillProjectionClaimsForAgent(
		opts.adapter.agentType,
		opts.environmentId,
	);
	const exactClaimKeys = new Set(exactAgentClaims.map((claim) => claim.skill_key));
	const staleExactClaimKeys = new Set(
		exactAgentClaims
			.filter((claim) => claim.project_id !== projectId)
			.map((claim) => claim.skill_key),
	);
	const allKeys = new Set([
		...localKeys,
		...claims.keys(),
		...exactClaimKeys,
		...(input.trustedLegacyRemoteKeys ?? []),
	]);

	for (const skillKey of [...allKeys].sort()) {
		if (
			readProjectSkillMaterialization({
				agentType: opts.adapter.agentType,
				localSkillKey: skillKey,
			})
		) {
			enqueueMaterializedSkillClaimCleanup(opts, queue, skillKey);
			continue;
		}
		const reserved = isReservedSkill(skills, skillKey);
		if (reserved || !localKeys.has(skillKey)) {
			if (
				claims.has(skillKey) ||
				exactClaimKeys.has(skillKey) ||
				input.trustedLegacyRemoteKeys?.has(skillKey)
			) {
				const pendingDelete = queue
					.all()
					.some(
						(item) =>
							item.kind === "skill_delete" &&
							item.skill_key === skillKey &&
							item.agent_id === opts.environmentId &&
							item.project_id === projectId,
					);
				if (!pendingDelete) {
					queue.enqueue({
						kind: "skill_delete",
						skill_key: skillKey,
						agent_id: opts.environmentId,
						project_id: projectId,
						enqueued_at: new Date().toISOString(),
						attempts: 0,
					});
				}
			}
			continue;
		}

		const hash = await computeSkillFolderHash(join(rootDir, skillKey), undefined, skillKey);
		const pendingOperation = queue
			.all()
			.find(
				(item) =>
					(item.kind === "skill_push" || item.kind === "skill_delete") &&
					item.skill_key === skillKey,
			);
		const matchingPendingPush =
			pendingOperation?.kind === "skill_push" &&
			pendingOperation.agent_id === opts.environmentId &&
			pendingOperation.project_id === projectId &&
			pendingOperation.new_hash === hash;
		if (
			matchingPendingPush ||
			(claims.get(skillKey) === hash &&
				pendingOperation?.kind !== "skill_delete" &&
				!staleExactClaimKeys.has(skillKey))
		) {
			continue;
		}
		queue.enqueue({
			kind: "skill_push",
			skill_key: skillKey,
			agent_id: opts.environmentId,
			project_id: projectId,
			new_hash: hash,
			enqueued_at: new Date().toISOString(),
			attempts: 0,
		});
	}
}

async function initialAgentProjectionSync(
	opts: EngineOpts,
	skills: SkillModule,
	api: ApiClient,
	queue: RetryQueue,
	claims: Map<string, string>,
	projectId: string,
	setRevision: (rev: number, etag: string) => void,
	health: SyncHealth,
): Promise<void> {
	await reconcileAgentSkillProjection({ opts, skills, queue, claims, projectId });
	try {
		const catchUp = await reconcileAgentSkillProjectionListing({
			api,
			opts,
			skills,
			queue,
			claims,
			projectId,
			previousEtag: null,
		});
		if (!catchUp.complete || catchUp.revision === null || catchUp.etag === null) {
			health.set(
				"projection",
				"listing",
				"reconcile: cloud skill listing was incomplete or unfenced",
			);
			return;
		}
		health.clear("projection", "listing");
		health.clear("projection", "reconcile");
		setRevision(catchUp.revision, catchUp.etag);
	} catch (error) {
		if (isAuthFailure(error)) throw error;
		// Local operations remain durable while offline. A failed or truncated
		// listing is never used to infer absence; legacy cleanup retries after a
		// later complete listing or an SSE invalidation.
		health.set("projection", "listing", `legacy listing: ${toErrorMessage(error)}`, true);
		log.warn("engine.legacy_skill_listing_failed", { error: toErrorMessage(error) });
	}
}

export function filterValidSkillKeysForSync(
	keys: Iterable<string>,
	opts: { logSkipped?: boolean } = {},
): string[] {
	const logSkipped = opts.logSkipped ?? true;
	const validKeys: string[] = [];
	for (const key of keys) {
		if (isValidSkillKey(key)) {
			validKeys.push(key);
		} else if (logSkipped) {
			log.warn("engine.invalid_skill_key_skipped", { skill_key: key, origin: "adapter_list" });
		}
	}
	return validKeys;
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

function isReservedSkill(skills: SkillModule, skillKey: string): boolean {
	return shouldIgnoreUserSkill(join(skills.rootDir(), skillKey), skillKey);
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
	let heartbeatFailureStreak = 0;
	const send = async () => {
		const fields = snapshot();
		const dropped = queue.drainDroppedDelta();
		const runtimeObserved = readHostedRuntimeObserved();
		try {
			await api.POST("/v1/agents/{agent_id}/sync-heartbeat", {
				params: { path: { agent_id: opts.environmentId } },
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
					...(runtimeObserved ? { runtime_observed: runtimeObserved } : {}),
				},
			});
			heartbeatFailureStreak = 0;
			await touchHealthFile(opts.adapter.agentType);
		} catch (e) {
			// POST failed — restore the unsent dropped delta so the
			// next successful heartbeat carries it. Without this the
			// count is permanently lost on every flaky-network
			// cycle, which is precisely when drops are most likely.
			queue.restoreDroppedDelta(dropped);
			heartbeatFailureStreak += 1;
			const classification = classifyHeartbeatFailure(heartbeatFailureStreak);
			const fields = {
				error: toErrorMessage(e),
				consecutive_failures: heartbeatFailureStreak,
				classification,
			};
			if (classification === "sustained") {
				log.warn("engine.heartbeat_failed", fields);
			} else {
				log.info("engine.heartbeat_failed", fields);
			}
		}
	};

	// Eager first beat. If this fails (network down, env_id
	// unknown), the warn log surfaces it; subsequent retries
	// happen on the normal interval.
	await send();
	while (!abort.aborted) {
		// Per-cycle jitter so daemons started by the same rollout
		// don't all heartbeat in the same wall-clock second. The
		// upper bound stays inside the dashboard's 90s freshness
		// window after the eager first beat.
		await sleep(heartbeatDelayMs(), abort);
		if (abort.aborted) return;
		await send();
	}
}

export function heartbeatDelayMs(random: () => number = Math.random): number {
	const offset = (random() - 0.5) * 2 * HEARTBEAT_JITTER_MS;
	return Math.round(HEARTBEAT_INTERVAL_MS + offset);
}

async function touchHealthFile(agentType: string): Promise<void> {
	const p = join(getServeStateDir(agentType), "health");
	try {
		// JSON shape lets `daemon status` / `daemon doctor` surface
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
	if (item.kind === "skill_push" || item.kind === "skill_delete") {
		return { kind: item.kind, skill_key: item.skill_key, attempts: item.attempts };
	}
	return { kind: item.kind, attempts: item.attempts };
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		// Listener must be removed when the timer fires, otherwise
		// long-running daemon code paths accumulate listeners on the shared
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
