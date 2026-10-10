# Solana Devnet 部署记录 — 2026-10-10

状态：**已成功部署到 Devnet，交易已 finalized**。核验时间为 2026-10-10 18:08:44（北京时间）。通过直接 RPC 与 Solana CLI 两种方式下载链上程序，均与本地 ELF 逐字节一致。

[查看程序](https://explorer.solana.com/address/9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit?cluster=devnet) · [部署交易](https://explorer.solana.com/tx/ZRXsagQh6jHeCM8QG6uLC9GfHzEykYAkzCzaKwuTAcaQtU9p4Cnv2KhHSgpN7WHxT1dm98id9mPLD94E7LVRYB4?cluster=devnet) · [完整验证 JSON](solana-devnet-verification.json)

## 固定部署参数

| 项目 | 值 |
|---|---|
| 网络 | Devnet |
| RPC | `https://api.devnet.solana.com` |
| 已核验 genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program ID | `9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit` |
| 付款钱包／升级权限 | `CFhBDR6xLXajUtV87mZtpCrCiTt7h3XtT5V8aiiCnKQ7` |
| ProgramData PDA | `7DaPiscdzPQzXTTH2iYb9g7Rz6qkvpbkCH447Z5NaWSY` |
| 部署 slot | `509505556` |
| 上传 Buffer | `CNhhVxBWd4zsjpE2v32h88eJCh8ZyGba1FAXBXotS7JN`（部署后已自动关闭回收） |
| 程序状态 | executable = true；Upgradeable Loader |
| ELF 大小 | 248256 字节 |
| ELF SHA-256 | `1f34c189c00f3a78a60388aac81242a4c01864bcdd71c040a454684b4e6214df` |
| 核验时钱包余额 | 16.23589756 Devnet SOL |

密钥均位于本机 `~/.config/solana/awareness-market/`，权限 `0600`，未写入仓库：

- `devnet-program-keypair.json`：已绑定的程序身份，保持不变。
- `devnet-deployer-keypair.json`：本次创建的独立测试付款／升级权限钱包。
- `devnet-buffer-keypair.json`：本次上传用的可恢复 Buffer 身份。

## 已完成的核验

- 官方 Devnet RPC 的 genesis hash 与预期一致。
- 部署交易 status = finalized、err = null，交易 slot 与 ProgramData 的 lastDeploySlot 一致。
- Program 账户 executable = true，owner 为 `BPFLoaderUpgradeab1e11111111111111111111111`，ProgramData PDA 正确。
- 链上升级权限与本机独立部署钱包公钥一致；保留升级权限，未执行 `--final`。
- 直接读取 ProgramData 并去除 45 字节 metadata 后，248256 字节代码与本地文件完全一致。
- 独立使用 `solana program dump` 下载后，`cmp` 与 SHA-256 比对再次通过。
- 本次上传 Buffer 已回收，未遗留占用租金的 Buffer 账户。
- 源码、Anchor 配置、IDL、ABI fixture 及编译产物与[身份绑定记录](solana-program-identity.md)一致。

## 领取与上传说明

用户通过 Solana 官方网页领取测试 SOL 后开始部署。未授权 DevnetFaucet 的 GitHub 资料／邮箱访问，也未使用主网资产。初次直接上传遇到公共 RPC 连接限流，停止客户端后保留已创建的 Buffer，再通过本机节流代理续传；程序 ID 和上传数据保持不变。

节流代理仅监听 `127.0.0.1`，固定上游为官方 Devnet RPC，每 350 ms 最多转发一次请求，复用最多两个 HTTPS 连接，不读取密钥。续传期间未再遇到 429；部署完成后已关闭代理。网络节流导致的超时请求由 CLI 自动重试。

程序账户占用 833120 lamports，ProgramData 占用 1262019320 lamports。升级权限钱包及程序密钥需分别备份，密钥内容不在本报告或仓库中。

## 后续升级参考命令

在仓库根目录执行；不修改全局 CLI 配置、不冻结升级权限：

```sh
export AWARENESS_SOLANA_TOOLING_DIR="$PWD/contracts/solana/.local/tooling"
"$AWARENESS_SOLANA_TOOLING_DIR/solana-release/bin/solana" program deploy \
  contracts/solana/target/deploy/awareness_memory.so \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/awareness-market/devnet-deployer-keypair.json \
  --fee-payer ~/.config/solana/awareness-market/devnet-deployer-keypair.json \
  --upgrade-authority ~/.config/solana/awareness-market/devnet-deployer-keypair.json \
  --program-id ~/.config/solana/awareness-market/devnet-program-keypair.json \
  --buffer ~/.config/solana/awareness-market/devnet-buffer-keypair.json \
  --use-quic --use-rpc --commitment finalized --output json
```

上述命令直接使用官方 RPC，遇到上传限流时需使用适当的节流或可信 Devnet RPC，并核验 genesis hash。后续升级前应先重新编译并检查实际程序大小。本次首次部署显式使用 `--max-len 248256`；不要把这个旧长度固定用于更大的未来产物。

本机独立核验脚本：`verify-awareness-devnet.mjs`（未提交的本机辅助脚本）。部署输出、CLI 元数据及两份链上 ELF 下载文件也保存在该 `work/` 目录。本次完成合约部署及字节／权限核验；Awareness 业务工作区尚需按[指南](../docs/solana-devnet.zh-CN.md)配置，此次未改动现有工作区状态。
