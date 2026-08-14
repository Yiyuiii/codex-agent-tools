# Ark / Pi 真实能力门禁

## 当前结论

当前 Ark 公开面共有三项固定 Pi/direct 路线：

- `ark-coding-plan` → provider `ark-coding-plan` / model `ark-code-latest`；delegate/review 的历史 passed case 仍有效，当前开发候选的运行时指纹 stale。
- `ark-agent-plan` → provider `ark-agent-plan` / model `ark-code-latest`；review/delegate 的历史 passed case 仍有效，当前开发候选的运行时指纹 stale。
- `ark-agent-deepseek-v4-flash` → provider `ark-agent-plan` / model `deepseek-v4-flash`；review/delegate 不使用 legacy evidence，历史 passed case 仍有效，当前开发候选的运行时指纹 stale。

现行公共调用省略 `timeoutMs` 时，三条 Ark/Pi 路线都不设置模型执行 deadline；只有调用方显式传入的单次值会建立 deadline。Pi 生产路径的原生 retry 保持不变，资格模式仍单独执行 single-attempt、零 retry/fallback。项目不给 Pi 或其外部 CLI 设置全局/default 模型能力上限。现行 `capabilities.json` 仍保留已发布 `0.1.1` 的 passed evidence，历史 batch manifest 与 case evidence永久不可变；共享资格输入变化使当前开发候选的六项 Ark 指纹 stale。

最新真实批次 `2026-08-03T02-04-45.497Z-44fcbde6-a2bd-4f58-80c5-d723a374a923` 绑定 frozen commit `9054cbc45aaf1c91c2c62817244be5288032ede8`。六项 Ark case 的模型、provider、direct route、凭据隔离、single-attempt、零 retry/fallback 与 owned process drain 均符合合同并全部 passed；整个八项批次为 `passed`、`promotionEligible=true`。manifest SHA-256 为 `835224ccc7893d1e5f930bf2f63f29ef0bbb0a1daddaf7e85e807e626c79ecac`，不可变证据提交为 `c09ce74`。

两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的 `ark-agent-plan` 配额池。2026-07-20 对旧 `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 完成的四项 passed 证据现仅作为历史事实保留，不属于当前公开面，也不得用于晋级两个新 Agent Plan 路线。原始 evidence JSON 保持不变。

Gemini 退役后的已发布 `0.1.1` 共有四个逻辑 LLM、八项能力。当前开发候选另登记 Direct `deepseek-v4-flash`，形成五个逻辑 LLM、十项能力。资格单位仍是精确的逻辑 LLM × 任务；[`capabilities.json`](evidence/capabilities.json) 由 verifier 比较 evidence 哈希、case 身份、registry anchor 与运行时指纹。候选当前为旧八项 evidence valid / fingerprint stale，Direct 两项 evidence valid / fingerprint current；详情见 [Direct DeepSeek 接入状态](deepseek.md)。

2026-08-14 的刷新批次 `2026-08-14T03-03-14.120Z-3312323b-63e0-4b47-b88c-8fb98bb06e4e` 绑定 frozen commit `9c34156975864d529f18d21500872cf8e9d3fd5b`。ordinal 1 `ark-coding-plan/delegate` 以 `account_quota_exceeded` failed 后，协调器按合同首错停止；其余七项 notRun，终态 `blocked / case_failed`、`promotionEligible=false`。该 case 为一次 client invocation、零 adapter/runtime retry、零 fallback、owned process drained；immutable verifier 通过，manifest SHA-256 为 `7a1ca09d3f1dc1128596ec9c9d77f74aaf0239391ded50faf7f299cc7f74ca31`。没有 resume、补跑或第二批；账户额度变化前不重复真实运行。

2026-07-27 的 105 秒资格承载演练只构成离线基础设施证据。后续真实批次由单个 `functions.exec` cell 正常承载到协调器终态，证明控制层承载路径有效，但不证明四小时存活。执行边界见[承载手册](../release/four-llm-qualification-execution-runbook.md)，演练事实见[承载演练报告](../release/qualification-carrier-rehearsal.md)。当时的历史闭包为 221 files / 17 Markdown/HTML / 4 个精确插件工件（marketplace、plugin manifest、`.mcp.json`、runtime），且没有持久 `.tgz`。该历史闭包不改变任何 Ark 路由、证据或资格状态，也不表示已经发布或安装。

上一份执行到 Agent Plan 的历史记录：2026-07-28 在 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`。ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 的 provider `ark-agent-plan`、模型 `ark-code-latest`、direct route、Agent Plan 凭据隔离、single-attempt 与零 retry/fallback 均正确，结果文件精确通过，但以 `account_quota_exceeded` failed；ordinal 7–8 notRun。ordinal 1 与 6 的规定写入、规定状态命令均各一次 success，文件范围只含预期文件，证明此前 Windows shell 与资格假阳性缺口已经真实闭合。

