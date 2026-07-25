# Codex External Agents 官方插件集成设计

状态：外部审阅已收敛，待维护者书面复核  
日期：2026-07-25  
目标仓库：`D:\Codes\codex-agent-tools`

## 1. 决策摘要

`codex-agent-tools` 将以本地 Codex 插件交付 `codex_external_agents` MCP 服务，而不是继续由项目 CLI 修改 Codex 的活动配置。

目标插件只暴露两个工具：

- `external_review`：只读审阅。
- `external_delegate`：可写委派。

两个工具的 `llm` 都始终必填。每个逻辑 LLM 固定绑定执行器、实际模型、凭据来源和网络策略；调用者不能指定 backend、provider、model 或 proxy。

本轮先让新插件与 `codex_cc_tools` 共存。只有官方插件安装、真实 Codex 宿主和真实模型门禁全部通过后，才另行规划旧工具移除。

## 2. 用户边界与成功条件

### 2.1 必须满足

1. 插件代码位于本仓库的隔离目录，不修改 `D:\Codes\codex-cc-tools`。
2. 不调用、修改或卸载本机 Claude Code。
3. 不提供 Anthropic Claude、OpenAI/Codex 或独立 DeepSeek API 来源。
4. Kimi 使用本机 Kimi Code ACP；Pi 承载 Gemini 与 Ark。
5. Kimi 与 Pi 对 Codex 呈现相同调用方式。
6. 主 Codex 的代理不应泄漏到默认直连的外部智能体子进程。
7. 项目代码不读取、写入、替换、备份或恢复活动的 `~/.codex/config.toml`。
8. 插件状态只通过 Codex 官方插件机制管理。
9. 未经明确授权不公开发布 npm 或公共插件。

### 2.2 本轮完成定义

本轮完成不是“stdio MCP 在仓库中能启动”，而是同时满足：

1. 插件产物自包含、可移动且不引用开发机绝对路径。
2. 官方插件 CLI 能在隔离 `CODEX_HOME` 中安装、发现、运行、卸载和重装，并留下可解释的状态差异。
3. 真实 Codex App 的新会话能发现并调用两个工具。
4. 五个逻辑 LLM 的 review/delegate 精确组合分别通过真实门禁。
5. 取消、超时和宿主断开不会留下 Pi/Kimi 子进程。
6. 新插件失败时可通过官方插件管理回滚，旧工具仍可使用。

## 3. 方案选择

### 3.1 采用：本地 Codex 插件 + 内置 stdio MCP

插件把清单、MCP 注册和自包含运行产物打包在一起。Codex 官方插件机制负责安装状态，MCP 进程仍在本机执行，因此可以复用 Kimi OAuth、Pi、系统环境变量和本地工作区。

### 3.2 不采用：远程 HTTP MCP

远程服务需要常驻进程、端口、认证和额外运维。当前能力依赖本机 Kimi/Pi 与本地文件系统，远程化没有带来相称收益。

### 3.3 不采用：项目 CLI 直接修改 Codex 配置

历史 cutover 的文件级和 MCP 自检曾通过，但重启后 Codex App 运行异常。继续维护自定义 TOML 写入、备份和恢复逻辑无法覆盖真实宿主行为，也绕开官方插件生命周期。

### 3.4 不采用：从开发仓库直接启动 MCP

依赖绝对路径、当前 `node_modules` 或构建目录只能作为开发烟测，不能作为无人手工维护的稳定交付方式。

## 4. 目标架构

```text
Codex
  -> 官方插件管理
      -> codex-external-agents 插件
          -> codex_external_agents stdio MCP
              -> external_review / external_delegate
                  -> 统一任务服务
                      -> 逻辑 LLM 注册表
                          -> Kimi ACP 适配器
                          -> Pi RPC 适配器
```

组件职责：

