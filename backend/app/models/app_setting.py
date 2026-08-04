from pydantic import JsonValue
from sqlalchemy import String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSetting(Base, TimestampMixin):
    """One typed, global application setting.

    Setting-specific validation belongs to the registry. Keeping persistence
    global-only makes every update an atomic replacement of one JSON value.
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[JsonValue] = mapped_column(JSONB(none_as_null=True), nullable=False)
