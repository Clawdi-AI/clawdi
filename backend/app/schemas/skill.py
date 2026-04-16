from pydantic import BaseModel


class SkillCreate(BaseModel):
    skill_key: str
    name: str
    content: str
    agent_types: list[str] | None = None


class SkillBatchRequest(BaseModel):
    skills: list[SkillCreate]


class SkillInstallRequest(BaseModel):
    repo: str          # owner/repo
    path: str | None = None  # subdirectory within repo
