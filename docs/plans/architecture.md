# Clawdi Cloud — Project Architecture Plan

## Context

Clawdi Cloud 是一个全新的独立项目（新仓库 `~/workspace/clawdi-cloud`），定位为 "iCloud for AI Agents"。用户通过 CLI 工具将本地 agent 环境数据（sessions、memories、skills、MCP 配置等）同步到云端，在精美的 Web Dashboard 上管理和查看，然后在另一台机器或另一个 agent 环境中将数据同步下来。

- **项目名**: clawdi-cloud
- **仓库位置**: ~/workspace/clawdi-cloud（全新 git repo）
- **CLI 命令名**: clawdi
- **目标 agent**: Claude Code、Codex、OpenClaw、Hermes
- **核心模块**: Vault、Skills、MCP/CLI、Session、Memory、CronJob、Channels
- **MVP 优先级**: Sessions + 贡献图 Dashboard 优先，视觉冲击力强，用户能立即看到价值
- **设计理念**: Clawdi Cloud 是**编排层**，不重造轮子。Memory 集成 Mem0 等已有方案，Connectors 集成 Composio，Vault/Session/Skills 自建

本次计划只设计整体架构和功能需求，各模块的详细设计将在后续分别展开。

---

## 1. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Monorepo | Bun + Turbo | 复用现有 clawdi 的熟悉度 |
| Frontend | Next.js 15, React 19, Tailwind v4, shadcn/ui | 同上 |
| State | TanStack Query + Zustand | 同上 |
| Auth (Web) | Clerk | 同上 |
| Auth (CLI/Agent) | 自建 Scoped Token | SHA-256 hash 存储，scope 控制 |
| Backend | FastAPI, SQLAlchemy 2.0 async, asyncpg, Alembic | 同上 |
| Database | PostgreSQL | 结构化数据 + 元数据 |
| File Store | S3 / R2 / 本地文件系统 | 文件型数据（sessions JSONL, skills MD） |
| Cache | Redis | Token 验证缓存、session 状态 |
| Background Tasks | Celery + Redis | Memory 提取、CronJob 执行 |
| CLI | TypeScript / Bun | 共享类型、MCP SDK 原生支持、`bun build --compile` 生成单文件二进制 |
| Code Quality | Biome (JS/TS), Ruff (Python) | 同上 |
| Memory Provider | Mem0 / Cognee / Built-in | 可插拔，集成已有方案 |
| Connectors | Composio | 已有集成 |

---

## 2. Project Structure

```
clawdi-cloud/
├── CLAUDE.md
├── package.json               # Bun workspaces root
├── turbo.json
├── biome.json
│
├── apps/
│   └── web/                   # Next.js Dashboard
│       └── src/
│           ├── app/
│           │   ├── (auth)/          # sign-in, sign-up
│           │   └── (dashboard)/     # 主应用
│           │       ├── page.tsx           # Overview + 贡献图
│           │       ├── sessions/
│           │       ├── memories/
│           │       ├── skills/
│           │       ├── vault/
│           │       ├── cron/
│           │       ├── channels/
│           │       ├── connectors/
│           │       └── settings/
│           ├── components/
│           │   ├── ui/              # shadcn
│           │   └── dashboard/       # contribution-graph, stats-cards 等
│           ├── hooks/
│           ├── lib/
│           └── stores/
│
├── packages/
│   ├── shared/                # 共享类型、常量
│   │   └── src/
│   │       ├── types/         # session.ts, memory.ts, skill.ts, vault.ts, sync.ts
│   │       ├── consts/        # agents.ts, modules.ts
│   │       └── utils/
│   │
│   └── cli/                   # CLI 工具
│       └── src/
│           ├── index.ts       # 入口
│           ├── commands/      # login, sync, run, vault, skills, mcp, cron, ...
│           ├── adapters/      # 各 agent 适配器
│           │   ├── base.ts
│           │   ├── claude-code.ts
│           │   ├── codex.ts
│           │   ├── openclaw.ts
│           │   └── hermes.ts
│           ├── sync/          # collector, uploader, downloader, differ
│           ├── mcp/           # MCP stdio server + tools
│           └── lib/           # api-client, auth, config, logger
│
├── backend/                   # FastAPI
│   ├── pyproject.toml
│   ├── alembic/
│   └── app/
│       ├── main.py
│       ├── core/              # config, auth, database, redis
│       ├── models/            # 数据模型
│       ├── schemas/           # Pydantic schemas
│       ├── routes/            # API 路由
│       ├── services/          # 业务逻辑
│       └── tasks/             # Celery 后台任务
│
├── docs/
│   ├── PROGRESS.md
│   ├── CHANGELOG.md
│   └── plans/
│
└── infra/
    ├── docker-compose.yml     # PostgreSQL + pgvector + Redis
    └── Dockerfile
```

