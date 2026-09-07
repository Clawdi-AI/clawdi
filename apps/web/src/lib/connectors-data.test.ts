import { describe, expect, it } from "bun:test";
import { connectorMetadataBatches } from "./connectors-data";

describe("connected metadata batches", () => {
	it("deduplicates names without reordering them or requesting empty names", () => {
		expect(connectorMetadataBatches(["slack", "", "github", "slack"])).toEqual([
			["slack", "github"],
		]);
		expect(connectorMetadataBatches([])).toEqual([]);
	});
	it("keeps every name while respecting the API batch bound", () => {
		const names = Array.from({ length: 207 }, (_, index) => `app-${index}`);
		const batches = connectorMetadataBatches(names);
		expect(batches.map((batch) => batch.length)).toEqual([100, 100, 7]);
		expect(batches.flat()).toEqual(names);
	});
});
