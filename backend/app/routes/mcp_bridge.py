"""MCP bridge: forwards authenticated JSON-RPC to Composio Tool Router."""

import json
import logging
import re
from typing import Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import String

from app.core.auth import AuthContext, _is_env_bound_api_key, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.session import AgentEnvironment, Session
from app.routes.memories import _attach_source_machines, _project_filter_memories
from app.routes.public_sessions import _resolve_session_for_view
from app.services.composio import (
    ComposioMcpSession,
    get_tool_router_mcp_session,
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
            "Search the user's durable Clawdi memories. Use when a request references "
            "the user's own preferences, projects, past decisions, named entities, or work history."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language search query."},
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
            "Store a durable memory for future Clawdi sessions. Do not store plaintext "
            "tokens, API keys, bearer credentials, or private keys."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Standalone memory content."},
                "category": {
                    "type": "string",
                    "enum": ["fact", "preference", "pattern", "decision", "context"],
                    "description": "Memory category. Default fact.",
                },
            },
            "required": ["content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "memory_extract",
        "description": (
            "Return instructions for proposing durable memories from the current conversation. "
            "The agent must ask the user before saving candidates with memory_add."
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
            "Search the user's past Clawdi sessions by keyword. Returned session IDs can "
            "be passed to session_read."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keyword query."},
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
            "Read a Clawdi session as Markdown. Accepts a session UUID or a Clawdi share URL."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "description": "A session UUID or a Clawdi share URL containing /s/{uuid}.",
                },
            },
            "required": ["reference"],
            "additionalProperties": False,
        },
    },
]

_MEMORY_EXTRACT_INSTRUCTIONS = (
    "Review the CURRENT conversation silently and propose up to 5 durable\n"
    "memories worth saving for future sessions. Pick the highest-signal. Fewer is better.\n\n"
    "Dedup first: for each candidate, call memory_search on its key topic and drop any\n"
    "that already have a clear match stored.\n\n"
    'If nothing qualifies, reply "nothing worth extracting" and stop.\n\n'
    "Otherwise, present the surviving candidates to the user as a numbered list. Wait for\n"
    "the user's approval. Do not call memory_add until the user approves specific candidates."
)


def _extract_user_id(request: Request) -> str:
    """Extract and verify user_id from the MCP bridge JWT."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing auth token")
    token = auth[7:]
    try:
        return verify_mcp_bridge_token(token)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


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
    except Exception:
        logger.exception("Clawdi MCP error: user=%s method=%s", auth.user_id, method)
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


async def _list_clawdi_mcp_tools(auth: AuthContext) -> list[dict[str, Any]]:
    tools = list(_NATIVE_TOOLS)
    try:
        session = await get_tool_router_mcp_session(auth.user.clerk_id)
        response = await _forward_composio_mcp_request(
            session,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        if isinstance(response, dict):
            result = response.get("result")
            if isinstance(result, dict) and isinstance(result.get("tools"), list):
                tools.extend(tool for tool in result["tools"] if isinstance(tool, dict))
    except Exception:
        logger.info("Connector MCP tools unavailable for user=%s", auth.user_id)
    return tools


async def _call_clawdi_mcp_tool(
    name: str, arguments: dict[str, Any], *, auth: AuthContext, db: AsyncSession
) -> dict[str, Any]:
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
    if not auth.is_cli or auth.api_key is None or auth.api_key.scopes is None:
        return
    missing = [scope for scope in needed if scope not in auth.api_key.scopes]
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
        auth.api_key.environment_id if _is_env_bound_api_key(auth) and auth.api_key else None
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
    session = await get_tool_router_mcp_session(auth.user.clerk_id)
    response = await _forward_composio_mcp_request(
        session,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    if isinstance(response, dict) and response.get("error"):
        return _tool_text(json.dumps(response["error"]), is_error=True)
    result = response.get("result") if isinstance(response, dict) else response
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        return result
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
    return _tool_text(text)


@router.post("/composio", include_in_schema=False)
async def mcp_composio_bridge_post(request: Request):
    """Forward MCP JSON-RPC to Composio Tool Router for an authenticated user."""
    user_id = _extract_user_id(request)
    body = await request.json()
    rpc_id = body.get("id", 1) if isinstance(body, dict) else None

    try:
        session = await get_tool_router_mcp_session(user_id)
        return await _forward_composio_mcp_request(session, body)
    except Exception:
        logger.exception("Composio MCP bridge error: user=%s", user_id)
        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32000, "message": "internal error"},
        }


async def _forward_composio_mcp_request(session: ComposioMcpSession, body) -> dict | list:
    headers = _composio_mcp_headers(session)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(session.url, json=body, headers=headers)

    if not resp.is_success:
        logger.warning(
            "Composio MCP bridge upstream failure: status=%s",
            resp.status_code,
        )
        rpc_id = body.get("id", 1) if isinstance(body, dict) else None
        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32000, "message": "upstream MCP error"},
        }

    parsed = _parse_composio_mcp_response(resp)
    if not isinstance(parsed, (dict, list)):
        raise ValueError("Composio MCP bridge returned non-object JSON")
    return parsed


def _composio_mcp_headers(session: ComposioMcpSession) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **session.headers,
    }
    lowered = {k.lower() for k in headers}
    if (
        settings.composio_api_key
        and "x-api-key" not in lowered
        and "x-user-api-key" not in lowered
        and "authorization" not in lowered
    ):
        headers["x-api-key"] = settings.composio_api_key
    return headers


def _parse_composio_mcp_response(resp: httpx.Response):
    content_type = resp.headers.get("content-type", "")
    if "text/event-stream" not in content_type:
        return resp.json()

    events = []
    data_lines: list[str] = []
    for line in resp.text.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line and data_lines:
            events.append("\n".join(data_lines))
            data_lines = []
    if data_lines:
        events.append("\n".join(data_lines))
    events = [event for event in events if event.strip() and event.strip() != "[DONE]"]
    if not events:
        raise ValueError("Composio MCP bridge returned an empty SSE response")
    return json.loads(events[-1])
