"""Index searchable text chunks from skill archives."""

from __future__ import annotations

import io
import tarfile
from dataclasses import dataclass
from pathlib import PurePosixPath

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.skill import Skill
from app.models.skill_chunk import SkillChunk

_TEXT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".css",
    ".csv",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mdx",
    ".py",
    ".rst",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
_TEXT_FILE_NAMES = {"Dockerfile", "Makefile", "SKILL.md"}
_MAX_FILE_BYTES = 512 * 1024
_MAX_CHUNK_CHARS = 6000
_CHUNK_OVERLAP_CHARS = 500


@dataclass(frozen=True)
class SkillTextFile:
    path: str
    content: str


def extract_skill_text_files(data: bytes, skill_key: str) -> list[SkillTextFile]:
    """Extract UTF-8 text files from a validated skill tarball."""
    files: list[SkillTextFile] = []
    strip_count = len(skill_key.split("/"))
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile() or member.size > _MAX_FILE_BYTES:
                continue
            relative_path = _relative_skill_path(member.name, strip_count)
            if not relative_path or not _is_indexable_text_path(relative_path):
                continue
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            try:
                content = extracted.read().decode("utf-8")
            except UnicodeDecodeError:
                continue
            content = content.strip()
            if content:
                files.append(SkillTextFile(path=relative_path, content=content))
    files.sort(key=lambda item: item.path)
    return files


async def index_skill_archive(db: AsyncSession, skill: Skill, data: bytes) -> int:
    """Replace indexed chunks for a skill archive. Caller commits."""
    await db.execute(delete(SkillChunk).where(SkillChunk.skill_id == skill.id))

    inserted = 0
    for text_file in extract_skill_text_files(data, skill.skill_key):
        for chunk_index, chunk in enumerate(_chunk_text(text_file.content)):
            db.add(
                SkillChunk(
                    skill_id=skill.id,
                    user_id=skill.user_id,
                    project_id=skill.project_id,
                    skill_key=skill.skill_key,
                    content_hash=skill.content_hash,
                    file_path=text_file.path,
                    chunk_index=chunk_index,
                    content=chunk,
                    embedding=None,
                )
            )
            inserted += 1
    await db.flush()
    return inserted


def _relative_skill_path(member_name: str, strip_count: int) -> str:
    parts = PurePosixPath(member_name).parts
    if len(parts) <= strip_count:
        return ""
    return "/".join(parts[strip_count:])


def _is_indexable_text_path(path: str) -> bool:
    posix = PurePosixPath(path)
    if posix.name in _TEXT_FILE_NAMES:
        return True
    return posix.suffix.lower() in _TEXT_EXTENSIONS


def _chunk_text(content: str) -> list[str]:
    if len(content) <= _MAX_CHUNK_CHARS:
        return [content]

    chunks: list[str] = []
    start = 0
    step = _MAX_CHUNK_CHARS - _CHUNK_OVERLAP_CHARS
    while start < len(content):
        chunk = content[start : start + _MAX_CHUNK_CHARS].strip()
        if chunk:
            chunks.append(chunk)
        start += step
    return chunks
