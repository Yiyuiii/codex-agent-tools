# Codex External Agents 产品设计

状态：已批准  
日期：2026-07-18  
目标仓库：`D:\Codes\codex-agent-tools`

## 1. 背景与目标

`codex-cc-tools` 以 Claude Code 子进程为执行桥梁。新项目要让 Codex 通过统一 MCP 接口调用本机外部智能体，同时移除对 Claude Code 的运行时依赖。

新项目的目标是：

1. 以逻辑 LLM 为调用中心，而不是把 Pi/Kimi 等后端暴露给 Codex。
2. 用两个稳定工具覆盖只读审阅和自主执行。
3. 让 Pi 承载 Gemini、Ark Coding Plan、Ark Agent Plan 等可迁移来源。
4. 让本机 Kimi Code 通过官方 ACP 接口提供 K2.7、K3 等模型。
5. 在 Windows 上可靠隔离代理、权限、取消、超时和子进程生命周期。
6. 由插件和 Codex 维护模型注册表与 Pi 配置，不要求终端用户手工编辑配置。

## 2. 明确不做的事情

- 不调用、修改或卸载本机 Claude Code。
- 不提供 Anthropic Claude 模型来源。
- 不提供 OpenAI/Codex 模型来源；顶层已经是 Codex，避免自调用。
- 不迁移 DeepSeek 来源。
- 首版不建立常驻进程池；只有真实性能证据证明必要时才评估。
- 不把 backend、provider、真实模型名、认证或代理参数暴露给 MCP 调用者。
- 不承诺 `external_delegate` 是 OS 级沙箱。它是明确标注的可写工具，在调用者指定的工作目录内自主执行。

## 3. 产品与公开命名

- 仓库和 npm 包候选名：`codex-agent-tools`
- MCP 服务注册名：`codex_external_agents`
- 只读工具：`external_review`
- 可写工具：`external_delegate`

MCP 元数据必须准确反映权限：

- `external_review` 标注只读、非破坏性。
- `external_delegate` 标注可写、可能破坏性。

首版以 npm MCP 包和配置安装 CLI 交付。若未来增加 Codex 插件清单，也必须放在本仓库内，不能混入旧项目。

## 4. 方案选择

采用“逻辑 LLM 注册表 + 隔离运行时适配器”。

未采用的方案：

1. 所有模型都经 Pi：无法优雅复用 Kimi 本机 OAuth、ACP 会话和权限能力。
2. 每个模型单独实现调用器：会重复代理、超时、脱敏和结果解析逻辑。

## 5. 总体架构

```text
Codex
  -> codex_external_agents
      -> external_review / external_delegate
          -> 统一任务服务
              -> 逻辑 LLM 注册表
                  -> Pi RPC 适配器
                  -> Kimi ACP 适配器
```

组件边界：

1. MCP 层只负责 schema、权限注解、取消信号和进度通知。
2. 任务层构建 review/delegate 请求、Git 证据和统一结果。
3. 注册表把逻辑 `llm` 解析为唯一运行配置。
4. 运行时适配器只处理各自协议、事件和会话。
5. 环境策略构造最小子进程环境、认证和代理。
6. 进程控制器负责启动、取消、硬超时和整个进程树清理。
7. 结果规范化器以真实工具事件、文件系统和 Git 差异为证据，不盲信模型自述。

## 6. 逻辑 LLM 注册表

`llm` 在两个 MCP 工具中始终必填，没有默认值。

每个注册表条目至少包含：

- 稳定逻辑 ID 和展示名
- 是否启用 `review`、`delegate`
- 运行时类型：`pi-rpc` 或 `kimi-acp`
- 真实 provider/model 或 Kimi model alias
- 认证变量白名单
- 网络策略：`direct`、`proxy-10808`、`proxy-11808`
- 默认硬超时与最大并发数
- 思考模式映射
- 质量门状态和最近真实 smoke 证据

注册表随代码版本维护。未知或未启用的 `llm` 必须失败并列出当前受支持的逻辑 ID，不允许静默回退。

终端用户不编辑 Pi `models.json`。项目为 Pi 生成独立的配置目录和版本化 `models.json`，不读取或修改日常 `~/.pi/agent`。认证只引用环境变量，不把密钥写入生成文件。

## 7. 初始模型范围与迁移顺序

第一阶段优先完成 Kimi：

- Kimi K3
- Kimi K2.7 Coding
- Kimi K2.7 Coding Highspeed

第二阶段迁移 Gemini：

- Gemini 3.5 Flash，经 Pi Google provider

第三阶段迁移 Ark：

- Ark Coding Plan：`ark-code-latest`
- Ark Agent Plan：`glm-5.2`
- Ark Agent Plan：`doubao-seed-2.0-pro`

