from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ADDON_PATH = (
    Path(__file__).resolve().parents[2]
    / "mitmproxy-addon"
    / "clawdi_mitm_addon.py"
)
SPEC = importlib.util.spec_from_file_location("clawdi_mitm_addon", ADDON_PATH)
assert SPEC and SPEC.loader
addon = importlib.util.module_from_spec(SPEC)
sys.modules["clawdi_mitm_addon"] = addon
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
        path="/v1/messages",
        headers=None,
    ):
        self.request = SimpleNamespace(
            scheme=scheme,
            host=host,
            pretty_host=host,
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
        "schemaVersion": "clawdi.mitmProfiles.v1",
        "generatedAt": "2026-07-08T00:00:00Z",
        "generation": 1,
        "instanceId": "iid_test",
        "profiles": profiles,
    }


class AddonProfileInterpreterTest(unittest.TestCase):
    def load(self, profiles, secrets=None):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        bundle_path = write_json(root, "profiles.json", bundle(profiles))
        secret_path = write_json(root, "secrets.json", secrets or {})
        mitm = addon.ClawdiMitmAddon()
        mitm.reload_from_environment(
            {
                "CLAWDI_MITM_PROFILE_BUNDLE": str(bundle_path),
                "CLAWDI_MITM_SECRET_FILE": str(secret_path),
            }
        )
        return mitm

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def test_unprofiled_sni_and_request_default_allow(self):
        mitm = self.load(
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
        self.assertFalse(mitm.should_intercept_sni("unmatched.test"))

        flow = Flow(host="unmatched.test", path="/anything")
        decision = mitm.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "unmatched.test")
        self.assertIsNone(flow.response)

    def test_shared_host_unmatched_request_passes_original_upstream(self):
        mitm = self.load(
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
        decision = mitm.apply_to_flow(flow)

        self.assertEqual(decision.action, "allow")
        self.assertEqual(flow.request.host, "shared.test")
        self.assertEqual(flow.request.path, "/managed/messages")

    def test_provider_profile_overwrites_authorization_without_host_rewrite(self):
        mitm = self.load(
            [
                {
                    "id": "provider",
                    "enabled": True,
                    "kind": "provider",
                    "match": {"scheme": "https", "host": "gateway.test", "pathPrefix": "/v1"},
                    "rewrite": {
                        "upstreamBaseUrl": "https://unused-upstream.test",
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
            host="gateway.test",
            path="/v1/responses",
            headers={"Authorization": "Bearer dummy"},
        )
        decision = mitm.apply_to_flow(flow)

        self.assertEqual(decision.action, "provider")
        self.assertEqual(flow.request.host, "gateway.test")
        self.assertEqual(flow.request.path, "/v1/responses")
        self.assertEqual(flow.request.headers["Authorization"], "Bearer real-key")

    def test_http_profile_rewrites_matching_placeholder_and_injects_secret(self):
        mitm = self.load(
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
                        "setHeaders": {
                            "authorization": {
                                "type": "secretRef",
                                "secretRef": "secret://control-token",
                                "prefix": "Bearer ",
                            }
                        },
                    },
                    "priority": 10,
                }
            ],
            {
                "secret://placeholder": "placeholder-token",
                "secret://control-token": "control-token",
            },
        )

        flow = Flow(host="provider.test", path="/botplaceholder-token/send?x=1")
        decision = mitm.apply_to_flow(flow)

        self.assertEqual(decision.action, "http")
        self.assertEqual(flow.request.scheme, "https")
        self.assertEqual(flow.request.host, "control.test")
        self.assertEqual(flow.request.path, "/v1/relay/botplaceholder-token/send?x=1")
        self.assertEqual(flow.request.headers["host"], "control.test")
        self.assertEqual(flow.request.headers["authorization"], "Bearer control-token")

    def test_websocket_profile_rewrites_upgrade_request(self):
        mitm = self.load(
            [
                {
                    "id": "managed-websocket",
                    "enabled": True,
                    "kind": "websocket",
                    "match": {"scheme": "wss", "host": "socket.test", "pathPrefix": "/ws"},
                    "rewrite": {"upstreamBaseUrl": "wss://relay.test/session"},
                    "priority": 10,
                }
            ]
        )

        flow = Flow(
            scheme="https",
            host="socket.test",
            path="/ws/chat",
            headers={"Upgrade": "websocket"},
        )
        decision = mitm.apply_to_flow(flow)

        self.assertEqual(decision.action, "websocket")
        self.assertEqual(flow.request.scheme, "https")
        self.assertEqual(flow.request.host, "relay.test")
        self.assertEqual(flow.request.path, "/session/ws/chat")

    def test_deny_profile_sets_safe_response(self):
        mitm = self.load(
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
        decision = mitm.apply_to_flow(flow)

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
