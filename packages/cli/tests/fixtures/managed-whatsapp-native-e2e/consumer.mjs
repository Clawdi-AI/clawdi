import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONTROL_BASE = "http://127.0.0.1:9000";
const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = "native-e2e-gateway-token";
const CHAT_JID = "15551112222@s.whatsapp.net";

const projection = JSON.parse(
	readFileSync(join(requiredEnvironment("E2E_OUTPUT"), "projection.json"), "utf8"),
);
if (projection.runtime !== "openclaw") {
	throw new Error("stock OpenClaw consumer requires an OpenClaw projection");
}

const openClaw = join(projection.home, ".openclaw", "bin", "openclaw");
const accountId = projection.channels?.whatsapp?.defaultAccount;
assert.equal(typeof accountId, "string");
assert.equal(typeof projection.openClawConfigPatchPath, "string");

runOpenClaw(
	["config", "patch", "--stdin", "--replace-path", "channels.whatsapp.accounts"],
	readFileSync(projection.openClawConfigPatchPath, "utf8"),
);

const gatewayLogPath = join(requiredEnvironment("E2E_OUTPUT"), "openclaw-gateway.log");
const gatewayLogFd = openSync(gatewayLogPath, "a");
const gateway = spawn(openClaw, ["gateway", "run", "--port", "18789"], {
	env: { ...process.env, HOME: projection.home },
	stdio: ["ignore", gatewayLogFd, gatewayLogFd],
});
closeSync(gatewayLogFd);

try {
	await waitFor(
		() => gateway.exitCode === null && gatewayCallAvailable("health"),
		"stock OpenClaw gateway",
		60_000,
	);
	await waitFor(async () => {
		const status = await controlStatus();
		// Socket authentication precedes the stock inbound listener attachment.
		return status.active && status.bundleCaptured && openClawReadyCount() > 0;
	}, "stock OpenClaw WhatsApp plugin connection");

	await controlPost("/control/push", {
		message_id: "openclaw-inbound-1",
		text: "openclaw inbound text",
	});
	await waitFor(async () => {
		const status = await controlStatus();
		return (
			status.modelRequests.some((request) =>
				JSON.stringify(request).includes("openclaw inbound text"),
			) &&
			status.outboundMessages.some((message) =>
				message.conversation?.includes("openclaw agent reply"),
			) &&
			status.outboundNodes.some((node) => node.tag === "receipt")
		);
	}, "OpenClaw inbound to agent model and stock reply");

	gatewayCall("send", {
		to: CHAT_JID,
		message: "openclaw outbound text",
		channel: "whatsapp",
		accountId,
		idempotencyKey: "openclaw-native-e2e-send-1",
	});
	gatewayCall("poll", {
		to: CHAT_JID,
		question: "OpenClaw poll",
		options: ["A", "B"],
		maxSelections: 1,
		channel: "whatsapp",
		accountId,
		idempotencyKey: "openclaw-native-e2e-poll-1",
	});
	await waitFor(async () => {
		const status = await controlStatus();
		return (
			status.outboundMessages.some(
				(message) => message.conversation === "openclaw outbound text",
			) &&
			status.outboundMessages.some((message) =>
				message.additionalNodes.some(
					(node) => node.tag === "meta" && node.attrs?.polltype === "creation",
				),
			)
		);
	}, "OpenClaw Gateway RPC text and poll envelopes");

	const beforeRestart = await controlStatus();
	const readyCountBeforeRestart = openClawReadyCount();
	await controlPost("/control/restart", {});
	await waitFor(async () => {
		const status = await controlStatus();
		return (
			status.connections > beforeRestart.connections &&
			status.active &&
			status.events.some(
				(event) => event.stage === "agent_bundle" && event.outcome === "restored",
			) &&
			openClawReadyCount() > readyCountBeforeRestart
		);
	}, "OpenClaw stock 515 reconnect and auth reconstruction");

	await controlPost("/control/push", {
		message_id: "openclaw-inbound-2",
		text: "openclaw inbound after 515",
	});
	await waitFor(async () => {
		const status = await controlStatus();
		return (
			status.modelRequests.some((request) =>
				JSON.stringify(request).includes("openclaw inbound after 515"),
			) &&
			status.outboundMessages.some((message) =>
				message.conversation?.includes("openclaw agent reply after reconnect"),
			)
		);
	}, "OpenClaw inbound and agent reply after 515");

	await assertCommonBoundary();
} catch (error) {
	let statusSummary;
	try {
		statusSummary = summarizeStatus(await controlStatus());
	} catch (statusError) {
		statusSummary = { unavailable: String(statusError) };
	}
	const log = readFileSync(gatewayLogPath, "utf8");
	throw new Error(
		`${String(error)}\nSanitized /control/status summary:\n${JSON.stringify(statusSummary, null, 2)}\nOpenClaw gateway log:\n${log.slice(-12_000)}`,
	);
} finally {
	await stopChild(gateway);
}

