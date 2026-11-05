# codex-run

[English](README.md)

**Claude 派活，Codex 干活，只有该你拍板的事才会找你。**

Codex 中途提问时，Claude 依据任务、文档和代码当场作答，Codex 从停下的地方接着干。产品取舍、范围变更、不可逆操作仍然交给你，其余的都不用停。

`codex-run` 是一组 Claude Code skills 加一个 CLI，用来把任务交给 [OpenAI Codex](https://github.com/openai/codex)。任务运行在**本机的 Codex app-server daemon** 上，和 Codex app 用的是同一个 daemon，所以每个会话都能在 Codex app 里查看、续接或接手。

- **提问不卡流程**：Codex 或它的子代理一提问，Claude 就把答复送回同一个等待中的 turn。
- **随时插手**：在 Codex app 里直接回答或改方向，Claude 会看到，不会重复作答。
- **每句汇报都能核对**：每次运行都会记录 Codex 上报的命令及退出码、改动的文件、实际使用的模型和沙箱，以及完整的事件日志。
- **断了能接上**：客户端退出后可用 `--attach` 重新跟随正在运行的 turn，用 `--stop` 中断它。模型满载时在同一会话上自动续跑。

## 运行要求

- Linux 或 macOS。daemon 监听 Unix socket，所以不支持 Windows，请用 WSL。
- Node.js ≥ 20。
- Codex CLI ≥ 0.164.0，并已登录（`codex login`）。daemon 由 `codex-run` 自动启动（`codex app-server daemon start`）。

## 安装

推荐作为 Claude Code 插件安装：

```
/plugin marketplace add kcng0/cc-codex-run
/plugin install codex-run@cc-codex-run
```

也可以通过 npm 安装 CLI，再把 skills 复制到 `~/.claude/skills`：

```bash
npm install -g cc-codex-run
codex-run --install-skills          # 已有同名 codex / codex-delegate skill 时，加 --force 会先把它们改名备份
```

也可以用 [skills CLI](https://github.com/vercel-labs/skills) 安装到当前项目（`.claude/skills/`），加 `-g` 则装到用户目录：

```bash
npx skills@latest add kcng0/cc-codex-run -a claude-code -s '*'
```

插件安装的 skill 带命名空间（`codex-run:codex`）。另外两种方式装的是不带命名空间的 `codex` 和 `codex-delegate`：如果 `~/.claude/skills` 里已有同名的个人 skill，它会优先于项目级安装的 skill 生效；用户级安装则可能把它覆盖掉。

## Skills

- **`codex`**：教 Claude 用 `codex-run` 派发任务、答复提问、续接、重新跟随、停止和 review。
- **`codex-delegate`**：委派策略。默认交给 Codex 的是三类工作：接口合同已定的模块实现、独立验收、提交前审查；UI 工作留给 Claude。范围可以在你自己的 CLAUDE.md 里放宽或收窄。

## CLI

```bash
codex-run --role implement -C ~/repo task.md            # 新会话
codex-run --resume <thread> -C ~/repo follow-up.md      # 在同一会话上开下一轮
codex-run --answer <提问线程> -C ~/repo answer.md
codex-run --attach <thread> -C ~/repo
codex-run --review --base main -C ~/repo [focus.md]
codex-run --ps | --stop <thread> | --roles | --models
```

输出格式：

- 默认是 `key=value` 行，依次为 `status`、`job`、`session`、`model`、`sandbox`、`report`、`commands`，后面跟改动文件、问题或错误信息。
- 加 `--json` 时改为输出一个 JSON 对象。
- 退出码：`ok` 和 `question` 为 0，其余状态为 1。

全部参数见 `codex-run -h`。

Codex 提问时，运行以 `status=question` 退出，打印问题和要执行的 `--answer` 命令；turn 留在 daemon 上等待，`--answer` 把答复送回同一个 turn。如果问题已经在 Codex app 或其他客户端里答过，`--answer` 不再发送，输出 `not_sent=` 和 `prior_reply=`，改为跟随该 turn。

### 角色

角色就是一个 Codex agent TOML 文件。`--role NAME` 先读 `$CODEX_HOME/agents/NAME.toml`；找不到时回退到 `plugin/skills/codex/roles/` 里自带的示例角色（`implement`、`check`、`critic`、`explore`）。自带角色不指定模型，由你的 Codex 配置决定。

要自定义角色，在 `$CODEX_HOME/agents/` 下建同名文件，它会覆盖自带角色；新名字同理。`codex-run --roles` 列出全部角色，并标出哪些是自带的。只读取以下字段：

```toml
# ~/.codex/agents/implement.toml
description = "在明确的文件归属内实现一个模块"
model = "gpt-6.1-sol"             # 可选，取自 `codex-run --models`；不写则用 Codex 配置
model_reasoning_effort = "high"   # 可选
sandbox_mode = "workspace-write"  # 可选：read-only | workspace-write | danger-full-access
developer_instructions = """
...
"""
```

如果同一个文件也注册成了 Codex 的 agent role（在 `config.toml` 里写 `[agents.<name>] config_file = ...`），Codex 自己的子代理也会用它，其中的 `sandbox_mode` 和说明对两边同时生效。

### 沙箱与审批

沙箱按以下优先级确定：

1. `-s` 参数；
2. 角色的 `sandbox_mode`；
3. 两者都没有时，新会话使用 Codex 配置的默认沙箱。

`codex-run` 会记录每个会话运行时的沙箱（存于 `$CODEX_RUN_HOME/threads/`，保留 90 天）。不带 `-s` 或角色执行 `--resume` 时：

- 如果 daemon 报告的沙箱比记录的更宽（daemon 从磁盘重新加载会话后会退回配置默认值），就重新应用记录值；
- 如果比记录的更窄，就保持不变，绝不放宽。

`--answer` 和 `--attach` 不接受 `-s`，因为正在等待的 turn 保留它启动时的沙箱。

审批始终关闭（`approvalPolicy=never`），因为没有人在旁边批准。在受限沙箱里，需要越界的命令会直接失败而不是等待批准，所以要按任务选够用的沙箱。`danger-full-access` 意味着 Codex 可以不受限制地访问本机。

受限沙箱对 shell 命令的限制如下（Linux、Codex 0.164.0 实测）。Codex 内置的 web search 不是 shell 命令，在 `read-only` 下也能用。

| | read-only | workspace-write |
|---|---|---|
| 读文件 | 可以 | 可以 |
| 写 `-C` 目录和 `/tmp` | 不可以 | 可以 |
| 写其他位置（`~/.cache`、`~/.npm`、`~/.cargo` 等） | 不可以 | 不可以 |
| 写 `.git`（commit、建分支） | 不可以 | 不可以 |
| 网络，包括本机 localhost 服务 | 不可以 | 仅当 `network_access = true` |
| 连接 Codex daemon | 不可以 | 不可以 |

所以在 Codex 默认配置的 `workspace-write` 下，安装依赖、把缓存放在主目录的构建（Go、Cargo、Playwright）、为端到端验证启动本地服务、提交，都会失败。可以在 `~/.codex/config.toml` 里放宽：

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/home/you/.cache"]   # 可选：仅在需要写 -C 目录和 /tmp 以外的位置时；绝对路径
```

或者对该任务传 `-s danger-full-access`。`codex-run` 启动的每个 `workspace-write` turn 都会带上这些 `[sandbox_workspace_write]` 设置。

#### 需要 MCP 工具或会执行脚本的 skills 的角色

在 `read-only` 和 `workspace-write` 下，角色可能依赖的两类能力会失败：

- **MCP 工具。** 审批关闭时，凡是需要审批的 MCP 调用都会被 Codex 直接拒绝（"MCP tool call requires approval, but approval policy is never"）。Codex 默认的 `auto` 模式下，没有标注只读的工具都需要审批，所以大多数 server（搜索、文档、代码上下文、浏览器）都用不了。`danger-full-access` 下调用不需要审批。
- **通过 shell 执行的 skills 和 CLI**，比如要联网调用 CLI 的文档查询，或者会写缓存、临时文件的 skill 脚本。它们受上表中 shell 命令的同样限制。

Codex 没有全局的 MCP 审批开关，只能按 server 单独设置（`[mcp_servers.<id>] default_tools_approval_mode = "approve"`），以后每新增一个 server 都要再加一次。

推荐做法：需要 MCP 工具、会执行脚本的 skills 或网络的角色，一律设为 `sandbox_mode = "danger-full-access"`，只读要求写进角色的 `developer_instructions`（例如"只读：不修改文件"）。这时只读靠指令约束，不再由沙箱强制。只读文件、跑简单命令的角色才保留 `read-only`。注意：`$CODEX_HOME/agents/` 里的角色文件如果也在 `config.toml` 里注册了，对 Codex 自己的子代理同样生效。

### 文件与环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CODEX_HOME` | `~/.codex` | Codex 主目录（角色放在 `agents/`） |
| `CODEX_RUN_HOME` | `$XDG_STATE_HOME/codex-run`，未设置时为 `~/.local/state/codex-run` | job 目录放在 `jobs/` |
| `CODEX_RUN_JOB_TTL_DAYS` | `7` | 启动时清理早于这个天数的已结束 job；`0` 表示不清理 |

每个 job 目录包含 `task.md`、`report.md`、`meta.json`、`events.jsonl`，以及按需生成的 `commands.jsonl`、`questions.json` 和 `stderr.log`。

## 使用须知

- `codex` skill 预先批准了自己的脚本（`allowed-tools`），Claude 启动 Codex 任务时不会弹权限确认。之后 Codex 能做什么只受沙箱限制，请据此选择角色和 `-s`。
- 运行消耗你的 Codex 账号额度。
- 运行与 Codex app 共用 daemon：会话会出现在 Codex app 里，`codex-run` 退出后 daemon 仍在运行。
- 除非加 `--allow-subagents`，Codex 自身的子代理是关闭的。

## 已知限制

- Codex 把 app-server 协议标为 experimental。`codex-run` 会拒绝 0.164.0 以下的版本，但更新的版本仍可能改动协议。
- `commands.jsonl` 只记录 Codex 以 `commandExecution` 上报的命令；Codex 通过 code-mode `exec` 工具执行的命令，daemon 不会上报。"改动文件"只包含经 apply_patch 写入的文件，实际改动范围以 `git status` 为准。
- 较旧的 Codex 在带子代理时偶尔收不到父 turn 的 `turn/completed`（0.164.0 实测未复现）。作为兜底：
  - 最终回复已出现、子代理都已结束，且静默 5 秒后，`codex-run` 会向 daemon 查询 turn 状态；
  - turn 已结束或线程已 idle，就结束运行，并输出 `inferred=` 行；
  - turn 仍在运行，就继续跟随，不会误报完成。

## 与 openai/codex-plugin-cc 的区别

官方插件也通过 app-server 调用 Codex，但每个工作区自建一个 broker 进程，提供 rescue、review 命令和 Stop hook review 关卡。

`codex-run` 直接使用 Codex 共享的 daemon，没有要管理的 broker 进程，因此不会出现 broker 进程泄漏或被误杀的问题。它的重点是提问往返、重新跟随运行中的任务和可核验的运行记录。

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
