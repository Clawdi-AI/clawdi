import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import type { Memory } from "../lib/api-schemas";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata } from "../lib/sanitize";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

interface ListOpts {
	json?: boolean;
	// `limit` is kept for CLI-flag compatibility; the backend names it `page_size`.
	limit?: string;
	category?: string;
	q?: string;
}

function buildQuery(opts: ListOpts) {
	return {
		q: opts.q || undefined,
		page_size: opts.limit ? Number(opts.limit) : undefined,
		category: opts.category || undefined,
	};
}

function printRows(memories: Memory[], short: boolean) {
	for (const m of memories) {
		const content = sanitizeMetadata(m.content);
		const id = chalk.gray(m.id.slice(0, 8));
		if (short) {
			console.log(`  ${id}  ${chalk.white(content.slice(0, 100))}`);
		} else {
			const date = m.created_at ? new Date(m.created_at).toLocaleDateString() : "";
			const cat = m.category ? sanitizeMetadata(m.category) : "";
			console.log(
				`  ${id}  ${chalk.white(content.slice(0, 80))}  ${chalk.gray(cat)}  ${chalk.gray(date)}`,
			);
		}
	}
}

export async function memoryList(opts: ListOpts = {}) {
	requireAuth();
	const api = new ApiClient();
	const page = unwrap(await api.GET("/api/memories", { params: { query: buildQuery(opts) } }));
	const memories = page.items;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(memories, null, 2));
		return;
	}

	if (memories.length === 0) {
		console.log(chalk.gray("No memories stored."));
		return;
	}

	printRows(memories, false);
	console.log(chalk.gray(`\n  ${memories.length} of ${page.total} memories`));
}

export async function memorySearch(query: string, opts: ListOpts = {}) {
	requireAuth();
	const api = new ApiClient();
	const page = unwrap(
		await api.GET("/api/memories", { params: { query: buildQuery({ ...opts, q: query }) } }),
	);
	const memories = page.items;

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
	const result = unwrap(
		await api.POST("/api/memories", {
			body: { content, category: "fact", source: "manual" },
		}),
	);
	console.log(chalk.green(`✓ Added memory ${result.id.slice(0, 8)}`));
}

export async function memoryRm(id: string) {
	requireAuth();
	const api = new ApiClient();
	unwrap(await api.DELETE("/api/memories/{memory_id}", { params: { path: { memory_id: id } } }));
	console.log(chalk.green("✓ Deleted memory"));
}
