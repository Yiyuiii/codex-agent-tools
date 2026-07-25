# 官方插件四层发布验收清单

日期：2026-07-25

分支：`codex/ark-cutover`

包版本：`0.1.0-alpha.1`

当前结论：**第 1 层确定性检查与第 2 层隔离官方插件生命周期已通过；第 3 层五项十门禁尚有四项 pending；第 4 层真实 Codex App 宿主门禁尚未执行。当前不是已安装、已替代旧工具或可公开发布状态。**

每层都必须独立成立。上层通过不能替代下层证据；任一层失败或证据缺失时，按该层停止条件执行。

## 状态总览

| 层级 | 验收对象 | 当前状态 | 通过证据路径 |
| --- | --- | --- | --- |
| 1 | 确定性单测、类型检查、构建、release smoke | passed | `test/`、`test/release/assurance.test.ts`、`scripts/release-smoke.mjs`，任务 5 提交 `874db97`、`8e59c3c`、`d235803` |
| 2 | 临时 `CODEX_HOME` 中的官方插件生命周期 | passed | [plugin-isolated-state.md](plugin-isolated-state.md)、`scripts/plugin-isolated-acceptance.mjs` |
| 3 | 五个逻辑 LLM 的十项真实模型门禁 | incomplete：6 passed / 4 pending | [Kimi](../smoke/kimi.md)、[Gemini](../smoke/pi-gemini.md)、[Ark](../smoke/ark.md)、`docs/smoke/evidence/` |
| 4 | 活动 Codex 的真实 App 宿主门禁 | not run / blocked | [real-plugin-install-review.md](real-plugin-install-review.md) 当前已存在，但只是 `blocked / not ready` 草案；只有十项真实模型门禁全部 passed 后才能重新审阅并改为 `ready`，授权后才可生成 `real-host-acceptance.md` |

## 第 1 层：确定性单测与构建

### 通过标准

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
git diff --check
```

`smoke:release` 还必须证明：

- npm pack 精确包含 marketplace、plugin manifest、`.mcp.json` 与单文件 runtime；
- runtime bundle 不依赖安装目录外生产模块，不泄漏开发机绝对路径或环境凭据值；
- MCP initialize/listTools 只公开 `external_review` 与 `external_delegate`，且 `llm` 必填；
- Codex plugin help 只在临时 `CODEX_HOME` 中运行；
- 不执行真实 add/remove、`npm publish`，也不保留 `.tgz`。

### 当前证据

任务 5 主线程复验：release assurance 24/24、全量 191/191、类型检查、构建与 release smoke 全部通过。

### 失败停止条件

任一命令非零、包文件面超出白名单、bundle 解析失败或发现秘密/绝对路径时立即停止。不得进入隔离安装、真实模型或真实 App 门禁；先在行为改动处补失败测试并修复。

## 第 2 层：隔离官方插件生命周期

### 通过标准

```powershell
npm run acceptance:plugin:isolated
```

脚本必须在唯一临时 `CODEX_HOME` 中完成官方 marketplace add/list、plugin add/list、从官方缓存副本启动 MCP、plugin remove/list 与 marketplace remove/list。调用门禁明确拒绝 pending 的 `gemini-3.5-flash`，改用 qualified 的 `ark-agent-deepseek-v4-flash` 验证从官方缓存副本调用、direct 路由、父代理清除和凭据规范化；Gemini 10808 仅由确定性环境测试与本轮真实 evidence 覆盖，不把它冒充为第 2 层成功调用。脚本还必须验证 MCP 契约、异常进程清理和官方列表语义回滚。

### 当前证据

[官方插件隔离状态报告](plugin-isolated-state.md) 记录 Codex CLI 0.135.0 的通过结果、相对状态差异、官方缓存位置和脱敏边界。该报告明确只证明隔离 CLI 生命周期，**不证明真实 Codex App 已安装或通过**。

### 失败停止条件

临时 home 边界、官方 add/list/remove、缓存副本启动、固定路由、环境白名单、进程回收或列表语义回滚任一失败即停止。不得改用活动 Codex home 诊断，也不得直接读取或写入活动 `config.toml`。

## 第 3 层：五项真实模型门禁

### 当前矩阵

| 逻辑 LLM | 固定路由 | review | delegate |
| --- | --- | --- | --- |
| `kimi-k3` | Kimi ACP / `kimi-code/k3` / direct | passed | passed |
| `gemini-3.5-flash` | Pi / Google / 同名模型 / `proxy-10808` | pending | pending |
| `ark-coding-plan` | Pi / `ark-coding-plan` / `ark-code-latest` / direct | pending | pending |
| `ark-agent-plan` | Pi / `ark-agent-plan` / `ark-code-latest` / direct | passed | passed |
| `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | passed | passed |

