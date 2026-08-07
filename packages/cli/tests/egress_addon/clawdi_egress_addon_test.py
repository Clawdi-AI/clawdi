from __future__ import annotations

import importlib.util
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ADDON_PATH = (
    Path(__file__).resolve().parents[2]
    / "egress-addon"
    / "clawdi_egress_addon.py"
)
SPEC = importlib.util.spec_from_file_location("clawdi_egress_addon", ADDON_PATH)
assert SPEC and SPEC.loader
addon = importlib.util.module_from_spec(SPEC)
sys.modules["clawdi_egress_addon"] = addon
SPEC.loader.exec_module(addon)


class Headers(dict):
    def get(self, name, default=""):
        for key, value in self.items():
            if key.lower() == name.lower():
                return value
        return default

    def __setitem__(self, name, value):
        existing = next((key for key in self if key.lower() == name.lower()), name)
        super().__setitem__(existing, value)


class Flow:
    def __init__(
        self,
        *,
        scheme="https",
        host="service.test",
        pretty_host=None,
        path="/v1/messages",
        headers=None,
    ):
        self.request = SimpleNamespace(
            scheme=scheme,
            host=host,
            pretty_host=pretty_host or host,
            port=443 if scheme in {"https", "wss"} else 80,
            path=path,
            url=f"{scheme}://{host}{path}",
            headers=Headers(headers or {}),
            stream=False,
        )
        self.response = None


def write_json(root: Path, name: str, value: object) -> Path:
    path = root / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def bundle(profiles):
    return {
        "schemaVersion": "clawdi.egressProfiles.v1",
        "generatedAt": "2026-07-08T00:00:00Z",
        "generation": 1,
        "instanceId": "iid_test",
        "profiles": profiles,
    }