1. **插件清单层**：声明插件身份和内置 MCP，不包含用户密钥或机器绝对路径。
2. **MCP 层**：只负责 schema、权限注解、取消信号和进度通知。
3. **任务层**：构建审阅或委派请求，采集工作区证据并规范化结果。
4. **LLM 注册表**：把必填 `llm` 解析成唯一运行配置。
5. **协议适配器**：分别处理 Kimi ACP 与 Pi RPC。
6. **环境策略**：按 LLM 白名单下发凭据并应用固定代理策略。
7. **进程控制器**：负责硬超时、取消和 Windows 进程树回收。

上层只理解逻辑 LLM 和两类任务，不理解 Pi/Kimi 协议差异。

## 5. 插件产物与目录

目标结构：

```text
codex-agent-tools/
├── .agents/
│   └── plugins/
│       └── marketplace.json
└── plugins/
    └── codex-external-agents/
        ├── .codex-plugin/
        │   └── plugin.json
        ├── .mcp.json
        └── runtime/
            └── codex-external-agents-mcp.mjs
```

约束：

- `plugin.json` 通过顶层 `mcpServers` 引用插件根目录内的 `./.mcp.json`。
- `.mcp.json` 只声明一个名为 `codex_external_agents` 的 stdio 服务。
- `runtime/codex-external-agents-mcp.mjs` 是包含生产依赖的单文件 bundle，只要求系统提供兼容的 Node.js。
- 支持的最低 Node.js 版本为 20；doctor 和隔离插件验收都必须检查。
- 产物不能依赖仓库 `node_modules`、npm 全局包或开发仓库绝对路径。
- 本轮 marketplace 只指向仓库内插件目录，不发布到公共目录。
- 插件不需要 skills、hooks、UI 或第三个状态工具。

当前官方文档明确了插件内 `mcpServers` 文件相对插件根目录解析，但没有在同一规则中明确承诺 stdio `args` 的相对路径基准，也没有明确承诺插件 stdio MCP 会继承哪些用户环境变量。因此实现计划的第一个兼容性门禁必须在隔离 `CODEX_HOME` 中证明：

1. `./runtime/codex-external-agents-mcp.mjs` 能从安装后的插件位置启动。
2. MCP 进程能获得 Kimi 定位和目标 LLM 所需的凭据候选变量。
3. MCP 进程继承的代理变量不会绕过子进程环境白名单。
4. 官方安装和卸载对隔离 `CODEX_HOME` 中 `config.toml` 及其它状态文件产生的差异是可解释、可逆且仅限目标插件。

若任一假设不成立，停止真实安装并修订设计；不得用项目代码写活动 `config.toml` 作为后备方案。

## 6. 公共工具契约

### 6.1 `external_review`

必填：

- `llm`
- `task`：`review_plan`、`review_diff`、`review_doc`、`adversarial_review`
- `prompt`
- `cwd`：绝对、存在的目录

可选：

- `context`
- `acceptanceCriteria`
- Git diff/untracked 证据开关
- `timeoutMs`

该工具标注只读、非破坏性。任何 bash/edit/write 事件或工作区真实变化都使调用以策略违规失败。

### 6.2 `external_delegate`

必填：

- `llm`
- `prompt`
- `cwd`：绝对、存在的目录

可选：

- `sessionId`
- `timeoutMs`

该工具标注可写、可能破坏性。插件不声称提供 OS 级沙箱；调用者负责选择工作目录、worktree、容器或其它执行边界。

### 6.3 共同约束

- `llm` 没有默认值。
- 不接受 backend、provider、model、tools、effort 或 proxy。
- 未知、禁用或未通过精确任务门禁的 LLM 立即失败。
- 指定 LLM 失败时不切换其它 LLM。

## 7. 逻辑 LLM 注册表

目标公共模型面固定为：

