// Test-only Node preload: no instrumentation is included in the shipped CLI.
import { appendFileSync, writeFileSync } from "node:fs";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";

const path = process.env.CLAWDI_MEMORY_PROBE_PATH;
if (!path) throw new Error("CLAWDI_MEMORY_PROBE_PATH is required");
const started = performance.now();
let peak;
function sample(event) {
	const memory = process.memoryUsage();
	const snapshot = {
		event,
		elapsedMs: Math.round(performance.now() - started),
		...memory,
		maxRssKiB: process.resourceUsage().maxRSS,
		spaces: getHeapSpaceStatistics(),
	};
	if (!peak || memory.rss > peak.rss) peak = snapshot;
	appendFileSync(path, `${JSON.stringify(snapshot)}\n`);
}
writeFileSync(
	path,
	`${JSON.stringify({ event: "startup", node: process.version, heap: getHeapStatistics() })}\n`,
);
sample("start");
const timer = setInterval(() => sample("sample"), 200);
timer.unref();
process.on("exit", () => {
	clearInterval(timer);
	sample("exit");
	appendFileSync(path, `${JSON.stringify({ ...peak, event: "peak" })}\n`);
});
