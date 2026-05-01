/**
 * Session-directory watcher with file-stable debounce.
 *
 * Per docs/plans/cloud-clawdi-integration.md (v0.25, line 1711):
 * `Pod → Cloud | sessions | ✓ (write-on-detect, file-stable
 * debounce)`. Push happens after a file has been quiescent for
 * `STABLE_AFTER_MS` so we don't upload half-written transcripts
 * mid-conversation.
 *
 * One watcher per adapter. Adapters return a list of paths via
 * `getSessionsWatchPaths()` — directories (Claude Code / Codex /
 * OpenClaw) or a single file (Hermes' SQLite DB). Any change
 * resets the per-path quiescence timer; once the timer fires,
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

interface Opts {
	paths: string[];
	abort: AbortSignal;
	onPathStable: () => void;
	forcePoll?: boolean;
}

// File-stable window: how long after the last detected change
// before we consider the session log "ready to push". Shorter ⇒
// more frequent partial pushes (and the next push catches up
// anyway, this is just for politeness). 30s matches the spec's
// "file-stable debounce" cadence and is short enough that the
// dashboard shows new sessions within a minute of completion.
const STABLE_AFTER_MS = 30_000;

// Polling fallback cadence. Longer than the skill watcher's
// (60s vs 30s) because session files mutate constantly during a
// live conversation; we don't want to wake every 30s for every
// keystroke. The stable-window is what gates the actual push.
const POLL_INTERVAL_MS = 60_000;

export async function watchSessions(opts: Opts): Promise<void> {
	if (opts.forcePoll) {
		log.info("sessions_watcher.mode", { mode: "poll", reason: "forced" });
		await pollLoop(opts);
		return;
	}
	try {
		await fsWatchLoop(opts);
	} catch (e) {
		log.warn("sessions_watcher.fs_watch_failed", {
			error: toErrorMessage(e),
			fallback: "poll",
		});
		await pollLoop(opts);
	}
}

async function fsWatchLoop(opts: Opts): Promise<void> {
	const watchers: ReturnType<typeof watch>[] = [];
	let stableTimer: ReturnType<typeof setTimeout> | null = null;

	const armStable = () => {
		if (stableTimer) clearTimeout(stableTimer);
		stableTimer = setTimeout(() => {
			stableTimer = null;
			opts.onPathStable();
		}, STABLE_AFTER_MS);
	};

	let missingOrFailed = 0;
	for (const p of opts.paths) {
		if (!existsSync(p)) {
			log.debug("sessions_watcher.path_missing", { path: p });
			missingOrFailed += 1;
			continue;
		}
		try {
			const isDir = statSync(p).isDirectory();
			const w = watch(p, { persistent: false, recursive: isDir }, () => {
				armStable();
			});
			watchers.push(w);
		} catch (e) {
			log.warn("sessions_watcher.attach_failed", {
				path: p,
				error: toErrorMessage(e),
			});
			missingOrFailed += 1;
		}
	}

	// Fall back to poll mode if ANY path is missing or its watch
	// attach failed. Pre-fix the daemon would just `await abort` and
	// silently never fire — a missing `~/.codex/sessions` dir at
	// boot meant Codex sessions never synced for the rest of the
	// daemon's lifetime, even after the directory appeared. Poll
	// mode handles late-appearing paths via the empty-signature
	// detection in pathSignature() and is cheap enough at 60s
	// cadence to use unconditionally when fs.watch couldn't cover
	// every path.
	if (missingOrFailed > 0 || watchers.length === 0) {
		log.info("sessions_watcher.mode", {
			mode: "poll",
			reason: watchers.length === 0 ? "all_paths_unavailable" : "partial_fs_events",
			path_count: opts.paths.length,
			fs_event_paths: watchers.length,
		});
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				/* already closed */
			}
		}
		await pollLoop(opts);
		return;
	}

	log.info("sessions_watcher.mode", {
		mode: "fs_events",
		path_count: watchers.length,
		stable_after_ms: STABLE_AFTER_MS,
	});

	await new Promise<void>((resolve) => {
		opts.abort.addEventListener(
			"abort",
			() => {
				if (stableTimer) clearTimeout(stableTimer);
				for (const w of watchers) {
					try {
						w.close();
					} catch {
						/* already closed */
					}
				}
				resolve();
			},
			{ once: true },
		);
	});
}

/** Polling fallback. Compares per-path mtime + size signatures
 * against the previous snapshot; emits a stable event when a
 * path that previously changed has been stable for >=
 * STABLE_AFTER_MS.
 *
 * State per path:
 *   - lastSig: signature observed last poll
 *   - lastChangeAt: epoch ms of the most recent change (sig
 *     differed from prior). Reset to null after we emit. */
async function pollLoop(opts: Opts): Promise<void> {
	const lastSig = new Map<string, string>();
	const lastChangeAt = new Map<string, number>();
	for (const p of opts.paths) {
		lastSig.set(p, await pathSignature(p));
	}

	log.info("sessions_watcher.mode", {
		mode: "poll",
		path_count: opts.paths.length,
		poll_ms: POLL_INTERVAL_MS,
		stable_after_ms: STABLE_AFTER_MS,
	});

	while (!opts.abort.aborted) {
		await sleep(POLL_INTERVAL_MS, opts.abort);
		if (opts.abort.aborted) return;

		const now = Date.now();
		let anyStable = false;
		for (const p of opts.paths) {
			const cur = await pathSignature(p);
			const prev = lastSig.get(p) ?? "";
			if (cur !== prev) {
				lastSig.set(p, cur);
				lastChangeAt.set(p, now);
			} else {
				const lc = lastChangeAt.get(p);
				if (lc !== undefined && now - lc >= STABLE_AFTER_MS) {
					lastChangeAt.delete(p);
					anyStable = true;
				}
			}
		}
		if (anyStable) opts.onPathStable();
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

async function pathSignature(p: string): Promise<string> {
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