| `llm` | 执行器与来源 | 实际模型 | 网络 | 并发池 |
|---|---|---|---|---|
| `kimi-k3` | Kimi Code ACP | `kimi-code/k3` | 直连 | Kimi，1 |
| `gemini-3.5-flash` | Pi / Google | `gemini-3.5-flash` | `proxy-10808` | Gemini，2 |
| `ark-coding-plan` | Pi / Ark Coding Plan | `ark-code-latest` | 直连 | Coding Plan，1 |
| `ark-agent-plan` | Pi / Ark Agent Plan | `ark-code-latest` | 直连 | Agent Plan，共享 1 |
| `ark-agent-deepseek-v4-flash` | Pi / Ark Agent Plan | `deepseek-v4-flash` | 直连 | Agent Plan，共享 1 |

说明：

- `ark-coding-plan` 与 `ark-agent-plan` 使用同一主模型，但绑定不同 endpoint、凭据和额度池。
- `ark-agent-deepseek-v4-flash` 是 Ark Agent Plan 内的经济快速档，不恢复独立 DeepSeek 后端。
- 两个 Agent Plan 逻辑 LLM 共享同一个并发为 1 的 provider 配额池，不能因为逻辑 ID 不同而并行击穿上游额度。
- 删除公共枚举中的 `kimi-k2.7`、`kimi-k2.7-highspeed`、`ark-agent-glm-5.2` 和 `ark-agent-doubao-seed-2.0-pro`。
- 删除的历史 smoke 证据保留为历史记录，但不能被解释为当前启用能力。
- 每个“逻辑 LLM × review/delegate”必须有与当前固定路由一致的新真实证据，不能复用已更换模型的旧证据。

## 8. 网络与凭据

每个子进程从最小基础环境开始构造：

1. 保留 Windows、Node、终端和 CLI 定位所需变量。
2. 删除父环境中所有大小写形式的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`。
3. 只对 `gemini-3.5-flash` 注入 `http://127.0.0.1:10808`。
4. Kimi 与 Ark 子进程保持直连。
5. 当前没有 Claude 后端，因此 `11808` 不参与运行。

目标网络策略类型只保留 `direct` 与 `proxy-10808`；实现阶段删除未被任何当前 LLM 使用的 `proxy-11808` 死分支。

主 Codex 如何联网不属于插件控制范围。即使 Codex 自身通过代理启动，插件也不能让该代理隐式泄漏给直连子进程。

凭据只从用户环境变量读取：

- Kimi 沿用本机 Kimi Code 自有认证。
- Gemini 只选择约定候选中的第一个非空变量。
- Ark Coding Plan 与 Ark Agent Plan 使用各自候选白名单和项目私有目标变量。

日志、诊断、证据和插件文件都不得包含密钥值、Authorization 头或完整父环境。允许报告命中的变量名、非秘密 endpoint host 和逻辑网络策略。

## 9. 调用与结果流

```text
MCP 输入
  -> 严格 schema 校验
  -> LLM 注册表解析
  -> 任务能力门禁
  -> 工作区基线
  -> 环境与进程启动
  -> ACP/RPC 事件流
  -> 取消/超时/策略监控
  -> 工作区与工具证据
  -> 脱敏、限长、统一结果
```

统一结果至少包含：

- 成功状态和失败阶段
- 逻辑 `llm`
- 非秘密实际模型标识
- 最终文本或委派摘要
- 真实文件变化、命令和验证证据
- 耗时、会话 ID（若支持）和脱敏诊断

模型自述只是补充。文件变化、命令和验证字段优先来自协议工具事件、文件系统和 Git 证据。

## 10. 错误、取消与重试

- 输入、LLM、能力门禁和凭据错误在启动子进程前失败。
- 网络、上游、协议解析和异常退出按阶段分类，返回限长、脱敏诊断。
- `external_delegate` 不自动重试完整任务，避免重复写入。
- `external_review` 默认也不自动重试模型调用。
- 不允许任何任务自动换模型或换 Plan。
- MCP AbortSignal、硬超时和宿主断开都传播到适配器。
- 结束时必须清理完整 Windows 进程树，并以进程快照或等价机制验证。
- 取消、超时或策略违规不能伪装为成功；已有部分证据可以随失败结果返回。

