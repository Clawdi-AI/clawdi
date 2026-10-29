import { expect, test } from "bun:test";
import {
	configuredHermesPlatforms,
	hermesChannelStates,
	hermesGatewayIsReady,
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
