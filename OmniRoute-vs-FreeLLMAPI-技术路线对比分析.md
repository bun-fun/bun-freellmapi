---
title: "OmniRoute vs FreeLLMAPI：两个 AI 代理项目的技术路线深度对比"
description: "深入分析 Node.js 企业级 AI 网关与 Bun 原生轻量级免费 LLM 代理的技术路线选择"
date: 2026-08-10
tags: [OmniRoute, FreeLLMAPI, Bun, Node.js, AI Gateway, 技术对比]
---
# OmniRoute vs FreeLLMAPI：两个 AI 代理项目的技术路线深度对比
## 前言
最近花了些时间深入研究了两个开源 AI 代理项目——**OmniRoute** 和 **FreeLLMAPI**（Bun 原生分支）。虽然它们都做「AI 代理」这件事，但技术路线和设计哲学却截然不同。一个像航空母舰，一个像快艇。这篇文章就来聊聊它们的差异，以及背后的技术选择逻辑。
---
## 一、项目速览
### OmniRoute — 企业级 AI 网关
- **版本**：v3.8.50
- **运行时**：Node.js 22+/24+
- **定位**：统一 AI 路由器，291 个提供商，自动故障转移
- **代码规模**：数十万行，25000+ 测试用例
- **依赖**：200+ 个 npm 包，安装约 5GB
- **许可证**：MIT
### FreeLLMAPI (Bun fork) — 轻量级免费 LLM 代理
- **版本**：v0.1.0
- **运行时**：Bun 1.3+
- **定位**：免费 LLM 模型聚合，OpenAI 兼容代理
- **代码规模**：数千行，Monorepo 4 个子包
- **依赖**：~20 个，安装 <100MB
- **许可证**：MIT
---
## 二、技术栈对比
### 运行时
| 技术 | OmniRoute | FreeLLMAPI |
|------|-----------|------------|
| **JS 引擎** | Node.js 22+/24+ | **Bun 1.3+** |
| **HTTP 服务器** | Next.js 16 (App Router) | **Bun.serve**（内置） |
| **语言** | TypeScript 6.0 | TypeScript 5.9+ |
| **TypeScript 严格度** | `strict: false` | **`strict: true`** |
OmniRoute 选择了成熟的 Node.js 生态，而 FreeLLMAPI 则拥抱了 Bun 的原生优势。这里有个有趣的细节：OmniRoute 的 `tsconfig.json` 设置的是 `strict: false`，而 FreeLLMAPI 是 `strict: true`——这反映了两个项目对 TypeScript 严格程度的不同取舍。
### 前端
| 技术 | OmniRoute | FreeLLMAPI |
|------|-----------|------------|
| **框架** | Next.js 16 + React 19 | **Vite + React 19** |
| **UI 库** | Tailwind CSS 4 | Tailwind CSS 4 + shadcn |
| **状态管理** | Zustand 5 | **@tanstack/react-query** |
| **路由** | Next.js App Router | **react-router-dom** |
| **国际化** | **next-intl（43 种语言）** | 内置 i18n（少量语言） |
| **构建** | Next.js (Turbopack/Webpack) | **Vite 8** |
OmniRoute 选择了 Next.js 全栈框架，前端和后端深度耦合。FreeLLMAPI 则选择了更轻量的 Vite + React 组合，前后端通过 API 通信。
### 后端
| 技术 | OmniRoute | FreeLLMAPI |
|------|-----------|------------|
| **HTTP 服务器** | Next.js 16 | **Bun.serve**（原生） |
| **数据库** | SQLite (better-sqlite3/bun:sqlite/sql.js) | **Bun SQLite**（bun:sqlite） |
| **验证** | **Zod 4** | Zod 3 |
| **日志** | **pino**（结构化 JSON） | 无专用日志库 |
| **加密** | **AES-256-GCM** | **AES-256-GCM** |
| **HTTP 客户端** | undici | **undici + socks-proxy-agent** |
这里有个值得注意的点：OmniRoute 的数据库层设计了一个**驱动级联**机制——`bun:sqlite → better-sqlite3 → node:sqlite → sql.js`。这意味着即使运行在 Bun 上，它也能正常工作。而 FreeLLMAPI 则直接拥抱了 `bun:sqlite`，没有这些兼容层。
---
## 三、架构设计对比
### 项目结构
```
OmniRoute/                          FreeLLMAPI/
├── src/          (Next.js 16)      ├── server/    (Bun HTTP 服务器)
├── open-sse/     (流式引擎)         ├── client/    (Vite + React SPA)
├── electron/     (桌面端)           ├── cli/       (CLI 工具)
├── tests/        (25000+ 测试)      ├── shared/    (共享类型)
├── docs/         (43 种语言)        └── docs/      (文档)
├── bin/          (CLI 入口)
└── scripts/      (150+ 构建脚本)
```
### 路由引擎
| 特性 | OmniRoute | FreeLLMAPI |
|------|-----------|------------|
| **路由策略** | **19 种** | **简单故障转移** |
| **故障转移** | **4 层**（订阅→API→廉价→免费） | 单层（按优先级） |
| **弹性机制** | **3 层**（断路器/冷却/模型锁定） | 无 |
| **自动组合** | **Auto-Combo 引擎**（12 因子评分） | 无 |
| **压缩引擎** | **12 层管道**（RTK+Caveman 等） | 无 |
OmniRoute 的路由引擎是其核心卖点——19 种路由策略、4 层故障转移、3 层弹性机制，以及 12 层压缩管道。而 FreeLLMAPI 则保持了极简的故障转移逻辑。
### 协议支持
| 协议 | OmniRoute | FreeLLMAPI |
|------|-----------|------------|
| **OpenAI 兼容** | ✅ 完整 | ✅ 完整 |
| **Anthropic 兼容** | ✅ | ❌ |
| **Gemini 兼容** | ✅ | ❌ |
| **MCP 服务器** | ✅ **105 个工具** | ❌ |
| **A2A 协议** | ✅ | ❌ |
| **OAuth** | ✅ 13 个提供商 | ❌ |
OmniRoute 支持多种协议，甚至内置了 105 个 MCP 工具。FreeLLMAPI 则专注于 OpenAI 兼容的 API 表面。
---
## 四、关键差异分析
### 为什么 FreeLLMAPI 选择 Bun？
从 FreeLLMAPI 的 README 可以看到明确的设计理念：
> "This fork is a complete rewrite that replaces Express with **Bun's built-in HTTP server** (`Bun.serve`), resulting in: Faster startup and lower memory footprint, Fewer dependencies (no Express, no body-parser, no cors middleware), Bun SQLite driver instead of `better-sqlite3`"
**FreeLLMAPI 选择 Bun 的原因：**
1. **项目规模小** — 依赖少，没有原生模块依赖问题
2. **功能简单** — 只有免费 LLM 代理，不需要 TLS 指纹、Electron、MCP 等复杂功能
3. **Bun 原生优势** — `Bun.serve` 替代 Express，`bun:sqlite` 替代 better-sqlite3
4. **单文件构建** — `bun build --target bun --minify` 输出单个可执行文件，部署极简
### 为什么 OmniRoute 不能完全切换 Bun？
| 原因 | 说明 |
|------|------|
| **TLS 指纹模拟** | `tls-client-node` 是核心功能，Bun 不兼容 |
| **Electron 桌面端** | 强制依赖 Node |
| **Next.js 16** | 官方主要支持 Node |
| **原生模块** | keytar、onnxruntime-node、sharp 等 |
| **测试框架** | 25000+ 测试基于 `node:test` |
| **生态工具** | SonarQube、Codecov、Husky 等 |
### 有趣的事实：OmniRoute 已经部分支持 Bun
在分析过程中，我发现 OmniRoute 的代码库中已经内置了 Bun 支持：
1. `src/lib/db/adapters/bunSqliteAdapter.ts` — 完整的 Bun SQLite 适配器
2. `driverFactory.ts` 中驱动级联顺序：**`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js`**
3. `AGENTS.md` 明确说明：Bun 1.3.14 已作为 devDependency 固定，用于运行部分构建/检查脚本
这意味着 OmniRoute 的作者已经做了「渐进式 Bun 支持」的设计——数据库层完整适配 Bun，但生产运行时仍然保持 Node。
---
## 五、部署体验对比
### OmniRoute 部署
```bash
# npm 全局安装（5GB 依赖）
npm install -g omniroute
# 或者 Docker
docker run -d --name omniroute -p 20128:20128 diegosouzapw/omniroute:latest
# 启动
omniroute
```
### FreeLLMAPI 部署
```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash
# 克隆项目
git clone https://github.com/stxh/freellmapi.git
cd freellmapi
# 安装依赖（<100MB）
bun install
# 构建
bun run build
# 启动
cd server && bun dist/server.js
# 或者直接部署单文件到任何机器（只需 Bun）
cp -r server/dist /opt/freellmapi
cd /opt/freellmapi && bun server.js
```
FreeLLMAPI 的部署体验明显更轻量——依赖少、构建快、单文件部署。而 OmniRoute 虽然功能丰富，但部署成本也相应更高。
---
## 六、总结与选择建议
### 两个项目的定位完全不同
| 项目 | 定位 | 一句话总结 |
|------|------|-----------|
| **OmniRoute** | 🏢 **企业级 AI 网关** | 291 个提供商，19 种路由策略，12 层压缩，105 个 MCP 工具 |
| **FreeLLMAPI** | 🏠 **个人免费 LLM 代理** | 20 个免费提供商，简单故障转移，极简部署，Bun 原生 |
### 技术路线选择建议
| 场景 | 推荐项目 | 理由 |
|------|----------|------|
| **企业/团队使用** | **OmniRoute** | 功能完整、弹性好、安全机制完善 |
| **个人开发者** | **FreeLLMAPI** | 轻量、部署简单、免费模型够用 |
| **需要 TLS 指纹** | **OmniRoute** | FreeLLMAPI 不支持 |
| **需要 MCP/A2A** | **OmniRoute** | FreeLLMAPI 不支持 |
| **需要 Electron 桌面端** | **OmniRoute** | FreeLLMAPI 不支持 |
| **快速部署免费模型** | **FreeLLMAPI** | 单文件部署，Bun 原生，<100MB |
| **需要大量付费模型** | **OmniRoute** | 200+ 付费提供商 |
| **资源受限环境** | **FreeLLMAPI** | 内存占用低，依赖少 |
### 关于「Bun 切换」的最终结论
| 项目 | 能否切换到 Bun | 结论 |
|------|---------------|------|
| **OmniRoute** | ❌ **不建议** | 深度绑定 Node 生态（TLS/Electron/Next.js），Bun 仅作辅助工具 |
| **FreeLLMAPI** | ✅ **已切换成功** | 项目轻量、无原生模块依赖，Bun 原生优势明显 |
---
## 写在最后
**OmniRoute 是「Node 生态的庞然大物」，FreeLLMAPI 是「Bun 原生的轻骑兵」。**
两个项目的技术路线选择完全合理——OmniRoute 追求功能完整度，FreeLLMAPI 追求极简高效。没有谁对谁错，只有谁更适合你的场景。
如果你是企业用户，需要完整的 AI 网关功能，OmniRoute 是不二之选。如果你是个体开发者，只想快速搭建一个免费 LLM 代理，FreeLLMAPI 的 Bun 原生体验会让你眼前一亮。
而如果你像我一样，对 Bun 感兴趣但又不想放弃 Node 生态的丰富资源，不妨看看 OmniRoute 的「渐进式 Bun 支持」设计——它给出了一个很好的思路：**数据库层用 Bun，生产运行时用 Node，各取所长。**