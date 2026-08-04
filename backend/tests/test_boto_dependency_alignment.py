from __future__ import annotations

import tomllib
from importlib.metadata import version
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
BOTO_VERSION = "1.43.14"
BOTO_DISTRIBUTIONS = frozenset(
    {
        "boto3",
        "boto3-stubs",
        "botocore",
        "botocore-stubs",
        "mypy-boto3-s3",
    }
)


def test_boto_runtime_stubs_lock_and_metadata_use_one_exact_patch() -> None:
    project = tomllib.loads((BACKEND_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    direct_entries = [
        *project["project"]["dependencies"],
        *project["dependency-groups"]["dev"],
    ]
    direct = {
        canonicalize_name(requirement.name): requirement
        for entry in direct_entries
        if canonicalize_name((requirement := Requirement(entry)).name) in BOTO_DISTRIBUTIONS
    }

    assert direct.keys() == BOTO_DISTRIBUTIONS
    assert {str(requirement.specifier) for requirement in direct.values()} == {f"=={BOTO_VERSION}"}

    lock = tomllib.loads((BACKEND_ROOT / "uv.lock").read_text(encoding="utf-8"))
    locked = {
        canonicalize_name(package["name"]): package["version"]
        for package in lock["package"]
        if canonicalize_name(package["name"]) in BOTO_DISTRIBUTIONS
    }

    assert locked == dict.fromkeys(BOTO_DISTRIBUTIONS, BOTO_VERSION)
    assert {
        canonicalize_name(distribution): version(distribution)
        for distribution in BOTO_DISTRIBUTIONS
    } == dict.fromkeys(BOTO_DISTRIBUTIONS, BOTO_VERSION)

    documentation = (REPOSITORY_ROOT / "docs/backend-development.md").read_text(encoding="utf-8")
    for distribution in BOTO_DISTRIBUTIONS:
        assert f"`{distribution}=={BOTO_VERSION}`" in documentation
