from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "clawdi-image-release.yml"
WORKFLOW_TEXT = WORKFLOW_PATH.read_text(encoding="utf-8")


def load_workflow() -> dict[str, Any]:
    workflow = yaml.load(WORKFLOW_TEXT, Loader=yaml.BaseLoader)
    assert isinstance(workflow, dict)
    return workflow


def named_step(job: dict[str, Any], name: str) -> dict[str, Any]:
    for step in job["steps"]:
        if step.get("name") == name:
            return step
    raise AssertionError(f"Missing workflow step: {name}")


def test_workflow_run_requires_successful_same_repository_main_push() -> None:
    workflow = load_workflow()
    workflow_run = workflow["on"]["workflow_run"]
    assert workflow_run["workflows"] == ["Backend CI"]
    assert workflow_run["types"] == ["completed"]
    assert workflow_run["branches"] == ["main"]

    publish_gate = workflow["jobs"]["publish"]["if"]
    for required_check in (
        "github.event_name == 'workflow_run'",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
        "github.event.workflow_run.repository.full_name == github.repository",
    ):
        assert required_check in publish_gate


def test_manual_production_deploy_requires_current_main_commit() -> None:
    publish = load_workflow()["jobs"]["publish"]
    source_step = named_step(publish, "Resolve source ref")
    assert source_step["env"]["DISPATCH_REF"] == "${{ inputs.ref }}"
    assert 'git check-ref-format --allow-onelevel "$ref"' in source_step["run"]
    assert '[[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]' in source_step["run"]

    deploy_mode = named_step(publish, "Resolve deploy mode")
    assert deploy_mode["env"]["DISPATCH_DEPLOY"] == "${{ inputs.deploy }}"
    assert deploy_mode["env"]["SOURCE_SHA"] == "${{ steps.rev.outputs.sha }}"
    assert '[ "$GITHUB_REF" != "refs/heads/main" ]' in deploy_mode["run"]
    assert '[ "$SOURCE_SHA" != "$GITHUB_SHA" ]' in deploy_mode["run"]
    assert '[ "$SOURCE_SHA" != "$WORKFLOW_RUN_HEAD_SHA" ]' in deploy_mode["run"]


@pytest.mark.parametrize(
    ("event_env", "expected_output"),
    (
        (
            {
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/main",
                "DISPATCH_DEPLOY": "true",
            },
            "deploy_scope=api-only\nshould_deploy=true\n",
        ),
        (
            {
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/feature",
                "DISPATCH_DEPLOY": "true",
            },
            None,
        ),
        (
            {
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/main",
                "DISPATCH_DEPLOY": "true",
                "SOURCE_SHA": "b" * 40,
            },
            None,
        ),
        (
            {
                "GITHUB_EVENT_NAME": "workflow_run",
                "AUTO_DEPLOY": "true",
            },
            "deploy_scope=all\nshould_deploy=true\n",
        ),
        (
            {
                "GITHUB_EVENT_NAME": "workflow_run",
                "AUTO_DEPLOY": "true",
                "WORKFLOW_RUN_HEAD_SHA": "b" * 40,
            },
            None,
        ),
    ),
)
def test_deploy_mode_fails_closed(
    tmp_path: Path,
    event_env: dict[str, str],
    expected_output: str | None,
) -> None:
    publish = load_workflow()["jobs"]["publish"]
    deploy_mode = named_step(publish, "Resolve deploy mode")
    output_path = tmp_path / "github-output"
    trusted_sha = "a" * 40
    env = {
        "AUTO_DEPLOY": "false",
        "DISPATCH_DEPLOY": "false",
        "DISPATCH_DEPLOY_SCOPE": "api-only",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_OUTPUT": str(output_path),
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": trusted_sha,
        "SOURCE_SHA": trusted_sha,
        "WORKFLOW_RUN_HEAD_SHA": trusted_sha,
        **event_env,
    }

    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", deploy_mode["run"]],
        check=False,
        capture_output=True,
        env=env,
        text=True,
    )

    if expected_output is None:
        assert result.returncode != 0
        return
    assert result.returncode == 0, result.stderr
    assert output_path.read_text(encoding="utf-8") == expected_output


def test_publish_and_production_jobs_have_separate_authority() -> None:
    workflow = load_workflow()
    jobs = workflow["jobs"]
    publish = jobs["publish"]

    assert workflow["permissions"] == {"contents": "read"}
    assert publish["permissions"] == {"contents": "read", "packages": "write"}
    assert "environment" not in publish
    assert "COOLIFY_API_URL" not in str(publish)
    assert "COOLIFY_TOKEN" not in str(publish)

    for job_name in ("deploy-production", "audit-production"):
        production_job = jobs[job_name]
        assert production_job["needs"] == "publish"
        assert production_job["environment"] == "production"
        assert production_job["permissions"] == {"contents": "read"}
        assert "needs.publish.outputs.should_deploy == 'true'" in production_job["if"]

    secret_names = set(re.findall(r"secrets\.([A-Z0-9_]+)", WORKFLOW_TEXT))
    assert secret_names == {"COOLIFY_API_URL", "COOLIFY_TOKEN"}
    assert WORKFLOW_TEXT.count("packages: write") == 1


def test_shell_steps_receive_expressions_through_environment() -> None:
    workflow = load_workflow()
    for job_name, job in workflow["jobs"].items():
        for step in job["steps"]:
            run = step.get("run")
            if run is not None:
                assert "${{" not in run, f"{job_name}/{step.get('name', step.get('id'))}"
                syntax = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-n", "-c", run],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                assert syntax.returncode == 0, syntax.stderr


def test_production_jobs_do_not_control_tenants_or_business_apis() -> None:
    workflow = load_workflow()
    jobs = workflow["jobs"]
    deploy_run = named_step(jobs["deploy-production"], "Deploy Coolify Applications")["run"]
    audit_runs = [
        step["run"]
        for job_name in ("deploy-production", "audit-production")
        for step in jobs[job_name]["steps"]
        if step.get("name") == "Audit Coolify Applications"
    ]

    assert "infra/deploy/coolify/deploy_ghcr_runtime.py" in deploy_run
    assert all("infra/deploy/coolify/audit_stack.py" in run for run in audit_runs)
    for forbidden in (
        "repository_dispatch",
        "workflow_call",
        "CLAWDI_AUTH_TOKEN",
        "ADMIN_API_KEY",
        "/v1/admin",
        "tenant",
    ):
        assert forbidden not in WORKFLOW_TEXT
