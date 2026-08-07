# Kimi Code 0.34.0 的 AgentSwarm / ACP 探测

## 结论

截至 2026-08-07，不为 `external_review` 或 `external_delegate` 增加 `swarm`、`cluster` 或思考强度参数。

本机 Kimi Code CLI 已从 0.27.0 升级到 0.34.0，但标准 ACP 会话不公开 `swarm` 模式；强制模型在普通 ACP delegate 中调用 `AgentSwarm` 的最小真实任务也没有在四分钟内返回可验收结果。把提示词前缀包装成公开开关会制造“已经开启集群”的错误保证，并不能证明更快。

Kimi 仍可在模型自行判断合适时调用内置 `AgentSwarm`。本项目不禁止它，也不设置 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`；只是不会在缺少协议级控制和成功观测证据时向调用者承诺该行为。

## 环境与升级

- 宿主：维护者当前 Windows x64 / Node 24 环境。
- Kimi Code CLI：0.34.0。
- 官方安装脚本在执行前两次下载比对，SHA-256 均为 `28a0473a7c56d41eae52cb4dbd3232f87a9133dd7af416a6a04dfbf7856fa9fc`。
- 安装只对该次命令设置 `KIMI_NO_MODIFY_PATH=1`；没有写入 PATH 或 Kimi 全局执行预算。
- 新 `kimi.exe` SHA-256 为 `36bd5659fb5d310edc06ac6196dac6e7f7528bfdf04d41f3bed9b29caaf4d206`；安装器保留的 0.27.0 备份 SHA-256 为 `1c3d981d2e0437ada925a153047b54922ada01d0f85282cff49f3a56df46f50a`。
- `kimi doctor` 确认现有 `config.toml` 与 `tui.toml` 有效。

## ACP 协议证据

0.34.0 的 `initialize` / `session/new` 响应显示：

- 可用模式只有 `default`、`plan`、`auto`、`yolo`；
- `mode` 配置项的值域与上述四项一致；
- `thinking` 配置项只提供 `on`；
- `session/set_mode` 传入 `swarm` 返回 `Invalid params: Unknown modeId: swarm`；
- `session/set_config_option` 对 `configId=mode, value=swarm` 返回同一拒绝。

因此不能通过当前标准 ACP 的 mode 或 config option 启用 swarm，也没有可用于降低 K3 思考强度的真实值域。

## 真实最小探测

探测工作区只包含 `alpha.txt=19` 与 `beta.txt=23`。提示要求 K3 恰好调用一次 `AgentSwarm`，以两个 `explore` 子智能体分别只读一个文件，再由主智能体求和；禁止写文件、运行 shell 和额外调查。

最初两次启动前检查分别因相对 cwd 和源码模块无法解析已打包 helper 根目录而 fail closed；两次 `adapterClientInvocationCount` 均为 0，不属于模型失败。修正为绝对 cwd 并显式注入已通过 SHA/PE 校验的同一 helper 后，真实调用进入运行，但四分钟没有返回正文或终态。Codex 按该次实验的停止边界终止外层进程，随后按命令行和父子身份复查，本次探测相关 Node、Kimi 与 helper 进程均为 0。没有文件变化。

这次真实调用不登记 PASS，也不支持 AgentSwarm 更快或更慢的普遍结论；它只证明当前 ACP 集成无法为这个最小任务提供可验收的 swarm 完成结果。

## 重新评估条件

满足任一条件后可重新设计：

1. Kimi ACP 在 `availableModes` 或 `configOptions` 中真实广告 `swarm`；
2. ACP 提供能明确区分并验证 `AgentSwarm` 启动、成员数量与终态的稳定事件；
3. 一次隔离窄任务取得可重复的成功结果，并证明 review 的只读权限可以约束 swarm 子智能体；
4. Kimi ACP 为 K3 广告多个真实 `thought_level` 值。

重新设计仍必须保持调用级 opt-in，不写 Kimi 全局配置，不设置默认并发或步骤上限，并通过 TDD、真实 Kimi 窄任务和 owned-process drain 验收。