## 11. CLI 与配置边界

目标公共 CLI 不再提供会写 Codex 配置的 `install`、`uninstall`、`restore` 或 cutover 路径。

- 安装和卸载由 `codex plugin` 或 Codex 官方插件界面负责。
- `doctor` 保留为只读运行时、凭据存在性、代理端口、插件产物和模型门禁诊断。
- `doctor` 默认不得读取活动 `~/.codex/config.toml`，也不得通过默认路径检查历史 MCP 注册。若保留 `--config` 作为测试能力，只能检查调用者显式传入的非活动测试文件，并拒绝解析为活动路径的参数。
- 如果保留配置文本变换器用于历史回归，只能作为不接触活动文件的内部纯函数测试，不得暴露默认活动配置路径。
- 项目不得通过“先备份再写入”规避活动配置禁令。

用户已同意采用 Codex 官方插件机制管理插件状态，但该同意不替代对真实写入行为的取证。隔离门禁必须先记录官方安装器的精确状态差异；若真实安装会修改活动 `config.toml`，执行前仍需向用户展示必要性、预计精确差异、验证和回滚方案，并取得针对该次官方安装操作的明确许可。

## 12. 安装、升级与回滚

### 12.1 隔离阶段

1. 构建插件 staging 目录。
2. 扫描绝对路径、秘密和未打包依赖。
3. 使用临时 `CODEX_HOME` 和仓库 marketplace 运行官方插件安装，并记录安装前后的完整文件清单、内容哈希和语义差异。
4. 验证安装后路径中的 MCP initialize、listTools、凭据可见性、代理隔离和代表性调用。
5. 通过官方命令卸载、重装并验证幂等性、状态差异范围和回滚完整性。

### 12.2 真实宿主阶段

隔离阶段全部通过后：

1. 根据隔离取证确认官方安装会触碰哪些真实状态；若包含活动 `config.toml`，先取得针对该次操作的明确许可。
2. 通过 Codex 官方插件管理界面或官方安装流程安装。
3. 刷新 Codex，并在新会话中检查工具。
4. 执行 Kimi 与 Pi 代表性真实调用。
5. 检查取消和进程回收。

不得因为隔离 CLI 测试通过就宣称真实 Codex App 集成完成。

### 12.3 回滚

- 新插件失败时只通过官方插件管理卸载或移除。
- 不修改或恢复活动 `config.toml`。
- `codex_cc_tools` 在真实宿主门禁完成前保持原状。
- 旧工具移除是后续独立变更，必须有自己的验收与回滚。

### 12.4 升级

- 插件版本以 `plugin.json` 和 marketplace 条目为准，两者必须一致。
- 升级先在新的隔离 `CODEX_HOME` 中重复安装、启动、状态差异和卸载验证。
- 真实升级前比照 §12.2 执行状态差异确认；若会触碰活动 `config.toml`，取得针对该次升级的明确许可。
- 真实环境只使用官方 marketplace 升级流程，不运行项目自定义配置迁移。
- 升级失败通过官方插件管理回到上一已验证版本；不得恢复历史 TOML 备份。

## 13. 测试与验收门禁

行为代码使用 TDD。

### 13.1 确定性测试

- 工具 schema 与 `llm` 必填
- 五项注册表唯一性和固定路由
- Coding Plan 独立并发池以及两个 Agent Plan LLM 共享并发为 1 的配额池
- 代理清理、Gemini `10808` 注入与凭据白名单
- review 写入检测
- 取消、硬超时、排队取消和 Windows 进程树回收
- 日志、事件和结果脱敏
- 单文件 bundle 无外部生产依赖
- staging 产物无开发机绝对路径
- doctor 默认不读取活动 Codex 配置，显式测试配置也拒绝活动路径

### 13.2 隔离插件验收

