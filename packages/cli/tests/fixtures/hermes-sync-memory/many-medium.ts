import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.env.CLAWDI_MEMORY_FIXTURE_ROOT;
if (!root) throw new Error("CLAWDI_MEMORY_FIXTURE_ROOT is required");
const adapter = process.argv.includes("--adapter=openclaw") ? "openclaw" : "hermes";
const idle = process.argv.includes("--idle");
const total = idle ? 0 : adapter === "hermes" ? 400 : 300;
const home = join(root, "home");
const hermes = join(home, ".hermes");
const openclaw = join(home, ".openclaw");
const timestamp = 1776247000000;
const text = "中😀éabc".repeat(Math.floor(250_000 / 12));
const large = "L".repeat(8 * 1024 * 1024 - 1024);
const sessionId = (index: number) => `medium-${index}`;

if (process.argv.includes("--seed")) {
	rmSync(home, { recursive: true, force: true });
	mkdirSync(hermes, { recursive: true });
	const bin = join(home, "bin");
	mkdirSync(bin, { recursive: true });
	if (adapter === "hermes") {
		const app = join(hermes, "hermes-agent");
		mkdirSync(join(app, "hermes_cli"), { recursive: true });
		mkdirSync(join(app, "venv", "bin"), { recursive: true });
		writeFileSync(join(app, "hermes_cli", "__init__.py"), "");
		writeFileSync(
			join(app, "hermes_cli", "profiles.py"),
			"from pathlib import Path\nimport os\ndef list_profile_names(): return ['default']\ndef get_profile_dir(name): return Path(os.environ['HERMES_HOME'])\ndef read_profile_meta(path): return {}\n",
		);
		writeFileSync(
			join(app, "venv", "bin", "python"),
			'#!/bin/sh\nexec /usr/local/bin/python3 "$@"\n',
			{ mode: 0o755 },
		);
		const db = new DatabaseSync(join(hermes, "state.db"));
		try {
			db.exec(`
				CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT,
				started_at REAL, ended_at REAL, message_count INTEGER, input_tokens INTEGER,
				output_tokens INTEGER, cache_read_tokens INTEGER);
				CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
				content TEXT, timestamp REAL);
				CREATE INDEX messages_session ON messages(session_id, id);
				BEGIN;
			`);
			const session = db.prepare(
				"INSERT INTO sessions VALUES (?, 'discord', 'fixture-model', NULL, ?, NULL, 1, 0, 0, 0)",
			);
			const message = db.prepare(
				"INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
			);
			for (let index = 0; index < total + (idle ? 0 : 1); index++) {
				const id = index === total ? "large" : sessionId(index);
				session.run(id, timestamp / 1000 + index);
				message.run(id, index === total ? large : text, timestamp / 1000 + index);
			}
			db.exec("COMMIT");
		} finally {
			db.close();
		}
	} else {
		writeFileSync(
			join(bin, "openclaw"),
			`#!/bin/sh\nif [ "$*" = "agents list --json" ]; then printf '%s\\n' '[{"id":"main","workspace":"${openclaw}/workspace"}]'; exit 0; fi\nexit 1\n`,
			{ mode: 0o755 },
		);
		const directory = join(openclaw, "agents", "main", "sessions");
		mkdirSync(directory, { recursive: true });
		const inventory: Record<string, unknown> = {};
		for (let index = 0; index < total; index++) {
			const id = sessionId(index);
			inventory[`agent:main:channel:${index}`] = {
				sessionId: id,
				updatedAt: timestamp + index,
				sessionFile: `${id}.jsonl`,
			};
			writeFileSync(
				join(directory, `${id}.jsonl`),
				`${JSON.stringify({ type: "message", id: `row-${index}`, timestamp: new Date(timestamp + index).toISOString(), message: { role: "user", content: [{ type: "text", text }] } })}\n`,
			);
		}
		writeFileSync(join(directory, "sessions.json"), JSON.stringify(inventory));
	}
	console.log(
		JSON.stringify({
			adapter,
			seeded: total + (adapter === "hermes" && !idle ? 1 : 0),
			mediumContentBytes: Buffer.byteLength(text),
			largeContentBytes: adapter === "hermes" && !idle ? large.length : 0,
		}),
	);
} else {
	const build = process.argv.find((value) => value.startsWith("--build="))?.slice(8);
	if (!build) throw new Error("--build is required");
	// Receipts are independent for each build/cap run, while source bytes are identical.
	rmSync(join(home, ".clawdi"), { recursive: true, force: true });
	const emptyHead = createHash("sha256").update("clawdi-events-v1\n", "ascii").digest("hex");
	const staged = new Map<string, { generation: string; count: number; head: string }>();
	const committed = new Set<string>();
	const seen = new Set<string>();
	let chunks = 0;
	let failure: Error | undefined;
	let done: () => void = () => {};
	const complete = new Promise<void>((resolve) => {
		done = resolve;
	});
	const expected = total + (adapter === "hermes" && !idle ? 1 : 0);
	const reply = (res: ServerResponse, data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const body = async (req: IncomingMessage) => {
		const buffers: Buffer[] = [];
		for await (const data of req) buffers.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
		return Buffer.concat(buffers);
	};
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const path = new URL(req.url ?? "/", "http://fixture.test").pathname;
		if (path === "/v1/sync/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(": connected\n\n");
			return;
		}
		if (path === "/v1/agents/memory-agent/profiles") return reply(res, []);
		if (path === "/v1/agents/memory-agent")
			return reply(res, { id: "memory-agent", default_project_id: "memory-project" });
		if (path.includes("/sync-heartbeat")) {
			res.writeHead(204);
			res.end();
			return;
		}
		if (path.includes("/skills"))
			return reply(res, { items: [], total: 0, page: 1, page_size: 200 });
		if (path === "/v1/sessions/upload-capabilities")
			return reply(res, {
				protocols: ["events-v1"],
				event_chunk_target_bytes: 4 * 1024 * 1024,
				event_chunk_max_bytes: 8 * 1024 * 1024,
			});
		if (path === "/v1/sessions/batch") {
			const input = JSON.parse((await body(req)).toString());
			const ids = input.sessions.map(
				(session: { local_session_id: string }) => session.local_session_id,
			);
			for (const id of ids) seen.add(id);
			return reply(res, {
				created: ids.length,
				updated: 0,
				unchanged: 0,
				rejected: [],
				needs_content: ids,
			});
		}
		const eventPath = path.match(/^\/v1\/sessions\/([^/]+)\/events\/(.*)$/);
		if (eventPath) {
			const id = decodeURIComponent(eventPath[1] ?? "");
			const suffix = eventPath[2];
			if (suffix === "head")
				return reply(res, {
					protocol: "events-v1",
					generation: null,
					revision: 0,
					count: 0,
					head_hash: emptyHead,
				});
			if (suffix === "generations") {
				const input = JSON.parse((await body(req)).toString());
				staged.set(id, { generation: input.generation, count: 0, head: emptyHead });
				return reply(res, { generation: input.generation, status: "staging" });
			}
			const stage = staged.get(id);
			if (!stage) throw new Error(`missing stage for ${id}`);
			if (suffix?.includes("/chunks/")) {
				const form = await new Response(await body(req), {
					headers: { "Content-Type": req.headers["content-type"] ?? "" },
				}).formData();
				const file = form.get("file");
				if (!(file instanceof File)) throw new Error("missing multipart file");
				const bytes = Buffer.from(await file.arrayBuffer());
				const digest = createHash("sha256").update(bytes).digest("hex");
				if (digest !== form.get("content_hash") || form.get("base_head_hash") !== stage.head)
					throw new Error("wrong chunk digest or prefix");
				const start = stage.count;
				for (const line of bytes.toString("ascii").trimEnd().split("\n")) {
					const event = JSON.parse(line);
					if (
						event.seq !== stage.count ||
						event.parts?.[0]?.text !== (id === "large" ? large : text)
					)
						throw new Error(`lost content or reordered event for ${id}`);
					stage.head = createHash("sha256")
						.update(Buffer.from(stage.head, "hex"))
						.update(createHash("sha256").update(line, "ascii").digest())
						.digest("hex");
					stage.count++;
				}
				chunks++;
				return reply(res, {
					generation: stage.generation,
					start_seq: start,
					end_seq: stage.count - 1,
					count: stage.count - start,
					content_hash: digest,
					result_head_hash: stage.head,
				});
			}
			if (suffix?.endsWith("/commit")) {
				const input = JSON.parse((await body(req)).toString());
				if (
					input.final_count !== stage.count ||
					input.final_head_hash !== stage.head ||
					stage.count !== 1
				)
					throw new Error(`incomplete history for ${id}`);
				committed.add(id);
				reply(res, {
					generation: stage.generation,
					revision: 1,
					count: stage.count,
					head_hash: stage.head,
				});

				return;
			}
		}
		if (path.includes("/observations"))
			return reply(res, { detail: "fixture has no runtime control plane" }, 503);
		return reply(res, { detail: `unexpected fixture request: ${path}` }, 404);
	};
	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			failure = error instanceof Error ? error : new Error(String(error));
			reply(res, { detail: "fixture validation failed" }, 500);
			done();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture listener failed");
	const api = `http://127.0.0.1:${address.port}`;
	// wait4/resource reports the daemon's peak RSS, excluding the mock API process.
	const python =
		"import subprocess,resource,signal,sys,json\np=subprocess.Popen(sys.argv[1:])\nsignal.signal(signal.SIGTERM,lambda *_: p.terminate())\ncode=p.wait()\nprint('MEMORY_RESULT='+json.dumps({'exitCode':code,'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}),flush=True)\nsys.exit(0 if code==0 else 1)";
	const policy = process.env.NODE_OPTIONS?.includes("--max-semi-space-size")
		? "semi16"
		: process.env.NODE_OPTIONS
			? "old256"
			: "default";
	const runName = `${adapter}-${build}-${idle ? "idle" : policy}`;
	const daemon = spawn(
		"/usr/local/bin/python3",
		[
			"-c",
			python,
			process.execPath,
			join(root, build, "bin", "clawdi.mjs"),
			"daemon",
			"run",
			"--port",
			"0",
		],
		{
			env: {
				...process.env,
				NODE_OPTIONS:
					`${process.env.NODE_OPTIONS ?? ""} --import=file://${join(root, "memory-probe.mjs")}`.trim(),
				CLAWDI_MEMORY_PROBE_PATH: join(root, `${runName}.memory.jsonl`),
				HOME: home,
				HERMES_HOME: hermes,
				OPENCLAW_STATE_DIR: openclaw,
				PATH: `${join(home, "bin")}:/nonexistent`,
				CLAWDI_AUTH_TOKEN: "memory-fixture-key",
				CLAWDI_AUTH_TOKEN_ORIGIN: api,
				CLAWDI_AGENT_TYPE: adapter,
				CLAWDI_ENVIRONMENT_ID: "memory-agent",
				CLAWDI_API_URL: api,
				CLAWDI_SERVE_MODE: "container",
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
				CLAWDI_SERVE_DEBUG: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	let log = "";
	const logPath = join(root, `${runName}.daemon.log`);
	writeFileSync(logPath, "");
	daemon.stdout.on("data", (data: Buffer) => {
		output += data.toString();
	});
	let pushed = 0;
	let pendingLog = "";
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	daemon.stderr.on("data", (data: Buffer) => {
		log = (log + data.toString()).slice(-32_000);
		appendFileSync(logPath, data);
		pendingLog += data.toString();
		const lines = pendingLog.split("\n");
		pendingLog = lines.pop() ?? "";
		for (const line of lines) {
			if (line.includes('"event":"engine.session_pushed"') && ++pushed === expected) done();
			if (idle && line.includes('"event":"engine.start"')) idleTimer = setTimeout(done, 10_000);
		}
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		daemon.once("error", reject);
		daemon.once("exit", resolve);
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			complete,
			exited.then(() => {
				throw new Error(`daemon exited before complete upload: ${output}\n${log.slice(-6000)}`);
			}),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() =>
						reject(
							new Error(
								`daemon timed out: committed=${committed.size}/${expected}\n${log.slice(-6000)}`,
							),
						),
					10 * 60_000,
				);
			}),
		]);
		if (failure) throw failure;
		if (seen.size !== expected || committed.size !== expected)
			throw new Error("incomplete session inventory");
	} finally {
		if (timeout) clearTimeout(timeout);
		if (idleTimer) clearTimeout(idleTimer);
		daemon.kill("SIGTERM");
		await exited;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
	const resultLine = output.split("\n").find((line) => line.startsWith("MEMORY_RESULT="));
	if (!resultLine) throw new Error(`missing peak RSS: ${output}`);
	const result = JSON.parse(resultLine.slice(14));
	if (result.exitCode !== 0) throw new Error(`daemon shutdown failed: ${output}`);
	console.log(
		JSON.stringify({
			adapter,
			build,
			idle,
			node: process.version,
			nodeOptions: process.env.NODE_OPTIONS ?? "",
			sessions: committed.size,
			chunks,
			...result,
		}),
	);
}
