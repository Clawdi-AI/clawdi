#!/usr/bin/env python3
"""Update Clawdi Coolify Applications to a GHCR image tag and deploy."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FULL_GIT_SHA_RE = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
EXPECT_COMMIT_PLACEHOLDER = "EXPECT_COMMIT"
CONFIGURE_IN_COOLIFY_PLACEHOLDER = "CONFIGURE_IN_COOLIFY"
TERMINAL_SUCCESS = {"finished"}
TERMINAL_FAILURE = {
    "cancelled-by-user",
    "failed",
    "failed:build",
    "failed:healthcheck",
    "failed:rollback",
}


@dataclass(frozen=True)
class ApplicationEnvAction:
    action: str
    key: str


def log(message: str) -> None:
    print(message, flush=True)


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
        "User-Agent": "clawdi-ghcr-runtime-deploy",
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
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Coolify API {method} {path} failed: HTTP {exc.code}: {detail}") from exc

    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


def get_payload_list(payload: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        rows = payload.get(key, payload.get("data", []))
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def extract_deployment_uuid(payload: Any) -> str | None:
    if isinstance(payload, dict):
        value = payload.get("deployment_uuid")
        if isinstance(value, str) and value:
            return value
        for value in payload.values():
            found = extract_deployment_uuid(value)
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = extract_deployment_uuid(item)
            if found:
                return found
    return None


def extract_deployment_uuids_by_resource(payload: Any) -> dict[str, str]:
    found: dict[str, str] = {}
    if isinstance(payload, dict):
        resource_uuid = payload.get("resource_uuid")
        deployment_uuid = payload.get("deployment_uuid")
        if isinstance(resource_uuid, str) and isinstance(deployment_uuid, str):
            found[resource_uuid] = deployment_uuid
        for value in payload.values():
            found.update(extract_deployment_uuids_by_resource(value))
    elif isinstance(payload, list):
        for item in payload:
            found.update(extract_deployment_uuids_by_resource(item))
    return found


def load_stack_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    if not isinstance(payload.get("applications"), dict):
        raise SystemExit(f"{path} must define an applications object.")
    return payload


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
) -> dict[str, str]:
    resolved = {
        app_name: app_uuid
        for app_name, expected in applications.items()
        if (app_uuid := explicit_uuid(expected))
    }

    missing = set(applications) - set(resolved)
    if not missing:
        return resolved
    if not deployment_tag:
        raise SystemExit(
            "Applications without explicit uuid require a deployment_tag "
            "so deploy can resolve them by name."
        )

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
        if not app_uuid:
            raise SystemExit(f"{app_name}: missing Coolify Application with tag {deployment_tag!r}")
        resolved[app_name] = app_uuid
    return resolved


def wait_for_deployment(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
    deployment_uuid: str | None,
    tag: str,
    timeout_seconds: int,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_status = "unknown"
    while time.monotonic() < deadline:
        payload = request_json(
            api_url=api_url,
            token=token,
            method="GET",
            path=f"/api/v1/deployments/applications/{app_uuid}?take=20",
        )
        rows = get_payload_list(payload, "deployments")
        selected = None
        for row in rows:
            if deployment_uuid and row.get("deployment_uuid") == deployment_uuid:
                selected = row
                break
        if selected is None:
            for row in rows:
                if str(row.get("commit")) == tag:
                    selected = row
                    break
        if selected:
            status = str(selected.get("status", "unknown"))
            if status != last_status:
                log(f"{app_name}: deployment_status={status}")
                last_status = status
            if status in TERMINAL_SUCCESS:
                return
            if status in TERMINAL_FAILURE or status.startswith("failed"):
                raise SystemExit(f"{app_name}: deployment failed with status {status}")
        time.sleep(5)
    raise SystemExit(
        f"{app_name}: deployment did not finish within {timeout_seconds}s "
        f"(last_status={last_status})"
    )


def deploy_application(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
) -> str | None:
    payload = request_json(
        api_url=api_url,
        token=token,
        method="POST",
        path=f"/api/v1/deploy?uuid={urllib.parse.quote(app_uuid)}",
    )
    deployment_uuid = extract_deployment_uuid(payload)
    log(f"{app_name}: deploy=queued uuid={app_uuid} deployment_uuid={deployment_uuid or 'unknown'}")
    return deployment_uuid


def deploy_applications(
    *,
    api_url: str,
    token: str,
    apps: list[tuple[str, str]],
) -> list[tuple[str, str, str | None]]:
    if not apps:
        return []
    uuid_param = ",".join(app_uuid for _, app_uuid in apps)
    payload = request_json(
        api_url=api_url,
        token=token,
        method="POST",
        path=f"/api/v1/deploy?uuid={urllib.parse.quote(uuid_param, safe=',')}",
    )
    deployment_by_resource = extract_deployment_uuids_by_resource(payload)
    queued: list[tuple[str, str, str | None]] = []
    for app_name, app_uuid in apps:
        deployment_uuid = deployment_by_resource.get(app_uuid)
        log(
            f"{app_name}: deploy=queued uuid={app_uuid} "
            f"deployment_uuid={deployment_uuid or 'unknown'}"
        )
        queued.append((app_name, app_uuid, deployment_uuid))
    return queued


def applications_by_role(
    applications: dict[str, dict[str, Any]],
    app_uuids: dict[str, str],
) -> tuple[tuple[str, str], list[tuple[str, str]]]:
    api_apps = [
        (app_name, app_uuids[app_name])
        for app_name, expected in applications.items()
        if expected.get("role") == "api"
    ]
    if len(api_apps) != 1:
        raise SystemExit(f"Expected exactly one role=api Application, found {len(api_apps)}.")

    api_app = api_apps[0]
    worker_apps = [
        (app_name, app_uuids[app_name]) for app_name in applications if app_name != api_app[0]
    ]
    return api_app, worker_apps


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


def application_env_payload(key: str, value: str) -> dict[str, Any]:
    return {
        "key": key,
        "value": value,
        "is_preview": False,
        "is_literal": True,
        "is_multiline": False,
        "is_shown_once": False,
        "is_runtime": True,
        "is_buildtime": False,
    }


def application_env_row_matches(row: dict[str, Any], key: str, value: str) -> bool:
    desired = application_env_payload(key, value)
    for field, expected_value in desired.items():
        if row.get(field) != expected_value:
            return False
    return row.get("is_shared") is not True


def plan_application_env_actions(
    *,
    rows: list[dict[str, Any]],
    expected_env: dict[str, str],
) -> list[ApplicationEnvAction]:
    production_rows = [row for row in rows if row.get("is_preview") is not True]
    by_key: dict[str, list[dict[str, Any]]] = {}
    for row in production_rows:
        key = str(row.get("key", ""))
        if key in expected_env:
            by_key.setdefault(key, []).append(row)

    actions: list[ApplicationEnvAction] = []
    for key, value in sorted(expected_env.items()):
        candidates = by_key.get(key, [])
        if not candidates:
            actions.append(ApplicationEnvAction("create", key))
            continue
        if len(candidates) > 1:
            raise SystemExit(f"{key}: duplicate application env rows require manual cleanup.")
        if not application_env_row_matches(candidates[0], key, value):
            actions.append(ApplicationEnvAction("update", key))
    return actions


def apply_application_env_action(
    *,
    api_url: str,
    token: str,
    app_uuid: str,
    action: ApplicationEnvAction,
    expected_env: dict[str, str],
) -> None:
    payload = application_env_payload(action.key, expected_env[action.key])
    if action.action == "create":
        request_json(
            api_url=api_url,
            token=token,
            method="POST",
            path=f"/api/v1/applications/{app_uuid}/envs",
            payload=payload,
        )
        return
    if action.action == "update":
        request_json(
            api_url=api_url,
            token=token,
            method="PATCH",
            path=f"/api/v1/applications/{app_uuid}/envs",
            payload=payload,
        )
        return
    raise SystemExit(f"Unknown application env action {action.action!r}")


def sync_application_env(
    *,
    api_url: str,
    token: str,
    app_name: str,
    app_uuid: str,
    expected_env: dict[str, str],
) -> None:
    if not expected_env:
        return

    payload = request_json(
        api_url=api_url,
        token=token,
        method="GET",
        path=f"/api/v1/applications/{app_uuid}/envs",
    )
    rows = get_payload_list(payload, "data")
    actions = plan_application_env_actions(rows=rows, expected_env=expected_env)
    if not actions:
        log(f"{app_name}: application_env=ok keys={len(expected_env)}")
        return

    for action in actions:
        apply_application_env_action(
            api_url=api_url,
            token=token,
            app_uuid=app_uuid,
            action=action,
            expected_env=expected_env,
        )
        log(f"{app_name}: application_env={action.action} key={action.key}")


def application_patch_payload(
    *,
    expected: dict[str, Any],
    image: str,
    tag: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for field, value in expected.get("fields", {}).items():
        if field == "build_pack":
            continue
        if value is None:
            continue
        if value == CONFIGURE_IN_COOLIFY_PLACEHOLDER:
            continue
        if value == EXPECT_COMMIT_PLACEHOLDER:
            payload[field] = tag
        else:
            payload[field] = value

    payload["docker_registry_image_name"] = image
    payload["docker_registry_image_tag"] = tag
    payload["git_commit_sha"] = tag
    return payload


def apps_for_deploy_scope(
    *,
    deploy_scope: str,
    api_app: tuple[str, str],
    worker_apps: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    if deploy_scope == "api-only":
        return [api_app]
    return [api_app, *worker_apps]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--stack-manifest",
        type=Path,
        default=Path(__file__).with_name("production-stack.json"),
    )
    parser.add_argument("--api-url", default=os.environ.get("COOLIFY_API_URL"))
    parser.add_argument("--token", default=os.environ.get("COOLIFY_TOKEN"))
    parser.add_argument(
        "--image",
        default=os.environ.get("CLAWDI_BACKEND_RUNTIME_IMAGE"),
        help="Runtime image name without tag.",
    )
    parser.add_argument(
        "--tag",
        default=os.environ.get("CLAWDI_BACKEND_RUNTIME_TAG"),
        help="Full git SHA tag to deploy.",
    )
    parser.add_argument("--no-deploy", action="store_true")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument(
        "--deploy-scope",
        choices=("api-only", "all"),
        default=os.environ.get("CLAWDI_DEPLOY_SCOPE", "api-only"),
        help="Applications to deploy after updating image tags.",
    )
    args = parser.parse_args()

    if not args.api_url:
        raise SystemExit("Set COOLIFY_API_URL or pass --api-url.")
    if not args.token:
        raise SystemExit("Set COOLIFY_TOKEN or pass --token.")
    if not args.image:
        raise SystemExit("Set CLAWDI_BACKEND_RUNTIME_IMAGE or pass --image.")
    if not args.tag or not FULL_GIT_SHA_RE.fullmatch(args.tag):
        raise SystemExit("--tag must be a full 40-character git SHA.")

    stack = load_stack_manifest(args.stack_manifest)
    applications: dict[str, dict[str, Any]] = stack["applications"]
    app_uuids = resolve_application_uuids(
        api_url=args.api_url,
        token=args.token,
        applications=applications,
        deployment_tag=stack.get("deployment_tag"),
    )
    api_app, worker_apps = applications_by_role(applications, app_uuids)
    apps_to_update = apps_for_deploy_scope(
        deploy_scope=args.deploy_scope,
        api_app=api_app,
        worker_apps=worker_apps,
    )
    apps_to_update_names = {app_name for app_name, _ in apps_to_update}

    log(f"runtime_image={args.image}:{args.tag}")
    log(
        f"applications={len(applications)} update_targets={len(apps_to_update)} "
        f"deploy={not args.no_deploy} deploy_scope={args.deploy_scope}"
    )

    for app_name, expected in applications.items():
        app_uuid = app_uuids[app_name]
        current = request_json(
            api_url=args.api_url,
            token=args.token,
            method="GET",
            path=f"/api/v1/applications/{app_uuid}",
        )
        current_build_pack = str(current.get("build_pack", ""))
        if current_build_pack != "dockerimage":
            raise SystemExit(
                f"{app_name}: expected Coolify Docker Image Application "
                f"(build_pack=dockerimage), found {current_build_pack!r}."
            )
        sync_application_env(
            api_url=args.api_url,
            token=args.token,
            app_name=app_name,
            app_uuid=app_uuid,
            expected_env=application_env(expected),
        )
        if app_name not in apps_to_update_names:
            log(f"{app_name}: image_tag=unchanged uuid={app_uuid}")
            continue
        request_json(
            api_url=args.api_url,
            token=args.token,
            method="PATCH",
            path=f"/api/v1/applications/{app_uuid}",
            payload=application_patch_payload(
                expected=expected,
                image=args.image,
                tag=args.tag,
            ),
        )
        log(f"{app_name}: application=updated uuid={app_uuid}")

    if args.no_deploy:
        return 0

    api_app_name, api_app_uuid = api_app

    if args.deploy_scope == "all":
        log("deployment_strategy=api-first-workers-concurrent")
        api_deployment_uuid = deploy_application(
            api_url=args.api_url,
            token=args.token,
            app_name=api_app_name,
            app_uuid=api_app_uuid,
        )
        if args.wait:
            wait_for_deployment(
                api_url=args.api_url,
                token=args.token,
                app_name=api_app_name,
                app_uuid=api_app_uuid,
                deployment_uuid=api_deployment_uuid,
                tag=args.tag,
                timeout_seconds=args.timeout_seconds,
            )
    else:
        log("deployment_strategy=api-only")
        api_deployment_uuid = deploy_application(
            api_url=args.api_url,
            token=args.token,
            app_name=api_app_name,
            app_uuid=api_app_uuid,
        )
        if args.wait:
            wait_for_deployment(
                api_url=args.api_url,
                token=args.token,
                app_name=api_app_name,
                app_uuid=api_app_uuid,
                deployment_uuid=api_deployment_uuid,
                tag=args.tag,
                timeout_seconds=args.timeout_seconds,
            )
        return 0

    queued_worker_deployments = deploy_applications(
        api_url=args.api_url,
        token=args.token,
        apps=worker_apps,
    )
    if args.wait:
        for app_name, app_uuid, deployment_uuid in queued_worker_deployments:
            wait_for_deployment(
                api_url=args.api_url,
                token=args.token,
                app_name=app_name,
                app_uuid=app_uuid,
                deployment_uuid=deployment_uuid,
                tag=args.tag,
                timeout_seconds=args.timeout_seconds,
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
