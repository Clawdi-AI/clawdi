"""Clawdi MCP endpoint with internal Composio Tool Router forwarding."""

import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote, unquote, urlsplit
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StrictInt,
    StrictStr,
    TypeAdapter,
    ValidationError,
    field_validator,
)
from sqlalchemy import cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import String

from app.core.auth import (
    AuthContext,
    get_auth,
    is_env_bound_api_key,
    is_runtime_deployment_principal,
    require_auth_scopes,
    require_clerk_id,
)
from app.core.database import get_session
from app.core.project import project_ids_visible_to, resolve_default_write_project
from app.core.query_utils import like_needle
from app.models.project import Project
from app.models.session import AgentEnvironment, Session
from app.models.vault import Vault, VaultItem, VaultProjectAttachment
from app.routes.memories import attach_source_machines
from app.routes.public_sessions import resolve_session_for_view
from app.services.composio import (
    ComposioMcpUpstreamError,
    ComposioRouteError,
    call_tool_router_mcp_tool,
    get_tool_router_mcp_session,
    get_tool_router_mcp_tools,
    list_tool_router_mcp_tools,
    verify_mcp_bridge_token,
)
from app.services.file_store import get_file_store
from app.services.memory_provider import get_memory_provider
from app.services.secret_detection import find_likely_secret, secret_memory_warning
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    load_session_messages,
)
from app.services.session_export import session_to_markdown
from app.services.vault_crypto import decrypt

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/mcp", tags=["mcp"])
file_store = get_file_store()
type JsonObject = dict[str, JsonValue]
_JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
_HTTP_EXCEPTION_DETAIL_ADAPTER: TypeAdapter[str] = TypeAdapter(StrictStr)

MCP_PROTOCOL_VERSION = "2025-06-18"
_SHARE_URL_RE = re.compile(
    r"/s/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b",
    re.IGNORECASE,
)


class _ToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _NoArguments(_ToolArguments):
    pass


class _MemorySearchArguments(_ToolArguments):
    query: StrictStr = Field(min_length=1, max_length=2_000)
    limit: StrictInt = Field(default=10, ge=1, le=50)

    @field_validator("query")
    @classmethod
    def _strip_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("query is required")
        return value


