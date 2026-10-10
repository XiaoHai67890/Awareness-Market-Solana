# Awareness Solana memory registry

这是 Solana 原生的 ERC-8350 状态语义适配器。它保持 ExperienceDelta transition ID 和 MemoryState root 的 32 字节 ABI word / Keccak 计算，但使用 Solana 公钥、PDA 和交易签名进行授权，不提供 EVM ABI 或 EIP-712 签名兼容性。

`9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit` 已于 2026-10-10 部署至 [Solana Devnet](https://explorer.solana.com/address/9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit?cluster=devnet)，交易已 finalized，链上代码与本地 ELF 逐字节一致。配套程序密钥保存在绑定机器的 `~/.config/solana/awareness-market/devnet-program-keypair.json`（权限 `0600`），不随仓库分发；清理构建目录不会删除它。详情见[部署记录](../../reports/solana-devnet-deployment.md)。

## 固定工具链与复现

Host Rust 1.90.0、Anchor 0.32.2、Agave 3.0.13、platform-tools v1.52（SBF Rust 1.89.0）、LiteSVM 0.7.1。依赖版本由 Cargo.lock 固定。脚本下载官方发布的工具到指定目录，不修改 shell 配置或全局 Rust/Solana 安装。

```bash
cd contracts/solana
./scripts/install-toolchain.sh
./scripts/test.sh
```

也可以选择一个独立工具目录：

```bash
./scripts/install-toolchain.sh /absolute/path/to/task-tools
AWARENESS_SOLANA_TOOLING_DIR=/absolute/path/to/task-tools ./scripts/test.sh
```

`build.sh` 编译真实 SBF ELF 到 `target/deploy/awareness_memory.so`，通过 Anchor IdlBuilder 实际编译生成 `idl/awareness_memory.json`，并用 Anchor 序列化生成 `fixtures/abi-v1.json`。工具自动创建的未使用程序 keypair 只存在于临时构建目录，脚本退出时删除。源码中的 declare_id 是程序身份的唯一来源。

`test.sh` 在 LiteSVM 中执行这个 ELF，测试独立付款人与授权者、当前签名权限、PDA/owner 约束、连续 sequence/prevRoot、非零承诺、授权轮换和 nonce、防溢出、不可重复初始化与不可覆盖 receipt，以及失败交易的状态/receipt 原子回滚。测试仅使用内存中的临时 keypair，不访问 RPC 或用户钱包。

Agave 3.0.13 发布包中的 SDK `syscalls.txt` 为空，构建后检查会对标准 Solana syscalls 输出 unknown-syscall 告警。此 ELF 已在 LiteSVM 和实际 Agave 3.0.13 本地 validator 中执行验证；遇到其他构建或执行错误仍应停止部署。validator 通过 genesis 加载程序时也有短暂的 DelayVisibility，RPC 测试会等程序可用后再执行。

## 账户与授权

Space PDA seeds 为 `[b"space", spaceId32]`。初始 identity 是 `keccak(keccak("AwarenessMemorySpace(bytes32 initialController,bytes32 salt)") || initialController32 || salt32)`。controller 和 authorizer 后续轮换不会改变 identity。

`register_space(space_id, salt, authorizer)` 要求 initial controller 签名。`commit_transition(sequence, prev_state_root, delta_commitment, provenance_commitment, profile_id, locator_commitment)` 要求当前 authorizer 签名，sequence 必须严格为 current+1、前根必须匹配，delta/profile 不可为零。`set_authorization(new_controller, new_authorizer, nonce)` 要求当前 controller 签名、nonce 严格为 current+1。payer 可以与 controller/authorizer 不同，只负责手续费和 rent。

每次提交创建不可覆盖的 TransitionReceipt PDA，seeds 为 `[b"transition", spaceId32, sequence_u64_le]`。receipt 记录全部承诺、前根、transition ID、新根、当时 authorizer 和执行 slot。没有 close/reset/删除指令。Space 250 字节，Receipt 314 字节（均包含 8 字节 Anchor discriminator）；准确字段和指令排列见生成的 IDL 与 ABI fixture。链上没有记忆明文。

客户端应按具体 receipt 核验提交；仅看到当前 sequence 已增加不足以证明自己的 transition 成功。确认时还应核验 cluster genesis、program owner、PDA、receipt 全部承诺、交易指令与执行 slot。账户的不可覆盖性取决于当前程序逻辑；可升级部署的 upgrade authority 仍可改变规则，正式部署需要明确管理该权限。

## 已绑定的程序身份

本项目已经完成程序身份绑定与 Devnet 部署，后续升级复用上述程序身份，无需重新生成。程序密钥与支付费用、管理升级权限的钱包是不同身份。当前升级权限为 `CFhBDR6xLXajUtV87mZtpCrCiTt7h3XtT5V8aiiCnKQ7`，对应同目录的 `devnet-deployer-keypair.json`，需要一并备份。`Anchor.toml` 的 localnet 条目使用同一公开地址，方便本地验证；Devnet 操作使用指南中的显式网络和身份参数。

其他使用者若要部署自己的独立程序，应自行保管程序密钥，取得公开地址后运行 `node scripts/set-program-id.mjs --program-id <公开地址>`，再运行 `./scripts/build.sh`。同步工具只读取公开地址，更新源码 declare_id 与 Anchor.toml；重建同步 IDL/fixture，无需安装 Anchor CLI。`source ./scripts/env.sh` 将工具加到当前 shell 的 PATH，不修改 shell 配置。

部署应显式选择目标 cluster、付款钱包、program ID 和 upgrade authority；部署后将实际 program ID 写入 Awareness 的选定 workspace。程序密钥需要单独备份，仓库只包含公开地址。测试或构建成功不等于已部署；操作步骤见 [Devnet 指南](../../docs/solana-devnet.zh-CN.md)。
