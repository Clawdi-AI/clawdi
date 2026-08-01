"""Clawdi MCP endpoint with internal Composio Tool Router forwarding."""

import json
import logging
import re
import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import String

from app.core.auth import (
    AuthContext,
    _is_env_bound_api_key,
    _is_scoped_api_key,
    get_auth,
    is_runtime_deployment_principal,
    require_clerk_id,
)
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.session import AgentEnvironment, Session
from app.routes.memories import _attach_source_machines, _project_filter_memories
from app.routes.public_sessions import _resolve_session_for_view
from app.services.composio import (
    call_tool_router_mcp_tool,
    get_tool_router_mcp_session,
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

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/mcp", tags=["mcp"])
file_store = get_file_store()

MCP_PROTOCOL_VERSION = "2025-06-18"
_SHARE_URL_RE = re.compile(
    r"/s/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b",
    re.IGNORECASE,
)

_NATIVE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "memory_search",
        "description": (
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
        "inputSchema": {
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
    },
    {
        "name": "memory_add",
        "description": (
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
        "inputSchema": {
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
    },
    {
        "name": "memory_extract",
        "description": (
            "Propose durable long-term memories from the CURRENT conversation, list them to "
            "the user, and save only what they approve. Call this when the user asks to "
            "'extract memories', 'save what we discussed', 'remember this conversation', or "
            "any equivalent phrasing (in any language). The tool returns instructions — follow "
            "them exactly: list up to 5 candidates first, wait for the user's confirmation, "
            "then call memory_add on the approved ones. Do not narrate your internal workflow. "
            "This tool inspects your active conversation context — it does NOT read any "
            "external file or database."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "session_search",
        "description": (
            "Search the user's past Clawdi sessions by keyword. Use when the user asks about "
            "prior work (e.g. 'find the auth migration session'). Returns up to N matching "
            "sessions with summary, agent, model, project, date, and message count. The "
            "session UUID in each result can be passed back to session_read to fetch the full "
            "conversation."
        ),
        "inputSchema": {
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
    },
    {
        "name": "session_read",
        "description": (
            "Read a Clawdi session and return its content as Markdown so you can ingest the "
            "conversation as context. Use this when the user references a Clawdi share URL "
            "(https://cloud.clawdi.ai/s/{uuid}) or one of their own sessions by UUID. Handles "
            "owned + shared sessions uniformly — you don't need to know which one. Returns a "
            "YAML front-matter block (source/agent/model/project/messages) followed by "
            "`## User` / `## Assistant` turn headings."
        ),
        "inputSchema": {
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
    },
]

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
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from None


# Deprecated compatibility bridge for CLI 0.12.7. Keep hidden from OpenAPI;
# new clients authenticate normally and use POST /v1/mcp/clawdi.
@router.post("/composio", include_in_schema=False)
async def mcp_composio_post(request: Request):
    user_id = _extract_legacy_mcp_user_id(request)
    body = await request.json()
    if not isinstance(body, dict):
        return _mcp_error(None, -32600, "Invalid Request")

    rpc_id = body.get("id")
    method = body.get("method")
    if method not in {"tools/list", "tools/call"}:
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
    except Exception as exc:
        logger.error(
            "Legacy Composio MCP error: method=%s error_type=%s", method, type(exc).__name__
        )
        return _mcp_error(rpc_id, -32000, "internal error")

    return _mcp_result(rpc_id, result.model_dump(by_alias=True, exclude_none=True))


@router.post("/clawdi", include_in_schema=False)
async def mcp_clawdi_post(
    request: Request,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    """Agent-facing stateless MCP endpoint backed directly by Clawdi Cloud."""
    body = await request.json()
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
    body: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any] | None:
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
                        "name": "clawdi-cloud",
                        "title": "Clawdi Cloud",
                        "version": "1.0.0",
                    },
                },
            )
        if method == "ping":
            return _mcp_result(rpc_id, {})
        if method == "tools/list":
            return _mcp_result(rpc_id, {"tools": await _list_clawdi_mcp_tools(auth)})
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


def _mcp_result(rpc_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _mcp_error(
    rpc_id: Any, code: int, message: str, *, is_tool_error: bool = False
) -> dict[str, Any]:
    if is_tool_error:
        return _mcp_result(
            rpc_id,
            {"content": [{"type": "text", "text": f"Error: {message}"}], "isError": True},
        )
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def _http_exception_message(exc: HTTPException) -> str:
    if isinstance(exc.detail, str):
        return exc.detail
    return "request failed"


# Connector tool definitions change only when the user connects/disconnects
# an app; a short per-user cache keeps repeated tools/list calls (every MCP
# client init) from paying a Composio round-trip each time.
_CONNECTOR_TOOLS_CACHE_TTL_SECONDS = 60.0
_connector_tools_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

_HOSTED_MEMORY_TOOLS = {"memory_search", "memory_add", "memory_extract"}


async def _connector_mcp_tools(auth: AuthContext) -> list[dict[str, Any]]:
    # Mirror `require_user_auth`, which guarded the old connector MCP
    # config route: narrowly-scoped api keys are deliberate capability
    # narrowing and get no connector surface. Don't list what the
    # caller can't call.
    if _is_scoped_api_key(auth) and not is_runtime_deployment_principal(auth):
        return []
    if is_runtime_deployment_principal(auth):
        try:
            _require_scope(auth, "connectors:read")
        except HTTPException:
            return []
    clerk_id = require_clerk_id(auth)
    now = time.monotonic()
    cached = _connector_tools_cache.get(clerk_id)
    if cached and cached[0] > now:
        return cached[1]
    tools: list[dict[str, Any]] = []
    try:
        session = await get_tool_router_mcp_session(clerk_id)
        result = await list_tool_router_mcp_tools(session)
        serialized = result.model_dump(by_alias=True, exclude_none=True)
        raw_tools = serialized.get("tools")
        if isinstance(raw_tools, list):
            tools = [tool for tool in raw_tools if isinstance(tool, dict)]
        _connector_tools_cache[clerk_id] = (
            now + _CONNECTOR_TOOLS_CACHE_TTL_SECONDS,
            tools,
        )
    except Exception:
        # Failures are not cached — the next call retries immediately.
        logger.info("Connector MCP tools unavailable")
    return tools


async def _list_clawdi_mcp_tools(auth: AuthContext) -> list[dict[str, Any]]:
    tools = [*_NATIVE_TOOLS, *(await _connector_mcp_tools(auth))]
    if is_runtime_deployment_principal(auth):
        return [tool for tool in tools if tool.get("name") not in _HOSTED_MEMORY_TOOLS]
    return tools


async def _call_clawdi_mcp_tool(
    name: str, arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
    if is_runtime_deployment_principal(auth) and name in _HOSTED_MEMORY_TOOLS:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Memory tools are not available to hosted runtime principals",
        )
    if name == "memory_search":
        return await _tool_memory_search(arguments, auth=auth, db=db)
    if name == "memory_add":
        return await _tool_memory_add(arguments, auth=auth, db=db)
    if name == "memory_extract":
        return _tool_text(_MEMORY_EXTRACT_INSTRUCTIONS)
    if name == "session_search":
        return await _tool_session_search(arguments, auth=auth, db=db)
    if name == "session_read":
        return await _tool_session_read(arguments, auth=auth, db=db)
    return await _tool_connector_call(name, arguments, auth=auth)


def _require_scope(auth: AuthContext, *needed: str) -> None:
    if not auth.is_cli or auth.api_key is None:
        return
    scopes = auth.api_key.scopes
    if scopes is None and not is_runtime_deployment_principal(auth):
        return
    missing = list(needed) if scopes is None else [scope for scope in needed if scope not in scopes]
    if missing:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"missing scope: {', '.join(missing)}")


def _string_arg(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{name} is required")
    return value.strip()


def _int_arg(arguments: dict[str, Any], name: str, default: int, maximum: int) -> int:
    value = arguments.get(name, default)
    if not isinstance(value, int):
        return default
    return max(1, min(value, maximum))


def _tool_text(text: str, *, is_error: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        payload["isError"] = True
    return payload


async def _tool_memory_search(
    arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
    _require_scope(auth, "memories:read")
    query = _string_arg(arguments, "query")
    limit = _int_arg(arguments, "limit", 10, 50)
    provider = await get_memory_provider(str(auth.user_id), db)
    search_limit = max(limit * 10, 200) if _is_env_bound_api_key(auth) else limit
    hits = await provider.search(str(auth.user_id), query, limit=search_limit)
    await _attach_source_machines(db, auth, hits)
    hits = (await _project_filter_memories(db, auth, hits))[:limit]
    text = (
        "\n\n".join(f"[{item.get('category', 'fact')}] {item.get('content', '')}" for item in hits)
        if hits
        else "No memories found."
    )
    return _tool_text(text)


async def _tool_memory_add(
    arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
    _require_scope(auth, "memories:write")
    if _is_env_bound_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Agent API keys cannot create manual memories. Memories without a source session "
            "are not visible to scoped reads.",
        )
    content = _string_arg(arguments, "content")
    finding = find_likely_secret(content)
    if finding is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, secret_memory_warning(finding))
    category = arguments.get("category")
    provider = await get_memory_provider(str(auth.user_id), db)
    result = await provider.add(
        str(auth.user_id),
        content,
        category=category if isinstance(category, str) else "fact",
        source="mcp",
    )
    return _tool_text(f"Memory stored ({str(result['id'])[:8]})")


def _user_sessions_stmt(auth: AuthContext):
    """Sessions visible to this caller: owned, and — for env-bound API
    keys — restricted to the key's environment."""
    stmt = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    bound_env = (
        auth.api_key.environment_id
        if _is_env_bound_api_key(auth)
        and not is_runtime_deployment_principal(auth)
        and auth.api_key
        else None
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    return stmt


async def _tool_session_search(
    arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
    _require_scope(auth, "sessions:read")
    query = _string_arg(arguments, "query")
    limit = _int_arg(arguments, "limit", 10, 20)
    stmt = (
        _user_sessions_stmt(auth)
        .order_by(Session.last_activity_at.desc(), Session.id.asc())
        .limit(limit)
    )
    pattern = like_needle(query)
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
        return _tool_text(f'No sessions matched "{query}".')
    lines = []
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
    return _tool_text(f'Found {len(rows)} session(s) matching "{query}":\n\n' + "\n".join(lines))


async def _tool_session_read(
    arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
    _require_scope(auth, "sessions:read")
    reference = _string_arg(arguments, "reference")
    match = _SHARE_URL_RE.search(reference)
    session_id = match.group(1) if match else reference
    try:
        parsed_id = UUID(session_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "reference must be a session UUID or a Clawdi share URL",
        ) from None
    if match:
        if _is_env_bound_api_key(auth) and not is_runtime_deployment_principal(auth):
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
                session, agent_type, _ = await _resolve_session_for_view(db, parsed_id, None)
        else:
            session, agent_type, _ = await _resolve_session_for_view(db, parsed_id, auth)
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


async def _tool_connector_call(
    name: str, arguments: dict[str, Any], *, auth: AuthContext
) -> dict[str, Any]:
    if _is_scoped_api_key(auth) and not is_runtime_deployment_principal(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Connector tools are not available to scoped api keys",
        )
    if is_runtime_deployment_principal(auth):
        _require_scope(auth, "connectors:invoke")
    session = await get_tool_router_mcp_session(require_clerk_id(auth))
    response = await call_tool_router_mcp_tool(session, name, arguments)
    result = response.model_dump(by_alias=True, exclude_none=True)
    if isinstance(result, dict):
        return result
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
    return _tool_text(text)
