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
        method="POST",
    ):
        self.request = SimpleNamespace(
            scheme=scheme,
            host=host,
            pretty_host=pretty_host or host,
            port=443 if scheme in {"https", "wss"} else 80,
            path=path,
            url=f"{scheme}://{host}{path}",
            headers=Headers(headers or {}),
            method=method,
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
    def test_addon_loads_when_executed_as_a_script_path(self):
        loaded = runpy.run_path(str(ADDON_PATH))

        self.assertIn("addons", loaded)
        self.assertEqual(len(loaded["addons"]), 1)

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

    def test_whatsapp_application_rewrite_requires_exact_method_path_host_and_placeholder(self):
        path = "/v1/channels/whatsapp/application/clawdi_account/inbox"
        egress = self.load(
            [
                {
                    "id": "whatsapp-application-inbox",
                    "enabled": True,
                    "kind": "provider",
                    "match": {
                        "scheme": "https",
                        "method": "GET",
                        "host": "cloud.test",
                        "path": {"type": "equals", "value": path},
                        "headers": {
                            "authorization": {
                                "type": "secretRefEquals",
                                "secretRef": "secret://placeholder",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "rewrite": {
                        "preservePath": True,
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://link-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                }
            ],
            {
                "secret://placeholder": "deterministic-placeholder",
                "secret://link-token": "real-link-token",
            },
        )
        cases = [
            Flow(
                method="get",
                host="cloud.test",
                path=path,
                headers={"authorization": "Bearer deterministic-placeholder"},
            ),
            Flow(
                method="POST",
                host="cloud.test",
                path=path,
                headers={"authorization": "Bearer deterministic-placeholder"},
            ),
            Flow(
                method="GET",
                host="cloud.test",
                path=f"{path}/extra",
                headers={"authorization": "Bearer deterministic-placeholder"},
            ),
            Flow(
                method="GET",
                host="other.test",
                path=path,
                headers={"authorization": "Bearer deterministic-placeholder"},
            ),
            Flow(
                method="GET",
                host="cloud.test",
                path=path,
                headers={"authorization": "Bearer wrong-placeholder"},
            ),
        ]

        for flow in cases:
            decision = egress.apply_to_flow(flow)
            self.assertIsNone(decision.profile)
            self.assertNotEqual(flow.request.headers["authorization"], "Bearer real-link-token")

        exact = Flow(
            method="GET",
            host="cloud.test",
            path=path,
            headers={"authorization": "Bearer deterministic-placeholder"},
        )
        decision = egress.apply_to_flow(exact)
        self.assertEqual(decision.profile_id, "whatsapp-application-inbox")
        self.assertEqual(exact.request.headers["authorization"], "Bearer real-link-token")

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
