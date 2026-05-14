"""Compatibility alias for legacy `ScopeShareLink` imports.

User-facing terminology moved to Project in pass 1.
"""

from app.models.project_share_link import ProjectShareLink

ScopeShareLink = ProjectShareLink
