import { expect, test } from "bun:test";
import { configuredHermesPlatforms, hermesChannelsAreReady } from "./hermes-channel-health";

test("a running gateway with missing required Discord is not channel-ready", () => {
	const required = configuredHermesPlatforms({ discord: { enabled: true } });
	expect(
		hermesChannelsAreReady(required, { gateway_state: "running", pid: 10, platforms: {} }),
	).toBe(false);
});

test("explicit adapter disables win over earlier nested enablement", () => {
	expect(
		configuredHermesPlatforms({
			gateway: { platforms: { discord: { enabled: true } }, telegram: { enabled: true } },
			platforms: { discord: { enabled: true } },
			discord: { enabled: false },
		}),
	).toEqual(["telegram"]);
});

test("only current configured channels count; an unbound historical WhatsApp error is ignored", () => {
	const config = { discord: { enabled: true }, platforms: { whatsapp: { enabled: false } } };
	const state = {
		gateway_state: "running",
		pid: 10,
		start_time: 100,
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
	expect(hermesChannelsAreReady(configuredHermesPlatforms(config), state)).toBe(true);
	expect(hermesChannelsAreReady(configuredHermesPlatforms({}), state)).toBe(true);
});

test.each(["disconnected", "fatal", "connecting"])(
	"required current channel state %s is not healthy",
	(state) => {
		expect(
			hermesChannelsAreReady(["discord"], {
				gateway_state: "running",
				pid: 10,
				platforms: { discord: { state } },
			}),
		).toBe(false);
	},
);

test("connected metadata from a previous PID or reused PID is not accepted", () => {
	const state = {
		gateway_state: "running",
		pid: 10,
		start_time: 100,
		platforms: { discord: { state: "connected", writer_pid: 9, writer_start_time: 50 } },
	};
	expect(hermesChannelsAreReady(["discord"], state)).toBe(false);
	state.platforms.discord.writer_pid = 10;
	expect(hermesChannelsAreReady(["discord"], state)).toBe(false);
	state.platforms.discord.writer_start_time = 100;
	expect(hermesChannelsAreReady(["discord"], state)).toBe(true);
});

test("legacy connected states remain supported without accepting absent or malformed state", () => {
	expect(
		hermesChannelsAreReady(["telegram"], {
			gateway_state: "running",
			pid: 10,
			platforms: { telegram: { state: "connected" } },
		}),
	).toBe(true);
	expect(hermesChannelsAreReady(["telegram"], null)).toBe(false);
	expect(hermesChannelsAreReady(["telegram"], { gateway_state: "running", pid: 0 })).toBe(false);
});