---

## 3. 存储分层

```
PostgreSQL（结构化数据 + 元数据）:
  ├── Session 元数据      时间, tokens, model, project → 喂贡献图
  ├── Skill 元数据        name, version, hash → 指向 File Store
  ├── Vault + VaultItem   加密密钥（三级结构）
  ├── ApiKey              CLI 认证（简单 bearer token）
  ├── CronJob             定时任务定义
  ├── Channel             bot 配置
  └── UserSetting        用户偏好（含 memory provider 配置等）

File Store（S3 / R2 / 本地文件系统）:
  ├── sessions/{user_id}/{session_id}.jsonl    原始会话文件
  ├── skills/{user_id}/{skill_key}/SKILL.md    技能文件/包
  └── exports/{user_id}/...                    导出数据

Memory（外部 Provider）:
  └── Mem0 / Cognee / Built-in pgvector        可插拔
```

后端 FileStore 抽象:
```python
class FileStore(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def get_url(self, key: str, expires: int) -> str: ...  # presigned URL

# 开发: LocalFileStore (./data/files/)
# 生产: S3FileStore (R2/S3/MinIO)
```

---

## 4. Provider 模式（可插拔模块）

```
Module        → Provider（可插拔）      → 数据归属
─────────────────────────────────────────────────────
Memory        → Mem0 (推荐)            → 数据在 Mem0
              → Cognee                 → 数据在 Cognee
              → Built-in (pgvector)    → 数据在我们的 PG

Connectors    → Composio               → 数据在 Composio

Vault         → Built-in (自建)        → 数据在我们的 PG
Skills        → Built-in (自建)        → 元数据 PG + 文件 File Store
Session       → Built-in (自建)        → 元数据 PG + 文件 File Store
CronJob       → Built-in (自建)        → 数据在我们的 PG
Channels      → Built-in (自建)        → 数据在我们的 PG
```

Provider 接口（后端）:
```python
class MemoryProvider(Protocol):
    async def search(self, query: str, user_id: str, limit: int) -> list[Memory]: ...
    async def add(self, content: str, user_id: str, metadata: dict) -> Memory: ...
    async def delete(self, memory_id: str) -> None: ...
    async def list(self, user_id: str, **filters) -> list[Memory]: ...

class Mem0Provider(MemoryProvider): ...      # 调 Mem0 API
class CogneeProvider(MemoryProvider): ...    # 调 Cognee API
class BuiltinMemoryProvider(MemoryProvider): ... # pgvector fallback
```

用户在 Dashboard Settings 或 CLI 配置 provider:
```bash
clawdi config set memory.provider mem0
clawdi config set memory.api_key m0-xxx
```

---

## 5. Core Data Model

### 实体关系

```
User (Clerk)
├── AgentEnvironment (N)     # 一台机器上的一个 agent 实例
├── Session (N)              # 元数据在 PG，原始文件在 File Store
├── Skill (N)                # 元数据在 PG，内容在 File Store
├── Vault (N) → VaultItem (N)  # 加密密钥，三级结构（PG）
├── CronJob (N)              # 定时任务（PG）
├── Channel (N)              # IM bot 配置（PG）
├── ApiKey (N)               # CLI 认证（简单 bearer token）
└── Memory (via Provider)    # 数据在 Mem0 / Cognee / PG
```

### 核心表

**AgentEnvironment** — 一台机器上的一个 agent
- machine_id（机器指纹）、machine_name（人类友好名）
- agent_type: `claude_code | codex | openclaw | hermes`
- agent_version, os, last_seen_at

**Session** — agent 会话元数据（喂贡献图的数据源）
- environment_id (FK), local_session_id
- project_path, started_at, ended_at, duration_seconds
- message_count, input_tokens, output_tokens, cache_read_tokens
- model（主模型）, models_used（所有用过的模型）
- summary（自动生成的摘要）, tags, status
- **file_key** → 指向 File Store 中的原始 JSONL

**Skill** — 可移植指令包元数据
- skill_key (unique per user), name, description
- version, source: `local | catalog | custom`
- agent_types (text[]), content_hash
- **file_key** → 指向 File Store 中的 SKILL.md 文件/包

**Vault** — 密钥容器（参考 Jingui 数据设计）
- id (slug), user_id, name

**VaultItem** — 容器内的密钥字段
- vault_id (FK), item_name, section (默认 "")
- encrypted_value, nonce
- UNIQUE(vault_id, section, item_name)

