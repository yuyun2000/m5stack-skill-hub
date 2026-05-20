# M5Stack Skill 局域网共享站

这是 M5Stack 内部使用的局域网 Skill 共享服务：同一个 Python 服务会托管网页，并提供上传、覆盖、删除、详情、评论、压缩包下载和服务端备份接口。默认不需要安装第三方依赖，只要本机有 Python 3 即可运行。

平台目标是让同事把 Codex Skill 共享出来，沉淀 M5Stack 产品资料、技术支持、文档翻译、研发流程、售后回复等可复用经验。Skill 本身主要给 agent 读取；评论区用于给同事补充“这个 Skill 能做什么、适合谁用、有哪些注意事项”。

## 快速启动

推荐使用内置脚本启动。脚本会自动启动完整共享服务，并托管 `public/` 目录。

Windows：

```powershell
.\scripts\manage.ps1 start
```

Linux：

```bash
bash ./scripts/manage.sh start
```

启动后复制脚本输出的局域网地址，例如：

```text
http://192.168.20.69:5173
```

同一局域网的同事打开这个地址即可使用。

## 一键管理脚本

默认监听 `0.0.0.0:5173`，方便局域网访问。

### Windows

可直接双击：

- `scripts\start-windows.cmd`：启动
- `scripts\stop-windows.cmd`：停止
- `scripts\restart-windows.cmd`：重启

也可以在 PowerShell 里使用完整管理命令：

```powershell
.\scripts\manage.ps1 start
.\scripts\manage.ps1 stop
.\scripts\manage.ps1 restart
.\scripts\manage.ps1 status
.\scripts\manage.ps1 open
.\scripts\manage.ps1 logs
.\scripts\manage.ps1 start -Port 8080
.\scripts\manage.ps1 logs -Follow
```

### Linux

可以使用快捷脚本：

```bash
bash ./scripts/start-linux.sh
bash ./scripts/stop-linux.sh
bash ./scripts/restart-linux.sh
```

也可以使用完整管理命令：

```bash
bash ./scripts/manage.sh start
bash ./scripts/manage.sh stop
bash ./scripts/manage.sh restart
bash ./scripts/manage.sh status
bash ./scripts/manage.sh open
bash ./scripts/manage.sh logs
bash ./scripts/manage.sh start --port 8080
bash ./scripts/manage.sh logs --follow
```

脚本运行时文件会保存在 `scripts/.runtime/`，包括 PID 和日志。这个目录由脚本自动创建，已加入 `.gitignore`。

## 目录结构

```text
share-skill/
  public/                  # 前端页面资源
    index.html
    styles.css
    app.js
  server/                  # 共享服务端
    skill_share_server.py
    .data/                 # 自动创建：Skill 数据、评论、备份、临时文件
  scripts/                 # Windows / Linux 管理脚本
    manage.ps1
    manage.sh
    start-windows.cmd
    stop-windows.cmd
    restart-windows.cmd
    start-linux.sh
    stop-linux.sh
    restart-linux.sh
  README.md
  .gitignore
```

## 使用流程

1. 点击“索引我的默认 Skill 目录”。
2. 在文件选择器里选择 `C:\Users\你的用户名\.codex\skills`。
3. 页面会扫描每个包含 `SKILL.md` 的子文件夹，并解析：
   - `name`
   - `description`
   - `version`
   - `tags`
   - `When to Use` / `功能` / `能力` 等章节的功能点
4. 勾选要分享的 Skill，点击“上传选中的 Skill”。
5. 同名上传会更新共享区展示版本，服务端会把旧版本写入备份。
6. 打开 Skill 详情后，可以在评论区补充给同事看的说明。
7. 删除共享区 Skill 时，列表会移除当前版本，服务端仍会保留删除前备份。
8. 安装统一使用 zip：下载压缩包，解压后把整个 Skill 文件夹放到自己的 Codex skills 目录。

## 安装 zip 的正确方式

浏览器不能可靠地“下载文件夹”，因此平台统一下载 zip 压缩包。下载后请先解压，再把整个 Skill 文件夹复制到：

```text
C:\Users\你的用户名\.codex\skills
```

正确结构必须是：

```text
C:\Users\你的用户名\.codex\skills\skill-name\SKILL.md
```

或者用目录树表示：

```text
.codex\skills\
  skill-name\
    SKILL.md
    ...其他文件
```

请注意：不要把 `SKILL.md` 直接放到 `.codex\skills` 根目录，也不要只复制 Skill 文件夹里的部分文件。Codex 需要识别 `skills\某个-skill-文件夹\SKILL.md` 这一层结构。

## 数据、评论与备份

服务端数据默认保存在：

```text
server/.data/
  skills/      # 当前共享区版本，每个 Skill 包含文件、metadata.json、comments.json
  backups/     # 覆盖和删除前的 zip 备份
  tmp/         # 临时文件
```

- 上传同名 Skill：先把旧版本备份到 `server/.data/backups/`，再更新共享区版本。
- 删除 Skill：先把当前版本备份到 `server/.data/backups/`，再从共享列表移除。
- 评论会保存在对应 Skill 的 `comments.json` 里；同名覆盖时会保留已有评论。
- `server/.data/` 已加入 `.gitignore`，不会误提交共享数据。

## 手动启动服务

如果不使用管理脚本，也可以手动启动：

```powershell
python .\server\skill_share_server.py --host 0.0.0.0 --port 5173 --public-dir .\public --data-dir .\server\.data
```

Linux：

```bash
python3 ./server/skill_share_server.py --host 0.0.0.0 --port 5173 --public-dir ./public --data-dir ./server/.data
```

## API 说明

页面已经按以下接口对接。管理脚本启动的服务已完整实现这些接口。

### 健康检查

```http
GET /api/health
```

### 获取共享列表

```http
GET /api/skills
```

返回：

```json
{
  "skills": [
    {
      "id": "frontend-design",
      "name": "frontend-design",
      "description": "Create distinctive frontend interfaces.",
      "version": "1.0.0",
      "tags": ["UI", "前端"],
      "updatedAt": "2026-05-20T08:00:00Z",
      "fileCount": 8,
      "commentCount": 2,
      "downloadUrl": "/api/skills/frontend-design/download"
    }
  ]
}
```

### 上传或覆盖 Skill

```http
POST /api/skills
Content-Type: multipart/form-data
```

字段：

- `name`: Skill 名称
- `metadata`: JSON 字符串，包含名称、简介、版本、标签、Markdown 等
- `manifest`: JSON 字符串，包含每个文件的相对路径、大小、类型
- `files`: 多个文件字段
- `paths`: 与 `files` 对应的相对路径

### 获取详情

```http
GET /api/skills/:id
```

返回单个 Skill，包含 `markdown` 和 `comments` 字段，用于详情预览和评论展示。

### 获取评论

```http
GET /api/skills/:id/comments
```

### 发布评论

```http
POST /api/skills/:id/comments
Content-Type: application/json
```

请求：

```json
{
  "author": "M5Stack Docs Team",
  "body": "这个 Skill 适合整理产品规格、生成售后回复模板，建议和官方文档一起使用。"
}
```

### 下载压缩包

```http
GET /api/skills/:id/download
```

返回 zip 文件。用户需要按页面提示解压到 `C:\Users\你的用户名\.codex\skills\skill-name\SKILL.md` 这种目录结构。

### 从共享区删除

```http
DELETE /api/skills/:id
```

从共享列表移除当前版本，删除前会写入服务端备份。
