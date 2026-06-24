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


def test_application_patch_payload_reconciles_manifest_fields_without_placeholders():
    module = _load_deploy_module()

    payload = module.application_patch_payload(
        expected={
            "fields": {
                "name": "clawdi-channels-worker",
                "git_commit_sha": "EXPECT_COMMIT",
                "build_pack": "dockerimage",
                "fqdn": "CONFIGURE_IN_COOLIFY",
                "ports_exposes": None,
                "health_check_enabled": True,
                "health_check_path": "/health",
                "health_check_port": "8000",
                "health_check_interval": 5,
                "health_check_retries": 12,
                "health_check_start_period": 20,
                "start_command": "cd /app/backend && exec python -m app.workers.channels",
                "custom_docker_run_options": (
                    "--init --add-host=host.docker.internal:host-gateway"
                ),
            }
        },
        image="ghcr.io/clawdi-ai/clawdi-backend",
        tag="1370164c7b837280be9918ca3eb65b084cb32376",
    )

    assert payload == {
        "name": "clawdi-channels-worker",
        "git_commit_sha": "1370164c7b837280be9918ca3eb65b084cb32376",
        "health_check_enabled": True,
        "health_check_path": "/health",
        "health_check_port": "8000",
        "health_check_interval": 5,
        "health_check_retries": 12,
        "health_check_start_period": 20,
        "start_command": "cd /app/backend && exec python -m app.workers.channels",
        "custom_docker_run_options": "--init --add-host=host.docker.internal:host-gateway",
        "docker_registry_image_name": "ghcr.io/clawdi-ai/clawdi-backend",
        "docker_registry_image_tag": "1370164c7b837280be9918ca3eb65b084cb32376",
    }


def test_production_stack_uses_init_without_nproc_ulimits():
    payload = json.loads((COOLIFY_DIR / "production-stack.json").read_text())

    for app_name, app in payload["applications"].items():
        options = app["fields"]["custom_docker_run_options"]
        assert options.startswith("--init "), app_name
        assert "--ulimit nproc=" not in options, app_name
