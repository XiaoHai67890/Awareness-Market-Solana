# Awareness Memory Registry：Solana 开发与 Devnet 部署

本工程新增 Solana 原生 Anchor 程序和本地客户端适配器。记忆正文、delta salt 和 witness 留在本地；链上保存承诺、连续状态根以及每条更新的凭证。链上记录证明特定内容承诺被授权提交，不证明记忆内容本身真实。

这是一份 ERC-8350 语义的 Solana 适配实现。ExperienceDelta 和 MemoryState 的 Keccak/ABI 哈希保留；Space 身份改用 32 字节 Solana 公钥，授权改用 Solana 交易签名，不兼容 Ethereum 的 EIP-712 签名。

## 工程入口

- `contracts/solana/`：固定依赖的 Rust/Anchor 程序、构建及 SVM 测试说明。
- `src/daemon/anchoring/solana-codec.mjs`：指令编码、账户解码与 PDA 派生。
- `src/daemon/anchoring/solana-client.mjs`：发送交易及独立链上确认。
- `scripts/solana-configure.mjs`：查询网络身份、检查已部署程序并配置指定工作区。
- `.awareness/anchoring.sqlite`：持久 Space 身份、快照和 outbox；不再存于可删除的搜索索引。

## 本地检查

按 `contracts/solana/README.md` 安装固定版本的 Rust、Agave 工具；Anchor 依赖由 Cargo 固定，无需另装 Anchor CLI。Node 依赖安装后运行：

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run test:anchoring
```

合约的构建和 SVM 检查见该目录 README。真实 RPC 集成测试需要本机 `solana-test-validator` 和编译后的 `.so`；没有这些工具时会明确跳过，不能把跳过视为验证通过。

## 部署到 Devnet

Devnet 用于应用开发与演示，Testnet 主要用于网络/验证节点测试。本指南默认 Devnet。程序 `9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit` 已于 2026-10-10 部署至 [Devnet](https://explorer.solana.com/address/9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit?cluster=devnet)，交易已 finalized，链上字节与本地编译产物一致。配套程序密钥保存在绑定机器的 `~/.config/solana/awareness-market/devnet-program-keypair.json`（权限 `0600`），需单独备份。详情见[部署记录](../reports/solana-devnet-deployment.md)。下方命令用于后续重建与升级，当前程序无需重复首次部署。

1. 已在绑定机器创建独立测试钱包 `~/.config/solana/awareness-market/devnet-deployer-keypair.json`，公钥为 `CFhBDR6xLXajUtV87mZtpCrCiTt7h3XtT5V8aiiCnKQ7`。通过 https://faucet.solana.com/ 领取测试 SOL，建议准备至少 2 SOL。此钱包用于付款和保留升级权限；不需要向 daemon、网页或任何聊天发送私钥。
2. 本项目已完成身份绑定与重新编译。后续修改合约时复用现有程序密钥，并按下列命令检查公开地址、同步和重建。克隆仓库不会获得程序密钥；独立部署者需要自己的身份。构建与本地测试仅使用公开地址。

```sh
cd contracts/solana
source ./scripts/env.sh
solana-keygen pubkey ~/.config/solana/awareness-market/devnet-program-keypair.json
# 本项目密钥的公钥应与下面地址一致。
node scripts/set-program-id.mjs --program-id 9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit
./scripts/build.sh
```

3. 后续升级使用显式 RPC、部署钱包及程序密钥，避免修改全局 CLI 网络设置。公用 RPC 批量上传可能限流，本次使用固定 Devnet 上游的本机节流代理完成续传；使用其他 RPC 时先核验 genesis hash 为 `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`：

```sh
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/awareness-market/devnet-deployer-keypair.json \
  --upgrade-authority ~/.config/solana/awareness-market/devnet-deployer-keypair.json \
  --program-id ~/.config/solana/awareness-market/devnet-program-keypair.json \
  --use-quic --use-rpc --commitment finalized \
  target/deploy/awareness_memory.so

solana program show 9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit --url https://api.devnet.solana.com
```

保留测试部署的 upgrade authority 便于修复；因此当前阶段属于可升级测试程序。不要宣称执行逻辑永久不可更改。冻结升级权限不可撤销，不能作为日常部署步骤自动执行。

4. 回到仓库根目录，配置一个明确的本地记忆工作区。`CONTROLLER_PUBLIC_KEY` 是测试钱包的公开地址：

```sh
cd ../..
node scripts/solana-configure.mjs \
  --project /absolute/path/to/demo-workspace \
  --program-id 9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit \
  --controller <CONTROLLER_PUBLIC_KEY> \
  --cluster devnet
```

辅助脚本会验证目标程序可执行，将 RPC 查询到的 genesis hash 写入配置，并保留已有的其他配置字段。已绑定 EVM 或其他 Solana 程序的工作区不能被静默改写；使用单独的演示工作区，保留旧工作区的状态和 witness。

5. 启动/重启该工作区 daemon，创建或修改记忆卡片，然后发送：

```sh
node bin/awareness-local.mjs start --project /absolute/path/to/demo-workspace
node bin/awareness-local.mjs anchor status --project /absolute/path/to/demo-workspace
node bin/awareness-local.mjs anchor flush \
  --project /absolute/path/to/demo-workspace \
  --keypair ~/.config/solana/awareness-market/devnet-deployer-keypair.json
```

CLI 会拒绝连接到其他工作区的 daemon。首次 flush 创建 Space，随后按序提交 outbox。再次修改一张卡片并 flush，可展示第二次状态根链接到第一次。

## 验收与恢复

- 记录实际 Program ID、交易签名和 Space PDA，通过 https://explorer.solana.com/?cluster=devnet 查看。
- 客户端等待 finalized，检查交易无错误，再读取对应 TransitionReceipt PDA，核对 owner、账户类型、Space、序号、各承诺、transition ID 和状态根。daemon 会独立重复核验后才改本地状态。
- 网络中断后直接再次 flush。恢复依据具体凭证，不能仅因为链上序号更大就确认。恢复已有凭证时交易签名可能为空；这不代表伪造一个全零交易哈希。
- reindex 会保留独立锚定数据库；升级前的 index.db 中旧锚定表会被复制迁移，原表不删除。备份时一并保留 `anchoring.sqlite` 与整个 `witness/` 目录。
- 旧 EVM 状态没有历史网络标识，首次迁移会绑定当前 EVM 配置；迁移前应保持原网络配置。旧 index.db 无法打开或迁移时，reindex 会停止并保留文件，需先恢复旧数据库。
- 新增卡片摘要使用版本化 v2 确定性 JSON 对象编码，消除旧分隔符歧义。旧 witness 和排队的 v1 transition 保留原始内容。
- 切换 cluster、Program ID 或 controller 不会自动重置历史。合约具备权限轮换指令；当前 CLI 聚焦注册/提交，未提供一键权限轮换和跨链历史迁移。
- Devnet 账本可能重置，测试凭证不应当作永久存档。正式生产还需要独立安全审计与明确的升级治理。

参考：Solana [网络说明](https://solana.com/docs/references/clusters)、[部署文档](https://solana.com/docs/programs/deploying)、[Anchor 账户约束](https://www.anchor-lang.com/docs/references/account-constraints)。
