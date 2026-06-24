from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

COOLIFY_DIR = Path(__file__).resolve().parents[2] / "infra" / "deploy" / "coolify"


def _load_deploy_module():
    path = COOLIFY_DIR / "deploy_ghcr_runtime.py"
    spec = importlib.util.spec_from_file_location("coolify_deploy_ghcr_runtime", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_runtime_update_payload_syncs_custom_docker_run_options():
    module = _load_deploy_module()

    payload = module.runtime_update_payload(
        expected={
            "fields": {
                "custom_docker_run_options": (
                    "--init --add-host=host.docker.internal:host-gateway"
                ),
                "limits_memory": "2g",
            }
        },
        image="ghcr.io/clawdi-ai/clawdi-backend",
        tag="a" * 40,
    )

    assert payload == {
        "docker_registry_image_name": "ghcr.io/clawdi-ai/clawdi-backend",
        "docker_registry_image_tag": "a" * 40,
        "git_commit_sha": "a" * 40,
        "custom_docker_run_options": "--init --add-host=host.docker.internal:host-gateway",
    }


def test_production_stack_uses_init_without_nproc_ulimits():
    payload = json.loads((COOLIFY_DIR / "production-stack.json").read_text())

    for app_name, app in payload["applications"].items():
        options = app["fields"]["custom_docker_run_options"]
        assert options.startswith("--init "), app_name
        assert "--ulimit nproc=" not in options, app_name
