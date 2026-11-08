# MT-MCP

公司内部常驻的 MCP 服务。同事只配置一次地址和共享令牌，就能用这台服务上的全部工具。图片进腾讯云 COS，不写到 NAS 磁盘。之后增加工具包时，客户端连接不用改。

当前协议是 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)（官方 TypeScript SDK v2）。同一个 `/mcp` 端点同时接受 2025-11-25 客户端和 2026-07-28 客户端。服务是无状态的：每个请求单独处理，NAS 前面不需要会话保持。

## 现在有哪些工具

| 工具 | 作用 |
| --- | --- |
| `imagebed_upload` | 上传一张 jpeg / png / gif / webp，返回公网 URL |
| `imagebed_list` | 按前缀列出图床对象 |
| `imagebed_delete` | 按对象键删除 |
| `camera_annot_validate_bootstrap` | 检查楼层和图片清单，不读磁盘 |
| `camera_annot_build_html` | 生成单文件机位标注 HTML，并附一份还没有点位的 JSON 骨架 |
| `design_list_prompts` | 列出仓库里的设计提示词（id、标题、说明、标签、分类、slug） |
| `design_get_prompt` | 按 id 或 slug 取一条提示词正文，有备注时一并返回 |

预留但尚未实现的包（不会注册工具）：`generation-channel`（将来的工具名前缀 `generation_`）、`internal-docs`（将来的工具名前缀 `docs_`）。设计提示词是单独的包，工具名前缀是 `design_`。

## 目录

```
src/
  index.ts                 进程入口
  config.ts                环境变量，密钥只从环境或文件读取
  http/                    健康检查、Bearer 鉴权、/mcp
  mcp/createHub.ts         组装 MCP server，按包注册工具
  packs/
    types.ts               ToolPack 接口
    registry.ts            在这里登记新包
    imagebed/              已实现的图床
    camera-annot/          已实现的机位标注页生成
    design-prompts/        已实现的设计提示词库
      prompts/             Markdown 提示词，按分类分目录
    generation-channel/    预留（生成渠道，工具名前缀 generation_）
    internal-docs/         预留（内部文档，工具名前缀 docs_）
```

加第二个工具包时：

1. 在 `src/packs/<包名>/` 新建目录，导出一个 `ToolPack`。
2. 把它放进 `src/packs/registry.ts` 的 `toolPacks`。
3. 工具名一旦发布就不要改，并带上稳定前缀，例如 `docs_search`。
4. 需要密钥时只从服务端环境读取，不要写进仓库，也不要放进工具返回值。
5. 包还没做完时让 `enabled()` 返回 `false`。如果有人把对应的 `PACK_*_ENABLED=true` 打开，进程只会打一条警告，不会注册空工具。

同事侧仍然是原来的 MCP 地址和令牌。刷新工具列表即可看到新工具。

## 安全

- `/mcp` 的每个请求都要带 `Authorization: Bearer <MCP_AUTH_TOKEN>`，也可以用 `X-API-Key`。令牌放在查询字符串里会被拒绝。
- 这是公司共享密钥，不是一套对外的 OAuth。不要把端口映射到公网。需要给外网用时，应先放在仅公司网络可访问的反向代理后面，并另行设计登录，而不是把这个令牌公开。
- `GET /health` 和 `GET /` 不鉴权，只返回服务名、版本和哪些包已启用，不返回密钥。
- 浏览器带来的 `Origin` 默认拒绝。非浏览器客户端（Cursor 等）通常不带 `Origin`，不受影响。要用网页调试器时，把主机名写进 `MCP_ALLOWED_ORIGINS`。
- 图床 URL 是公网可读的。任何拿到链接的人都能在对象被删掉之前打开它。不要上传密钥、证件或未公开的截图。
- COS 密钥只存在于服务端环境或 Docker secret 文件。客户端配置里只有 MCP 令牌。

## 环境变量

复制 `.env.example` 为 `.env` 后替换占位值。`.env` 已被 git 忽略。

