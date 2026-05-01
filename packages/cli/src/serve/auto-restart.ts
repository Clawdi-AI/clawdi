/**
 * Self-restart on binary update.
 *
 * Problem: when `npm i -g clawdi` (or `bun add -g`, or a local
 * `bun run build:dev`) rewrites the daemon's own JS file, the
 * already-running process stays on the old in-memory code forever.
 * Users had no way to pick up a fix short of `launchctl kickstart`
 * or rebooting.
 *
 * Solution: snapshot the entry JS file's mtime at boot, poll
 * periodically, and exit cleanly when the file changes. The OS
 * supervisor (launchd `KeepAlive=true` on macOS, systemd
 * `Restart=always` on Linux) respawns the daemon, which loads the
 * new code at process start. Net effect: any update path
 * propagates to a running daemon within `pollMs` of the file
 * being rewritten.
 *
 * Why mtime + poll instead of `fs.watch`: npm and bun both replace
 * files atomically (write to temp + rename), and `fs.watch`
 * semantics across platforms differ on rename events (macOS sends
 * `rename`, Linux sends `change`, Windows behavior varies). Polling
 * mtime is dumb but works the same everywhere and the daemon's
 * baseline cost is trivial — one stat() per poll interval.
 */

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./log";

interface AutoRestartOpts {
	/** Caller's abort controller. We call `.abort()` when the entry
	 * file changes so the engine's main loop drains and exits. */
	abort: AbortController;
	/** Polling cadence. Defaults to 60s — fast enough that a user
	 * who just ran `clawdi update` sees behavior change inside one
	 * coffee break, slow enough to not be visible in `top`. */
	pollMs?: number;
	/** Override the entry-file resolver. Tests pass an explicit
	 * path; production callers omit it and we derive from
	 * `process.argv[1]`. */
	entryPath?: string;
}

/**
 * Resolve the JS file the daemon is actually executing. Returns
 * null when we can't figure it out (e.g. running tests with no
 * argv[1]) — the caller treats that as "skip this feature" rather
 * than throwing, since the daemon is otherwise functional without
 * auto-restart.
 *
 * Resolution order:
 *   1. `argv[1]` if it ends in `.js`/`.mjs` and is a real file.
 *   2. `<argv[1]_dir>/../dist/index.js` — the bun/npm install
 *      layout where `bin/clawdi.mjs` is a thin wrapper that
 *      imports the bundled file. The wrapper rarely changes,
 *      but the bundled file gets rewritten on every update.
 */
async function resolveEntryFile(): Promise<string | null> {
	const arg = process.argv[1];
	if (!arg) return null;

	// `argv[1]` = `.../node_modules/clawdi/bin/clawdi.mjs` for an
	// installed CLI. The bundled JS sits at `.../dist/index.js`.
	// We prefer the bundled file because that's what gets rewritten
	// on `npm i -g`; the .mjs wrapper is stable across versions.
	const candidates = [join(dirname(dirname(arg)), "dist", "index.js"), arg];
	for (const c of candidates) {
		try {
			const s = await stat(c);
			if (s.isFile()) return c;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

/**
 * Start the auto-restart watcher in the background. Resolves
 * immediately; the watcher runs as a detached promise tied to the
 * caller's abort signal. The caller awaits its main engine — the
 * abort controller is the channel.
 *
 * Returns the path being watched (or null if disabled), purely for
 * the boot log. Callers MUST attach this watcher BEFORE awaiting
 * `runSyncEngine` so a binary update mid-flight still triggers a
 * graceful shutdown.
 */
export async function startAutoRestart(opts: AutoRestartOpts): Promise<string | null> {
	const entry = opts.entryPath ?? (await resolveEntryFile());
	if (!entry) return null;

	let initial: number;
	try {
		initial = (await stat(entry)).mtimeMs;
	} catch {
		// Entry vanished between resolveEntryFile and stat — bail
		// silently rather than throwing; the daemon is fine without
		// auto-restart.
		return null;
	}
	const pollMs = opts.pollMs ?? 60_000;

	void (async () => {
		while (!opts.abort.signal.aborted) {
			await sleep(pollMs, opts.abort.signal);
			if (opts.abort.signal.aborted) return;
			try {
				const now = (await stat(entry)).mtimeMs;
				if (now !== initial) {
					log.info("serve.binary_updated", {
						entry,
						initial_mtime: initial,
						current_mtime: now,
					});
					// Graceful shutdown — the engine's drain loop
					// notices the abort and exits, then launchd /
					// systemd respawns us with the new code.
					opts.abort.abort();
					return;
				}
			} catch (e) {
				// Atomic replace momentarily makes the path miss; one
				// poll later the new file is in place. Don't trip
				// shutdown on a transient ENOENT.
				log.debug("serve.binary_stat_transient", {
					entry,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	})();
	return entry;
}

/**
 * Internal helper: sleep but wake early on abort. Module-local so
 * we don't pull a dependency on engine.ts (which would cycle).
 */
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
