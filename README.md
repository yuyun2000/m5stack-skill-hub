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
http://192.168.20.69:1885
```

同一局域网的同事打开这个地址即可使用。

## 一键管理脚本

默认监听 `0.0.0.0:1885`，方便局域网访问。

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
  skills/      # 当前共享区版本，每个 Skill 包含文件、metadata.json、comments.json、history.json
  backups/     # 覆盖和删除前的 zip 备份
  tmp/         # 临时文件
```

- 上传同名 Skill：先把旧版本备份到 `server/.data/backups/`，再更新共享区版本。
- 删除 Skill：先把当前版本备份到 `server/.data/backups/`，再从共享列表移除。
- 评论会保存在对应 Skill 的 `comments.json` 里；同名覆盖时会保留已有评论。
- 更新记录会保存在对应 Skill 的 `history.json` 里；同名覆盖时会追加一条更新历史。
- `server/.data/` 已加入 `.gitignore`，不会误提交共享数据。

## 手动启动服务

如果不使用管理脚本，也可以手动启动：

```powershell
python .\server\skill_share_server.py --host 0.0.0.0 --port 1885 --public-dir .\public --data-dir .\server\.data
```

Linux：

```bash
python3 ./server/skill_share_server.py --host 0.0.0.0 --port 1885 --public-dir ./public --data-dir ./server/.data
```

## API 说明

页面已经按以下接口对接。管理脚本启动的服务已完整实现这些接口。

### Codex / Agent 自助发现

只需要把共享站首页地址告诉 Codex。首页 HTML 已内嵌机器可读入口，Codex 可以按以下顺序自行发现能力：

```text
GET /llms.txt                    # Agent 操作指南，并附当前 Skill 摘要
GET /api/manifest               # 服务能力与工作流清单
GET /api/openapi.json           # OpenAPI 3.1 接口描述
GET /.well-known/skill-share.json
GET /api/skills                 # 实时 Skill 资源目录
```

推荐直接告诉 Codex：

```text
访问 http://共享站地址:1885/llms.txt，读取实时 Skill 目录和接口说明，
根据我的请求自行下载或上传 Skill；不要删除任何 Skill，除非我明确确认。
```

服务默认没有登录鉴权，只能部署在可信局域网中，不要映射到公网。

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
  "apiVersion": "1.1",
  "count": 1,
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
      "updateCount": 3,
      "latestUpdate": {
        "action": "updated",
        "at": "2026-05-20T08:00:00Z",
        "version": "1.0.0"
      },
      "downloadUrl": "/api/skills/frontend-design/download",
      "detailUrl": "/api/skills/frontend-design",
      "filesUrl": "/api/skills/frontend-design/files"
    }
  ],
  "links": {
    "upload": "/api/skills/upload",
    "agentGuide": "/llms.txt",
    "openapi": "/api/openapi.json"
  }
}
```

### Codex 上传 zip（推荐）

压缩包必须只包含一个 Skill，并保持 `skill-name/SKILL.md` 结构：

```http
POST /api/skills/upload
Content-Type: multipart/form-data
```

multipart 字段：

- `archive`: 必填，Skill zip 文件
- `name`: 可选，覆盖从 `SKILL.md` 解析出的名称
- `folderName`: 可选，指定下载包顶层目录名
- `metadata`: 可选，JSON 字符串

PowerShell / Codex 示例：

```powershell
$skill = "C:\Users\你的用户名\.codex\skills\skill-name"
$zip = Join-Path $env:TEMP "skill-name.zip"
Compress-Archive -LiteralPath $skill -DestinationPath $zip -Force
curl.exe -X POST "http://共享站地址:1885/api/skills/upload" -F "archive=@$zip"
```

也可以直接发送 zip 字节：

```http
POST /api/skills/upload
Content-Type: application/zip
X-Skill-Name: skill-name
X-Skill-Folder: skill-name
```

服务会拒绝路径穿越、符号链接、加密条目、多个顶层 Skill，以及超过文件数或解压大小限制的压缩包。同名上传会先备份旧版本，再更新共享版本。

### 浏览器多文件上传（兼容接口）

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

返回单个 Skill，包含 `markdown`、`comments` 和 `updateHistory` 字段，用于详情预览、评论展示和更新历史展示。

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

返回只包含可安装 Skill 文件的 zip。用户或 Codex 需要按页面提示解压到 `C:\Users\你的用户名\.codex\skills\skill-name\SKILL.md` 这种目录结构；评论、更新历史等平台数据不会混入安装包。

### 从共享区删除

```http
DELETE /api/skills/:id
```

从共享列表移除当前版本，删除前会写入服务端备份。
