const DEFAULT_SKILL_PATH = "C:\\Users\\你的用户名\\.codex\\skills";
const API_BASE = (window.SKILL_SHARE_API_BASE || localStorage.getItem("skillShareApiBase") || "").replace(/\/$/, "");

const els = {
  serverStatus: document.querySelector("#serverStatus"),
  pickDefaultInlineBtn: document.querySelector("#pickDefaultInlineBtn"),
  defaultSkillsInput: document.querySelector("#defaultSkillsInput"),
  customFolderInput: document.querySelector("#customFolderInput"),
  selectAllLocalBtn: document.querySelector("#selectAllLocalBtn"),
  clearLocalBtn: document.querySelector("#clearLocalBtn"),
  localSummary: document.querySelector("#localSummary"),
  localSkillGrid: document.querySelector("#localSkillGrid"),
  selectedCount: document.querySelector("#selectedCount"),
  uploadSelectedBtn: document.querySelector("#uploadSelectedBtn"),
  sharedSkillGrid: document.querySelector("#sharedSkillGrid"),
  searchInput: document.querySelector("#searchInput"),
  refreshBtn: document.querySelector("#refreshBtn"),
  toastRegion: document.querySelector("#toastRegion"),
  localSkillTemplate: document.querySelector("#localSkillTemplate"),
  sharedSkillTemplate: document.querySelector("#sharedSkillTemplate"),
  dialog: document.querySelector("#skillDialog"),
  closeDialogBtn: document.querySelector("#closeDialogBtn"),
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogDescription: document.querySelector("#dialogDescription"),
  dialogVersion: document.querySelector("#dialogVersion"),
  dialogFileCount: document.querySelector("#dialogFileCount"),
  dialogUpdated: document.querySelector("#dialogUpdated"),
  dialogMarkdown: document.querySelector("#dialogMarkdown"),
  installPathExample: document.querySelector("#installPathExample"),
  installTree: document.querySelector("#installTree"),
  downloadZipBtn: document.querySelector("#downloadZipBtn"),
  deleteSkillBtn: document.querySelector("#deleteSkillBtn"),
  commentCount: document.querySelector("#commentCount"),
  commentsList: document.querySelector("#commentsList"),
  commentForm: document.querySelector("#commentForm"),
  commentAuthor: document.querySelector("#commentAuthor"),
  commentBody: document.querySelector("#commentBody"),
};

const state = {
  backendOnline: false,
  localSkills: [],
  sharedSkills: [],
  selectedLocalIds: new Set(),
  activeSkill: null,
  search: "",
};

init();

function init() {
  bindEvents();
  loadSharedSkills();
}

function bindEvents() {
  els.pickDefaultInlineBtn.addEventListener("click", () => els.defaultSkillsInput.click());

  els.defaultSkillsInput.addEventListener("change", (event) => handleFolderInput(event, "default"));
  els.customFolderInput.addEventListener("change", (event) => handleFolderInput(event, "custom"));

  els.selectAllLocalBtn.addEventListener("click", toggleSelectAllLocal);
  els.clearLocalBtn.addEventListener("click", clearLocalSkills);
  els.uploadSelectedBtn.addEventListener("click", uploadSelectedSkills);
  els.refreshBtn.addEventListener("click", loadSharedSkills);
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderSharedSkills();
  });

  els.closeDialogBtn.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });

  els.downloadZipBtn.addEventListener("click", downloadActiveSkill);
  els.commentForm.addEventListener("submit", submitComment);
  els.deleteSkillBtn.addEventListener("click", () => {
    if (state.activeSkill) deleteSharedSkill(state.activeSkill);
  });

  const savedAuthor = localStorage.getItem("skillShareCommentAuthor");
  if (savedAuthor) els.commentAuthor.value = savedAuthor;
}