该历史 [manifest](evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/manifest.json) SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`；终态为 6 completed / 5 passed、`blocked / case_failed`、`promotionEligible=false`，immutable-evidence verifier 通过，锁 absent，目标进程 0/0/0，20 个证据文件由提交 `6b4217d` 保存。没有 resume、retry、fallback、补跑、第二入口或第二批；其 passed case 现只作历史审计。

上一批（batch 2026-07-28T10-56-09.704Z-649886e3-233e-4da1-ac80-185227342bef）ordinal 1 Ark Coding Plan delegate 暴露了旧资格门禁假阳性：case passed，但 5 个 bash 生命周期全部为 error，精确写入命令也是 error。离线根因确认为 Pi Windows 子进程环境缺少 `ProgramFiles` 与 `ProgramFiles(x86)`，导致 Git Bash resolver 失败；提交 `2a815c7` 修复后，生产隔离环境中的 resolver 找到 `C:\Program Files\Git\bin\bash.exe`，两个系统根变量存在、代理变量为 0；精确 Ark Agent Plan 写入探针 exit 0、28 bytes、SHA-256 `81fcf915...`，代理与凭据边界不变。提交链 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 又要求资格 Pi delegate 的精确写入与精确 `git status --short` 生命周期各恰好一次且均 success；历史 blocked/interrupted 证据兼容，schema/plan、公开 MCP、provider/model/route/credential、提示词、validator、retry/fallback 均未改变。独立质量复审为 PASS、无 P0–P3。2026-07-28T14-33 批次形成了满足这些合同的 Coding Plan delegate passed case；它仍只支持当时的旧运行时指纹。

更早 blocked 历史：2026-07-28 在 frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470` 上只调用一次标准入口，启动批次 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678`。该轮 8 completed / 7 passed，因 ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 结果文件缺失而停止；manifest SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`，证据提交 `1d5d2c4`。该批整体仍是 blocked；其中 Agent Plan delegate 与 DeepSeek review 的 passed case 曾由旧索引精确复用，现只作历史审计。

上一轮 blocked 历史：2026-07-27 在 frozen commit `652e14ac637bfc04d90c448179ecc5838f2f8450` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa`。Ark Coding Plan delegate 使用 Pi RPC / `ark-coding-plan` / `ark-code-latest` / direct，结果、精确命令、隔离、进程清理和 `1 / 0 / 0 / false / false` telemetry 全部通过；[evidence](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/cases/2026-07-27T10-23-27.732Z-ark-coding-plan-delegate-ark.json) SHA-256 为 `9c08437b18874512b2313109bb3a7526b0414099c6d530bee082e2fbe92fd5e1`。Ark Coding Plan review 同样使用固定模型与 direct 路由，识别预置缺陷且工作区不变；[evidence](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/cases/2026-07-27T10-23-49.991Z-ark-coding-plan-review-ark.json) SHA-256 为 `1a6092f716fa2c0a107421f7f91eaecb1208c17f6499db80a8cc684b228fbc06`。该轮 [manifest](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json) 为 4 completed / 4 notRun，SHA-256 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`；因 ordinal 4 Kimi delegate 失败而停止，只作历史审计。

