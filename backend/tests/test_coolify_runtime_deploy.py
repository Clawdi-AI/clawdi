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


def _load_audit_module():
    path = COOLIFY_DIR / "audit_stack.py"
    spec = importlib.util.spec_from_file_location("coolify_audit_stack", path)
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
        "custom_docker_run_options": ("--init --add-host=host.docker.internal:host-gateway"),
        "docker_registry_image_name": "ghcr.io/clawdi-ai/clawdi-backend",
        "docker_registry_image_tag": "1370164c7b837280be9918ca3eb65b084cb32376",
    }


def test_application_env_payload_uses_runtime_only_literal_value():
    module = _load_deploy_module()

    assert module.application_env_payload("CLAWDI_PROCESS_ROLE", "channels-worker") == {
        "key": "CLAWDI_PROCESS_ROLE",
        "value": "channels-worker",
        "is_preview": False,
        "is_literal": True,
        "is_multiline": False,
        "is_shown_once": False,
        "is_runtime": True,
        "is_buildtime": False,
    }


def test_plan_application_env_actions_creates_and_updates_only_declared_keys():
    module = _load_deploy_module()

    actions = module.plan_application_env_actions(
        rows=[
            {
                "key": "CLAWDI_PROCESS_ROLE",
                "value": "{{environment.CLAWDI_PROCESS_ROLE}}",
                "is_preview": False,
                "is_shared": True,
                "is_literal": False,
                "is_runtime": True,
                "is_buildtime": False,
            },
            {
                "key": "DATABASE_URL",
                "value": "{{environment.DATABASE_URL}}",
                "is_preview": False,
            },
        ],
        expected_env={
            "CLAWDI_PROCESS_ROLE": "channels-worker",
            "OTHER_RUNTIME_FLAG": "enabled",
        },
    )

    assert actions == [
        module.ApplicationEnvAction("update", "CLAWDI_PROCESS_ROLE"),
        module.ApplicationEnvAction("create", "OTHER_RUNTIME_FLAG"),
    ]


def test_production_stack_uses_init_without_nproc_ulimits():
    payload = json.loads((COOLIFY_DIR / "production-stack.json").read_text())

    for app_name, app in payload["applications"].items():
        options = app["fields"]["custom_docker_run_options"]
        assert options.startswith("--init "), app_name
        assert "--ulimit nproc=" not in options, app_name
        assert "--env CLAWDI_PROCESS_ROLE=" not in options, app_name
        assert "start_command" not in app["fields"], app_name


def test_production_stack_assigns_runtime_roles():
    payload = json.loads((COOLIFY_DIR / "production-stack.json").read_text())

    expected_roles = {
        "clawdi-backend": "api",
        "clawdi-channels-worker": "channels-worker",
    }
    for app_name, role in expected_roles.items():
        app_env = payload["applications"][app_name]["application_env"]
        assert app_env == {"CLAWDI_PROCESS_ROLE": role}, app_name


def test_audit_env_accepts_shared_manifest_and_application_env(monkeypatch):
    module = _load_audit_module()

    def fake_request_json(**_kwargs):
        return {
            "data": [
                {
                    "key": "DATABASE_URL",
                    "value": "{{environment.DATABASE_URL}}",
                    "real_value": "postgresql+asyncpg://example",
                    "is_preview": False,
                    "is_shared": True,
                    "is_runtime": True,
                    "is_buildtime": False,
                },
                {
                    "key": "CLAWDI_PROCESS_ROLE",
                    "value": "channels-worker",
                    "real_value": "'channels-worker'",
                    "is_preview": False,
                    "is_shared": False,
                    "is_literal": True,
                    "is_runtime": True,
                    "is_buildtime": False,
                },
            ]
        }

    monkeypatch.setattr(module, "request_json", fake_request_json)

    errors, digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-channels-worker",
        app_uuid="app-uuid",
        expected_shared_keys={"DATABASE_URL"},
        expected_application_env={"CLAWDI_PROCESS_ROLE": "channels-worker"},
    )

    assert errors == []
    assert set(digests) == {"DATABASE_URL"}


