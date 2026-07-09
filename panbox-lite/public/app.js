const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  pollTimer: null,
  scanSession: null,
  scanTimer: null,
  selectedScanDrive: "quark",
  driveStack: [{ fid: "0", name: "根目录" }],
  driveItems: [],
  targetFolder: { fid: "0", name: "根目录" },
  selectedItems: new Map(),
  lastResults: [],
  resultTypes: new Map(),
};

function todayFolder() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `PanBoxLite-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function setHint(text, isError = false) {
  $("accountHint").textContent = text;
  $("accountHint").style.color = isError ? "#c24135" : "#667085";
}

function setScanHint(text, isError = false) {
  $("scanHint").textContent = text;
  $("scanHint").style.color = isError ? "#c24135" : "#667085";
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function renderAccounts() {
  const select = $("accountSelect");
  const list = $("accountList");
  select.innerHTML = "";
  list.innerHTML = "";
  if (!state.accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "还没有账号";
    select.appendChild(option);
    list.innerHTML = '<div class="empty">还没有账号，先扫码添加一个。</div>';
    return;
  }
  state.accounts.forEach((account, index) => {
    const option = document.createElement("option");
    option.value = account.id;
    const status = account.status === "ok" ? "可用" : account.status === "failed" ? "异常" : "未测试";
    const driveName = { quark: "夸克", baidu: "百度", ali: "阿里", xunlei: "迅雷" }[account.driveType] || account.driveType;
    option.textContent = `${driveName} · ${account.name || account.nickname || "账号"} · ${status}`;
    select.appendChild(option);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `account-card ${index === 0 ? "active" : ""}`;
    card.dataset.accountId = account.id;
    card.innerHTML = `
      <span class="account-no">账号${index + 1}</span>
      <span>
        <span class="account-title">${escapeHtml(account.name || account.nickname || `${driveName}网盘`)}</span>
        <span class="account-sub">${driveName} · ${status}</span>
      </span>
      <span class="account-sub">${account.hasCookie ? "已登录" : "未登录"}</span>
    `;
    card.addEventListener("click", () => selectAccount(account.id, true));
    list.appendChild(card);
  });
}

function selectAccount(accountId, shouldLoadDrive = false) {
  $("accountSelect").value = accountId;
  const account = state.accounts.find((item) => item.id === accountId);
  $("renameAccountInput").value = account ? (account.name || account.nickname || "") : "";
  document.querySelectorAll(".account-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.accountId === accountId);
  });
  state.driveStack = [{ fid: "0", name: "根目录" }];
  state.targetFolder = { fid: "0", name: "根目录" };
  state.driveItems = [];
  state.selectedItems.clear();
  renderDrive();
  if (shouldLoadDrive) loadDrive().catch((e) => renderDriveError(e.message));
}

function currentDriveFolder() {
  return state.driveStack[state.driveStack.length - 1] || { fid: "0", name: "根目录" };
}

function formatSize(size) {
  const n = Number(size || 0);
  if (!n) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderDrive() {
  $("drivePathText").textContent = `保存位置：${state.targetFolder.name}`;
  $("selectedLine").textContent = `已选 ${state.selectedItems.size} 项`;
  $("driveBreadcrumb").innerHTML = state.driveStack.map((item, index) => {
    const cls = index === state.driveStack.length - 1 ? "crumb active" : "crumb";
    return `<button class="${cls}" type="button" data-crumb="${index}">${escapeHtml(item.name)}</button>`;
  }).join("");
  document.querySelectorAll("[data-crumb]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.crumb);
      state.driveStack = state.driveStack.slice(0, index + 1);
      loadDrive().catch((e) => renderDriveError(e.message));
    });
  });

  const box = $("driveList");
  if (!state.driveItems.length) {
    box.innerHTML = '<div class="empty">这个目录里没有文件</div>';
    return;
  }
  box.innerHTML = state.driveItems.map((item) => {
    const icon = item.dir ? "📁" : "📄";
    const checked = state.selectedItems.has(item.fid) ? "checked" : "";
    const openAttr = item.dir ? `data-row-open="${escapeAttr(item.fid)}"` : "";
    return `<div class="drive-item ${item.dir ? "clickable" : ""}" ${openAttr}>
      <label class="drive-check"><input type="checkbox" data-select="${escapeAttr(item.fid)}" ${checked}></label>
      <div class="drive-icon">${icon}</div>
      <div class="drive-name">${escapeHtml(item.name)}</div>
      <div class="drive-meta">${item.dir ? "文件夹" : formatSize(item.size)}</div>
      <div class="drive-meta">${item.dir ? "点击进入" : ""}</div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-row-open]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("input")) return;
      const fid = row.dataset.rowOpen;
      const item = state.driveItems.find((entry) => entry.fid === fid);
      if (!item) return;
      state.driveStack.push({ fid: item.fid, name: item.name });
      state.selectedItems.clear();
      loadDrive().catch((e) => renderDriveError(e.message));
    });
  });
  document.querySelectorAll("[data-select]").forEach((input) => {
    input.addEventListener("change", () => {
      const fid = input.dataset.select;
      const item = state.driveItems.find((entry) => entry.fid === fid);
      if (!item) return;
      if (input.checked) state.selectedItems.set(fid, item);
      else state.selectedItems.delete(fid);
      $("selectedLine").textContent = `已选 ${state.selectedItems.size} 项`;
    });
  });
}