每个逻辑 LLM 的 review 与 delegate 分开设门。只通过 review smoke 的模型不能自动获得 delegate 能力。

## 8. Pi RPC 适配器

- 每次调用启动独立 `pi --mode rpc` 子进程。
- 使用项目生成的独立 `PI_CODING_AGENT_DIR`，不污染用户 Pi 配置。
- 通过 RPC 设置模型、思考等级、发送 prompt、处理中止并监听 settled/tool 事件。
- review 仅启用 read/grep/find/ls 等只读工具，不启用 shell、edit、write。
- delegate 启用所需完整工具。
- stdout 只解析 JSONL；stderr 单独采集、限长和脱敏。
- 兼容 LF、CRLF、分片行、未知事件和尾部不完整行。

## 9. Kimi ACP 适配器

- 每次调用启动独立 `kimi acp` 子进程。
- 优先从 PATH 查找 `kimi`，Windows 下同时探测 `~/.kimi-code/bin/kimi.exe`。
- 沿用本机 Kimi OAuth、模型配置和会话存储。
- ACP 客户端实现 initialize、authenticate、session/new/load/resume、prompt、cancel 和必要的反向 RPC。
- review 只允许工作目录内的文件读取；拒绝文件写入、shell 和其它修改性权限请求。
- delegate 根据工具契约批准自主执行所需权限。
- 支持返回和续接 `sessionId`；不支持续接的逻辑 LLM 收到 `sessionId` 时明确失败。

## 10. MCP 输入契约

### `external_review`

必填：

- `llm`
- `task`：`review_plan`、`review_diff`、`review_doc`、`adversarial_review`
- `prompt`
- `cwd`：绝对、存在的目录

可选：

- Git diff/status/untracked 证据选项
- 上下文和验收标准
- `timeoutMs`，受注册表上下限约束

### `external_delegate`

必填：

- `llm`
- `prompt`
- `cwd`：绝对、存在的目录

可选：

- `sessionId`
- `timeoutMs`，受注册表上下限约束

两个工具均不接受 backend、provider、model、effort、tools 或 proxy 参数。

## 11. 输出契约与证据

公共字段：

- `ok`
- `status`
- `llm`
- 非秘密的实际模型标识
- `elapsedMs`
- `sessionId`（若有）
- `diagnostics`

review 额外返回：

- 最终审阅文本
- 结构化 verdict/findings/missing context（可用时）

delegate 额外返回：

- `summary`
- `filesChanged`
- `commandsRun`
- `verification`
- `risks`

结构化输出不依赖模型严格遵守 JSON schema。桥接层同时采集协议工具事件、执行前后文件系统和 Git 证据；模型自述只作为补充。所有返回内容统一脱敏和限长。

## 12. 网络与环境策略

每个逻辑 LLM 固定一个网络策略。调用者不能覆盖。

- `direct`：删除 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 及小写变体。
- `proxy-10808`：只向该子进程注入 `http://127.0.0.1:10808`。
- `proxy-11808`：只向该子进程注入 `http://127.0.0.1:11808`。

子进程环境不能直接复制完整父环境。环境构造器只保留 Windows/Node/终端运行所需基础变量，再加入该 LLM 的认证变量、固定代理和必要的 Kimi/Pi 路径。不得把其它 provider 的凭据暴露给当前子进程。

诊断允许报告 endpoint host、认证变量名和代理路由，但不能报告密钥值或 Authorization 头。

## 13. 权限与工作区边界

### Review

- Pi 只注册只读工具。
- Kimi ACP 只实现限定在 `cwd` 内的文件读取，并拒绝写入与 shell 权限。
- 桥接层在任务前后记录 Git status/diff 指纹。发现意外修改时将任务判为失败并报告最小证据。
- 工具限制是主要边界，前后指纹是纵深检测。首版不声称对恶意本地二进制提供 OS 级隔离。

### Delegate

- `cwd` 必须是绝对、存在的目录。
- delegate 在调用者指定目录执行，不擅自建立 worktree 或副本。
- 启动前采集 Git/文件基线，结束后从真实状态计算变化。
- 因为这是明确的可写工具，调用者负责选择合适的现有工作目录、worktree、容器或 OS 边界。

## 14. 取消、超时、进程树和并发

- MCP AbortSignal 必须显式传到适配器和进程控制器。
- 只使用硬期限，不使用“暂时无 stdout”空闲期限。
- Kimi K3 真实审阅曾约 97 秒才返回首个 JSONL 消息；桥接层在子进程沉默时发送自身心跳进度。
- Windows 上终止父进程不会自动终止后代。进程控制器优先使用 Job Object 的 `KILL_ON_JOB_CLOSE`；只有在经过测试后才启用树终止后备路径。
- 取消和超时返回 `cancelled`/`timed_out`，并包含已取得的部分证据，不得伪装成功。
- 注册表为每个 LLM 设置并发上限；排队本身支持取消。默认不自动重试 delegate，防止重复写入。