```
数据结构（三级：vault → section → field）:

  vault: "ai-keys"
    section: "openai"
      field: "api_key" = "sk-xxx"
    section: "anthropic"
      field: "api_key" = "sk-ant-xxx"

  vault: "prod"
    section: "stripe"
      field: "secret_key" = "sk_live_xxx"
      field: "webhook_secret" = "whsec_xxx"
    section: "database"
      field: "url" = "postgres://..."

URI 引用格式（兼容 Jingui/1Password op://）:
  clawdi://ai-keys/openai/api_key
  clawdi://prod/stripe/secret_key
  clawdi://prod/database/url

.env 文件可以安全提交 git:
  OPENAI_API_KEY=clawdi://ai-keys/openai/api_key
  DATABASE_URL=clawdi://prod/database/url
  LOCAL_VAR=some-plain-value  # 非 clawdi:// 直接透传
```

**CronJob** — 定时任务
- name, schedule (cron expression), command/webhook_url
- agent_type, prompt, is_active

**Channel** — IM bot
- platform: `telegram | discord | slack`
- bot_token_ref: `clawdi://channels/telegram/bot_token`（Vault URI 引用）

**ApiKey** — CLI 认证（简单 bearer token，不做 scope 系统）
- key_hash (SHA-256), key_prefix (显示用前 8 位)
- label, expires_at, revoked_at, last_used_at

**UserSetting** — 用户偏好（jsonb，含 provider 配置等）
- memory_provider: `mem0 | cognee | builtin`
- memory_api_key (加密)
- 其他偏好设置

---

## 4. Auth 设计

```
Web Dashboard:
  Clerk JWT → 标准 RS256 → 完整权限（除 vault/resolve）

CLI:
  ApiKey → SHA-256 hash 匹配 → bearer token
  前缀: clawdi_ → 后端识别为 ApiKey
  用户在 Dashboard 生成，`clawdi login` 时输入或通过浏览器授权获取

vault/resolve 端点:
  只接受 ApiKey（CLI 调用），Clerk JWT 不能调用
  这是唯一返回明文密钥的端点
```

---

## 6. API 路由概览

```
/api/auth/         # Token 管理（创建、列表、撤销）
/api/sync/         # 同步引擎（up、down、status、checkpoint）
/api/environments/ # Agent 环境注册和管理
/api/sessions/     # 会话 CRUD + 批量上传 + 文件上传
/api/dashboard/    # 贡献图、统计数据、模型分析
/api/memories/     # 记忆 CRUD + 搜索（代理到 Memory Provider）
/api/skills/       # 技能 CRUD + 文件上传/下载
/api/vault/        # 密钥管理 + resolve 端点（CLI 专用）
/api/cron/         # 定时任务 CRUD + 手动触发
/api/channels/     # IM bot 管理
/api/connectors/   # Composio OAuth 连接
/api/settings/     # 用户设置（含 provider 配置）
```

---

## 7. CLI 命令树

```
clawdi login                          # 浏览器授权 → 获取 ApiKey
clawdi logout
clawdi status                         # 当前认证和同步状态

clawdi setup [--agent <type>]         # 检测 agent → 注册环境 → 配置 MCP

clawdi sync up [--modules ...]        # 本地 → 云端
clawdi sync down [--modules ...]      # 云端 → 本地
clawdi sync auto [--interval 300]     # 后台自动同步

clawdi run -- <agent-command>         # Vault 环境变量注入 + exec

clawdi vault set/list/import/rm       # 密钥管理
clawdi skills list/add/pull/push/rm   # 技能管理
clawdi memories list/search/add/rm    # 记忆管理
clawdi mcp stdio                      # 启动本地 MCP server
clawdi cron list/add/rm/trigger       # 定时任务
clawdi channels list/add/rm/send      # IM 频道管理
```

### 本地配置

```
~/.clawdi/
├── config.json         # API URL、默认 agent
├── auth.json           # ApiKey（OS keychain 加密）
├── environments/       # 已注册的环境
├── sync.json              # 同步水位（本地跟踪，不上云）
└── cache/skills/       # 离线技能缓存
```

---

## 8. Agent Adapter 模式

每个 agent 的数据格式和存储位置不同。Adapter 抽象了这些差异：