- 本地 marketplace 可被官方 CLI 识别
- 插件能安装、列出、启动、卸载和重装
- 安装后的副本从任意临时路径运行
- 安装、卸载和升级对隔离 Codex 状态目录的差异均被记录并验证可逆
- MCP 进程能看见所需凭据候选，但不会向非目标子进程泄漏
- Codex 只发现 `external_review` 与 `external_delegate`
- 两个工具元数据准确反映只读/可写权限

### 13.3 真实模型验收

五个 LLM 分别执行 review 与 delegate，共十个精确门禁：

- review 证明无工作区修改
- delegate 在隔离临时仓库完成真实写入和验证
- 返回的实际模型和路由与注册表一致
- 失败不回退到其它 LLM
- 每次 smoke 后无孤儿进程

Pi smoke 的残留进程检查使用全机快照，因此真实门禁串行执行。

### 13.4 真实 Codex App 验收

- 新会话正常启动
- 插件由官方界面显示为已安装
- 只暴露两个目标工具
- 至少一次 Kimi ACP 和一次 Pi 调用成功
- 取消后无残留进程
- 旧工具仍可用

只有四层验收全部通过，才可以称为“已具备替代条件”。

## 14. 文档与状态迁移

实现时必须同步更新：

- `AGENTS.md`：用户边界、当前事实和当前计划索引
- 原产品设计：标记本设计对安装、模型清单和切换部分的覆盖关系
- `docs/operations.md`：改为官方插件运维，不再指导配置写入
- `docs/migration-from-codex-cc-tools.md`：改为先共存、后独立移除
- Kimi/Gemini/Ark smoke 文档：区分历史证据与当前五项模型面
- release checklist：增加隔离插件和真实 Codex App 两级宿主门禁

文档必须明确区分用户原始要求、当前事实和目标状态，不能继续保留“已完成真实切换”的失效结论。

## 15. 官方依据

- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- Codex 当前手册把 `codex plugin` 和 `codex plugin marketplace` 列为稳定命令，并说明已安装插件可以提供 MCP 服务。

## 16. 外部审阅与裁决记录

本节是 AI 历史总结，不构成新的用户要求。

### 16.1 Kimi K3

2026-07-25 使用当前 `external_review(llm: "kimi-k3")` 对初稿进行只读审阅，实际模型为 `kimi-code/k3`，工作区无修改。采纳的实质问题：

1. 在隔离 `CODEX_HOME` 中记录官方安装/卸载对所有 Codex 状态文件的精确差异。
2. 把插件 MCP 的凭据环境继承和代理继承加入兼容性门禁。
3. 明确两个 Ark Agent Plan 逻辑 LLM 共享并发为 1 的配额池。
4. 明确 doctor 默认不读取活动 Codex 配置。
5. 补充 Node.js 最低版本、删除 `proxy-11808` 死分支和官方升级路径。

Kimi 把“官方安装器可能写活动配置”视为未经授权。Codex 结合用户此前对官方插件路线的同意后，没有简单接受“官方机制也一律禁止”的解释，而是采用更严格的分阶段边界：先在隔离环境取证；若真实官方安装或升级会触碰活动 `config.toml`，仍在执行前展示预计精确差异、验证和回滚，并取得针对该次操作的明确许可。

### 16.2 Ark Coding Plan

第一次并行审阅因 Pi stdout `EPIPE` 在返回审阅内容前失败，工作区无修改。缩小证据包后重新显式调用 `external_review(llm: "ark-coding-plan")`，实际模型为 `ark-code-latest`；审阅确认上述四个核心修订均已闭合，没有阻断或重要正确性问题。其唯一有效补充是要求真实升级也显式复用逐次许可门，已写入 §12.4。

### 16.3 Gemini

`external_review(llm: "gemini-3.5-flash")` 因 Google 免费层 429 配额失败，没有产生可供裁决的审阅内容，工作区无修改。Codex 没有把配额失败解释为设计通过，也没有自动改换模型。
