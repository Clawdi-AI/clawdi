import chalk from "chalk";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata } from "../lib/sanitize";

interface MemoryRow {
	id: string;
	content: string;
	category?: string;
	created_at: string;
}

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

function buildQuery(opts: {
	limit?: string;
	category?: string;
	since?: string;
	q?: string;
}): string {
	const params = new URLSearchParams();
	if (opts.q) params.set("q", opts.q);
	if (opts.limit) params.set("limit", opts.limit);
	if (opts.category) params.set("category", opts.category);
	if (opts.since) params.set("since", opts.since);
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

function printRows(memories: MemoryRow[], short: boolean) {
	for (const m of memories) {
		const content = sanitizeMetadata(m.content);
		const id = chalk.gray(m.id.slice(0, 8));
		if (short) {
			console.log(`  ${id}  ${chalk.white(content.slice(0, 100))}`);
		} else {
			const date = new Date(m.created_at).toLocaleDateString();
			const cat = m.category ? sanitizeMetadata(m.category) : "";
			console.log(
				`  ${id}  ${chalk.white(content.slice(0, 80))}  ${chalk.gray(cat)}  ${chalk.gray(date)}`,
			);
		}
	}
}

export async function memoryList(
	opts: { json?: boolean; limit?: string; category?: string; since?: string } = {},
) {
	requireAuth();
	const api = new ApiClient();
	const memories = await api.get<MemoryRow[]>(`/api/memories${buildQuery(opts)}`);

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(memories, null, 2));
		return;
	}

	if (memories.length === 0) {
		console.log(chalk.gray("No memories stored."));
		return;
	}

	printRows(memories, false);
	console.log(
		chalk.gray(`\n  ${memories.length} memor${memories.length === 1 ? "y" : "ies"} total`),
	);
}

export async function memorySearch(
	query: string,
	opts: { json?: boolean; limit?: string; category?: string; since?: string } = {},
) {
	requireAuth();
	const api = new ApiClient();
	const memories = await api.get<MemoryRow[]>(`/api/memories${buildQuery({ ...opts, q: query })}`);

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(memories, null, 2));
		return;
	}

	if (memories.length === 0) {
		console.log(chalk.gray(`No memories matching "${sanitizeMetadata(query)}".`));
		return;
	}

	printRows(memories, true);
	console.log(chalk.gray(`\n  ${memories.length} result${memories.length === 1 ? "" : "s"}`));
}

export async function memoryAdd(content: string) {
	requireAuth();
	const api = new ApiClient();
	const result = await api.post<{ id: string }>("/api/memories", { content });
	console.log(chalk.green(`✓ Added memory ${result.id.slice(0, 8)}`));
}

export async function memoryRm(id: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/memories/${id}`);
	console.log(chalk.green("✓ Deleted memory"));
}
