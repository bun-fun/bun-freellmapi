# 在 Hugging Face Spaces 上部署免费 LLM API 代理（基于 Bun）

[models.dev](https://github.com/anomalyco/models.dev) 追踪了数百个免费 LLM 模型。支持的平台包括 **Google AI Studio、Groq、Cerebras、SambaNova、NVIDIA NIM、Mistral、OpenRouter、GitHub Models、Cohere、Cloudflare Workers AI、智谱 AI** 等。前段时间我构建了一个代理，将它们统一聚合到一个兼容 OpenAI 的端点后面。

最终成果是 [bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi)，一个基于[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)的 Bun 的分支，大约五分钟即可部署到 Hugging Face Spaces。

## 为什么用 Bun？

原始的 FreeLLMAPI 使用 Node.js + Express。我用 Bun 内置的 HTTP 服务器（`Bun.serve`）重写了它，原因有三：

- **单一依赖** — Bun 既是运行时也是包管理器。无需 Express、body-parser、cors 中间件，也无需 `better-sqlite3`。
- **快速启动** — HF Spaces 上的冷启动从几秒降到一秒以内。
- **全部依赖打包为自包含** — `bun build --target bun` 生成一个包含所有依赖的 `server.js`。可在任何运行 Bun 的地方部署。

感谢原项目，部署后提供OpenAI标准的API 接口 —— 任何 OpenAI SDK 都可以作为客户端使用。

## 工作原理

首次启动时，服务器会：

1. 从 [models.dev](https://github.com/anomalyco/models.dev) 获取免费模型
2. 筛选 `pricing.prompt === "0" && pricing.completion === "0"` 的模型
3. 每个模型按提供的平台（Google、Groq 等）的baseUrl与用户提供的key组成调用路由
4. 将模型目录和回退优先级写入本地 SQLite 数据库
5. 创建一个管理员用户和一个统一的 API 密钥

当聊天请求到达 `/v1/chat/completions` 时，代理会从你已配置密钥的平台中选择最佳可用模型。如果某个提供商达到速率限制，它会自动选择下一个模型。

提供商 API 密钥使用 AES-256-GCM 加密存储。

## 部署到 Hugging Face Spaces

这是最实用的部分。免费的 HF Space 可以让你用最少的设置获得一个公共 HTTPS 端点。

**你需要准备：**
- 一个 Hugging Face 账号
- 本地安装 [Bun](https://bun.sh/) 用于构建，或直接使用 [bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi)预构建结果

**第一步(可选)：构建**

```bash
git clone https://github.com/bun-fun/bun-freellmapi.git
cd bun-freellmapi
bun install
bun run build
```

这会生成 `server/dist/server.js`（打包后的服务器）和 `server/dist/web/`（React 管理后台）。

**第二步：部署到 HF Space**

由于 HF Space 重启后文件系统会重置，SQLite 数据库中的 API 密钥和配置会丢失。解决方案是绑定一个 HF Dataset 作为持久化存储：

1. 在 Hugging Face 上创建一个新的 **Dataset**（设为私有）。例如 yourname/freellmapi-backups
2. 在 Space Settings → Repository Secrets 中添加 `HF_TOKEN`（你的 User Access Token），HF_DATASET_ID （yourname/freellmapi-backups）
3. 首次启动后，服务器会将 `data/freeapi.db` 自动同步到该 Dataset

在 Hugging Face 上创建一个新的 **Docker** Space。
或更简单的直接访问公开示例[https://huggingface.co/spaces/bun008/freellmapi](https://huggingface.co/spaces/bun008/freellmapi)。然后在页面右上角，点击3点的菜单，直接使用Duplicate this Space就可以建立你自己的应用了。

```bash
git clone https://huggingface.co/spaces/yourname/freellmapi
cd freellmapi

# 复制构建产物
cp /path/to/server/dist/server.js .
cp /path/to/server/dist/web/* .
cp /path/to/server/dist/Dockerfile .

git add . && git commit -m "Deploy" && git push
```

**第三步：配置密钥**

在 Space Settings → Repository Secrets 中设置：

| 密钥 | 必填 | 说明 |
|------|------|------|
| `ENCRYPTION_KEY` | 是 | 64 位十六进制密钥，用于 AES-256-GCM 加密。生成：`bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_PASSWORD` | 否 | 管理后台密码（不设置则自动生成） |
| `HF_TOKEN` | 否* | Hugging Face User Access Token，用于 Dataset 备份 |
| `HF_DATASET_ID` | 否* | Dataset 仓库 ID，例如 `yourname/freellmapi-backups` |
| `BACKUP_ENABLED` | 否 | 设为 `true` 启用自动备份/恢复 |
| `BACKUP_INTERVAL_MS` | 否 | 备份间隔毫秒数（默认 `86400000` = 24 小时） |

*当 `BACKUP_ENABLED=true` 时必须填写。

Space 构建完成后（大约 2 分钟），打开 Space URL 并用构建日志中的管理员密码登录即可。

**典型配置：**
```
ENCRYPTION_KEY=<64位十六进制密钥>
ADMIN_PASSWORD=<你的安全密码>
HF_TOKEN=hf_your_token
HF_DATASET_ID=yourname/freellmapi-backups
BACKUP_ENABLED=true
```

## 保持与 models.dev 同步

模型目录从不硬编码。每次全新启动都会拉取 models.dev 的最新列表。如果有新的免费模型出现，你的代理会自动识别。

要刷新已有数据库，只需删除 `data/freeapi.db` 并重启即可。

## 给中国大陆用户的说明

我构建这个项目的原因之一是：许多免费提供商（Google AI Studio、Groq、Cerebras、Mistral 等）在中国大陆无需 VPN 即可直接访问。在 HF Spaces 上自托管一个代理，可以将它们聚合为单个 API 端点，供任何应用程序使用。

## 独立运行

同样的 `server.js` 可以在任何运行 Bun 的地方使用——VPS、树莓派或 Docker 容器：

```bash
ENCRYPTION_KEY=<key> ADMIN_PASSWORD=<pass> bun server.js
```

端口默认为 `3001`，可通过 `PORT` 环境变量修改（HF Spaces 内部映射为 `7860`）。

无需 `node_modules`，无需构建步骤。只有一个文件。

## API 使用示例

部署完成后，任何 OpenAI SDK 均可直接使用：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://yourname-freellmapi.hf.space/v1",
    api_key="freellmapi-你的统一密钥",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "你好!"}],
)
print(resp.choices[0].message.content)
```

## 公网部署安全注意事项

1. **使用 HTTPS** — HF Spaces 自动提供 TLS。自定义部署请在前方加 Nginx/Caddy 反向代理。
2. **设置强密码** — 不要依赖自动生成的 `ADMIN_PASSWORD`，务必使用长而复杂的值。
3. **保护 `ENCRYPTION_KEY`** — 丢失该密钥将导致已存储的 API 密钥无法恢复。
4. **统一 API 密钥** — 启动时打印的统一密钥用于代理认证（`/v1/chat/completions`），请定期轮换，不要公开分享。
5. **Space 设为 Private** — 虽然管理后台自带认证，Private 可见性增加了网络层防护。
6. **Dataset 设为私有** — 备份数据集默认公开，记得手动设为 Private。

## 试试看

在线演示地址：[bun008-freellmapi.hf.space](https://bun008-freellmapi.hf.space)。[bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi) 以 MIT 许可证发布在 GitHub 上。
