# 合并分析报告：e:\aicode\freellmapi (stxh/main) → 本分支 (bun-freellmapi)

> 生成时间：2026-09-02

## 1. 结论摘要

- **共同基线**：`291556df` 之后两个分支彻底分叉。
- **源仓库** `stxh/main`：在基线上额外 **~50 个提交**。
- **本分支** `bun-freellmapi`（HEAD `5981d918`）：在基线上额外 **5 个提交**，且做了大规模 Bun 原生重构。
- **直接 `git merge` 不可行**：会产生数百个冲突。冲突类型主要为两类：
  1. **locale 文件**（60+ 个 `client/src/i18n/locales/*.json`，每个被源提交改了 17 次）——两侧几乎逐行冲突。
  2. **modify/delete 冲突**：源修改了本分支已删除/移动的文件（CI workflow、Dockerfile、desktop 全部、`server/src/routes/*.ts` → 已移到 `server/src/routes/bun/*.ts`）。

---

## 2. 架构分叉概览

| 维度 | 源仓库 (stxh/main) | 本分支 (bun-freellmapi) |
|---|---|---|
| 运行时 | Express + Node | Bun.serve（无路由库，if/else 分发） |
| 路由位置 | `server/src/routes/*.ts` | `server/src/routes/bun/*.ts` |
| desktop | 完整 Electron 应用（package.json、tray、i18n 等） | 已删除 |
| CI/Docker | 有 ci/cli-release/desktop-release workflow + Dockerfile | 已删除/重写 |
| 服务层 | `services/*`（多数文件名相同） | `services/*`（多数文件名相同） |

---

## 3. 源 50 个提交的功能归类

按相近主题归类（同一主题的多个提交折叠）：

### 3.1 源带、本分支缺失的**新功能**（需要移植/适配，工作量最大）
| 功能 | 源提交 | 现状 |
|---|---|---|
| **Idempotency-Key 支持**（防客户端重试双扣费） | `36b877d8`、`95bc46fd` | 本分支**无** `services/idempotency.ts`、迁移 `20260901_000001_idempotency_claims.ts`。仅有无关的 `idempoten` 命中（crypto/db） |
| **Fetch Relay 出站传输**（可选中转） | `56eb257c` | 本分支**无**，`docs/fetch-relay.md`、`examples/fetch-relay-worker/` 均缺失 |
| **数据库备份/恢复** | `a9b87740` | 本分支只有 HuggingFace 备份 `services/backup.ts`；缺 `backups-section.tsx`、`backups_table` 迁移、`routes/bun` 无 backups |
| **命名 fallback 链管理器** | `8bb2004c`、`b3bf20f4`、`e852ff13` | 缺 `chain-manager.tsx`、（chain 语义改动） |
| **peak-hours 路由调整**（可选时段） | `f9af5f75` | 缺 `peak-hours-controls.tsx` |
| **least-remaining key 选择策略** | `c4c0221b` | 需移植到 bun 的 router |
| **headroom 阈值可调** | `547692a8` | 需移植到 bun 的 router/ratelimit |
| **catalog 路由的视频生成** | `60f3e704` | 需移植（bun 有 media 但无 VideoPage） |
| **同模型跨 provider 的 /v1/messages 故障转移** | `59db4547` | 需移植到 `routes/bun/anthropic.ts` |

### 3.2 Proxy / SSE / 模型层修复（映射到本分支同名或近似文件，可移植，冲突可控）
| 功能 | 源提交 | 本分支对应 |
|---|---|---|
| 系统代理自动探测（兜底） | `86368ac9` | `server/src/lib/proxy.ts` |
| 存活超碰反向代理空闲连接池 | `73178f3f` | `server/src/lib/proxy.ts` / `wake-detect.ts` |
| Groq/Cerebras 剥离 `reasoning_content` | `2b1fc7b8` | `routes/bun/proxy.ts`, `openai-compat.ts` |
| SSE `data:` 无空格帧解析（Google 流解析器） | `fac3cbc4`、`613e10d2` | `lib/read-sse-frames` / `providers/google.ts` |
| chain-switch stall + cache poisoning 修复 | `560d687f` | `services/cache.ts`, `router.ts` |
| 上游 401 不再结束 dashboard 会话 | `03dafed7` | `lib/auth.ts` / `routes/bun/auth.ts` |
| 非聊天发现模型分类 | `560d687f` | `services/model-discovery.ts`, `custom-model-sync.ts` |
| identity 对 model id 推断 vision | `be12fe0b` | `services/model-discovery.ts` |
| 流式上游省略 usage 时注入估算帧 | `0a0bd24e` | `routes/bun/proxy.ts` / `responses.ts` |
| 自定义端点搜索匹配 host/key label | `7bd2f5d1` | `routes/bun/models.ts` |
| 默认值采样参数规范化（cache key） | `d03021eb` | `services/cache.ts`, `routes/bun/proxy.ts` |
| 自定义端点 reasoning/tool 能力探测 | `c7b4d456` | `services/custom-model-sync.ts`, `model-discovery.ts` |

