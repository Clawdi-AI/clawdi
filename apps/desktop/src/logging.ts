import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import type { App } from "electron";

const LOG_METHODS = ["debug", "log", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_METHODS)[number];
const SECRET_KEYS =
	"access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|authorization|api[_ -]?key|client[_ -]?secret|password|user[_ -]?code|device[_ -]?code|verification[_ -]?(?:code|uri)|code";
const SECRET_ASSIGNMENT = new RegExp(
	`(["']?(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)(?:\\[redacted\\]|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,\\s;&}\\]]+)`,
	"gi",
);
const SECRET_ARGUMENT = new RegExp(
	`((?:--)?(?:${SECRET_KEYS})\\s+)(?:\\[redacted\\]|[^,\\s;&}\\]]+)`,
	"gi",
);

/** No raw CLI output, arguments, sign-in progress or credentials should be logged. */
export function redactDesktopLog(message: string): string {
	return message
		.replace(SECRET_ASSIGNMENT, "$1[redacted]")
		.replace(SECRET_ARGUMENT, "$1[redacted]")
		.replace(/\bBearer\s+[^\s,"';]+/gi, "Bearer [redacted]")
		.replace(/\bclawdi_[a-zA-Z0-9_-]+/g, "[redacted]")
		.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[redacted]")
		.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[redacted]")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, "$1?[redacted]");
}

function logValue(value: unknown): unknown {
	if (!(value instanceof Error)) return value;
	// CLI and network errors may echo arbitrary upstream output, including secrets.
	// Keep the error kind, OS error code and call sites, but omit message/cause.
	const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
	return {
		name: value.name,
		...(code ? { systemError: code } : {}),
		stack: value.stack
			?.split("\n")
			.filter((line) => /^\s+at\s/.test(line))
			.join("\n"),
	};
}

/** Bounded synchronous writes finish before quit and require no background worker. */
export class DesktopFileLog {
	readonly path: string;
	private readonly maxBytes: number;
	private readonly backups: number;

	constructor(directory: string, options: { maxBytes?: number; backups?: number } = {}) {
		this.maxBytes = options.maxBytes ?? 1024 * 1024;
		this.backups = options.backups ?? 3;
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 128)
			throw new Error("Log size must be an integer of at least 128 bytes.");
		if (!Number.isSafeInteger(this.backups) || this.backups < 1 || this.backups > 10)
			throw new Error("Log backups must be between 1 and 10.");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.path = join(directory, "main.log");
	}

	write(level: LogLevel, message: string): void {
		let line = `${new Date().toISOString()} [${level}] ${redactDesktopLog(message)}\n`;
		const bytes = Buffer.from(line);
		if (bytes.length > this.maxBytes) {
			line = `${bytes
				.subarray(0, this.maxBytes - 16)
				.toString("utf8")
				.replace(/\uFFFD$/u, "")} [truncated]\n`;
		}
		const size = existsSync(this.path) ? statSync(this.path).size : 0;
		if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
		appendFileSync(this.path, line, { mode: 0o600 });
	}

	private rotate(): void {
		rmSync(`${this.path}.${this.backups}`, { force: true });
		for (let index = this.backups - 1; index >= 1; index -= 1) {
			const source = `${this.path}.${index}`;
			if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
		}
		renameSync(this.path, `${this.path}.1`);
	}
}

/** Call after app.setAppLogsPath(); UI/menu handlers can open this directory. */
export function getDesktopLogDirectory(application: Pick<App, "getPath">): string {
	return application.getPath("logs");
}

/** Route existing console output and electron-updater's logger to the same sink. */
export function initializeDesktopLogging(directory: string): () => void {
	const original = {
		debug: console.debug,
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};
	let log: DesktopFileLog | null = null;
	try {
		log = new DesktopFileLog(directory);
	} catch {
		original.error("Desktop file logging unavailable; using console output.");
	}
	for (const level of LOG_METHODS) {
		console[level] = (...values: unknown[]) => {
			const message = redactDesktopLog(
				formatWithOptions(
					{ depth: 4, maxArrayLength: 50, customInspect: false },
					...values.map(logValue),
				),
			);
			if (log) {
				try {
					log.write(level, message);
				} catch {
					log = null;
					original.error("Desktop file logging unavailable; using console output.");
				}
			}
			original[level](message);
		};
	}
	return () => {
		for (const level of LOG_METHODS) {
			console[level] = original[level];
		}
	};
}
