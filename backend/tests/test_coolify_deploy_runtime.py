from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_deploy_module():
    path = (
        Path(__file__).resolve().parents[2]
        / "infra"
        / "deploy"
        / "coolify"
        / "deploy_ghcr_runtime.py"
    )
    spec = importlib.util.spec_from_file_location("coolify_deploy_runtime", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
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
                "start_command": "cd /app/backend && exec python -m app.workers.channels",
            }
        },
        image="ghcr.io/clawdi-ai/clawdi-backend",
        tag="1370164c7b837280be9918ca3eb65b084cb32376",
    )

    assert payload == {
        "name": "clawdi-channels-worker",
        "git_commit_sha": "1370164c7b837280be9918ca3eb65b084cb32376",
        "start_command": "cd /app/backend && exec python -m app.workers.channels",
        "docker_registry_image_name": "ghcr.io/clawdi-ai/clawdi-backend",
        "docker_registry_image_tag": "1370164c7b837280be9918ca3eb65b084cb32376",
    }
