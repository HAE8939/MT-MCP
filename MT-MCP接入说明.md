# MT-MCP 介绍与接入说明

公司内部共用的 MCP（Model Context Protocol）服务，常开在极空间 NAS 的 Docker 里。同事在 Cursor、千问办公等支持远程 MCP 的客户端里配置一次地址和共享令牌，即可调用本服务上的全部工具；之后服务端加新工具包时，客户端一般只需刷新工具列表，不必改连接配置。

当前三块能力：

1. **临时图床**：图片上传到腾讯云 COS（不落 NAS），返回约 1 天有效的公网 URL
2. **机位标注**：根据本地项目清单生成可离线打开的标注 HTML；人手点选后导出 JSON，后续导览不走本 MCP
3. **设计提示词库**：只读列出 / 按 id 或 slug 取仓库内 Markdown 提示词（当前 7 条）

协议为 Streamable HTTP，端点无状态。

**给同事**：把本文发出去即可，内含地址、令牌与配置片段。

---

## 0. 命名与位置速查

| 项 | 值 |
| --- | --- |
| 项目名（文档 / 目录） | `MT-MCP` |
| 服务名（`/health` 的 `service`） | `mt-mcp` |
| npm / 镜像名 | `mt-mcp` |
| Origin 仓库 | [hae/mt-mcp](https://cursor.com/codebase/hae/mt-mcp) |
| 本机路径 | `E:\HAE_WORKSPACE\PROJECT_HUB\code\MT-MCP` |
| NAS 部署目录 | `/data_s002/docker-apps/MT-MCP/` |
| Docker 容器名 | `mt-mcp` |
| 局域网 IP:端口 | `192.168.1.135:8787` |

---

## 1. 这是什么 / 解决什么问题

| 要点 | 说明 |
| --- | --- |
| 定位 | 公司共享、常驻的 MCP Hub，多 AI 客户端共用同一套工具 |
| 部署 | 极空间 NAS Docker，局域网常开 |
| 鉴权 | 共享 Bearer 令牌（不是 OAuth） |
| 当前能力 | ① 图床 `imagebed_*` ② 机位标注 `camera_annot_*` ③ 设计提示词 `design_*` |
| 扩展 | 预留 `generation-channel`、`internal-docs` 槽位（尚未注册工具）；加工具时连接地址与令牌通常不变 |
| Agent 如何选功能 | 客户端 `tools/list` 一次拿到**全部已启用工具**；Hub **不做**意图路由。模型按工具名与描述自行选择并 `tools/call`。要少暴露能力，只能在服务端关对应 `PACK_*` / 不配 COS，重启后再刷新列表 |

**已测通**：千问办公接本 MCP 后可上传返图；机位标注与设计提示词包已上线，刷新工具列表可见。

---

## 2. 现在能做什么

连上后应能看到 **7 个工具**（本机 / NAS 均已启用 COS 与三包）：

- 图床：`imagebed_upload` / `imagebed_list` / `imagebed_delete`
- 机位标注：`camera_annot_validate_bootstrap` / `camera_annot_build_html`
- 设计提示词：`design_list_prompts` / `design_get_prompt`

健康检查里 `packs` 可见：`imagebed`、`camera-annot`、`design-prompts` 为 enabled；`generation-channel`、`internal-docs` 为 disabled。

### 2.1 临时图床（`imagebed`）

| 工具名 | 作用 | 主要参数 | 返回 |
| --- | --- | --- | --- |
| `imagebed_upload` | 上传一张图到公司临时图床 | `filename`（必填）；`content_base64` 与 `source_url` **二选一**；可选 `content_type` | 公网 `url`、`key`、`content_type`、`size` 等 |
| `imagebed_list` | 按前缀列出对象 | 可选 `prefix`、`max_keys`（默认 50，最大 100） | 对象列表（含 key / url） |
| `imagebed_delete` | 按对象键删除 | `key`（须在图床前缀内） | 是否已删除 |

#### 上传说明

- 格式：仅 jpeg / png / gif / webp（不收 SVG）
- 大小：默认单张最大 8 MiB（服务端可调，上限 20 MiB）
- `content_base64`：原始 base64，或 `data:image/png;base64,...`
- `source_url`：仅公网 `https`；内网、回环、云元数据地址会被拒绝
- 对象键由服务生成；文件名只作标签
- 返回 URL 在删除前公网可读；**约 1 天后**由 COS 桶生命周期删除（控制台配置，不在本服务内）
- 未配置完整 COS 时，本包不注册工具；机位标注与设计提示词仍可独立启用

### 2.2 机位标注（`camera-annot`）

给千问办公 / Cursor 等用：结合**本地项目**的楼层、平面图、图片清单，生成**单文件离线 HTML**。人在浏览器里点选机位并「导出 → JSON」；**导出之后的导览拼装不再走本 MCP**。

服务端**不读** NAS 或本机路径；平面图和图片只作为相对路径写进页面。调用方负责盘点本地资料、填参数、把返回的 HTML 存到项目目录。

| 工具名 | 作用 |
| --- | --- |
| `camera_annot_validate_bootstrap` | 用与 build 相同的参数先检查；返回楼层数、图片数、建议文件名、schema、警告；**不返回 HTML** |
| `camera_annot_build_html` | 生成完整 HTML；默认还附一份**尚未落点**的 JSON 脚手架（`include_scaffold`，默认 true） |

#### 推荐流程（千问办公）

1. 打开本地项目，整理 `floors`（楼层 + 平面图像素宽高）与 `pages`（每张图相对路径、所属楼层）
2. 先调 `camera_annot_validate_bootstrap`，有警告再改清单
3. 再调 `camera_annot_build_html`，把返回的 `html` **原样**存为建议文件名（一般是 `<项目>-机位标注.html`）
4. 推荐落盘目录：`01_机位标注/`，此时 `base` 用默认 `../` 指向项目素材根
5. **人手**用浏览器打开该 HTML，在平面上点选；`effect` 模式可拖朝向、调 FOV
6. 页面内 **导出 → JSON** → 项目导览标注信息完成
7. 下游用这份 JSON 辅助其他 AI；**与本 MCP 无关**

#### 目录约定（示例）

```text
某项目/
  平面图/一层.png
  jpg/1 (1).jpg
  01_机位标注/
    某项目-机位标注.html    ← MCP 生成后写在这里（base="../"）
    某项目-机位标注.json    ← 人手导出后覆盖/保存
```

#### `mode`（必填）

| mode | 用途 | 交互与导出 | 默认 schema |
| --- | --- | --- | --- |
| `pano` | 实景全景 | 只落点；导出 `dir` / `fov` 为 `null` | `camera-annot.pano-annotations/1` |
| `effect` | 效果图 | 按下拖出朝向，可调视场角 | `camera-annot.camera-annotations/1` |

需要沿用旧项目 id 时可传 `schema`（如 `gdmjt.pano-annotations/1`）、`store_key`（如 `gdmjt`）。

#### 主要参数

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `project` | 是 | 项目名；用于标题与建议文件名「`<project>-机位标注.html`」 |
| `mode` | 是 | `pano` 或 `effect` |
| `floors` | 是 | 非空。每项：`id`、`title`、`plan`（相对 base）、`w`、`h`（平面图像素） |
| `pages` | 是 | 非空。每项：`floor`（须对上某楼层 id）、`file`（相对 base）；可选 `no`、`sec`、`room`、`view`、`conf`、`note` |
| `base` | 否 | HTML 相对素材根的路径，默认 `../` |
| `source_pdf` | 否 | 来源图纸名，写入页脚 |
| `title` / `subtitle` / `logo` | 否 | 页面展示文案 |
| `schema` / `store_key` | 否 | 沿用旧草稿时用 |
| `sections` / `dup_of` | 否 | 分组→楼层兜底、重复页映射 |
| `include_scaffold` | 否 | 仅 build；默认 true，附空 JSON 脚手架 |

约束：`plan` / `file` 必须是相对 `base` 的路径；**禁止**绝对路径、URL、`..`。默认启用（`PACK_CAMERA_ANNOT_ENABLED` 未设或为 true）。**不需要 COS**。

#### 调用参数示例（`pano`）

```json
{
  "project": "示例项目",
  "mode": "pano",
  "base": "../",
  "floors": [
    {
      "id": "F1",
      "title": "一层",
      "plan": "平面图/一层.png",
      "w": 4491,
      "h": 6352
    }
  ],
  "pages": [
    {
      "floor": "F1",
      "file": "jpg/1 (1).jpg",
      "room": "客厅",
      "conf": "low"
    }
  ]
}
```

### 2.3 设计提示词（`design-prompts`）

只读库：把仓库内 Markdown 提示词暴露给客户端。默认开启（`PACK_DESIGN_PROMPTS_ENABLED`），**不需要 COS**。

| 工具名 | 作用 |
| --- | --- |
| `design_list_prompts` | 列出全部提示词元数据（`id`、`title`、`description`、`tags`、`category`、`slug`、`path`、`version`；有 `model`/`image` 时一并返回） |
| `design_get_prompt` | 按 `id` 或 `slug` 取一条；返回 `# Prompt` 正文，有 `# Notes` 时同时返回 `notes` |

`slug` 是不带 `.md` 的相对路径（如 `camera/05_change_angle`）；带 `.md` 也可。只填其一即可；两个都填时必须指向同一条。

#### 当前 7 条提示词

| slug | 标题 | 分类 |
| --- | --- | --- |
| `rendering/01_render_reverse_master` | 通用效果图返推大师 | rendering |
| `rendering/02_render_design_prompt` | 效果图设计提示词 | rendering |
| `moodboard/03_moodboard_master` | 情绪板大师 | moodboard |
| `camera/04_nine_grid_storyboard` | 九宫格分镜图 | camera |
| `camera/05_change_angle` | 换角度 | camera |
| `styling/06_soft_furnishing` | 软装搭配 | styling |
| `floorplan/07_color_plan` | 彩平图提示词生成 | floorplan |

调用示意：

```json
{ "slug": "floorplan/07_color_plan" }
```

或：

```json
{ "id": "a25791f7-951d-4c48-9bd6-a14d2bddd9b5" }
```

#### 新增一条提示词（简）

1. 在 `src/packs/design-prompts/prompts/<分类>/` 新建 `.md`（分类即一级目录；现有 `rendering` / `moodboard` / `camera` / `styling` / `floorplan`）
2. frontmatter 必填 `id`（库内唯一，建议 uuid）、`title`；可选 `model`、`tags`、`description`、`image`、`version`
3. 正文用 `# Prompt`（必填）与可选 `# Notes` 分段
4. 本机 `npm run dev` 保存即可热读；**生产镜像须重新 build**（`npm run build` 会把 Markdown 拷进 `dist/`），再重建 NAS 容器

### 2.4 尚未实现的包

| 包 id | 状态 | 将来工具前缀 |
| --- | --- | --- |
| `generation-channel` | 占位，永不注册工具（直到实现） | `generation_` |
| `internal-docs` | 占位 | `docs_` |

---

## 3. 部署与访问地址

设备须能访问 NAS 局域网 `192.168.1.135`（同网段或可达 VPN）。**不要把 8787 映射到公网。**

| 用途 | 地址 |
| --- | --- |
| MCP 入口 | `http://192.168.1.135:8787/mcp` |
| 健康检查 | `http://192.168.1.135:8787/health` |

- 传输：`http` / `streamable-http`（不要用 stdio 或旧版独立 SSE）
- `/health` 与根路径不鉴权，只返回服务名、版本、已启用包等，不含密钥
- 浏览器带 `Origin` 的请求默认拒绝；Cursor、千问办公等通常不带 Origin，不受影响

```bash
curl -s http://192.168.1.135:8787/health
```

预期：`status` 为 `ok`，`service` 为 `mt-mcp`，`packs` 中 `imagebed` / `camera-annot` / `design-prompts` 为 enabled，看不到令牌或 COS 密钥。

---

## 4. 鉴权怎么配

每个访问 `/mcp` 的请求必须带共享令牌（`MCP_AUTH_TOKEN`），二选一：

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

或：

```http
X-API-Key: <MCP_AUTH_TOKEN>
```

- 令牌放在查询字符串里会被拒绝
- **当前公司内部共享令牌**（向管理员索取；公开仓仅占位符）：`<MCP_AUTH_TOKEN>`
- 令牌来源：NAS `/data_s002/docker-apps/MT-MCP/.env` 的 `MCP_AUTH_TOKEN`（本机同仓 `.env` 保持一致便于联调）
- 本文仅公司内传阅；**不要**发到公开渠道。COS 密钥只在服务端 `.env`

轮换：改 NAS `.env` 里的 `MCP_AUTH_TOKEN` → `docker restart mt-mcp` → 更新各客户端 Header，并同步改本文。

---

## 5. 怎么接到常见客户端

### 5.1 通用 mcp.json 片段

```json
{
  "mcpServers": {
    "MT-MCP": {
      "url": "http://192.168.1.135:8787/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

传输类型若可选，选 `http` 或 `streamable-http`。

### 5.2 Cursor

1. Settings → MCP（或编辑 `~/.cursor/mcp.json` / 项目 `.cursor/mcp.json`）
2. 合并上一节的 `mcpServers`
3. 启用后确认出现 3 个 `imagebed_*`、2 个 `camera_annot_*`、2 个 `design_*`

### 5.3 千问办公

1. 在「自定义 MCP / 远程 MCP」中新增服务
2. URL：`http://192.168.1.135:8787/mcp`
3. Header：`Authorization: Bearer <MCP_AUTH_TOKEN>`
4. 传输若可选：HTTP / streamable-http
5. 测试：图床应返公网链接；机位标注先 `validate` 再 `build_html`；设计提示词可 `design_list_prompts` / `design_get_prompt`

菜单位置以千问当前版本为准；核心是「远程 URL + Authorization Header」。

### 5.4 其他支持远程 MCP 的客户端

- URL：`http://192.168.1.135:8787/mcp`
- Header：`Authorization: Bearer <同上令牌>`

只支持导入 JSON 时，用 5.1 片段。

---

## 6. 注意事项

1. **局域网**：设备须能访问 `192.168.1.135`；外网需先连公司 VPN（若有）。
2. **传阅范围**：本文含内部令牌，只在公司内转发；勿发公开渠道。COS 密钥勿写入客户端配置。
3. **图约 1 天过期**：适合临时预览、跨模型传图；勿当永久图床，勿传密钥/证件/未公开敏感截图。
4. **机位 HTML 离线可用**：生成后与 MCP 脱钩；标注与导出均在本地浏览器完成。
5. **不要把 8787 暴露公网**；外网应走公司可达反向代理并另行设计登录。
6. 客户端配置里只有 MCP 令牌，没有 COS 密钥。
7. **重大改动**（改令牌、改端口、删工具、改工具参数语义、对外暴露）部署前需先确认；单纯加提示词 Markdown + 重建镜像一般可按常规发布。

---

## 7. 运维速查（简）

| 项 | 值 |
| --- | --- |
| 本机路径 | `E:\HAE_WORKSPACE\PROJECT_HUB\code\MT-MCP` |
| Origin | `https://origin.cursor.com/hae/mt-mcp.git` |
| 容器名 | `mt-mcp` |
| NAS 部署目录 | `/data_s002/docker-apps/MT-MCP/` |
| 端口 | `8787` |
| 环境变量 | 同目录 `.env`（可参考仓库 `.env.example`） |
| 重启 | `docker restart mt-mcp` |

极空间环境**没有** `docker compose` 时，在部署目录：

```bash
docker build -t mt-mcp:local .
docker rm -f mt-mcp
docker run -d --name mt-mcp --restart unless-stopped \
  -p 8787:8787 --env-file .env \
  -e HOST=0.0.0.0 -e PORT=8787 \
  mt-mcp:local
```

更完整的开发与扩展说明见同仓库 `README.md`。

---

## 8. 相关文件

| 文件 | 说明 |
| --- | --- |
| `MT-MCP接入说明.md`（本文） | 内部介绍 + 接入说明，**含令牌**，递交同事用这份 |
| `README.md` | 服务端开发、安全与环境变量详解 |
| `.env.example` | 环境变量模板（不含真实密钥） |
| `AGENTS.md` | 给本仓 Agent 的约定（若有） |
