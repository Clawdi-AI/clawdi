/**
 * Watches the loaded CLI entry by mtime and asks the service supervisor for a
 * clean restart when it changes. A daemon-owned global install holds the small
 * coordination barrier below through installer close and version validation;
 * watcher events observed inside that interval are deferred while the updater
 * validates the new bytes, while entry changes outside it restart immediately.
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import { log } from "./log";

export interface RestartCoordination {
	duringUpdateInstall<T>(work: () => Promise<T>): Promise<T>;
	requestRestart(): boolean;
}

export function createRestartCoordination(abort: AbortController): RestartCoordination {
	let installsInFlight = 0;

	return {
		async duringUpdateInstall<T>(work: () => Promise<T>): Promise<T> {
			installsInFlight += 1;
			try {
				return await work();
			} finally {
				installsInFlight -= 1;
			}
		},
		requestRestart(): boolean {
			if (installsInFlight > 0) return false;
			abort.abort();
			return true;
		},
	};
}

interface AutoRestartOpts {
	abort: AbortController;
	restart: RestartCoordination;
	pollMs?: number;
	entryPath?: string;
}

/**
 * Resolve the file the daemon is actually executing. Script installs prefer
 * the bundled JS behind the stable bin wrapper. Returns null when resolution
 * fails because the daemon is otherwise functional without auto-restart.
 *
 * Resolution order:
 *   1. `<entry_dir>/../dist/index.js` — the bun/npm install
 *      layout where `bin/clawdi.mjs` is a thin wrapper that
 *      imports the bundled file. The wrapper rarely changes,
 *      but the bundled file gets rewritten on every update.
 *   2. The current script entry.
 */
async function resolveEntryFile(): Promise<string | null> {
	let invocation: ReturnType<typeof resolveCurrentCliInvocation>;
	try {
		invocation = resolveCurrentCliInvocation();
	} catch {
		return null;
	}

	// The script entry is `.../node_modules/clawdi/bin/clawdi.mjs` for an
	// installed CLI. The bundled JS sits at `.../dist/index.js`.
	// We prefer the bundled file because that's what gets rewritten
	// on `npm i -g`; the .mjs wrapper is stable across versions.
	const candidates = [
		join(dirname(dirname(invocation.entryPath)), "dist", "index.js"),
		invocation.entryPath,
	];
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

	let previous: number;
	try {
		previous = (await stat(entry)).mtimeMs;
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
				if (now !== previous) {
					log.info("serve.binary_updated", {
						entry,
						initial_mtime: previous,
						current_mtime: now,
					});
					previous = now;
					if (opts.restart.requestRestart()) return;
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
