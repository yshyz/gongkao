import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const EXPORT_DIR = path.join(__dirname, "exports");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.local.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.local.json");
const PORT = Number(process.env.PORT || 8787);
const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser-profiles");

const QUARK_PC = "https://drive-pc.quark.cn/1/clouddrive";
const QUARK_MAIN = "https://drive.quark.cn/1/clouddrive";

let activeJob = null;
let stopRequested = false;
const scanSessions = new Map();

await mkdir(DATA_DIR, { recursive: true });
await mkdir(EXPORT_DIR, { recursive: true });
await mkdir(BROWSER_PROFILE_DIR, { recursive: true });

const LOGIN_PROVIDERS = {
  quark: {
    name: "夸克网盘",
    loginUrl: "https://pan.quark.cn/",
    domains: ["quark.cn"],
    requiredCookies: ["b-user-id"],
  },
  baidu: {
    name: "百度网盘",
    loginUrl: "https://pan.baidu.com/disk/main",
    domains: ["baidu.com", "pan.baidu.com"],
    requiredCookies: ["BDUSS", "STOKEN"],
  },
  ali: {
    name: "阿里云盘",
    loginUrl: "https://www.aliyundrive.com/drive",
    domains: ["aliyundrive.com"],
    requiredCookies: [],
  },
  xunlei: {
    name: "迅雷云盘",
    loginUrl: "https://pan.xunlei.com/",
    domains: ["xunlei.com", "pan.xunlei.com"],
    requiredCookies: [],
  },
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function textResponse(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function getBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    driveType: account.driveType,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastTestAt: account.lastTestAt || "",
    status: account.status || "unknown",
    nickname: account.nickname || "",
    quotaTotal: account.quotaTotal || 0,
    quotaUsed: account.quotaUsed || 0,
    hasCookie: Boolean(account.cookie),
  };
}

function maskCookie(cookie) {
  if (!cookie) return "";
  const parts = cookie.split(";").map((item) => item.trim()).filter(Boolean);
  return parts.slice(0, 3).map((item) => item.split("=")[0] + "=***").join("; ");
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function waitForJson(url, attempts = 25) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(lastError?.message || "浏览器调试端口没有响应");
}

async function cdpCall(wsUrl, method, params = {}) {
  if (!globalThis.WebSocket) {
    throw new Error("当前 Node 不支持 WebSocket，请升级 Node 版本。");
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("读取扫码登录信息超时"));
    }, 12000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (message.error) reject(new Error(message.error.message || "浏览器返回错误"));
      else resolve(message.result || {});
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接扫码浏览器"));
    });
  });
}

