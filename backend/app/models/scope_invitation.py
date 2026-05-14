"""Compatibility alias for legacy `ScopeInvitation` imports.

User-facing terminology moved to Project in pass 1.
"""

from app.models.project_invitation import ProjectInvitation

ScopeInvitation = ProjectInvitation
