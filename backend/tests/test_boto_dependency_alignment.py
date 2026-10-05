from __future__ import annotations

import tomllib
from importlib.metadata import packages_distributions, version
from pathlib import Path

from mypy_boto3_s3.version import __version__ as s3_stub_version
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BOTO_DISTRIBUTIONS = frozenset(
    {
        "boto3",
        "boto3-stubs",
        "boto3-stubs-full",
        "botocore",
        "botocore-stubs",
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

    lock = tomllib.loads((BACKEND_ROOT / "uv.lock").read_text(encoding="utf-8"))
    locked = {
        canonicalize_name(package["name"]): package["version"]
        for package in lock["package"]
        if canonicalize_name(package["name"]) in BOTO_DISTRIBUTIONS
    }

    assert locked.keys() == BOTO_DISTRIBUTIONS
    assert len(set(locked.values())) == 1
    assert {str(requirement.specifier) for requirement in direct.values()} == {
        f"=={locked['boto3']}"
    }
    assert {
        canonicalize_name(distribution): version(distribution)
        for distribution in BOTO_DISTRIBUTIONS
    } == locked
    assert packages_distributions()["mypy_boto3_s3"] == ["boto3-stubs-full"]
    assert s3_stub_version == locked["boto3"]
