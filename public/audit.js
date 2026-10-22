const PAGE_SIZE = 50;

const EVENT_META = {
  upload: { label: "上传", className: "event-upload" },
  update: { label: "更新", className: "event-update" },
  download: { label: "下载", className: "event-download" },
  comment: { label: "评论", className: "event-comment" },
  delete: { label: "删除", className: "event-delete" },
};

const els = {
  serverStatus: document.querySelector("#serverStatus"),
  summary: document.querySelector("#logSummary"),
  form: document.querySelector("#filterForm"),
  event: document.querySelector("#eventFilter"),
  skill: document.querySelector("#skillFilter"),
  range: document.querySelector("#rangeFilter"),
  applyBtn: document.querySelector("#applyBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  body: document.querySelector("#logBody"),
  empty: document.querySelector("#logEmpty"),
  count: document.querySelector("#logCount"),
  prev: document.querySelector("#prevBtn"),
  next: document.querySelector("#nextBtn"),
};

const state = {
  offset: 0,
  total: 0,
  loading: false,
};

init();

function init() {
  els.form.addEventListener("submit", () => {
    state.offset = 0;
    load();
  });
  els.event.addEventListener("change", () => {
    state.offset = 0;
    load();
  });
  els.range.addEventListener("change", () => {
    state.offset = 0;
    load();
  });
  els.refreshBtn.addEventListener("click", () => load());
  els.resetBtn.addEventListener("click", () => {
    els.event.value = "";
    els.skill.value = "";
    els.range.value = "7";
    state.offset = 0;
    load();
  });
  els.prev.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    load();
  });
  els.next.addEventListener("click", () => {
    if (state.offset + PAGE_SIZE < state.total) {
      state.offset += PAGE_SIZE;
      load();
    }
  });
  load();
}

function rangeStart(days) {
  if (days === "all") return "";
  const date = new Date();
  date.setDate(date.getDate() - (Number(days) - 1));
  date.setHours(0, 0, 0, 0);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function buildQuery() {
  const params = new URLSearchParams();
  if (els.event.value) params.set("event", els.event.value);
  const skill = els.skill.value.trim();
  if (skill) params.set("skill", skill);
  const since = rangeStart(els.range.value);
  if (since) params.set("since", since);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(state.offset));
  return params.toString();
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  els.applyBtn.disabled = true;
  els.applyBtn.textContent = "查询中…";

  try {
    const response = await fetch(`/api/audit?${buildQuery()}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setStatus(true);
    state.total = Number(data.total || 0);
    renderSummary(data.summary || {}, state.total);
    renderRows(Array.isArray(data.items) ? data.items : []);
    updatePager();
  } catch (error) {
    setStatus(false);
    els.body.replaceChildren();
    els.empty.hidden = false;
    els.empty.textContent = `日志读取失败：${error.message}。请确认共享服务正在运行。`;
    els.count.textContent = "共 0 条";
    els.prev.disabled = true;
    els.next.disabled = true;
  } finally {
    state.loading = false;
    els.applyBtn.disabled = false;
    els.applyBtn.textContent = "查询";
  }
}

function setStatus(online) {
  els.serverStatus.classList.remove("online", "offline");
  if (online) {
    els.serverStatus.classList.add("online");
    els.serverStatus.textContent = "共享服务已连接";
  } else {
    els.serverStatus.classList.add("offline");
    els.serverStatus.textContent = "共享服务未连接";
  }
}

function renderSummary(summary, total) {
  const order = ["upload", "update", "download", "comment", "delete"];
  els.summary.replaceChildren();
  for (const key of order) {
    const meta = EVENT_META[key];
    if (!meta) continue;
    const item = document.createElement("div");
    item.className = "log-stat";
    const label = document.createElement("span");
    label.textContent = meta.label;
    const value = document.createElement("strong");
    value.textContent = String(summary[key] ?? 0);
    item.append(label, value);
    els.summary.append(item);
  }
  const totalCard = document.createElement("div");
  totalCard.className = "log-stat log-stat--total";
  const totalLabel = document.createElement("span");
  totalLabel.textContent = total === 0 ? "当前筛选" : "筛选结果";
  const totalValue = document.createElement("strong");
  totalValue.textContent = String(total);
  totalCard.append(totalLabel, totalValue);
  els.summary.append(totalCard);
}

function renderRows(items) {
  els.body.replaceChildren();
  if (!items.length) {
    els.empty.hidden = false;
    els.empty.textContent = "这段时间没有记录。换个时间范围或清空筛选再看看。";
    return;
  }
  els.empty.hidden = true;

  for (const item of items) {
    const row = document.createElement("tr");

    const timeCell = document.createElement("td");
    timeCell.className = "log-time";
    timeCell.textContent = formatTime(item.at || item.ts);

    const eventCell = document.createElement("td");
    const badge = document.createElement("span");
    const meta = EVENT_META[item.event] || { label: item.event || "未知", className: "event-other" };
    badge.className = `event-badge ${meta.className}`;
    badge.textContent = meta.label;
    eventCell.append(badge);

    const skillCell = document.createElement("td");
    skillCell.className = "log-skill";
    const skill = item.skill || {};
    skillCell.textContent = skill.name || skill.id || "-";

    const clientCell = document.createElement("td");
    clientCell.className = "log-client";
    clientCell.textContent = describeClient(item.client, item.userAgent);

    const detailCell = document.createElement("td");
    detailCell.className = "log-detail";
    detailCell.textContent = describeDetail(item);

    row.append(timeCell, eventCell, skillCell, clientCell, detailCell);
    els.body.append(row);
  }
}

function updatePager() {
  els.count.textContent = state.total
    ? `共 ${state.total} 条，当前第 ${state.offset + 1}–${Math.min(state.offset + PAGE_SIZE, state.total)} 条`
    : "共 0 条";
  els.prev.disabled = state.offset === 0;
  els.next.disabled = state.offset + PAGE_SIZE >= state.total;
}

function describeClient(client, userAgent) {
  const ip = client || "未知来源";
  const ua = shortUserAgent(userAgent);
  return ua ? `${ip} · ${ua}` : ip;
}

function shortUserAgent(value) {
  const ua = String(value || "");
  if (!ua) return "";
  if (/curl/i.test(ua)) return "curl";
  if (/python-requests/i.test(ua)) return "python";
  if (/node-fetch|undici/i.test(ua)) return "node";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  if (/Firefox\//i.test(ua)) return "Firefox";
  return ua.slice(0, 18);
}

function describeDetail(item) {
  const detail = item.detail || {};
  if (item.event === "download") {
    return [`${formatBytes(detail.size)}`, detail.fileCount ? `${detail.fileCount} 个文件` : ""].filter(Boolean).join(" · ");
  }
  if (item.event === "delete") {
    return detail.backupKept ? "已保留服务端备份" : "未保留备份";
  }
  if (item.event === "comment") {
    const parts = [];
    if (detail.author) parts.push(detail.author);
    if (detail.length) parts.push(`${detail.length} 字`);
    return parts.join(" · ") || "新增评论";
  }
  const parts = [];
  if (detail.fileCount) parts.push(`${detail.fileCount} 个文件`);
  if (detail.size) parts.push(formatBytes(detail.size));
  if (detail.version) parts.push(`v${String(detail.version).replace(/^v/, "")}`);
  if (detail.via) parts.push(detail.via === "zip" ? "zip 上传" : "网页上传");
  return parts.join(" · ") || "-";
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  const stamp = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!stamp || Number.isNaN(stamp)) return "-";
  const date = new Date(stamp);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