function renderDriveError(message) {
  $("driveList").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function renderJob(job) {
  if (!job) {
    $("runtimeStatus").textContent = "空闲";
    return;
  }
  $("runtimeStatus").textContent = job.status === "running" ? "运行中" : job.status;
  const totals = job.totals || {};
  for (const key of ["totalLinks", "previewed", "savedLinks", "shared", "failed"]) {
    $(key).textContent = totals[key] || 0;
  }

  const logs = job.logs || [];
  $("logBox").innerHTML = logs.map((line) => {
    const text = `[${line.at.slice(11, 19)}] ${line.message}`;
    return `<div class="log-line ${line.level}">${escapeHtml(text)}</div>`;
  }).join("");
  $("logBox").scrollTop = $("logBox").scrollHeight;

  const rows = job.results || [];
  state.lastResults = rows;
  rows.forEach((row) => {
    if (row.shareUrl && !state.resultTypes.has(row.shareUrl)) {
      const name = row.name || "";
      state.resultTypes.set(row.shareUrl, row.kind || (/(^|[\s:：,，;；【\[])(新增|新加|增|新课|🆕)(?=$|[\s:：,，;；】\]])/i.test(name) ? "new" : "update"));
    }
  });
  const tbody = $("resultRows");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">还没有任务结果</td></tr>';
  } else {
    tbody.innerHTML = rows.map((row) => {
      const link = row.shareUrl
        ? `<div class="share-cell"><b>${escapeHtml(row.name || "分享链接")}</b><a href="${escapeAttr(row.shareUrl)}" target="_blank">${escapeHtml(row.shareUrl)}</a></div>`
        : "";
      const typeSelect = row.shareUrl
        ? `<select class="type-select" data-type-url="${escapeAttr(row.shareUrl)}">
            <option value="update" ${state.resultTypes.get(row.shareUrl) === "update" ? "selected" : ""}>更新</option>
            <option value="new" ${state.resultTypes.get(row.shareUrl) === "new" ? "selected" : ""}>新增</option>
          </select>`
        : "";
      return `<tr>
        <td>${escapeHtml(row.name || "-")}</td>
        <td>${escapeHtml(row.saveStatus || "-")}</td>
        <td>${escapeHtml(row.shareStatus || "-")} ${typeSelect}</td>
        <td>${link}</td>
        <td>${escapeHtml(row.error || "")}</td>
      </tr>`;
    }).join("");
    document.querySelectorAll("[data-type-url]").forEach((select) => {
      select.addEventListener("change", () => {
        state.resultTypes.set(select.dataset.typeUrl, select.value);
      });
    });
  }

  if (job.exportFile) {
    $("exportLink").classList.remove("hidden");
    $("exportLink").href = job.exportFile;
  } else {
    $("exportLink").classList.add("hidden");
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", "");
}

async function refresh() {
  const data = await api("/api/state");
  state.accounts = data.accounts || [];
  renderAccounts();
  renderJob(data.activeJob);
}

async function loadDrive() {
  const accountId = $("accountSelect").value;
  if (!accountId) return renderDriveError("请先选择账号。");
  const folder = currentDriveFolder();
  $("driveList").innerHTML = '<div class="empty">正在读取网盘内容...</div>';
  const data = await api(`/api/accounts/${accountId}/files?pdirFid=${encodeURIComponent(folder.fid)}`);
  state.driveItems = data.items || [];
  state.selectedItems.clear();
  renderDrive();
}

async function createFolder() {
  const accountId = $("accountSelect").value;
  if (!accountId) return renderDriveError("请先选择账号。");
  const name = $("newFolderName").value.trim();
  if (!name) return renderDriveError("请输入新文件夹名称。");
  const folder = currentDriveFolder();
  const data = await api(`/api/accounts/${accountId}/folders`, {
    method: "POST",
    body: { parentFid: folder.fid, name },
  });
  $("newFolderName").value = "";
  state.driveStack.push({ fid: data.folder.fid, name: data.folder.name });
  state.targetFolder = { fid: data.folder.fid, name: data.folder.name };
  await loadDrive();
}

function selectTargetFolder() {
  const folder = currentDriveFolder();
  state.targetFolder = { fid: folder.fid, name: folder.name };
  $("drivePathText").textContent = `保存位置：${state.targetFolder.name}`;
  $("targetFolderName").value = todayFolder();
}

function selectAllDriveItems() {
  state.driveItems.forEach((item) => state.selectedItems.set(item.fid, item));
  renderDrive();
}

function clearSelectedDriveItems() {
  state.selectedItems.clear();
  renderDrive();
}

async function previewLinks() {
  const data = await api("/api/preview-links", {
    method: "POST",
    body: { linksText: $("linksText").value },
  });
  const updates = (data.entries || []).filter((entry) => entry.kind !== "new").length;
  const news = (data.entries || []).filter((entry) => entry.kind === "new").length;
  const typeText = data.count ? `更新 ${updates} · 新增 ${news}` : "0 个可保存";
  $("linkCount").textContent = data.ignoredCount
    ? `${typeText} · 忽略 ${data.ignoredCount}`
    : typeText;
}

async function addAccount() {
  const name = $("accountName").value.trim();
  const cookie = $("accountCookie").value.trim();
  const driveType = $("manualDriveType").value;
  if (!cookie) return setHint("请先粘贴 Cookie。", true);
  const data = await api("/api/accounts", {
    method: "POST",
    body: { name, cookie, driveType },
  });
  $("accountCookie").value = "";
  setHint(`已添加到本地：${data.cookiePreview}`);
  await refresh();
}

async function startScanLogin(driveType = state.selectedScanDrive) {
  const data = await api("/api/scan-login/start", {
    method: "POST",
    body: { driveType },
  });
  state.scanSession = data.session;
  $("scanActions").classList.remove("hidden");
  $("scanAccountName").value = `${data.session.providerName}扫码账号`;
  setScanHint(`已打开 ${data.session.providerName} 官方登录窗口。扫码进入网盘首页后，点“我已扫码，保存账号”。`);
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = setInterval(pollScanStatus, 1500);
}

async function pollScanStatus() {
  if (!state.scanSession) return;
  try {
    const data = await api(`/api/scan-login/${state.scanSession.id}/status`);
    state.scanSession = data.session;
    if (data.session.status === "waiting") {
      setScanHint(`${data.session.providerName} 窗口已打开，请扫码登录。`);
    } else if (data.session.status === "closed") {
      setScanHint("扫码窗口已关闭，如未保存请重新打开扫码。", true);
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
  } catch (error) {
    setScanHint(error.message, true);
  }
}

async function finishScanLogin() {
  if (!state.scanSession) return setScanHint("请先打开扫码。", true);
  const name = $("scanAccountName").value.trim();
  const data = await api(`/api/scan-login/${state.scanSession.id}/finish`, {
    method: "POST",
    body: { name },
  });
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  state.scanSession = null;
  $("scanActions").classList.add("hidden");
  setScanHint(`已保存扫码账号：${data.cookiePreview}`);
  await refresh();
}

async function cancelScanLogin() {
  if (!state.scanSession) {
    $("scanActions").classList.add("hidden");
    return;
  }
  await api(`/api/scan-login/${state.scanSession.id}/cancel`, { method: "POST" });
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  state.scanSession = null;
  $("scanActions").classList.add("hidden");
  setScanHint("已取消扫码。");
}

async function testAccount() {
  const id = $("accountSelect").value;
  if (!id) return setHint("请先选择账号。", true);
  setHint("正在测试账号...");
  try {
    const data = await api(`/api/accounts/${id}/test`, { method: "POST" });
    setHint(`测试通过：${data.account.nickname || data.account.name}`);
  } catch (error) {
    setHint(error.message, true);
  }
  await refresh();
}

async function deleteAccount() {
  const id = $("accountSelect").value;
  if (!id) return;
  const ok = window.confirm("只会删除本工具里的本地账号记录，不会影响网盘账号。确认删除？");
  if (!ok) return;
  await api(`/api/accounts/${id}`, { method: "DELETE" });
  await refresh();
}

async function renameAccount() {
  const id = $("accountSelect").value;
  if (!id) return setHint("请先选择账号。", true);
  const name = $("renameAccountInput").value.trim();
  if (!name) return setHint("请输入账号名称。", true);
  const data = await api(`/api/accounts/${id}`, {
    method: "PATCH",
    body: { name },
  });
  setHint(`已重命名：${data.account.name}`);
  await refresh();
  selectAccount(id, false);
}

function askLiveConfirm(kind) {
  if ($("confirmLive").checked) return true;
  const actionText = kind === "分享选中内容"
    ? "为你选中的网盘内容生成分享链接"
    : `创建新目录、转存文件${kind.includes("分享") ? "、生成分享链接" : ""}`;
  const ok = window.confirm(`${kind} 会正式操作你的网盘：${actionText}。确认继续？`);
  if (ok) $("confirmLive").checked = true;
  return ok;
}

async function startJob(mode) {
  const accountId = $("accountSelect").value;
  if (!accountId) {
    alert("请先添加并选择一个夸克账号。");
    return;
  }
  await previewLinks();
  const dryRun = mode === "dry-run";
  const shareAfterSave = mode === "save-share";
  if (!dryRun && !askLiveConfirm(shareAfterSave ? "保存并分享链接" : "保存到我网盘")) return;
  const body = {
    accountId,
    linksText: $("linksText").value,
    dryRun,
    confirmLive: dryRun ? false : $("confirmLive").checked,
    shareAfterSave,
    targetFolderName: $("targetFolderName").value.trim() || todayFolder(),
    targetFid: state.targetFolder.fid,
    delayMs: Number($("delayMs").value),
  };
  const data = await api("/api/jobs/start", { method: "POST", body });
  renderJob(data.job);
  startPolling();
}

async function shareSelected() {
  const accountId = $("accountSelect").value;
  if (!accountId) return alert("请先选择账号。");
  if (!state.selectedItems.size) return alert("请先在网盘内容里勾选要分享的文件或文件夹。");
  if (!askLiveConfirm("分享选中内容")) return;
  const data = await api("/api/jobs/share-selected", {
    method: "POST",
    body: {
      accountId,
      items: Array.from(state.selectedItems.values()).map((item) => ({
        fid: item.fid,
        name: item.name,
        dir: item.dir,
      })),
      confirmLive: $("confirmLive").checked,
      delayMs: Number($("delayMs").value),
    },
  });
  renderJob(data.job);
  startPolling();
}

async function deleteSelected() {
  const accountId = $("accountSelect").value;
  if (!accountId) return alert("请先选择账号。");
  if (!state.selectedItems.size) return alert("请先在网盘内容里勾选要删除的文件或文件夹。");
  const names = Array.from(state.selectedItems.values()).slice(0, 5).map((item) => item.name).join("\n");
  const ok = window.confirm(`确认删除选中的 ${state.selectedItems.size} 项？\n\n${names}${state.selectedItems.size > 5 ? "\n..." : ""}\n\n这个操作会影响你的网盘内容。`);
  if (!ok) return;
  const data = await api("/api/jobs/delete-selected", {
    method: "POST",
    body: {
      accountId,
      items: Array.from(state.selectedItems.values()).map((item) => ({
        fid: item.fid,
        name: item.name,
        dir: item.dir,
      })),
      confirmDelete: true,
    },
  });
  state.selectedItems.clear();
  await loadDrive();
  alert(`已删除 ${data.deleted} 项。`);
}

async function copyAllLinks() {
  const rows = state.lastResults.filter((row) => row.shareUrl);
  if (!rows.length) return alert("还没有可复制的分享链接。");
  const text = rows.map((row) => `${row.name}：${row.shareUrl}`).join("\n");
  await navigator.clipboard.writeText(text);
  $("copyAllBtn").textContent = `已复制 ${rows.length} 条`;
  setTimeout(() => { $("copyAllBtn").textContent = "复制全部链接"; }, 1600);
}

function noticeDateText() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function makeNoticeText() {
  const rows = state.lastResults.filter((row) => row.shareUrl);
  if (!rows.length) return "";
  const updates = [];
  const news = [];
  for (const row of rows) {
    const type = state.resultTypes.get(row.shareUrl) || "update";
    const item = `    ${row.name}\n      ${row.shareUrl}`;
    if (type === "new") news.push(item);
    else updates.push(item);
  }

  const parts = [`📮 公考补给站 · ${noticeDateText()}更新`, ""];
  if (updates.length) {
    parts.push(`  🔄 更新 ${updates.length} 门：`);
    parts.push(updates.join("\n"));
    parts.push("");
  }
  if (news.length) {
    parts.push(`  🆕 新增 ${news.length} 门：`);
    parts.push(news.join("\n"));
    parts.push("");
  }
  parts.push("  🌐 网站更新");
  parts.push("  🔗 https://yshyz.github.io/gongkao/");
  return parts.join("\n");
}

function renderNotice() {
  const text = makeNoticeText();
  if (!text) {
    alert("还没有可生成文案的分享链接。");
    return;
  }
  $("noticeText").value = text;
}

async function copyNotice() {
  if (!$("noticeText").value.trim()) renderNotice();
  const text = $("noticeText").value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  $("copyNoticeBtn").textContent = "文案已复制";
  setTimeout(() => { $("copyNoticeBtn").textContent = "复制文案"; }, 1600);
}

async function stopJob() {
  await api("/api/jobs/stop", { method: "POST" });
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const data = await api("/api/jobs/current");
      renderJob(data.job);
      if (!data.job || ["finished", "failed", "stopped"].includes(data.job.status)) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        await refresh();
      }
    } catch {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 1500);
}

