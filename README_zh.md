# Codex–OpenCode Bridge

[English](README.md) | [中文说明](README_zh.md)

一个专为 Codex 设计的 MCP（Model Context Protocol）桥接器，使 Codex 能够将有界的编码与分析任务安全地委托给 OpenCode 执行，同时将任务状态、Prompt 指令、执行事件和取消生命周期置于 Bridge 的严格控制之下。

> **当前阶段（Phase 7 状态）：** 已实现基于 macOS Seatbelt 的只读隔离与写入限制、子进程环境变量白名单过滤、`agent_preflight` 预检、`agent_delivery` 交付快照与校验、上下文哈希快照、Provider 异常熔断与本地 `bridge resume` 恢复通道、以及基于证据强度的审查提示。CLI 任务审查工具、安装/卸载文档、预算控制、Worktree 清理、人工审批、后台守护进程持久化、崩溃安全恢复与本地实时会话监视器均已就绪。

---

## 核心特性

- **标准 MCP Stdio 服务**：采用 `@modelcontextprotocol/server` v2，无缝对接各类 MCP 宿主（如 Codex CLI）。
- **15 个功能 MCP 工具**：
  - `agent_viewer`：获取本地实时任务监视器地址与连接状态
  - `agent_capabilities`：无模型调用的策略发现（允许的模型、调度上限、沙盒模式等）
  - `agent_preflight`：委托前安全预检（路径白名单校验、Git HEAD/Dirty 检查、权限模拟）
  - `agent_spawn`：创建并排队执行新任务（支持只读分析与写入修改）
  - `agent_wait`：阻塞等待单个或批量任务完成，支持增量超时
  - `agent_events`：长轮询获取实时脱敏事件流（按序号增量拉取）
  - `agent_status`：非阻塞快速获取当前状态、Token 用量与结果摘要
  - `agent_history`：查看完整脱敏事件历史
  - `agent_message`：多轮对话续接（沿用原会话上下文、工作区与权限模型）
  - `agent_diff`：对比审查工作区变更（修改、新增、删除及未跟踪文件）
  - `agent_result`：轻量级紧凑结果查询接口
  - `agent_delivery`：获取包含 Base Commit、完整补丁 SHA-256、执行命令与验证间隙的不可变交付报告
  - `agent_abort`：主动安全中止排队中或运行中的任务，支持生命周期验证
  - `agent_list`：按状态/时间/关联根任务列出所有任务
  - `agent_cleanup`：安全规划与清理已完成任务的临时 Worktree 和日志
- **系统级安全隔离（macOS Seatbelt & 沙盒）**：
  - 只读任务通过 macOS `sandbox-exec` 隐藏用户主目录、系统临时目录和外部挂载点。
  - 写入型任务强制在独立的 Git Worktree 中运行，主工作区免受意外破坏；严格限制只能修改指定 `write_paths`。
  - 严格的环境变量过滤：移除云平台凭据、SSH 密钥和 CI Token，仅传递必要的基础运行变量。
- **本地凭据隔离网关（Model Gateway）**：
  - 上游大模型 API 凭据保留在 Bridge 守护进程内，Worker 进程仅分配虚拟 Key，且网络被限制在仅能访问本地 Localhost 代理。
- **FIFO 任务调度队列与生命周期管理**：
  - 任务并发数与队列长度可配，支持幂等键（Idempotency Key）。
  - 支持调用方完全掌控的任务超时设定（默认不设硬超时，防止误杀长时间推理任务）。
  - 轮次级（Turn-scoped）完成确认，防止历史会话中的旧 Idle/Error 伪造本轮成功。
- **后台守护进程（Daemon）与 SQLite 持久化**：
  - 后台守护进程通过 Unix Domain Socket 提供 IPC 服务；MCP 适配器或 Codex 退出不影响后台任务执行。
  - 状态、事件、会话与模型消耗全量写入 SQLite，进程崩溃重启后自动标记为 `interrupted`（不会盲目重试产生副作用）。
- **本地实时会话监视器（Local Conversation Viewer）**：
  - 极简 Geist/Vercel 设计风格的前端页面，实时轮询展示委派任务的 Prompt、OpenCode 回复、Tool 调用卡片与 Diff 补丁。
  - 单例标签页复用（避免重复弹窗），支持代码高亮、Markdown 渲染与局部展开。
- **CLI 命令行工具（`bridge`）**：
  - 提供 `bridge preflight`, `bridge tasks`, `bridge status`, `bridge logs --follow`, `bridge diff`, `bridge delivery`, `bridge approve`, `bridge resume` 等运维命令。

---

## 环境要求