async function loadSharedSkills() {
  setServerStatus("connecting");
  try {
    const response = await fetch(apiUrl("/api/skills"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const skills = Array.isArray(payload) ? payload : payload.skills || [];
    state.sharedSkills = skills.map(normalizeSharedSkill);
    state.backendOnline = true;
    setServerStatus("online");
  } catch (error) {
    state.backendOnline = false;
    setServerStatus("offline");
    if (!state.sharedSkills.length) state.sharedSkills = [];
    toast("共享服务未连接。请通过 scripts 里的管理脚本启动完整服务。", "warning");
  }
  renderSharedSkills();
  updateSelectedCount();
}

async function handleFolderInput(event, source) {
  const input = event.target;
  const files = Array.from(input.files || []);
  input.value = "";

  if (!files.length) return;

  try {
    const scanned = await scanSkillFolders(files, source);
    if (!scanned.length) {
      toast("没有找到 SKILL.md。请确认选择的是 Skill 文件夹或 .codex\\skills 目录。", "warning");
      return;
    }

    mergeLocalSkills(scanned);
    renderLocalSkills();
    toast(`已解析 ${scanned.length} 个 Skill，可勾选后上传。`);
  } catch (error) {
    console.error(error);
    toast("解析文件夹失败，请确认浏览器允许读取所选目录。", "warning");
  }
}

async function scanSkillFolders(files, source) {
  const normalizedFiles = files.map((file) => ({
    file,
    fullPath: normalizePath(file.webkitRelativePath || file.name),
  }));

  const roots = normalizedFiles
    .filter((entry) => basename(entry.fullPath).toLowerCase() === "skill.md")
    .map((entry) => dirname(entry.fullPath));

  const uniqueRoots = Array.from(new Set(roots)).sort((a, b) => a.length - b.length);
  const skills = [];

  for (const root of uniqueRoots) {
    const rootFiles = normalizedFiles
      .filter((entry) => entry.fullPath === root || entry.fullPath.startsWith(`${root}/`))
      .map((entry) => ({
        file: entry.file,
        relativePath: stripRoot(entry.fullPath, root),
      }))
      .filter((entry) => entry.relativePath);

    const skillFile = rootFiles.find((entry) => entry.relativePath.toLowerCase() === "skill.md");
    if (!skillFile) continue;

    const markdown = await skillFile.file.text();
    const parsed = parseSkillMarkdown(markdown, basename(root));
    const filesCount = rootFiles.length;
    const bytes = rootFiles.reduce((total, entry) => total + entry.file.size, 0);

    skills.push({
      id: `local-${hashString(`${root}-${parsed.name}-${Date.now()}`)}`,
      name: parsed.name,
      folderName: basename(root),
      description: parsed.description,
      version: parsed.version,
      tags: parsed.tags,
      markdown,
      source,
      sourcePath: root,
      files: rootFiles,
      fileCount: filesCount,
      size: bytes,
      updatedAt: new Date().toISOString(),
    });
  }

  return skills;
}

function mergeLocalSkills(skills) {
  for (const skill of skills) {
    const existingIndex = state.localSkills.findIndex(
      (item) => item.name.toLowerCase() === skill.name.toLowerCase(),
    );
    if (existingIndex >= 0) {
      state.localSkills.splice(existingIndex, 1, skill);
    } else {
      state.localSkills.push(skill);
    }
    state.selectedLocalIds.add(skill.id);
  }
}

function renderLocalSkills() {
  els.localSkillGrid.replaceChildren();

  if (!state.localSkills.length) {
    els.localSummary.innerHTML = `
      <span>还没有索引本机 Skill。</span>
      <button class="text-button" id="pickDefaultAgainBtn" type="button">现在选择默认目录</button>
    `;
    els.localSummary.querySelector("#pickDefaultAgainBtn").addEventListener("click", () => els.defaultSkillsInput.click());
  } else {
    const totalFiles = state.localSkills.reduce((sum, skill) => sum + skill.fileCount, 0);
    els.localSummary.innerHTML = `<span>已索引 <strong>${state.localSkills.length}</strong> 个 Skill，共 <strong>${totalFiles}</strong> 个文件。</span><span>可继续选择目录追加扫描。</span>`;
  }

  for (const skill of state.localSkills) {
    const node = els.localSkillTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = node.querySelector("input");
    checkbox.checked = state.selectedLocalIds.has(skill.id);
    node.classList.toggle("selected", checkbox.checked);
    node.querySelector(".local-name").textContent = skill.name;
    node.querySelector(".local-desc").textContent = skill.description || "没有简介，上传前建议在 SKILL.md 里补充 description。";
    renderTags(node.querySelector(".tag-row"), [
      skill.source === "default" ? "默认目录" : "自选目录",
      `${skill.fileCount} 个文件`,
      ...skill.tags,
    ]);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedLocalIds.add(skill.id);
      else state.selectedLocalIds.delete(skill.id);
      renderLocalSkills();
    });

    els.localSkillGrid.append(node);
  }

  updateSelectedCount();
}

