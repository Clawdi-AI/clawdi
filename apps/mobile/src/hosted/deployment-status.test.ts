import { expect, test } from "bun:test";
import { operationIdFromName } from "@/hosted/deployment-status";

test("LRO names become one safe operation ID", () => {
	expect(operationIdFromName("operations/op_abc-123")).toBe("op_abc-123");
	for (const name of [
		undefined,
		"op_abc",
		"operations/",
		"operations/a/b",
		"operations/../a",
		"operations/a%2Fb",
		"operations/a?b",
		"operations/a b",
	])
		expect(operationIdFromName(name)).toBeNull();
});