function cookiesToHeader(cookies, provider) {
  const domains = provider.domains;
  const filtered = cookies
    .filter((cookie) => domains.some((domain) => String(cookie.domain || "").includes(domain)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const seen = new Set();
  const pairs = [];
  for (const cookie of filtered) {
    if (!cookie.name || seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value || ""}`);
  }
  return pairs.join("; ");
}

async function captureScanCookies(session) {
  const targets = await waitForJson(`http://127.0.0.1:${session.port}/json`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
    || targets.find((target) => target.webSocketDebuggerUrl);
  if (!page) throw new Error("没有找到扫码浏览器页面");
  const cookiesResult = await cdpCall(page.webSocketDebuggerUrl, "Network.getAllCookies");
  const cookies = cookiesResult.cookies || [];
  const provider = LOGIN_PROVIDERS[session.driveType];
  const cookieHeader = cookiesToHeader(cookies, provider);
  if (!cookieHeader) throw new Error("没有读取到该网盘的登录 Cookie，请确认已经扫码登录成功。");
  const missing = provider.requiredCookies.filter((name) => !cookieHeader.includes(`${name}=`));
  if (missing.length === provider.requiredCookies.length && provider.requiredCookies.length) {
    throw new Error(`没有读取到关键登录信息：${missing.join("、")}。请确认网页已进入网盘首页后再保存。`);
  }
  return cookieHeader;
}

async function loadAccounts() {
  const data = await readJson(ACCOUNTS_FILE, { accounts: [] });
  return data.accounts || [];
}

async function saveAccounts(accounts) {
  await writeJson(ACCOUNTS_FILE, { accounts });
}

async function appendJobHistory(job) {
  const data = await readJson(JOBS_FILE, { jobs: [] });
  data.jobs.unshift({
    id: job.id,
    mode: job.options.dryRun ? "dry-run" : "live",
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    totals: job.totals,
    exportFile: job.exportFile || "",
  });
  data.jobs = data.jobs.slice(0, 50);
  await writeJson(JOBS_FILE, data);
}

function extractLinks(text) {
  const seen = new Set();
  const links = [];
  const regex = /(https?:\/\/[^\s"'<>，。；；、]+)/g;
  for (const match of text.matchAll(regex)) {
    const url = match[1].replace(/[)\]}]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      links.push(url);
    }
  }
  return links;
}

function extractQuarkLinks(text) {
  const allLinks = extractLinks(text);
  const links = [];
  const ignored = [];
  for (const url of allLinks) {
    const parsed = parseQuarkShare(url);
    if (parsed.pwdId) links.push(url);
    else ignored.push(url);
  }
  return { links, ignored };
}

function extractQuarkEntries(text) {
  const entries = [];
  const ignored = [];
  const seen = new Set();
  let currentType = "update";
  const tokenPattern = /(新增|新加|🆕|更新|🔄)|(https?:\/\/[^\s"'<>，。；；、]+)/g;
  for (const match of String(text || "").matchAll(tokenPattern)) {
    const marker = match[1];
    const rawUrl = match[2];
    if (marker) {
      currentType = /新增|新加|🆕/.test(marker) ? "new" : "update";
      continue;
    }
    if (!rawUrl) continue;
    const url = rawUrl.replace(/[)\]}]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const parsed = parseQuarkShare(url);
    if (!parsed.pwdId) {
      ignored.push(url);
      continue;
    }
    entries.push({ url, kind: currentType });
  }
  return { entries, ignored, links: entries.map((entry) => entry.url) };
}

function parseQuarkShare(url) {
  const pwd = url.match(/[?&]pwd=([^&#]+)/)?.[1] || "";
  const passcode = url.match(/[?&]passcode=([^&#]+)/)?.[1] || pwd;
  const pwdId = url.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/)?.[1] || "";
  return { pwdId, passcode };
}

function makeParams(extra = {}) {
  return {
    pr: "ucpro",
    fr: "pc",
    uc_param_str: "",
    __dt: String(randomInt(600, 9999)),
    __t: String(Date.now()),
    ...extra,
  };
}

function toQuery(params) {
  return new URLSearchParams(params).toString();
}

function sanitizeName(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

class QuarkClient {
  constructor(cookie) {
    this.cookie = cookie;
    this.headers = {
      "accept": "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      "content-type": "application/json",
      "cookie": cookie,
      "origin": "https://pan.quark.cn",
      "referer": "https://pan.quark.cn/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    };
  }

  async request(base, pathName, { method = "GET", params = {}, body = null } = {}) {
    const qs = toQuery(makeParams(params));
    const url = `${base}${pathName}?${qs}`;
    const response = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`接口返回不是 JSON：${response.status}`);
    }
    if (!response.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    return data;
  }

  async accountInfo() {
    const response = await fetch("https://pan.quark.cn/account/info?fr=pc&platform=pc", {
      headers: this.headers,
    });
    const data = await response.json();
    if (!data?.data) throw new Error(data?.message || "账号校验失败，请检查 Cookie");
    return data.data;
  }

  async listFiles(pdirFid = "0") {
    const list = [];
    let page = 1;
    while (page <= 200) {
      const data = await this.request(QUARK_PC, "/file/sort", {
        params: {
          pdir_fid: pdirFid,
          _page: String(page),
          _size: "100",
          _fetch_total: "1",
          _fetch_sub_dirs: "1",
          _sort: "file_type:asc,file_name:asc",
        },
      });
      const items = data?.data?.list || [];
      list.push(...items);
      const meta = data?.metadata || {};
      const total = Number(meta._total || 0);
      const size = Number(meta._size || 100);
      if (items.length < size || list.length >= total) break;
      page += 1;
    }
    return list;
  }

  async createFolder(parentFid, name) {
    const data = await this.request(QUARK_PC, "/file", {
      method: "POST",
      body: {
        pdir_fid: parentFid || "0",
        file_name: name,
        dir_path: "",
        dir_init_lock: false,
      },
    });
    if (data?.code === 23008) throw new Error("目标目录里已有同名文件夹，请换一个任务目录名");
    const fid = data?.data?.fid;
    if (!fid) throw new Error(data?.message || "创建文件夹失败");
    return { fid, name: data?.data?.file_name || name };
  }

  async findFolder(parentFid, name) {
    const items = await this.listFiles(parentFid || "0");
    return items.find((item) => item.dir && item.file_name === name) || null;
  }

  async getShareToken(pwdId, passcode = "") {
    const data = await this.request(QUARK_PC, "/share/sharepage/token", {
      method: "POST",
      body: { pwd_id: pwdId, passcode, support_visit_limit_private_share: true },
    });
    const stoken = data?.data?.stoken;
    if (!stoken) throw new Error(data?.message || "获取分享凭证失败");
    return stoken;
  }

  async getShareDetail(pwdId, stoken, pdirFid = "0") {
    const list = [];
    let page = 1;
    while (page <= 200) {
      const data = await this.request(QUARK_PC, "/share/sharepage/detail", {
        params: {
          pwd_id: pwdId,
          stoken,
          pdir_fid: pdirFid,
          force: "0",
          _page: String(page),
          _size: "100",
          _sort: "file_type:asc,file_name:asc",
        },
      });
      const items = data?.data?.list || [];
      list.push(...items);
      const meta = data?.metadata || {};
      const total = Number(meta._total || 0);
      const size = Number(meta._size || 100);
      if (items.length < size || list.length >= total) break;
      page += 1;
    }
    return list;
  }

  async saveShareItems(pwdId, stoken, items, targetFid) {
    const fidList = items.map((item) => item.fid);
    const tokenList = items.map((item) => item.share_fid_token);
    const data = await this.request(QUARK_MAIN, "/share/sharepage/save", {
      method: "POST",
      body: {
        fid_list: fidList,
        fid_token_list: tokenList,
        to_pdir_fid: targetFid,
        pwd_id: pwdId,
        stoken,
        pdir_fid: "0",
        scene: "link",
      },
    });
    const taskId = data?.data?.task_id;
    if (!taskId) throw new Error(data?.message || "创建转存任务失败");
    return taskId;
  }

  async pollTask(taskId, attempts = 60) {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      await sleep(randomInt(500, 1100));
      const data = await this.request(QUARK_PC, "/task", {
        params: { task_id: taskId, retry_index: String(i) },
      });
      last = data;
      if (data?.data?.status === 2 || data?.data?.share_id) return data;
      if (data?.data?.status === 3) throw new Error(data?.message || "任务失败");
      if (data?.code === 32003 || data?.code === 41013) {
        throw new Error(data?.message || "任务失败");
      }
    }
    throw new Error(last?.message || "任务等待超时");
  }

  async createShare(fid, title, { expiredType = 1, urlType = 1, passcode = "" } = {}) {
    const body = {
      fid_list: [fid],
      title,
      url_type: urlType,
      expired_type: expiredType,
    };
    if (urlType === 2 && passcode) body.passcode = passcode;
    const data = await this.request(QUARK_PC, "/share", { method: "POST", body });
    const taskId = data?.data?.task_id;
    if (!taskId) throw new Error(data?.message || "创建分享任务失败");
    const task = await this.pollTask(taskId, 30);
    const shareId = task?.data?.share_id;
    if (!shareId) throw new Error("分享任务没有返回 share_id");
    const detail = await this.request(QUARK_PC, "/share/password", {
      method: "POST",
      body: { share_id: shareId },
    });
    let shareUrl = detail?.data?.share_url || "";
    const code = detail?.data?.passcode || "";
    if (shareUrl && code) shareUrl += `?pwd=${code}`;
    if (!shareUrl) throw new Error(detail?.message || "获取分享链接失败");
    return {
      shareId,
      shareUrl,
      title: detail?.data?.title || title,
      passcode: code,
    };
  }

  async deleteFiles(fids) {
    const data = await this.request(QUARK_PC, "/file/delete", {
      method: "POST",
      body: {
        action_type: 2,
        filelist: fids,
        exclude_fids: [],
      },
    });
    const taskId = data?.data?.task_id;
    if (!taskId) throw new Error(data?.message || "创建删除任务失败");
    return this.pollTask(taskId, 40);
  }
}

function ensureActiveJob() {
  return activeJob ? serializeJob(activeJob) : null;
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || "",
    logs: job.logs.slice(-300),
    items: job.items,
    results: job.results,
    totals: job.totals,
    options: {
      dryRun: job.options.dryRun,
      delayMs: job.options.delayMs,
      shareAfterSave: job.options.shareAfterSave,
      targetFolderName: job.options.targetFolderName,
    },
    exportFile: job.exportFile || "",
  };
}

function log(job, level, message, data = null) {
  job.logs.push({ at: nowIso(), level, message, data });
}

function bump(job, key) {
  job.totals[key] = (job.totals[key] || 0) + 1;
}

async function exportResults(job) {
  const rows = [
    ["来源链接", "原始文件名", "保存状态", "分享状态", "新分享链接", "错误"],
  ];
  for (const result of job.results) {
    rows.push([
      result.sourceUrl,
      result.name,
      result.saveStatus || "",
      result.shareStatus || "",
      result.shareUrl || "",
      result.error || "",
    ]);
  }
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const file = `panbox-lite-${job.id}.csv`;
  const output = path.join(EXPORT_DIR, file);
  await writeFile(output, "\ufeff" + csv, "utf8");
  job.exportFile = `/exports/${file}`;
}

async function runJob(job) {
  activeJob = job;
  stopRequested = false;
  const accounts = await loadAccounts();
  const account = accounts.find((item) => item.id === job.options.accountId);
  if (!account) throw new Error("找不到账号");
  if (account.driveType !== "quark") throw new Error("当前批量转存/分享第一版只支持夸克账号，请选择夸克账号。");
  const client = new QuarkClient(account.cookie);

  try {
    job.status = "running";
    log(job, "info", job.options.dryRun ? "演练开始：不会转存，也不会创建分享。" : "正式任务开始：只会创建文件夹、转存、创建分享，不会删除或移动文件。");
    const info = await client.accountInfo();
    log(job, "ok", `账号校验通过：${info.nickname || account.name}`);

    let targetFid = job.options.targetFid || "0";
    if (!job.options.dryRun) {
      const existing = await client.findFolder(targetFid, job.options.targetFolderName);
      const folder = existing || await client.createFolder(targetFid, job.options.targetFolderName);
      targetFid = folder.fid;
      job.targetFid = targetFid;
      log(job, "ok", `${existing ? "使用已有" : "已创建"}本次任务目录：${folder.file_name || folder.name}`);
    } else {
      log(job, "info", `演练目标目录名：${job.options.targetFolderName}`);
    }

    for (const sourceEntry of job.items) {
      const sourceUrl = typeof sourceEntry === "string" ? sourceEntry : sourceEntry.url;
      const sourceKind = typeof sourceEntry === "string" ? "update" : sourceEntry.kind || "update";
      if (stopRequested) {
        job.status = "stopped";
        log(job, "warn", "任务已按请求停止。");
        break;
      }
      const { pwdId, passcode } = parseQuarkShare(sourceUrl);
      const sourceResult = { sourceUrl, name: "", saveStatus: "", shareStatus: "", shareUrl: "", error: "" };
      if (!pwdId) {
        log(job, "warn", "已忽略无法识别的链接。", { sourceUrl });
        continue;
      }

      try {
        log(job, "info", `解析分享链接：${pwdId}`);
        const stoken = await client.getShareToken(pwdId, passcode);
        const detailItems = await client.getShareDetail(pwdId, stoken);
        if (!detailItems.length) throw new Error("分享链接里没有可保存文件");
        log(job, "ok", `发现 ${detailItems.length} 个顶层项目。`);

        if (job.options.dryRun) {
          for (const item of detailItems) {
            job.results.push({
              sourceUrl,
              name: item.file_name,
              saveStatus: "演练：未转存",
              shareStatus: "演练：未分享",
              shareUrl: "",
              kind: sourceKind,
              error: "",
            });
            bump(job, "previewed");
          }
          await sleep(job.options.delayMs);
          continue;
        }

        const before = await client.listFiles(targetFid);
        const beforeFids = new Set(before.map((item) => item.fid));
        const taskId = await client.saveShareItems(pwdId, stoken, detailItems, targetFid);
        await client.pollTask(taskId);
        log(job, "ok", "转存任务完成。");
        bump(job, "savedLinks");

        await sleep(Math.max(1200, job.options.delayMs));
        const after = await client.listFiles(targetFid);
        const savedItems = after.filter((item) => !beforeFids.has(item.fid));
        const fallbackNames = new Set(detailItems.map((item) => item.file_name));
        const matchedItems = savedItems.length
          ? savedItems
          : after.filter((item) => fallbackNames.has(item.file_name));

        if (!matchedItems.length) {
          throw new Error("转存后没有在目标目录中识别到新文件，可能是同名已存在或接口延迟。");
        }

        for (const item of matchedItems) {
          const result = {
            sourceUrl,
            name: item.file_name,
            saveStatus: "已转存",
            shareStatus: job.options.shareAfterSave ? "待分享" : "未分享",
            shareUrl: "",
            kind: sourceKind,
            error: "",
          };
          if (job.options.shareAfterSave) {
            try {
              await sleep(job.options.delayMs);
              const share = await client.createShare(item.fid, item.file_name, {
                expiredType: Number(job.options.expiredType || 1),
                urlType: Number(job.options.urlType || 1),
                passcode: job.options.passcode || "",
              });
              result.shareStatus = "已分享";
              result.shareUrl = share.shareUrl;
              bump(job, "shared");
              log(job, "ok", `已生成分享：${item.file_name}`);
            } catch (error) {
              result.shareStatus = "分享失败";
              result.error = error.message;
              bump(job, "failed");
              log(job, "error", `分享失败：${item.file_name}，${error.message}`);
            }
          }
          job.results.push(result);
        }
      } catch (error) {
        sourceResult.error = error.message;
        sourceResult.saveStatus = "失败";
        job.results.push(sourceResult);
        bump(job, "failed");
        log(job, "error", error.message, { sourceUrl });
      }

      await sleep(job.options.delayMs);
    }

    if (job.status !== "stopped") job.status = "finished";
    job.finishedAt = nowIso();
    await exportResults(job);
    log(job, "ok", `任务结束，结果已导出：${job.exportFile}`);
  } catch (error) {
    job.status = "failed";
    job.finishedAt = nowIso();
    log(job, "error", error.message);
  } finally {
    await appendJobHistory(job);
  }
}

async function runShareSelectedJob(job) {
  activeJob = job;
  stopRequested = false;
  const accounts = await loadAccounts();
  const account = accounts.find((item) => item.id === job.options.accountId);
  if (!account) throw new Error("找不到账号");
  if (account.driveType !== "quark") throw new Error("当前直接分享第一版只支持夸克账号，请选择夸克账号。");
  const client = new QuarkClient(account.cookie);

  try {
    job.status = "running";
    log(job, "info", "开始分享选中的网盘内容，不会转存、删除、移动文件。");
    const info = await client.accountInfo();
    log(job, "ok", `账号校验通过：${info.nickname || account.name}`);

    for (const item of job.items) {
      if (stopRequested) {
        job.status = "stopped";
        log(job, "warn", "任务已按请求停止。");
        break;
      }

      const result = {
        sourceUrl: "我的网盘",
        name: item.name,
        saveStatus: "已有文件",
        shareStatus: "待分享",
        shareUrl: "",
        error: "",
      };

      try {
        await sleep(job.options.delayMs);
        const share = await client.createShare(item.fid, item.name, {
          expiredType: Number(job.options.expiredType || 1),
          urlType: Number(job.options.urlType || 1),
          passcode: job.options.passcode || "",
        });
        result.shareStatus = "已分享";
        result.shareUrl = share.shareUrl;
        bump(job, "shared");
        log(job, "ok", `已生成分享：${item.name}`);
      } catch (error) {
        result.shareStatus = "分享失败";
        result.error = error.message;
        bump(job, "failed");
        log(job, "error", `分享失败：${item.name}，${error.message}`);
      }

      job.results.push(result);
    }

    if (job.status !== "stopped") job.status = "finished";
    job.finishedAt = nowIso();
    await exportResults(job);
    log(job, "ok", `任务结束，结果已导出：${job.exportFile}`);
  } catch (error) {
    job.status = "failed";
    job.finishedAt = nowIso();
    log(job, "error", error.message);
  } finally {
    await appendJobHistory(job);
  }
}

async function routeApi(req, res, pathname) {
  if (pathname === "/api/state" && req.method === "GET") {
    const accounts = (await loadAccounts()).map(publicAccount);
    const history = await readJson(JOBS_FILE, { jobs: [] });
    return jsonResponse(res, 200, { accounts, activeJob: ensureActiveJob(), history: history.jobs || [] });
  }

  if (pathname === "/api/accounts" && req.method === "POST") {
    const body = await getBody(req);
    const cookie = String(body.cookie || "").trim();
    const driveType = String(body.driveType || "quark");
    if (!LOGIN_PROVIDERS[driveType]) {
      return jsonResponse(res, 400, { error: "暂不支持这个网盘类型。" });
    }
    if (driveType === "quark" && !cookie.includes("b-user-id")) {
      return jsonResponse(res, 400, { error: "夸克 Cookie 看起来不完整，需要包含 b-user-id。" });
    }
    const accounts = await loadAccounts();
    const account = {
      id: crypto.randomUUID(),
      name: String(body.name || LOGIN_PROVIDERS[driveType].name).trim(),
      driveType,
      cookie,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "unknown",
    };
    accounts.push(account);
    await saveAccounts(accounts);
    return jsonResponse(res, 200, { account: publicAccount(account), cookiePreview: maskCookie(cookie) });
  }

  if (pathname.startsWith("/api/accounts/") && pathname.endsWith("/test") && req.method === "POST") {
    const id = pathname.split("/")[3];
    const accounts = await loadAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return jsonResponse(res, 404, { error: "账号不存在" });
    if (account.driveType !== "quark") {
      account.status = "saved";
      account.lastTestAt = nowIso();
      account.updatedAt = nowIso();
      await saveAccounts(accounts);
      return jsonResponse(res, 200, {
        account: publicAccount(account),
        message: "该网盘已保存扫码凭据，具体转存能力后续接入。",
      });
    }
    try {
      const client = new QuarkClient(account.cookie);
      const info = await client.accountInfo();
      account.status = "ok";
      account.nickname = info.nickname || account.name;
      account.quotaTotal = info?.total_capacity || 0;
      account.quotaUsed = info?.use_capacity || 0;
      account.lastTestAt = nowIso();
      account.updatedAt = nowIso();
      await saveAccounts(accounts);
      return jsonResponse(res, 200, { account: publicAccount(account) });
    } catch (error) {
      account.status = "failed";
      account.lastTestAt = nowIso();
      account.updatedAt = nowIso();
      await saveAccounts(accounts);
      return jsonResponse(res, 400, { error: error.message, account: publicAccount(account) });
    }
  }

  if (pathname.startsWith("/api/accounts/") && req.method === "PATCH") {
    const id = pathname.split("/")[3];
    const body = await getBody(req);
    const name = sanitizeName(body.name || "");
    if (!name) return jsonResponse(res, 400, { error: "请输入账号名称。" });
    const accounts = await loadAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return jsonResponse(res, 404, { error: "账号不存在" });
    account.name = name;
    account.updatedAt = nowIso();
    await saveAccounts(accounts);
    return jsonResponse(res, 200, { account: publicAccount(account) });
  }

  if (pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
    const id = pathname.split("/")[3];
    const accounts = await loadAccounts();
    const next = accounts.filter((item) => item.id !== id);
    await saveAccounts(next);
    return jsonResponse(res, 200, { ok: true });
  }

  if (pathname.startsWith("/api/accounts/") && pathname.endsWith("/files") && req.method === "GET") {
    const parts = pathname.split("/");
    const id = parts[3];
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pdirFid = url.searchParams.get("pdirFid") || "0";
    const accounts = await loadAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return jsonResponse(res, 404, { error: "账号不存在" });
    if (account.driveType !== "quark") {
      return jsonResponse(res, 400, { error: "当前只支持浏览夸克网盘内容。" });
    }
    try {
      const client = new QuarkClient(account.cookie);
      const items = await client.listFiles(pdirFid);
      return jsonResponse(res, 200, {
        pdirFid,
        items: items.map((item) => ({
          fid: item.fid,
          name: item.file_name,
          dir: Boolean(item.dir),
          size: item.size || item.file_size || 0,
          updatedAt: item.updated_at || item.updated_at_ms || "",
          fileType: item.file_type || "",
        })),
      });
    } catch (error) {
      return jsonResponse(res, 400, { error: error.message });
    }
  }

  if (pathname.startsWith("/api/accounts/") && pathname.endsWith("/folders") && req.method === "POST") {
    const parts = pathname.split("/");
    const id = parts[3];
    const body = await getBody(req);
    const parentFid = String(body.parentFid || "0");
    const name = sanitizeName(body.name || "");
    if (!name) return jsonResponse(res, 400, { error: "请输入文件夹名称。" });
    const accounts = await loadAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return jsonResponse(res, 404, { error: "账号不存在" });
    if (account.driveType !== "quark") {
      return jsonResponse(res, 400, { error: "当前只支持在夸克网盘创建文件夹。" });
    }
    try {
      const client = new QuarkClient(account.cookie);
      const existing = await client.findFolder(parentFid, name);
      const folder = existing || await client.createFolder(parentFid, name);
      return jsonResponse(res, 200, {
        folder: {
          fid: folder.fid,
          name: folder.file_name || folder.name || name,
          dir: true,
          existed: Boolean(existing),
        },
      });
    } catch (error) {
      return jsonResponse(res, 400, { error: error.message });
    }
  }

  if (pathname === "/api/scan-login/start" && req.method === "POST") {
    const body = await getBody(req);
    const driveType = String(body.driveType || "quark");
    const provider = LOGIN_PROVIDERS[driveType];
    if (!provider) return jsonResponse(res, 400, { error: "暂不支持这个网盘类型。" });

    const browser = findBrowserExecutable();
    if (!browser) return jsonResponse(res, 500, { error: "没有找到 Chrome 或 Edge。" });

    const id = crypto.randomUUID();
    const port = randomInt(19000, 26000);
    const profileDir = path.join(BROWSER_PROFILE_DIR, `${driveType}-${id}`);
    await mkdir(profileDir, { recursive: true });
    const child = spawn(browser, [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      provider.loginUrl,
    ], {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });

    const session = {
      id,
      driveType,
      providerName: provider.name,
      port,
      profileDir,
      pid: child.pid,
      startedAt: nowIso(),
      status: "opening",
      loginUrl: provider.loginUrl,
      child,
    };
    scanSessions.set(id, session);
    child.on("exit", () => {
      const current = scanSessions.get(id);
      if (current) current.status = "closed";
    });

    return jsonResponse(res, 200, {
      session: {
        id,
        driveType,
        providerName: provider.name,
        status: session.status,
        loginUrl: provider.loginUrl,
      },
    });
  }

  if (pathname.startsWith("/api/scan-login/") && pathname.endsWith("/status") && req.method === "GET") {
    const id = pathname.split("/")[3];
    const session = scanSessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: "扫码会话不存在或已结束。" });
    try {
      await waitForJson(`http://127.0.0.1:${session.port}/json/version`, 2);
      session.status = session.status === "closed" ? "closed" : "waiting";
    } catch {
      if (session.status !== "closed") session.status = "opening";
    }
    return jsonResponse(res, 200, {
      session: {
        id: session.id,
        driveType: session.driveType,
        providerName: session.providerName,
        status: session.status,
        startedAt: session.startedAt,
      },
    });
  }

  if (pathname.startsWith("/api/scan-login/") && pathname.endsWith("/finish") && req.method === "POST") {
    const id = pathname.split("/")[3];
    const body = await getBody(req);
    const session = scanSessions.get(id);
    if (!session) return jsonResponse(res, 404, { error: "扫码会话不存在或已结束。" });
    const provider = LOGIN_PROVIDERS[session.driveType];
    try {
      const cookie = await captureScanCookies(session);
      const accounts = await loadAccounts();
      const account = {
        id: crypto.randomUUID(),
        name: String(body.name || provider.name).trim(),
        driveType: session.driveType,
        cookie,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: session.driveType === "quark" ? "unknown" : "saved",
      };
      accounts.push(account);
      await saveAccounts(accounts);
      try { session.child.kill(); } catch {}
      scanSessions.delete(id);
      return jsonResponse(res, 200, {
        account: publicAccount(account),
        cookiePreview: maskCookie(cookie),
      });
    } catch (error) {
      return jsonResponse(res, 400, { error: error.message });
    }
  }

  if (pathname.startsWith("/api/scan-login/") && pathname.endsWith("/cancel") && req.method === "POST") {
    const id = pathname.split("/")[3];
    const session = scanSessions.get(id);
    if (session) {
      try { session.child.kill(); } catch {}
      scanSessions.delete(id);
    }
    return jsonResponse(res, 200, { ok: true });
  }

  if (pathname === "/api/preview-links" && req.method === "POST") {
    const body = await getBody(req);
    const result = extractQuarkEntries(String(body.linksText || ""));
    return jsonResponse(res, 200, {
      links: result.links,
      entries: result.entries,
      ignored: result.ignored,
      count: result.links.length,
      ignoredCount: result.ignored.length,
    });
  }

  if (pathname === "/api/jobs/start" && req.method === "POST") {
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return jsonResponse(res, 409, { error: "已有任务正在运行，请先停止或等它结束。" });
    }
    const body = await getBody(req);
    const parsedLinks = extractQuarkEntries(String(body.linksText || ""));
    const entries = parsedLinks.entries;
    if (!entries.length) return jsonResponse(res, 400, { error: "没有识别到可保存的夸克分享链接。" });
    if (!body.dryRun && body.confirmLive !== true) {
      return jsonResponse(res, 400, { error: "正式任务需要勾选确认。" });
    }
    const job = {
      id: new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14),
      status: "queued",
      createdAt: nowIso(),
      finishedAt: "",
      logs: [],
      items: entries,
      results: [],
      totals: { totalLinks: entries.length, previewed: 0, savedLinks: 0, shared: 0, failed: 0 },
      options: {
        accountId: String(body.accountId || ""),
        dryRun: body.dryRun !== false,
        targetFid: String(body.targetFid || "0"),
        targetFolderName: sanitizeName(body.targetFolderName || `PanBoxLite-${new Date().toISOString().slice(0, 10)}`),
        shareAfterSave: body.shareAfterSave !== false,
        delayMs: Math.max(1500, Math.min(Number(body.delayMs || 3000), 30000)),
        expiredType: Number(body.expiredType || 1),
        urlType: Number(body.urlType || 1),
        passcode: String(body.passcode || "").trim(),
      },
    };
    activeJob = job;
    runJob(job);
    return jsonResponse(res, 200, { job: serializeJob(job) });
  }

  if (pathname === "/api/jobs/share-selected" && req.method === "POST") {
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return jsonResponse(res, 409, { error: "已有任务正在运行，请先停止或等它结束。" });
    }
    const body = await getBody(req);
    const selectedItems = Array.isArray(body.items) ? body.items : [];
    const safeItems = selectedItems
      .filter((item) => item && item.fid && item.name)
      .map((item) => ({
        fid: String(item.fid),
        name: sanitizeName(item.name),
        dir: Boolean(item.dir),
      }));
    if (!safeItems.length) return jsonResponse(res, 400, { error: "请先勾选要分享的网盘内容。" });
    if (body.confirmLive !== true) {
      return jsonResponse(res, 400, { error: "直接分享需要勾选确认。" });
    }
    const job = {
      id: new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14),
      status: "queued",
      createdAt: nowIso(),
      finishedAt: "",
      logs: [],
      items: safeItems,
      results: [],
      totals: { totalLinks: safeItems.length, previewed: 0, savedLinks: 0, shared: 0, failed: 0 },
      options: {
        accountId: String(body.accountId || ""),
        dryRun: false,
        targetFid: "",
        targetFolderName: "",
        shareAfterSave: true,
        delayMs: Math.max(1500, Math.min(Number(body.delayMs || 3000), 30000)),
        expiredType: Number(body.expiredType || 1),
        urlType: Number(body.urlType || 1),
        passcode: String(body.passcode || "").trim(),
      },
    };
    activeJob = job;
    runShareSelectedJob(job);
    return jsonResponse(res, 200, { job: serializeJob(job) });
  }

  if (pathname === "/api/jobs/delete-selected" && req.method === "POST") {
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return jsonResponse(res, 409, { error: "已有任务正在运行，请先停止或等它结束。" });
    }
    const body = await getBody(req);
    if (body.confirmDelete !== true) {
      return jsonResponse(res, 400, { error: "删除操作需要确认。" });
    }
    const selectedItems = Array.isArray(body.items) ? body.items : [];
    const fids = selectedItems.filter((item) => item && item.fid).map((item) => String(item.fid));
    if (!fids.length) return jsonResponse(res, 400, { error: "请先勾选要删除的网盘内容。" });
    const accounts = await loadAccounts();
    const account = accounts.find((item) => item.id === String(body.accountId || ""));
    if (!account) return jsonResponse(res, 404, { error: "账号不存在" });
    if (account.driveType !== "quark") return jsonResponse(res, 400, { error: "当前删除第一版只支持夸克账号。" });
    try {
      const client = new QuarkClient(account.cookie);
      await client.deleteFiles(fids);
      return jsonResponse(res, 200, { ok: true, deleted: fids.length });
    } catch (error) {
      return jsonResponse(res, 400, { error: error.message });
    }
  }

  if (pathname === "/api/jobs/current" && req.method === "GET") {
    return jsonResponse(res, 200, { job: ensureActiveJob() });
  }

  if (pathname === "/api/jobs/stop" && req.method === "POST") {
    stopRequested = true;
    return jsonResponse(res, 200, { ok: true });
  }

  return jsonResponse(res, 404, { error: "接口不存在" });
}

async function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  filePath = path.normalize(filePath);

  if (pathname.startsWith("/exports/")) {
    filePath = path.join(EXPORT_DIR, pathname.replace("/exports/", ""));
  } else if (!filePath.startsWith(PUBLIC_DIR)) {
    return textResponse(res, 403, "Forbidden");
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return textResponse(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    createReadStream(filePath).pipe(res);
  } catch {
    textResponse(res, 404, "Not found");
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url.pathname);
    } else {
      await serveStatic(req, res, decodeURIComponent(url.pathname));
    }
  } catch (error) {
    jsonResponse(res, 500, { error: error.message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`PanBox Lite running at http://127.0.0.1:${PORT}`);
  console.log("Local data stays under panbox-lite/data and panbox-lite/exports.");
});
