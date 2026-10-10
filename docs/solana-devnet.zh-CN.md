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

## Devnet 记忆提交与独立验证

2026-10-10 已通过正常 daemon 记忆 API 和 CLI 完成两次真实 Devnet 提交，序号为 1、2，待提交队列为 0。演示 Space PDA 为 [`GejMdC1Yn56pXSZUHmrjbtYwuaa5XMhrMW1AU4MJdEQ7`](https://explorer.solana.com/address/GejMdC1Yn56pXSZUHmrjbtYwuaa5XMhrMW1AU4MJdEQ7?cluster=devnet)。公开验收数据见 [JSON](../reports/solana-devnet-memory-verification.json)。

本机演示工作区是仓库下的 `demo/devnet-workspace/`，daemon 端口为 `37810`；该工作区、独立运行目录 `demo/devnet-home/`、数据库和 witness 均已被 Git 忽略。两个演示记忆输入位于 `examples/solana-devnet/`，内容是公开的合成示例。

**读取已经提交的证明不需要钱包或运行中的 daemon：**

```sh
node scripts/solana-verify.mjs --project demo/devnet-workspace
```

验证脚本以只读方式打开本地索引及锚定数据库，重算私有 witness 的承诺和连续状态根，重放卡片变更并核对当前已索引卡片的 digest 字段，再查询 finalized 链上账户及对应交易。它只输出公开证明字段，不输出记忆正文、盐值或私钥。有 pending 记录、尚未 build 的卡片变更、缺失 witness、内容不一致或链上核验失败时，命令失败，不会把未完成的流程报告成成功。验证范围是[卡片 digest profile](memory-card-digest-v2.md)中的字段及其承诺历史，不证明内容真实性，也不覆盖所有原始记忆字段。

**在已有演示工作区继续使用：** 在一个终端启动服务，保持该终端运行。先确保 `37810` 空闲；正常 `start` 命令会切换占用同一端口的 Awareness daemon 工作区，因此演示应使用独立端口。

```sh
AWARENESS_HOME="$PWD/demo/devnet-home" node bin/awareness-local.mjs start \
  --foreground --project "$PWD/demo/devnet-workspace" --port 37810
```

另一个终端中按顺序执行；每次记忆提交脚本都会等到对应知识卡片完成索引。锚定对象是知识卡片快照，仅写入普通记忆而没有生成知识卡片，不一定产生待提交更新。

```sh
node scripts/solana-demo-record.mjs --project demo/devnet-workspace --port 37810 --step 1
node bin/awareness-local.mjs anchor flush --project demo/devnet-workspace --port 37810 \
  --keypair ~/.config/solana/awareness-market/devnet-deployer-keypair.json

node scripts/solana-demo-record.mjs --project demo/devnet-workspace --port 37810 --step 2
node bin/awareness-local.mjs anchor flush --project demo/devnet-workspace --port 37810 \
  --keypair ~/.config/solana/awareness-market/devnet-deployer-keypair.json

node scripts/solana-verify.mjs --project demo/devnet-workspace
```

已完成本次演示的工作区重复运行时，记录脚本识别已经存在的同内容知识卡片，flush 返回 `Nothing to anchor.`，不会重复提交。若需新的一组交易，创建独立工作区和新的 Space，不要删除现有数据库或 witness。

**新克隆仓库的初始化：** 克隆不包含本机演示状态或钱包。先安装 Node 依赖，并创建一个新的演示工作区：

```sh
node --input-type=module - <<'JS'
import fs from 'node:fs';
const dir = 'demo/devnet-workspace/.awareness';
if (fs.existsSync('demo/devnet-workspace')) throw new Error('Workspace exists; preserve its state');
fs.mkdirSync(dir, {recursive: true, mode: 0o700});
fs.mkdirSync('demo/devnet-home', {recursive: true, mode: 0o700});
fs.writeFileSync(`${dir}/config.json`, JSON.stringify({
  daemon: {port: 37810}, cloud: {enabled: false}, telemetry: {enabled: false},
  git_sync: {enabled: false}, extraction: {enabled: false}
}, null, 2), {mode: 0o600, flag: 'wx'});
fs.writeFileSync(`${dir}/scan-config.json`, JSON.stringify({enabled: false, watch_enabled: false}), {mode: 0o600, flag: 'wx'});
JS

node scripts/solana-configure.mjs --project demo/devnet-workspace \
  --program-id 9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit \
  --controller <YOUR_DEVNET_WALLET_PUBLIC_KEY> --cluster devnet
```

使用有测试 SOL 的自有 Devnet 钱包，并在上面的 flush 命令中替换 `--keypair` 路径。记忆提交脚本不接触密钥，也不发送链上交易；只有 flush 在本地签名。本次三笔交易（注册和两次提交）合计手续费 0.000015 Devnet SOL，账户租金 0.00641096 Devnet SOL。其他工作区的实际消耗以链上结果为准。

结束演示可执行 `node bin/awareness-local.mjs stop --project demo/devnet-workspace`。保留整个演示工作区以便以后验证本地 witness 和恢复队列。

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
