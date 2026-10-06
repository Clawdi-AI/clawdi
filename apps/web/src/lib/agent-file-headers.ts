import type { AgentFile } from "@/lib/agent-files";

export function agentFileHeaders(file: AgentFile, options: { canonical?: string } = {}): Headers {
	const headers = new Headers({
		"Content-Type": `${file.contentType}; charset=utf-8`,
		"Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
		"X-Content-Type-Options": "nosniff",
	});
	if ("noindex" in file && file.noindex) headers.set("X-Robots-Tag", "noindex");
	if ("cors" in file && file.cors) headers.set("Access-Control-Allow-Origin", "*");
	if (options.canonical) headers.set("Link", `<${options.canonical}>; rel="canonical"`);
	return headers;
}
