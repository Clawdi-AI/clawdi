/**
 * Turn a FastAPI error payload into a readable one-liner.
 *
 * FastAPI packs the human message in `detail`; pydantic validation failures
 * come back as an array of `{loc, msg, type}`. Both web and CLI clients
 * flatten this the same way, so the logic lives here and both import it.
 */
export function extractApiDetail(err: unknown): string {
	if (typeof err === "object" && err !== null && "detail" in err) {
		const d = (err as { detail: unknown }).detail;
		if (typeof d === "string") return d;
		if (Array.isArray(d)) {
			return d
				.map((e) => {
					const loc = Array.isArray((e as { loc?: unknown[] })?.loc)
						? ((e as { loc: unknown[] }).loc as unknown[]).join(".")
						: "";
					const msg = (e as { msg?: string })?.msg ?? "";
					return loc ? `${loc}: ${msg}` : msg;
				})
				.filter(Boolean)
				.join("; ");
		}
	}
	return typeof err === "string" ? err : JSON.stringify(err);
}