def test_audit_env_allows_empty_s3_values_while_file_store_is_local(monkeypatch):
    module = _load_audit_module()
    s3_keys = {
        "FILE_STORE_S3_ACCESS_KEY_ID",
        "FILE_STORE_S3_BUCKET",
        "FILE_STORE_S3_ENDPOINT_URL",
        "FILE_STORE_S3_FORCE_PATH_STYLE",
        "FILE_STORE_S3_REGION",
        "FILE_STORE_S3_SECRET_ACCESS_KEY",
    }
    rows = [
        {
            "key": "FILE_STORE_TYPE",
            "value": "{{environment.FILE_STORE_TYPE}}",
            "real_value": "local",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_LOCAL_PATH",
            "value": "{{environment.FILE_STORE_LOCAL_PATH}}",
            "real_value": "/data/files",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
    ]
    rows.extend(
        {
            "key": key,
            "value": f"{{{{environment.{key}}}}}",
            "real_value": "",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        }
        for key in sorted(s3_keys)
    )

    def fake_request_json(**_kwargs):
        return {"data": rows}

    monkeypatch.setattr(module, "request_json", fake_request_json)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-backend",
        app_uuid="app-uuid",
        expected_shared_keys={"FILE_STORE_TYPE", "FILE_STORE_LOCAL_PATH"} | s3_keys,
        expected_application_env={},
    )

    assert errors == []


def test_audit_env_retries_pending_shared_file_store_resolution(monkeypatch):
    module = _load_audit_module()
    calls = 0

    pending_rows = [
        {
            "key": "FILE_STORE_TYPE",
            "value": "{{environment.FILE_STORE_TYPE}}",
            "real_value": None,
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_LOCAL_PATH",
            "value": "{{environment.FILE_STORE_LOCAL_PATH}}",
            "real_value": None,
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
    ]
    resolved_rows = [
        {
            "key": "FILE_STORE_TYPE",
            "value": "{{environment.FILE_STORE_TYPE}}",
            "real_value": "local",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_LOCAL_PATH",
            "value": "{{environment.FILE_STORE_LOCAL_PATH}}",
            "real_value": "/data/files",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
    ]

    def fake_load_env_rows(**_kwargs):
        nonlocal calls
        calls += 1
        return pending_rows if calls == 1 else resolved_rows

    monkeypatch.setattr(module, "load_env_rows", fake_load_env_rows)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-backend",
        app_uuid="app-uuid",
        expected_shared_keys={"FILE_STORE_TYPE", "FILE_STORE_LOCAL_PATH"},
        expected_application_env={},
        env_resolution_attempts=2,
    )

    assert calls == 2
    assert errors == []


def test_audit_env_rejects_permanently_pending_shared_file_store_resolution(monkeypatch):
    module = _load_audit_module()
    calls = 0

    def fake_load_env_rows(**_kwargs):
        nonlocal calls
        calls += 1
        return [
            {
                "key": "FILE_STORE_TYPE",
                "value": "{{environment.FILE_STORE_TYPE}}",
                "real_value": None,
                "is_preview": False,
                "is_shared": True,
                "is_runtime": True,
                "is_buildtime": False,
            }
        ]

    monkeypatch.setattr(module, "load_env_rows", fake_load_env_rows)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-backend",
        app_uuid="app-uuid",
        expected_shared_keys={"FILE_STORE_TYPE"},
        expected_application_env={},
        env_resolution_attempts=2,
    )

    assert calls == 2
    assert errors == [
        "clawdi-backend: FILE_STORE_TYPE must resolve to 'local' or 's3', got "
        "'{{environment.FILE_STORE_TYPE}}'",
    ]


