import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { collectManagedSkillTree, type ManagedSkillTree } from "./managed-skill-delivery";

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const SOURCE_LIFETIME_MS = 120_000;
const ALLOWED_SUPPORT_DIRECTORIES = new Set([
	"references",
	"templates",
	"scripts",
	"assets",
	"examples",
]);
const LOCAL_LINK_PATTERN =
	/(?:\]\(|`|(?:^|[\s"']))((?:references|templates|scripts|assets|examples)\/[^\s)`"'<>]+)/gm;
const SUSPICIOUS_LOCAL_REFERENCE_PATTERN =
	/(?:references|templates|scripts|assets|examples)\/(?:[^\s)`"'<>]*\/)?\.\.(?:\/|$)/;

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

function normalizeReferencedPath(value: string): string | null {
	const path = value.replace(/[.,;:]+$/, "").split(/[?#]/, 1)[0];
	if (!path) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(path).replaceAll("\\", "/");
	} catch {
		return null;
	}
	if (decoded.startsWith("/")) return null;
	const parts = decoded.split("/").filter((part) => part && part !== ".");
	if (parts.length === 0 || parts.some((part) => part === ".." || part.includes(":"))) {
		return null;
	}
	return parts.join("/");
}

export function hermesUrlSourceFiles(sourceDir: string): ManagedSkillTree {
	const collected = collectManagedSkillTree(sourceDir);
	if (collected.status !== "collected") {
		throw new Error(`prepared Hermes Skill tree is ${collected.status}`);
	}
	const skillBytes = collected.tree.get("SKILL.md");
	if (!skillBytes) throw new Error("prepared Hermes Skill is missing SKILL.md");
	let skillText: string;
	try {
		skillText = new TextDecoder("utf-8", { fatal: true }).decode(skillBytes);
	} catch {
		throw new Error("prepared Hermes SKILL.md is not valid UTF-8");
	}
	const normalized = skillText.replaceAll("\\", "/");
	if (SUSPICIOUS_LOCAL_REFERENCE_PATTERN.test(normalized)) {
		throw new Error("prepared Hermes SKILL.md contains an unsafe support file reference");
	}
	const paths = new Set(["SKILL.md"]);
	for (const match of normalized.matchAll(LOCAL_LINK_PATTERN)) {
		const referenced = normalizeReferencedPath(match[1] ?? "");
		if (!referenced || !ALLOWED_SUPPORT_DIRECTORIES.has(referenced.split("/", 1)[0] ?? "")) {
			throw new Error("prepared Hermes SKILL.md contains an unsafe support file reference");
		}
		if (!collected.tree.has(referenced)) {
			throw new Error(`prepared Hermes Skill support file is missing: ${referenced}`);
		}
		paths.add(referenced);
	}
	return new Map(
		[...paths].sort().map((path) => [path, collected.tree.get(path) ?? Buffer.alloc(0)]),
	);
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
	const worker = new Worker(`(${runLoopbackWorker.toString()})()`, {
		eval: true,
		workerData: {
			state: shared,
			token,
			files: [...files],
			lifetimeMs: SOURCE_LIFETIME_MS,
		} satisfies LoopbackWorkerData,
	});
	worker.unref();
	try {
		const ready = waitForState(state, SourceState.Starting, READY_TIMEOUT_MS);
		if (ready !== SourceState.Ready) throw new Error("Hermes Skill loopback source did not start");
		const port = Atomics.load(state, 1);
		if (port < 1 || port > 65_535)
			throw new Error("Hermes Skill loopback source returned an invalid port");
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
