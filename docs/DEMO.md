# MVP Demo Flow

## Demo 1: Sync UP (Claude Code → Cloud)

```bash
# 安装 CLI
npm install -g @clawdi-cloud/cli

# 登录
clawdi login
# → 浏览器打开授权页 → 获取 ApiKey → 保存到 ~/.clawdi/auth.json

# 检测并注册当前 agent 环境
clawdi setup
# → 检测到 Claude Code
# → 注册 AgentEnvironment: paco-mbp / claude_code / darwin

# 同步当前项目的 sessions 和 skills 到云端
clawdi sync up
# → 扫描 ~/.claude/projects/ 下的 session JSONL
# → 解析元数据（tokens, model, duration, project）
# → 上传元数据到 API，原始 JSONL 到 File Store
# → 扫描本地 skills
# ✓ Synced 29 sessions, 3 skills
```

## Demo 2: Web Dashboard

```
浏览器打开 https://cloud.clawdi.ai (或 localhost:3000)

1. 登录（Clerk）
2. 看到 Overview 页面:
   - 统计卡片: 29 Sessions, 1435 Messages, 127.8k Tokens, 16 Active Days
   - 贡献图热力图（365 天）
   - 最近 sessions 列表
3. 点击某个 session → 查看详情（项目、模型、token 用量、时长）
4. 进入 Connectors 页面 → 点击 "Connect GitHub" → Composio OAuth → 授权
5. 进入 Vault 页面 → 添加 OPENAI_API_KEY
6. 进入 Skills 页面 → 看到同步上来的 skills
```

## Demo 3: Sync DOWN (Cloud → OpenClaw on another machine)

```bash
# 另一台机器上
clawdi login

clawdi setup --agent openclaw
# → 注册 AgentEnvironment: server-01 / openclaw / linux

# 拉取云端数据到本地
clawdi sync down
# → 拉取 skills → 写入 OpenClaw skill 目录
# → 拉取 vault secrets → clawdi run 时注入
# → 拉取 connector 信息 → 配置到 OpenClaw

# 使用 vault secrets 启动 OpenClaw
clawdi run -- openclaw start
# → 从云端拉取 vault secrets
# → 注入 OPENAI_API_KEY 等环境变量
# → 启动 OpenClaw，自动有 Claude Code 的 skills 和 connectors
```

## 核心验证点

- [ ] CLI 能扫描 Claude Code 的 session 数据并上传
- [ ] Web 贡献图能正确展示活跃度
- [ ] Web 能通过 Composio 连接第三方服务
- [ ] Vault 能安全存储和分发密钥
- [ ] 另一台机器能通过 sync down 获取 skills/vault/connectors
- [ ] `clawdi run` 能注入 vault secrets 启动 agent
