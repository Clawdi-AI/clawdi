import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { AUDITED_PROVIDER_RELEASE } from "./audited-version.js";
import type { SidecarConfig, SidecarSessionConfig } from "./config.js";
import { assertOwnedDirectory } from "./filesystem-security.js";
import { type BaileysRuntimeDependencies, BaileysSocketRuntime } from "./runtime.js";
import { type BaileysRuntime, SIDECAR_CAPABILITIES, type SidecarCapabilities } from "./types.js";

const SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SessionRuntimeFactory = (
	config: SidecarSessionConfig,
	dependencies?: BaileysRuntimeDependencies,
) => BaileysRuntime;

type SupervisedSession = {
	runtime: BaileysRuntime;
	startPromise?: Promise<void>;
};

export class BaileysSessionSupervisor {
	private readonly sessions = new Map<string, SupervisedSession>();

	constructor(
		private readonly config: SidecarConfig,
		private readonly runtimeFactory: SessionRuntimeFactory = (sessionConfig, dependencies) =>
			new BaileysSocketRuntime(sessionConfig, dependencies),
	) {}

	health() {
		return {
			schemaVersion: "clawdi.whatsapp.sidecar-health.v1",
			ready: true,
			activeSessions: this.sessions.size,
			advertisedRelease: AUDITED_PROVIDER_RELEASE,
		} as const;
	}

	capabilities(): SidecarCapabilities {
		return SIDECAR_CAPABILITIES;
	}

	async session(sessionId: string): Promise<BaileysRuntime> {
		assertSessionId(sessionId);
		let session = this.sessions.get(sessionId);
		if (!session) {
			const sessionDir = join(this.config.stateRoot, sessionId);
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			assertOwnedDirectory(sessionDir, 0o700, "provider session directory");
			const runtime = this.runtimeFactory({
				...this.config,
				sessionId,
				sessionDir,
			});
			session = { runtime };
			this.sessions.set(sessionId, session);
		}
		let startPromise = session.startPromise;
		if (!startPromise) {
			startPromise = session.runtime.start();
			session.startPromise = startPromise;
		}
		try {
			await startPromise;
		} finally {
			if (session.startPromise === startPromise) {
				delete session.startPromise;
			}
		}
		return session.runtime;
	}

	async stop(): Promise<void> {
		const runtimes = [...this.sessions.values()].map((session) => session.runtime);
		this.sessions.clear();
		const results = await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"one or more provider sessions failed to stop",
			);
		}
	}
}

function assertSessionId(value: string): void {
	if (!SESSION_ID_PATTERN.test(value)) {
		throw new InvalidSessionIdError();
	}
}

export class InvalidSessionIdError extends Error {
	constructor() {
		super("invalid_session_id");
		this.name = "InvalidSessionIdError";
	}
}