```typescript
interface AgentAdapter {
  agentType: AgentType
  detect(): Promise<boolean>              // 是否安装
  getVersion(): Promise<string | null>

  // 数据采集（sync up）
  collectSessions(since?: Date): Promise<RawSession[]>
  collectSessionEvents(id: string): Promise<RawEvent[]>
  collectMemories(): Promise<RawMemory[]>
  collectSkills(): Promise<RawSkill[]>

  // 数据写入（sync down）
  writeSkill(key: string, content: string): Promise<void>

  // 运行包装（clawdi run）
  buildRunCommand(args: string[], env: Record<string, string>): string[]
}
```

### 各 Agent 数据位置

| Agent | Sessions | Memories | Skills |
|-------|----------|----------|--------|
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/**/memory/` | `~/.claude/skills/` |
| Codex | TBD (通过 `clawdi run` 包装追踪) | TBD | TBD |
| OpenClaw | OpenClaw API | OpenClaw API | Deployment config |
| Hermes | 自定义格式 | 自定义格式 | 自定义格式 |

**Claude Code 优先**——它的数据格式最成熟（JSONL sessions），作为第一个完整适配的 agent。

---

## 9. 核心同步流程

### Sync UP（本地 → 云端）

```
clawdi sync up
  1. 加载当前环境的 adapter
  2. 读取 ~/.clawdi/sync.json（上次同步到哪）
  3. 按模块采集:
     Sessions → adapter.collectSessions(since) → POST /api/sessions/batch
     Memories → adapter.collectMemories() → POST /api/memories/batch
     Skills   → adapter.collectSkills() → POST /api/skills/batch
  4. 更新 checkpoint
```

### Sync DOWN（云端 → 本地）

```
clawdi sync down
  1. GET /api/sync/status 检查变更
  2. 按模块拉取:
     Skills   → GET /api/skills → adapter.writeSkill()
     Memories → GET /api/memories → 写入 adapter 的记忆位置
  3. 更新 checkpoint
```

### Session → Memory 管道

```
Session 同步到云端后:
  → Celery 后台任务检测新 session
  → 从 File Store 读取 session JSONL
  → 用 LLM (Haiku) 提取结构化知识
  → 调用 Memory Provider（Mem0 / Cognee / Built-in）存储
  → Provider 自己处理嵌入和去重
