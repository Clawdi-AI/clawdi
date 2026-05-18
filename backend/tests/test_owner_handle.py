"""Owner-handle resolution - see spec section 11.2.

Definition: handle = kebab(users.name) + "-" + user.id.hex[:4].
Always suffixed for guaranteed global uniqueness. Requires
`users.name` (the user-visible display name column) to be non-NULL
and to kebab to a non-empty string - callers must gate on this
before invoking (share-link create returns 409 `display_name_required`).
"""

import uuid

import pytest

from app.models.user import User
from app.services.sharing import resolve_owner_handle


def _user(*, name: str | None = None, user_id_hex: str | None = None) -> User:
    return User(
        id=uuid.UUID(user_id_hex) if user_id_hex else uuid.uuid4(),
        clerk_id=f"clerk_{uuid.uuid4().hex[:8]}",
        email=None,
        name=name,
    )


def test_handle_combines_name_kebab_with_user_id_hex_suffix():
    u = _user(name="Alice Chen", user_id_hex="a3b4c5d600000000000000000000c0de")
    assert resolve_owner_handle(u) == "alice-chen-a3b4"


def test_handle_strips_non_alnum_from_name():
    u = _user(name="Bob (Robert) Smith!", user_id_hex="0102030400000000000000000000beef")
    assert resolve_owner_handle(u) == "bob-robert-smith-0102"


def test_handle_two_alices_get_different_suffixes():
    u1 = _user(name="Alice", user_id_hex="a3b4c5d600000000000000000000beef")
    u2 = _user(name="Alice", user_id_hex="f1e2d3c400000000000000000000c0de")
    h1 = resolve_owner_handle(u1)
    h2 = resolve_owner_handle(u2)
    assert h1 != h2
    assert h1.startswith("alice-")
    assert h2.startswith("alice-")


def test_handle_lowercases_and_kebabs_unicode_friendly():
    u = _user(name="ALICE Chen", user_id_hex="cafef00d00000000000000000000beef")
    assert resolve_owner_handle(u) == "alice-chen-cafe"


def test_handle_raises_when_user_name_empty():
    """Callers are responsible for gating on `users.name` presence."""
    u = _user(name=None, user_id_hex="0102030400000000000000000000beef")
    with pytest.raises(ValueError):
        resolve_owner_handle(u)


def test_handle_raises_when_user_name_only_punctuation():
    """A name like `???` kebabs to empty string."""
    u = _user(name="!!!", user_id_hex="0102030400000000000000000000beef")
    with pytest.raises(ValueError):
        resolve_owner_handle(u)