## 15. 错误处理

- 未知/禁用 LLM：失败并返回受支持逻辑 ID。
- 缺少认证：报告缺少的环境变量名，不显示值。
- 固定代理不可达：报告逻辑路由和非秘密 endpoint host。
- 协议解析错误：保存脱敏、限长的 stderr/event 尾部。
- 结构化模型输出无效：保留最终文本，以桥接证据生成可验证字段。
- 指定 LLM 失败时不切换其它 LLM。
- review 可以在尚未执行任何工具前对明确瞬时网络错误做同 LLM 有界重试；delegate 一旦开始执行就不自动重试。

## 16. CLI 与运维

提供：

- `install`：幂等注册 `codex_external_agents` MCP 服务。
- `uninstall`：只删除本项目拥有的配置，不影响其它 MCP 服务。
- `doctor`：检查 Pi/Kimi 二进制、版本、认证存在性、模型注册表、隔离配置、代理端口、每个 LLM 的启用/门禁状态。
- `--version`、`--help`。

模型状态不增加第三个 MCP 工具；Codex 在工具参数校验错误和 CLI doctor 中获得可用模型信息。

## 17. 测试策略

行为代码采用 TDD。

单元测试：

- 注册表唯一性、任务能力和逻辑 ID
- 环境白名单、代理注入/清除、密钥脱敏
- 输入/输出 schema
- Git 基线和证据规范化
- 权限决定和路径边界

协议测试：

- Fake Pi RPC 与 Fake Kimi ACP 子进程
- JSONL 分片、LF/CRLF、未知事件、异常退出、stderr 洪泛
- 取消、硬超时、心跳、排队取消
- Windows 进程树清理和文件锁释放

真实 smoke：

- 每个逻辑 LLM 分别验证认证、实际后端、固定网络路由和模型标识
- review 验证无工作区修改
- delegate 在隔离测试仓库验证真实写入、命令和 Git 证据
- 取消/超时后验证没有孤儿子进程

每个“逻辑 LLM × task”只有在真实 smoke 通过后才启用。

## 18. 迁移与发布

1. 新旧 MCP 服务短期并存。
2. 优先交付 Kimi review，并用本机 Kimi 参与后续设计/实现审阅。
3. 完成 Kimi delegate 后迁移 Gemini，再迁移 Ark 两类计划。
4. 所有目标线路通过真实 smoke 后，从 Codex 配置停用 `codex_cc_tools`。
5. 新项目不提供 `cc_review`/`cc_delegate` 兼容别名，避免继续暗示 Claude Code 依赖。
6. 发布前重新核查 npm 名称、包内容、安装/卸载幂等性和 Windows 全新环境流程。

## 19. Kimi 独立审阅及采纳情况

2026-07-18 使用本机 Kimi K3 对设计做只读审阅。

采纳：

- review 采用只读白名单和权限拒绝，不依赖修改性命令黑名单。
- Windows 必须清理整个进程树。
- MCP 取消必须传播到子进程。
- 子进程使用环境白名单，所有结果脱敏。
- 增加注册表并发上限。

部分采纳：

- Kimi 建议 delegate 强制 worktree。项目不强制改变调用者执行空间，因为 delegate 的产品合同就是在指定目录自主执行；改为必填绝对 `cwd`、明确破坏性标注和执行前后真实证据。

调试证据：

- 完整 K3 审阅超过 184 秒外层期限，并暴露出父进程超时后 `kimi.exe` 孤儿仍存活。
- 缩短提示后的同模型调用约 97 秒成功，说明沉默期不能被当成协议挂死，也证明必须使用进程树级清理。

## 20. 验收条件

项目达到首个可替代版本时必须满足：

1. Codex 只看到 `external_review` 与 `external_delegate`。
2. `llm` 始终必填，无法覆盖注册表后端和代理。
3. Kimi、Gemini、Ark Coding Plan、Ark Agent Plan 的已启用任务都有真实 smoke 证据。
4. 不调用 Claude Code，不提供 Anthropic、Codex 或 DeepSeek 来源。
5. review 真实验证不修改工作区。
6. delegate 的修改、命令和验证结果有桥接层证据。
7. 代理、凭据和子进程相互隔离，日志无密钥。
8. Windows 取消和超时不遗留子进程。
9. 安装、doctor、卸载和 release smoke 通过。