function summarizeStatus(status) {
	const events = Array.isArray(status.events) ? status.events : [];
	const outboundMessages = Array.isArray(status.outboundMessages) ? status.outboundMessages : [];
	const outboundNodes = Array.isArray(status.outboundNodes) ? status.outboundNodes : [];
	const modelRequests = Array.isArray(status.modelRequests) ? status.modelRequests : [];
	return {
		connections: status.connections,
		authorizedConnections: status.authorizedConnections,
		active: status.active,
		bundleCaptured: status.bundleCaptured,
		markerLeaks: status.markerLeaks,
		identityRejections: status.identityRejections,
		eventStages: events.map((event) => `${event.stage}:${event.outcome}`),
		outboundDrops: events
			.filter((event) => event.stage === "outbound_message" && event.outcome === "dropped")
			.map((event) => ({
				reason: event.details?.reason ?? "unspecified",
				errorType: event.details?.errorType ?? null,
			})),
		inboundPushCount: Array.isArray(status.inboundPushes) ? status.inboundPushes.length : null,
		modelRequestCount: modelRequests.length,
		outboundMessageCount: outboundMessages.length,
		outboundNodeCount: outboundNodes.length,
		assertions: {
			inboundModelRequest: modelRequests.some((request) =>
				JSON.stringify(request).includes("openclaw inbound text"),
			),
			inboundAgentReply: outboundMessages.some((message) =>
				message.conversation?.includes("openclaw agent reply"),
			),
			receiptEnvelope: outboundNodes.some((node) => node.tag === "receipt"),
			gatewayText: outboundMessages.some(
				(message) => message.conversation === "openclaw outbound text",
			),
			gatewayPollEnvelope: outboundMessages.some((message) =>
				message.additionalNodes?.some(
					(node) => node.tag === "meta" && node.attrs?.polltype === "creation",
				),
			),
			reconnected: Number(status.connections) > 1,
			restoredBundle: events.some(
				(event) => event.stage === "agent_bundle" && event.outcome === "restored",
			),
			afterReconnectModelRequest: modelRequests.some((request) =>
				JSON.stringify(request).includes("openclaw inbound after 515"),
			),
			afterReconnectAgentReply: outboundMessages.some((message) =>
				message.conversation?.includes("openclaw agent reply after reconnect"),
			),
		},
	};
}

async function assertCommonBoundary() {
	const status = await controlStatus();
	assert.equal(status.authorizedConnections, status.connections, "OpenClaw bearer rewrite");
	assert.equal(status.markerLeaks, 0, "OpenClaw marker removal");
	assert.equal(status.identityRejections, 0, "OpenClaw synthetic identity reconstruction");
	assert.ok(status.inboundPushes.length >= 2, "OpenClaw exact inbound proto evidence");
	assert.ok(status.outboundMessages.length >= 4, "OpenClaw exact outbound proto evidence");
	assert.ok(status.modelRequests.length >= 2, "OpenClaw stock agent execution evidence");
	for (const message of status.outboundMessages) {
		assert.ok(message.messageProtoBase64.length > 0, "OpenClaw exact proto pass-through");
	}
	const creds = readFileSync(join(projection.authDir, "creds.json"), "utf8");
	assert.ok(creds.includes("clawdi.managedWhatsAppSocket"), "managed metadata persisted");
	assert.ok(!creds.includes("wa-native-e2e-link-bearer"), "bearer not persisted");
	assert.ok(!creds.includes("must-not-project.invalid"), "backend URL not persisted");
}

function gatewayCall(method, params = {}) {
	return runOpenClaw([
		"gateway",
		"call",
		method,
		"--params",
		JSON.stringify(params),
		"--url",
		GATEWAY_URL,
		"--token",
		GATEWAY_TOKEN,
		"--timeout",
		"10000",
		"--json",
	]);
}

function gatewayCallAvailable(method) {
	try {
		gatewayCall(method);
		return true;
	} catch {
		return false;
	}
}

function openClawReadyCount() {
	const log = readFileSync(gatewayLogPath, "utf8");
	return log.match(/Listening for WhatsApp inbound messages/g)?.length ?? 0;
}

function runOpenClaw(args, input) {
	const result = spawnSync(openClaw, args, {
		env: { ...process.env, HOME: projection.home },
		input,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`openclaw ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

async function stopChild(child) {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		delay(5_000).then(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}),
	]);
}

async function controlStatus() {
	return await fetchJson(`${CONTROL_BASE}/control/status`);
}

async function controlPost(path, body) {
	return await fetchJson(`${CONTROL_BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function fetchJson(url, options = {}) {
	const response = await fetch(url, options);
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return await response.json();
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(`${label} timed out${lastError ? `: ${String(lastError)}` : ""}`);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnvironment(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