| 变量 | 说明 |
| --- | --- |
| `PORT` | 默认 `8787` |
| `HOST` | 容器内默认 `0.0.0.0` |
| `MCP_AUTH_TOKEN` | 共享令牌，至少 16 位，不能含空格。`openssl rand -hex 32` |
| `MCP_ALLOWED_HOSTS` | 可选。允许访问 `/mcp` 的 Host，逗号分隔，不写端口。空着则不检查 |
| `MCP_ALLOWED_ORIGINS` | 可选。允许的浏览器 Origin 主机名 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 腾讯云 CAM 密钥 |
| `COS_REGION` | 例如 `ap-guangzhou` |
| `COS_BUCKET` | 例如 `dmds-images-1259154611` |
| `COS_PREFIX` | 默认 `dmds/`。上传、列出、删除都不能离开这个前缀 |
| `COS_CDN_DOMAIN` | 可选，例如 `https://img.example.com`。不填则用 COS 默认域名 |
| `COS_OBJECT_ACL` | `public-read`（默认，给每个对象写公有读）或 `default`（继承桶 ACL） |
| `MAX_UPLOAD_BYTES` | 默认 8388608（8 MiB），最大 20 MiB |
| `PACK_CAMERA_ANNOT_ENABLED` | 默认开启。设为 `false` 则不注册机位标注工具。这个包不需要密钥 |
| `PACK_DESIGN_PROMPTS_ENABLED` | 默认开启。设为 `false` 则不注册设计提示词工具。这个包不需要密钥 |

也可以不把密钥写进环境变量，改用文件（适合 Docker secrets）：

```
MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_auth_token
COS_SECRET_ID_FILE=/run/secrets/cos_secret_id
COS_SECRET_KEY_FILE=/run/secrets/cos_secret_key
```

环境变量优先于同名的 `*_FILE`。

CAM 建议只授予该桶、该前缀上的 `PutObject`、`GetBucket`（列出）、`DeleteObject`。使用默认的 `public-read` 时还需要能设置对象 ACL。

公网地址格式：

```
https://<COS_BUCKET>.cos.<COS_REGION>.myqcloud.com/<对象键>
```

配置了 `COS_CDN_DOMAIN` 时，换成该域名加上同样的对象键。

## 桶上的一天删除

生命周期不在这个服务里配置，也不要期待代码去改桶规则。请在腾讯云 COS 控制台为该桶添加生命周期规则：

- 应用范围：指定前缀 `dmds/`（或你改过的 `COS_PREFIX`）
- 操作：文件创建约 1 天后删除
- 规则启用后，过期对象由 COS 删除

上传返回的 URL 在对象被删之前一直是公网可读的。

## 本地冒烟（占位环境即可）

占位密钥可以启动服务并走通鉴权和 MCP 握手。真正上传要换成真实的 COS 密钥，否则 COS 会拒绝。

```bash
cp .env.example .env
npm install
npm test
npm run dev
```

另开一个终端：

```bash
curl -s http://127.0.0.1:8787/health

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer replace-me-with-openssl-rand-hex-32' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

预期：`/health` 返回 `status: ok`，且正文里没有令牌和 COS 密钥；不带令牌的 `/mcp` 返回 401；带上示例令牌后，响应里能看到 `MT-MCP`。示例令牌和示例 COS 密钥只适合本机冒烟，同事接入前必须换掉。启动日志会提示占位符还在。

开发命令：`npm run dev`（tsx）、`npm run build` 然后 `npm start`、`npm test`。

## 在 NAS 上用 Docker 跑

`docker-compose.yml` 按群晖 Container Manager、威联通 Container Station 这一类环境来写：进程随容器重启，端口只建议映射在局域网。

```bash
cp .env.example .env
# 编辑 .env，填入真实令牌和 COS 密钥
 param($m) $m.Value -replace 'MT-MCP','mt-mcp' 
 param($m) $m.Value -replace 'MT-MCP','mt-mcp' 
curl -s http://127.0.0.1:8787/health
```

镜像用多阶段构建，运行用户是 `node`，不把 `.env` 打进镜像。密钥通过 `env_file` 或文件型 secret 注入。容器里的健康检查访问 `http://127.0.0.1:8787/health`，所以即使给 `/mcp` 配了 `MCP_ALLOWED_HOSTS`，健康检查仍然可用。

