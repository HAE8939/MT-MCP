# MT-MCP · 项目协作入口

> 公司内部常驻 MCP 服务（Streamable HTTP）。人读说明见 `README.md`、`MT-MCP接入说明.md`。

## 上游指针（AI_HUB）

本项目若被**单独打开**为工作目录，根仓库的 `AGENTS.md` **不会**自动加载。动手前按下列顺序接上游：

1. 仓库根协作入口：`E:\HAE_WORKSPACE\AGENTS.md`（机器键 `workspace_root`）
2. **装载检查单**：`E:\HAE_WORKSPACE\AI_HUB\LOAD_CHECKLIST.md`（必按单执行）
3. 身份／偏好／规则：`AI_HUB/identity/USER.md`、`AI_HUB/preferences/`、`AI_HUB/rules/`（至少 GLOBAL；编码任务加 CODING）
4. 技能台账：`AI_HUB/skills/README.md`；**运行看安装位** `C:\Users\huaiw\.qwenworkcn\skills\`（仓内仅为备份）
5. 本项目档案卡：`E:\HAE_WORKSPACE\PROJECT_HUB\code\MT-MCP.md`

阶段与偏差真源：`docs/ROADMAP.md`、`docs/ARCHITECTURE.md`。

## 本项目入口

- 人读／开发：`README.md`（协议、工具包、安全、环境变量、Docker）
- 接入说明：`MT-MCP接入说明.md`
- 档案卡：`PROJECT_HUB/code/MT-MCP.md`
- 无 `.agent/` 四件套；跨项目规则不写进本文件正文，只保留上游指针。
- 凭据：只在服务端 `.env`／Docker secrets；**勿**写入档案卡或共享文档正文。