上一轮中断历史记录：2026-07-27 在冻结 commit `287b9a8bfa14805f84707adff6c7f2af19065475` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde`。preflight clean 且通过；build identity SHA-256 为 `71576ad637f1a9ee9914ebf7294b267abd43421a4df89621f45fd0adfdf034ee`，preflight SHA-256 为 `1fdd7273a57309d6f541049493a89ed342ed897c749c5cb3cf043e7e7ca30185`。执行宿主前台 shell 约 14 秒后返回 timeout 124，协调器子进程随后仍存活并发布 `batch_started` 与 ordinal 1 `ark-coding-plan/delegate` 的 `case_running`，后来退出并留下 stale owner。确认原进程已死且 Kimi ACP / Pi RPC / real-smoke 为 0/0/0 后，只对同一 batch 执行一次 `--recover-interrupted`；恢复没有调用模型、resume、retry 或 fallback，只发布 `interrupted / process_interrupted` 终态并释放锁。

中断 [manifest](evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json) 为 schema v2，SHA-256 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`，`promotionEligible=false`，包含 0 completed cases、ordinal 2–8 共 7 个 notRun、2 个 checkpoints，且没有 cases 文件、case evidence 或 `uncommittedEvidence`。现有证据只能证明 ordinal 1 进入 `case_running`，不能证明真实后端请求是否完成；因此不得为该项虚构 telemetry 或失败 evidence SHA，也不得把本次中断写成模型、route、凭据或 acceptance 失败。immutable-evidence verifier 已通过，锁已消失，目标进程仍为 0/0/0；证据由独立提交 `b76c75d` 保存（3 files / 276 insertions）。这份 interrupted 记录不替代任何既有或本轮 passed 资格证据，也不能晋级 Coding Plan pair。

上一轮历史记录：2026-07-27 只在冻结 commit `b57382ed4f2fddce4946613b5aa5739c6eed5c8f` 上启动一次四模型批次 `2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d`。第 1 项 Ark Coding Plan delegate 的实际模型、provider、direct 路由、凭据隔离、变更范围、命令和进程清理均正确，telemetry 为 `1 / 0 / 0 / false / false`，但安全读取到的 30 字节单行结果文件不含预期行，故以 `acceptance_failed` 停止。case [evidence](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/cases/2026-07-26T17-23-31.295Z-ark-coding-plan-delegate-ark.json) SHA-256 为 `166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9`；blocked [manifest](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json) SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`，`promotionEligible=false`，后七项 not run。该轮授权已经消费，批次后目标进程为 0/0/0；没有 retry、fallback、resume、跳项或第二批。

该 case 保存的 raw/normalized 双哈希可确定实际文件是 `ARK_SMOKE_OK:ark-coding-plan;\n`，分号来自旧生产提示词紧邻期望 payload 的自然语言分隔符。实现提交 `76504d7d165366ad291e6ff08026b7236f862fc8` 已把三个 Ark delegate profile 统一到精确 Node + Base64 Bash 写入命令，并把 payload 放在独立代码块中；严格结果 validator、provider/model/direct route、凭据、single-attempt、无 retry/fallback、telemetry、schema/protocol 和全部 evidence 均未修改。独立规格与代码质量审阅均 PASS；fresh 离线验证为 44 个测试文件、569 passed / 1 skipped / 0 failed，类型检查、构建、release smoke、临时 `CODEX_HOME` 隔离 check-report、当时 evidence 5/5、历史 Gemini 14/14、两代 blocked immutable verifier 及进程 0/0/0 均通过。Node `spawnSync(bash, ["-c", command])` 探针精确写入 29 bytes、LF 结尾、SHA-256 `7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59`。这些结果只证明当时的离线夹具已修复；后续真实批次形成的 Coding Plan passed cases现由能力索引使用。此段只作历史根因与修复记录。

2026-07-26 的旧五模型原子重认证批次在第 1 项 Gemini delegate 失败后立即停止，六项 Ark case 均为 not run。该历史批次没有替换下述 2026-07-25 Ark 证据；blocked [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json) 的 SHA-256 为 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`，批次后目标进程分类为 0，未重试或另开批次。它现在只作为 `five-llm-v1` 历史审计材料保留，不能参与当前四模型晋级。

