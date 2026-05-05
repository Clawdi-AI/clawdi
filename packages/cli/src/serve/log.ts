/**
 * Structured JSON logger for `clawdi serve`.
 *
 * Daemon logs are NEVER for humans reading a TTY — they get
 * redirected by launchd / systemd / the pod's stdout collector
 * into a centralized log pipeline. JSON-per-line is the only
 * format that survives that round-trip cleanly. `@clack/prompts`
 * (used everywhere else in the CLI) is the wrong shape: ANSI
 * codes, multi-line spinners, no machine-readable fields.
 *
 * Levels follow the conventional info/warn/error/debug. `debug`
 * is gated on `CLAWDI_SERVE_DEBUG=1` so production logs stay
 * lean. `event` is a free-form string (push.success,
 * sse.reconnect, queue.drop, reconcile.swept) easier to grep than a fuzzy
 * message string.
 */

type Level = "info" | "warn" | "error" | "debug";

const DEBUG_ON = process.env.CLAWDI_SERVE_DEBUG === "1";

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
	if (level === "debug" && !DEBUG_ON) return;
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		event,
		...fields,
	});
	// stderr — stdout is reserved for any future structured-output
	// surface (status command piped through the daemon, etc.).
	process.stderr.write(`${line}\n`);
}

export const log = {
	info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
	warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
	error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
	debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
};

/** Coerce an `unknown` thrown value to a printable string.
 *
 * `catch (e)` types `e` as `unknown` under strict TS. The pattern
 * `(e as Error).message` is unsound — non-Error throws (strings,
 * numbers, objects from third-party libs) produce `undefined`,
 * which then logs as the literal string "undefined" and erases
 * the actual cause. This helper inspects the value at runtime
 * and falls back to `String(e)` so something useful always lands
 * in the log. Prefer this everywhere we catch and log. */
export function toErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	return String(e);
}
