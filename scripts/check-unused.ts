import { readFile } from "node:fs/promises";

const categories = [
	"files",
	"exports",
	"dependencies",
	"devDependencies",
	"optionalPeerDependencies",
	"unlisted",
	"unresolved",
] as const;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
	const baseline: unknown = JSON.parse(
		await readFile(new URL("../knip-baseline.json", import.meta.url), "utf8"),
	);
	if (!Array.isArray(baseline)) throw new Error("Invalid Knip baseline");
	const allowed = new Set<string>();
	for (const item of baseline) {
		if (
			!record(item) ||
			typeof item.file !== "string" ||
			typeof item.name !== "string" ||
			item.category !== "exports" ||
			typeof item.reason !== "string" ||
			!item.reason.trim()
		) {
			throw new Error("Baseline entries must name one export and explain why it is retained");
		}
		const key = JSON.stringify([item.file, item.category, item.name]);
		if (allowed.has(key)) throw new Error("Duplicate Knip baseline entry");
		allowed.add(key);
	}

	const child = Bun.spawn(
		["bun", "run", "--silent", "knip", "--reporter", "json", "--no-progress"],
		{
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0 && code !== 1) throw new Error(`Knip failed with exit code ${code}`);
	const report: unknown = JSON.parse(output);
	if (!record(report) || !Array.isArray(report.issues)) throw new Error("Invalid Knip report");
	let failures = 0;
	let ignored = 0;
	for (const issue of report.issues) {
		if (!record(issue) || typeof issue.file !== "string") throw new Error("Invalid Knip issue");
		for (const category of categories) {
			const items = issue[category];
			if (!Array.isArray(items)) throw new Error(`Missing Knip category: ${category}`);
			for (const item of items) {
				if (!record(item) || typeof item.name !== "string") throw new Error("Invalid Knip item");
				if (allowed.has(JSON.stringify([issue.file, category, item.name]))) {
					ignored++;
				} else {
					console.error(`${category}: ${issue.file}: ${item.name}`);
					failures++;
				}
			}
		}
	}
	if (code === 1 && failures === 0 && ignored === 0)
		throw new Error("Knip failed without findings");
	if (failures > 0) {
		console.error(`${failures} new unused-code findings. Fix them before merging.`);
		process.exitCode = 1;
		return;
	}
	console.log(`Unused-code gate passed (${ignored} explicitly documented existing exports).`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Unused-code check failed");
	process.exitCode = 1;
});
