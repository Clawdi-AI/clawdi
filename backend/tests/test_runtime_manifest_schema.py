from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.admin import AdminRuntimeStateUpsert


def runtime_state(**overrides):
    body = {
        "deployment_id": "hdep_schema",
        "app_id": "app-schema",
        "instance_id": "hri_schema",
        "generation": 1,
        "provider_id": "clawdi-managed",
        "runtime_targets": {
            "openclaw-a": {
                "type": "openclaw",
                "enabled": True,
                "environmentId": "env-openclaw-a",
                "image": {
                    "ref": "ghcr.io/openclaw/openclaw:2026.6.11",
                    "repository": "ghcr.io/openclaw/openclaw",
                    "tag": "2026.6.11",
                    "pullPolicy": "IfNotPresent",
                },
                "version": {
                    "desired": "2026.6.11",
                    "observed": "OpenClaw 2026.6.11",
                    "observedAt": "2026-07-01T00:00:00Z",
                    "upgradeAvailable": False,
                    "upgradePolicy": "pinned",
                },
                "execution": {
                    "mode": "external",
                    "home": "/home/openclaw-a",
                    "stateDir": "/home/openclaw-a/.openclaw",
                    "workspace": "/workspace/openclaw-a",
                    "controlCommand": {
                        "command": "/usr/local/bin/agent-control",
                        "args": ["openclaw-a"],
                        "env": {},
                        "cwd": "/workspace/openclaw-a",
                    },
                    "terminal": {
                        "container": "openclaw-a",
                        "user": "node",
                        "cwd": "/workspace/openclaw-a",
                    },
                    "mcp": {
                        "source": "sidecar-local",
                        "url": "http://clawdi-sidecar:8788/mcp",
                        "transport": "streamable-http",
                    },
                },
            },
            "openclaw-b": {
                "type": "openclaw",
                "enabled": True,
                "environmentId": "env-openclaw-b",
                "execution": {
                    "mode": "external",
                    "home": "/home/openclaw-b",
                    "stateDir": "/home/openclaw-b/.openclaw",
                    "workspace": "/workspace/openclaw-b",
                    "terminal": {
                        "container": "openclaw-b",
                        "user": "node",
                        "cwd": "/workspace/openclaw-b",
                    },
                },
            },
            "hermes-a": {
                "type": "hermes",
                "enabled": True,
                "environmentId": "env-hermes-a",
                "execution": {
                    "mode": "external",
                    "home": "/home/hermes-a",
                    "stateDir": "/home/hermes-a",
                    "workspace": "/workspace/hermes-a",
                    "terminal": {
                        "container": "hermes-a",
                        "user": "hermes",
                        "cwd": "/workspace/hermes-a",
                    },
                },
            },
        },
        "live_sync": {
            "enabled": True,
            "agents": [
                {
                    "agentType": "openclaw",
                    "agentId": "openclaw-a",
                    "environmentId": "env-openclaw-a",
                }
            ],
        },
    }
    body.update(overrides)
    return body


def assert_rejected(body, message: str) -> None:
    with pytest.raises(ValidationError) as exc:
        AdminRuntimeStateUpsert.model_validate(body)
    assert message in str(exc.value)


def test_runtime_targets_accept_multiple_same_type_with_distinct_isolation():
    parsed = AdminRuntimeStateUpsert.model_validate(runtime_state())

    assert sorted(parsed.runtime_targets) == ["hermes-a", "openclaw-a", "openclaw-b"]
    assert parsed.runtime_targets["openclaw-a"]["image"]["tag"] == "2026.6.11"
    assert parsed.runtime_targets["openclaw-a"]["version"]["upgradePolicy"] == "pinned"


def test_runtime_targets_accept_target_scoped_provider_binding_fields():
    body = runtime_state()
    body["runtime_targets"]["openclaw-a"]["provider_id"] = "openai-managed"
    body["runtime_targets"]["openclaw-a"]["model"] = "gpt-5.5"
    body["runtime_targets"]["hermes-a"]["providerId"] = "anthropic-managed"
    body["runtime_targets"]["hermes-a"]["primary_model"] = "claude-opus-4-6"

    parsed = AdminRuntimeStateUpsert.model_validate(body)

    assert parsed.runtime_targets["openclaw-a"]["provider_id"] == "openai-managed"
    assert parsed.runtime_targets["openclaw-a"]["model"] == "gpt-5.5"
    assert parsed.runtime_targets["hermes-a"]["providerId"] == "anthropic-managed"
    assert parsed.runtime_targets["hermes-a"]["primary_model"] == "claude-opus-4-6"


def test_runtime_targets_reject_conflicting_provider_aliases():
    body = runtime_state()
    body["runtime_targets"]["openclaw-a"]["provider_id"] = "openai-managed"
    body["runtime_targets"]["openclaw-a"]["providerId"] = "anthropic-managed"

    assert_rejected(
        body,
        "runtime openclaw-a.providerId conflicts with runtime openclaw-a.provider_id",
    )


def test_runtime_targets_reject_entries_without_explicit_type():
    body = runtime_state(
        runtime_targets={
            "openclaw-a": {
                "enabled": True,
                "execution": {"mode": "external", "stateDir": "/home/openclaw-a/.openclaw"},
            }
        }
    )

    assert_rejected(body, "runtime openclaw-a.type is required")


def test_runtime_targets_reject_shared_external_state_path():
    body = runtime_state()
    body["runtime_targets"]["openclaw-b"]["execution"]["stateDir"] = "/home/openclaw-a/.openclaw"

    assert_rejected(
        body,
        "runtime targets openclaw-a and openclaw-b share state path /home/openclaw-a/.openclaw",
    )


def test_runtime_targets_reject_shared_terminal_container():
    body = runtime_state()
    body["runtime_targets"]["hermes-a"]["execution"]["terminal"]["container"] = "openclaw-a"

    assert_rejected(
        body,
        "runtime targets hermes-a and openclaw-a share terminal container openclaw-a",
    )


def test_external_openclaw_requires_state_dir():
    body = runtime_state()
    del body["runtime_targets"]["openclaw-a"]["execution"]["stateDir"]

    assert_rejected(
        body,
        "runtime openclaw-a external execution requires execution.stateDir",
    )


def test_external_hermes_requires_home_or_state_dir():
    body = runtime_state()
    del body["runtime_targets"]["hermes-a"]["execution"]["home"]
    del body["runtime_targets"]["hermes-a"]["execution"]["stateDir"]

    assert_rejected(
        body,
        "runtime hermes-a external execution requires execution.home or execution.stateDir",
    )


def test_external_runtime_rejects_install_metadata():
    body = runtime_state()
    body["runtime_targets"]["openclaw-a"]["install"] = {
        "source": "official",
        "channel": "stable",
    }

    assert_rejected(
        body,
        "runtime openclaw-a uses external execution and must not declare install metadata",
    )


def test_live_sync_requires_agent_id_not_agent_type_selection():
    body = runtime_state(
        live_sync={
            "enabled": True,
            "agents": [
                {"agentType": "openclaw", "environmentId": "env-openclaw-a"},
            ],
        }
    )

    assert_rejected(body, "live_sync.agents[0].agentId is required")