2026-07-20 历史 passed evidence 使用的旧隔离配置 SHA-256 为 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`。2026-07-25 本轮三模型配置包含 Agent Plan 的 `ark-code-latest`、`deepseek-v4-flash` 与 Coding Plan 的 `ark-code-latest`；按生成器实际输出计算的 SHA-256 为 `61ffbd4c6ea41adc6a8313f957b732da2b98b8b28b082c52a95226b2a6fb2fe9`。两代配置的 endpoint host 均固定为 `ark.cn-beijing.volces.com`，网络策略均为 direct。

2026-07-25 的六项 Ark 门禁严格串行执行，未重试或 fallback。每次 evidence 都确认环境隔离与无新增 Pi RPC 进程；每次 evidence 验收后的独立系统快照也确认 Kimi 与 Pi RPC 进程数均为 0。Coding Plan 的 delegate 失败被如实保留，因此 review 即使单独 passed 也不启用；两个 Agent profile 各自两项全部通过后才使用下方稳定 anchor 晋级。

Ark Coding 的本机用户环境变量实际命名为 `API_KEY_DOUBAO_CODING`。注册表现按 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 的顺序选择第一个非空值，并只向 Pi 子进程注入项目私有变量 `CODEX_AGENT_ARK_CODING_KEY`。Ark Agent 使用 `OPENAI_API_KEY_DOUBAO`，规范化为 `CODEX_AGENT_ARK_AGENT_KEY`。

本轮所有 review 都找到预置正确性缺陷且工作区无修改。两个通过的 Agent delegate 只生成指定文件并观测到验证命令；Coding Plan delegate 只变更预期文件且观测到命令，但文件内容检查失败。证据文件不含密钥、认证头、完整环境、开发机绝对路径或上游原始错误正文。

## 当前证据矩阵

当前 [`capabilities.json`](evidence/capabilities.json) 的三条 Ark 路线六项记录全部引用 2026-08-03 passed batch case，evidence SHA-256 仍由 verifier 验证有效；共享资格输入变化使当前开发候选的六项运行时指纹 stale。以下 2026-07-25 条目只保留为历史基线，不代表当前候选资格。

| 逻辑 LLM                      | evidence | 开发候选指纹 | 当前来源摘要 |
| ----------------------------- | -------- | ------------ | ------------ |
| `ark-coding-plan`             | passed cases | stale | 2026-08-03 batch；2026-08-14 刷新被账户额度阻断 |
| `ark-agent-plan`              | passed cases | stale | 2026-08-03 batch |
| `ark-agent-deepseek-v4-flash` | passed cases | stale | 2026-08-03 batch；0 legacy |

## 历史 2026-07-25 逐项基线

<a id="ark-coding-plan-review"></a>

### ark-coding-plan review

- 当时任务结果：passed；当时注册表状态：pending（同 profile 的 delegate 当时未通过）。
- 实际/预期模型均为 `ark-code-latest`；provider 为 `ark-coding-plan`；route 为 `direct`；耗时 11.803 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-49-40.932Z-ark-coding-plan-review-ark.json)；SHA-256 `a4c2b6ba19e8226f8c641426c5ad9c81826fcd32adb77200ad7c90731dbb3dd4`。

<a id="ark-coding-plan-delegate"></a>

### ark-coding-plan delegate

- 当时任务结果：failed；当时注册表状态：pending；稳定失败类别为 `acceptance_failed`。该失败已被后续 passed case 取代为当前资格来源。
- 实际/预期模型均为 `ark-code-latest`；provider 为 `ark-coding-plan`；route 为 `direct`；耗时 75.889 秒。
- 只变更 `ark-coding-plan-smoke.txt` 并观测到命令，但 `resultFileValid` 为 false；其它环境隔离、变更范围与进程清理检查均通过，独立系统进程快照也为零残留。
- 证据：[JSON](evidence/2026-07-25T15-51-44.134Z-ark-coding-plan-delegate-ark.json)；SHA-256 `7d7af81493dd9e94a9669efb12eb90c83c1c7535959b81c385091aa3eef461eb`。

<a id="ark-agent-plan-review"></a>

### ark-agent-plan review

- 结果：passed；实际/预期模型均为 `ark-code-latest`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 9.098 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-52-57.715Z-ark-agent-plan-review-ark.json)；SHA-256 `c6ef0351080d9448c4bf65ad606349c219c3b51d1a2e3ff7a02127c0e6fb6871`。

<a id="ark-agent-plan-delegate"></a>

### ark-agent-plan delegate

- 结果：passed；实际/预期模型均为 `ark-code-latest`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 859.946 秒。
- 只变更 `ark-agent-plan-smoke.txt`，文件内容与命令证据正确；环境隔离、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-08-00.444Z-ark-agent-plan-delegate-ark.json)；SHA-256 `ef805b815ee95b58c2ce0e81ad8f2bff62efd9d49599571b7c8ff87f18b127df`。

<a id="ark-agent-deepseek-v4-flash-review"></a>

### ark-agent-deepseek-v4-flash review

- 结果：passed；实际/预期模型均为 `deepseek-v4-flash`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 16.000 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-09-09.705Z-ark-agent-deepseek-v4-flash-review-ark.json)；SHA-256 `24fb03e09071666f33d5194a50cac2ccca492021249bf0adf466c7d3fde97545`。

<a id="ark-agent-deepseek-v4-flash-delegate"></a>

### ark-agent-deepseek-v4-flash delegate

- 结果：passed；实际/预期模型均为 `deepseek-v4-flash`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 32.243 秒。
- 只变更 `ark-agent-deepseek-v4-flash-smoke.txt`，文件内容与命令证据正确；环境隔离、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-10-32.796Z-ark-agent-deepseek-v4-flash-delegate-ark.json)；SHA-256 `38869fd3844a2e5ab933cc438bcdbb364eaf16182dbc3c650452d04c3c3bbe92`。

## 历史证据（不属于当前公开面）

<a id="ark-agent-glm-5.2-review"></a>

### ark-agent-glm-5.2 review

- 结果：passed；实际模型：`glm-5.2`；耗时：34.765 秒。
- 证据：[JSON](evidence/2026-07-20T07-32-04.030Z-ark-agent-glm-5.2-review-ark.json)；SHA-256 `df9a02977e6501c96744f48b825377152287b3a82f18f428a8367e5121beef22`。

<a id="ark-agent-glm-5.2-delegate"></a>

### ark-agent-glm-5.2 delegate

- 结果：passed；实际模型：`glm-5.2`；耗时：41.426 秒。
- 仅变更 `ark-agent-glm-5.2-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-36-31.292Z-ark-agent-glm-5.2-delegate-ark.json)；SHA-256 `4024d8eccc0cf88812958de0a64bb273f374a37139d3d9c67c9598eb3fcc34bb`。

