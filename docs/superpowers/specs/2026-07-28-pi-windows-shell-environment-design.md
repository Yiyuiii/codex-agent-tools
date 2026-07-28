# Pi Windows shell 环境闭环设计

> 历史状态说明：本文当时的“不得启动第二个真实批次”已被 [standing authorization](2026-07-28-standing-experiment-authorization-design.md) 覆盖；Windows 环境白名单、代理和凭据边界保持不变。

状态：已批准进入离线 TDD 实施。批准依据是维护者对 frozen SHA
`cb9434b4b540e70f5384224e4e98823a3ea2dbae` 真实批次失败后的自主离线
诊断、修复、审阅、验证和重新冻结授权。本设计不授权第二个真实批次。

## 1. 问题与证据

真实批次
`2026-07-28T10-56-09.704Z-649886e3-233e-4da1-ac80-185227342bef`
在 ordinal 6 `ark-agent-plan/delegate` 首错停止。目标结果文件实际存在且
内容、长度、标准化哈希均正确，但运行还产生了意外 `where.cmd`，Pi 最终
报告 `account_quota_exceeded`，因此同批终态为 `blocked`。

qualification-only schema v3 首次提供了命令生命周期证据：

- 精确写入命令已形成，但工具结果为 `error`；
- 其余 17 个执行命令也全部为 `error`；
- ordinal 1 的已通过 Ark Coding delegate 同样显示 5 个执行命令全部
  `error`，说明模型是通过其它工具或恢复动作形成了结果文件，不能把
  “文件存在”解释为精确 bash 命令成功。

离线环境探针进一步定位到确定性边界：

1. `buildChildEnvironment()` 当前不转发 `ProgramFiles` 或
   `ProgramFiles(x86)`；
2. 本机 Pi 0.80.10 的 Windows `getShellConfig()` 先从这两个系统根目录
   查找 Git Bash，再回退到 `PATH` 上的 `where bash.exe`；
3. 当前隔离白名单下，Pi 明确返回 `No bash shell found`；
4. 仅补入 `ProgramFiles` 后，Pi 解析到
   `C:\Program Files\Git\bin\bash.exe`；
5. 使用与 Pi 相同的 Node
   `spawn(shell, ["-c", command])` 参数数组执行精确资格命令时，命令
   exit 0，并生成预期 28 字节、SHA-256
   `81fcf9156bbf05c9deccd3a31abd32ec54bfb7c20a27357b9efb7f6a4b640370`
   的结果文件。

因此已证代码缺口是：项目的子进程环境隔离遗漏了 Pi 在 Windows 上定位
本机 Git Bash 所需的非秘密系统路径变量。Ark 账户额度耗尽仍是独立外部
状态，不由本修复解决。

## 2. 方案比较

### 方案 A：扩展现有基础环境白名单（采用）

在 `BASE_ENVIRONMENT_KEYS` 中加入 Pi 实际读取的 `ProgramFiles` 与
`ProgramFiles(x86)`。继续复用现有大小写无关查找，只向子进程传递值，
不在项目内解析或选择 shell。

优点：

- 改动与已证根因一一对应；
- 保留 Pi 自身对 Git Bash、PATH fallback 和平台差异的控制；
- 两个值是非秘密系统安装根目录，不引入用户代理或额外凭据；
- 不改变公开 API、Pi 配置 schema 或资格语义。

### 方案 B：由项目修改 `PATH`（不采用）

项目检测 Git 安装目录并把 `Git\bin` 注入 Pi 子进程 `PATH`。

该方案会复制 Pi 的 shell 查找逻辑，需要处理 32/64 位、非默认安装位置
和未来 Pi 行为变化，长期漂移风险更高。

### 方案 C：在版本化 Pi 配置中固定 `shellPath`（不采用）

该方案把宿主绝对路径写入项目配置，增加机器耦合，并把一个运行环境
白名单缺口升级成配置协议变更，超出最小修复范围。

## 3. 实现边界

生产改动仅限 `src/runtime/environment.ts` 的基础环境白名单：

- 加入 `ProgramFiles`；
- 加入 `ProgramFiles(x86)`；
- 不加入 `ProgramW6432` 或其它未被 Pi 读取的变量；
- 不改变代理清除、凭据重命名、凭据候选选择或其它环境继承规则。

不会修改：

- `external_review` / `external_delegate` 契约；
- LLM、provider、model、direct route 与代理策略；
- 资格提示词、validator、schema、case 顺序、single-attempt、
  retry/fallback；
- 活动插件、`~/.codex/config.toml`、Claude Code 或 `codex_cc_tools`。

## 4. TDD 与验证

先在现有环境单元测试中加入失败用例，使用合成父环境证明：

- 两个 Windows program-files 变量按 Pi 可读取的名称进入子环境；
- 查找仍保持大小写无关；
- 未列入白名单的相邻变量与代理不会被带入；
- 既有凭据目标重命名行为保持不变。

确认测试因变量缺失而 RED 后，只增加两个白名单键，再运行该文件和相关
环境、Pi adapter、Pi smoke 测试至 GREEN。

完成实现后运行：

1. fresh 类型检查与全量测试；
2. 构建、release smoke、隔离插件 `--check-report`；
3. 与 Pi 相同的离线 `getShellConfig()` 和 Node spawn 精确命令探针；
4. 全部 retained manifests 的 immutable-evidence 校验；
5. `git diff --check`、目标进程 0/0/0、资格锁 absent、clean tree。

真实模型不用于验证本修复。若形成新 clean SHA，第二个真实批次仍须由
维护者针对该精确 SHA 重新授权。

## 5. 失败与停止条件

- 若单元测试不能在旧代码上稳定 RED，停止并重新审计假设；
- 若加入两个变量后 Pi 离线 shell 解析仍失败，不继续扩大白名单，回到
  根因调查；
- 若全量门禁出现与改动无关的失败，按系统化调试流程定位；
- 不因 Ark 额度错误执行 retry、fallback、单项补跑或第二批；
- 完成离线修复、审阅和新 clean freeze 后，停止在精确 SHA 重新授权点。