### 通过标准

- 五个逻辑 LLM 的 review/delegate 共十次调用必须按实施任务 7 串行执行；
- 每次实际模型、provider 与路由必须和注册表精确一致；
- review 必须找到预置缺陷且工作区零变化；
- delegate 必须只产生预期变化并观测到验证命令；
- 每次调用结束后不得有新增 Kimi/Pi 进程；
- 新证据必须脱敏并写入 `docs/smoke/evidence/`，三个 smoke 索引同步更新。

### 当前证据

2026-07-25 已严格串行执行十项精确门禁，原始结果为 8 passed / 2 failed；每次结束后的 evidence 与独立系统快照均确认无新增 Kimi/Pi RPC 进程。Kimi K3 与两个 Agent Plan profile 各自 review/delegate 均通过，共 6 项注册表能力为 passed；Gemini delegate 因免费层额度失败，Ark Coding delegate 因结果文件内容验收失败，因此这两个 profile 按成对策略共 4 项保持 pending。精确 evidence、SHA-256、模型、provider 与 route 见三个 smoke 索引。

### 失败停止条件

任一精确门禁因模型、路由、额度、工作区、工具证据或残留进程失败时，该逻辑 LLM 的 review/delegate 都不得晋级。不得复用旧模型证据、自动 fallback、并行运行 Pi smoke 或把确定性测试当成真实模型证据。五项十门禁未全 passed 前，不准备真实 App 安装执行。

## 第 4 层：真实 Codex App 宿主门禁

### 前置权限

当前尚未执行真实官方安装。项目代码不得直接读取或写入活动 `~/.codex/config.toml`；官方插件命令可能由官方机制触碰该文件，因此必须先提交 `real-plugin-install-review.md` 权限包并取得针对本次 add 与失败 remove 的明确许可。

### 通过标准

获得许可后，才可使用 [官方插件运维流程](../operations.md) 中列出的官方命令，并从真实 Codex App 验证：

- 只新增 `external_review` 与 `external_delegate`，二者 `llm` 必填；
- 旧 `codex_cc_tools` 仍存在且未被修改；
- Kimi 与至少一条 Pi 路线完成代表性 review；
- delegate 只在隔离临时仓库执行；
- 可取消长任务在结束后不残留 Kimi/Pi 进程；
- 所有结果、诊断和宿主证据均脱敏。

通过证据必须写入授权后才创建的 `docs/release/real-host-acceptance.md`。隔离 CLI 报告不能填充这一层。

### 失败停止条件

官方命令输出、工具发现、代表性调用、取消或进程清理任一异常时立即停止，且只使用权限包内的官方 remove 命令回滚。不得手工恢复、编辑或修补活动 `config.toml`。若官方回滚也异常，停止并报告，不执行旧工具移除或发布。

## 替代与发布边界

- 第四层通过只表示新插件具备替代条件，不会自动移除旧 `codex_cc_tools`。
- 旧工具移除是后续独立变更，需要新的影响评估、验证、回滚方案与明确授权。
- 本轮不调用或修改 Claude Code，不执行 `npm publish`，不发布公共 marketplace。