class AddonProfileInterpreterTest(unittest.TestCase):
    def test_generic_engine_source_contains_no_channel_product_constants(self):
        source = ADDON_PATH.read_text(encoding="utf-8").lower()

        for product_constant in (
            "telegram",
            "discord",
            "whatsapp",
            "api.telegram.org",
            "discord.com",
            "web.whatsapp.com",
            "x-clawdi-whatsapp",
        ):
            self.assertNotIn(product_constant, source)

    def test_channel_placeholder_profiles_share_the_generic_matcher_and_rewriter(self):
        marker_header = "x-clawdi-whatsapp-link-capability"
        profiles = [
            {
                "id": "managed-telegram-path-placeholder",
                "enabled": True,
                "kind": "http",
                "match": {
                    "scheme": "https",
                    "host": "api.telegram.org",
                    "path": {
                        "type": "secretRefPrefix",
                        "secretRef": "secret://telegram/placeholder",
                        "prefix": "/bot",
                        "suffix": "/",
                    },
                },
                "rewrite": {
                    "upstreamBaseUrl": "https://relay.test/v1/channels/telegram",
                    "preservePath": True,
                    "setHeaders": {
                        "authorization": {
                            "type": "secretRef",
                            "secretRef": "secret://telegram/link-bearer",
                            "prefix": "Bearer ",
                        }
                    },
                },
                "priority": 10,
            },
            {
                "id": "managed-discord-header-placeholder",
                "enabled": True,
                "kind": "http",
                "match": {
                    "scheme": "https",
                    "host": "discord.com",
                    "pathPrefix": "/api/",
                    "headers": {
                        "authorization": {
                            "type": "secretRefEquals",
                            "secretRef": "secret://discord/placeholder",
                            "prefix": "Bot ",
                        }
                    },
                },
                "rewrite": {
                    "upstreamBaseUrl": "https://relay.test/v1/channels/discord",
                    "preservePath": True,
                    "setHeaders": {
                        "authorization": {
                            "type": "secretRef",
                            "secretRef": "secret://discord/link-bearer",
                            "prefix": "Bearer ",
                        }
                    },
                },
                "priority": 10,
            },
            {
                "id": "managed-whatsapp-marker",
                "enabled": True,
                "kind": "websocket",
                "match": {
                    "scheme": "wss",
                    "host": "web.whatsapp.com",
                    "path": {"type": "equals", "value": "/ws/chat"},
                    "headers": {
                        marker_header: {
                            "type": "secretRefEquals",
                            "secretRef": "secret://whatsapp/marker",
                        }
                    },
                },
                "rewrite": {
                    "upstreamBaseUrl": "wss://relay.test/v1/channels/whatsapp/baileys",
                    "preservePath": False,
                    "removeHeaders": [marker_header],
                    "setHeaders": {
                        "authorization": {
                            "type": "secretRef",
                            "secretRef": "secret://whatsapp/link-bearer",
                            "prefix": "Bearer ",
                        }
                    },
                },
                "priority": 10,
            },
        ]
        egress = self.load(
            profiles,
            {
                "secret://telegram/placeholder": "999999999:placeholder",
                "secret://telegram/link-bearer": "telegram-link",
                "secret://discord/placeholder": "discord-placeholder",
                "secret://discord/link-bearer": "discord-link",
                "secret://whatsapp/marker": "managed-marker",
                "secret://whatsapp/link-bearer": "whatsapp-link",
            },
        )
        cases = (
            (
                Flow(host="api.telegram.org", path="/bot999999999:placeholder/sendMessage"),
                "managed-telegram-path-placeholder",
                "telegram-link",
            ),
            (
                Flow(
                    host="discord.com",
                    path="/api/v10/channels/1/messages",
                    headers={"authorization": "Bot discord-placeholder"},
                ),
                "managed-discord-header-placeholder",
                "discord-link",
            ),
            (
                Flow(
                    host="web.whatsapp.com",
                    path="/ws/chat",
                    headers={"upgrade": "websocket", marker_header: "managed-marker"},
                ),
                "managed-whatsapp-marker",
                "whatsapp-link",
            ),
        )

        for flow, profile_id, link_bearer in cases:
            with self.subTest(profile_id=profile_id):
                decision = egress.apply_to_flow(flow)
                self.assertEqual(decision.profile_id, profile_id)
                self.assertEqual(flow.request.host, "relay.test")
                self.assertEqual(flow.request.headers["authorization"], f"Bearer {link_bearer}")

        self.assertNotIn(marker_header, cases[2][0].request.headers)

    def test_addon_loads_when_executed_as_a_script_path(self):
        loaded = runpy.run_path(str(ADDON_PATH))

        self.assertIn("addons", loaded)
        self.assertEqual(len(loaded["addons"]), 1)

    def test_secret_ref_prefix_matcher_is_shared_by_headers_and_query(self):
        egress = self.load(
            [
                {
                    "id": "generic-prefix-identity",
                    "enabled": True,
                    "kind": "http",
                    "match": {
                        "scheme": "https",
                        "host": "provider.test",
                        "headers": {
                            "authorization": {
                                "type": "secretRefPrefix",
                                "secretRef": "secret://placeholder",
                                "prefix": "Bearer ",
                                "suffix": ".",
                            }
                        },
                        "query": {
                            "identity": {
                                "type": "secretRefPrefix",
                                "secretRef": "secret://placeholder",
                            }
                        },
                    },
                    "rewrite": {"upstreamBaseUrl": "https://relay.test/provider"},
                    "priority": 10,
                }
            ],
            {"secret://placeholder": "managed"},
        )

        matched = Flow(
            host="provider.test",
            path="/v1/messages?identity=managed.gateway",
            headers={"authorization": "Bearer managed.session"},
        )
        wrong_query = Flow(
            host="provider.test",
            path="/v1/messages?identity=user-owned",
            headers={"authorization": "Bearer managed.session"},
        )

        self.assertEqual(egress.apply_to_flow(matched).profile_id, "generic-prefix-identity")
        self.assertIsNone(egress.apply_to_flow(wrong_query).profile)

    def load(self, profiles, secrets=None):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        bundle_path = write_json(root, "profiles.json", bundle(profiles))
        secret_path = write_json(root, "secrets.json", secrets or {})
        egress = addon.ClawdiEgressAddon()
        egress.reload_from_environment(
            {
                "CLAWDI_EGRESS_PROFILE_BUNDLE": str(bundle_path),
                "CLAWDI_EGRESS_SECRET_FILE": str(secret_path),
            }
        )
        return egress

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def test_unprofiled_sni_and_request_default_allow(self):
        egress = self.load(
            [
                {
                    "id": "profiled-host",
                    "enabled": True,
                    "kind": "http",
                    "match": {"scheme": "https", "host": "profiled.test", "pathPrefix": "/api/"},
                    "rewrite": {"upstreamBaseUrl": "https://relay.test/base"},
                    "priority": 10,
                }
            ]
        )
        self.assertFalse(egress.should_intercept_sni("unmatched.test"))

        flow = Flow(host="unmatched.test", path="/anything")
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "unmatched.test")
        self.assertIsNone(flow.response)

    def test_enabled_profiles_require_all_referenced_secrets(self):
        with self.assertRaisesRegex(
            addon.ConfigError, "egress profile secrets are missing: secret://provider-key"
        ):
            self.load([self.managed_provider_profile()])

    def test_enabled_profiles_reject_empty_referenced_secrets(self):
        with self.assertRaisesRegex(
            addon.ConfigError, "egress profile secrets are missing: secret://provider-key"
        ):
            self.load(
                [self.managed_provider_profile()],
                {"secret://provider-key": ""},
            )

    def test_passthrough_only_profile_does_not_intercept_sni(self):
        egress = self.load(
            [
                {
                    "id": "gateway-passthrough",
                    "enabled": True,
                    "kind": "passthrough",
                    "match": {
                        "scheme": "wss",
                        "host": "gateway.discord.gg",
                        "pathPrefix": "/",
                    },
                    "priority": 10,
                },
                {
                    "id": "shared-host-managed",
                    "enabled": True,
                    "kind": "http",
                    "match": {
                        "scheme": "https",
                        "host": "discord.com",
                        "pathPrefix": "/api/",
                    },
                    "rewrite": {"upstreamBaseUrl": "https://relay.test/discord"},
                    "priority": 20,
                },
            ]
        )

        self.assertFalse(egress.should_intercept_sni("gateway.discord.gg"))
        self.assertTrue(egress.should_intercept_sni("discord.com"))

    def test_shared_host_unmatched_request_passes_original_upstream(self):
        egress = self.load(
            [
                {
                    "id": "placeholder-only",
                    "enabled": True,
                    "kind": "http",
                    "match": {
                        "scheme": "https",
                        "host": "shared.test",
                        "pathPrefix": "/managed/",
                        "headers": {"authorization": {"type": "secretRefEquals", "secretRef": "secret://placeholder", "prefix": "Bearer "}},
                    },
                    "rewrite": {"upstreamBaseUrl": "https://relay.test/managed"},
                    "priority": 10,
                }
            ],
            {"secret://placeholder": "placeholder-token"},
        )

        flow = Flow(
            host="shared.test",
            path="/managed/messages",
            headers={"Authorization": "Bearer user-real-token"},
        )
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "shared.test")
        self.assertEqual(flow.request.path, "/managed/messages")

    def managed_provider_profile(self):
        return {
            "id": "provider",
            "enabled": True,
            "kind": "provider",
            "match": {
                "scheme": "https",
                "host": "gateway.test",
                "headers": {
                    "authorization": {
                        "type": "equals",
                        "value": "clawdi-egress-placeholder",
                        "prefix": "Bearer ",
                    }
                },
            },
            "rewrite": {
                "setHeaders": {
                    "authorization": {
                        "type": "secretRef",
                        "secretRef": "secret://provider-key",
                        "prefix": "Bearer ",
                    }
                },
            },
            "logging": {"redactHeaders": ["authorization"], "redactUrlPatterns": []},
            "priority": 10,
        }

    def test_provider_profile_rewrites_only_the_managed_placeholder(self):
        egress = self.load(
            [self.managed_provider_profile()],
            {"secret://provider-key": "real-key"},
        )

        flow = Flow(
            host="gateway.test",
            path="/v1/responses",
            headers={"Authorization": "Bearer clawdi-egress-placeholder"},
        )
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "provider")
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertEqual(flow.request.path, "/v1/responses")
        self.assertEqual(flow.request.headers["Authorization"], "Bearer real-key")

    def test_provider_profile_does_not_rewrite_a_user_bearer_token(self):
        egress = self.load(
            [self.managed_provider_profile()],
            {"secret://provider-key": "real-key"},
        )
        flow = Flow(
            host="gateway.test",
            path="/v1/responses",
            headers={"Authorization": "Bearer sk-user-real-token"},
        )

        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertEqual(flow.request.headers["Authorization"], "Bearer sk-user-real-token")

    def test_provider_profile_does_not_inject_a_missing_authorization_header(self):
        egress = self.load(
            [self.managed_provider_profile()],
            {"secret://provider-key": "real-key"},
        )
        flow = Flow(host="gateway.test", path="/v1/responses")

        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertNotIn("authorization", flow.request.headers)

    def test_provider_profile_restores_transparent_authority_before_forwarding(self):
        egress = self.load(
            [
                {
                    "id": "provider",
                    "enabled": True,
                    "kind": "provider",
                    "match": {
                        "scheme": "https",
                        "host": "gateway.test",
                        "headers": {
                            "authorization": {
                                "type": "equals",
                                "value": "clawdi-egress-placeholder",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "rewrite": {
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://provider-key",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "logging": {"redactHeaders": ["authorization"], "redactUrlPatterns": []},
                    "priority": 10,
                }
            ],
            {"secret://provider-key": "real-key"},
        )

        flow = Flow(
            host="203.0.113.10",
            pretty_host="gateway.test",
            path="/v1/chat/completions",
            headers={
                "Host": "203.0.113.10",
                "Authorization": "Bearer clawdi-egress-placeholder",
            },
        )
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "provider")
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertEqual(flow.request.headers["Host"], "gateway.test")
        self.assertEqual(flow.request.headers["Authorization"], "Bearer real-key")

    def test_requestheaders_applies_provider_rewrite_before_streaming(self):
        egress = self.load(
            [
                {
                    "id": "provider",
                    "enabled": True,
                    "kind": "provider",
                    "match": {
                        "scheme": "https",
                        "host": "gateway.test",
                        "headers": {
                            "authorization": {
                                "type": "equals",
                                "value": "clawdi-egress-placeholder",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "rewrite": {
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://provider-key",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "logging": {"redactHeaders": ["authorization"], "redactUrlPatterns": []},
                    "priority": 10,
                }
            ],
            {"secret://provider-key": "real-key"},
        )
        flow = Flow(
            host="203.0.113.10",
            pretty_host="gateway.test",
            path="/v1/chat/completions",
            headers={
                "Host": "203.0.113.10",
                "Authorization": "Bearer clawdi-egress-placeholder",
            },
        )

        egress.requestheaders(flow)

        self.assertTrue(flow.request.stream)
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertEqual(flow.request.headers["Host"], "gateway.test")
        self.assertEqual(flow.request.headers["Authorization"], "Bearer real-key")
        self.assertTrue(flow.metadata["clawdi_egress_decision_applied"])

    def test_http_profile_rewrites_matching_placeholder_and_injects_secret(self):
        egress = self.load(
            [
                {
                    "id": "managed-http",
                    "enabled": True,
                    "kind": "http",
                    "match": {
                        "scheme": "https",
                        "host": "provider.test",
                        "path": {
                            "type": "secretRefPrefix",
                            "secretRef": "secret://placeholder",
                            "prefix": "/bot",
                        },
                    },
                    "rewrite": {
                        "upstreamBaseUrl": "https://control.test/v1/relay",
                        "preservePath": True,
                        "pathReplace": {
                            "type": "secretRefPrefix",
                            "secretRef": "secret://placeholder",
                            "replacementSecretRef": "secret://real-token",
                            "prefix": "/bot",
                            "suffix": "/",
                        },
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://control-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "logging": {
                        "redactHeaders": ["authorization"],
                        "redactUrlPatterns": ["/bot[^/]+"],
                    },
                    "priority": 10,
                }
            ],
            {
                "secret://placeholder": "placeholder-token",
                "secret://real-token": "real-agent-token",
                "secret://control-token": "control-token",
            },
        )

        flow = Flow(host="provider.test", path="/botplaceholder-token/send?x=1")
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "http")
        self.assertIsNotNone(decision.profile)
        self.assertEqual(flow.request.scheme, "https")
        self.assertEqual(flow.request.host, "control.test")
        self.assertEqual(flow.request.path, "/v1/relay/botreal-agent-token/send?x=1")
        self.assertEqual(flow.request.headers["host"], "control.test")
        self.assertEqual(flow.request.headers["authorization"], "Bearer control-token")
        redacted = addon.redact_url(
            "https://control.test/v1/relay/botreal-agent-token/send?x=1",
            decision.profile,
        )
        self.assertNotIn("real-agent-token", redacted)

    def test_provider_profile_with_explicit_port_matches_exact_origin(self):
        egress = self.load(
            [
                {
                    "id": "managed-mcp",
                    "enabled": True,
                    "kind": "provider",
                    "match": {
                        "scheme": "http",
                        "host": "cloud.test:18080",
                        "path": {"type": "equals", "value": "/v1/mcp/clawdi"},
                        "headers": {
                            "authorization": {
                                "type": "equals",
                                "value": "clawdi-egress-placeholder",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "rewrite": {
                        "preservePath": True,
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://clawdi/auth-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                }
            ],
            {"secret://clawdi/auth-token": "deployment-token"},
        )
        wrong_port = Flow(
            scheme="http",
            host="cloud.test",
            path="/v1/mcp/clawdi",
            headers={"authorization": "Bearer clawdi-egress-placeholder"},
        )
        wrong_port.request.port = 18081
        self.assertIsNone(egress.apply_to_flow(wrong_port).profile)
        self.assertEqual(
            wrong_port.request.headers["authorization"],
            "Bearer clawdi-egress-placeholder",
        )

        exact_origin = Flow(
            scheme="http",
            host="cloud.test",
            path="/v1/mcp/clawdi",
            headers={"authorization": "Bearer clawdi-egress-placeholder"},
        )
        exact_origin.request.port = 18080
        self.assertEqual(egress.apply_to_flow(exact_origin).profile_id, "managed-mcp")
        self.assertEqual(exact_origin.request.headers["authorization"], "Bearer deployment-token")

    def test_telegram_rewrite_keeps_non_secret_route_and_moves_credential_to_header(self):
        egress = self.load(
            [
                {
                    "id": "managed-telegram",
                    "enabled": True,
                    "kind": "http",
                    "match": {
                        "scheme": "https",
                        "host": "api.telegram.org",
                        "path": {
                            "type": "secretRefPrefix",
                            "secretRef": "secret://placeholder",
                            "prefix": "/bot",
                            "suffix": "/",
                        },
                    },
                    "rewrite": {
                        "upstreamBaseUrl": "https://cloud.test/v1/channels/telegram",
                        "preservePath": True,
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://agent-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "logging": {"redactHeaders": ["authorization"], "redactUrlPatterns": []},
                    "priority": 10,
                }
            ],
            {
                "secret://placeholder": "999999999:public-routing-id",
                "secret://agent-token": "123456789:real-agent-token",
            },
        )
        flow = Flow(
            host="api.telegram.org",
            path="/bot999999999:public-routing-id/sendMessage?chat_id=42",
        )

        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "http")
        self.assertEqual(
            flow.request.path,
            "/v1/channels/telegram/bot999999999:public-routing-id/sendMessage?chat_id=42",
        )
        self.assertNotIn("real-agent-token", flow.request.path)
        self.assertEqual(flow.request.headers["authorization"], "Bearer 123456789:real-agent-token")

    def test_websocket_profile_rewrites_upgrade_request(self):
        egress = self.load(
            [
                {
                    "id": "managed-websocket",
                    "enabled": True,
                    "kind": "websocket",
                    "match": {"scheme": "wss", "host": "socket.test", "pathPrefix": "/ws"},
                    "rewrite": {
                        "upstreamBaseUrl": "wss://relay.test/session",
                        "preservePath": False,
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://link-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "logging": {"redactHeaders": ["authorization"]},
                    "priority": 10,
                }
            ],
            {"secret://link-token": "link-secret"},
        )

        flow = Flow(
            scheme="https",
            host="socket.test",
            path="/ws/chat?v=10&encoding=json",
            headers={"Upgrade": "websocket"},
        )
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "websocket")
        self.assertEqual(flow.request.scheme, "https")
        self.assertEqual(flow.request.host, "relay.test")
        self.assertEqual(flow.request.path, "/session?v=10&encoding=json")
        self.assertEqual(flow.request.headers["Upgrade"], "websocket")
        self.assertEqual(flow.request.headers["authorization"], "Bearer link-secret")

        profile = egress.profiles[0]
        self.assertEqual(
            addon.redacted_headers(flow.request.headers, profile)["authorization"],
            "[redacted]",
        )
        messages = []
        original_info = addon.ctx.log.info
        addon.ctx.log.info = messages.append
        try:
            egress.log_decision(flow, decision)
        finally:
            addon.ctx.log.info = original_info
        self.assertNotIn("link-secret", "\n".join(messages))

    def test_whatsapp_upgrade_routes_only_managed_capability_and_preserves_ws_shape(self):
        capability_header = "x-clawdi-whatsapp-link-capability"
        valid_profile = {
            "id": "native-whatsapp-baileys-link-a",
            "enabled": True,
            "kind": "websocket",
            "match": {
                "scheme": "wss",
                "host": "web.whatsapp.com",
                "notAfter": "2099-08-01T00:00:00Z",
                "path": {"type": "equals", "value": "/ws/chat"},
                "headers": {
                    capability_header: {
                        "type": "secretRefEquals",
                        "secretRef": "secret://whatsapp/link-a/capability",
                    }
                },
            },
            "rewrite": {
                "upstreamBaseUrl": "wss://cloud.test/v1/channels/whatsapp/baileys",
                "preservePath": False,
                "removeHeaders": [capability_header],
                "setHeaders": {
                    "authorization": {
                        "type": "secretRef",
                        "secretRef": "secret://whatsapp/link-a/agent-token",
                        "prefix": "Bearer ",
                    }
                },
            },
            "logging": {
                "redactHeaders": [capability_header, "authorization"],
                "redactUrlPatterns": [],
            },
            "priority": 40,
        }
        deny_profile = {
            "id": "native-whatsapp-baileys-invalid-capability",
            "enabled": True,
            "kind": "deny",
            "match": {
                "host": "web.whatsapp.com",
                "headers": {capability_header: {"type": "exists"}},
            },
            "logging": {
                "redactHeaders": [capability_header],
                "redactUrlPatterns": [],
            },
            "priority": 49,
        }
        egress = self.load(
            [valid_profile, deny_profile],
            {
                "secret://whatsapp/link-a/capability": "capability-generation-2",
                "secret://whatsapp/link-a/agent-token": "agent-token-generation-2",
            },
        )

        user_owned = Flow(
            scheme="https",
            host="web.whatsapp.com",
            path="/ws/chat?ED=user-owned",
            headers={
                "Upgrade": "websocket",
                "Sec-WebSocket-Protocol": "chat",
            },
        )
        self.assertEqual(egress.apply_to_flow(user_owned).action, "allow")
        self.assertEqual(user_owned.request.host, "web.whatsapp.com")
        self.assertEqual(user_owned.request.path, "/ws/chat?ED=user-owned")
        self.assertNotIn("authorization", user_owned.request.headers)

        for reconnect in range(2):
            managed = Flow(
                scheme="https",
                host="web.whatsapp.com",
                path=f"/ws/chat?ED=managed-{reconnect}&foo=%2Fopaque",
                headers={
                    "Upgrade": "websocket",
                    "Sec-WebSocket-Protocol": "chat, binary",
                    capability_header: "capability-generation-2",
                    "X-Opaque": "unchanged",
                },
            )
            binary_messages = [b"\x00\xffnoise", b"\x01\x02signal"]
            managed.websocket = SimpleNamespace(messages=binary_messages)

            decision = egress.apply_to_flow(managed)

            self.assertEqual(decision.action, "websocket")
            self.assertEqual(managed.request.host, "cloud.test")
            self.assertEqual(
                managed.request.path,
                f"/v1/channels/whatsapp/baileys?ED=managed-{reconnect}&foo=%2Fopaque",
            )
            self.assertEqual(managed.request.headers["Upgrade"], "websocket")
            self.assertEqual(
                managed.request.headers["Sec-WebSocket-Protocol"], "chat, binary"
            )
            self.assertEqual(managed.request.headers["X-Opaque"], "unchanged")
            self.assertNotIn(capability_header, managed.request.headers)
            self.assertEqual(
                managed.request.headers["authorization"],
                "Bearer agent-token-generation-2",
            )
            self.assertIs(managed.websocket.messages, binary_messages)

        for invalid_capability in ["capability-generation-1", "wrong-link-capability"]:
            stale = Flow(
                scheme="https",
                host="web.whatsapp.com",
                path="/ws/chat?ED=stale",
                headers={
                    "Upgrade": "websocket",
                    capability_header: invalid_capability,
                },
            )
            decision = egress.apply_to_flow(stale)
            self.assertEqual(decision.action, "deny")
            self.assertEqual(stale.request.host, "web.whatsapp.com")
            self.assertIsNotNone(stale.response)

        misplaced = Flow(
            scheme="https",
            host="web.whatsapp.com",
            path="/not-the-baileys-endpoint",
            headers={
                "Upgrade": "websocket",
                capability_header: "capability-generation-2",
            },
        )
        self.assertEqual(egress.apply_to_flow(misplaced).action, "deny")
        self.assertIsNotNone(misplaced.response)

        misplaced_http = Flow(
            scheme="https",
            host="web.whatsapp.com",
            path="/media/fetch",
            headers={capability_header: "capability-generation-2"},
        )
        self.assertEqual(egress.apply_to_flow(misplaced_http).action, "deny")
        self.assertIsNotNone(misplaced_http.response)

        expired_profile = {
            **valid_profile,
            "match": {**valid_profile["match"], "notAfter": "2000-01-01T00:00:00Z"},
        }
        self.tmp.cleanup()
        expired_egress = self.load(
            [expired_profile, deny_profile],
            {
                "secret://whatsapp/link-a/capability": "capability-generation-2",
                "secret://whatsapp/link-a/agent-token": "agent-token-generation-2",
            },
        )
        expired = Flow(
            scheme="https",
            host="web.whatsapp.com",
            path="/ws/chat?ED=expired",
            headers={
                "Upgrade": "websocket",
                capability_header: "capability-generation-2",
            },
        )
        self.assertEqual(expired_egress.apply_to_flow(expired).action, "deny")

        redacted = addon.redacted_headers(
            Headers(
                {
                    capability_header: "capability-generation-2",
                    "authorization": "Bearer agent-token-generation-2",
                }
            ),
            valid_profile,
        )
        self.assertEqual(redacted[capability_header], "[redacted]")
        self.assertEqual(redacted["authorization"], "[redacted]")

    def test_deny_profile_sets_safe_response(self):
        egress = self.load(
            [
                {
                    "id": "deny",
                    "enabled": True,
                    "kind": "deny",
                    "match": {"scheme": "https", "host": "blocked.test", "pathPrefix": "/"},
                    "priority": 1,
                }
            ]
        )

        flow = Flow(host="blocked.test")
        decision = egress.apply_to_flow(flow)

        self.assertEqual(decision.action, "deny")
        self.assertEqual(flow.response["status_code"], 403)
        self.assertNotIn("blocked.test", flow.response["content"].decode())

    def test_redacts_configured_url_patterns(self):
        profile = {
            "logging": {
                "redactUrlPatterns": [r"token=[^&]+"],
            }
        }

        self.assertEqual(
            addon.redact_url("https://example.test/path?token=secret&x=1", profile),
            "https://example.test/path?[redacted]&x=1",
        )


if __name__ == "__main__":
    unittest.main()