```

---

## 10. Web Dashboard 页面

### Overview（首页）

```
┌──────────────────────────────────────────────┐
│  What's up next, [avatar]?                    │
│                                              │
│  ┌──────────┬──────────┬──────────┬────────┐ │
│  │Sessions  │Messages  │Tokens    │Active  │ │
│  │ 29       │ 1,435    │ 127.8k   │ 16 days│ │
│  ├──────────┼──────────┼──────────┼────────┤ │
│  │Streak    │Best      │Peak Hour │Model   │ │
│  │ 3d       │ 7d       │ 10:00    │opus-4  │ │
│  └──────────┴──────────┴──────────┴────────┘ │
│                                              │
│  [Contribution Graph — 365 天活动热力图]       │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓██▓█     │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓█▓▓▓       │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓██       │
│                                              │
│  [Overview] [Models]    [All] [30d] [7d]     │
│                                              │
│  Recent Sessions:                            │
│  ├─ clawdi: 讨论 Channels 场景  (2h ago)      │
│  ├─ btc: 修复数据采集 bug       (5h ago)      │
│  └─ clawdi: 设计 Memory 同步    (1d ago)      │
└──────────────────────────────────────────────┘
```

### 其他页面

| 页面 | 核心功能 |
|------|---------|
| Sessions | 会话列表 + 筛选（agent、项目、日期、模型）+ 详情页 |
| Memories | 语义搜索 + 卡片网格 + 分类筛选 + 编辑/删除 |
| Skills | 已安装技能网格 + 上传 + Markdown 编辑器 + agent 兼容标记 |
| Vault | 密钥表格（值始终隐藏）+ .env 导入 + 审计日志 |
| CronJobs | 任务表格 + 运行历史 + 手动触发 |
| Channels | 平台卡片 + 配置向导 + 测试消息 |
| Connectors | 可用应用网格 + OAuth 连接/断开 |
| Settings | API Tokens + 已链接环境 + 同步偏好 + 数据导出 |

---

## 11. 构建阶段

### Phase 0: 脚手架 (Week 1)
- 初始化 Bun + Turbo monorepo
- 创建 packages/shared 类型定义
- 创建 backend/ FastAPI 骨架 + Alembic + docker-compose (PG + Redis)
- FileStore 抽象层（LocalFileStore 开发用）
- 创建 apps/web/ Next.js + Clerk + shadcn/ui
- 创建 packages/cli/ 基础命令结构
- 写 CLAUDE.md

### Phase 1: Auth + CLI Login (Week 2)
- ApiKey 模型 + 路由
- 双层 auth 中间件（Clerk JWT + ApiKey）
- `clawdi login/logout/status`
- Web: 登录/注册页

### Phase 2: Sessions + Dashboard MVP (Weeks 3-4) ← **MVP 发布点**
- Claude Code adapter（session JSONL 解析）
- AgentEnvironment + Session 模型
- Session 元数据存 PG，原始 JSONL 上传 File Store
- `clawdi setup` + `clawdi sync up --modules sessions`
- 同步引擎（批量 upsert、checkpoint）
- Web: 贡献图 + 统计卡片 + 会话列表

### Phase 3: Skills + Memories (Weeks 5-6)
- Skill 模型（元数据 PG + 文件 File Store）
- MemoryProvider 接口 + Mem0Provider 实现
- UserSetting 中的 provider 配置
- `clawdi sync up/down --modules skills,memories`
- `clawdi skills/memories` 子命令 + `clawdi config set memory.provider`
- Memory 提取后台任务（Session → Memory Provider）
- Web: Skills + Memories 管理页 + Provider 设置

### Phase 4: Vault + Run (Weeks 7-8)
- Vault + VaultItem 模型 + AES-256-GCM 加密
- `clawdi vault` 子命令
- `clawdi run` 环境变量注入
- Web: Vault 管理页

### Phase 5: MCP Server + 双向同步 (Weeks 9-10)
- `clawdi mcp stdio` 本地 MCP server
- MCP tools: memory_search (代理到 Memory Provider), connector_invoke (代理到 Composio)
- `clawdi sync down` 完整实现

### Phase 6: Multi-Agent (Weeks 11-12)
- Codex adapter, OpenClaw adapter, Hermes adapter
- 跨 agent 同步测试
- Dashboard agent 筛选

### Phase 7: CronJob + Channels (Weeks 13-14)
- CronJob 模型 + 调度器
- Channel 模型 + Telegram 集成
- Web: Cron + Channels 管理页

### Phase 8: Connectors + 开源发布 (Weeks 15-16)
- Composio OAuth 连接
- Web: Connectors 页
- `bun build --compile` 生成 macOS/Linux 二进制
- npm publish
- README, 文档, 示例
- GitHub Actions CI/CD
- License (MIT or Apache 2.0)

---

## 12. 关键架构决策

1. **编排层而非实现层**：Memory 集成 Mem0/Cognee，Connectors 集成 Composio。自建 Vault/Session/Skills。不重造轮子
2. **PG 存元数据 + File Store 存文件**：Session JSONL、Skill MD 是文件，不塞 PG。PG 只存元数据和结构化数据
3. **Provider 可插拔**：Memory/Connectors 通过 Provider 接口抽象，用户选择自己偏好的服务
4. **CLI 用 TypeScript/Bun**：共享类型避免 schema 漂移，MCP SDK 原生支持，`bun build --compile` 生成单文件二进制
5. **Session → Memory 异步管道**：Session 原样同步到 File Store，Memory 提取在服务端后台通过 Memory Provider 异步完成
6. **Vault 值永远不到 Web**：`vault/resolve` 端点仅接受 ApiKey（CLI 专用），Web Dashboard 可以列 key 管 key 但看不到值
7. **MCP Server 仅本地**：`clawdi mcp stdio` 跑在用户机器上，连接云端 API 做 memory search 和 connector invoke
8. **Adapter 模式解耦 agent**：每个 agent 有独立 adapter，sync engine 和云端 API 是 agent-agnostic 的
9. **贡献图是核心体验**：Dashboard 的设计重心是让贡献图有成就感，Session sync 的首要目标是喂这个图
10. **增量同步是客户端状态**：同步水位存本地 `~/.clawdi/sync.json`，服务端无状态，客户端传 `?since=` 时间戳过滤

---

## 13. 验证方案

每个 Phase 完成后的验证：

- **Phase 2 (MVP)**: `clawdi login` → `clawdi setup` → `clawdi sync up` → 打开 Web 看到贡献图和 session 列表，点击 session 能查看详情（从 File Store 加载 JSONL）
- **Phase 3**: `clawdi config set memory.provider mem0` → 在 Claude Code 里工作 → sync up → Memory 自动提取到 Mem0 → 在 Web 搜索到记忆
- **Phase 4**: `clawdi vault set OPENAI_API_KEY` → `clawdi run -- python test.py` → 脚本成功读到 env var
- **Phase 5**: Claude Code 启动后 → MCP server 可用 → `memory_search` 通过 Mem0 返回跨 agent 记忆
- **Phase 6**: Claude Code sync up → Codex sync down → Codex 能搜索到 Claude Code 的记忆