<a id="ark-agent-doubao-seed-2.0-pro-review"></a>

### ark-agent-doubao-seed-2.0-pro review

- 结果：passed；实际模型：`doubao-seed-2.0-pro`；耗时：47.535 秒。
- 证据：[JSON](evidence/2026-07-20T07-33-08.018Z-ark-agent-doubao-seed-2.0-pro-review-ark.json)；SHA-256 `8d287e0fb5af52fca30acb8cb9ecb6c37e010d9a114d560f4542abec8fa4e36b`。

<a id="ark-agent-doubao-seed-2.0-pro-delegate"></a>

### ark-agent-doubao-seed-2.0-pro delegate

- 结果：passed；实际模型：`doubao-seed-2.0-pro`；耗时：16.338 秒。
- 仅变更 `ark-agent-doubao-seed-2.0-pro-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-37-04.272Z-ark-agent-doubao-seed-2.0-pro-delegate-ark.json)；SHA-256 `726d34d59d7f3c9b9fd0f9973bb0047ffa7b9f82555bf3fd0ffbb328155d0a8c`。

## 历史失败与复核说明

2026-07-18 的 Coding Plan 失败源于当时未识别本机的 `API_KEY_DOUBAO_CODING` 命名；Agent Plan 失败源于上游周额度耗尽。这些失败证据保留作诊断回归，不再代表当前能力状态。

真实 Pi smoke 的“无新增 Pi RPC 进程”检查比较全机进程快照，因此多个 smoke 不应并行运行。2026-07-20 曾并行启动三个 review：先结束的两项因看见其它 smoke 的仍在运行进程而产生验收假阴性，最后结束的一项通过；串行复测证明模型、路由和清理逻辑均正常。最终门禁只采用上面的串行证据。

Pi RPC 桥还覆盖 assistant `errorMessage` 与空内容同时出现的失败语义：此类 API 错误会脱敏记录并返回 failed，不会误标 completed。

## 复跑命令

以下 standalone 命令会调用真实模型，不构成 `four-llm-v1` 同批资格，也不在当前离线授权内。只有在另有明确目的和授权时才可串行运行：

```powershell
npm run smoke:ark -- --llm ark-coding-plan --task review
npm run smoke:ark -- --llm ark-coding-plan --task delegate
npm run smoke:ark -- --llm ark-agent-plan --task review
npm run smoke:ark -- --llm ark-agent-plan --task delegate
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task review
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task delegate
```