function updateSelectedCount() {
  const selected = state.localSkills.filter((skill) => state.selectedLocalIds.has(skill.id));
  els.selectedCount.textContent = `已选择 ${selected.length} 个 Skill`;
  els.uploadSelectedBtn.disabled = selected.length === 0 || !state.backendOnline;
  els.selectAllLocalBtn.textContent = selected.length === state.localSkills.length && state.localSkills.length
    ? "取消全选"
    : "全选";
}

function toggleSelectAllLocal() {
  if (!state.localSkills.length) return;
  const allSelected = state.localSkills.every((skill) => state.selectedLocalIds.has(skill.id));
  if (allSelected) state.selectedLocalIds.clear();
  else state.localSkills.forEach((skill) => state.selectedLocalIds.add(skill.id));
  renderLocalSkills();
}

function clearLocalSkills() {
  state.localSkills = [];
  state.selectedLocalIds.clear();
  renderLocalSkills();
}

async function uploadSelectedSkills() {
  const selected = state.localSkills.filter((skill) => state.selectedLocalIds.has(skill.id));
  if (!selected.length) return;
  if (!state.backendOnline) {
    toast("共享服务未连接，暂时无法上传。请先启动服务后再试。", "warning");
    return;
  }

  els.uploadSelectedBtn.disabled = true;
  els.uploadSelectedBtn.textContent = "上传中...";

  let success = 0;
  let failed = 0;

  for (const skill of selected) {
    try {
      const uploaded = await uploadSkillToBackend(skill);
      addOrReplaceSharedSkill(normalizeSharedSkill(uploaded));
      success += 1;
    } catch (error) {
      console.error(error);
      failed += 1;
    }
  }

  renderSharedSkills();
  els.uploadSelectedBtn.textContent = "上传选中的 Skill";
  updateSelectedCount();

  if (failed) {
    toast(`已上传 ${success} 个 Skill，${failed} 个上传失败。请查看服务日志后重试。`, "warning");
  } else {
    toast(`已上传 ${success} 个 Skill。同名内容已更新，服务端已保留历史备份。`);
  }
}

