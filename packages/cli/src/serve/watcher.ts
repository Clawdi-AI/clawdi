/**
 * Local skill-directory watcher.
 *
 * Two modes:
 *
 * 1. fs.watch (default) — kernel-level inotify/FSEvents. Cheap
 *    and instant. Works on the user's laptop and on bare-metal
 *    Linux.
 *
 * 2. mtime poll (fallback) — read the directory tree every N
 *    seconds and compare against the previous snapshot. Triggered
 *    automatically when fs.watch errors (overlayfs in containers
 *    silently drops events) or by `CLAWDI_SERVE_MODE=container`.
 *
 * Container mode is a forced fallback because overlayfs's notify
 * support is broken in subtle ways: events fire for the upper
 * layer but not the lower, fire on truncate but not append, etc.
 * Polling is slower but correct.
 *
 * Emits one `change` callback per skill_key when ANY file inside
 * that skill's directory has changed. The caller (sync-engine)
 * dedups by `skill_key`, so a touch storm during a `git pull`
 * collapses into one upload.
 */

import { type Dirent, type Stats, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { log, toErrorMessage } from "./log";

const POLL_INTERVAL_MS = 30_000;

/** Sentinel: thrown out of `watchEvents` when recursive fs.watch
 * isn't supported. The outer `watchSkills` catches it and falls
 * to `pollLoop`. Distinct class so a future caller can
 * `instanceof` rather than string-match the message. */
class RecursiveWatchUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecursiveWatchUnsupportedError";
	}
}

// Mirror of the backend's per-component SKILL_KEY_PATTERN shape.
// Top-level child dirs under `~/.claude/skills/` are filtered
// with a single-component match — the watcher only enumerates
// the direct children of the skills root, never the nested
// Hermes layout. The wider "nested path" form lives on the
// backend; the watcher's job here is to reject dotfiles like
// `.system`, `.cache`, `.git` that aren't real skills. Without
// this filter, every dotfile produces an
// `engine.queue_drop_permanent` error log on every reconcile.
const SKILL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
function isValidSkillKey(name: string): boolean {
	return SKILL_KEY_RE.test(name);
}

interface Opts {
	/** Absolute path. We watch all immediate children that are
	 * directories (each child = one top-level skill_key, OR a
	 * Hermes-style category dir that holds nested skills). */
	rootDir: string;
	abort: AbortSignal;
	onSkillChanged: (skillKey: string) => void;
	/** Force poll mode even if fs.watch is available. The serve
	 * command sets this from CLAWDI_SERVE_MODE=container. */
	forcePoll?: boolean;
	/** Optional resolver: given a path relative to `rootDir`,
	 * return the skill_key that owns it (or `null` if the path
	 * isn't inside any skill yet). For flat adapters (Claude
	 * Code / Codex / OpenClaw) this is a no-op — the top-level
	 * dir IS the skill_key. For Hermes the resolver walks up
	 * looking for SKILL.md so an edit at
	 * `category/foo/SKILL.md` reports `category/foo`, not the
	 * top-level `category`. Without this, the daemon enqueues
	 * the wrong key and uploads a bogus `category` tarball. */
	resolveSkillKey?: (pathFromRoot: string) => string | null;
	/** Optional adapter-aware skill_key enumerator. Poll mode
	 * uses this to take snapshots — flat adapters can rely on
	 * the top-level fs walk, but Hermes nested layouts
	 * (`category/foo/SKILL.md`) need the recursive enumeration
	 * the adapter implements. Without it, poll mode reports the
	 * `category` dir as the skill_key on any nested change and
	 * the daemon uploads the wrong key. fs.watch mode separately
	 * uses `resolveSkillKey` for the same purpose. */
	listSkillKeys?: () => Promise<string[]>;
}

export async function watchSkills(opts: Opts): Promise<void> {
	if (opts.forcePoll) {
		log.info("watcher.mode", { mode: "poll", reason: "forced" });
		await pollLoop(opts);
		return;
	}

	try {
		await watchEvents(opts);
	} catch (e) {
		log.warn("watcher.fs_watch_failed", {
			error: toErrorMessage(e),
			fallback: "poll",
		});
		await pollLoop(opts);
	}
}

/** fs.watch-based mode. The Node API requires us to fan out a
 * single recursive watch ourselves on platforms where recursive
 * watch isn't supported (Linux). We handle both cases in one
 * loop by watching the top dir non-recursively + each immediate
 * subdir non-recursively. Skill directories rarely have deep
 * nesting beyond `references/` so this is fine.
 *
 * Sub-watchers are attached dynamically — a `mkdir
 * new-skill && touch new-skill/SKILL.md` triggers the root
 * watcher for the dir-create, which in turn installs a
 * sub-watcher BEFORE the SKILL.md write fires. Without that
 * attach-on-demand, edits inside a freshly-created skill dir
 * silently slip past until the next reconcile (60s) catches up. */
