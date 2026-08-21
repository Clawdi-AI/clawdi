import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
	collectManagedSkillTree,
	ManagedSkillResourceError,
	type ManagedSkillTree,
} from "./managed-skill-delivery";

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const SOURCE_LIFETIME_MS = 120_000;
enum SourceState {
	Starting,
	Ready,
	Failed,
	StopRequested,
	Stopped,
	Expired,
}

interface LoopbackWorkerData {
	state: SharedArrayBuffer;
	token: string;
	files: Array<[string, Uint8Array]>;
	lifetimeMs: number;
}

export function hermesUrlSourceFiles(sourceDir: string): ManagedSkillTree {
	const collected = collectManagedSkillTree(sourceDir);
	if (collected.status !== "collected") {
		throw new ManagedSkillResourceError(`prepared Hermes Skill tree is ${collected.status}`);
	}
	if (!collected.tree.has("SKILL.md")) {
		throw new ManagedSkillResourceError("prepared Hermes Skill is missing SKILL.md");
	}
	for (const path of collected.tree.keys()) {
		const parts = path.split("/");
		if (
			path.includes("\\") ||
			parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))
		) {
			throw new ManagedSkillResourceError(`prepared Hermes Skill path is unsafe: ${path}`);
		}
	}
	return new Map([...collected.tree].sort(([left], [right]) => left.localeCompare(right)));
}

function runLoopbackWorker(): void {
	const { createServer } = process.getBuiltinModule("node:http");
	const { workerData } = process.getBuiltinModule("node:worker_threads") as {
		workerData: LoopbackWorkerData;
	};
	const state = new Int32Array(workerData.state);
	const files = new Map(workerData.files.map(([path, bytes]) => [path, Buffer.from(bytes)]));
	let closing = false;
	let lifetime: ReturnType<typeof setTimeout>;
	let stopPoll: ReturnType<typeof setInterval>;
	const server = createServer((request, response) => {
		try {
			const requestTarget = request.url ?? "";
			const prefix = `/${workerData.token}/`;
			if (
				request.method !== "GET" ||
				requestTarget.includes("?") ||
				requestTarget.includes("#") ||
				!requestTarget.startsWith(prefix)
			) {
				response.writeHead(request.method === "GET" ? 404 : 405, { Connection: "close" });
				response.end();
				return;
			}
			let path: string;
			try {
				path = decodeURIComponent(requestTarget.slice(prefix.length));
			} catch {
				response.writeHead(400, { Connection: "close" });
				response.end();
				return;
			}
			const parts = path.split("/");
			if (
				path.includes("\\") ||
				parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))
			) {
				response.writeHead(400, { Connection: "close" });
				response.end();
				return;
			}
			const bytes = files.get(path);
			if (!bytes) {
				response.writeHead(404, { Connection: "close" });
				response.end();
				return;
			}
			response.writeHead(200, {
				"Content-Type": path.endsWith(".md")
					? "text/markdown; charset=utf-8"
					: "application/octet-stream",
				"Content-Length": String(bytes.byteLength),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				Connection: "close",
			});
			response.end(bytes);
		} catch {
			response.writeHead(400, { Connection: "close" });
			response.end();
		}
	});
	const close = (finalState: SourceState) => {
		if (closing) return;
		closing = true;
		clearTimeout(lifetime);
		clearInterval(stopPoll);
		server.close(() => {
			Atomics.store(state, 0, finalState);
			Atomics.notify(state, 0);
		});
		server.closeAllConnections();
	};
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	server.keepAliveTimeout = 1_000;
	server.maxRequestsPerSocket = 16;
	server.once("error", () => close(SourceState.Failed));
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			close(SourceState.Failed);
			return;
		}
		Atomics.store(state, 1, address.port);
		Atomics.store(state, 0, SourceState.Ready);
		Atomics.notify(state, 0);
	});
	lifetime = setTimeout(() => close(SourceState.Expired), workerData.lifetimeMs);
	stopPoll = setInterval(() => {
		if (Atomics.load(state, 0) === SourceState.StopRequested) close(SourceState.Stopped);
	}, 10);
}

function waitForState(state: Int32Array, expected: SourceState, timeoutMs: number): SourceState {
	const deadline = Date.now() + timeoutMs;
	let current = Atomics.load(state, 0) as SourceState;
	while (current === expected && Date.now() < deadline) {
		Atomics.wait(state, 0, expected, Math.min(50, deadline - Date.now()));
		current = Atomics.load(state, 0) as SourceState;
	}
	return current;
}

export function withHermesSkillLoopbackSource<T>(
	sourceDir: string,
	operation: (input: { url: string; files: ManagedSkillTree }) => T,
): T {
	const files = hermesUrlSourceFiles(sourceDir);
	const token = `0${randomBytes(32).toString("hex")}`;
	const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
	const state = new Int32Array(shared);
	let worker: Worker;
	try {
		worker = new Worker(`(${runLoopbackWorker.toString()})()`, {
			eval: true,
			workerData: {
				state: shared,
				token,
				files: [...files],
				lifetimeMs: SOURCE_LIFETIME_MS,
			} satisfies LoopbackWorkerData,
		});
	} catch (error) {
		throw new ManagedSkillResourceError("Hermes Skill loopback source did not start", {
			cause: error,
		});
	}
	worker.unref();
	try {
		const ready = waitForState(state, SourceState.Starting, READY_TIMEOUT_MS);
		if (ready !== SourceState.Ready) {
			throw new ManagedSkillResourceError("Hermes Skill loopback source did not start");
		}
		const port = Atomics.load(state, 1);
		if (port < 1 || port > 65_535) {
			throw new ManagedSkillResourceError("Hermes Skill loopback source returned an invalid port");
		}
		return operation({ url: `http://127.0.0.1:${port}/${token}/SKILL.md`, files });
	} finally {
		if (Atomics.load(state, 0) === SourceState.Ready) {
			Atomics.store(state, 0, SourceState.StopRequested);
			Atomics.notify(state, 0);
		}
		const stopped = waitForState(state, SourceState.StopRequested, STOP_TIMEOUT_MS);
		if (stopped === SourceState.Starting || stopped === SourceState.StopRequested) {
			void worker.terminate();
		}
	}
}
