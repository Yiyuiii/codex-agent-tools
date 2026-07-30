# 真实插件安装审阅状态包 — authorization consumed / host acceptance partial

日期：2026-07-30

目标发布分支：`main`；当前预备分支：`codex/stable-0.1.0`

候选包版本：`0.1.0`

版本迁移依据：稳定版只变更发布版本元数据与相应当前版本测试夹具，没有改变
逻辑 LLM 注册表、能力实现、运行路由或固定 evidence；8/8 能力索引在新版本下
重新验证通过，因此本授权材料的能力结论可从 beta.1 直接迁移，不需要重跑真实
模型资格批次。

## 状态摘要

本状态包最初用于请求一次明确的真实安装许可；维护者已于 2026-07-30 授权本次 add 与失败 remove，官方安装成功，因此该许可已经消费。完整结果记录在仓库内 `docs/release/real-host-acceptance.md`；本文件仍保留当时的动作和回滚边界，不能复用为下一次升级、移除开发注册或真实模型调用授权。

- 当前活动产品面是四个逻辑 LLM、八项 review/delegate 能力，全部固定使用 direct。
- 八项能力均由 [`capabilities.json`](../smoke/evidence/capabilities.json) 记录为 passed；`npm run verify:capabilities` 会验证不可变 source evidence、精确 passed case、registry anchor 和当前运行时指纹。
- 第 2 层临时 `CODEX_HOME` 官方插件生命周期已经通过。
- release smoke 已接入能力索引验证，并继续检查包文件面、秘密/绝对路径、文档链接闭包、MCP 契约和自包含 runtime。
- 第 4 层真实 Codex App 宿主门禁为 partial：官方安装、版本化缓存 MCP 契约和 CLI 来源消歧通过；当前 App 进程的新任务尚未加载插件工具，真实调用为 0。
- 活动 Codex 的 marketplace/plugin add 已按授权成功执行；没有执行 remove，没有读取、写入、备份或恢复活动 `~/.codex/config.toml`，也没有移除旧 `codex_cc_tools`。

最新 `four-llm-v1` 批次仍按不可改写的历史事实保留为 6 completed / 5 passed、`blocked / case_failed`。其中 passed case 可在逻辑 LLM、任务、运行时指纹和 evidence 哈希全部精确匹配时支持对应能力；批次聚合失败不再把这些 case 降级。ordinal 6 的 `account_quota_exceeded` 表示 Ark Agent Plan 当时的服务可用性，不是 Coding Plan 或整个产品的资格阻碍；实际调用 Agent Plan 时仍可能受当前额度影响。

## 为什么最终仍需要官方安装

[OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)要求用 `codex plugin marketplace` 管理 marketplace，而不是手工编辑 `config.toml`。只有未来通过官方机制把插件安装到活动 Codex，再从真实 Codex App 新会话验证工具发现、调用、取消和进程清理，才能完成第 4 层宿主验收。

当前的[隔离状态报告](plugin-isolated-state.md)只证明 Codex CLI 0.135.0 在唯一临时 `CODEX_HOME` 中可以添加 marketplace、安装缓存副本、启动 MCP、卸载插件并按官方列表语义回滚。它不证明活动 Codex App 已安装或可用，也不能代替真实宿主门禁。

## 能力资格证据

当前注册表为 8 passed / 0 pending：

| 逻辑 LLM                      | 固定后端 / 模型 / 路由                               | review | delegate |
| ----------------------------- | ---------------------------------------------------- | ------ | -------- |
| `kimi-k3`                     | Kimi ACP / `kimi-code/k3` / direct                   | passed | passed   |
| `ark-coding-plan`             | Pi / `ark-coding-plan` / `ark-code-latest` / direct  | passed | passed   |
| `ark-agent-plan`              | Pi / `ark-agent-plan` / `ark-code-latest` / direct   | passed | passed   |
| `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | passed | passed   |

能力索引的约束是：

1. 每个条目只引用该精确“逻辑 LLM × 任务”的 passed evidence；
2. batch source 必须通过 immutable-evidence verifier、manifest/evidence SHA 和精确 case 校验；
3. 唯一 legacy standalone source 只允许既有 `ark-agent-deepseek-v4-flash/delegate` 证据，不能用于任何其它能力；
4. 运行时相关代码、模型绑定、路由、凭据来源或验收语义改变时，对应 fingerprint 会失配并使该能力 fail closed；
5. 只有 stale、缺失、新增或证据失效的能力需要定向重跑；临时服务额度不自动撤销其它资格。

设计与实现边界见[能力粒度资格设计](../superpowers/specs/2026-07-29-capability-scoped-qualification-design.md)和[实施计划](../superpowers/plans/2026-07-29-capability-scoped-qualification.md)。

## 最新批次历史事实

- 冻结 commit：`0113da97a6b1fef35cc4c45025caa9e36a002176`。
- 批次：`2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`。
- ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 的 provider、模型、direct route、凭据隔离、single-attempt、零 retry/fallback 和结果文件均符合合同，但以 `account_quota_exceeded` failed；ordinal 7–8 notRun。
- manifest SHA-256：`f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`；[JSON](../smoke/evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/manifest.json)。
- 没有 recovery、resume、retry、fallback、补跑、第二入口或第二批；immutable-evidence verifier 通过，资格锁 absent，目标进程为 0/0/0。

这些事实保持原样。新资格策略不声称该批次整体 passed，也不修改任何历史 evidence。

## 预计真实安装动作

只有收到针对本次 add 与失败时 remove 的明确许可后，才可执行：

```powershell
$repoRoot = (Resolve-Path "." -ErrorAction Stop).Path
codex plugin marketplace add $repoRoot
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace add 失败，停止安装。" }
codex plugin add codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin add 失败，停止安装。" }
```

预计由官方机制改变活动插件状态；项目代码不会直接读取或编辑 `~/.codex/config.toml`。本动作不移除或修改旧 `codex_cc_tools`，不调用或修改 Claude Code，也不执行 npm 发布、推送、合并或正式工作树 fast-forward。

## 安装后验证

真实 Codex App 新会话必须验证：

- 只新增 `external_review` 与 `external_delegate`，且 `llm` 始终必填；
- 旧 `codex_cc_tools` 仍存在且未被修改；
- Kimi 与至少一条 Pi 路线完成代表性 review；
- delegate 只在隔离临时仓库执行；
- 可取消长任务结束后不残留 Kimi/Pi 进程；
- 诊断、模型输出和宿主证据均脱敏。

通过证据写入授权后才创建的 `docs/release/real-host-acceptance.md`。隔离 CLI 报告不能填充这一层。

## 官方回滚

安装失败或宿主验收失败时，只使用官方命令回滚：

```powershell
codex plugin remove codex-external-agents
codex plugin marketplace remove codex-external-agents-local
```

回滚后重新检查官方列表和工具发现。不得手工编辑、备份还原或覆盖活动 `config.toml`；如果官方 remove 失败，停止并保留最小脱敏证据。

## 下一授权节点

本次安装许可和开发期直连移除许可已经消费；旧 `codex_cc_tools` 保持不动。CLI
已经解析到插件相对入口，但当前 App 进程创建的新任务未发现插件工具并在任何真实
调用前首错停止。完整第 4 层的下一人工动作是刷新或重启 Codex App，然后创建新的
验收任务；不得通过恢复开发直连、重复真实调用或手工修改配置绕过。未来升级仍需
新的逐动作许可。
