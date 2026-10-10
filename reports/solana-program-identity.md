# Devnet 程序身份绑定与重编译 — 2026-10-10

已为 Awareness Memory Registry 创建并绑定持久程序身份，完成重新编译和本地验证。此次未发送任何 Devnet 部署交易，也未创建付款钱包或修改全局 Solana 网络配置。

后续进度：用户授权后已于同日完成 Devnet 部署。本文保留身份绑定时的历史记录；当前链上状态见[部署记录](solana-devnet-deployment.md)与[验证数据](solana-devnet-verification.json)。

## 程序身份与产物

| 项目 | 值 |
|---|---|
| 目标网络 | Solana Devnet（尚未部署） |
| Program ID | `9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit` |
| 本机程序密钥 | `~/.config/solana/awareness-market/devnet-program-keypair.json` |
| 文件／目录权限 | `0600`／`0700` |
| 编译产物 | `contracts/solana/target/deploy/awareness_memory.so` |
| ELF 大小 | 248256 字节 |
| ELF SHA-256 | `1f34c189c00f3a78a60388aac81242a4c01864bcdd71c040a454684b4e6214df` |

程序密钥保存在仓库外，已使用 Solana CLI 确认其公钥与 Program ID 一致。密钥内容未写入报告、源码或日志。后续部署复用该文件并单独备份；清理 `target/` 不会删除它。程序密钥与付款／升级权限钱包分开管理。

源码 `declare_id!`、`Anchor.toml`、生成的 IDL.address 与 ABI fixture.programId 四处一致。重新生成的 Space/Receipt PDA 与 bump 已核对。Anchor 默认继续用于 Localnet 验证，Devnet 部署按[部署指南](../docs/solana-devnet.zh-CN.md)显式指定网络与程序密钥。

## 验证结果

| 检查 | 结果 |
|---|---|
| SBF ELF 编译、Anchor IDL 与 ABI fixture 生成 | 成功 |
| Rust 格式检查 | 通过 |
| Rust 单元测试 | 4 通过，0 失败 |
| LiteSVM 执行新 ELF | 7 通过，0 失败 |
| Solana JS 客户端／ABI 测试 | 21 通过，0 失败 |
| 新 Program ID + 新 ELF + 真实本地 validator E2E | 1 通过，0 失败，0 跳过 |
| 上述 Node 测试合计 | 22 通过，0 失败，0 跳过；约 80 秒 |
| Git 空白检查 | 通过 |

E2E 显式指定新 Program ID 与最新 ELF，避免旧环境变量或旧产物影响验证。它实际执行注册、两次连续提交、finalized 凭证验证、daemon HTTP 确认、SQLite 状态更新、凭证重试及冲突拒绝。仅使用本地临时验证节点和临时测试钱包。

固定工具链仍为 host Rust 1.90.0、Anchor 0.32.2、Agave 3.0.13、platform-tools v1.52/SBF Rust 1.89.0、LiteSVM 0.7.1。构建中仍出现已记录的 SDK 空 syscall 清单告警；实际新 ELF 已通过 LiteSVM 与本地 Agave validator 执行验证。

本轮验证范围为身份变更与相关合约／客户端；未重复执行无关的全仓库测试。此前全套测试及原仓库已有失败见[重构验证记录](solana-refactor-validation.md)。

## 本机复现

在仓库根目录执行：

```sh
export AWARENESS_SOLANA_TOOLING_DIR="$PWD/contracts/solana/.local/tooling"
contracts/solana/scripts/test.sh

export AWARENESS_SOLANA_TEST_VALIDATOR="$AWARENESS_SOLANA_TOOLING_DIR/solana-release/bin/solana-test-validator"
export AWARENESS_SOLANA_PROGRAM_SO="$PWD/contracts/solana/target/deploy/awareness_memory.so"
export AWARENESS_SOLANA_PROGRAM_ID=9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit
node --test --test-timeout=240000 test/anchoring-solana.test.mjs test/anchoring-solana-e2e.test.mjs
```

本机日志保存于 `solana-program-identity-build.log`（未提交的本机验证日志） 和同目录的 `solana-program-identity-client.log`。
