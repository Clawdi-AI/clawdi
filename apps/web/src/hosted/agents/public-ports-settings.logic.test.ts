import { describe, expect, test } from "bun:test";
import type { DeploymentUpdateRequest } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	createPublicPortDraftState,
	projectPublicHttpPorts,
	publicEndpointAvailability,
	publicEndpointsArePending,
	publicPortDraftIsDirty,
	publicPortsUpdate,
	reconcilePublicPortDraft,
	validatePublicPortDraft,
} from "./public-ports-settings.logic";

describe("public HTTP port settings", () => {
	test("initializes from only desired public HTTP ports in canonical order", () => {
		const deployment = hostedDeploymentFixture();
		deployment.resource.spec.ports = [
			{ name: "tenant-app", port: 9120, protocol: "http", visibility: "public" },
			{ name: "web", port: 3000, protocol: "http", visibility: "public" },
			{ name: "private", port: 4000, protocol: "http", visibility: "private" },
			{ name: "tls", port: 5000, protocol: "https", visibility: "public" },
			{ name: "tcp", port: 6000, protocol: "tcp", visibility: "public" },
		];

		expect(projectPublicHttpPorts(deployment)).toEqual([3000, 9120]);
		expect(createPublicPortDraftState(projectPublicHttpPorts(deployment)).rows).toEqual([
			{ id: "saved-3000", value: "3000" },
			{ id: "saved-9120", value: "9120" },
		]);
	});

	test("accepts clear and the full canonical port range and sorts the payload", () => {
		expect(validatePublicPortDraft(["65535", "1", "3000"])).toEqual({
			ports: [1, 3000, 65535],
			errors: [null, null, null],
		});
		expect(validatePublicPortDraft(["3000", "9120"]).ports).toEqual([3000, 9120]);
		expect(validatePublicPortDraft([]).ports).toEqual([]);
	});

	test.each([
		"",
		" 80",
		"80 ",
		"0",
		"65536",
		"1.5",
		"01",
		"+80",
		"80px",
	])("rejects non-canonical or out-of-range value %s", (value) => {
		expect(validatePublicPortDraft([value]).ports).toBeNull();
		expect(validatePublicPortDraft([value]).errors[0]).toContain("whole number from 1 to 65535");
	});

	test("rejects duplicate ports", () => {
		const result = validatePublicPortDraft(["3000", "3000"]);
		expect(result.ports).toBeNull();
		expect(result.errors).toEqual([
			"Each public port must be unique.",
			"Each public port must be unique.",
		]);
	});

	test("builds the exact generated public_ports-only update, including clear", () => {
		const update: DeploymentUpdateRequest = publicPortsUpdate([3000, 9120]);
		expect(update).toEqual({ public_ports: [3000, 9120] });
		expect(Object.keys(update)).toEqual(["public_ports"]);
		expect(publicPortsUpdate([])).toEqual({ public_ports: [] });
	});

	test("tracks unsaved state as a port set", () => {
		expect(publicPortDraftIsDirty(["3000"], [3000])).toBeFalse();
		expect(publicPortDraftIsDirty(["3001"], [3000])).toBeTrue();
		expect(publicPortDraftIsDirty(["5173", "3000"], [3000, 5173])).toBeFalse();
	});

	test("preserves dirty rows across refetches and adopts an accepted server projection", () => {
		const initial = createPublicPortDraftState([3000]);
		const dirty = {
			...initial,
			rows: [{ ...initial.rows[0], value: "5173" }],
		};

		expect(reconcilePublicPortDraft(dirty, [3000])).toBe(dirty);
		const outOfBandProjection = reconcilePublicPortDraft(dirty, [9120]);
		expect(outOfBandProjection.rows).toEqual(dirty.rows);
		expect(outOfBandProjection.baselinePorts).toEqual([9120]);

		expect(reconcilePublicPortDraft(outOfBandProjection, [5173])).toEqual(
			createPublicPortDraftState([5173]),
		);
	});

	test("never carries a draft into a different deployment", () => {
		const initial = createPublicPortDraftState([3000], "deployment-one");
		const dirty = {
			...initial,
			rows: [{ id: "saved-3000", value: "5173" }],
		};

		expect(reconcilePublicPortDraft(dirty, [3000], "deployment-two")).toEqual(
			createPublicPortDraftState([3000], "deployment-two"),
		);
	});

	test("associates URLs only through the explicit authoritative port field", () => {
		const endpoints = [
			{ port: 9120, url: "https://assigned-by-server.example" },
			{ port: 3000, url: "https://another-server-url.example" },
		];
		expect(publicEndpointAvailability(9120, endpoints, false)).toEqual({
			kind: "available",
			url: "https://assigned-by-server.example",
		});
		expect(publicEndpointAvailability(5173, endpoints, true)).toEqual({ kind: "pending" });
		expect(publicEndpointAvailability(5173, endpoints, false)).toEqual({
			kind: "unavailable",
		});
	});

	test("marks missing URLs pending only during mutation, update, or generation lag", () => {
		const current = hostedDeploymentFixture();
		expect(publicEndpointsArePending(current, false)).toBeFalse();
		expect(publicEndpointsArePending(current, true)).toBeTrue();

		const updating = hostedDeploymentFixture({ status: "updating" });
		expect(publicEndpointsArePending(updating, false)).toBeTrue();

		const stale = hostedDeploymentFixture();
		stale.resource.metadata.generation = 2;
		expect(publicEndpointsArePending(stale, false)).toBeTrue();
	});
});
