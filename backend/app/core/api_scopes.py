"""Canonical API permission bundles for Clawdi runtimes."""

RUNTIME_MCP_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:metadata:read",
)

RUNTIME_DEPLOYMENT_KEY_SCOPES = (
    *RUNTIME_MCP_SCOPES,
    "runtime-observations:write",
)