async function uploadSkillToBackend(skill) {
  const formData = new FormData();
  const metadata = {
    name: skill.name,
    folderName: skill.folderName,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    markdown: skill.markdown,
    fileCount: skill.fileCount,
    size: skill.size,
  };

  formData.append("name", skill.name);
  formData.append("metadata", JSON.stringify(metadata));
  formData.append("manifest", JSON.stringify(skill.files.map((entry) => ({
    path: entry.relativePath,
    size: entry.file.size,
    type: entry.file.type || "application/octet-stream",
  }))));

  for (const entry of skill.files) {
    formData.append("files", entry.file, entry.relativePath);
    formData.append("paths", entry.relativePath);
  }

  const response = await fetch(apiUrl("/api/skills"), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const payload = await response.json().catch(() => null);
  return payload?.skill || payload || metadata;
}

function toLocalSharedSkill(skill) {
  return {
    id: `demo-${slugify(skill.name)}`,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    markdown: skill.markdown,
    updatedAt: new Date().toISOString(),
    fileCount: skill.fileCount,
    commentCount: 0,
    comments: [],
    files: skill.files,
    localOnly: true,
  };
}

function addOrReplaceSharedSkill(skill) {
  const normalizedName = skill.name.toLowerCase();
  state.sharedSkills = [
    skill,
    ...state.sharedSkills.filter((item) => item.name.toLowerCase() !== normalizedName),
  ];
}

function renderSharedSkills() {
  els.sharedSkillGrid.replaceChildren();

  const filtered = state.sharedSkills.filter((skill) => {
    if (!state.search) return true;
    const haystack = [
      skill.name,
      skill.description,
      skill.version,
      ...(skill.tags || []),
    ].join(" ").toLowerCase();
    return haystack.includes(state.search);
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = !state.backendOnline
      ? "共享服务未连接。请先运行管理脚本启动服务，然后点击刷新。"
      : state.search
      ? "没有搜到匹配的 Skill。换个关键词试试。"
      : "共享区还是空的。先从上方索引本机目录并上传一个 Skill。";
    els.sharedSkillGrid.append(empty);
    return;
  }

  for (const skill of filtered) {
    const node = els.sharedSkillTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".skill-initial").textContent = skill.name.slice(0, 1) || "S";
    node.querySelector("h3").textContent = skill.name;
    node.querySelector("p").textContent = skill.description || "暂无简介。";
    node.querySelector(".updated-text").textContent = formatDate(skill.updatedAt);
    node.querySelector(".comment-badge").textContent = `${skill.commentCount || 0} 条评论`;
    renderTags(node.querySelector(".tag-row"), [
      skill.localOnly ? "临时预览" : "共享",
      skill.version ? `v${skill.version}` : null,
      ...(skill.tags || []),
    ]);

    node.querySelector(".view-btn").addEventListener("click", () => openSkillDialog(skill));
    node.querySelector(".delete-card-btn").addEventListener("click", () => deleteSharedSkill(skill));
    els.sharedSkillGrid.append(node);
  }
}

async function openSkillDialog(skill) {
  const detailedSkill = await loadSkillDetail(skill);
  state.activeSkill = detailedSkill;

  els.dialogTitle.textContent = detailedSkill.name;
  els.dialogDescription.textContent = detailedSkill.description || "暂无简介。";
  els.dialogVersion.textContent = detailedSkill.version || "-";
  els.dialogFileCount.textContent = detailedSkill.fileCount ? `${detailedSkill.fileCount} 个` : "-";
  els.dialogUpdated.textContent = formatDate(detailedSkill.updatedAt);
  els.dialogMarkdown.innerHTML = renderMarkdown(detailedSkill.markdown || "# 暂无 SKILL.md 内容\n\n共享服务未返回 Markdown 内容。");
  updateInstallGuide(detailedSkill);
  renderComments(detailedSkill.comments || []);

  if (typeof els.dialog.showModal === "function") {
    els.dialog.showModal();
  } else {
    alert("你的浏览器版本过旧，无法打开弹窗。请升级浏览器。");
  }
}

async function loadSkillDetail(skill) {
  if (skill.localOnly || skill.markdown) return skill;

  try {
    const response = await fetch(apiUrl(`/api/skills/${encodeURIComponent(skill.id || skill.name)}`), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return normalizeSharedSkill(payload.skill || payload);
  } catch (error) {
    console.warn("Cannot load skill detail", error);
    return skill;
  }
}

function renderComments(comments) {
  const normalized = Array.isArray(comments) ? comments : [];
  els.commentCount.textContent = normalized.length;
  els.commentsList.replaceChildren();

  if (!normalized.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "还没有评论。可以补充这个 Skill 的适用场景、使用方法或注意事项。";
    els.commentsList.append(empty);
    return;
  }

  for (const comment of normalized) {
    const item = document.createElement("article");
    item.className = "comment-item";
    item.innerHTML = `
      <header>
        <strong>${escapeHtml(comment.author || "M5Stack 同事")}</strong>
        <time>${escapeHtml(formatDate(comment.createdAt))}</time>
      </header>
      <p>${escapeHtml(comment.body || "")}</p>
    `;
    els.commentsList.append(item);
  }
}

async function submitComment(event) {
  event.preventDefault();
  const skill = state.activeSkill;
  if (!skill) return;
  if (!state.backendOnline || skill.localOnly) {
    toast("共享服务未连接，暂时无法发布评论。", "warning");
    return;
  }

  const author = els.commentAuthor.value.trim() || "M5Stack 同事";
  const body = els.commentBody.value.trim();
  if (!body) {
    toast("请先填写评论内容。", "warning");
    return;
  }

  const submitButton = els.commentForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "发布中...";

  try {
    const response = await fetch(apiUrl(`/api/skills/${encodeURIComponent(skill.id || skill.name)}/comments`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author, body }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const comments = payload.comments || [];
    state.activeSkill = {
      ...state.activeSkill,
      comments,
      commentCount: payload.commentCount ?? comments.length,
    };
    localStorage.setItem("skillShareCommentAuthor", author);
    els.commentBody.value = "";
    renderComments(comments);
    updateSharedSkillCommentCount(state.activeSkill.id || state.activeSkill.name, state.activeSkill.commentCount);
    toast("评论已发布。");
  } catch (error) {
    console.error(error);
    toast("评论发布失败，请确认共享服务正常运行。", "warning");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "发布评论";
  }
}

function updateSharedSkillCommentCount(skillId, count) {
  state.sharedSkills = state.sharedSkills.map((skill) => {
    if ((skill.id || skill.name) !== skillId && skill.name !== skillId) return skill;
    return { ...skill, commentCount: count };
  });
  renderSharedSkills();
}

async function deleteSharedSkill(skill) {
  if (!state.backendOnline && !skill.localOnly) {
    toast("共享服务未连接，暂时无法删除。请启动服务后再试。", "warning");
    return;
  }

  const ok = confirm(`确认从共享区删除「${skill.name}」吗？\n\n共享列表会移除这个 Skill，服务端备份仍然保留。`);
  if (!ok) return;

  try {
    if (state.backendOnline && !skill.localOnly) {
      const response = await fetch(apiUrl(`/api/skills/${encodeURIComponent(skill.id || skill.name)}`), {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }

    state.sharedSkills = state.sharedSkills.filter((item) => (item.id || item.name) !== (skill.id || skill.name));
    renderSharedSkills();
    if (els.dialog.open) els.dialog.close();
    toast("已从共享区删除。服务端备份仍保留，可找管理员恢复。");
  } catch (error) {
    console.error(error);
    toast("删除失败：共享服务没有确认删除。请刷新后重试。", "warning");
  }
}

function downloadActiveSkill() {
  const skill = state.activeSkill;
  if (!skill) return;

  toast("下载后请按左侧安装结构解压到 .codex\\skills。");

  if (!skill.localOnly) {
    window.location.href = skill.downloadUrl
      ? apiUrl(skill.downloadUrl)
      : apiUrl(`/api/skills/${encodeURIComponent(skill.id || skill.name)}/download`);
    return;
  }

  const markdown = skill.markdown || "# Skill\n";
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${safePathPart(skill.name)}-SKILL.md`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("当前是临时预览，仅下载 SKILL.md；连接共享服务后可下载完整压缩包。", "warning");
}

function updateInstallGuide(skill) {
  const folderName = safePathPart(skill.folderName || skill.name);
  const path = `${DEFAULT_SKILL_PATH}\\${folderName}\\SKILL.md`;
  const tree = `.codex\\skills\\\n  ${folderName}\\\n    SKILL.md\n    ...其他文件`;
  els.installPathExample.textContent = path;
  els.installTree.textContent = tree;
}

function parseSkillMarkdown(markdown, fallbackName) {
  const frontmatter = parseFrontmatter(markdown);
  const body = stripFrontmatter(markdown);
  const headingName = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstParagraph = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("|"));

  const name = cleanScalar(frontmatter.name) || headingName || fallbackName || "未命名 Skill";
  const description = cleanScalar(frontmatter.description)
    || summarizeText(firstParagraph)
    || "这个 Skill 暂时没有简介。";
  const version = cleanScalar(frontmatter.version) || "";
  const tags = extractTags(markdown, frontmatter);

  return { name, description, version, tags };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  return match[1].split(/\r?\n/).reduce((result, line) => {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) return result;
    result[item[1]] = item[2].trim();
    return result;
  }, {});
}

function extractTags(markdown, frontmatter) {
  const tags = [];
  const rawTags = cleanScalar(frontmatter.tags || frontmatter.tag || "");
  if (rawTags) {
    tags.push(...rawTags.replace(/^\[|\]$/g, "").split(/[,，]/).map((item) => item.trim()));
  }

  const section = getUsefulSection(markdown);
  const bulletTags = section
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/[`*_]/g, "").trim())
    .map((line) => line.split(/[。.!；;，,]/)[0])
    .filter(Boolean);
  tags.push(...bulletTags);

  if (!tags.length) {
    const headings = Array.from(markdown.matchAll(/^##+\s+(.+)$/gm))
      .map((match) => match[1].replace(/[`*_]/g, "").trim())
      .filter((heading) => !/overview|quick reference|workflow|security/i.test(heading));
    tags.push(...headings);
  }

  return Array.from(new Set(tags.filter(Boolean))).slice(0, 4).map((tag) => truncate(tag, 18));
}

function getUsefulSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^##+\s+(When to Use|功能|能力|适用|Capabilities|Usage)/i.test(line.trim()));
  if (startIndex === -1) return markdown;

  const collected = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##+\s+/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join("\n");
}

function renderMarkdown(markdown) {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  let codeBuffer = [];

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s*(.+)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  if (codeBuffer.length) html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  return html.join("");
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function normalizeSharedSkill(skill) {
  const metadata = skill.metadata || {};
  const name = skill.name || metadata.name || skill.folderName || "未命名 Skill";
  return {
    id: skill.id || skill.slug || name,
    name,
    folderName: skill.folderName || metadata.folderName || name,
    description: skill.description || metadata.description || skill.summary || "暂无简介。",
    version: skill.version || metadata.version || "",
    tags: Array.isArray(skill.tags) ? skill.tags : Array.isArray(metadata.tags) ? metadata.tags : [],
    markdown: skill.markdown || metadata.markdown || skill.readme || "",
    updatedAt: skill.updatedAt || skill.updated_at || metadata.updatedAt || new Date().toISOString(),
    fileCount: skill.fileCount || skill.file_count || metadata.fileCount || 0,
    commentCount: skill.commentCount || skill.comment_count || metadata.commentCount || 0,
    comments: Array.isArray(skill.comments) ? skill.comments : [],
    downloadUrl: skill.downloadUrl || skill.download_url || "",
    localOnly: Boolean(skill.localOnly),
    files: skill.files,
  };
}

function renderTags(container, tags) {
  container.replaceChildren();
  tags.filter(Boolean).slice(0, 5).forEach((tag) => {
    const pill = document.createElement("span");
    pill.className = "tag";
    pill.textContent = tag;
    container.append(pill);
  });
}

function setServerStatus(status) {
  els.serverStatus.classList.remove("online", "offline");
  if (status === "online") {
    els.serverStatus.classList.add("online");
    els.serverStatus.textContent = "共享服务已连接";
  } else if (status === "offline") {
    els.serverStatus.classList.add("offline");
    els.serverStatus.textContent = "共享服务未连接";
  } else {
    els.serverStatus.textContent = "正在连接共享服务...";
  }
}

function toast(message, tone = "default") {
  const node = document.createElement("div");
  node.className = `toast ${tone === "warning" ? "warning" : ""}`;
  node.textContent = message;
  els.toastRegion.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(8px)";
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function basename(path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.at(-1) || "";
}

function dirname(path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function stripRoot(path, root) {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot) return normalizedPath;
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
}

function safePathPart(text) {
  return String(text || "skill")
    .replace(/[<>:"\\|?*\x00-\x1F]/g, "-")
    .replace(/\.+$/g, "")
    .trim() || "skill";
}

function hashString(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function cleanScalar(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").trim();
}

function summarizeText(text) {
  if (!text) return "";
  return truncate(text.replace(/[#>*`_-]/g, "").replace(/\s+/g, " ").trim(), 110);
}

function truncate(text, limit) {
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
