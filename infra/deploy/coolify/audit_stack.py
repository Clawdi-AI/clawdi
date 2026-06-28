#!/usr/bin/env python3
"""Audit the Clawdi Coolify backend stack without printing secrets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

FULL_GIT_SHA_RE = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
ANGLE_BRACKET_PLACEHOLDER_RE = re.compile(r"<[^<>]+>")
EXPECT_COMMIT_PLACEHOLDER = "EXPECT_COMMIT"
CONFIGURE_IN_COOLIFY_PLACEHOLDER = "CONFIGURE_IN_COOLIFY"

BASE_REQUIRED_NON_EMPTY_KEYS = {
    "ADMIN_API_KEY",
    "CLERK_PEM_PUBLIC_KEY",
    "CORS_ORIGINS",
    "DATABASE_URL",
    "DB_MAX_OVERFLOW",
    "DB_POOL_SIZE",
    "DB_POOL_TIMEOUT",
    "ENCRYPTION_KEY",
    "ENVIRONMENT",
    "PUBLIC_API_URL",
    "TRUST_FORWARDED_FOR",
    "VAULT_ENCRYPTION_KEY",
    "WEB_ORIGIN",
}
FILE_STORE_MANIFEST_KEYS = {
    "FILE_STORE_LOCAL_PATH",
    "FILE_STORE_S3_ACCESS_KEY_ID",
    "FILE_STORE_S3_BUCKET",
    "FILE_STORE_S3_ENDPOINT_URL",
    "FILE_STORE_S3_FORCE_PATH_STYLE",
    "FILE_STORE_S3_REGION",
    "FILE_STORE_S3_SECRET_ACCESS_KEY",
    "FILE_STORE_TYPE",
}
S3_REQUIRED_NON_EMPTY_KEYS = {
    "FILE_STORE_S3_ACCESS_KEY_ID",
    "FILE_STORE_S3_BUCKET",
    "FILE_STORE_S3_ENDPOINT_URL",
    "FILE_STORE_S3_REGION",
    "FILE_STORE_S3_SECRET_ACCESS_KEY",
}
REQUIRED_MANIFEST_KEYS = BASE_REQUIRED_NON_EMPTY_KEYS | FILE_STORE_MANIFEST_KEYS
ENV_RESOLUTION_ATTEMPTS = 4
ENV_RESOLUTION_RETRY_DELAY_SECONDS = 3.0


def parse_env_manifest(path: Path) -> set[str]:
    return set(parse_env_manifest_values(path))


def parse_env_manifest_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and (key[0].isalpha() or key[0] == "_"):
            values[key] = value.strip()
    return values


def request_json(
    *,
    api_url: str,
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    body = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "clawdi-coolify-stack-audit",
    }
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        api_url.rstrip("/") + path,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Coolify API {method} {path} failed: HTTP {exc.code}") from exc

    if not raw.strip():
        return {}
    return json.loads(raw)


def get_payload_list(payload: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        rows = payload.get(key, payload.get("data", []))
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def value_digest(value: object) -> str:
    normalized = "" if value is None else str(value)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def row_resolved_value(row: dict[str, Any]) -> object:
    if row.get("real_value") is not None:
        return row.get("real_value")
    return row.get("value")


def shared_value_is_hidden(row: dict[str, Any]) -> bool:
    return (
        row.get("is_shared") is True and row.get("real_value") is None and row.get("value") is None
    )


def shared_value_is_pending(row: dict[str, Any]) -> bool:
    if row.get("is_shared") is not True:
        return False
    real_value = row.get("real_value")
    if real_value is not None:
        return isinstance(real_value, str) and looks_like_unresolved_shared_ref(real_value)
    value = row.get("value")
    return isinstance(value, str) and looks_like_unresolved_shared_ref(value)


def env_resolution_pending(by_key: dict[str, dict[str, Any]]) -> bool:
    file_store_type = by_key.get("FILE_STORE_TYPE")
    if file_store_type and shared_value_is_pending(file_store_type):
        return True

    kind_value = row_resolved_value(file_store_type) if file_store_type else None
    kind = str(kind_value or "").strip().lower()
    keys = set(BASE_REQUIRED_NON_EMPTY_KEYS)
    if kind == "local":
        keys.add("FILE_STORE_LOCAL_PATH")
    elif kind == "s3":
        keys.update(S3_REQUIRED_NON_EMPTY_KEYS)

    return any(
        (row := by_key.get(key)) is not None and shared_value_is_pending(row) for key in keys
    )


def load_env_rows(
    *,
    api_url: str,
    token: str,
    app_uuid: str,
) -> list[dict[str, Any]]:
    payload = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/applications/{app_uuid}/envs",
    )
    return [row for row in get_payload_list(payload, "data") if row.get("is_preview") is not True]


def env_rows_by_key(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    by_key: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for row in rows:
        key = str(row.get("key", ""))
        if key in by_key:
            errors.append(f"duplicate env key {key}")
        by_key[key] = row
    return by_key, errors


def file_store_required_non_empty_keys(
    by_key: dict[str, dict[str, Any]],
    expected_file_store_type: str | None,
) -> tuple[set[str], list[str]]:
    row = by_key.get("FILE_STORE_TYPE")
    if row is None:
        return set(), []
    kind_value = row_resolved_value(row)
    expected_kind = normalize_literal_env_value(expected_file_store_type)
    if isinstance(expected_kind, str):
        expected_kind = expected_kind.strip().lower()

    errors: list[str] = []
    if shared_value_is_hidden(row) and expected_kind in {"local", "s3"}:
        kind_value = expected_kind

    kind = str(kind_value or "").strip().lower()
    required = {"FILE_STORE_TYPE"}

    if expected_kind and expected_kind not in {"local", "s3"}:
        errors.append(
            "env manifest FILE_STORE_TYPE must be 'local' or 's3', "
            f"got {expected_file_store_type!r}"
        )
    if kind in {"local", "s3"} and expected_kind in {"local", "s3"} and kind != expected_kind:
        errors.append(f"FILE_STORE_TYPE expected {expected_kind!r}, got {kind!r}")

    if kind == "local":
        required.add("FILE_STORE_LOCAL_PATH")
        return required, errors
    if kind == "s3":
        required.update(S3_REQUIRED_NON_EMPTY_KEYS)
        return required, errors
    errors.append(f"FILE_STORE_TYPE must resolve to 'local' or 's3', got {kind_value!r}")
    return required, errors


def normalize_literal_env_value(value: object) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if len(normalized) >= 2 and normalized[0] == "'" and normalized[-1] == "'":
        return normalized[1:-1]
    if len(normalized) >= 2 and normalized[0] == '"' and normalized[-1] == '"':
        return normalized[1:-1]
    return normalized


def literal_env_value_matches(row: dict[str, Any], expected: str) -> bool:
    candidates = {
        normalized
        for value in (row.get("value"), row.get("real_value"))
        if (normalized := normalize_literal_env_value(value)) is not None
    }
    if not candidates:
        return True
    return expected in candidates


def looks_like_placeholder(value: str) -> bool:
    normalized = value.strip()
    lower = normalized.lower()
    if lower in {"replace", "replace-me"}:
        return True
    if "replace-with-" in lower:
        return True
    if re.search(r"://(?:<|replace)(?:[/:?#.-]|$)", lower):
        return True
    return ANGLE_BRACKET_PLACEHOLDER_RE.search(normalized) is not None


def looks_like_unresolved_shared_ref(value: str) -> bool:
    normalized = value.strip().replace("\\{", "{").replace("\\}", "}")
    pattern = r"\{\{\s*(environment|project|team|server)\.[^{}]+\s*\}\}"
    return re.search(pattern, normalized) is not None


def field_matches(
    *,
    field: str,
    actual: object,
    expected: object,
    expect_commit: str | None,
) -> bool:
    if expected == CONFIGURE_IN_COOLIFY_PLACEHOLDER:
        return (
            isinstance(actual, str) and bool(actual.strip()) and not looks_like_placeholder(actual)
        )
    if expected == EXPECT_COMMIT_PLACEHOLDER:
        if expect_commit:
            return actual == expect_commit
        return isinstance(actual, str) and FULL_GIT_SHA_RE.fullmatch(actual) is not None
    if field == "git_commit_sha" and expected == "HEAD":
        return actual == "HEAD" or (
            isinstance(actual, str) and FULL_GIT_SHA_RE.fullmatch(actual) is not None
        )
    return actual == expected


def configured_value_matches(actual: object, expected: object) -> bool:
    if expected == CONFIGURE_IN_COOLIFY_PLACEHOLDER:
        return (
            isinstance(actual, str) and bool(actual.strip()) and not looks_like_placeholder(actual)
        )
    return actual == expected


def load_stack_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    if not isinstance(payload.get("applications"), dict):
        raise SystemExit(f"{path} must define an applications object.")
    return payload


def application_env(expected: dict[str, Any]) -> dict[str, str]:
    raw = expected.get("application_env", {})
    if not isinstance(raw, dict):
        raise SystemExit("Application application_env must be an object.")

    normalized: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key:
            raise SystemExit("Application application_env keys must be non-empty strings.")
        if not isinstance(value, str):
            raise SystemExit(f"{key}: application_env values must be strings.")
        normalized[key] = value
    return normalized


def explicit_uuid(expected: dict[str, Any]) -> str | None:
    value = expected.get("uuid")
    if isinstance(value, str) and value and not value.startswith("REPLACE_"):
        return value
    return None


def resolve_application_uuids(
    *,
    api_url: str,
    token: str,
    applications: dict[str, dict[str, Any]],
    deployment_tag: str | None,
) -> tuple[dict[str, str], list[str]]:
    resolved = {
        app_name: app_uuid
        for app_name, expected in applications.items()
        if (app_uuid := explicit_uuid(expected))
    }
    errors: list[str] = []

    missing = set(applications) - set(resolved)
    if missing:
        if not deployment_tag:
            errors.append(
                "Applications without explicit uuid require a deployment_tag "
                "so the audit can resolve them by name."
            )
            return resolved, errors
        payload = request_json(
            api_url=api_url,
            token=token,
            method="GET",
            path=f"/api/v1/applications?tag={urllib.parse.quote(deployment_tag)}",
        )
        tagged = get_payload_list(payload, "applications")
        by_name = {str(row.get("name")): str(row.get("uuid")) for row in tagged if row.get("uuid")}
        for app_name in sorted(missing):
            app_uuid = by_name.get(app_name)
            if app_uuid:
                resolved[app_name] = app_uuid
            else:
                errors.append(
                    f"{app_name}: missing Coolify Application with tag {deployment_tag!r}"
                )

    return resolved, errors


def audit_deployment_tag(
    *,
    api_url: str,
    token: str,
    applications: dict[str, dict[str, Any]],
    deployment_tag: str,
) -> list[str]:
    payload = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/applications?tag={urllib.parse.quote(deployment_tag)}",
    )
    rows = get_payload_list(payload, "applications")
    actual_names = {str(row.get("name")) for row in rows if row.get("name")}
    expected_names = set(applications)
    errors: list[str] = []

    for app_name in sorted(expected_names - actual_names):
        errors.append(f"{app_name}: missing Coolify deployment tag {deployment_tag!r}")
    for app_name in sorted(actual_names - expected_names):
        errors.append(
            f"{app_name}: unexpected Application has Coolify deployment tag {deployment_tag!r}"
        )

    print(
        f"deployment_tag={deployment_tag} expected_apps={len(expected_names)} "
        f"tagged_apps={len(actual_names)}"
    )
    return errors


def audit_application_shape(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
    expected: dict[str, Any],
    application_settings: dict[str, Any],
    destination: dict[str, str],
    phase: str,
    expect_commit: str | None,
) -> list[str]:
    app = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/applications/{app_uuid}",
    )
    if not isinstance(app, dict):
        return [f"{app_name}: application payload is not an object"]

    errors: list[str] = []
    if app.get("name") != app_name:
        errors.append(f"{app_name}: uuid resolves to {app.get('name')!r}")

    role = str(expected.get("role", ""))
    app_expect_commit = expect_commit
    if phase == "api-only" and role != "api":
        app_expect_commit = None

    for field, expected_value in expected.get("fields", {}).items():
        actual = app.get(field)
        if not field_matches(
            field=field,
            actual=actual,
            expected=expected_value,
            expect_commit=app_expect_commit,
        ):
            expected_display = (
                app_expect_commit
                if expected_value == EXPECT_COMMIT_PLACEHOLDER and app_expect_commit
                else expected_value
            )
            errors.append(f"{app_name}: {field} expected {expected_display!r}, got {actual!r}")

    if application_settings:
        exposed_settings = [field for field in application_settings if field in app]
        hidden_settings = len(application_settings) - len(exposed_settings)
        for field in exposed_settings:
            expected_value = application_settings[field]
            actual = app.get(field)
            if not field_matches(
                field=field,
                actual=actual,
                expected=expected_value,
                expect_commit=app_expect_commit,
            ):
                errors.append(f"{app_name}: {field} expected {expected_value!r}, got {actual!r}")
        print(
            f"{app_name}: application_settings_exposed={len(exposed_settings)} "
            f"manual_check_required={hidden_settings}"
        )

    app_destination = app.get("destination")
    if not isinstance(app_destination, dict):
        errors.append(f"{app_name}: missing destination")
    else:
        for field, expected_value in destination.items():
            actual = app_destination.get(field)
            if not configured_value_matches(actual, expected_value):
                errors.append(
                    f"{app_name}: destination.{field} expected {expected_value!r}, got {actual!r}"
                )

    status = str(app.get("status", ""))
    if phase == "api-only":
        if role == "api" and not status.startswith("running:"):
            errors.append(f"{app_name}: expected api-only API running status, got {status!r}")
    elif phase == "live" and not status.startswith("running:"):
        errors.append(f"{app_name}: expected live running status, got {status!r}")

    print(f"{app_name}: app_shape=checked status={status or 'unknown'} uuid={app_uuid}")
    return errors


def audit_storages(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
    expected_storages: list[dict[str, Any]],
) -> list[str]:
    payload = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/applications/{app_uuid}/storages",
    )
    rows = get_payload_list(payload, "persistent_storages")
    by_name = {str(row.get("name")): row for row in rows}
    errors: list[str] = []

    expected_names = {str(row["name"]) for row in expected_storages}
    actual_names = set(by_name)
    for name in sorted(expected_names - actual_names):
        errors.append(f"{app_name}: missing storage {name}")
    for name in sorted(actual_names - expected_names):
        errors.append(f"{app_name}: extra storage {name}")

    for expected in expected_storages:
        name = str(expected["name"])
        row = by_name.get(name)
        if not row:
            continue
        for field in ("host_path", "mount_path"):
            if not configured_value_matches(row.get(field), expected.get(field)):
                errors.append(
                    f"{app_name}: storage {name} {field} expected "
                    f"{expected.get(field)!r}, got {row.get(field)!r}"
                )

    print(f"{app_name}: storages={len(rows)}")
    return errors


def audit_env(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
    expected_shared_keys: set[str],
    expected_application_env: dict[str, str],
    expected_env_values: dict[str, str] | None = None,
    env_resolution_attempts: int = 1,
    env_resolution_retry_delay_seconds: float = 0.0,
) -> tuple[list[str], dict[str, str]]:
    expected_env_values = expected_env_values or {}
    attempts = max(env_resolution_attempts, 1)
    rows: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    duplicate_errors: list[str] = []
    for attempt in range(attempts):
        rows = load_env_rows(api_url=api_url, token=token, app_uuid=app_uuid)
        by_key, duplicate_errors = env_rows_by_key(rows)
        if not env_resolution_pending(by_key):
            break
        if attempt + 1 < attempts and env_resolution_retry_delay_seconds > 0:
            time.sleep(env_resolution_retry_delay_seconds)

    errors: list[str] = []

    for error in duplicate_errors:
        errors.append(f"{app_name}: {error}")

    keys = set(by_key)
    expected_application_keys = set(expected_application_env)
    expected_keys = expected_shared_keys | expected_application_keys
    for key in sorted(expected_keys - keys):
        errors.append(f"{app_name}: missing env key {key}")
    for key in sorted(keys - expected_keys):
        errors.append(f"{app_name}: extra env key {key}")

    for key in sorted(expected_shared_keys & keys):
        row = by_key[key]
        expected_ref = f"{{{{environment.{key}}}}}"
        if row.get("is_shared") is not True:
            errors.append(f"{app_name}: {key} is not marked as shared")
            if row.get("value") != expected_ref:
                errors.append(f"{app_name}: {key} is not wired to {expected_ref}")
        if row.get("is_runtime") is not True:
            errors.append(f"{app_name}: {key} is not marked as runtime")
        if row.get("is_buildtime") is not False:
            errors.append(f"{app_name}: {key} must not be exposed at build time")

        real_value = row.get("real_value")
        if real_value is None and row.get("is_shared") is not True:
            errors.append(f"{app_name}: {key} does not resolve to a value")
        if real_value is not None:
            if isinstance(real_value, str) and looks_like_placeholder(real_value):
                errors.append(f"{app_name}: {key} still looks like a placeholder")
            if isinstance(real_value, str) and looks_like_unresolved_shared_ref(real_value):
                errors.append(f"{app_name}: {key} does not resolve from shared variables")

    required_non_empty_keys = set(BASE_REQUIRED_NON_EMPTY_KEYS)
    file_store_required, file_store_errors = file_store_required_non_empty_keys(
        by_key,
        expected_file_store_type=expected_env_values.get("FILE_STORE_TYPE"),
    )
    required_non_empty_keys.update(file_store_required)
    for error in file_store_errors:
        errors.append(f"{app_name}: {error}")

    for key in sorted(required_non_empty_keys & keys):
        value = row_resolved_value(by_key[key])
        if value is not None and not str(value).strip():
            errors.append(f"{app_name}: {key} resolves to an empty value")

    for key, expected_value in sorted(expected_application_env.items()):
        row = by_key.get(key)
        if not row:
            continue
        if row.get("is_shared") is True:
            errors.append(f"{app_name}: {key} must be Application-specific, not shared")
        if row.get("is_literal") is not True:
            errors.append(f"{app_name}: {key} must be stored as a literal value")
        if row.get("is_runtime") is not True:
            errors.append(f"{app_name}: {key} is not marked as runtime")
        if row.get("is_buildtime") is not False:
            errors.append(f"{app_name}: {key} must not be exposed at build time")

        if not literal_env_value_matches(row, expected_value):
            errors.append(f"{app_name}: {key} has an unexpected value")

    digests = {
        key: value_digest(row_resolved_value(by_key[key]))
        for key in sorted(expected_shared_keys & keys)
    }
    shared_refs = sum(1 for row in rows if row.get("is_shared") is True)
    hidden_shared_refs = sum(1 for row in rows if shared_value_is_hidden(row))
    runtime_only = sum(
        1 for row in rows if row.get("is_runtime") is True and row.get("is_buildtime") is False
    )
    print(
        f"{app_name}: env_rows={len(rows)} keys={len(keys)} "
        f"shared_refs={shared_refs} app_env={len(expected_application_env)} "
        f"runtime_only={runtime_only} hidden_shared_refs={hidden_shared_refs}"
    )
    return errors, digests


def latest_successful_deployment_commit(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
) -> tuple[list[str], str | None]:
    payload = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/deployments/applications/{app_uuid}?take=20",
    )
    rows = get_payload_list(payload, "deployments")
    for row in rows:
        status = str(row.get("status", ""))
        commit = str(row.get("commit", ""))
        if status == "finished" and FULL_GIT_SHA_RE.fullmatch(commit):
            print(f"{app_name}: latest_finished_commit={commit}")
            return [], commit
    return [f"{app_name}: no latest finished deployment with a full git commit"], None


def audit_deployment_commits(
    *,
    api_url: str,
    token: str,
    app_uuids: dict[str, str],
    expect_commit: str | None,
) -> list[str]:
    errors: list[str] = []
    commits: dict[str, str] = {}
    for app_name, app_uuid in app_uuids.items():
        commit_errors, commit = latest_successful_deployment_commit(
            api_url=api_url,
            token=token,
            app_name=app_name,
            app_uuid=app_uuid,
        )
        errors.extend(commit_errors)
        if commit:
            commits[app_name] = commit

    unique_commits = set(commits.values())
    if len(unique_commits) > 1:
        for app_name, commit in sorted(commits.items()):
            errors.append(f"{app_name}: latest finished commit is {commit}")
        errors.append("Applications do not share the same latest finished commit")

    if expect_commit:
        for app_name, commit in sorted(commits.items()):
            if commit != expect_commit:
                errors.append(
                    f"{app_name}: latest finished commit expected {expect_commit}, got {commit}"
                )

    if commits:
        print(
            f"deployment_commits=checked unique_commits={len(unique_commits)} "
            f"expected={expect_commit or 'none'}"
        )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--stack-manifest",
        type=Path,
        default=Path(__file__).with_name("production-stack.json"),
    )
    parser.add_argument(
        "--env-manifest",
        type=Path,
        default=Path(__file__).with_name(".env.example"),
    )
    parser.add_argument("--api-url", default=os.environ.get("COOLIFY_API_URL"))
    parser.add_argument("--token", default=os.environ.get("COOLIFY_TOKEN"))
    parser.add_argument("--phase", choices=("api-only", "live", "none"), default="none")
    parser.add_argument("--expect-commit")
    parser.add_argument("--skip-deployment-commit-audit", action="store_true")
    args = parser.parse_args()

    if not args.api_url:
        raise SystemExit("Set COOLIFY_API_URL or pass --api-url.")
    if not args.token:
        raise SystemExit("Set COOLIFY_TOKEN or pass --token.")
    if args.expect_commit and not FULL_GIT_SHA_RE.fullmatch(args.expect_commit):
        raise SystemExit("--expect-commit must be a full 40-character git SHA.")

    stack = load_stack_manifest(args.stack_manifest)
    expected_env_values = parse_env_manifest_values(args.env_manifest)
    expected_keys = set(expected_env_values)
    missing_required_keys = REQUIRED_MANIFEST_KEYS - expected_keys
    if missing_required_keys:
        raise SystemExit(
            "Required non-empty keys missing from env manifest: "
            + ", ".join(sorted(missing_required_keys))
        )

    applications: dict[str, dict[str, Any]] = stack["applications"]
    application_settings = stack.get("application_settings", {})
    if not isinstance(application_settings, dict):
        raise SystemExit("Stack manifest application_settings must be an object.")
    deployment_tag = stack.get("deployment_tag")
    if deployment_tag is not None and not isinstance(deployment_tag, str):
        raise SystemExit("Stack manifest deployment_tag must be a string.")
    destination = stack.get("destination", {})
    if not isinstance(destination, dict):
        raise SystemExit("Stack manifest destination must be an object.")

    print(f"project={stack.get('project')} environment={stack.get('environment')}")
    print(f"manifest_keys={len(expected_keys)} applications={len(applications)} phase={args.phase}")

    all_errors: list[str] = []
    app_uuids, resolve_errors = resolve_application_uuids(
        api_url=args.api_url,
        token=args.token,
        applications=applications,
        deployment_tag=deployment_tag,
    )
    all_errors.extend(resolve_errors)

    app_digests: dict[str, dict[str, str]] = {}
    for app_name, expected in applications.items():
        app_uuid = app_uuids.get(app_name)
        if not app_uuid:
            continue
        all_errors.extend(
            audit_application_shape(
                api_url=args.api_url,
                token=args.token,
                app_name=app_name,
                app_uuid=app_uuid,
                expected=expected,
                application_settings=application_settings,
                destination=destination,
                phase=args.phase,
                expect_commit=args.expect_commit,
            )
        )
        all_errors.extend(
            audit_storages(
                api_url=args.api_url,
                token=args.token,
                app_name=app_name,
                app_uuid=app_uuid,
                expected_storages=expected.get("storages", []),
            )
        )
        env_errors, digests = audit_env(
            api_url=args.api_url,
            token=args.token,
            app_name=app_name,
            app_uuid=app_uuid,
            expected_shared_keys=expected_keys,
            expected_env_values=expected_env_values,
            expected_application_env=application_env(expected),
            env_resolution_attempts=ENV_RESOLUTION_ATTEMPTS,
            env_resolution_retry_delay_seconds=ENV_RESOLUTION_RETRY_DELAY_SECONDS,
        )
        all_errors.extend(env_errors)
        app_digests[app_name] = digests

    backend = app_digests.get("clawdi-backend", {})
    for app_name, digests in app_digests.items():
        if app_name == "clawdi-backend":
            continue
        for key, digest in backend.items():
            if digests.get(key) != digest:
                all_errors.append(f"{app_name}: {key} resolves differently from backend")

    if deployment_tag:
        all_errors.extend(
            audit_deployment_tag(
                api_url=args.api_url,
                token=args.token,
                applications=applications,
                deployment_tag=deployment_tag,
            )
        )

    should_audit_deployment_commits = not args.skip_deployment_commit_audit and args.phase == "live"
    if should_audit_deployment_commits and app_uuids:
        all_errors.extend(
            audit_deployment_commits(
                api_url=args.api_url,
                token=args.token,
                app_uuids=app_uuids,
                expect_commit=args.expect_commit,
            )
        )

    if all_errors:
        print("coolify_stack_audit=failed")
        for error in all_errors:
            print(error)
        return 1

    print("coolify_stack_audit=ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
