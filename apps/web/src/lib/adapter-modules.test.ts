import { describe, expect, test } from "bun:test";
import { connectedAdapterHasModule, connectedAdapterModules } from "./adapter-modules";

describe("Connected adapter modules", () => {
	test("keeps legacy null rows backward compatible", () => {
		expect(connectedAdapterModules(null)).toEqual(["sessions", "skills"]);
		expect(connectedAdapterHasModule(undefined, "skills")).toBe(true);
	});

	test("honors a real session-only registration", () => {
		expect(connectedAdapterHasModule(["sessions"], "sessions")).toBe(true);
		expect(connectedAdapterHasModule(["sessions"], "skills")).toBe(false);
	});
});
