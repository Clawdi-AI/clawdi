import chalk from "chalk";
import { ApiClient } from "../lib/api-client";
import type { MemoryRecord } from "../lib/api-types";
import { isLoggedIn } from "../lib/config";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		process.exit(1);
	}
}

export async function memoriesList() {
	requireAuth();
	const api = new ApiClient();
	const memories = await api.get<MemoryRecord[]>("/api/memories");

	if (memories.length === 0) {
		console.log(chalk.gray("No memories stored."));
		return;
	}

	for (const m of memories) {
		const date = m.created_at ? new Date(m.created_at).toLocaleDateString() : "—";
		console.log(
			`  ${chalk.gray(m.id.slice(0, 8))}  ${chalk.white(m.content.slice(0, 80))}  ${chalk.gray(m.category)}  ${chalk.gray(date)}`,
		);
	}
	console.log(chalk.gray(`\n  ${memories.length} memories total`));
}

export async function memoriesSearch(query: string) {
	requireAuth();
	const api = new ApiClient();
	const memories = await api.get<MemoryRecord[]>(`/api/memories?q=${encodeURIComponent(query)}`);

	if (memories.length === 0) {
		console.log(chalk.gray(`No memories matching "${query}".`));
		return;
	}

	for (const m of memories) {
		console.log(`  ${chalk.gray(m.id.slice(0, 8))}  ${chalk.white(m.content.slice(0, 100))}`);
	}
	console.log(chalk.gray(`\n  ${memories.length} results`));
}

export async function memoriesAdd(content: string) {
	requireAuth();
	const api = new ApiClient();
	const result = await api.post<{ id: string }>("/api/memories", { content });
	console.log(chalk.green(`✓ Added memory ${result.id.slice(0, 8)}`));
}

export async function memoriesRm(id: string) {
	requireAuth();
	const api = new ApiClient();
	await api.delete(`/api/memories/${id}`);
	console.log(chalk.green(`✓ Deleted memory`));
}