### 3.3 Client 前端改动（多数映射到同名文件，可移植）
- `api.ts`、`routing.ts` 及其测试
- `proxy-settings-section.tsx`、`discover-models-dialog.tsx`、`FallbackPage.tsx`、`App.tsx`
- 3.1 中的新增组件（chain-manager、backups-section、peak-hours-controls）

### 3.4 desktop 应用（本分支已整体删除）
- 源有约 10 个 desktop 相关提交（`c8e05f07`, `3b6f40e9`, `e70d1305`, `9196ed04`, `0ed621db`, `4774cf02`, `4c8b38d8` 等），改动 `desktop/*` 全部文件。
- **决策点**：本分支删除了 desktop。合并时要么整体跳过 desktop（推荐，除非用户要恢复 desktop），要么整个 desktop 目录作为 add 纳入。

### 3.5 构建 / CI / Docker / 基础设施
- 源有 ci 改动（`07a60b56`, `01d6f2de` npm ci）、Docker/Paas entrypoint（`3f054433`）、mac notarize（多个）。
- 本分支删除了这些文件并改用 Bun 构建流程（`bun run build` → `server/dist`）。
- **决策点**：CI/Docker/desktop 保留本分支（Bun）版本，跳过源的 Express/Node 版本。`docker-entrypoint.sh` 是否需要取决于本分支的 Docker 策略。

### 3.6 文档 / 杂项
- `docs/*`、`README`、locale 文件、`repo-assets/*`、`examples/fetch-relay-worker/`、`CLAUDE.md`、`OmniRoute-vs-FreeLLMAPI-技术路线对比分析.md`。
- locale 文件（60+ 个 x 17 次）= 冲突数量最多的来源。

---

## 4. 冲突量估算

| 类别 | 文件数 | 冲突性质 | 处理难度 |
|---|---|---|---|
| `client/src/i18n/locales/*.json` | ~60 | 紧挨着逐行冲突 | 中低（机械合并，需保留双方新增 key） |
| 被删除/移动的 `server/src/routes/*.ts` | ~6-14 | modify/delete → 需移植到 `routes/bun/*` | 高 |
| CI / Dockerfile / desktop | ~15+ | modify/delete 或整目录新增 | 取决于取舍决策 |
| 同名可合并服务/客户端文件 | ~30 | content conflict 或自动合并 | 中 |

---

## 5. 三种处理方案 & 工作量评估

### 方案 A：整体 `git merge` + 全量解冲突
- 步骤：merge → 逐个解冲突（locale 用脚本合并；modify/delete 逐个人工决策；新功能移植到 bun 等价文件）→ 补齐 bun 分支缺失的功能实现 → 跑测试。
- 优点：历史最完整，一次性纳入所有提交。
- 缺点：数百冲突，且**很多"移植"实际是重新实现功能**（如 idempotency、fetch relay 在 bun 里根本没有等价文件），根本不是"解决冲突"，而是"重新开发"。工作量可能高达 1-2 天甚至更多，易引入回归。
- **不推荐**（除非本分支就是用来承接全部上游功能）。

### 方案 B：按功能 cherry-pick + 适配（推荐）
- 步骤：把 3.1/3.2 里的高价值功能（idempotency、fetch relay、backups、chain manager、SSE 修复、proxy 修复等）**按功能** cherry-pick，每个功能独立适配到 bun 分支的等价文件，逐个提交、逐个跑测试。
- 优点：可控、可回滚、可测试，符合本分支"Bun 原生重构"的定位——源功能为新架构重新实现。
- 缺点：不保留原始提交图，desktop/CI/locale 的大多数 bulk 改动需要按需跳过。

### 方案 C：先出清单、逐步来
- 基于本报告，先选定一批"高价值 + 低冲突"的功能（3.2 的 proxy/SSE 修复 + 3.1 的部分）先合并，其余挂起。

---

## 6. 建议路线

1. **默认跳过**：desktop（整目录）、Express 版 CI/Docker、`client/src/i18n/locales` 的 bulk diff（若非必要不整体并入，避免 60 个文件的冲突噪音）。
2. **优先移植 3.2 的 Proxy/SSE/模型层修复**——这些直接提升正确性，且映射到 bun 同名文件，冲突易控。
3. **再移植 3.1 的新功能**（idempotency、fetch relay、backups、chain manager），每个作为独立提交并补测试。
4. 每个功能合并后 `bun test` 验证。

> 请确认采用哪种方案。若选 B/C，我会按上面路线逐个功能执行。
