/**
 * Session-directory watcher with file-stable debounce.
 *
 * Hosted sync design requirement: session push is "write-on-detect
 * with file-stable debounce". Push happens after a file has been quiescent for
 * `SESSION_STABLE_AFTER_MS` so we don't upload half-written transcripts
 * mid-conversation.
 *
 * One watcher per adapter. Adapters return a list of paths via
 * `getSessionsWatchPaths()` — directories (Claude Code / Codex /
 * OpenClaw) or SQLite database/sidecar files (Hermes). Any change
 * resets the adapter-wide quiescence timer; once the timer fires,
 * `onPathStable` runs and the engine re-enumerates sessions to
 * find what changed.
 *
 * Why path-level (not per-session) debounce: the watcher doesn't
 * know which session a given fs event corresponds to; the
 * adapter does. Letting the adapter re-enumerate on a "stable"
 * tick is simpler and avoids leaking session-id parsing here.
 *
 * Two modes mirror the skill watcher:
 *
 *   1. fs.watch (default) — kernel-level events, instant.
 *   2. mtime poll fallback — used when fs.watch errors or the
 *      caller forces it via CLAWDI_SERVE_MODE=container.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { log, toErrorMessage } from "./log";

export interface SessionWatcherOptions {
	paths: string[];
	abort: AbortSignal;
	onPathStable: () => void;
	forcePoll?: boolean;
}

interface SessionFsWatcher {
	close: () => void;
	on: (event: "error", listener: (error: Error) => void) => SessionFsWatcher;
}

export interface SessionTimerScheduler {
	schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface SessionWatcherDependencies {
	createWatcher: (
		path: string,
		options: { persistent: false; recursive: boolean },
		onChange: () => void,
	) => SessionFsWatcher;
	poll: (opts: SessionWatcherOptions) => Promise<void>;
	stableTimer: SessionTimerScheduler;
}

const defaultSessionTimerScheduler: SessionTimerScheduler = {
	schedule: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
};

const defaultSessionWatcherDependencies: SessionWatcherDependencies = {
	createWatcher: (path, options, onChange) => watch(path, options, onChange),
	poll: pollSessionPaths,
	stableTimer: defaultSessionTimerScheduler,
};

// File-stable window: how long after the last detected change
// before we consider the session log "ready to push". Shorter ⇒
// more frequent partial pushes (and the next push catches up
// anyway, this is just for politeness). 30s matches the spec's
// "file-stable debounce" cadence. Upload detection and dashboard
// refresh have separate schedules, so neither implies a visibility SLA.
export const SESSION_STABLE_AFTER_MS = 30_000;

// Idle polling remains deliberately less frequent than the skill
// watcher because session files mutate constantly during a live
// conversation. Once a change is observed, pollSessionPaths schedules a
// follow-up at the exact quiescence deadline instead of waiting
// for another full idle interval.
export const SESSION_IDLE_POLL_INTERVAL_MS = 60_000;

export async function watchSessions(
	opts: SessionWatcherOptions,
	dependencies: SessionWatcherDependencies = defaultSessionWatcherDependencies,
): Promise<void> {
	if (opts.forcePoll) {
		log.info("sessions_watcher.mode", { mode: "poll", reason: "forced" });
		await dependencies.poll(opts);
		return;
	}
	try {
		await fsWatchLoop(opts, dependencies);
	} catch (e) {
		log.warn("sessions_watcher.fs_watch_failed", {
			error: toErrorMessage(e),
			fallback: "poll",
		});
		await dependencies.poll(opts);
	}
}

async function fsWatchLoop(
	opts: SessionWatcherOptions,
	dependencies: SessionWatcherDependencies,
): Promise<void> {
	const watchers: SessionFsWatcher[] = [];
	let cancelStableTimer: (() => void) | null = null;
	let cleaned = false;
	let settled = false;
	let resolveCompletion = () => {};
	let rejectCompletion: (error: Error) => void = () => {};
	const completion = new Promise<void>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		opts.abort.removeEventListener("abort", onAbort);
		if (cancelStableTimer) {
			cancelStableTimer();
			cancelStableTimer = null;
		}
		for (const watcher of watchers) {
			try {
				watcher.close();
			} catch {
				/* already closed */
			}
		}
	};
	const settle = (error?: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		if (error) rejectCompletion(error);
		else resolveCompletion();
	};
	const onAbort = () => {
		settle();
	};

	opts.abort.addEventListener("abort", onAbort, { once: true });
	// AbortSignal does not replay an abort to listeners registered after it.
	// Re-check after registration to close the race with a pre-aborted caller.
	if (opts.abort.aborted) onAbort();

	const armStable = () => {
		if (settled || opts.abort.aborted) return;
		cancelStableTimer?.();
		cancelStableTimer = dependencies.stableTimer.schedule(() => {
			cancelStableTimer = null;
			if (settled || opts.abort.aborted) return;
			opts.onPathStable();
		}, SESSION_STABLE_AFTER_MS);
	};

	try {
		if (opts.abort.aborted) return;
		let missingOrFailed = 0;
		for (const p of opts.paths) {
			if (settled || opts.abort.aborted) break;
			if (!existsSync(p)) {
				log.debug("sessions_watcher.path_missing", { path: p });
				missingOrFailed += 1;
				continue;
			}
			try {
				const isDir = statSync(p).isDirectory();
				const watcher = dependencies.createWatcher(
					p,
					{ persistent: false, recursive: isDir },
					() => {
						if (!opts.abort.aborted) armStable();
					},
				);
				watchers.push(watcher);
				watcher.on("error", (error) => {
					settle(new Error(`fs.watch failed for ${p}: ${toErrorMessage(error)}`));
				});
				if (settled) break;
			} catch (e) {
				log.warn("sessions_watcher.attach_failed", {
					path: p,
					error: toErrorMessage(e),
				});
				missingOrFailed += 1;
			}
		}

		// Missing paths need polling so a later creation is observable.
		if (missingOrFailed > 0 || watchers.length === 0) {
			log.info("sessions_watcher.mode", {
				mode: "poll",
				reason: watchers.length === 0 ? "all_paths_unavailable" : "partial_fs_events",
				path_count: opts.paths.length,
				fs_event_paths: watchers.length,
			});
			settle();
			await dependencies.poll(opts);
			return;
		}

		log.info("sessions_watcher.mode", {
			mode: "fs_events",
			path_count: watchers.length,
			stable_after_ms: SESSION_STABLE_AFTER_MS,
		});
		await completion;
	} finally {
		cleanup();
	}
}

