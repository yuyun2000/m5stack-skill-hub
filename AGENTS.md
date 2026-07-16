# AGENTS.md

## 角色定位

你为 M5Stack 的 AI 工程师服务。你的目标是帮助团队维护这个内部 Skill 共享站，让同事可以在局域网内上传、浏览、评论、下载和复用 Codex Skill。

## 项目概览

- 这是一个 M5Stack 内部使用的局域网 Skill 共享服务。
- 后端位于 `server/`，使用 Python 标准库实现 HTTP 服务和 API，不依赖第三方包。
- 前端位于 `public/`，使用原生 HTML、CSS、JavaScript，不引入构建工具。
- 管理脚本位于 `scripts/`，同时支持 Windows PowerShell/CMD 和 Linux Shell。
- 运行时数据默认写入 `server/.data/`，包括已共享 Skill、评论、历史记录、备份和临时文件；这些数据不应提交到 Git。

## 工作原则

- 优先保持项目轻量：不要随意增加框架、打包器或第三方依赖。
- 面向 M5Stack 内部团队优化体验：文案、错误提示、安装说明应清晰、中文优先，并适合非前端/后端同事使用。
- 保护用户数据：上传文件、评论、备份和删除逻辑要谨慎处理，避免误删、路径穿越和覆盖不可恢复。
- 修改前先理解现有接口约定，避免破坏 `public/app.js` 与 `server/skill_share_server.py` 之间的 API 契约。
- 兼顾 Windows 与 Linux：脚本、路径示例和启动说明需要同时考虑两端环境。

## 常用命令

Windows:

```powershell
.\scripts\manage.ps1 start
.\scripts\manage.ps1 stop
.\scripts\manage.ps1 restart
.\scripts\manage.ps1 status
.\scripts\manage.ps1 logs
.\scripts\manage.ps1 start -Port 8080
```

Linux:

```bash
bash ./scripts/manage.sh start
bash ./scripts/manage.sh stop
bash ./scripts/manage.sh restart
bash ./scripts/manage.sh status
bash ./scripts/manage.sh logs
bash ./scripts/manage.sh start --port 8080
```

手动启动:

```powershell
python .\server\skill_share_server.py --host 0.0.0.0 --port 1885 --public-dir .\public --data-dir .\server\.data
```

## 代码规范

- Python 代码保持标准库优先，风格清晰、函数职责单一。
- 前端代码保持原生实现，避免引入复杂状态管理或构建步骤。
- 文件读写统一注意 UTF-8 编码，中文文案不要产生乱码。
- 新增 API 时保持 JSON 返回结构稳定，并为错误场景返回明确的信息。
- 新增或修改路径处理时必须使用安全的相对路径校验，防止 `../`、绝对路径和非法文件名逃逸数据目录。
- CSS 修改应保持现有视觉语言，优先改进可读性、响应式和可访问性，不要做无关的大幅重设计。

## 验证清单

修改后尽量完成以下验证：

- 启动服务后访问 `http://127.0.0.1:1885` 或脚本输出的局域网地址。
- 检查 `GET /api/health` 返回正常。
- 验证共享列表、Skill 详情、评论、下载 zip、删除和重新上传流程。
- 验证上传目录中包含 `SKILL.md` 的 Skill 可以被正确解析。
- 验证下载后的 zip 解压后仍保持 `skill-name/SKILL.md` 这类结构。
- 验证 Windows 与 Linux 脚本涉及的路径、PID、日志和端口参数没有被破坏。

## Git 与数据注意事项

- 不要提交 `server/.data/`、`scripts/.runtime/`、日志、备份 zip 或临时文件。
- 不要把真实内部 Skill 内容、评论数据或用户上传文件硬编码到代码或文档中。
- 修改 README、前端文案或 API 时，确保中文显示正常且示例路径准确。
- 如果发现已有工作区变更不是你造成的，不要回滚；先确认变更意图再继续。

