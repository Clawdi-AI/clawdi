import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ApiClient } from "./api-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("ApiClient.uploadSkill", () => {
	it("rejects invalid skill_key before building a multipart request", async () => {
		const api = new ApiClient({ requireAuth: false });

		await expect(
			api.uploadSkill(
				"00000000-0000-0000-0000-000000000000",
				".system",
				Buffer.from("not a tar"),
				".system.tar.gz",
			),
		).rejects.toThrow("Invalid skill_key (length=7, components=1, reason=invalid_component_start)");
	});
});

describe("multipart upload deadline", () => {
	it.each([25 * 1024 * 1024, 1024])("allows transfer time for %i bytes", async (size) => {
		const originalTimeout = globalThis.setTimeout;
		const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
		let now = 0;
		function fakeTimeout(callback: TimerHandler, delay?: number, ...args: unknown[]): number;
		function fakeTimeout<TArgs extends unknown[]>(
			callback: (...args: TArgs) => void,
			delay?: number,
			...args: TArgs
		): ReturnType<typeof setTimeout>;
		function fakeTimeout(
			callback: TimerHandler,
			delay = 0,
			...args: unknown[]
		): number | ReturnType<typeof setTimeout> {
			if (typeof callback !== "function") throw new Error("unexpected string timer");
			const handle = originalTimeout(() => {}, 3_600_000);
			timers.set(handle, { at: now + delay, callback: () => callback(...args) });
			return handle;
		}
		const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign(fakeTimeout, { __promisify__: originalTimeout.__promisify__ }),
		);
		let started: () => void = () => {};
		const fetched = new Promise<void>((resolve) => {
			started = resolve;
		});
		let aborted = false;
		globalThis.fetch = Object.assign(
			async (_request: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
					setTimeout(
						() => resolve(Response.json({ status: "uploaded", content_hash: "hash" })),
						31_000,
					);
					started();
				}),
			{ preconnect: originalFetch.preconnect },
		);
		const advance = (until: number) => {
			for (const [handle, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
				if (timer.at > until) continue;
				timers.delete(handle);
				clearTimeout(handle);
				now = timer.at;
				timer.callback();
			}
			now = until;
		};
		try {
			const upload = new ApiClient({ requireAuth: false }).uploadSessionContent(
				"session",
				Buffer.alloc(size),
				"session.json",
				{ environmentId: "agent", expectedContentHash: "hash" },
			);
			const outcome = upload.then(
				() => "uploaded",
				() => "timeout",
			);
			await fetched;
			advance(30_000);
			expect(aborted).toBe(false);
			if (size === 1024) {
				advance(30_010);
				expect(await outcome).toBe("timeout");
				expect(aborted).toBe(true);
			} else {
				advance(31_000);
				expect(await outcome).toBe("uploaded");
				expect(aborted).toBe(false);
			}
		} finally {
			for (const handle of timers.keys()) clearTimeout(handle);
			timerSpy.mockRestore();
		}
	});
});

describe("ApiClient session upload origin", () => {
	it("sends the Agent origin for equal local IDs with unbound credentials", async () => {
		const origins: FormDataEntryValue[] = [];
		globalThis.fetch = (async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/v1/sessions/shared-id/upload");
			const form = await request.formData();
			const origin = form.get("environment_id");
			if (origin === null)
				return Response.json({ detail: "session_origin_required" }, { status: 409 });
			origins.push(origin);
			expect(form.get("expected_content_hash")).toBe("a".repeat(64));
			return Response.json({ status: "uploaded", content_hash: "a".repeat(64) });
		}) as typeof fetch;
		const api = new ApiClient({ requireAuth: false });
		for (const environmentId of ["agent-a", "agent-b"]) {
			await api.uploadSessionContent("shared-id", Buffer.from("[]"), "shared-id.json", {
				environmentId,
				expectedContentHash: "a".repeat(64),
			});
		}
		expect(origins).toEqual(["agent-a", "agent-b"]);
	});
});

describe("ApiClient machine fence", () => {
	it("sends one normalized identity through generated and handwritten request paths", async () => {
		const captured: Request[] = [];
		globalThis.fetch = (async (request: Request) => {
			captured.push(request.clone());
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			if (new URL(request.url).pathname === "/bytes") return new Response("content");
			return Response.json({ status: "ok" });
		}) as typeof fetch;

		const api = new ApiClient({ requireAuth: false, machineId: "  machine-1  " });
		await api.GET("/health");
		await api.uploadAgentSkill(
			"agent-1",
			"project-1",
			"demo",
			Buffer.from("archive"),
			"demo.tar.gz",
		);
		await api.deleteAgentSkill("agent-1", "demo", "project-1");
		await api.postJson<Record<string, unknown>>("/post");
		await api.postJsonBody<Record<string, unknown>>("/post-body", { ok: true });
		await api.getBytes("/bytes");

		expect(captured).toHaveLength(6);
		expect(
			captured.every((request) => request.headers.get("X-Clawdi-Machine-Id") === "machine-1"),
		).toBe(true);
	});
});

describe("ApiClient upload cancellation", () => {
	it.each(["before request", "during credentials"])(
		"does not send an upload canceled %s",
		async (timing) => {
			const abort = new AbortController();
			const api = new ApiClient({ requireAuth: false, abortSignal: abort.signal });
			let requests = 0;
			globalThis.fetch = (async (_request: Request) => {
				requests += 1;
				return Response.json({ status: "ok" });
			}) as typeof fetch;
			if (timing === "before request") abort.abort();
			else {
				api.getAccessToken = async () => {
					abort.abort();
					return "";
				};
			}
			await expect(
				api.uploadSessionEventGenerationChunk({
					localSessionId: "session",
					generation: "generation",
					startSeq: 0,
					baseHeadHash: "a".repeat(64),
					contentHash: "b".repeat(64),
					file: Buffer.from("{}\n"),
				}),
			).rejects.toMatchObject({ name: "ApiError", body: "aborted", isTimeout: false });
			expect(requests).toBe(0);
		},
	);
});
