from __future__ import annotations

import ast
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).parents[1]

# Every renderer-input mutation family terminates at one of these functions.
# Adding a new write path requires extending this reviewed inventory.
MUTATION_AUTHORITIES = (
    (
        "app/services/sync_events.py",
        "queue_runtime_manifests_changed",
        "refresh_runtime_source_revisions",
    ),
    (
        "app/services/sync_events.py",
        "queue_runtime_manifest_changed",
        "queue_runtime_manifests_changed",
    ),
    (
        "app/services/sync_events.py",
        "queue_environment_runtime_manifest_changed",
        "queue_runtime_manifest_changed",
    ),
    (
        "app/services/sync_events.py",
        "queue_provider_runtime_manifest_changed",
        "queue_runtime_manifests_changed",
    ),
    (
        "app/services/ai_provider_auth_transition.py",
        "queue_provider_runtime_manifest_changed",
        "queue_manifest_change",
    ),
    (
        "app/services/ai_provider_auth_transition.py",
        "transition_ai_provider_auth",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/services/project_runtime_skills.py",
        "queue_project_runtime_manifest_changed",
        "queue_runtime_manifests_changed",
    ),
    (
        "app/services/sync_events.py",
        "bump_skills_revision",
        "queue_project_runtime_manifest_changed",
    ),
    ("app/routes/platform.py", "platform_upsert_runtime_state", "queue_runtime_manifest_changed"),
    ("app/routes/platform.py", "platform_delete_runtime_state", "queue_runtime_manifest_changed"),
    (
        "app/routes/platform.py",
        "platform_delete_agent",
        "queue_environment_runtime_manifest_changed",
    ),
    ("app/routes/admin.py", "_admin_upsert_runtime_state", "queue_runtime_manifest_changed"),
    ("app/routes/admin.py", "_admin_delete_runtime_state", "queue_runtime_manifest_changed"),
    (
        "app/routes/admin.py",
        "_admin_delete_environment",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/sessions.py",
        "_delete_agent_identity",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/runtime.py",
        "get_runtime_manifest",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/plugin_catalog.py",
        "put_agent_plugin_desired_state",
        "queue_runtime_manifest_changed",
    ),
    (
        "app/routes/plugin_catalog.py",
        "delete_agent_plugin_desired_state",
        "queue_runtime_manifest_changed",
    ),
    (
        "app/services/ai_provider_auth_transition.py",
        "transition_ai_provider_auth",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/ai_providers.py",
        "upsert_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/ai_providers.py",
        "patch_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/ai_providers.py",
        "_accept_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/ai_providers.py",
        "resolve_ai_provider_auth",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/admin.py",
        "admin_upsert_clawdi_managed_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/admin.py",
        "admin_replace_deployment_managed_ai_provider_metadata",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/admin.py",
        "admin_cleanup_deployment_managed_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/admin.py",
        "admin_delete_clawdi_managed_ai_provider",
        "queue_provider_runtime_manifest_changed",
    ),
    (
        "app/routes/channel_routers/public.py",
        "_queue_agent_link_runtime_changed",
        "queue_environment_runtime_manifest_changed",
    ),
    ("app/routes/channel_routers/public.py", "create_channel", "_queue_agent_link_runtime_changed"),
    ("app/routes/channel_routers/public.py", "delete_channel", "_queue_agent_link_runtime_changed"),
    (
        "app/routes/channel_routers/public.py",
        "create_channel_pair_code",
        "_queue_agent_link_runtime_changed",
    ),
    (
        "app/routes/channel_routers/public.py",
        "create_channel_agent_link",
        "_queue_agent_link_runtime_changed",
    ),
    (
        "app/routes/channel_routers/public.py",
        "rotate_channel_agent_link_token",
        "_queue_agent_link_runtime_changed",
    ),
    (
        "app/routes/channel_routers/public.py",
        "delete_channel_agent_link",
        "_queue_agent_link_runtime_changed",
    ),
    ("app/routes/admin.py", "admin_delete_channel", "queue_environment_runtime_manifest_changed"),
    ("app/routes/admin.py", "admin_update_channel", "queue_runtime_manifests_changed"),
    (
        "app/routes/channel_routers/whatsapp.py",
        "_run_whatsapp_baileys_websocket",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/channel_routers/whatsapp.py",
        "_resolve_whatsapp_noise_lid",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/services/agent_bindings.py",
        "delete_project_bindings_for_users",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/services/agent_bindings.py",
        "attach_project_to_owned_agents",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/services/agent_bindings.py",
        "attach_projects_to_owned_agent",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/services/agent_bindings.py",
        "update_owned_agent_project_links",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/services/agent_bindings.py",
        "update_project_owned_agent_links",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/agent_project_bindings.py",
        "list_project_bindings",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/agent_project_bindings.py",
        "add_context_project_binding",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/agent_project_bindings.py",
        "reorder_context_project_bindings",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/agent_project_bindings.py",
        "delete_project_binding",
        "queue_environment_runtime_manifest_changed",
    ),
    (
        "app/routes/projects.py",
        "archive_project",
        "queue_project_runtime_manifest_changed",
    ),
    (
        "app/services/principal_lifecycle.py",
        "complete_principal_cleanup",
        "queue_project_runtime_manifest_changed",
    ),
    ("app/routes/skills.py", "refresh_project_skill", "bump_skills_revision"),
    ("app/routes/skills.py", "_do_upload_skill", "bump_skills_revision"),
    ("app/routes/skills.py", "_do_delete_agent_synced_skill", "bump_skills_revision"),
    ("app/routes/skills.py", "_do_delete_skill", "bump_skills_revision"),
    ("app/routes/skills.py", "_upsert_skill", "bump_skills_revision"),
    (
        "app/services/agent_skill_projection.py",
        "delete_agent_project_skill_rows",
        "bump_skills_revision",
    ),
)


def _awaited_calls(path: str, function_name: str) -> set[str]:
    tree = ast.parse((BACKEND_ROOT / path).read_text())
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == function_name
    )
    calls: set[str] = set()
    for awaited in (node for node in ast.walk(function) if isinstance(node, ast.Await)):
        for call in (node for node in ast.walk(awaited.value) if isinstance(node, ast.Call)):
            if isinstance(call.func, ast.Name):
                calls.add(call.func.id)
            elif isinstance(call.func, ast.Attribute):
                calls.add(call.func.attr)
    return calls


@pytest.mark.parametrize(
    ("path", "function_name", "authority"),
    MUTATION_AUTHORITIES,
)
def test_runtime_source_mutations_await_revision_authority(
    path: str,
    function_name: str,
    authority: str,
) -> None:
    assert authority in _awaited_calls(path, function_name)