- **操作系统**：macOS（推荐 Apple Silicon）或 Linux
  - *注：写入型沙盒隔离与 Seatbelt 依赖 macOS `sandbox-exec`；Linux 仅支持基于 OpenCode 权限控制的只读模式。*
- **Node.js**：**Node 24 LTS**（由于依赖要求，Node 23 不支持）
- **包管理器**：pnpm 10+
- **Git**：用于 Worktree 管理与 Diff 计算
- **OpenCode**：已安装并在 PATH 中，推荐 **OpenCode 2.2.x**（兼容 2.1.x）
- **Codex CLI**：具备 MCP 支持（推荐 0.152.0+）

如果本地 Node 版本较旧，建议通过 Homebrew 安装 Node 24：

```bash
brew install node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version # 确认输出 v24.x
```

---

## 安装与构建

```bash
# 1. 确保使用 Node 24 安装依赖
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm install

# 2. 类型检查与构建
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm typecheck
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm build

# 3. （可选）全局链接 bridge 命令行工具以方便本地排查
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm link --global

# 4. 检查守护进程状态
bridge daemon status
```

卸载 CLI：

```bash
bridge daemon stop
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm unlink --global codex-opencode-bridge
```

---

## 配置文件配置

将示例配置文件复制到用户的配置目录下：

```bash
mkdir -p ~/.config/codex-opencode-bridge
cp examples/config.example.json ~/.config/codex-opencode-bridge/config.json
```

### 1. 基础 Mock 配置 (`config.example.json`)
```json
{
  "adapter": "mock",
  "models": {
    "default": "mock/echo",
    "allow": ["mock/echo"]
  },
  "security": {
    "allowed_repo_roots": ["/Users/you/Code"]
  }
}
```

### 2. 真实 OpenCode 配置 (`config.opencode.example.json`)
```json
{
  "adapter": "opencode",
  "models": {
    "default": "opencode/deepseek-v4.1-flash-free",
    "allow": ["opencode/deepseek-v4.1-flash-free"]
  },
  "security": {
    "allowed_repo_roots": ["/Users/you/Code"],
    "read_sandbox": "auto",
    "model_gateway": "require"
  },
  "opencode": {
    "binary": "/opt/homebrew/bin/opencode",
    "compatibility": "2.2.x",
    "startup_timeout_ms": 15000
  }
}
```

- `security.allowed_repo_roots`：**必填**，限制任务可以访问的宿主仓库根目录。不在列表内的目录在 `agent_preflight` 阶段即被直接拒绝。
- `security.read_sandbox`：在 macOS 下默认为 `auto`，自动启用只读 Seatbelt 限制；
- `security.model_gateway`：默认为 `require`，将模型凭据隔绝在网关内部。

---

## 接入 Codex

在构建出 `dist/mcp/server.js` 之后，将 Bridge 注册至 Codex CLI 中。请确保指定具体的 Node 24 路径：

```bash
codex mcp add opencode_bridge \
  --env BRIDGE_CONFIG="$HOME/.config/codex-opencode-bridge/config.json" \
  -- /opt/homebrew/opt/node@24/bin/node \
  /absolute/path/to/OpenCodeBridge/dist/mcp/server.js
```

或者直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.opencode_bridge]
command = "/opt/homebrew/opt/node@24/bin/node"
args = ["/absolute/path/to/OpenCodeBridge/dist/mcp/server.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.opencode_bridge.env]
BRIDGE_CONFIG = "/Users/you/.config/codex-opencode-bridge/config.json"
```

验证连接：

```bash
codex mcp list
```

---

## CLI 工具常用命令

Bridge 附带了功能强大的 `bridge` 命令行工具：

| 命令 | 说明 |
| --- | --- |
| `bridge preflight --repo <path>` | 预检指定代码库的安全策略与配置有效性 |
| `bridge tasks` | 查看任务列表及当前状态 |
| `bridge status <task-id>` | 查看单个任务的执行状态与 Token 消耗 |
| `bridge logs <task-id> --follow` | 实时跟踪输出任务的脱敏事件日志 |
| `bridge diff <task-id>` | 查看写入型任务产生的代码变更补丁 |
| `bridge delivery <task-id>` | 查看最终不可变交付快照与校验状态 |
| `bridge abort <task-id>` | 终止运行中或排队中的任务 |
| `bridge resume` | 清除 Provider 异常熔断标记以恢复调度 |
| `bridge approve <task-id>` | 人工审批清理未提交变更的 Worktree 目录 |
| `bridge viewer` | 输出本地任务监视器的访问 URL |
| `bridge daemon status/stop` | 查看或停止后台守护进程 |

---

## 协议与开源许可

本项目采用 [MIT License](LICENSE) 许可协议。