def test_audit_env_requires_s3_values_when_file_store_is_s3(monkeypatch):
    module = _load_audit_module()
    rows = [
        {
            "key": "FILE_STORE_TYPE",
            "value": "{{environment.FILE_STORE_TYPE}}",
            "real_value": "s3",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_LOCAL_PATH",
            "value": "{{environment.FILE_STORE_LOCAL_PATH}}",
            "real_value": "",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_S3_BUCKET",
            "value": "{{environment.FILE_STORE_S3_BUCKET}}",
            "real_value": "clawdi",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_S3_ACCESS_KEY_ID",
            "value": "{{environment.FILE_STORE_S3_ACCESS_KEY_ID}}",
            "real_value": "",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_S3_ENDPOINT_URL",
            "value": "{{environment.FILE_STORE_S3_ENDPOINT_URL}}",
            "real_value": "https://example.r2.cloudflarestorage.com",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_S3_REGION",
            "value": "{{environment.FILE_STORE_S3_REGION}}",
            "real_value": "auto",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
        {
            "key": "FILE_STORE_S3_SECRET_ACCESS_KEY",
            "value": "{{environment.FILE_STORE_S3_SECRET_ACCESS_KEY}}",
            "real_value": "",
            "is_preview": False,
            "is_shared": True,
            "is_runtime": True,
            "is_buildtime": False,
        },
    ]

    def fake_request_json(**_kwargs):
        return {"data": rows}

    monkeypatch.setattr(module, "request_json", fake_request_json)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-backend",
        app_uuid="app-uuid",
        expected_shared_keys={str(row["key"]) for row in rows},
        expected_application_env={},
    )

    assert errors == [
        "clawdi-backend: FILE_STORE_S3_ACCESS_KEY_ID resolves to an empty value",
        "clawdi-backend: FILE_STORE_S3_SECRET_ACCESS_KEY resolves to an empty value",
    ]


def test_audit_env_rejects_unresolved_shared_references(monkeypatch):
    module = _load_audit_module()

    def fake_request_json(**_kwargs):
        return {
            "data": [
                {
                    "key": "FILE_STORE_TYPE",
                    "value": "{{environment.FILE_STORE_TYPE}}",
                    "real_value": "{{environment.FILE_STORE_TYPE}}",
                    "is_preview": False,
                    "is_shared": True,
                    "is_runtime": True,
                    "is_buildtime": False,
                },
            ]
        }

    monkeypatch.setattr(module, "request_json", fake_request_json)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-backend",
        app_uuid="app-uuid",
        expected_shared_keys={"FILE_STORE_TYPE"},
        expected_application_env={},
    )

    assert errors == [
        "clawdi-backend: FILE_STORE_TYPE does not resolve from shared variables",
        "clawdi-backend: FILE_STORE_TYPE must resolve to 'local' or 's3', got "
        "'{{environment.FILE_STORE_TYPE}}'",
    ]


def test_audit_env_rejects_wrong_application_env_value(monkeypatch):
    module = _load_audit_module()

    def fake_request_json(**_kwargs):
        return {
            "data": [
                {
                    "key": "CLAWDI_PROCESS_ROLE",
                    "value": "api",
                    "is_preview": False,
                    "is_shared": False,
                    "is_literal": True,
                    "is_runtime": True,
                    "is_buildtime": False,
                },
            ]
        }

    monkeypatch.setattr(module, "request_json", fake_request_json)

    errors, _digests = module.audit_env(
        api_url="https://coolify.example.com",
        token="token",
        app_name="clawdi-channels-worker",
        app_uuid="app-uuid",
        expected_shared_keys=set(),
        expected_application_env={"CLAWDI_PROCESS_ROLE": "channels-worker"},
    )

    assert errors == ["clawdi-channels-worker: CLAWDI_PROCESS_ROLE has an unexpected value"]


def test_literal_env_value_matches_value_or_quoted_real_value():
    module = _load_audit_module()

    assert module.literal_env_value_matches({}, "api")
    assert module.literal_env_value_matches(
        {"value": "api", "real_value": "'api'"},
        "api",
    )
    assert module.literal_env_value_matches(
        {"value": "masked", "real_value": '"channels-worker"'},
        "channels-worker",
    )
    assert not module.literal_env_value_matches(
        {"value": "api", "real_value": "'api'"},
        "channels-worker",
    )
