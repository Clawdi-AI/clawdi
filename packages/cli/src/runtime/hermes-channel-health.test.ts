import { expect, test } from "bun:test";
import {
	configuredHermesPlatforms,
	hermesChannelStates,
	hermesGatewayIsReady,
	hermesRestartDrain,
} from "./hermes-channel-health";

const gateway = { gateway_state: "running", pid: 10, start_time: 100 };
const currentWriter = { writer_pid: 10, writer_start_time: 100 };

test("explicit adapter disables win over earlier nested enablement", () => {
	expect(
		configuredHermesPlatforms({
			gateway: { platforms: { discord: { enabled: true } }, telegram: { enabled: true } },
			platforms: { discord: { enabled: true } },
			discord: { enabled: false },
		}),
	).toEqual(["telegram"]);
});

test("only configured channels are emitted, uniquely sorted, without native error details", () => {
	const config = { discord: { enabled: true }, platforms: { whatsapp: { enabled: false } } };
	const native = {
		...gateway,
		platforms: {
			discord: { state: "connected", writer_pid: 10, writer_start_time: 100 },
			whatsapp: {
				state: "fatal",
				error_code: "whatsapp_not_paired",
				writer_pid: 9,
				writer_start_time: 50,
			},
		},
	};
	expect(configuredHermesPlatforms(config)).toEqual(["discord"]);
	expect(hermesChannelStates(configuredHermesPlatforms(config), native)).toEqual([
		{ kind: "channel", runtime: "hermes", integration: "discord", state: "connected" },
	]);
	expect(hermesChannelStates(configuredHermesPlatforms({}), native)).toEqual([]);
	expect(
		hermesChannelStates(["whatsapp", "telegram", "discord", "telegram"], native).map(
			(entry) => entry.integration,
		),
	).toEqual(["discord", "telegram", "whatsapp"]);
});

test.each(["connected", "connecting", "retrying", "disconnected", "fatal", "paused"])(
	"native %s channel state does not fail core gateway readiness",
	(state) => {
		const native = { ...gateway, platforms: { telegram: { ...currentWriter, state } } };
		expect(hermesGatewayIsReady(native)).toBe(true);
		expect(hermesChannelStates(["telegram"], native)).toEqual([
			{ kind: "channel", runtime: "hermes", integration: "telegram", state },
		]);
	},
);

test.each([
	{ state: "connected", writer_pid: 9, writer_start_time: 100 },
	{ state: "connected", writer_pid: 10, writer_start_time: 50 },
	{ state: "not-a-native-state", ...currentWriter },
	undefined,
])("stale, missing or unrecognized channel metadata is unknown", (platform) => {
	const native = { ...gateway, platforms: { discord: platform } };
	expect(hermesGatewayIsReady(native)).toBe(true);
	expect(hermesChannelStates(["discord"], native)[0]?.state).toBe("unknown");
});

test.each([
	null,
	{ ...gateway, gateway_state: "stopped" },
	{ ...gateway, gateway_state: "starting" },
	{ ...gateway, pid: 0 },
	{ ...gateway, pid: -1 },
	{ ...gateway, pid: "10" },
])("non-current gateway still fails core readiness and yields unknown channels", (native) => {
	expect(hermesGatewayIsReady(native)).toBe(false);
	expect(hermesChannelStates(["telegram"], native)[0]?.state).toBe("unknown");
});

test("legacy platform states without writer metadata remain supported", () => {
	expect(
		hermesChannelStates(["telegram"], {
			gateway_state: "running",
			pid: 10,
			platforms: { telegram: { state: "connected" } },
		})[0]?.state,
	).toBe("connected");
});

const drainNow = Date.parse("2026-10-30T10:00:00Z");
const drainStatus = { gateway_running: true, gateway_state: "draining", gateway_pid: 10 };
const drainState = {
	...gateway,
	gateway_state: "draining",
	restart_requested: true,
	updated_at: "2026-10-30T09:59:30Z",
	active_work: [{ kind: "chat" }, { kind: "cron" }],
};

test.each([
	[undefined, 1875],
	[0, 75],
	[30, 105],
	[0.5, 76],
	[3600, 2400],
	[-100, 1],
	["60", 135],
	["", 1875],
	["invalid", 1875],
])("restart drain budget uses the native timeout %s plus bounded headroom", (timeout, budget) => {
	expect(
		hermesRestartDrain(
			drainStatus,
			drainState,
			{ agent: { restart_after_turn_timeout: timeout } },
			drainNow,
		),
	).toEqual({
		runtime: "hermes",
		reason: "upstream_restart_drain",
		activeWork: 2,
		budgetSeconds: budget,
	});
});

test.each([
	{ restart_requested: false },
	{ restart_requested: undefined },
	{ updated_at: "2026-10-30T09:58:29Z" },
	{ updated_at: "2026-10-30T10:00:01Z" },
	{ updated_at: "invalid" },
	{ updated_at: undefined },
	{ pid: 11 },
	{ pid: 0 },
	{ pid: "10" },
	{ gateway_state: "stopped" },
])("restart admission rejects unrequested, stale or mismatched evidence %j", (extra) => {
	expect(hermesRestartDrain(drainStatus, { ...drainState, ...extra }, {}, drainNow)).toBeNull();
});

test.each(["running", "starting", "stopping", "stopped", "degraded", "startup_failed"])(
	"dashboard state %s cannot certify a restart drain",
	(gateway_state) => {
		expect(
			hermesRestartDrain({ ...drainStatus, gateway_state }, drainState, {}, drainNow),
		).toBeNull();
	},
);

test("drain permits absent dashboard PID and active-work details but requires liveness", () => {
	const status = { ...drainStatus, gateway_pid: undefined };
	const state = { ...drainState, active_work: undefined };
	expect(hermesRestartDrain(status, state, {}, drainNow)?.activeWork).toBe(0);
	expect(hermesRestartDrain({ ...status, gateway_running: false }, state, {}, drainNow)).toBeNull();
});

test.each(["connected", "connecting", "retrying", "disconnected", "fatal", "paused"])(
	"an admitted drain retains native channel state %s and writer identity checks",
	(state) => {
		const native = { ...drainState, platforms: { telegram: { ...currentWriter, state } } };
		const admitted = hermesRestartDrain(drainStatus, native, {}, drainNow) !== null;
		expect(hermesChannelStates(["telegram"], native)[0]?.state).toBe("unknown");
		expect(hermesChannelStates(["telegram"], native, admitted)[0]?.state).toBe(state);
		native.platforms.telegram.writer_pid = 9;
		expect(hermesChannelStates(["telegram"], native, admitted)[0]?.state).toBe("unknown");
	},
);
