import { expect, test } from "bun:test";
import { loadImageSource } from "./image-source";

const signal = () => new AbortController().signal;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
test("image preview downloads anonymously and validates raster signatures", async () => {
	const uri = await loadImageSource(
		"https://images.example/a.png",
		async (request, init) => {
			expect(request.headers.get("authorization")).toBeNull();
			expect(request.headers.get("cache-control")).toBe("no-store");
			expect(init).toMatchObject({
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			});
			return new Response(png, { headers: { "content-type": "image/png" } });
		},
		signal(),
	);
	expect(uri).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`);
	await expect(
		loadImageSource(
			"https://images.example/bad",
			async () => new Response("<html>", { headers: { "content-type": "image/png" } }),
			signal(),
		),
	).rejects.toThrow();
});
test("image boundary rejects unsafe URLs, vector responses and oversized streams", async () => {
	let calls = 0;
	const fetch = async () => {
		calls++;
		return new Response("x");
	};
	for (const url of ["http://example.com/a", "file:///x", "https://user:secret@example.com/a"])
		await expect(loadImageSource(url, fetch, signal())).rejects.toThrow();
	expect(calls).toBe(0);
	await expect(
		loadImageSource(
			"https://images.example/a",
			async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
			signal(),
		),
	).rejects.toThrow();
	let cancelled = false;
	await expect(
		loadImageSource(
			"https://images.example/a",
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "image/png" } },
				),
			signal(),
		),
	).rejects.toThrow();
	expect(cancelled).toBe(true);
});
test("image timeout and caller cancellation bound fetches which ignore abort", async () => {
	const stalled = () => new Promise<Response>(() => undefined);
	await expect(loadImageSource("https://images.example/a", stalled, signal(), 5)).rejects.toThrow();
	const controller = new AbortController();
	const result = loadImageSource("https://images.example/a", stalled, controller.signal);
	controller.abort();
	await expect(result).rejects.toThrow();
	let cancelled = false;
	await expect(
		loadImageSource(
			"https://images.example/a",
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "image/png" } },
				),
			signal(),
			5,
		),
	).rejects.toThrow();
	expect(cancelled).toBe(true);
});