群晖：打开 Container Manager，用「项目」导入本目录，让它读取 `docker-compose.yml`。不要在路由器上把 8787 转发到公网。

## 同事怎么连

把下面的地址和令牌交给同事。令牌就是服务器上的 `MCP_AUTH_TOKEN`，不是 COS 密钥。

Cursor 的 `~/.cursor/mcp.json`（或项目里的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "MT-MCP": {
      "url": "http://<NAS局域网IP>:8787/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

如果客户端要求写传输类型，用 `http` 或 `streamable-http`，不要用已经淘汰的独立 SSE 传输。端点仍然是同一个 `http://<NAS局域网IP>:8787/mcp`。请求头同样是 `Authorization: Bearer <MCP_AUTH_TOKEN>`。也接受 `X-API-Key: <MCP_AUTH_TOKEN>`。

连上之后应能看到 `imagebed_upload`、`imagebed_list`、`imagebed_delete`，机位标注的 `camera_annot_validate_bootstrap`、`camera_annot_build_html`，以及设计提示词的 `design_list_prompts`、`design_get_prompt`。地址和令牌不用改。上传时提供文件名，以及 `content_base64`（可以是 `data:image/png;base64,...`）或一个公网 `https` 图片地址，二选一。`source_url` 只允许公网 https，内网、回环和云元数据地址会被拒绝。

图床没配 COS 时，机位标注和设计提示词工具仍然在。只有把 `PACK_CAMERA_ANNOT_ENABLED=false` 或 `PACK_DESIGN_PROMPTS_ENABLED=false` 写进环境并重启，对应工具才会从列表里消失。

## 机位标注 HTML

这个包只负责生成标注页。千问办公（或其他已接入本服务的客户端）先在项目目录里看素材，把楼层和图片整理成参数调用工具，再把返回的 HTML 存到素材旁边。人用浏览器打开页面，在平面图上点机位，点「导出 → JSON」。导出的 JSON 交给别的流程。本包不做全景转换，也不做导览或 tour 导出。

页面是单文件，双击即可用 `file://` 打开。图片按 `base`（默认 `../`）相对 HTML 所在位置读取。常见摆法：

```
项目/
  平面图/
  jpg/                 或 地下室/、一层/
  01_机位标注/
    <项目>-机位标注.html
```

`mode` 必填，二选一：

| mode | 页面行为 | 导出的 dir / fov | 默认 schema |
| --- | --- | --- | --- |
| `pano` | 实景全景，单击落点 | `null` | `camera-annot.pano-annotations/1` |
| `effect` | 效果图，按下并拖出朝向，可调视场角 | 方位角与视场角 | `camera-annot.camera-annotations/1` |

要沿用旧项目的 schema id 时传 `schema`，例如 `gdmjt.pano-annotations/1`。`store_key` 是浏览器本地草稿的前缀，页面会接上 `.cameras.v1`；同一项目重复生成会沿用同一键。旧页面如果用的是 `gdmjt.cameras.v1`，这里传 `store_key: "gdmjt"`。

调用示意（清单由客户端从本地文件整理，服务端不读这些路径）：

```json
{
  "project": "示例别墅",
  "source_pdf": "方案平面.pdf",
  "base": "../",
  "mode": "pano",
  "floors": [
    { "id": "F1", "title": "一层", "plan": "平面图/一层.png", "w": 4000, "h": 3000 }
  ],
  "pages": [
    { "floor": "F1", "file": "jpg/1 (1).jpg", "room": "客厅", "view": "沙发", "conf": "high" }
  ]
}
```

`w` / `h` 是平面图的像素尺寸，导出归一化坐标要用。`pages[].no` 可以整组省略，按数组顺序从 1 编号。`pages[].floor` 必须对上某个楼层 `id`。`plan` 和 `file` 都相对 `base`，不要写绝对路径、URL 或 `..`。

返回里有建议文件名 `filename`、完整 `html`，以及 `scaffold`（还没有点位的导出 JSON，`cameras` 为空，`exportedAt` 为 `null`）。人工在页面里导出的 JSON 才是下游要用的那份。

`camera_annot_validate_bootstrap` 用同一套参数做检查，不返回 HTML。缺平面图、图片列表为空、或图片指向了不存在的楼层时，两个工具都会返回明确错误。

可以先校验再生成：

1. 在项目目录列出平面图和图片，读出每张平面的像素宽高。
2. 调用 `camera_annot_validate_bootstrap`。有警告（某层没有图片、同一文件列了多次、同一个分组跨了多层）就改清单。
3. 调用 `camera_annot_build_html`，把 `html` 写成 `01_机位标注/<filename>`。
4. 人打开该 HTML 完成点选，用「导出 → JSON」。
5. 之后的导览制作不走这个 MCP。

## 设计提示词

这个包把仓库里的 Markdown 提示词读出来交给客户端。服务只返回这些文件，鉴权仍是原来的 Bearer 令牌。默认开启。

| 工具 | 作用 |
| --- | --- |
| `design_list_prompts` | 列出全部提示词。每条有 `id`、`title`、`description`、`tags`、`category`、`slug`、`path`、`version`。有 `model` 或 `image` 时一并返回 |
| `design_get_prompt` | 用 `id` 或 `slug` 取一条。返回标题和 `# Prompt` 下可直接使用的正文；文件里有 `# Notes` 时同时返回 `notes` |

`slug` 是不带 `.md` 的相对路径，例如 `camera/05_change_angle`。带上 `.md` 也可以。只填 `id` 或 `slug` 其中一个即可；两个都填时必须指向同一条。找不到时工具返回明确错误，不会编一条。

`version` 优先用 frontmatter 里的 `version`。没有则是该文件字节的 `sha256:` 加前 12 位十六进制，正文一改版本就变。

当前五条：

| slug | 标题 | 分类 |
| --- | --- | --- |
| `rendering/01_render_reverse_master` | 通用效果图返推大师 | rendering |
| `rendering/02_render_design_prompt` | 效果图设计提示词 | rendering |
| `moodboard/03_moodboard_master` | 情绪板大师 | moodboard |
| `camera/04_nine_grid_storyboard` | 九宫格分镜图 | camera |
| `camera/05_change_angle` | 换角度 | camera |

调用示意：

```json
{ "slug": "rendering/01_render_reverse_master" }
```

或：

```json
{ "id": "14a956a9-5c6e-4c3a-98d1-485bf385542b" }
```

### 新增一条提示词

1. 在 `src/packs/design-prompts/prompts/<分类>/` 下新建一个 `.md` 文件。分类是一级目录名。现有 `rendering`、`moodboard`、`camera`，也可以新建目录。不要再套一层子目录，也不要把文件直接放在 `prompts/` 根下。
2. 文件名只用字母、数字、`.`、`_`、`-`。slug 就是 `<分类>/<文件名>`（不含 `.md`）。
3. 文件开头写 frontmatter。`id` 和 `title` 必填，`id` 在整库里唯一，建议用 uuid。其余字段可选。值和标签都写在一行上，不要用 `|` 或 `>` 折行：

```yaml
---
id: 00000000-0000-4000-8000-000000000000
title: 中文标题
model: Gemini
tags:
  - 提示词
description: 一句话说明这条提示词做什么
---
```

可选字段还有 `image`（一张参考图的路径，只作记录，服务不读这张图）和 `version`（自己定的版本号；不写就用文件内容哈希）。

4. 正文用这两个标题分段。`# Prompt` 必填，`# Notes` 可选。提示词内部可以有别的标题，只要整行不是 `# Prompt` 或 `# Notes`：

```markdown
# Prompt

这里是交给模型的提示词。

# Notes

给人看的备注。
```

5. 工具每次调用都从磁盘重读这些文件。`npm run dev` 保存后即可看到。生产镜像要重新构建：`npm run build` 会把 Markdown 拷到 `dist/packs/design-prompts/prompts/`，容器里读的是这份拷贝。

## 限制

- 单张最大 8 MiB（可用 `MAX_UPLOAD_BYTES` 调整，上限 20 MiB）。
- 只收 jpeg、png、gif、webp。SVG 不收。
- 对象键由服务生成，调用方给的文件名只作标签，不能借 `../` 写出前缀。
- 列出最多 100 条。结果被截断时，把 `prefix` 收窄再查。
- 服务不在 NAS 上保存图片，也不创建 COS 生命周期规则。
