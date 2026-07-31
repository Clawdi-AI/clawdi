"""Enforce uv as the backend's sole dependency and lock authority."""

from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    required = BACKEND_ROOT / "uv.lock"
    forbidden = ("pdm.lock", "poetry.lock", "Pipfile.lock", "requirements.txt")
    if not required.is_file():
        raise SystemExit("dependency-authority: backend/uv.lock is required")
    present = [name for name in forbidden if (BACKEND_ROOT / name).exists()]
    if present:
        raise SystemExit(f"dependency-authority: non-uv lock authority found: {', '.join(present)}")
    print("dependency-authority: uv.lock is the sole backend lock authority")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
