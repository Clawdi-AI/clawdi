from __future__ import annotations

from copy import deepcopy
from typing import Any, cast

import pytest
from pydantic import ValidationError

from app.schemas.runtime import AGENT_PLUGINS_SCHEMA_1_0_0, HostedAgentPlugins


def _installation() -> dict[str, object]:
    return {
        "installationId": "install_01hxyz",
        "version": "1.2.3-rc.1+linux",
        "agentPluginsSchema": AGENT_PLUGINS_SCHEMA_1_0_0,
        "source": {
            "type": "github",
            "url": "https://github.com/acme/agent-plugins",
            "path": "plugins/acme.tools",
            "commit": "a" * 40,
        },
        "contentDigest": f"sha256-tree-v1:{'b' * 64}",
    }


def _agent_plugins() -> dict[str, object]:
    return {"schemaVersion": 1, "installations": {"acme.tools": _installation()}}


def test_agent_plugins_accepts_exact_immutable_package_contract() -> None:
    desired = _agent_plugins()

    assert HostedAgentPlugins.model_validate(desired).model_dump(mode="json") == desired
    assert (
        HostedAgentPlugins.model_validate({"schemaVersion": 1, "installations": {}}).installations
        == {}
    )
    maximum_version = f"1.2.3+{'a' * 250}"
    maximum_length = deepcopy(desired)
    cast(dict[str, Any], maximum_length["installations"])["acme.tools"] = {
        **_installation(),
        "version": maximum_version,
    }
    assert (
        HostedAgentPlugins.model_validate(maximum_length).installations["acme.tools"].version
        == maximum_version
    )
    release = deepcopy(desired)
    cast(dict[str, Any], release["installations"])["acme.tools"] = {
        **_installation(),
        "source": {
            "type": "github-release",
            "url": "https://github.com/acme/plugins/releases/download/acme-v1.2.3/acme-1.2.3.tar.gz",
            "archiveDigest": f"sha256:{'c' * 64}",
        },
    }
    assert (
        HostedAgentPlugins.model_validate(release).installations["acme.tools"].source.type
        == "github-release"
    )


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("installations", "acme.tools", "version"), "^1.2.3"),
        (("installations", "acme.tools", "version"), f"1.2.3+{'a' * 251}"),
        (("installations", "acme.tools", "agentPluginsSchema"), "1.0.0"),
        (("installations", "acme.tools", "source", "commit"), "main"),
        (("installations", "acme.tools", "source", "path"), "plugins/../escape"),
        (("installations", "acme.tools", "contentDigest"), f"sha256-tree-v1:{'B' * 64}"),
    ],
)
def test_agent_plugins_rejects_mutable_or_unsafe_values(
    path: tuple[str, ...],
    value: str,
) -> None:
    desired = deepcopy(_agent_plugins())
    target: dict[str, Any] = desired
    for segment in path[:-1]:
        target = cast(dict[str, Any], target[segment])
    target[path[-1]] = value

    with pytest.raises(ValidationError):
        HostedAgentPlugins.model_validate(desired)


@pytest.mark.parametrize(
    "desired",
    [
        {**_agent_plugins(), "secretValues": {"api-token": "plaintext"}},
        {
            **_agent_plugins(),
            "installations": {"Acme": _installation()},
        },
    ],
)
def test_agent_plugins_rejects_unknown_or_noncanonical_shapes(
    desired: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        HostedAgentPlugins.model_validate(desired)
