"""Compatibility alias for legacy `ScopeMembership` imports.

User-facing terminology moved to Project in pass 1.
"""

from app.models.project_membership import ProjectMembership

ScopeMembership = ProjectMembership
