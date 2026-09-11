import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { ConnectionProviderTransfer } from "./connection-provider-config";
import type { RuntimePaths } from "./paths";

const PROVIDER_RUNTIMES = ["openclaw", "hermes"] as const;

const transferSchema = z
	.object({
		pendingCreation: z.boolean().optional(),
		envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
		baseUrl: z.string().url(),
		apiMode: z.enum([
			"openai_chat",
			"openai_responses",
			"anthropic_messages",
			"google_generate_content",
		]),
	})
	.strict();

export interface ProviderOwnership {
	providers: Record<string, string[]>;
	transfers: Record<string, Record<string, ConnectionProviderTransfer>>;
}

export const providerOwnershipJournalSchema = z
	.object({
		schemaVersion: z.literal(1),
		instanceId: z.string().min(1),
		home: z.string().min(1),
		transfers: z.record(
			z.enum(PROVIDER_RUNTIMES),
			z.record(z.string().regex(/^[a-z][a-z0-9._-]{1,62}$/), transferSchema),
		),
		providers: z.record(z.enum(PROVIDER_RUNTIMES), z.array(z.string().min(1))),
	})
	.strict();

/** Survives config writes that precede a failed service or authority commit. */
export function readProviderOwnership(
	paths: RuntimePaths,
	instanceId: string,
	home: string,
	applied: Record<string, string[]>,
): ProviderOwnership {
	let content: string;
	try {
		content = readFileSync(join(paths.serviceStateRoot, "provider-ownership.json"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { providers: applied, transfers: { openclaw: {}, hermes: {} } };
		throw new Error("Provider ownership journal is unreadable");
	}
	let journal: z.infer<typeof providerOwnershipJournalSchema>;
	try {
		journal = providerOwnershipJournalSchema.parse(JSON.parse(content));
	} catch {
		throw new Error("Provider ownership journal is invalid");
	}
	if (journal.instanceId !== instanceId || journal.home !== home)
		throw new Error("Provider ownership journal belongs to another runtime");
	const providers = { ...applied };
	for (const runtime of PROVIDER_RUNTIMES) {
		const ids = journal.providers[runtime];
		providers[runtime] = [...new Set([...(applied[runtime] ?? []), ...ids])]
			.filter((id) => !Object.hasOwn(journal.transfers[runtime] ?? {}, id))
			.sort();
	}
	return { providers, transfers: journal.transfers };
}

export function writeProviderOwnership(
	paths: RuntimePaths,
	instanceId: string,
	home: string,
	ownership: ProviderOwnership,
): void {
	const journal = providerOwnershipJournalSchema.parse({
		schemaVersion: 1,
		instanceId,
		home,
		transfers: ownership.transfers,
		providers: Object.fromEntries(
			PROVIDER_RUNTIMES.map((runtime) => [
				runtime,
				[...new Set(ownership.providers[runtime] ?? [])]
					.filter((id) => !Object.hasOwn(ownership.transfers[runtime] ?? {}, id))
					.sort(),
			]),
		),
	});
	writePrivateFileAtomic(
		join(paths.serviceStateRoot, "provider-ownership.json"),
		`${JSON.stringify(journal)}\n`,
		{ trustedRoot: paths.serviceStateRoot, durable: true },
	);
}

/** Commit closes only first-write recovery; transfer tombstones remain permanent. */
export function commitProviderTransfers(
	transfers: ProviderOwnership["transfers"],
): ProviderOwnership["transfers"] {
	return Object.fromEntries(
		Object.entries(transfers).map(([runtime, providers]) => [
			runtime,
			Object.fromEntries(
				Object.entries(providers).map(([id, { pendingCreation: _pending, ...transfer }]) => [
					id,
					transfer,
				]),
			),
		]),
	);
}
