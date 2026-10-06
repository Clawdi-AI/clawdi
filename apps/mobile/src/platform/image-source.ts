import type { ApiClientFetch } from "@clawdi/shared/api";
import { markdownExternalUrl } from "@clawdi/shared/markdown";

const MAX_BYTES = 4 * 1024 * 1024;
/** Explicit raster download; no credentials/redirects or application file writes. */
export async function loadImageSource(
	url: string,
	fetch: ApiClientFetch,
	signal: AbortSignal,
	timeoutMs = 20000,
): Promise<string> {
	const target = markdownExternalUrl(url);
	if (
		!target?.startsWith("https:") ||
		signal.aborted ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	)
		throw new Error("Image unavailable");
	const controller = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let rejectAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = () => reject(new Error("Image unavailable"));
	});
	const abort = () => {
		controller.abort();
		rejectAbort?.();
	};
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	const run = async () => {
		const policy = {
			headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: controller.signal,
		} as const;
		const response = await fetch(new Request(target, policy), policy);
		reader = response.body?.getReader();
		if (controller.signal.aborted) {
			void reader?.cancel().catch(() => undefined);
			throw new Error("Image unavailable");
		}
		const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
		if (
			!response.ok ||
			!mime ||
			!["image/png", "image/jpeg", "image/webp"].includes(mime) ||
			Number(response.headers.get("content-length")) > MAX_BYTES ||
			!response.body
		)
			throw new Error("Image unavailable");
		if (!reader) throw new Error("Image unavailable");
		let length = 0;
		const buffer = new Uint8Array(MAX_BYTES);
		for (;;) {
			const part = await reader.read();
			if (controller.signal.aborted) throw new Error("Image unavailable");
			if (part.done) break;
			length += part.value.byteLength;
			if (length > MAX_BYTES) throw new Error("Image unavailable");
			buffer.set(part.value, length - part.value.byteLength);
		}
		if (!length) throw new Error("Image unavailable");
		const bytes = buffer.subarray(0, length);
		const matches =
			mime === "image/png"
				? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
				: mime === "image/jpeg"
					? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
					: String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
						String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
		if (!matches) throw new Error("Image unavailable");
		let binary = "";
		for (let index = 0; index < bytes.length; index += 8192)
			binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
		return `data:${mime};base64,${btoa(binary)}`;
	};
	try {
		return await Promise.race([run(), aborted]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.abort();
		void reader?.cancel().catch(() => undefined);
	}
}