async function watchEvents(opts: Opts): Promise<void> {
	const { watch } = await import("node:fs");
	const { existsSync, statSync } = await import("node:fs");

	const skillWatchers = new Map<string, { close(): void }>();
	let rootWatcher: { close(): void } | null = null;

	const on = (skillKey: string) => {
		opts.onSkillChanged(skillKey);
	};

	const attachSubWatcher = (key: string) => {
		if (skillWatchers.has(key)) return;
		// Skip non-skill subdirs at the watcher boundary. Without
		// this, a dotfile child like `.system` gets a sub-watcher
		// AND fires onSkillChanged on the next touch, which puts a
		// permanently-failing item in the queue.
		if (!isValidSkillKey(key)) return;
		const dir = join(opts.rootDir, key);
		try {
			if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
		} catch {
			return;
		}
		// Runtime fs.watch errors (mount unavailable, kernel inotify
		// limit hit, file deleted out from under the watcher) used
		// to bubble up unhandled and crash the daemon. Listen for
		// them, log, drop the watcher; the next reconcile cycle
		// re-attaches if the dir reappears.
		const attachErrorHandler = (w: ReturnType<typeof watch>) => {
			w.on("error", (e: Error) => {
				log.warn("watcher.subwatcher_runtime_error", {
					skill_key: key,
					error: toErrorMessage(e),
				});
				try {
					w.close();
				} catch {
					/* already closed */
				}
				skillWatchers.delete(key);
			});
		};
		try {
			const w = watch(dir, { persistent: false, recursive: true }, (_e, filename) => {
				// Resolve the actual skill_key from the changed path.
				// For flat layouts the resolver echoes `key`; for
				// Hermes-nested it walks up to find the dir
				// containing SKILL.md and emits the full
				// `category/foo` key. Without this, an edit under
				// `category/foo/SKILL.md` here would naively call
				// `on("category")` and the daemon would tar the
				// whole category dir under the wrong key.
				const pathFromRoot = filename ? join(key, filename.toString()) : key;
				const resolved = opts.resolveSkillKey ? opts.resolveSkillKey(pathFromRoot) : key;
				if (resolved) on(resolved);
			});
			attachErrorHandler(w);
			skillWatchers.set(key, w);
		} catch (e) {
			// Recursive watch unsupported (older Linux without inotify
			// recursive, some FUSE/overlay mounts) or rejected.
			// Re-throw a sentinel so `watchEvents` aborts the whole
			// fs-events mode and the outer `watchSkills` switches to
			// poll mode for THIS daemon process. Pre-fix the fallback
			// attached a non-recursive watcher to the skill root,
			// which silently missed nested edits like
			// `references/foo.md` — the parent dir's mtime doesn't
			// bump on a nested file write, no event fires, no rescan
			// catches up because the skill rescan path only fires on
			// scope changes.
			throw new RecursiveWatchUnsupportedError(toErrorMessage(e));
		}
	};

	// Watch the root for added/removed skill folders. On any
	// event, eagerly attach a sub-watcher in case the entry is
	// a brand-new dir; idempotent so no harm if the dir was
	// already present.
	rootWatcher = watch(opts.rootDir, { persistent: false }, (_event, filename) => {
		if (!filename) return;
		const topKey = filename.toString().split(sep)[0] ?? "";
		if (!topKey) return;
		// Same filter as `listSkillDirs` — fs.watch happily fires for
		// dotfile creates under the skills root, but those aren't
		// real skills and the backend would 422 every push.
		if (!isValidSkillKey(topKey)) return;
		try {
			attachSubWatcher(topKey);
		} catch (e) {
			// If recursive watch becomes unsupported mid-session
			// (extremely rare — typically caught at boot via the
			// initialSync attach loop), surface the failure as a
			// log; the next reconcile + watcher restart fall to
			// pollLoop. Don't propagate out of the fs.watch
			// callback (Node terminates the process on unhandled
			// callback throws).
			log.warn("watcher.subwatcher_attach_failed", {
				skill_key: topKey,
				error: toErrorMessage(e),
			});
		}
		// Same resolver path as the sub-watcher: for flat layouts
		// the resolver echoes `topKey`. For Hermes-nested layouts
		// the resolver returns null when `topKey` is just a
		// category dir (no SKILL.md at the top level) — we skip
		// the emission and rely on the sub-watcher's nested events
		// to fire as the user adds the actual skill content.
		const resolved = opts.resolveSkillKey ? opts.resolveSkillKey(filename.toString()) : topKey;
		if (resolved) on(resolved);
	});

	const initial = await listSkillDirs(opts.rootDir);
	try {
		for (const key of initial) attachSubWatcher(key);
	} catch (e) {
		// `attachSubWatcher` throws `RecursiveWatchUnsupportedError`
		// on platforms where recursive fs.watch isn't available
		// (older Linux without inotify recursive, some FUSE/overlay
		// mounts). The outer `watchSkills` catches and falls to
		// pollLoop — but we've already opened `rootWatcher` and
		// possibly some sub-watchers above. Without this cleanup
		// the daemon keeps a fs.watch alive in parallel with
		// pollLoop, leaking the watcher AND firing duplicate
		// onSkillChanged callbacks on the root dir.
		try {
			rootWatcher?.close();
		} catch {
			/* already closed */
		}
		for (const w of skillWatchers.values()) {
			try {
				w.close();
			} catch {
				/* already closed */
			}
		}
		skillWatchers.clear();
		rootWatcher = null;
		throw e;
	}

	log.info("watcher.mode", { mode: "fs_events", root: opts.rootDir, skill_count: initial.length });

	await new Promise<void>((resolve) => {
		opts.abort.addEventListener(
			"abort",
			() => {
				try {
					rootWatcher?.close();
				} catch {
					/* already closed */
				}
				for (const w of skillWatchers.values()) {
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

/** Polling fallback. Walks `rootDir` every POLL_INTERVAL_MS and
 * compares per-skill mtime + size signatures. */
async function pollLoop(opts: Opts): Promise<void> {
	let prev = await snapshot(opts.rootDir, opts.listSkillKeys);
	log.info("watcher.mode", { mode: "poll", root: opts.rootDir, skill_count: prev.size });

	while (!opts.abort.aborted) {
		await sleep(POLL_INTERVAL_MS, opts.abort);
		if (opts.abort.aborted) return;

		const next = await snapshot(opts.rootDir, opts.listSkillKeys);
		const changed = diff(prev, next);
		for (const key of changed) {
			opts.onSkillChanged(key);
		}
		prev = next;
	}
}

/** Per-skill signature: concatenated `mtime|size` for every file
 * under the skill dir. New file or changed mtime → different
 * signature → emit change. We use mtime not content hash here:
 * polling is already O(files), and re-hashing is the sync
 * engine's job once it decides to upload.
 *
 * `listSkillKeys` (when provided) returns the full set of
 * skill_keys including nested Hermes layouts; we hash each
 * skill's directory under that key. Without it we fall back to
 * a top-level walk — wrong for Hermes (would emit `category`
 * for any nested change) but the only sane default for an
 * adapter-less code path. */
async function snapshot(
	rootDir: string,
	listSkillKeys?: () => Promise<string[]>,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const skills = listSkillKeys ? await listSkillKeys() : await listSkillDirs(rootDir);
	for (const key of skills) {
		const sig = await dirSignature(join(rootDir, key));
		out.set(key, sig);
	}
	return out;
}

async function listSkillDirs(rootDir: string): Promise<string[]> {
	try {
		const entries = await readdir(rootDir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory() && isValidSkillKey(e.name)).map((e) => e.name);
	} catch {
		// Root doesn't exist yet (fresh agent install). Caller will
		// re-list on the next poll cycle, so an empty result is fine.
		return [];
	}
}

async function dirSignature(dir: string): Promise<string> {
	const parts: string[] = [];
	await walk(dir, parts);
	parts.sort();
	return parts.join("|");
}

async function walk(dir: string, out: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			await walk(full, out);
		} else if (e.isFile()) {
			let st: Stats;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			out.push(`${full}@${st.mtimeMs.toFixed(0)}:${st.size}`);
		}
	}
}

function diff(prev: Map<string, string>, next: Map<string, string>): string[] {
	const changed: string[] = [];
	const allKeys = new Set([...prev.keys(), ...next.keys()]);
	for (const k of allKeys) {
		if (prev.get(k) !== next.get(k)) changed.push(k);
	}
	return changed;
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		// Add the listener with an explicit reference so we can
		// remove it in the timer-fires path. Pre-fix the listener
		// stayed registered until abort, so a long-running daemon
		// in poll mode (30s ticks) leaked one closure per cycle —
		// after a few hundred ticks Node emits
		// MaxListenersExceededWarning and the closures pile up
		// indefinitely. The other serve sleep helpers
		// (sync-engine, sessions-watcher) already mirror this
		// shape; this one was the outlier.
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
