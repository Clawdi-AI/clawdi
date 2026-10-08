import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import type { Memory } from "../lib/api-schemas";
import { parsePositiveInteger } from "../lib/cli-options";
import { commandResult, emitJson, message, wantsJson } from "../lib/command-output";
import { confirmOrRequireYes } from "../lib/prompts";
import { requireAuth } from "../lib/require-auth";
import { sanitizeMetadata } from "../lib/sanitize";
import { requireSearchQuery } from "../lib/search-query";
import { isInteractive } from "../lib/tty";

interface ListOpts {
	json?: boolean;
	// `limit` is kept for CLI-flag compatibility; the backend names it `page_size`.
	limit?: string | number;
	category?: string;
	q?: string;
}

function buildQuery(opts: ListOpts) {
	return {
		q: opts.q || undefined,
		page_size: opts.limit === undefined ? undefined : parsePositiveInteger(opts.limit),
		category: opts.category || undefined,
	};
}

function printRows(memories: Memory[], short: boolean) {
	for (const m of memories) {
		const content = sanitizeMetadata(m.content);
		const id = chalk.gray(m.id);
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
	const page = unwrap(await api.GET("/v1/memories", { params: { query: buildQuery(opts) } }));
	const memories = page.items;
	if (memories.length < page.total) {
		console.error(`Showing ${memories.length} of ${page.total}; pass --limit to see more.`);
	}

	if (wantsJson(opts, { legacyImplicit: true })) {
		emitJson(memories);
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
	const searchQuery = requireSearchQuery(query, "Memory");
	const api = new ApiClient();
	const page = unwrap(
		await api.GET("/v1/memories", { params: { query: buildQuery({ ...opts, q: searchQuery }) } }),
	);
	const memories = page.items;
	if (memories.length < page.total) {
		console.error(`Showing ${memories.length} of ${page.total}; pass --limit to see more.`);
	}

	if (wantsJson(opts, { legacyImplicit: true })) {
		emitJson(memories);
		return;
	}

	if (memories.length === 0) {
		console.log(chalk.gray(`No memories matching "${sanitizeMetadata(searchQuery)}".`));
		return;
	}

	printRows(memories, true);
	console.log(chalk.gray(`\n  ${memories.length} result${memories.length === 1 ? "" : "s"}`));
}

const VALID_CATEGORIES = ["fact", "preference", "pattern", "decision", "context"] as const;
type MemoryCategory = (typeof VALID_CATEGORIES)[number];

export async function memoryAdd(content: string, opts: { category?: string; json?: boolean } = {}) {
	requireAuth();

	const category: MemoryCategory = (VALID_CATEGORIES as readonly string[]).includes(
		opts.category ?? "",
	)
		? (opts.category as MemoryCategory)
		: "fact";

	if (opts.category && category === "fact" && opts.category !== "fact") {
		console.error(
			chalk.yellow(
				`⚠ Unknown category "${opts.category}". Valid: ${VALID_CATEGORIES.join(", ")}. Defaulting to "fact".`,
			),
		);
	}

	const finding = findLikelySecret(content);
	if (finding) {
		throw new Error(formatSecretMemoryWarning(finding));
	}

	const api = new ApiClient();
	const result = unwrap(
		await api.POST("/v1/memories", {
			body: { content, category, source: "manual" },
		}),
	);
	message(opts.json, chalk.green(`✓ Added memory ${result.id} (${category})`));
	commandResult(opts.json, "clawdi.memoryAdd.v1", { id: result.id, category, status: "added" });
}

export async function memoryRm(id: string, opts: { yes?: boolean; json?: boolean } = {}) {
	requireAuth();
	if (
		isInteractive() &&
		!(await confirmOrRequireYes(`Delete memory ${id}?`, {
			yes: opts.yes,
			action: "delete this memory",
		}))
	) {
		commandResult(opts.json, "clawdi.memoryRm.v1", { id, status: "cancelled" });
		return;
	}
	const api = new ApiClient();
	unwrap(await api.DELETE("/v1/memories/{memory_id}", { params: { path: { memory_id: id } } }));
	message(opts.json, chalk.green("✓ Deleted memory"));
	commandResult(opts.json, "clawdi.memoryRm.v1", { id, status: "deleted" });
}

export async function memoryUpdate(id: string, content: string, opts: { json?: boolean } = {}) {
	requireAuth();
	if (!content.trim() || content.length > 100_000) {
		throw new Error("Memory content must contain text and be at most 100000 characters.");
	}
	const finding = findLikelySecret(content);
	if (finding) throw new Error(formatSecretMemoryWarning(finding));
	const result = unwrap(
		await new ApiClient().PATCH("/v1/memories/{memory_id}", {
			params: { path: { memory_id: id } },
			body: { content },
		}),
	);
	if (wantsJson(opts, { legacyImplicit: true })) {
		emitJson(result, false);
	} else {
		console.log(`Updated memory ${sanitizeMetadata(result.memory_id)}; metadata preserved.`);
	}
}