$("targetFolderName").value = todayFolder();
$("refreshBtn").addEventListener("click", refresh);
$("accountSelect").addEventListener("change", () => {
  selectAccount($("accountSelect").value, true);
});
$("loadDriveBtn").addEventListener("click", () => loadDrive().catch((e) => renderDriveError(e.message)));
$("createFolderBtn").addEventListener("click", () => createFolder().catch((e) => renderDriveError(e.message)));
$("selectTargetBtn").addEventListener("click", selectTargetFolder);
$("selectAllBtn").addEventListener("click", selectAllDriveItems);
$("clearSelectedBtn").addEventListener("click", clearSelectedDriveItems);
$("shareSelectedBtn").addEventListener("click", () => shareSelected().catch((e) => alert(e.message)));
$("deleteSelectedBtn").addEventListener("click", () => deleteSelected().catch((e) => alert(e.message)));
$("copyAllBtn").addEventListener("click", () => copyAllLinks().catch((e) => alert(e.message)));
$("makeNoticeBtn").addEventListener("click", renderNotice);
$("copyNoticeBtn").addEventListener("click", () => copyNotice().catch((e) => alert(e.message)));
$("previewBtn").addEventListener("click", () => previewLinks().catch((e) => alert(e.message)));
$("addAccountBtn").addEventListener("click", () => addAccount().catch((e) => setHint(e.message, true)));
document.querySelectorAll(".provider").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".provider").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.selectedScanDrive = button.dataset.drive || "quark";
    startScanLogin(state.selectedScanDrive).catch((e) => setScanHint(e.message, true));
  });
});
$("finishScanBtn").addEventListener("click", () => finishScanLogin().catch((e) => setScanHint(e.message, true)));
$("cancelScanBtn").addEventListener("click", () => cancelScanLogin().catch((e) => setScanHint(e.message, true)));
$("testAccountBtn").addEventListener("click", testAccount);
$("deleteAccountBtn").addEventListener("click", () => deleteAccount().catch((e) => alert(e.message)));
$("renameAccountBtn").addEventListener("click", () => renameAccount().catch((e) => setHint(e.message, true)));
$("dryRunBtn").addEventListener("click", () => startJob("dry-run").catch((e) => alert(e.message)));
$("saveOnlyBtn").addEventListener("click", () => startJob("save-only").catch((e) => alert(e.message)));
$("saveShareBtn").addEventListener("click", () => startJob("save-share").catch((e) => alert(e.message)));
$("stopBtn").addEventListener("click", () => stopJob().catch((e) => alert(e.message)));
$("linksText").addEventListener("input", () => previewLinks().catch(() => {}));

refresh().then(startPolling).catch((error) => {
  $("runtimeStatus").textContent = "连接失败";
  $("logBox").innerHTML = `<div class="log-line error">${escapeHtml(error.message)}</div>`;
});
