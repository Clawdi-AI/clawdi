import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableJsonCache } from "./durable-cache.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable provider retry cache", () => {
	test("restores retry counters across connector instances", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-wa-provider-retry-"));
		roots.push(root);
		const path = join(root, "retry-counters.json");

		const first = new DurableJsonCache(path, 3600);
		first.set("message-a", 3);

		const restored = new DurableJsonCache(path, 3600);
		expect(restored.get<number>("message-a")).toBe(3);
		restored.del("message-a");
		expect(new DurableJsonCache(path, 3600).get("message-a")).toBeUndefined();
	});
});
