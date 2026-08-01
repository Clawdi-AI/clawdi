import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	buildActionOperation,
	buildMarkReadOperation,
	buildSendOperation,
	buildTypingOperation,
	createRelayClient,
	MAX_MEDIA_BYTES,
	normalizeInboxEvent,
	processDurableInboxEvent,
	runInboxLoop,
} from "../runtime-adapters/whatsapp/openclaw/relay-client.js";
import { renderHermesManagedPlugin } from "../src/lib/hermes-config-merge";
import {
	buildManagedWhatsAppAdapterBundle,
	buildManagedWhatsAppAdapterProjection,
	MANAGED_WHATSAPP_HERMES_UPSTREAM,
	MANAGED_WHATSAPP_OPENCLAW_UPSTREAM,
	managedWhatsAppAdapterCanActivate,
	managedWhatsAppAdapterMutationTargets,
	managedWhatsAppAdapterReadiness,
	managedWhatsAppAdapterTargetDir,
	reconcileManagedWhatsAppAdapterBundle,
} from "../src/runtime/managed-whatsapp-adapters";

const cliRoot = join(import.meta.dir, "..");
const tempRoots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-managed-whatsapp-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed WhatsApp adapter bundles", () => {
	test("pins the audited contracts while refusing activation and reproducibility claims", () => {
		expect(MANAGED_WHATSAPP_OPENCLAW_UPSTREAM).toEqual({
			version: "2026.7.1",
			commit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
		});
		expect(MANAGED_WHATSAPP_HERMES_UPSTREAM).toEqual({
			version: "0.19.1",
			commit: "f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1",
		});
		for (const runtime of ["openclaw", "hermes"] as const) {
			const readiness = managedWhatsAppAdapterReadiness(runtime);
			expect(managedWhatsAppAdapterCanActivate(runtime)).toBe(false);
			expect(readiness).toMatchObject({
				ready: false,
				installerArtifactsPinned: false,
				deploymentReproducible: false,
			});
			expect(readiness.blockers.join("\n")).toContain("installer URLs are mutable");
		}
		const openclawBlockers = managedWhatsAppAdapterReadiness("openclaw").blockers.join("\n");
		expect(openclawBlockers).toContain("outbound.types.ts:21-49");
		expect(openclawBlockers).toContain("message/types.ts:168-187");
		expect(openclawBlockers).toContain("message/types.ts:274-292");
		const hermesBlockers = managedWhatsAppAdapterReadiness("hermes").blockers.join("\n");
		expect(hermesBlockers).toContain("gateway/platforms/base.py:3476-3495");
		expect(hermesBlockers).toContain("5023-5080");
	});

	test("builds deterministic complete local assets with no provider transport material", () => {
		for (const runtime of ["openclaw", "hermes"] as const) {
			const first = buildManagedWhatsAppAdapterBundle(runtime, cliRoot);
			const second = buildManagedWhatsAppAdapterBundle(runtime, cliRoot);
			expect(first).toEqual(second);
			expect(first.pluginId).toBe("clawdi-whatsapp");
			expect(first.channelId).toBe("whatsapp");
			expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
			const source = first.assets
				.map((asset) => asset.content)
				.join("\n")
				.toLowerCase();
			for (const forbidden of [
				["graph", "facebook"].join("."),
				"wa_websocket_url",
				"hermes_wa_creds_json",
				"whatsapp_baileys_auth_state",
				"@openclaw/whatsapp",
				"signal credential",
			]) {
				expect(source).not.toContain(forbidden);
			}
		}
		const openclaw = buildManagedWhatsAppAdapterBundle("openclaw", cliRoot);
		expect(openclaw.assets.map((asset) => asset.path).sort()).toEqual([
			"api.js",
			"channel-plugin-api.js",
			"index.js",
			"openclaw.plugin.json",
			"package.json",
			"plugin.js",
			"relay-client.js",
		]);
		const manifest = JSON.parse(
			openclaw.assets.find((asset) => asset.path === "openclaw.plugin.json")?.content ?? "{}",
		);
		expect(manifest).toMatchObject({ id: "clawdi-whatsapp", channels: ["whatsapp"] });
		const pluginSource = openclaw.assets.find((asset) => asset.path === "plugin.js")?.content ?? "";
		expect(pluginSource).toContain("maxProperties: 1");
		expect(pluginSource).toContain('defaultAckPolicy: "after_agent_dispatch"');
		expect(pluginSource).toContain("actions: messageActions");
		expect(pluginSource).toContain("sendTyping:");
		expect(pluginSource).toContain("clearTyping:");
		expect(pluginSource).toContain('read: "OpenClaw read action fetches message history');
		expect(pluginSource).toContain('"set-presence": "OpenClaw set-presence is targetless');
		expect(pluginSource).toContain("reply: true");
		expect(pluginSource).toContain("reactions: true");
		expect(pluginSource).toContain("edit: true");
		expect(pluginSource).toContain("unsend: true");
		expect(pluginSource).toContain("arbitraryOutboundBlocker");
		expect(pluginSource).toContain("buildMarkReadOperation");
		expect(pluginSource).toContain("has no public PTT field for inbound agent media");
		expect(pluginSource).not.toContain("deliveryQueueId");
		expect(pluginSource).not.toContain("durableFinal");

		const hermes = buildManagedWhatsAppAdapterBundle("hermes", cliRoot);
		expect(hermes.assets.map((asset) => asset.path).sort()).toEqual([
			"__init__.py",
			"adapter.py",
			"plugin.yaml",
		]);
		const adapterSource = hermes.assets.find((asset) => asset.path === "adapter.py")?.content ?? "";
		expect(adapterSource).toContain("class ClawdiWhatsAppAdapter(BasePlatformAdapter)");
		expect(adapterSource).toContain('name="whatsapp"');
		expect(adapterSource).toContain("ctx.register_platform(");
		expect(adapterSource).toContain("async def connect(self, *, is_reconnect=False):");
		expect(adapterSource).toContain("async def on_processing_complete(self, event, outcome):");
		expect(adapterSource).toContain("await self.handle_message(event)");
		expect(adapterSource).toContain('"type": "mark_read"');
		expect(adapterSource).toContain("WhatsApp media payload exceeds 8 MiB");
		expect(adapterSource).not.toContain("uuid.uuid4");
		expect(adapterSource).not.toContain("._session");
	});

	test("builds one-account default-profile projections with relay auth only", () => {
		const projection = buildManagedWhatsAppAdapterProjection({
			accountId: "account-1",
			accountKey: "default",
			relayUrl: "https://relay.test/root/",
			linkTokenSecretRef: "secret://channels/whatsapp/default/agent-token",
		});
		expect(projection.openclaw.channel).toEqual({
			enabled: true,
			defaultAccount: "default",
			accounts: { default: { enabled: true } },
		});
		expect(projection.openclaw.plugins.entries).toEqual({
			whatsapp: { enabled: false },
			"clawdi-whatsapp": { enabled: true },
		});
		expect(Object.keys(projection.openclaw.plugins.entries)).toEqual([
			"whatsapp",
			"clawdi-whatsapp",
		]);
		expect(projection.hermes.plugins.enabled).toEqual(["clawdi-whatsapp"]);
		expect(projection.hermes.platforms).toEqual({
			whatsapp: { enabled: true, extra: { managed_by: "clawdi" } },
		});
		for (const runtimeProjection of [projection.openclaw, projection.hermes]) {
			expect(runtimeProjection.env).toEqual({
				CLAWDI_WHATSAPP_RELAY_URL: "https://relay.test/root",
				CLAWDI_WHATSAPP_ACCOUNT_ID: "account-1",
			});
			expect(runtimeProjection.secretEnv).toEqual({
				CLAWDI_WHATSAPP_LINK_TOKEN: "secret://channels/whatsapp/default/agent-token",
			});
		}
		expect(() =>
			buildManagedWhatsAppAdapterProjection({
				accountId: "account-1",
				accountKey: "default",
				relayUrl: "https://relay.test/root?credential=forbidden",
				linkTokenSecretRef: "secret://channels/whatsapp/default/agent-token",
			}),
		).toThrow("query");
	});

	test("enables only the managed Hermes plugin and preserves unrelated plugin choices", () => {
		const enabled = parseYaml(
			renderHermesManagedPlugin(
				"plugins:\n  enabled: [user-plugin]\n  disabled: [clawdi-whatsapp, blocked-plugin]\n",
				"clawdi-whatsapp",
				true,
			),
		) as { plugins: { enabled: string[]; disabled: string[] } };
		expect(enabled.plugins.enabled).toEqual(["clawdi-whatsapp", "user-plugin"]);
		expect(enabled.plugins.disabled).toEqual(["blocked-plugin"]);

		const removed = parseYaml(
			renderHermesManagedPlugin(
				"plugins:\n  enabled: [clawdi-whatsapp, user-plugin]\n  disabled: [blocked-plugin]\n",
				"clawdi-whatsapp",
				false,
			),
		) as { plugins: { enabled: string[]; disabled: string[] } };
		expect(removed.plugins.enabled).toEqual(["user-plugin"]);
		expect(removed.plugins.disabled).toEqual(["blocked-plugin"]);
	});

	test("loads the OpenClaw plugin against the fixed 0790 public export surface", () => {
		const root = tempRoot();
		const home = join(root, "home");
		const target = reconcileManagedWhatsAppAdapterBundle({
			home,
			runtime: "openclaw",
			desired: buildManagedWhatsAppAdapterBundle("openclaw", cliRoot),
		});
		expect(target).not.toBeNull();
		const packageRoot = join(root, "node_modules", "openclaw");
		mkdirSync(packageRoot, { recursive: true });
		const fixedExports: Record<string, Record<string, string>> = {
			"channel-core": {
				buildChannelOutboundSessionRoute: "(value) => value",
				createChatChannelPlugin: "(value) => value",
			},
			"channel-actions": {
				jsonResult: "(value) => value",
				readStringParam:
					"(params, key, options = {}) => params?.[key] ?? (options.required ? (() => { throw new Error(options.label ?? key); })() : undefined)",
				resolveReactionMessageId: "({ args }) => args?.messageId",
			},
			"channel-config-schema": { buildJsonChannelConfigSchema: "(value) => value" },
			"channel-ingress-runtime": {
				resolveStableChannelMessageIngress: "async () => ({ ingress: { admission: 'dispatch' } })",
			},
			"inbound-envelope": {
				resolveInboundRouteEnvelopeBuilderWithRuntime:
					"() => ({ route: { agentId: 'main', sessionKey: 'session', accountId: 'default' }, buildEnvelope: ({ body }) => ({ body, storePath: '/tmp/store' }) })",
			},
			"agent-media-payload": { buildAgentMediaPayload: "() => ({})" },
			"media-store": {
				saveMediaBuffer: "async () => ({ path: '/tmp/media', contentType: 'image/png' })",
			},
			"outbound-media": {
				loadOutboundMediaFromUrl:
					"async (value) => ({ buffer: Buffer.from(value), contentType: value.endsWith('.ogg') ? 'audio/ogg' : 'application/pdf', kind: value.endsWith('.ogg') ? 'audio' : 'document', fileName: value.split('/').at(-1) })",
			},
			"channel-outbound": {
				createDurableInboundReceiveJournalFromQueue: "() => ({ pending: async () => [] })",
				defineChannelMessageAdapter: "(value) => value",
			},
			"channel-plugin-common": { getChatChannelMeta: "(id) => ({ id })" },
			"status-helpers": {
				createComputedAccountStatusAdapter: "(value) => value",
				createDefaultChannelRuntimeState: "(accountId) => ({ accountId })",
			},
			"runtime-store": {
				createPluginRuntimeStore:
					"() => { let runtime; return { setRuntime: (value) => { runtime = value; }, getRuntime: () => runtime }; }",
			},
			"channel-entry-contract": { defineBundledChannelEntry: "(value) => value" },
		};
		const exportsMap: Record<string, { default: string }> = {};
		for (const [subpath, symbols] of Object.entries(fixedExports)) {
			const path = `${subpath}.js`;
			exportsMap[`./plugin-sdk/${subpath}`] = { default: `./${path}` };
			writeFileSync(
				join(packageRoot, path),
				`${Object.entries(symbols)
					.map(([name, implementation]) => `export const ${name} = ${implementation};`)
					.join("\n")}\n`,
			);
		}
		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify({ name: "openclaw", version: "2026.7.1", type: "module", exports: exportsMap })}\n`,
		);
		const probe = `
import { pathToFileURL } from "node:url";
const root = pathToFileURL(process.argv[1]);
const channel = await import(new URL("./channel-plugin-api.js", root));
const api = await import(new URL("./api.js", root));
const entry = await import(new URL("./index.js", root));
const plugin = await import(new URL("./plugin.js", root));
const relay = await import(new URL("./relay-client.js", root));
if (channel.whatsappPlugin?.base?.id !== "whatsapp") throw new Error("channel did not load");
if (typeof api.setWhatsAppRuntime !== "function") throw new Error("runtime store did not load");
if (entry.default?.id !== "clawdi-whatsapp") throw new Error("entry did not load");
Object.assign(process.env, {
  CLAWDI_WHATSAPP_RELAY_URL: "https://relay.test",
  CLAWDI_WHATSAPP_ACCOUNT_ID: "account-1",
  CLAWDI_WHATSAPP_LINK_TOKEN: "link-token",
});
const actionAdapter = channel.whatsappPlugin.base.actions;
const actionConfig = { channels: { whatsapp: { enabled: true, defaultAccount: "default", accounts: { default: { enabled: true } } } } };
const discovery = actionAdapter.describeMessageTool({ cfg: actionConfig, accountId: "default" });
const expectedActions = ["reply", "react", "edit", "delete", "unsend"];
if (JSON.stringify(discovery.actions) !== JSON.stringify(expectedActions)) throw new Error("actions were not discovered");
if (JSON.stringify(discovery.schema.actions) !== JSON.stringify(expectedActions)) throw new Error("action schema scope drifted");
const idempotencySchema = discovery.schema.properties.idempotencyKey;
if (idempotencySchema.minLength !== 1 || idempotencySchema.maxLength !== 200 || idempotencySchema.pattern !== "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$") throw new Error("idempotency schema drifted");
if (!new RegExp(idempotencySchema.pattern).test("action.retry-1") || new RegExp(idempotencySchema.pattern).test("invalid key")) throw new Error("idempotency schema validation drifted");
const actionOperations = [];
globalThis.fetch = async (_url, init) => {
  const operation = JSON.parse(init.body);
  actionOperations.push(operation);
  return new Response(JSON.stringify({ status: "completed", operationId: operation.operationId }), { status: 200, headers: { "content-type": "application/json" } });
};
const repeatedAction = {
  action: "delete",
  cfg: actionConfig,
  accountId: "default",
  params: { to: "group:binding-1/chat-1", messageId: "message-1", idempotencyKey: "action.retry-1" },
};
await actionAdapter.handleAction(repeatedAction);
await actionAdapter.handleAction(repeatedAction);
if (actionOperations.length !== 2 || actionOperations.some((operation) => operation.operationId !== "action.retry-1")) throw new Error("action retry did not reuse the supplied idempotency key");
const unsupportedEvent = relay.normalizeInboxEvent({
  id: "event-unsupported",
  binding: { id: "binding-1" },
  chat: { id: "chat-1", type: "direct" },
  sender: { id: "user-1" },
  message: { id: "message-unsupported", text: "", timestamp: 1, media: [], unsupported: { providerContentType: "contactMessage" } },
});
if (plugin.bodyForEvent(unsupportedEvent) !== "[Unsupported WhatsApp content: contactMessage]") throw new Error("unsupported content was rendered as blank");
let inboundVoiceDenied = false;
try {
  plugin.assertInboundMediaSupported({ message: { media: [{ ptt: true }] } });
} catch (error) {
  inboundVoiceDenied = String(error).includes("no public PTT field");
}
if (!inboundVoiceDenied) throw new Error("inbound voice was silently mapped to ordinary audio");
const operations = [];
let sequence = 0;
await plugin.deliverInboundReplyPayload({
  client: { submitOperation: async (operation) => { operations.push(operation); return { operationId: operation.operationId, messageId: "message-" + operations.length }; } },
  event: { id: "event-1", message: { id: "inbound-message-1" } },
  target: "group:binding-1/chat-1",
  payload: { text: "caption", mediaUrls: ["https://safe.test/file.pdf", "/tmp/generated.pdf"] },
  relayUrl: "https://relay.test",
  accountId: "account-1",
  nextOperationId: () => "inbound:event-1:reply:" + (++sequence),
});
await plugin.deliverInboundReplyPayload({
  client: { submitOperation: async (operation) => { operations.push(operation); return { operationId: operation.operationId, messageId: "message-" + operations.length }; } },
  event: { id: "event-1", message: { id: "inbound-message-1" } },
  target: "group:binding-1/chat-1",
  payload: { mediaUrl: "https://relay.test/v1/channels/whatsapp/application/account-1/media/voice-1", audioAsVoice: true },
  relayUrl: "https://relay.test",
  accountId: "account-1",
  nextOperationId: () => "inbound:event-1:reply:" + (++sequence),
});
let inlineVoiceDenied = false;
try {
  await plugin.deliverInboundReplyPayload({
    client: { submitOperation: async (operation) => { operations.push(operation); return { operationId: operation.operationId, messageId: "unexpected" }; } },
    event: { id: "event-1", message: { id: "inbound-message-1" } },
    target: "group:binding-1/chat-1",
    payload: { mediaUrl: "/tmp/voice.ogg", audioAsVoice: true },
    relayUrl: "https://relay.test",
    accountId: "account-1",
    nextOperationId: () => "inbound:event-1:reply:" + (++sequence),
  });
} catch (error) {
  inlineVoiceDenied = String(error).includes("inline voice is unavailable");
}
if (!inlineVoiceDenied) throw new Error("inline voice was not rejected");
if (operations.length !== 3) throw new Error("contextual media replies were not delivered");
if (operations[0].operationId !== "inbound:event-1:reply:1" || operations[0].text !== "caption") throw new Error("first media reply identity is invalid");
if ("text" in operations[1] || operations[1].operationId !== "inbound:event-1:reply:2") throw new Error("multi-media reply mapping is invalid");
const allowedInlineKeys = ["contentBase64", "fileName", "kind"];
for (const operation of operations.slice(0, 2)) {
  if (JSON.stringify(Object.keys(operation.media).sort()) !== JSON.stringify(allowedInlineKeys)) throw new Error("inline media violated the extra-forbid schema");
}
if (JSON.stringify(operations[2].media) !== JSON.stringify({ relayUrl: "https://relay.test/v1/channels/whatsapp/application/account-1/media/voice-1" })) throw new Error("relay voice source is invalid");
`;
		const result = spawnSync("node", ["--input-type=module", "-e", probe, `${target}/`], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: home },
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	test("Hermes connect accepts the fixed keyword-only reconnect contract and fails closed without relay config", () => {
		const root = tempRoot();
		const script = `
import asyncio
import importlib.util
import sys
import types

gateway = types.ModuleType("gateway")
config = types.ModuleType("gateway.config")
platforms = types.ModuleType("gateway.platforms")
base = types.ModuleType("gateway.platforms.base")
httpx = types.ModuleType("httpx")

class Platform:
    WHATSAPP = "whatsapp"

class BasePlatformAdapter:
    def __init__(self, *, config, platform):
        self.config = config
        self.platform = platform

    async def on_processing_start(self, event):
        return None

    async def on_processing_complete(self, event, outcome):
        return None

class MessageType:
    TEXT = "text"
    VOICE = "voice"

class ProcessingOutcome:
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"

class MessageEvent:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

class SendResult:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

config.Platform = Platform
base.BasePlatformAdapter = BasePlatformAdapter
base.MessageEvent = MessageEvent
base.MessageType = MessageType
base.ProcessingOutcome = ProcessingOutcome
base.SendResult = SendResult
base.cache_media_bytes = lambda *args, **kwargs: None
sys.modules.update({
    "gateway": gateway,
    "gateway.config": config,
    "gateway.platforms": platforms,
    "gateway.platforms.base": base,
    "httpx": httpx,
})

spec = importlib.util.spec_from_file_location("clawdi_whatsapp_adapter", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
adapter = module.ClawdiWhatsAppAdapter(object())
assert asyncio.run(adapter.connect(is_reconnect=True)) is False
`;
		const result = spawnSync(
			"python3",
			["-c", script, join(cliRoot, "runtime-adapters", "whatsapp", "hermes", "adapter.py")],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: join(root, "home"),
					PYTHONDONTWRITEBYTECODE: "1",
				},
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	test("Hermes completion hook journals before dispatch and retries completed read-plus-ACK without redispatch", () => {
		const root = tempRoot();
		const script = `
import asyncio
import importlib.util
import json
import os
import sys
import types
from enum import Enum

gateway = types.ModuleType("gateway")
config = types.ModuleType("gateway.config")
platforms = types.ModuleType("gateway.platforms")
base = types.ModuleType("gateway.platforms.base")
httpx = types.ModuleType("httpx")

class Platform:
    WHATSAPP = "whatsapp"

class MessageType:
    TEXT = "text"
    VOICE = "voice"

class ProcessingOutcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"

class MessageEvent:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

class SendResult:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

class BasePlatformAdapter:
    def __init__(self, *, config, platform):
        self.config = config
        self.platform = platform
        self.dispatched = []

    def build_source(self, **kwargs):
        return types.SimpleNamespace(**kwargs)

    async def handle_message(self, event):
        self.dispatched.append(event)

    async def on_processing_start(self, event):
        return None

    async def on_processing_complete(self, event, outcome):
        return None

    def validate_media_delivery_path(self, value):
        return value

class Timeout:
    def __init__(self, value):
        self.value = value

class UnusedAsyncClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

config.Platform = Platform
base.BasePlatformAdapter = BasePlatformAdapter
base.MessageEvent = MessageEvent
base.MessageType = MessageType
base.ProcessingOutcome = ProcessingOutcome
base.SendResult = SendResult
base.cache_media_bytes = lambda *args, **kwargs: None
httpx.Timeout = Timeout
httpx.AsyncClient = UnusedAsyncClient
sys.modules.update({
    "gateway": gateway,
    "gateway.config": config,
    "gateway.platforms": platforms,
    "gateway.platforms.base": base,
    "httpx": httpx,
})

spec = importlib.util.spec_from_file_location("clawdi_whatsapp_adapter", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Response:
    def __init__(self, value):
        self.value = value
        self.status_code = 200
        self.headers = {}

    def raise_for_status(self):
        return None

    def json(self):
        return self.value

class FakeClient:
    def __init__(self):
        self.calls = []
        self.fail_send_once = False
        self.fail_mark_read_once = False
        self.ambiguous_send_once = False

    async def request(self, method, url, **kwargs):
        body = kwargs.get("json")
        if url.endswith("/operations"):
            self.calls.append(body)
            if body["type"] == "send_text" and self.fail_send_once:
                self.fail_send_once = False
                raise RuntimeError("unknown send outcome")
            if body["type"] == "send_text" and self.ambiguous_send_once:
                self.ambiguous_send_once = False
                return Response({"operationId": body["operationId"], "status": "failed"})
            if body["type"] == "mark_read" and self.fail_mark_read_once:
                self.fail_mark_read_once = False
                return Response({"operationId": body["operationId"], "status": "ambiguous"})
            value = {"operationId": body["operationId"], "status": "completed"}
            if body["type"] in {"send_text", "send_media", "edit_message"}:
                value["messageId"] = "relay-message-1"
            return Response(value)
        if url.endswith("/ack"):
            self.calls.append({"type": "ack", "url": url})
            return Response({})
        raise AssertionError(url)

def relay_event(event_id, message_id):
    return {
        "id": event_id,
        "binding": {"id": "binding-1"},
        "chat": {"id": "chat-1", "type": "group", "name": "Test group"},
        "sender": {"id": "user-1", "name": "User"},
        "message": {
            "id": message_id,
            "text": "hello",
            "timestamp": 1,
            "replyTo": "previous-1",
            "media": [],
        },
    }

class Config:
    extra = {}

async def main():
    adapter = module.ClawdiWhatsAppAdapter(Config())
    client = FakeClient()
    adapter._client = client

    blocked = await adapter.send("group:binding-1/chat-1", "outside inbound")
    assert blocked.success is False
    assert "durable_outbound_unavailable" in blocked.error
    assert client.calls == []

    first = relay_event("event-1", "message-1")
    assert await adapter._accept_and_dispatch(first) == "dispatched"
    first_event = adapter.dispatched[-1]
    assert first_event.source.chat_id == "group:binding-1/chat-1"
    assert first_event.source.user_id == "user-1"
    assert first_event.reply_to_message_id == "previous-1"
    assert adapter.journal.records["event-1"]["status"] == "pending"
    assert client.calls == []

    await adapter.on_processing_start(first_event)
    client.fail_send_once = True
    failed = await adapter.send(first_event.source.chat_id, "agent reply", reply_to="message-1")
    retried = await adapter.send(first_event.source.chat_id, "agent reply", reply_to="message-1")
    assert failed.success is False and failed.retryable is True
    assert retried.success is True
    send_calls = [call for call in client.calls if call.get("type") == "send_text"]
    assert [call["operationId"] for call in send_calls] == [
        "inbound:event-1:send:1",
        "inbound:event-1:send:1",
    ]
    client.ambiguous_send_once = True
    ambiguous = await adapter.send(first_event.source.chat_id, "ambiguous reply")
    recovered = await adapter.send(first_event.source.chat_id, "ambiguous reply")
    assert ambiguous.success is False and ambiguous.retryable is True
    assert "not completed" in ambiguous.error
    assert recovered.success is True
    ambiguous_calls = [
        call for call in client.calls
        if call.get("text") == "ambiguous reply"
    ]
    assert [call["operationId"] for call in ambiguous_calls] == [
        "inbound:event-1:send:2",
        "inbound:event-1:send:2",
    ]

    await adapter.on_processing_complete(first_event, ProcessingOutcome.SUCCESS)
    assert adapter.journal.records["event-1"]["status"] == "acknowledged"
    assert client.calls[-2]["type"] == "mark_read"
    assert client.calls[-2]["operationId"] == "inbound:event-1:mark-read"
    assert client.calls[-2]["messageId"] == "message-1"
    assert client.calls[-1]["type"] == "ack"
    blocked_after_completion = await adapter.send(first_event.source.chat_id, "outside inbound")
    assert blocked_after_completion.success is False
    assert "durable_outbound_unavailable" in blocked_after_completion.error

    dispatched_before_redelivery = len(adapter.dispatched)
    assert await adapter._accept_and_dispatch(first) == "acknowledged"
    assert len(adapter.dispatched) == dispatched_before_redelivery
    assert client.calls[-1]["type"] == "ack"

    removed_reaction = relay_event("event-reaction-remove", "message-reaction-remove")
    removed_reaction["message"]["reaction"] = {"messageId": "reacted-message", "emoji": ""}
    removed_event = await adapter._message_event(removed_reaction)
    assert removed_event.text == "[Reaction removed from reacted-message]"

    unsupported = relay_event("event-unsupported", "message-unsupported")
    unsupported["message"]["text"] = ""
    unsupported["message"]["unsupported"] = {"providerContentType": "contactMessage"}
    unsupported_event = await adapter._message_event(unsupported)
    assert unsupported_event.text == "[Unsupported WhatsApp content: contactMessage]"
    assert "providerContentType" not in json.dumps(unsupported_event.raw_message)

    unsupported_null = relay_event("event-unsupported-null", "message-unsupported-null")
    unsupported_null["message"]["unsupported"] = None
    assert (await adapter._message_event(unsupported_null)).text == "hello"
    for invalid_unsupported in [
        {"providerContentType": "contactMessage", "rawPayload": "forbidden"},
        {"providerContentType": "x" * 81},
    ]:
        invalid = relay_event("event-invalid-unsupported", "message-invalid-unsupported")
        invalid["message"]["unsupported"] = invalid_unsupported
        try:
            await adapter._message_event(invalid)
            raise AssertionError("invalid unsupported content was accepted")
        except ValueError as exc:
            assert "unsupported" in str(exc)

    voice_event = relay_event("event-voice", "message-voice")
    voice_event["message"]["media"] = [{
        "url": "http://127.0.0.1:18080/root/v1/channels/whatsapp/application/account-1/media/voice-1",
        "mimeType": "audio/ogg",
        "ptt": True,
    }]
    original_download_media = adapter._download_media
    original_cache_media_bytes = module.cache_media_bytes
    async def fake_download_media(value):
        return b"voice", "audio/ogg"
    adapter._download_media = fake_download_media
    module.cache_media_bytes = lambda *args, **kwargs: types.SimpleNamespace(
        path="/tmp/voice.ogg", media_type="audio/ogg"
    )
    try:
        normalized_voice = await adapter._message_event(voice_event)
    finally:
        adapter._download_media = original_download_media
        module.cache_media_bytes = original_cache_media_bytes
    assert normalized_voice.message_type == MessageType.VOICE

    media_path = os.path.join(os.environ["HOME"], "reply.ogg")
    with open(media_path, "wb") as handle:
        handle.write(b"voice-reply")
    await adapter.on_processing_start(first_event)
    sent_document = await adapter.send_document(
        first_event.source.chat_id,
        media_path,
        caption="document caption",
        file_name="reply.ogg",
        reply_to="message-1",
    )
    assert sent_document.success is True
    document_call = client.calls[-1]
    assert document_call["type"] == "send_media"
    assert set(document_call["media"]) == {"contentBase64", "kind", "fileName"}
    assert document_call["media"]["kind"] == "document"
    assert document_call["media"]["fileName"] == "reply.ogg"
    assert "mimeType" not in document_call["media"]
    assert "ptt" not in document_call["media"]

    calls_before_inline_voice = len(client.calls)
    denied_voice = await adapter.send_voice(
        first_event.source.chat_id,
        media_path,
        caption="voice caption",
        reply_to="message-1",
    )
    assert denied_voice.success is False
    assert "inline voice is unavailable" in denied_voice.error
    assert len(client.calls) == calls_before_inline_voice

    relay_voice_url = (
        "http://127.0.0.1:18080/root/v1/channels/whatsapp/application/"
        "account-1/media/voice-1"
    )
    sent_voice = await adapter.send_voice(
        first_event.source.chat_id,
        relay_voice_url,
        caption="voice caption",
        reply_to="message-1",
    )
    assert sent_voice.success is True
    voice_call = client.calls[-1]
    assert voice_call["type"] == "send_media"
    assert voice_call["media"] == {"relayUrl": relay_voice_url}
    assert "mimeType" not in voice_call["media"]
    assert "ptt" not in voice_call["media"]
    assert voice_call["text"] == "voice caption"
    assert voice_call["replyTo"] == "message-1"

    allowed_media_keys = {"relayUrl", "contentBase64", "kind", "fileName"}
    for call in client.calls:
        if call.get("type") == "send_media":
            assert set(call["media"]) <= allowed_media_keys

    second = relay_event("event-2", "message-2")
    await adapter._accept_and_dispatch(second)
    second_event = adapter.dispatched[-1]
    client.fail_mark_read_once = True
    await adapter.on_processing_complete(second_event, ProcessingOutcome.SUCCESS)
    assert adapter.journal.records["event-2"]["status"] == "completed"
    first_mark = [
        call for call in client.calls
        if call.get("operationId") == "inbound:event-2:mark-read"
    ]
    assert len(first_mark) == 1

    dispatched_before_sweep = len(adapter.dispatched)
    async def empty_inbox(cursor=None):
        if adapter.journal.records["event-2"]["status"] == "acknowledged":
            adapter._stop_event.set()
        return [], cursor
    adapter._list_inbox = empty_inbox
    await asyncio.wait_for(adapter._poll_loop(), timeout=2)
    assert adapter.journal.records["event-2"]["status"] == "acknowledged"
    assert len(adapter.dispatched) == dispatched_before_sweep
    event_two_marks = [
        call for call in client.calls
        if call.get("operationId") == "inbound:event-2:mark-read"
    ]
    assert len(event_two_marks) == 2

    restart_event = relay_event("event-restart", "message-restart")
    await adapter._accept_and_dispatch(restart_event)
    restart_message_event = adapter.dispatched[-1]
    client.fail_mark_read_once = True
    await adapter.on_processing_complete(restart_message_event, ProcessingOutcome.SUCCESS)
    assert adapter.journal.records["event-restart"]["status"] == "completed"

    restarted = module.ClawdiWhatsAppAdapter(Config())
    restarted_client = FakeClient()
    restarted._client = restarted_client
    await restarted._replay_journal()
    assert restarted.dispatched == []
    assert restarted.journal.records["event-restart"]["status"] == "acknowledged"
    assert [call.get("operationId") for call in restarted_client.calls[:-1]] == [
        "inbound:event-restart:mark-read"
    ]
    assert restarted_client.calls[-1]["type"] == "ack"

    third = relay_event("event-3", "message-3")
    await restarted._accept_and_dispatch(third)
    third_event = restarted.dispatched[-1]
    before = len(restarted.dispatched)
    await restarted.on_processing_complete(third_event, ProcessingOutcome.FAILURE)
    assert restarted.journal.records["event-3"]["status"] == "pending"
    assert restarted.journal.records["event-3"]["retryCount"] == 1
    assert (
        restarted.journal.records["event-3"]["retryAfter"]
        > restarted.journal.records["event-3"]["releasedAt"]
    )
    await restarted._replay_journal()
    assert len(restarted.dispatched) == before
    restarted.journal.records["event-3"]["retryAfter"] = 0
    async def poll_until_failure_retry(cursor=None):
        if len(restarted.dispatched) == before + 1:
            restarted._stop_event.set()
        return [], cursor
    restarted._list_inbox = poll_until_failure_retry
    restarted._stop_event.clear()
    await asyncio.wait_for(restarted._poll_loop(), timeout=2)
    assert len(restarted.dispatched) == before + 1
    await restarted._replay_journal()
    assert len(restarted.dispatched) == before + 1

    fourth = relay_event("event-4", "message-4")
    await restarted._accept_and_dispatch(fourth)
    fourth_event = restarted.dispatched[-1]
    before = len(restarted.dispatched)
    await restarted.on_processing_complete(fourth_event, ProcessingOutcome.CANCELLED)
    assert restarted.journal.records["event-4"]["status"] == "pending"
    assert restarted.journal.records["event-4"]["retryCount"] == 1
    await restarted._replay_journal()
    assert len(restarted.dispatched) == before
    restarted.journal.records["event-4"]["retryAfter"] = 0
    async def poll_until_cancel_retry(cursor=None):
        if len(restarted.dispatched) == before + 1:
            restarted._stop_event.set()
        return [], cursor
    restarted._list_inbox = poll_until_cancel_retry
    restarted._stop_event.clear()
    await asyncio.wait_for(restarted._poll_loop(), timeout=2)
    assert len(restarted.dispatched) == before + 1
    await restarted._replay_journal()
    assert len(restarted.dispatched) == before + 1
    assert all(
        call.get("operationId") not in {
            "inbound:event-3:mark-read",
            "inbound:event-4:mark-read",
        }
        for call in restarted_client.calls
    )

    replay = module.DurableInboxJournal(os.path.join(os.environ["HOME"], "ordered.json"))
    replay.records = {
        "event-b": {"status": "pending", "receivedAt": 2, "payload": second},
        "event-c": {"status": "completed", "receivedAt": 1, "payload": third},
        "event-a": {"status": "pending", "receivedAt": 2, "payload": first},
    }
    assert [event_id for event_id, _ in replay.replay_records()] == [
        "event-c", "event-a", "event-b"
    ]

    bounded = module.DurableInboxJournal(os.path.join(os.environ["HOME"], "bounded.json"))
    bounded.records = {
        f"pending-{index}": {"status": "pending", "receivedAt": index, "payload": first}
        for index in range(500)
    }
    try:
        bounded.accept(relay_event("overflow", "message-overflow"))
        raise AssertionError("pending capacity did not fail closed")
    except RuntimeError as exc:
        assert "pending capacity is exhausted" in str(exc)
    assert "overflow" not in bounded.records

    bounded_completed = module.DurableInboxJournal(
        os.path.join(os.environ["HOME"], "bounded-completed.json")
    )
    bounded_completed.records = {
        **{
            f"completed-{index}": {
                "status": "completed",
                "receivedAt": index,
                "payload": first,
            }
            for index in range(500)
        },
        "current": {"status": "pending", "receivedAt": 501, "payload": first},
    }
    try:
        bounded_completed.complete("current")
        raise AssertionError("completed capacity did not fail closed")
    except RuntimeError as exc:
        assert "completed capacity is exhausted" in str(exc)
    assert bounded_completed.records["current"]["status"] == "pending"

    bounded_acknowledged = module.DurableInboxJournal(
        os.path.join(os.environ["HOME"], "bounded-acknowledged.json")
    )
    bounded_acknowledged.records = {
        **{
            f"ack-{index}": {
                "status": "acknowledged",
                "acknowledgedAt": index,
                "receivedAt": index,
                "payload": first,
            }
            for index in range(500)
        },
        "new-ack": {"status": "completed", "receivedAt": 501, "payload": first},
    }
    bounded_acknowledged.acknowledge("new-ack")
    acknowledged_ids = {
        event_id
        for event_id, record in bounded_acknowledged.records.items()
        if record["status"] == "acknowledged"
    }
    assert len(acknowledged_ids) == 500
    assert "ack-0" not in acknowledged_ids
    assert "ack-1" in acknowledged_ids
    assert "new-ack" in acknowledged_ids

    bounded_backoff = module.DurableInboxJournal(
        os.path.join(os.environ["HOME"], "bounded-backoff.json")
    )
    bounded_backoff.accept(relay_event("backoff", "message-backoff"))
    original_time = module.time.time
    module.time.time = lambda: 1000
    try:
        retry_delays = []
        for _ in range(8):
            bounded_backoff.release("backoff", "failure")
            record = bounded_backoff.records["backoff"]
            retry_delays.append(record["retryAfter"] - record["releasedAt"])
    finally:
        module.time.time = original_time
    assert retry_delays == [250, 500, 1000, 2000, 4000, 8000, 10000, 10000]

    fsync_calls = []
    original_fsync = module.os.fsync
    module.os.fsync = lambda descriptor: fsync_calls.append(descriptor)
    try:
        durable = module.DurableInboxJournal(os.path.join(os.environ["HOME"], "durable.json"))
        durable.accept(relay_event("durable", "message-durable"))
    finally:
        module.os.fsync = original_fsync
    assert len(fsync_calls) == 2

    registry = {"whatsapp": "builtin"}
    class Context:
        def register_platform(self, **kwargs):
            registry[kwargs["name"]] = kwargs
    module.register(Context())
    assert registry["whatsapp"]["label"] == "WhatsApp (Clawdi managed)"

asyncio.run(main())
`;
		const result = spawnSync(
			"python3",
			["-c", script, join(cliRoot, "runtime-adapters", "whatsapp", "hermes", "adapter.py")],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: join(root, "home"),
					HERMES_HOME: join(root, "home", ".hermes"),
					CLAWDI_WHATSAPP_RELAY_URL: "http://127.0.0.1:18080/root",
					CLAWDI_WHATSAPP_ACCOUNT_ID: "account-1",
					CLAWDI_WHATSAPP_LINK_TOKEN: "link-token",
					PYTHONDONTWRITEBYTECODE: "1",
				},
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	test("reconciles revisioned assets atomically and removes managed state only", () => {
		const root = tempRoot();
		const home = join(root, "home");
		const bundle = buildManagedWhatsAppAdapterBundle("openclaw", cliRoot);
		const target = managedWhatsAppAdapterTargetDir(home, "openclaw");
		expect(managedWhatsAppAdapterMutationTargets(home)).toEqual([
			target,
			managedWhatsAppAdapterTargetDir(home, "hermes"),
		]);

		expect(
			reconcileManagedWhatsAppAdapterBundle({ home, runtime: "openclaw", desired: bundle }),
		).toBe(target);
		const markerPath = join(target, ".clawdi-managed-adapter.json");
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		expect(marker).toMatchObject({
			schemaVersion: "clawdi.managedWhatsAppAdapterReceipt.v1",
			pluginId: "clawdi-whatsapp",
			channelId: "whatsapp",
			currentRevision: bundle.revision,
		});
		if (process.platform !== "win32") expect(statSync(markerPath).mode & 0o777).toBe(0o600);
		writeFileSync(join(target, "stale-managed.js"), "stale\n");
		writeFileSync(join(target, "plugin.js"), "damaged\n");
		reconcileManagedWhatsAppAdapterBundle({ home, runtime: "openclaw", desired: bundle });
		expect(existsSync(join(target, "stale-managed.js"))).toBe(false);
		expect(readFileSync(join(target, "plugin.js"), "utf8")).toBe(
			bundle.assets.find((asset) => asset.path === "plugin.js")?.content,
		);
		reconcileManagedWhatsAppAdapterBundle({ home, runtime: "openclaw", desired: null });
		expect(existsSync(target)).toBe(false);

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "user-owned.js"), "keep\n");
		reconcileManagedWhatsAppAdapterBundle({ home, runtime: "openclaw", desired: null });
		expect(readFileSync(join(target, "user-owned.js"), "utf8")).toBe("keep\n");
		expect(() =>
			reconcileManagedWhatsAppAdapterBundle({ home, runtime: "openclaw", desired: bundle }),
		).toThrow("refusing to overwrite unmanaged");
	});

	test("keeps the false gate free of custom assets and preserves unrelated stock paths", () => {
		const root = tempRoot();
		const home = join(root, "home");
		const stockOpenClaw = join(home, ".openclaw", "extensions", "whatsapp");
		const stockHermes = join(home, ".hermes", "plugins", "whatsapp");
		mkdirSync(stockOpenClaw, { recursive: true });
		mkdirSync(stockHermes, { recursive: true });
		writeFileSync(join(stockOpenClaw, "user-owned.js"), "keep\n");
		writeFileSync(join(stockHermes, "user-owned.py"), "keep\n");

		for (const runtime of ["openclaw", "hermes"] as const) {
			expect(managedWhatsAppAdapterCanActivate(runtime)).toBe(false);
			expect(reconcileManagedWhatsAppAdapterBundle({ home, runtime, desired: null })).toBeNull();
			expect(existsSync(managedWhatsAppAdapterTargetDir(home, runtime))).toBe(false);
		}
		expect(readFileSync(join(stockOpenClaw, "user-owned.js"), "utf8")).toBe("keep\n");
		expect(readFileSync(join(stockHermes, "user-owned.py"), "utf8")).toBe("keep\n");
	});

	test("refuses default-profile adapter writes through symlinks", () => {
		if (process.platform === "win32") return;
		const root = tempRoot();
		const home = join(root, "home");
		const outside = join(root, "outside");
		mkdirSync(join(home, ".openclaw"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(home, ".openclaw", "extensions"), "dir");
		expect(() =>
			reconcileManagedWhatsAppAdapterBundle({
				home,
				runtime: "openclaw",
				desired: buildManagedWhatsAppAdapterBundle("openclaw", cliRoot),
			}),
		).toThrow("symlinked path");
	});
});

describe("OpenClaw managed WhatsApp relay contract", () => {
	const event = {
		id: "event-1",
		bindingId: "binding-1",
		chat: { id: "chat-1", type: "direct" },
		sender: { id: "user-1" },
		message: { id: "message-1", text: "hello", timestamp: 1, media: [] },
	};

	test("normalizes an empty reaction emoji as explicit removal", () => {
		const normalized = normalizeInboxEvent({
			id: "event-reaction-remove",
			binding: { id: "binding-1" },
			chat: { id: "chat-1", type: "direct" },
			sender: { id: "user-1" },
			message: {
				id: "message-reaction-remove",
				timestamp: 1,
				media: [],
				reaction: { messageId: "reacted-message", emoji: "" },
			},
		});
		expect(normalized.message.reaction).toEqual({
			messageId: "reacted-message",
			emoji: "",
			remove: true,
		});
	});

	test("normalizes bounded unsupported content without provider raw payload", () => {
		const rawEvent = (unsupported?: unknown) => ({
			id: "event-unsupported",
			binding: { id: "binding-1" },
			chat: { id: "chat-1", type: "direct" },
			sender: { id: "user-1" },
			message: {
				id: "message-unsupported",
				text: "",
				timestamp: 1,
				media: [],
				...(unsupported === undefined ? {} : { unsupported }),
			},
		});
		const normalized = normalizeInboxEvent(rawEvent({ providerContentType: "contactMessage" }));
		expect(normalized.message.unsupported).toEqual({ providerContentType: "contactMessage" });
		expect(JSON.stringify(normalized)).not.toContain("rawPayload");
		expect(normalizeInboxEvent(rawEvent()).message.unsupported).toBeUndefined();
		expect(normalizeInboxEvent(rawEvent(null)).message.unsupported).toBeUndefined();
		for (const unsupported of [
			{ providerContentType: "contactMessage", rawPayload: "forbidden" },
			{ providerContentType: "x".repeat(81) },
			{ providerContentType: "" },
		]) {
			expect(() => normalizeInboxEvent(rawEvent(unsupported))).toThrow("unsupported");
		}
	});

	test("completes durable dispatch before ACK", async () => {
		const calls: string[] = [];
		const journal = {
			accept: async () => ({ kind: "accepted", record: { payload: event } }),
			complete: async () => calls.push("complete"),
			release: async () => calls.push("release"),
		};
		const client = { acknowledge: async () => calls.push("ack") };
		const result = await processDurableInboxEvent({
			journal,
			client,
			event,
			dispatch: async () => calls.push("dispatch"),
			finalize: async () => calls.push("mark-read"),
		});
		expect(result).toBe("completed");
		expect(calls).toEqual(["dispatch", "complete", "mark-read", "ack"]);
	});

	test("releases dispatch failures without ACK", async () => {
		const calls: string[] = [];
		const journal = {
			accept: async () => ({ kind: "accepted", record: { payload: event } }),
			complete: async () => calls.push("complete"),
			release: async () => calls.push("release"),
		};
		const client = { acknowledge: async () => calls.push("ack") };
		await expect(
			processDurableInboxEvent({
				journal,
				client,
				event,
				dispatch: async () => {
					calls.push("dispatch");
					throw new Error("dispatch failed");
				},
			}),
		).rejects.toThrow("dispatch failed");
		expect(calls).toEqual(["dispatch", "release"]);
	});

	test("retries a released pending dispatch in the same process", async () => {
		let attempts = 0;
		let completed = false;
		const journal = {
			accept: async () => ({ kind: "pending", record: { payload: event } }),
			complete: async () => {
				completed = true;
			},
			release: async () => true,
		};
		const result = await processDurableInboxEvent({
			journal,
			client: { acknowledge: async () => undefined },
			event,
			dispatch: async () => {
				attempts += 1;
			},
			inflight: new Set(),
		});
		expect(result).toBe("completed");
		expect(attempts).toBe(1);
		expect(completed).toBe(true);
	});

	test("retries a failed ACK from the completed tombstone without redispatch", async () => {
		let completed = false;
		let dispatches = 0;
		let acknowledgements = 0;
		let finalizations = 0;
		let releases = 0;
		const journal = {
			accept: async () =>
				completed
					? { kind: "completed", record: { id: event.id } }
					: { kind: "accepted", record: { payload: event } },
			complete: async () => {
				completed = true;
			},
			release: async () => {
				releases += 1;
			},
		};
		const client = {
			acknowledge: async () => {
				acknowledgements += 1;
				if (acknowledgements === 1) throw new Error("relay unavailable");
			},
		};
		const dispatch = async () => {
			dispatches += 1;
		};
		const finalize = async () => {
			finalizations += 1;
		};
		await expect(
			processDurableInboxEvent({ journal, client, event, dispatch, finalize }),
		).rejects.toThrow("relay unavailable");
		expect(completed).toBe(true);
		expect(releases).toBe(0);
		expect(await processDurableInboxEvent({ journal, client, event, dispatch, finalize })).toBe(
			"already_completed",
		);
		expect(dispatches).toBe(1);
		expect(finalizations).toBe(2);
		expect(acknowledgements).toBe(2);
	});

	test("keeps a completed tombstone when automatic read outcome is ambiguous", async () => {
		let completed = false;
		let dispatches = 0;
		let acknowledgements = 0;
		let readAttempts = 0;
		const journal = {
			accept: async () =>
				completed
					? { kind: "completed", record: { id: event.id } }
					: { kind: "accepted", record: { payload: event } },
			complete: async () => {
				completed = true;
			},
			release: async () => undefined,
		};
		const client = {
			acknowledge: async () => {
				acknowledgements += 1;
			},
		};
		const dispatch = async () => {
			dispatches += 1;
		};
		const finalize = async () => {
			readAttempts += 1;
			if (readAttempts === 1) throw new Error("unknown mark_read outcome");
		};

		await expect(
			processDurableInboxEvent({ journal, client, event, dispatch, finalize }),
		).rejects.toThrow("unknown mark_read outcome");
		expect(completed).toBe(true);
		expect(dispatches).toBe(1);
		expect(acknowledgements).toBe(0);
		expect(await processDurableInboxEvent({ journal, client, event, dispatch, finalize })).toBe(
			"already_completed",
		);
		expect(dispatches).toBe(1);
		expect(readAttempts).toBe(2);
		expect(acknowledgements).toBe(1);
	});

	test("does not dispatch or ACK a concurrently pending duplicate", async () => {
		let dispatches = 0;
		let acknowledgements = 0;
		const result = await processDurableInboxEvent({
			journal: {
				accept: async () => ({ kind: "pending", record: { payload: event } }),
			},
			client: {
				acknowledge: async () => {
					acknowledgements += 1;
				},
			},
			event,
			inflight: new Set([event.id]),
			dispatch: async () => {
				dispatches += 1;
			},
		});
		expect(result).toBe("already_pending");
		expect(dispatches).toBe(0);
		expect(acknowledgements).toBe(0);
	});

	test("maps stable text, reply, and media operations and denies arbitrary remote media", async () => {
		const common = {
			target: "group:binding-1/chat-1",
			relayUrl: "https://relay.test",
			accountId: "account-1",
		};
		expect(
			await buildSendOperation({
				...common,
				text: "hello",
				replyTo: "message-0",
				operationId: "operation-1",
			}),
		).toEqual({
			operationId: "operation-1",
			type: "send_text",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			text: "hello",
			replyTo: "message-0",
		});
		const relayVoiceUrl =
			"https://relay.test/v1/channels/whatsapp/application/account-1/media/media-1";
		expect(
			await buildSendOperation({
				...common,
				mediaUrl: relayVoiceUrl,
				audioAsVoice: true,
				operationId: "operation-2",
			}),
		).toEqual({
			operationId: "operation-2",
			type: "send_media",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			media: { relayUrl: relayVoiceUrl },
		});
		const inlineMedia = await buildSendOperation({
			...common,
			mediaUrl: "/tmp/generated.pdf",
			mediaReadFile: async () => ({
				buffer: Buffer.from("document"),
				contentType: "application/pdf",
				kind: "document",
				fileName: "generated.pdf",
			}),
			operationId: "operation-3",
		});
		expect(inlineMedia.media).toEqual({
			contentBase64: Buffer.from("document").toString("base64"),
			kind: "document",
			fileName: "generated.pdf",
		});
		expect(Object.keys(inlineMedia.media).sort()).toEqual(["contentBase64", "fileName", "kind"]);
		expect(inlineMedia.media).not.toHaveProperty("mimeType");
		expect(inlineMedia.media).not.toHaveProperty("ptt");
		await expect(
			buildSendOperation({
				...common,
				mediaUrl: "/tmp/voice.ogg",
				mediaReadFile: async () => ({
					buffer: Buffer.from("voice"),
					contentType: "audio/ogg",
					kind: "audio",
				}),
				audioAsVoice: true,
				operationId: "operation-4",
			}),
		).rejects.toThrow("inline voice is unavailable");
		await expect(
			buildSendOperation({
				...common,
				mediaUrl: "https://remote.test/file.jpg",
				operationId: "operation-5",
			}),
		).rejects.toThrow("requires OpenClaw's validated outbound media loader");
		await expect(
			buildSendOperation({
				...common,
				mediaUrl:
					"https://user:password@relay.test/v1/channels/whatsapp/application/account-1/media/file",
				operationId: "operation-6",
			}),
		).rejects.toThrow("outside the authorized Clawdi relay path");
		await expect(
			buildSendOperation({
				...common,
				text: "durable without an identity",
			}),
		).rejects.toThrow("invalid operation ID");
		for (const operationId of ["invalid key", `a${"b".repeat(200)}`]) {
			await expect(
				buildSendOperation({ ...common, text: "invalid identity", operationId }),
			).rejects.toThrow("invalid operation ID");
		}
		await expect(
			buildSendOperation({
				...common,
				mediaUrl:
					"https://relay.test/v1/channels/whatsapp/application/account-1/media/file?token=forbidden",
				operationId: "operation-7",
			}),
		).rejects.toThrow("outside the authorized Clawdi relay path");
	});

	test("maps every binding-aware public action and denies unsupported action names", () => {
		const common = {
			target: "group:binding-1/chat-1",
			messageId: "message-1",
			operationId: "stable-action-1",
		};
		expect(buildActionOperation({ ...common, action: "reply", text: "hello" })).toEqual({
			operationId: "stable-action-1",
			type: "send_text",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			text: "hello",
			replyTo: "message-1",
		});
		const reactionRemoval = buildActionOperation({
			...common,
			action: "react",
			emoji: "👍",
			remove: true,
		});
		expect(reactionRemoval).toEqual({
			operationId: "stable-action-1",
			type: "reaction",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			messageId: "message-1",
			emoji: "",
		});
		expect(reactionRemoval).not.toHaveProperty("remove");
		expect(buildActionOperation({ ...common, action: "edit", text: "updated" })).toMatchObject({
			type: "edit_message",
			messageId: "message-1",
			text: "updated",
		});
		for (const action of ["delete", "unsend"]) {
			expect(buildActionOperation({ ...common, action })).toMatchObject({
				type: "delete_message",
				messageId: "message-1",
			});
		}
		expect(
			buildTypingOperation({
				target: common.target,
				active: true,
				operationId: "ephemeral-typing-1",
			}),
		).toEqual({
			operationId: "ephemeral-typing-1",
			type: "typing",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			active: true,
		});
		expect(
			buildMarkReadOperation({
				target: common.target,
				messageId: "message-1",
				eventId: "event-1",
			}),
		).toEqual({
			operationId: "inbound:event-1:mark-read",
			type: "mark_read",
			target: { bindingId: "binding-1", chatId: "chat-1", chatType: "group" },
			messageId: "message-1",
		});
		expect(() => buildActionOperation({ ...common, action: "read" })).toThrow(
			"Unsupported Clawdi WhatsApp action: read",
		);
		expect(() => buildActionOperation({ ...common, action: "set-presence" })).toThrow(
			"Unsupported Clawdi WhatsApp action: set-presence",
		);
	});

	test("downloads inbound media with relay bearer auth, no redirects, and a byte bound", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const mediaUrl = "https://relay.test/v1/channels/whatsapp/application/account-1/media/media-1";
		const client = createRelayClient({
			relayUrl: "https://relay.test",
			accountId: "account-1",
			linkToken: "link-token",
			fetchImpl: async (url: URL, init: RequestInit) => {
				calls.push({ url: url.toString(), init });
				return new Response("media-bytes", {
					status: 200,
					headers: { "content-type": "image/png", "content-length": "11" },
				});
			},
		});
		expect(await client.downloadMedia(mediaUrl)).toMatchObject({ contentType: "image/png" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(mediaUrl);
		expect(calls[0]?.init.redirect).toBe("manual");
		expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer link-token" });

		await expect(client.downloadMedia(`${mediaUrl}?token=forbidden`)).rejects.toThrow(
			"outside the authorized Clawdi relay path",
		);
		const redirecting = createRelayClient({
			relayUrl: "https://relay.test",
			accountId: "account-1",
			linkToken: "link-token",
			fetchImpl: async () => new Response(null, { status: 302, headers: { location: mediaUrl } }),
		});
		await expect(redirecting.downloadMedia(mediaUrl)).rejects.toThrow("refused a redirect");
		const oversized = createRelayClient({
			relayUrl: "https://relay.test",
			accountId: "account-1",
			linkToken: "link-token",
			fetchImpl: async () =>
				new Response("x", {
					status: 200,
					headers: { "content-length": String(MAX_MEDIA_BYTES + 1) },
				}),
		});
		await expect(oversized.downloadMedia(mediaUrl)).rejects.toThrow("exceeds 8 MiB");
	});

	test("accepts only completed relay operation outcomes", async () => {
		const operation = buildMarkReadOperation({
			target: "direct:binding-1/chat-1",
			messageId: "message-1",
			eventId: "event-1",
		});
		for (const status of [undefined, "failed", "ambiguous"]) {
			const client = createRelayClient({
				relayUrl: "https://relay.test",
				accountId: "account-1",
				linkToken: "link-token",
				fetchImpl: async () =>
					new Response(
						JSON.stringify({ operationId: operation.operationId, ...(status ? { status } : {}) }),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			});
			await expect(client.submitOperation(operation)).rejects.toThrow("outcome is not completed");
		}
		const completed = createRelayClient({
			relayUrl: "https://relay.test",
			accountId: "account-1",
			linkToken: "link-token",
			fetchImpl: async () =>
				new Response(JSON.stringify({ status: "completed", operationId: operation.operationId }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		expect(await completed.submitOperation(operation)).toEqual({
			operationId: "inbound:event-1:mark-read",
			messageId: undefined,
		});
	});

	test("retries polling with abortable backoff", async () => {
		const controller = new AbortController();
		let attempts = 0;
		await runInboxLoop({
			client: {
				listInbox: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("temporary failure");
					controller.abort();
					return { events: [], cursor: "cursor-1" };
				},
			},
			signal: controller.signal,
			dispatch: async () => undefined,
			initialRetryMs: 1,
		});
		expect(attempts).toBe(2);
	});
});