class _MemoryAddArguments(_ToolArguments):
    content: StrictStr = Field(min_length=1, max_length=20_000)
    category: Literal["fact", "preference", "pattern", "decision", "context"] = "fact"

    @field_validator("content")
    @classmethod
    def _strip_content(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("content is required")
        return value


class _SessionSearchArguments(_ToolArguments):
    query: StrictStr = Field(min_length=1, max_length=2_000)
    limit: StrictInt = Field(default=10, ge=1, le=20)

    @field_validator("query")
    @classmethod
    def _strip_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("query is required")
        return value


class _SessionReadArguments(_ToolArguments):
    reference: StrictStr = Field(min_length=1, max_length=2_000)

    @field_validator("reference")
    @classmethod
    def _strip_reference(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reference is required")
        return value


class _ProjectListArguments(_ToolArguments):
    limit: StrictInt = Field(default=50, ge=1, le=100)


class _ProjectGetArguments(_ToolArguments):
    project_id: StrictStr = Field(min_length=36, max_length=36)

    @field_validator("project_id")
    @classmethod
    def _validate_project_id(cls, value: str) -> str:
        try:
            UUID(value)
        except ValueError as exc:
            raise ValueError("invalid project id") from exc
        return value


class _VaultListArguments(_ToolArguments):
    project_id: StrictStr | None = Field(default=None, min_length=36, max_length=36)
    limit: StrictInt = Field(default=50, ge=1, le=100)

    @field_validator("project_id")
    @classmethod
    def _validate_project_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            UUID(value)
        except ValueError as exc:
            raise ValueError("invalid project id") from exc
        return value


class _VaultGetArguments(_ToolArguments):
    project_id: StrictStr = Field(min_length=36, max_length=36)
    vault_id: StrictStr = Field(min_length=36, max_length=36)

    @field_validator("project_id", "vault_id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        try:
            UUID(value)
        except ValueError as exc:
            raise ValueError("invalid resource id") from exc
        return value


class _VaultResolveArguments(_ToolArguments):
    reference: StrictStr = Field(min_length=1, max_length=1_000)

    @field_validator("reference")
    @classmethod
    def _strip_reference(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reference is required")
        return value


def _validate_arguments[ArgumentsT: _ToolArguments](
    model: type[ArgumentsT], arguments: JsonObject
) -> ArgumentsT:
    try:
        return model.model_validate(arguments)
    except ValidationError:
        # Pydantic details can echo hostile input and implementation names.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid tool arguments") from None


type _NativeToolHandler = Callable[[JsonObject, AuthContext, AsyncSession], Awaitable[JsonObject]]


@dataclass(frozen=True)
class _NativeToolSpec:
    description: str
    input_schema: object
    scopes: tuple[str, ...]
    handler: _NativeToolHandler

    def definition(self, name: str) -> JsonObject:
        return {
            "name": name,
            "description": self.description,
            "inputSchema": _JSON_OBJECT_ADAPTER.validate_python(self.input_schema),
        }


_NATIVE_TOOL_REGISTRY: dict[str, _NativeToolSpec] = {
    "memory_search": _NativeToolSpec(
        description=(
            "ALWAYS call this BEFORE answering any question that references the user's own "
            "context — their preferences, projects, past decisions, named entities, or work "
            "history. A missed hit costs the user's trust every subsequent turn; a call that "
            "returns empty costs ~100ms. Bias toward calling. Works in any language — pass "
            "the user's query through as-is.\n\n"
            "MUST call when the user's message contains ANY of these signals (in English, "
            "Chinese, or any other language):\n"
            '- First-person self-reference in a question about themselves: possessives like "my", '
            'verbs of habit like "I usually", "I prefer", "I always"\n'
            '- Preference / habit questions, even phrased abstractly: "what do I usually use for '
            'X", "how do I normally do Y", "what\'s my preferred tool for Z" — these MUST trigger '
            "even when no specific entity is named\n"
            '- Callbacks to past context: "like last time", "as I mentioned", "you know the one", '
            '"we discussed before", "what was that X"\n'
            "- Named entities specific to this user: their project / repo / service / team / tool "
            "name, or a person by name\n"
            "- Any reference to a past bug, decision, investigation, meeting, or design choice\n\n"
            "Do NOT call for pure textbook / generic programming questions with zero "
            'user-specific signal (e.g. "how does async/await work").\n\n'
            "When in doubt, CALL IT. Zero results is cheap; a missed memory makes you look "
            "amnesic."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Natural-language query in any language — the search does semantic "
                        "matching, no keyword optimization needed. Pass the user's own phrasing "
                        "(translation not required) or a short rewrite that captures intent. "
                        'Examples: "user\'s name", "coding style preference", "command-line '
                        'tools the user prefers", "how we fixed the login bug", "Clerk auth '
                        'reasoning", "project architecture".'
                    ),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Max results to return. Default 10.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        scopes=("memories:read",),
        handler=lambda arguments, auth, db: _tool_memory_search(arguments, auth=auth, db=db),
    ),
    "memory_add": _NativeToolSpec(
        description=(
            "Store a durable memory so future agent sessions (same agent, or a different one) "
            "can retrieve this context. Call this when you learn something non-obvious about "
            "the user or their project that a future session would benefit from knowing.\n\n"
            "MUST call when:\n"
            '- The user explicitly asks you to remember something ("remember this", "save '
            'this", or equivalent in any language) — always honor the request\n'
            '- You just fixed a non-trivial bug — save ROOT CAUSE + fix, not just "bug fixed"\n'
            "- You and the user made an architecture decision together — save the decision AND "
            "the reasoning (why this option over alternatives)\n"
            "- The user expressed a coding / workflow preference you had to ask about — save it "
            'so you or another agent never asks again (e.g. "user prefers pnpm over npm")\n'
            "- The user shared personal info (their name, their project name, their team, who "
            "they work with) that future context would need\n\n"
            "Do NOT save:\n"
            "- Trivia that any agent can discover by reading the current code\n"
            "- Generic programming knowledge (how APIs work, language features)\n"
            '- Ephemeral conversation details ("the user asked about X today")\n'
            "- Plaintext tokens, API keys, bearer credentials, or private keys; use Vault and "
            "save a clawdi:// reference instead\n\n"
            "Write the content as a standalone sentence with full context — include proper "
            "nouns, not pronouns. A future session will read it without today's conversation. "
            "Content language should match the user's primary language for that context."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": (
                        "The memory content. Standalone sentence that makes sense in isolation. "
                        'Examples: "The user prefers rg over grep and fd over find.", "We chose '
                        'Clerk over Auth0 because the team already had a Clerk account."'
                    ),
                },
                "category": {
                    "type": "string",
                    "enum": ["fact", "preference", "pattern", "decision", "context"],
                    "description": (
                        "fact — technical facts, API details, config values. preference — user "
                        "preferences, coding style, workflow choices. pattern — recurring "
                        "patterns, pitfalls, team conventions. decision — architecture decisions "
                        "and their reasoning. context — project context, deadlines, ongoing "
                        "work. Default: fact."
                    ),
                },
            },
            "required": ["content"],
            "additionalProperties": False,
        },
        scopes=("memories:write",),
        handler=lambda arguments, auth, db: _tool_memory_add(arguments, auth=auth, db=db),
    ),
    "memory_extract": _NativeToolSpec(
        description=(
            "Propose durable long-term memories from the CURRENT conversation, list them to "
            "the user, and save only what they approve. Call this when the user asks to "
            "'extract memories', 'save what we discussed', 'remember this conversation', or "
            "any equivalent phrasing (in any language). The tool returns instructions — follow "
            "them exactly: list up to 5 candidates first, wait for the user's confirmation, "
            "then call memory_add on the approved ones. Do not narrate your internal workflow. "
            "This tool inspects your active conversation context — it does NOT read any "
            "external file or database."
        ),
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        scopes=("memories:read", "memories:write"),
        handler=lambda arguments, auth, db: _tool_memory_extract(arguments, auth=auth, db=db),
    ),
    "session_search": _NativeToolSpec(
        description=(
            "Search the user's past Clawdi sessions by keyword. Use when the user asks about "
            "prior work (e.g. 'find the auth migration session'). Returns up to N matching "
            "sessions with summary, agent, model, project, date, and message count. The "
            "session UUID in each result can be passed back to session_read to fetch the full "
            "conversation."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keyword query — matches session summary and metadata.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "description": "Max sessions to return. Default 10.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        scopes=("sessions:read",),
        handler=lambda arguments, auth, db: _tool_session_search(arguments, auth=auth, db=db),
    ),
    "session_read": _NativeToolSpec(
        description=(
            "Read a Clawdi session and return its content as Markdown so you can ingest the "
            "conversation as context. Use this when the user references a Clawdi share URL "
            "(https://cloud.clawdi.ai/s/{uuid}) or one of their own sessions by UUID. Handles "
            "owned + shared sessions uniformly — you don't need to know which one. Returns a "
            "YAML front-matter block (source/agent/model/project/messages) followed by "
            "`## User` / `## Assistant` turn headings."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "description": (
                        "Either a full Clawdi share URL (https://cloud.clawdi.ai/s/{uuid}) or a "
                        "bare session UUID."
                    ),
                },
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
        scopes=("sessions:read",),
        handler=lambda arguments, auth, db: _tool_session_read(arguments, auth=auth, db=db),
    ),
    "project_current": _NativeToolSpec(
        description=(
            "Return the caller's current/bound Clawdi Project. Hosted runtimes always "
            "receive only the Project bound to their authenticated environment."
        ),
        input_schema=_NoArguments.model_json_schema(),
        scopes=("projects:read",),
        handler=lambda arguments, auth, db: _tool_project_current(arguments, auth=auth, db=db),
    ),
    "project_list": _NativeToolSpec(
        description=(
            "List Projects visible to the authenticated caller. Hosted runtimes are "
            "restricted to their bound environment Project. This tool is read-only."
        ),
        input_schema=_ProjectListArguments.model_json_schema(),
        scopes=("projects:read",),
        handler=lambda arguments, auth, db: _tool_project_list(arguments, auth=auth, db=db),
    ),
    "project_get": _NativeToolSpec(
        description=(
            "Read safe metadata for one visible Clawdi Project by UUID. Inaccessible "
            "Projects are reported as not found. This tool is read-only."
        ),
        input_schema=_ProjectGetArguments.model_json_schema(),
        scopes=("projects:read",),
        handler=lambda arguments, auth, db: _tool_project_get(arguments, auth=auth, db=db),
    ),
    "vault_list": _NativeToolSpec(
        description=(
            "List Vault metadata attached to visible Projects. Returns Vault names, "
            "slugs, Project provenance, and key counts only; never secret values."
        ),
        input_schema=_VaultListArguments.model_json_schema(),
        scopes=("vault:read",),
        handler=lambda arguments, auth, db: _tool_vault_list(arguments, auth=auth, db=db),
    ),
    "vault_get": _NativeToolSpec(
        description=(
            "List key names and exact clawdi:// references for one Vault attachment. "
            "Returns Project/Vault provenance and never decrypts or returns secret values."
        ),
        input_schema=_VaultGetArguments.model_json_schema(),
        scopes=("vault:read",),
        handler=lambda arguments, auth, db: _tool_vault_get(arguments, auth=auth, db=db),
    ),
    "vault_resolve": _NativeToolSpec(
        description=(
            "Resolve one exact Project-scoped clawdi:// reference to its plaintext secret. "
            "Call only when the current task requires the value. The result is sensitive: "
            "never echo it, store it in Memory, or include it in logs. Hosted runtimes are "
            "restricted to their bound Project."
        ),
        input_schema=_VaultResolveArguments.model_json_schema(),
        scopes=("vault:read",),
        handler=lambda arguments, auth, db: _tool_vault_resolve(arguments, auth=auth, db=db),
    ),
}

_MEMORY_EXTRACT_INSTRUCTIONS = (
    "Review the CURRENT conversation silently and propose up to 5 durable memories worth "
    "saving for future sessions. Pick the highest-signal. Fewer is better — a confident 1-2 "
    "beats 5 mediocre. Do not fabricate candidates to fill the list.\n\n"
    "Dedup first, silently: for each candidate, call memory_search on its key topic and drop "
    "any that already have a clear match stored.\n\n"
    "If nothing qualifies — either because no candidate was durable, or because every "
    'candidate was already saved — reply "nothing worth extracting" (or "everything useful '
    'is already saved") and stop.\n\n'
    "Otherwise, present the surviving candidates to the user as a numbered list. For each: "
    "[category] full-sentence content, using proper nouns, not pronouns.\n\n"
    "Wait for the user's reply. Do NOT call memory_add yet.\n\n"
    "On approval, call memory_add once per approved memory, using the category and content "
    "from the candidate (with any edits the user asked for). Then print a bullet summary "
    "with the stored IDs so the user can delete individual ones later.\n\n"
    "Do NOT narrate your internal workflow to the user. The user should see only the "
    "candidate list, their own reply, and the final save summary — nothing else.\n\n"
    "What qualifies as durable: user preferences / habits (tools, style, workflow); "
    "architecture / design decisions and their reasoning; recurring patterns, team "
    "conventions, pitfalls worked through; named entities specific to the user; anything "
    "the user explicitly asked you to remember.\n\n"
    "Does NOT qualify: one-off debugging details with no broader lesson; code snippets "
    "(unless they demonstrate a preferred pattern); anything readable from the current code "
    "state; conversational noise."
)


def _extract_legacy_mcp_user_id(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing auth token")
    try:
        return verify_mcp_bridge_token(authorization[7:])
    except (jwt.PyJWTError, RuntimeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from None


# Deprecated compatibility bridge for legacy clients. Keep hidden from OpenAPI;
# new clients authenticate normally and use POST /v1/mcp/clawdi.
@router.post("/composio", include_in_schema=False)
async def mcp_composio_post(request: Request) -> JsonObject:
    user_id = _extract_legacy_mcp_user_id(request)
    body = await _read_request_json(request)
    if not isinstance(body, dict):
        return _mcp_error(None, -32600, "Invalid Request")

    rpc_id = body.get("id")
    method = body.get("method")
    if not isinstance(method, str) or method not in {"tools/list", "tools/call"}:
        return _mcp_error(rpc_id, -32601, "Method not found")

    try:
        session = await get_tool_router_mcp_session(user_id)
        if method == "tools/list":
            result = await list_tool_router_mcp_tools(session)
        else:
            params = body.get("params")
            if not isinstance(params, dict):
                return _mcp_error(rpc_id, -32602, "Invalid params")
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if not isinstance(name, str) or not isinstance(arguments, dict):
                return _mcp_error(rpc_id, -32602, "Invalid params")
            result = await call_tool_router_mcp_tool(session, name, arguments)
    except (ComposioMcpUpstreamError, ComposioRouteError) as exc:
        logger.error(
            "Legacy Composio MCP error: method=%s error_type=%s", method, type(exc).__name__
        )
        return _mcp_error(rpc_id, -32000, "internal error")

    serialized_result = _JSON_OBJECT_ADAPTER.validate_json(
        result.model_dump_json(by_alias=True, exclude_none=True)
    )
    return _mcp_result(rpc_id, serialized_result)


@router.post("/clawdi", include_in_schema=False, response_model=None)
async def mcp_clawdi_post(
    request: Request,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> JsonObject | list[JsonObject] | Response:
    """Agent-facing stateless MCP endpoint backed directly by Clawdi Cloud."""
    body = await _read_request_json(request)
    if isinstance(body, list):
        responses = [
            response
            for response in [
                await _handle_clawdi_mcp_request(item, auth=auth, db=db)
                for item in body
                if isinstance(item, dict)
            ]
            if response is not None
        ]
        if not responses:
            return Response(status_code=status.HTTP_202_ACCEPTED)
        return responses
    if not isinstance(body, dict):
        return _mcp_error(None, -32600, "Invalid Request")
    response = await _handle_clawdi_mcp_request(body, auth=auth, db=db)
    if response is None:
        return Response(status_code=status.HTTP_202_ACCEPTED)
    return response


async def _handle_clawdi_mcp_request(
    body: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject | None:
    rpc_id = body.get("id")
    method = body.get("method")
    if not isinstance(method, str):
        return _mcp_error(rpc_id, -32600, "Invalid Request")
    if rpc_id is None and method.startswith("notifications/"):
        return None
    try:
        if method == "initialize":
            return _mcp_result(
                rpc_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {
                        "name": "clawdi",
                        "title": "Clawdi Cloud",
                        "version": "1.0.0",
                    },
                },
            )
        if method == "ping":
            return _mcp_result(rpc_id, {})
        if method == "tools/list":
            tools: list[JsonValue] = [tool for tool in await _list_clawdi_mcp_tools(auth)]
            return _mcp_result(rpc_id, {"tools": tools})
        if method == "tools/call":
            params = body.get("params")
            if not isinstance(params, dict):
                return _mcp_error(rpc_id, -32602, "Invalid params")
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if not isinstance(name, str) or not isinstance(arguments, dict):
                return _mcp_error(rpc_id, -32602, "Invalid params")
            return _mcp_result(
                rpc_id,
                await _call_clawdi_mcp_tool(name, arguments, auth=auth, db=db),
            )
        return _mcp_error(rpc_id, -32601, "Method not found")
    except HTTPException as exc:
        return _mcp_error(rpc_id, -32000, _http_exception_message(exc), is_tool_error=True)
    except Exception as exc:
        logger.error("Clawdi MCP error: method=%s error_type=%s", method, type(exc).__name__)
        return _mcp_error(rpc_id, -32000, "internal error", is_tool_error=True)


def _mcp_result(rpc_id: JsonValue, result: JsonValue) -> JsonObject:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _mcp_error(
    rpc_id: JsonValue, code: int, message: str, *, is_tool_error: bool = False
) -> JsonObject:
    if is_tool_error:
        return _mcp_result(
            rpc_id,
            {"content": [{"type": "text", "text": f"Error: {message}"}], "isError": True},
        )
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def _http_exception_message(exc: HTTPException) -> str:
    try:
        return _HTTP_EXCEPTION_DETAIL_ADAPTER.validate_python(exc.detail, strict=True)
    except ValidationError:
        return "request failed"


async def _read_request_json(request: Request) -> JsonValue | None:
    try:
        return _JSON_VALUE_ADAPTER.validate_json(await request.body())
    except ValidationError:
        return None


async def _connector_mcp_tools(auth: AuthContext) -> list[JsonObject]:
    try:
        require_auth_scopes(auth, "connectors:read")
    except HTTPException:
        return []
    clerk_id = require_clerk_id(auth)
    try:
        return await get_tool_router_mcp_tools(clerk_id)
    except (ComposioMcpUpstreamError, ComposioRouteError):
        # Failures are not cached — the next call retries immediately.
        logger.info("Connector MCP tools unavailable")
        return []


async def _list_clawdi_mcp_tools(auth: AuthContext) -> list[JsonObject]:
    native_tools: list[JsonObject] = []
    for name, spec in _NATIVE_TOOL_REGISTRY.items():
        try:
            require_auth_scopes(auth, *spec.scopes)
        except HTTPException:
            continue
        native_tools.append(spec.definition(name))
    connector_tools = [
        tool
        for tool in await _connector_mcp_tools(auth)
        if tool.get("name") not in _NATIVE_TOOL_REGISTRY
    ]
    return [*native_tools, *connector_tools]


async def _call_clawdi_mcp_tool(
    name: str, arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    spec = _NATIVE_TOOL_REGISTRY.get(name)
    if spec is not None:
        require_auth_scopes(auth, *spec.scopes)
        return await spec.handler(arguments, auth, db)
    return await _tool_connector_call(name, arguments, auth=auth)


def _tool_text(text: str, *, is_error: bool = False) -> JsonObject:
    payload: JsonObject = {"content": [{"type": "text", "text": text}]}
    if is_error:
        payload["isError"] = True
    return payload


def _tool_json(payload: object) -> JsonObject:
    return _tool_text(json.dumps(payload, ensure_ascii=False, indent=2))


async def _tool_memory_extract(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    _validate_arguments(_NoArguments, arguments)
    return _tool_text(_MEMORY_EXTRACT_INSTRUCTIONS)


async def _tool_memory_search(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_MemorySearchArguments, arguments)
    provider = await get_memory_provider(str(auth.user_id), db)
    hits = await provider.search(
        str(auth.user_id),
        parsed.query,
        limit=parsed.limit,
    )
    await attach_source_machines(db, auth, hits)
    text = (
        "\n\n".join(f"[{item.get('category', 'fact')}] {item.get('content', '')}" for item in hits)
        if hits
        else "No memories found."
    )
    return _tool_text(text)


async def _tool_memory_add(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_MemoryAddArguments, arguments)
    finding = find_likely_secret(parsed.content)
    if finding is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, secret_memory_warning(finding))
    provider = await get_memory_provider(str(auth.user_id), db)
    source_environment_id = (
        auth.api_key.environment_id
        if is_env_bound_api_key(auth) and auth.api_key is not None
        else None
    )
    result = await provider.add(
        str(auth.user_id),
        parsed.content,
        category=parsed.category,
        source="mcp",
        source_environment_id=source_environment_id,
    )
    return _tool_text(f"Memory stored ({str(result['id'])[:8]})")


def _user_sessions_stmt(auth: AuthContext):
    """Return account sessions, fencing only legacy environment keys.

    Strict Hosted runtimes intentionally receive cross-Agent history. Legacy
    environment keys predate that contract and retain their local boundary.
    Session-history reads intentionally retain archived Agent type/name.
    """
    stmt = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    bound_env = (
        auth.api_key.environment_id
        if is_env_bound_api_key(auth) and not is_runtime_deployment_principal(auth) and auth.api_key
        else None
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    return stmt


async def _tool_session_search(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_SessionSearchArguments, arguments)
    stmt = (
        _user_sessions_stmt(auth)
        .order_by(Session.last_activity_at.desc(), Session.id.asc())
        .limit(parsed.limit)
    )
    pattern = like_needle(parsed.query)
    stmt = stmt.where(
        or_(
            Session.summary.ilike(pattern, escape="\\"),
            Session.project_path.ilike(pattern, escape="\\"),
            Session.local_session_id.ilike(pattern, escape="\\"),
            cast(Session.id, String).ilike(pattern, escape="\\"),
        )
    )
    rows = (await db.execute(stmt)).all()
    if not rows:
        return _tool_text(f'No sessions matched "{parsed.query}".')
    lines: list[str] = []
    for session, agent_type in rows:
        date = session.last_activity_at.date().isoformat() if session.last_activity_at else "-"
        summary = session.summary or session.local_session_id or "(untitled)"
        project = f" · {session.project_path}" if session.project_path else ""
        model = f" · {session.model}" if session.model else ""
        lines.append(
            f"- **{summary}**{project}{model}\n"
            f"  - id: `{session.id}` · {agent_type or 'unknown'} · {date} · "
            f"{session.message_count or 0} msgs"
        )
    return _tool_text(
        f'Found {len(rows)} session(s) matching "{parsed.query}":\n\n' + "\n".join(lines)
    )


async def _tool_session_read(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_SessionReadArguments, arguments)
    match = _SHARE_URL_RE.search(parsed.reference)
    session_id = match.group(1) if match else parsed.reference
    try:
        parsed_id = UUID(session_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "reference must be a session UUID or a Clawdi share URL",
        ) from None
    if match:
        if is_env_bound_api_key(auth) and not is_runtime_deployment_principal(auth):
            # No owner-bypass for env-bound agent keys: a share URL for a
            # same-user session in another environment must not sidestep
            # the bare-UUID env filter. Own-environment sessions resolve
            # directly; everything else needs an active public link
            # (anonymous share semantics).
            row = (
                await db.execute(_user_sessions_stmt(auth).where(Session.id == parsed_id))
            ).first()
            if row is not None:
                session, agent_type = row
            else:
                session, agent_type, _ = await resolve_session_for_view(db, parsed_id, None)
        else:
            session, agent_type, _ = await resolve_session_for_view(db, parsed_id, auth)
    else:
        stmt = _user_sessions_stmt(auth).where(Session.id == parsed_id)
        row = (await db.execute(stmt)).first()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
        session, agent_type = row
    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")
    try:
        messages = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None
    return _tool_text(
        session_to_markdown(session, messages, agent_type=agent_type, public=bool(match))
    )


def _project_payload(project: Project) -> JsonObject:
    return {
        "id": str(project.id),
        "name": project.name,
        "slug": project.slug,
        "kind": project.kind,
        "origin_environment_id": (
            str(project.origin_environment_id) if project.origin_environment_id else None
        ),
        "archived_at": project.archived_at.isoformat() if project.archived_at else None,
        "created_at": project.created_at.isoformat(),
    }


async def _visible_project_or_404(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
) -> Project:
    visible_project_ids = await project_ids_visible_to(db, auth)
    if project_id not in visible_project_ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


async def _tool_project_current(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    _validate_arguments(_NoArguments, arguments)
    project_id = await resolve_default_write_project(db, auth)
    project = await _visible_project_or_404(db, auth, project_id)
    return _tool_json(_project_payload(project))


async def _tool_project_list(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_ProjectListArguments, arguments)
    visible_project_ids = await project_ids_visible_to(db, auth)
    projects = (
        (
            await db.execute(
                select(Project)
                .where(Project.id.in_(visible_project_ids))
                .order_by(Project.created_at.desc(), Project.id.asc())
                .limit(parsed.limit)
            )
        )
        .scalars()
        .all()
    )
    return _tool_json({"projects": [_project_payload(project) for project in projects]})


async def _tool_project_get(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_ProjectGetArguments, arguments)
    project = await _visible_project_or_404(db, auth, UUID(parsed.project_id))
    return _tool_json(_project_payload(project))


async def _tool_vault_list(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_VaultListArguments, arguments)
    visible_project_ids = await project_ids_visible_to(db, auth)
    if parsed.project_id is not None:
        selected_project_id = UUID(parsed.project_id)
        if selected_project_id not in visible_project_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        visible_project_ids = [selected_project_id]

    rows = (
        await db.execute(
            select(
                Project.id,
                Project.name,
                Project.slug,
                Vault.id,
                Vault.name,
                Vault.slug,
                func.count(VaultItem.id),
            )
            .join(VaultProjectAttachment, VaultProjectAttachment.project_id == Project.id)
            .join(Vault, Vault.id == VaultProjectAttachment.vault_id)
            .outerjoin(VaultItem, VaultItem.vault_id == Vault.id)
            .where(Project.id.in_(visible_project_ids))
            .group_by(Project.id, Vault.id)
            .order_by(Project.name.asc(), Project.id.asc(), Vault.slug.asc(), Vault.id.asc())
            .limit(parsed.limit)
        )
    ).all()
    vaults = [
        {
            "project": {
                "id": str(project_id),
                "name": project_name,
                "slug": project_slug,
            },
            "vault": {
                "id": str(vault_id),
                "name": vault_name,
                "slug": vault_slug,
                "key_count": item_count,
            },
        }
        for (
            project_id,
            project_name,
            project_slug,
            vault_id,
            vault_name,
            vault_slug,
            item_count,
        ) in rows
    ]
    return _tool_json({"vaults": vaults})


def _exact_vault_reference(
    project_id: UUID,
    vault_slug: str,
    section: str,
    field: str,
) -> str:
    parts = [
        "project",
        str(project_id),
        "vault",
        vault_slug,
        *(["section", section] if section else []),
        "field",
        field,
    ]
    return "clawdi://" + "/".join(quote(part, safe="") for part in parts)


async def _tool_vault_get(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_VaultGetArguments, arguments)
    project_id = UUID(parsed.project_id)
    vault_id = UUID(parsed.vault_id)
    project = await _visible_project_or_404(db, auth, project_id)
    vault_row = (
        await db.execute(
            select(Vault.id, Vault.name, Vault.slug)
            .join(VaultProjectAttachment, VaultProjectAttachment.vault_id == Vault.id)
            .where(
                Vault.id == vault_id,
                VaultProjectAttachment.project_id == project_id,
            )
        )
    ).one_or_none()
    if vault_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vault not found")
    _, vault_name, vault_slug = vault_row
    item_rows = (
        await db.execute(
            select(VaultItem.section, VaultItem.item_name)
            .where(VaultItem.vault_id == vault_id)
            .order_by(VaultItem.section.asc(), VaultItem.item_name.asc())
        )
    ).all()
    keys = [
        {
            "section": section,
            "field": field,
            "reference": _exact_vault_reference(project_id, vault_slug, section, field),
            "provenance": {
                "project_id": str(project_id),
                "vault_id": str(vault_id),
                "vault_slug": vault_slug,
            },
        }
        for section, field in item_rows
    ]
    return _tool_json(
        {
            "project": _project_payload(project),
            "vault": {
                "id": str(vault_id),
                "name": vault_name,
                "slug": vault_slug,
            },
            "keys": keys,
        }
    )


def _parse_exact_project_vault_reference(reference: str) -> tuple[UUID, str, str, str]:
    try:
        parsed = urlsplit(reference)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference") from None
    if parsed.scheme != "clawdi" or parsed.netloc != "project" or parsed.query or parsed.fragment:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference")
    raw_parts = parsed.path.removeprefix("/").split("/")
    parts = [unquote(part) for part in raw_parts]
    if len(parts) == 5 and parts[1] == "vault" and parts[3] == "field":
        project_raw, _, vault_slug, _, field = parts
        section = ""
    elif len(parts) == 7 and parts[1] == "vault" and parts[3] == "section" and parts[5] == "field":
        project_raw, _, vault_slug, _, section, _, field = parts
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference")
    try:
        project_id = UUID(project_raw)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference") from None
    if not vault_slug or not field:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference")
    if _exact_vault_reference(project_id, vault_slug, section, field) != reference:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Vault reference")
    return project_id, vault_slug, section, field


async def _tool_vault_resolve(
    arguments: JsonObject, *, auth: AuthContext, db: AsyncSession
) -> JsonObject:
    parsed = _validate_arguments(_VaultResolveArguments, arguments)
    project_id, vault_slug, section, field = _parse_exact_project_vault_reference(parsed.reference)
    await _visible_project_or_404(db, auth, project_id)
    rows = (
        await db.execute(
            select(VaultItem.encrypted_value, VaultItem.nonce)
            .join(Vault, Vault.id == VaultItem.vault_id)
            .join(VaultProjectAttachment, VaultProjectAttachment.vault_id == Vault.id)
            .where(
                VaultProjectAttachment.project_id == project_id,
                Vault.slug == vault_slug,
                VaultItem.section == section,
                VaultItem.item_name == field,
            )
        )
    ).all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vault reference not found")
    if len(rows) != 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "Vault reference is ambiguous")
    encrypted_value, nonce = rows[0]
    return _tool_json(
        {
            "reference": parsed.reference,
            "value": decrypt(encrypted_value, nonce),
        }
    )


async def _tool_connector_call(
    name: str, arguments: JsonObject, *, auth: AuthContext
) -> JsonObject:
    require_auth_scopes(auth, "connectors:invoke")
    session = await get_tool_router_mcp_session(require_clerk_id(auth))
    response = await call_tool_router_mcp_tool(session, name, arguments)
    return _JSON_OBJECT_ADAPTER.validate_json(
        response.model_dump_json(by_alias=True, exclude_none=True)
    )