/** Polling fallback. Compares per-path mtime + size signatures
 * against the previous snapshot; emits a stable event when a
 * path that previously changed has been stable for >=
 * SESSION_STABLE_AFTER_MS.
 *
 * Signatures remain per path, but the quiescence deadline is global: a
 * change on any watched path postpones the one full-session collection. */
export interface SessionPollDependencies {
	now: () => number;
	pathSignature: (path: string) => Promise<string>;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSessionPollDependencies: SessionPollDependencies = {
	now: () => performance.now(),
	pathSignature: sessionPathSignature,
	sleep: sleepForSessionPoll,
};

export async function pollSessionPaths(
	opts: SessionWatcherOptions,
	dependencies: SessionPollDependencies = defaultSessionPollDependencies,
): Promise<void> {
	const lastSig = new Map<string, string>();
	for (const p of opts.paths) {
		if (opts.abort.aborted) return;
		const signature = await dependencies.pathSignature(p);
		if (opts.abort.aborted) return;
		lastSig.set(p, signature);
	}

	log.info("sessions_watcher.mode", {
		mode: "poll",
		path_count: opts.paths.length,
		poll_ms: SESSION_IDLE_POLL_INTERVAL_MS,
		stable_after_ms: SESSION_STABLE_AFTER_MS,
	});

	let stableDeadline: number | null = null;
	while (!opts.abort.aborted) {
		const now = dependencies.now();
		const delayMs =
			stableDeadline === null
				? SESSION_IDLE_POLL_INTERVAL_MS
				: Math.min(SESSION_IDLE_POLL_INTERVAL_MS, Math.max(0, stableDeadline - now));
		await dependencies.sleep(delayMs, opts.abort);
		if (opts.abort.aborted) return;

		let anyChanged = false;
		for (const p of opts.paths) {
			if (opts.abort.aborted) return;
			const cur = await dependencies.pathSignature(p);
			if (opts.abort.aborted) return;
			const prev = lastSig.get(p) ?? "";
			if (cur !== prev) {
				lastSig.set(p, cur);
				anyChanged = true;
			}
		}
		const observedAt = dependencies.now();
		if (anyChanged) {
			stableDeadline = observedAt + SESSION_STABLE_AFTER_MS;
			continue;
		}
		if (stableDeadline !== null && observedAt >= stableDeadline) {
			stableDeadline = null;
			if (opts.abort.aborted) return;
			opts.onPathStable();
		}
	}
}

/** Per-path signature that detects appends to existing files
 * inside a session directory.
 *
 * Pre-fix this returned just the path's own `mtime:size`. That's
 * fine for a single SQLite file (Hermes) but BREAKS for
 * append-mode JSONL transcripts: writing more lines into
 * `<dir>/<session>.jsonl` doesn't bump `<dir>`'s mtime, so the
 * poll loop saw the same signature forever and never armed the
 * stable timer. Container-mode (CLAWDI_SERVE_MODE=container)
 * + active conversation = silently no session push.
 *
 * Now: for files we keep `mtime:size`. For directories we walk
 * up to MAX_ENTRIES top-level + child entries and aggregate
 * `mtime:size` per file, folded into a streaming sha256. The
 * fold is bounded in memory (one hash state regardless of dir
 * size) and content-sensitive at every entry — appending to an
 * existing file changes its mtime+size and therefore the hash.
 *
 * Why a fold rather than a parts list with a cap: the previous
 * cap-and-truncate implementation silently collapsed every state
 * past 4096 entries to the same dir-mtime fallback signature,
 * which the parent dir's mtime didn't bump on file APPEND.
 * Active session dirs with hundreds of files would silently stop
 * detecting transcript writes once they crossed the cap.
 */
// Depth budget for the walk's RECURSION into subdirectories.
// Files at every depth are statted; only further recursion is
// gated. Codex sessions live at `~/.codex/sessions/YYYY/MM/DD/*`
// — `root → YYYY → MM → DD` is depth 3 to land on the day dir
// where the .jsonl files actually live, so the cap has to allow
// the walk to enter DD before statting. Pre-fix the cap was 2,
// which returned at the top of `walk(DD, 3)` without ever
// statting Codex transcript files; container-mode poll signatures
// stayed identical across appends and the stable timer never armed.
// Hermes (single SQLite at root) and Claude Code
// (`~/.claude/projects/<project>/*.jsonl`, depth 1) both still
// fit comfortably; the budget just needs to be wide enough for
// the deepest supported adapter.
const SIG_MAX_DEPTH = 3;

export async function sessionPathSignature(p: string): Promise<string> {
	try {
		const s = await stat(p);
		if (!s.isDirectory()) {
			return `f:${s.mtimeMs}:${s.size}`;
		}
		// Streaming hash: sorted readdir order at each level so the
		// same on-disk state always produces the same digest. Files
		// are stat'd individually; directories recurse up to depth.
		// No content read — just metadata.
		const h = createHash("sha256");
		let counted = 0;
		const walk = async (dir: string, depth: number): Promise<void> => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isFile()) {
					try {
						const fs = await stat(full);
						h.update(`${e.name}:${fs.mtimeMs}:${fs.size};`);
						counted += 1;
					} catch {
						/* race: file vanished between readdir and stat */
					}
				} else if (e.isDirectory()) {
					h.update(`d:${e.name}/`);
					// Gate ONLY the recursion, not the file-stat
					// loop above. The pre-fix shape gated at the top
					// of `walk()`, so the boundary depth's files
					// were never statted.
					if (depth < SIG_MAX_DEPTH) await walk(full, depth + 1);
				}
			}
		};
		await walk(p, 0);
		return `d:${counted}:${h.digest("hex")}`;
	} catch {
		// Path missing / permission denied — treat as empty
		// signature so it shows up as "changed" if the path
		// later appears.
		return "";
	}
}

export function sleepForSessionPoll(
	ms: number,
	signal: AbortSignal,
	scheduler: SessionTimerScheduler = defaultSessionTimerScheduler,
): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		let cancelTimer = () => {};
		const finish = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => {
			cancelTimer();
			finish();
		};
		const onTimer = () => {
			if (signal.aborted) {
				onAbort();
				return;
			}
			finish();
		};
		cancelTimer = scheduler.schedule(onTimer, ms);
		if (settled) {
			cancelTimer();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}
