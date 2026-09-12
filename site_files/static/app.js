const $ = (id) => document.getElementById(id);

let currentUser = null; // {username, uid, is_admin}
let currentPage = "points";
let wallPage = 1;
let wallSort = "latest";
let wallPages = 1;

function fmtPoints(n) {
  return Number(n || 0).toLocaleString();
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(path, {
      credentials: "same-origin",
      signal: ctrl.signal,
      ...options,
    });
    let data = {};
    try {
      data = await resp.json();
    } catch (e) {
      data = {};
    }
    if (!resp.ok && data.status === "error") {
      throw new Error(data.message || "请求失败");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 主题 ----------

function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $("theme-toggle").textContent = dark ? "☀️" : "🌙";
}

function bindTheme() {
  const saved = localStorage.getItem("theme");
  applyTheme(saved === "dark");
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") !== "dark";
    applyTheme(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
    syncThemeButtons();
  });
}

// ---------- 网站设置 / 动漫背景 ----------

let bgTimer = null;
let bgEnabled = true;
let bgInterval = 5;
let bgApiUrl = "";
let offlineMode = localStorage.getItem("offline-mode") === "1";

function applyOfflineMode() {
  // 离线模式：隐藏注册 tab，禁止注册（聊天/留言等需已有账号登录）
  const tabReg = $("tab-register");
  if (tabReg) tabReg.classList.toggle("hidden", offlineMode);
  if (
    offlineMode &&
    $("register-form") &&
    !$("register-form").classList.contains("hidden")
  ) {
    $("tab-login").click();
  }
  if ($("settings-offline-switch"))
    $("settings-offline-switch").checked = offlineMode;
  if ($("auth-mode-status"))
    $("auth-mode-status").textContent = offlineMode ? "离线" : "在线";
}

function toggleOfflineMode() {
  offlineMode = !offlineMode;
  localStorage.setItem("offline-mode", offlineMode ? "1" : "0");
  applyOfflineMode();
  void checkVersion();
}

function syncThemeButtons() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  if (!$("theme-dark-btn")) return;
  $("theme-dark-btn").classList.toggle("active", dark);
  $("theme-light-btn").classList.toggle("active", !dark);
}

async function setupBackground() {
  try {
    const data = await api("/api/site-settings");
    const d = (data.data) || {};
    bgApiUrl = d.bg_api || "";
    const savedEnabled = localStorage.getItem("bg-enabled");
    const savedInterval = localStorage.getItem("bg-interval");
    bgEnabled = savedEnabled === null ? !!d.bg_enabled : savedEnabled === "1";
    bgInterval =
      savedInterval === null
        ? Number(d.bg_refresh) || 5
        : Number(savedInterval) || 0;
    if ($("bg-enabled")) $("bg-enabled").checked = bgEnabled;
    if ($("bg-interval")) $("bg-interval").value = bgInterval;
  } catch (e) {
    // 离线等异常：按本地设置
    bgEnabled = localStorage.getItem("bg-enabled") !== "0";
    bgInterval = Number(localStorage.getItem("bg-interval")) || 5;
  }
  restartBgLoop();
}

function preloadImage(url, timeoutMs) {
  // 带超时的图片预加载：卡住/失败都算失败，避免某个图源一直挂起导致观赏模式黑屏
  // 超时放宽到 10 秒：网络慢但能加载的图源不应被过早判为失败
  const timeout = timeoutMs || 10000;
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok ? url : null);
    };
    const timer = setTimeout(() => finish(false), timeout);
    img.referrerPolicy = "no-referrer";
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

function setBg(url) {
  document.body.classList.add("bg-mode");
  document.body.style.backgroundImage = `url("${url}")`;
}

// 加载一张随机动漫背景图 URL（多来源逐个尝试，均预加载验证）
async function loadBgUrl() {
  const ts = Date.now();
  // 1) 直连外站（快、省服务器流量）
  const directSources = [];
  if (bgApiUrl) directSources.push(bgApiUrl);
  if (directSources.indexOf("https://pic.2333404.xyz/pic?img=ua") === -1) {
    directSources.push("https://pic.2333404.xyz/pic?img=ua");
  }
  for (const api of directSources) {
    const u = api + (api.includes("?") ? "&" : "?") + "t=" + ts;
    const loaded = await preloadImage(u);
    if (loaded) return loaded;
  }
  // 2) 服务器代理直出图片（浏览器只连本站，最可靠：本站能打开就一定能加载）
  const proxyUrl = `/api/bg?ts=${ts}`;
  const proxyLoaded = await preloadImage(proxyUrl, 15000);
  if (proxyLoaded) return proxyUrl;
  // 3) 本地兜底图（本站 /static，绝对能加载，保证不黑屏）
  return "/static/bg-fallback.svg";
}

async function applyBackgroundNow() {
  const url = await loadBgUrl();
  if (url) {
    setBg(url);
    return url;
  }
  return null;
}

// ---------- 观赏页面（独立图库页，类似照片墙） ----------

let viewerImages = [];

function renderViewerPage() {
  const grid = $("viewer-page-grid");
  const out = $("viewer-page-result");
  if (!grid) return;
  const ratio = $("viewer-page-ratio").value;
  const fit = $("viewer-page-fit").value;
  const opacity = Number($("viewer-page-opacity").value || 100);
  $("viewer-page-opacity-val").textContent = opacity + "%";
  grid.innerHTML = "";
  if (!viewerImages.length) {
    grid.innerHTML = '<p class="hint">暂无图片，点击「＋ 加载一张」开始。</p>';
    out.textContent = "";
    return;
  }
  viewerImages.forEach((url, i) => {
    const card = document.createElement("div");
    card.className = "viewer-page-card";
    if (ratio !== "auto") card.style.aspectRatio = ratio;
    card.style.opacity = opacity / 100;
    card.innerHTML = `
      <img src="${escapeHtml(url)}" alt="动漫背景" loading="lazy" referrerpolicy="no-referrer"
           style="object-fit:${fit}" />
      <button class="viewer-page-del" data-i="${i}" title="删除">✕</button>
    `;
    grid.appendChild(card);
  });
  grid.querySelectorAll(".viewer-page-del").forEach((b) => {
    b.addEventListener("click", () => {
      viewerImages.splice(Number(b.dataset.i), 1);
      renderViewerPage();
    });
  });
}

async function viewerPageAdd() {
  const out = $("viewer-page-result");
  out.textContent = "加载中…";
  let url = await loadBgUrl();
  if (url === viewerImages[viewerImages.length - 1]) {
    url = await loadBgUrl();
  }
  if (url) {
    viewerImages.push(url);
    setBg(url);
    out.textContent = "";
    renderViewerPage();
  } else {
    out.textContent = "图片加载失败，点「加载一张」重试。";
  }
}

async function loadViewerPage() {
  if (!viewerImages.length) {
    await viewerPageAdd();
  } else {
    renderViewerPage();
  }
}

function bindViewerPage() {
  $("viewer-page-add").addEventListener("click", () => void viewerPageAdd());
  $("viewer-page-clear").addEventListener("click", () => {
    viewerImages = [];
    renderViewerPage();
  });
  $("viewer-page-opacity").addEventListener("input", renderViewerPage);
  $("viewer-page-ratio").addEventListener("change", renderViewerPage);
  $("viewer-page-fit").addEventListener("change", renderViewerPage);
}

function restartBgLoop() {
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = null;
  }
  if (bgEnabled && bgInterval > 0) {
    void applyBackgroundNow();
    bgTimer = setInterval(() => void applyBackgroundNow(), bgInterval * 1000);
  } else if (bgEnabled) {
    // 启用但不自动换
  } else {
    document.body.classList.remove("bg-mode");
    document.body.style.backgroundImage = "";
  }
}

function renderSettingsStatus(d) {
  const box = $("settings-status");
  if (!box) return;
  const online = d.online;
  let statusHtml;
  if (offlineMode) {
    statusHtml = `<span class="status-badge offline">● 离线模式（手动）</span>`;
  } else {
    statusHtml = online
      ? `<span class="status-badge online">● 在线</span>`
      : `<span class="status-badge offline">● 离线</span>`;
  }
  const ageText =
    d.sync_age >= 0
      ? `${d.sync_age} 秒前`
      : "从未同步";
  const verText = d.plugin_version
    ? `网站 v${d.web_version} · 插件 v${d.plugin_version}`
    : `网站 v${d.web_version} · 插件未同步`;
  box.innerHTML = `<div class="status-row">${statusHtml} <span>插件连接状态</span></div>
    <div class="hint">${escapeHtml(verText)} · 最近同步：${ageText}</div>
    ${offlineMode ? '<p class="hint">离线模式：忽略插件同步提示，聊天/留言/邮箱/反馈/五子棋仍可用，积分相关功能暂不可用。</p>' : ""}
    ${!offlineMode && !online ? '<p class="hint">插件离线：聊天室/留言板/邮箱/反馈/五子棋仍可用，积分相关功能暂不可用。</p>' : ""}`;
}

async function loadSettings() {
  try {
    const data = await api("/api/site-settings");
    const d = (data.data) || {};
    renderSettingsStatus(d);
    if (d.bg_api) bgApiUrl = d.bg_api;
  } catch (e) {
    if ($("settings-status"))
      $("settings-status").innerHTML = '<p class="hint">无法获取连接状态。</p>';
  }
  syncThemeButtons();
  if ($("bg-enabled") === null) return;
  $("bg-enabled").checked = bgEnabled;
  $("bg-interval").value = bgInterval;
}

function bindSettings() {
  const applyThemeFromButtons = (dark) => {
    applyTheme(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
    syncThemeButtons();
  };
  $("theme-light-btn").addEventListener("click", () => applyThemeFromButtons(false));
  $("theme-dark-btn").addEventListener("click", () => applyThemeFromButtons(true));

  $("bg-enabled").addEventListener("change", () => {
    bgEnabled = $("bg-enabled").checked;
    localStorage.setItem("bg-enabled", bgEnabled ? "1" : "0");
    $("settings-result").textContent = bgEnabled ? "背景已启用。" : "背景已停用。";
    restartBgLoop();
  });
  $("bg-interval").addEventListener("change", () => {
    const v = Math.max(0, Math.min(3600, Number($("bg-interval").value) || 0));
    bgInterval = v;
    localStorage.setItem("bg-interval", String(v));
    $("settings-result").textContent = v > 0 ? `已设为每 ${v} 秒自动换图。` : "已关闭自动换图（可手动换）。";
    restartBgLoop();
  });
  $("bg-refresh-btn").addEventListener("click", async () => {
    const url = await applyBackgroundNow();
    $("settings-result").textContent = url ? "已换一张背景。" : "换图失败，请稍后再试。";
  });
  $("settings-viewer-btn").addEventListener("click", () => switchPage("viewer"));
  $("settings-logout-btn").addEventListener("click", () => void logout());
  $("settings-offline-switch").addEventListener("change", () => {
    offlineMode = $("settings-offline-switch").checked;
    localStorage.setItem("offline-mode", offlineMode ? "1" : "0");
    applyOfflineMode();
    void checkVersion();
  });
}

// ---------- 折叠 ----------

function bindCollapse() {
  document.querySelectorAll(".collapse-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = $(btn.dataset.target);
      if (!target) return;
      const collapsed = target.classList.toggle("hidden");
      btn.textContent = collapsed ? "展开" : "收起";
    });
  });
}

// ---------- 公告 ----------

async function loadAnnouncement() {
  try {
    const data = await api("/api/announcements");
    const d = data.data || {};
    const bar = $("announcement-bar");
    if (!d.content) {
      bar.classList.add("hidden");
      return;
    }
    $("announcement-text").textContent = d.content;
    bar.classList.remove("hidden");
  } catch (e) {
    /* ignore */
  }
}

// ---------- 导航 ----------

const PAGE_LOADERS = {
  points: loadMyPoints,
  signin: loadSignCalendar,
  wall: loadWall,
  images: loadMyImages,
  random: loadRandomImage,
  redeem: loadRedeemHistory,
  shop: loadShop,
  lottery: loadLottery,
  chat: loadChat,
  board: loadBoard,
  mail: loadMail,
  feedback: loadFeedbackMine,
  tasks: loadTasks,
  auction: loadAuction,
  gomoku: loadGomoku,
  favorites: loadFavorites,
  rank: loadLeaderboard,
  viewer: loadViewerPage,
  profile: loadProfile,
  settings: loadSettings,
  "admin-users": loadAdminUsers,
  "admin-accounts": loadAdminAccounts,
  "admin-images": loadAdminImages,
  "admin-redeem": () => {},
  "admin-redeem-gen": loadAdminRedeemGen,
  "admin-shop": loadAdminShop,
  "admin-bottles": loadAdminBottles,
  "admin-announcement": loadAdminAnnouncement,
  "admin-lottery": loadAdminLottery,
  "admin-auction": loadAdminAuction,
  "admin-feedback": loadAdminFeedback,
  "admin-ledger": loadAdminLedger,
};

// 每个页面顶部注入「刷新」按钮（动态重建，避免重复）
function ensureRefreshButton(page) {
  const pageEl = $(`page-${page}`);
  if (!pageEl) return;
  let bar = pageEl.querySelector(".page-refresh-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "page-refresh-bar";
    pageEl.prepend(bar);
  }
  bar.innerHTML = `<button class="btn btn-sm page-refresh-btn">🔄 刷新</button>`;
  bar.querySelector(".page-refresh-btn").addEventListener("click", () => {
    // 整页刷新前记住当前页，刷新后回到原页面
    sessionStorage.setItem("points-current-page", page);
    // 整页刷新：重新校验版本/登录并拉取最新同步数据。
    // （原先只重载当前页数据，插件同步最慢 30 秒，点击后界面看起来没变化，容易被误认为"没反应"）
    window.location.reload();
  });
}

function reloadCurrentPage() {
  const fn = PAGE_LOADERS[currentPage];
  if (fn) Promise.resolve(fn()).catch(() => {});
}

window.addEventListener("hashchange", () => {
  const h = (location.hash || "").replace(/^#/, "");
  if (h && h !== currentPage) switchPage(h);
});

function switchPage(page) {
  currentPage = page;
  // hash 路由：让 /#rank 这类链接能直达对应页
  try {
    if (location.hash !== "#" + page) {
      history.replaceState(null, "", "#" + page);
    }
  } catch (e) {}
  stopChatPolling();
  stopBoardPolling();
  stopGomokuPolling();
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page),
  );
  document.querySelectorAll(".page").forEach((p) =>
    p.classList.toggle("hidden", p.id !== `page-${page}`),
  );
  closeSidebar();
  ensureRefreshButton(page);
  const fn = PAGE_LOADERS[page];
  if (fn) {
    Promise.resolve(fn()).catch(() => {});
  }
}

function bindSidebar() {
  document.querySelectorAll(".nav-item[data-page]").forEach((b) => {
    b.addEventListener("click", () => switchPage(b.dataset.page));
  });
  $("nav-toggle").addEventListener("click", () => {
    $("sidebar").classList.add("open");
    $("sidebar-mask").classList.remove("hidden");
  });
  $("sidebar-mask").addEventListener("click", closeSidebar);
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-mask").classList.add("hidden");
}

// ---------- 认证 ----------

function showAuth() {
  $("auth-view").classList.remove("hidden");
  $("pages").classList.add("hidden");
  $("login-info").textContent = "";
  $("login-info").classList.add("hidden");
  $("nav-toggle").classList.add("hidden");
  $("user-badge").classList.add("hidden");
  closeSidebar();
}

function showApp(user) {
  currentUser = user;
  $("auth-view").classList.add("hidden");
  $("pages").classList.remove("hidden");
  $("login-info").textContent = `已登录：${escapeHtml(user.username)}`;
  $("login-info").classList.remove("hidden");
  $("nav-toggle").classList.remove("hidden");
  $("user-badge").textContent = user.is_admin ? `管理员 · ${user.username}` : user.username;
  $("user-badge").classList.remove("hidden");
  $("nav-admin").classList.toggle("hidden", !user.is_admin);
  void loadAnnouncement();
  const savedPage = sessionStorage.getItem("points-current-page") || "points";
  switchPage(savedPage);
}

async function loadMe() {
  try {
    const data = await api("/api/me");
    if (data.status === "ok") {
      showApp(data.data);
    } else {
      showAuth();
    }
  } catch (e) {
    showAuth();
  }
}

function bindAuthTabs() {
  $("tab-login").addEventListener("click", () => {
    $("tab-login").classList.add("active");
    $("tab-register").classList.remove("active");
    $("login-form").classList.remove("hidden");
    $("register-form").classList.add("hidden");
    $("recover-form").classList.add("hidden");
  });
  $("tab-register").addEventListener("click", () => {
    $("tab-register").classList.add("active");
    $("tab-login").classList.remove("active");
    $("register-form").classList.remove("hidden");
    $("login-form").classList.add("hidden");
    $("recover-form").classList.add("hidden");
  });
  $("forgot-link").addEventListener("click", () => {
    $("login-form").classList.add("hidden");
    $("register-form").classList.add("hidden");
    $("recover-form").classList.remove("hidden");
    $("recover-result").textContent = "";
  });
  $("back-login-link").addEventListener("click", () => {
    $("recover-form").classList.add("hidden");
    $("login-form").classList.remove("hidden");
    $("tab-login").click();
  });
}

function bindLogin() {
  $("login-btn").addEventListener("click", async () => {
    const username = $("login-username").value.trim();
    const password = $("login-password").value;
    const out = $("login-result");
    if (!username || !password) {
      out.textContent = "请输入用户名和密码。";
      return;
    }
    out.textContent = "登录中…";
    try {
      const data = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      out.textContent = "";
      await loadMe();
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("login-btn").click();
  });
}

function bindRecover() {
  $("recover-btn").addEventListener("click", async () => {
    const username = $("recover-username").value.trim();
    const verifyId = $("recover-verify").value.trim();
    const password = $("recover-password").value;
    const out = $("recover-result");
    if (!username || !verifyId || !password) {
      out.textContent = "请填写完整信息。";
      return;
    }
    out.textContent = "提交中…";
    try {
      const data = await api("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, verify_id: verifyId, new_password: password }),
      });
      out.textContent = data.message || "已提交";
      if (data.status === "ok") {
        setTimeout(() => {
          $("recover-username").value = username;
          $("login-password").value = password;
          $("back-login-link").click();
          out.textContent = "密码已重置，请用新密码登录。";
        }, 3000);
      }
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

function bindRegister() {
  $("register-btn").addEventListener("click", async () => {
    const uid = $("reg-uid").value.trim();
    const verifyId = $("reg-verify").value.trim();
    const username = $("reg-username").value.trim();
    const password = $("reg-password").value;
    const out = $("register-result");
    if (!uid || !verifyId || !username || !password) {
      out.textContent = "请填写完整信息。";
      return;
    }
    out.textContent = "提交中…";
    try {
      const data = await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, verify_id: verifyId, username, password }),
      });
      out.textContent = data.message || "注册已提交";
      // 注册成功后自动登录（轮询直到账号同步到网站）
      await autoLoginAfterRegister(username, password);
      out.textContent = "注册成功，已自动登录！";
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

async function autoLoginAfterRegister(username, password) {
  const maxAttempts = 12;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const data = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (data.status === "ok") {
        await loadMe();
        return;
      }
    } catch (e) {
      // 账号还没同步，继续等
    }
  }
  $("register-result").textContent =
    "注册已提交，但账号尚未同步，请稍等几秒后用账号手动登录。";
  $("login-username").value = username;
  $("login-password").value = password;
  $("tab-login").click();
}

async function logout() {
  stopChatPolling();
  stopBoardPolling();
  stopGomokuPolling();
  gomokuGame = null;
  chatLoaded = false;
  boardLoaded = false;
  chatLastId = 0;
  await api("/api/logout", { method: "POST" });
  currentUser = null;
  sessionStorage.removeItem("points-current-page");
  showAuth();
}

// ---------- 我的积分 ----------

async function loadMyPoints() {
  let data;
  try {
    data = await api("/api/me/points");
  } catch (e) {
    return;
  }
  const d = data.data || {};
  const out = $("my-points");
  if (!d.found) {
    out.innerHTML = '<p class="hint">暂无积分数据（可能尚未同步）。</p>';
    return;
  }
  const u = d.user;
  out.innerHTML = `<div class="points-big">${fmtPoints(u.points)}</div>
    <span class="muted">积分余额 · 用户ID：${escapeHtml(u.user_id)}</span>`;
  renderPointsChart(u.ledger || []);
  renderLedgerList(u.ledger || [], 8);
}

function renderPointsChart(ledger, days = 14) {
  const box = $("points-chart");
  const bucket = {};
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    bucket[key] = 0;
  }
  (ledger || []).forEach((e) => {
    const key = fmtDate(e.t);
    if (key in bucket) bucket[key] += Number(e.delta || 0);
  });
  const keys = Object.keys(bucket);
  const values = keys.map((k) => bucket[k]);
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const barW = Math.min(36, Math.max(8, Math.floor(620 / keys.length)));
  const bars = keys
    .map((k, i) => {
      const v = bucket[k];
      const h = Math.max(1, Math.round((Math.abs(v) / max) * 110));
      const color = v >= 0 ? "#22c55e" : "#e5484d";
      const label = k.slice(5);
      return `<div class="chart-col" title="${k} ${v >= 0 ? "+" : ""}${v}">
        <div class="chart-bar" style="height:${h}px;background:${color}"></div>
        <span class="chart-label">${label}</span></div>`;
    })
    .join("");
  box.innerHTML = `<h3 class="card-title">近 ${days} 天积分变动</h3>
    <div class="chart">${bars}</div>`;
}

let ledgerFull = false;
function renderLedgerList(ledger, limit) {
  const box = $("my-ledger");
  if (!ledger.length) {
    box.innerHTML = '<p class="hint">暂无积分明细。</p>';
    return;
  }
  const items = ledgerFull ? ledger : ledger.slice(0, limit);
  const rows = items.map((e) => {
    const delta = Number(e.delta || 0);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "ledger-in" : "ledger-out";
    return `<div class="ledger-row">
      <span class="ledger-reason">${escapeHtml(e.reason || "其他")}${e.note ? `<i class="ledger-note"> · ${escapeHtml(e.note)}</i>` : ""}</span>
      <span class="ledger-balance">余额 ${fmtPoints(e.balance)}</span>
      <span class="${cls}">${sign}${fmtPoints(delta)}</span>
      <span class="hint">${fmtTime(e.t)}</span>
    </div>`;
  });
  box.innerHTML = rows.join("");
  $("ledger-more-btn").textContent = ledgerFull ? "收起" : "查看全部";
}

function renderLedgerFull(entries) {
  const box = $("my-ledger");
  const rows = entries.map((e) => {
    const delta = Number(e.delta || 0);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "ledger-in" : "ledger-out";
    return `<div class="ledger-row">
      <span class="ledger-reason">${escapeHtml(e.reason || "其他")}${e.note ? `<i class="ledger-note"> · ${escapeHtml(e.note)}</i>` : ""}</span>
      <span class="ledger-balance">余额 ${fmtPoints(e.balance)}</span>
      <span class="${cls}">${sign}${fmtPoints(delta)}</span>
      <span class="hint">${fmtTime(e.t)}</span>
    </div>`;
  });
  box.innerHTML = rows.join("");
}

// ---------- 签到 ----------

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

async function loadSignCalendar() {
  const data = await api("/api/me/sign_in/status");
  const d = data.data || {};
  const cal = d.calendar;
  if (!cal) {
    $("sign-calendar-title").textContent = "本月签到";
    $("sign-calendar").innerHTML = "";
    return;
  }
  $("sign-calendar-title").textContent = `${cal.year} 年 ${cal.month} 月签到`;
  const html = ["<div class='cal-week'>"];
  WEEKDAYS.forEach((w) => html.push(`<span class='cal-cell cal-weekday'>${w}</span>`));
  html.push("</div><div class='cal-grid'>");
  for (let i = 0; i < cal.first_weekday; i++) {
    html.push("<span class='cal-cell cal-empty'></span>");
  }
  cal.days.forEach((item) => {
    const isToday = item.day === cal.today;
    const cls = item.signed
      ? "cal-cell cal-signed"
      : isToday
        ? "cal-cell cal-today"
        : "cal-cell cal-missed";
    const mark = item.signed ? "√" : "×";
    html.push(`<span class="${cls}" title="${cal.month}月${item.day}日${item.signed ? "已签到" : "未签到"}">${item.day}<i>${mark}</i></span>`);
  });
  html.push("</div>");
  $("sign-calendar").innerHTML = html.join("");
  const todaySigned = d.last_sign_in === d.today;
  $("sign-btn").disabled = todaySigned;
  $("sign-btn").textContent = todaySigned ? "今日已签到" : "签到";
}

async function checkSignResult() {
  try {
    const data = await api("/api/me/sign_in_result");
    const items = (data.data && data.data.items) || [];
    if (!items.length) return;
    const last = items[0];
    const out = $("sign-result");
    if (last.status === "done") {
      out.textContent = `✅ ${last.message}（${fmtTime(last.created_at)}）`;
    } else if (last.status === "failed") {
      out.textContent = `❌ ${last.message}（${fmtTime(last.created_at)}）`;
    }
  } catch (e) {
    /* ignore */
  }
}

function bindSignIn() {
  $("sign-btn").addEventListener("click", async () => {
    const out = $("sign-result");
    out.textContent = "提交中…";
    try {
      const data = await api("/api/sign_in", { method: "POST" });
      out.textContent = data.message || "已提交";
      await loadSignCalendar();
      setTimeout(checkSignResult, 3500);
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 照片墙 ----------

async function loadWall() {
  const data = await api(`/api/wall?sort=${wallSort}&page=${wallPage}`);
  const d = data.data || {};
  wallPages = d.pages || 1;
  const grid = $("wall-grid");
  grid.innerHTML = "";
  const items = d.items || [];
  if (!items.length) {
    grid.innerHTML = '<p class="hint">照片墙空空如也，先去上传一张吧。</p>';
    $("wall-prev").disabled = true;
    $("wall-next").disabled = true;
    $("wall-page-info").textContent = "";
    return;
  }
  items.forEach((img) => {
    const item = document.createElement("div");
    item.className = "wall-item";
    const owner = img.owner_name || img.owner_user_id || "匿名";
    const liked = img.liked_by_me;
    item.innerHTML = `
      <img src="${escapeHtml(img.url)}" alt="图片" loading="lazy"/>
      <div class="wall-meta">
        <span class="wall-owner">${escapeHtml(owner)}</span>
        <span class="hint">${fmtTime(img.created_at)}</span>
      </div>
      <div class="wall-actions">
        <button class="btn wall-like ${liked ? "active" : ""}" data-id="${escapeHtml(img.id)}">👍 <span>${Number(img.like_count || 0)}</span></button>
        <button class="btn wall-tip" data-id="${escapeHtml(img.id)}">💗 ${Number(img.total_tips || 0)}</button>
        <button class="btn wall-fav ${img.favorited_by_me ? "active" : ""}" data-id="${escapeHtml(img.id)}">${img.favorited_by_me ? "⭐" : "☆"}</button>
      </div>`;
    grid.appendChild(item);
    item.querySelector(".wall-like").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api("/api/wall/like", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_id: btn.dataset.id }),
        });
        $("wall-result").textContent = r.message || "已提交";
        setTimeout(loadWall, 3500);
      } catch (err) {
        $("wall-result").textContent = err.message;
        btn.disabled = false;
      }
    });
    item.querySelector(".wall-tip").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const amount = prompt("赞赏多少积分？（将转给图片作者）", "1");
      if (amount === null) return;
      const n = Number(amount);
      if (!Number.isInteger(n) || n < 1) {
        $("wall-result").textContent = "请输入大于 0 的整数积分。";
        return;
      }
      btn.disabled = true;
      try {
        const r = await api("/api/tip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_id: btn.dataset.id, amount: n }),
        });
        $("wall-result").textContent = r.message || "已提交";
        setTimeout(loadWall, 3500);
      } catch (err) {
        $("wall-result").textContent = err.message;
        btn.disabled = false;
      }
    });
    item.querySelector(".wall-fav").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api("/api/wall/favorite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_id: btn.dataset.id }),
        });
        $("wall-result").textContent = r.message || "已提交";
        setTimeout(loadWall, 3500);
      } catch (err) {
        $("wall-result").textContent = err.message;
        btn.disabled = false;
      }
    });
  });
  $("wall-prev").disabled = wallPage <= 1;
  $("wall-next").disabled = wallPage >= wallPages;
  $("wall-page-info").textContent = `第 ${wallPage} / ${wallPages} 页 · 共 ${d.total} 张`;
}

function bindWall() {
  $("wall-sort-latest").addEventListener("click", () => {
    wallSort = "latest";
    wallPage = 1;
    $("wall-sort-latest").classList.add("active");
    $("wall-sort-likes").classList.remove("active");
    void loadWall();
  });
  $("wall-sort-likes").addEventListener("click", () => {
    wallSort = "likes";
    wallPage = 1;
    $("wall-sort-likes").classList.add("active");
    $("wall-sort-latest").classList.remove("active");
    void loadWall();
  });
  $("wall-prev").addEventListener("click", () => {
    if (wallPage > 1) {
      wallPage -= 1;
      void loadWall();
    }
  });
  $("wall-next").addEventListener("click", () => {
    if (wallPage < wallPages) {
      wallPage += 1;
      void loadWall();
    }
  });
}

// ---------- 图片 ----------

function bindUpload() {
  $("upload-btn").addEventListener("click", () => $("upload-file").click());
  $("upload-file").addEventListener("change", async () => {
    const file = $("upload-file").files[0];
    const out = $("upload-result");
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    out.textContent = "上传中…";
    try {
      const data = await api("/api/upload", { method: "POST", body: fd });
      out.textContent = data.message || "上传成功";
      $("upload-file").value = "";
      await loadMyImages();
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

async function loadMyImages() {
  const data = await api("/api/me/images");
  const items = (data.data && data.data.items) || [];
  const grid = $("my-images");
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = '<p class="hint">暂无图片。</p>';
    return;
  }
  items.forEach((img) => {
    const item = document.createElement("div");
    item.className = "image-item";
    item.innerHTML = `<img src="${escapeHtml(img.url)}" alt="图片" loading="lazy"/><span class="hint">${escapeHtml(img.filename || "")} · ${fmtTime(img.created_at)}</span>`;
    grid.appendChild(item);
  });
}

async function loadRandomImage() {
  const data = await api("/api/me/random_image");
  const d = data.data || {};
  const box = $("random-box");
  if (!d.found) {
    box.classList.remove("hidden");
    box.innerHTML = '<p class="hint">你还没有上传过图片。</p>';
    return;
  }
  const img = d.image;
  box.classList.remove("hidden");
  box.innerHTML = `<img src="${escapeHtml(img.url)}" alt="图片" /><p class="hint">${escapeHtml(img.filename || "")} · ${fmtTime(img.created_at)}</p>`;
}

function bindRandom() {
  $("random-btn").addEventListener("click", () => void loadRandomImage());
}

// ---------- 兑换码 ----------

function bindRedeem() {
  $("redeem-btn").addEventListener("click", async () => {
    const code = $("redeem-code").value.trim();
    const out = $("redeem-result");
    if (!code) {
      out.textContent = "请输入兑换码。";
      return;
    }
    out.textContent = "提交中…";
    try {
      const data = await api("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      out.textContent = data.message || "兑换已提交";
      $("redeem-code").value = "";
      await loadRedeemHistory();
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

async function loadRedeemHistory() {
  const data = await api("/api/me/redeem_result");
  const items = (data.data && data.data.items) || [];
  const box = $("redeem-history");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无兑换记录。</p>';
    return;
  }
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const tag = item.status === "done" ? "✅ 成功" : item.status === "failed" ? "❌ 失败" : "⏳ 处理中";
    div.innerHTML = `<span class="code">${escapeHtml(item.code)}</span> ${tag} ${escapeHtml(item.message || "")}<br/><span class="hint">${fmtTime(item.created_at)}</span>`;
    box.appendChild(div);
  });
}

// ---------- 商城 ----------

async function loadShop() {
  const [shopData, pointsData] = await Promise.all([
    api("/api/shop"),
    api("/api/me/points"),
  ]);
  const products = (shopData.data && shopData.data.products) || [];
  const myPoints = (pointsData.data && pointsData.data.user && pointsData.data.user.points) || 0;
  $("shop-my-points").textContent = `我的积分：${fmtPoints(myPoints)}`;
  const grid = $("shop-products");
  grid.innerHTML = "";
  if (!products.length) {
    grid.innerHTML = '<p class="hint">商城暂无商品。</p>';
    return;
  }
  products.forEach((p) => {
    const item = document.createElement("div");
    item.className = "shop-item";
    const stockText = p.stock < 0 ? "∞" : String(p.stock);
    const soldOut = p.stock === 0;
    item.innerHTML = `
      <div class="shop-name">${escapeHtml(p.name)}</div>
      <div class="shop-desc">${escapeHtml(p.desc || "")}</div>
      <div class="shop-cost">${fmtPoints(p.cost)} 积分</div>
      <div class="shop-stock">库存 ${stockText}</div>
      <button class="btn ${soldOut ? "btn-disabled" : "btn-primary"} shop-buy" data-id="${escapeHtml(p.id)}" ${soldOut ? "disabled" : ""}>${soldOut ? "已售罄" : "兑换"}</button>
    `;
    grid.appendChild(item);
  });
  grid.querySelectorAll(".shop-buy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const data = await api("/api/shop/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: btn.dataset.id }),
        });
        alert(data.message || "兑换已提交");
        setTimeout(loadShop, 3500);
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
  });
}

// ---------- 抽奖 ----------

async function loadLottery() {
  const [data, splitData] = await Promise.all([
    api("/api/lottery/info"),
    api("/api/split/info").catch(() => ({ status: "error" })),
  ]);
  const d = data.data || {};
  const box = $("lottery-box");
  const prizes = d.prizes || [];
  const rows = prizes
    .map((p) => `<div class="lottery-prize"><span>${escapeHtml(p.name)}</span><span>${p.points > 0 ? `+${p.points}` : "无"}积分</span></div>`)
    .join("");
  box.innerHTML = `
    <div class="lottery-hero">
      <span class="lottery-cost">单次消耗 <b>${fmtPoints(d.cost)}</b> 积分</span>
      <button id="lottery-spin-btn" class="btn btn-primary">开 抽</button>
      <span class="hint">我的余额：${fmtPoints(d.balance)}</span>
    </div>
    <div class="lottery-prizes">${rows}</div>`;
  $("lottery-spin-btn").addEventListener("click", async () => {
    const btn = $("lottery-spin-btn");
    btn.disabled = true;
    $("lottery-my-result").textContent = "开抽中…";
    try {
      const r = await api("/api/lottery", { method: "POST" });
      $("lottery-my-result").textContent = r.message || "已提交";
      setTimeout(loadLottery, 3500);
    } catch (e) {
      $("lottery-my-result").textContent = e.message;
      btn.disabled = false;
    }
  });
  const myBox = $("lottery-my");
  myBox.innerHTML = "";
  const mySpins = d.my_spins || [];
  if (!mySpins.length) {
    myBox.innerHTML = '<p class="hint">还没有抽过奖。</p>';
  }
  mySpins.forEach((e) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const tag = e.reason === "抽奖中奖" ? "🎉" : "🎰";
    div.innerHTML = `${tag} ${escapeHtml(e.reason)} ${Number(e.delta) > 0 ? "+" : ""}${Number(e.delta)} · ${escapeHtml(e.note || "")}<br/><span class="hint">${fmtTime(e.t)}</span>`;
    myBox.appendChild(div);
  });
  const logBox = $("lottery-log");
  logBox.innerHTML = "";
  const log = d.log || [];
  if (!log.length) {
    logBox.innerHTML = '<p class="hint">暂无中奖记录。</p>';
  }
  log.slice(0, 20).forEach((e) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `${escapeHtml(e.user_name || e.user_id)} 抽中「${escapeHtml(e.prize_name)}」${e.prize_points > 0 ? `+${e.prize_points}积分` : "（无积分）"}<br/><span class="hint">${fmtTime(e.t)}</span>`;
    logBox.appendChild(div);
  });
  renderSplit(splitData);
}

// ---------- 瓜分池 ----------

function renderSplit(data) {
  const s = (data && data.data) || {};
  const box = $("split-box");
  const grabbed = !!s.grabbed;
  const finished = !!s.finished;
  const btnState = grabbed
    ? "已参与本轮瓜分"
    : finished
      ? "已瓜分完"
      : s.balance > 0
        ? "瓜 分"
        : "待开启";
  const disabled = grabbed || finished || !(s.balance > 0);
  box.innerHTML = `
    <div class="split-hero">
      <div class="split-balance">
        <span class="split-label">剩余瓜分池</span>
        <span class="split-amount">${fmtPoints(s.balance)}</span>
      </div>
      <button id="split-grab-btn" class="btn btn-primary ${disabled ? "btn-disabled" : ""}" ${disabled ? "disabled" : ""}>${btnState}</button>
      <span class="hint">单次 ${Number(s.min_share)} ~ ${Number(s.max_share)} 积分 · 每人限一次</span>
    </div>`;
  $("split-grab-btn").addEventListener("click", async () => {
    const btn = $("split-grab-btn");
    btn.disabled = true;
    $("split-result").textContent = "瓜分中…";
    try {
      const r = await api("/api/split", { method: "POST" });
      $("split-result").textContent = r.message || "已提交";
      setTimeout(loadLottery, 3500);
    } catch (e) {
      $("split-result").textContent = e.message;
      btn.disabled = false;
    }
  });
  const recBox = $("split-records");
  recBox.innerHTML = "";
  const records = s.records || [];
  if (!records.length) {
    recBox.innerHTML = '<p class="hint">本轮还没有人瓜分。</p>';
  }
  records.slice(0, 30).forEach((r) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `${escapeHtml(r.user_name || r.user_id)} 瓜分了 <b class="split-in">+${Number(r.amount)}</b> 积分<br/><span class="hint">${fmtTime(r.t)}</span>`;
    recBox.appendChild(div);
  });
}

// ---------- 排行榜 ----------

let rankPeriod = "all";

async function loadLeaderboard() {
  const data = await api(`/api/leaderboard?period=${rankPeriod}&limit=100`);
  const items = (data.data && data.data.items) || [];
  const body = $("leaderboard-body");
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="3" class="hint">暂无数据</td></tr>';
    return;
  }
  items.forEach((u) => {
    const medal = u.rank === 1 ? "🥇" : u.rank === 2 ? "🥈" : u.rank === 3 ? "🥉" : String(u.rank);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${medal}</td><td>${escapeHtml(u.name)}</td><td class="strong">${fmtPoints(u.points)}</td>`;
    body.appendChild(tr);
  });
}

function bindRank() {
  $("rank-all").addEventListener("click", () => {
    rankPeriod = "all";
    $("rank-all").classList.add("active");
    $("rank-week").classList.remove("active");
    $("rank-month").classList.remove("active");
    void loadLeaderboard();
  });
  $("rank-week").addEventListener("click", () => {
    rankPeriod = "week";
    $("rank-week").classList.add("active");
    $("rank-all").classList.remove("active");
    $("rank-month").classList.remove("active");
    void loadLeaderboard();
  });
  $("rank-month").addEventListener("click", () => {
    rankPeriod = "month";
    $("rank-month").classList.add("active");
    $("rank-all").classList.remove("active");
    $("rank-week").classList.remove("active");
    void loadLeaderboard();
  });
}

// ---------- 个人资料 ----------

async function loadProfile() {
  const [pointsData, imagesData] = await Promise.all([
    api("/api/me/points").catch(() => ({ data: {} })),
    api("/api/me/images").catch(() => ({ data: {} })),
  ]);
  const u = (pointsData.data && pointsData.data.user) || {};
  const myImages = (imagesData.data && imagesData.data.items) || [];
  const uid = currentUser ? String(currentUser.uid || "") : "";
  let avatar = /^\d+$/.test(uid)
    ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uid)}&s=100`
    : "";
  if (!avatar && myImages.length) avatar = myImages[0].url;
  $("profile-avatar").innerHTML = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="头像" referrerpolicy="no-referrer"/>`
    : `<span>👤</span>`;
  $("profile-info").innerHTML =
    `当前用户名：${currentUser ? escapeHtml(currentUser.username) : "-"} · 用户ID：${currentUser ? escapeHtml(currentUser.uid) : "-"}` +
    (u.sign_in_streak ? `<br/><span class="hint">连续签到 ${u.sign_in_streak} 天 · 累计签到 ${u.total_sign_in_days || 0} 天</span>` : "");
  renderBadges(u, myImages.length);
  const [meData] = await Promise.all([api("/api/me").catch(() => ({}))]);
  const bio = (meData.data && meData.data.bio) || "";
  if (bio) $("profile-bio").value = bio;
  const uidBox = $("profile-uid-code");
  if (uidBox) uidBox.value = (meData.data && meData.data.uid_code) || "";
  void loadBindRequests();
}

async function loadBindRequests() {
  const box = $("bind-request-list");
  if (!box) return;
  box.innerHTML = '<span class="hint">加载中…</span>';
  try {
    const data = await api("/api/me/bind_requests");
    const items = (data.data && data.data.items) || [];
    if (!items.length) {
      box.innerHTML = '<span class="hint">暂无绑定请求。</span>';
      return;
    }
    const label = { pending: "待确认", confirmed: "已确认", rejected: "已拒绝" };
    box.innerHTML = items
      .map((it) => {
        const st = label[it.status] || escapeHtml(it.status || "");
        const canAct = it.status === "pending";
        return (
          `<div class="bind-item" data-key="${escapeHtml(it.key)}">` +
          `<div>${escapeHtml(it.platform || "")} · ${escapeHtml(it.user_name || it.user_id || "")}</div>` +
          `<div class="hint">状态：${st}</div>` +
          (canAct
            ? '<div class="row"><button class="btn bind-ok">确认</button><button class="btn bind-no">拒绝</button></div>'
            : "") +
          "</div>"
        );
      })
      .join("");
  } catch (e) {
    box.innerHTML = `<span class="hint">${escapeHtml(e.message)}</span>`;
  }
}

function renderBadges(u, imageCount) {
  const badges = [];
  const points = Number(u.points || 0);
  if (points >= 10000) badges.push(["💎", "十万分", "积分达到 10000"]);
  else if (points >= 1000) badges.push(["🥇", "千分大佬", "积分达到 1000"]);
  if (u.sign_in_streak >= 7) badges.push(["🔥", `连签${u.sign_in_streak}`, "连续签到7天以上"]);
  if ((u.total_sign_in_days || 0) >= 30) badges.push(["📅", "月全勤", "累计签到30天"]);
  if (imageCount >= 5) badges.push(["📷", "摄影家", "上传5张图片"]);
  if (Number(u.total_tips_received || 0) > 0) badges.push(["💗", "被赞赏", "收到过赞赏"]);
  const box = $("profile-badges");
  if (!badges.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = badges
    .map((b) => `<span class="badge" title="${escapeHtml(b[2])}">${b[0]} ${escapeHtml(b[1])}</span>`)
    .join("");
}

function bindProfile() {
  const bindBox = $("bind-request-list");
  if (bindBox) {
    bindBox.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      const item = btn ? btn.closest(".bind-item") : null;
      if (!btn || !item) return;
      const key = item.getAttribute("data-key");
      const isOk = btn.classList.contains("bind-ok");
      btn.disabled = true;
      try {
        await api(isOk ? "/api/me/bind/confirm" : "/api/me/bind/reject", {
          method: "POST",
          body: JSON.stringify({ key: key }),
        });
        await loadBindRequests();
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
  const uidCopy = $("profile-uid-copy");
  if (uidCopy) {
    uidCopy.addEventListener("click", async () => {
      const box = $("profile-uid-code");
      const v = box ? box.value : "";
      try {
        await navigator.clipboard.writeText(v);
        uidCopy.textContent = "已复制";
      } catch (e) {
        uidCopy.textContent = "请手动复制";
      }
      setTimeout(() => { uidCopy.textContent = "复制"; }, 1500);
    });
  }
  const bindRefresh = $("bind-request-refresh");
  if (bindRefresh) bindRefresh.addEventListener("click", () => void loadBindRequests());
  $("ledger-more-btn").addEventListener("click", () => {
    ledgerFull = !ledgerFull;
    void loadMyPoints();
  });
  $("ledger-all-btn").addEventListener("click", async () => {
    const box = $("my-ledger");
    box.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const data = await api("/api/me/ledger/all");
      const items = (data.data && data.data.items) || [];
      if (!items.length) {
        box.innerHTML = '<p class="hint">暂无积分使用记录。</p>';
        return;
      }
      renderLedgerFull(items);
    } catch (e) {
      box.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
    }
  });
  $("profile-bio-btn").addEventListener("click", async () => {
    const bio = $("profile-bio").value.trim();
    const out = $("profile-result");
    out.textContent = "保存中…";
    try {
      const data = await api("/api/me/bio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio }),
      });
      out.textContent = data.message || "已提交";
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $("profile-rename-btn").addEventListener("click", async () => {
    const newUsername = $("profile-new-username").value.trim();
    const verifyId = $("profile-verify-id").value.trim();
    const out = $("profile-result");
    if (!newUsername) {
      out.textContent = "请输入新用户名。";
      return;
    }
    if (!verifyId) {
      out.textContent = "请先私聊机器人获取cookieQQ并填写。";
      return;
    }
    try {
      const data = await api("/api/me/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          new_username: newUsername,
          verify_id: verifyId,
        }),
      });
      out.textContent = data.message || "已提交";
      void confirmProfileRename(newUsername);
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $("profile-password-btn").addEventListener("click", async () => {
    const newPassword = $("profile-new-password").value;
    const verifyId = $("profile-verify-id").value.trim();
    const out = $("profile-result");
    if (!newPassword) {
      out.textContent = "请输入新密码。";
      return;
    }
    if (!verifyId) {
      out.textContent = "请先私聊机器人获取cookieQQ并填写。";
      return;
    }
    try {
      const data = await api("/api/me/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "password",
          new_password: newPassword,
          verify_id: verifyId,
        }),
      });
      out.textContent = data.message || "已提交";
      $("profile-new-password").value = "";
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $("transfer-btn").addEventListener("click", async () => {
    const targetUid = $("transfer-uid").value.trim();
    const amount = Number($("transfer-amount").value);
    const verifyId = $("profile-verify-id").value.trim();
    const out = $("transfer-result");
    if (!targetUid) {
      out.textContent = "请输入目标用户ID。";
      return;
    }
    if (!Number.isInteger(amount) || amount < 1) {
      out.textContent = "请输入大于 0 的整数积分。";
      return;
    }
    if (!verifyId) {
      out.textContent = "请先私聊机器人获取cookieQQ并填写。";
      return;
    }
    out.textContent = "转账中…";
    try {
      const data = await api("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_uid: targetUid, amount, verify_id: verifyId }),
      });
      out.textContent = data.message || "已提交";
      $("transfer-uid").value = "";
      $("transfer-amount").value = "";
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 管理员：用户 ----------

async function loadAdminUsers() {
  const data = await api("/api/admin/users");
  const items = (data.data && data.data.items) || [];
  const body = $("admin-users-body");
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="hint">暂无用户</td></tr>';
    return;
  }
  items.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-ellipsis">${escapeHtml(u.user_id)}</td>
      <td>${escapeHtml(u.display_name || u.user_name || "-")}</td>
      <td class="strong"><span id="points-${escapeHtml(u.user_id)}">${fmtPoints(u.points)}</span></td>
      <td>${escapeHtml(u.platform_label || u.platform)}</td>
      <td class="row-actions">
        <button class="btn" data-act="add" data-uid="${escapeHtml(u.user_id)}" data-platform="${escapeHtml(u.platform)}">+积分</button>
        <button class="btn" data-act="blacklist" data-uid="${escapeHtml(u.user_id)}" data-platform="${escapeHtml(u.platform)}">${u.blacklisted ? "解拉黑" : "拉黑"}</button>
        <button class="btn" data-act="mail" data-uid="${escapeHtml(u.user_id)}" data-name="${escapeHtml(u.user_name || "")}">📧 邮件</button>
      </td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const uid = btn.dataset.uid;
      const platform = btn.dataset.platform;
      if (act === "add") {
        const value = prompt(`给 ${uid} 增加多少积分？`);
        if (value === null) return;
        await adminOp({ op: "add_points", platform, user_id: uid, value: Number(value) || 0 });
        void loadAdminUsers();
      } else if (act === "blacklist") {
        await adminOp({ op: "blacklist", platform, user_id: uid, blacklisted: !btn.textContent.includes("解") });
        void loadAdminUsers();
      } else if (act === "mail") {
        const content = prompt(`给用户 ${uid}（${btn.dataset.name || ""}）发送站内信内容：`, "");
        if (content === null || !content.trim()) return;
        try {
          const r = await api("/api/admin/mail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to_uid: uid, subject: "系统通知", content: content.trim() }),
          });
          alert(r.message || "已发送");
        } catch (e) {
          alert(e.message);
        }
      }
    });
  });
}

// ---------- 管理员：账号管理 ----------

async function loadAdminAccounts() {
  const data = await api("/api/admin/accounts");
  const items = (data.data && data.data.items) || [];
  const body = $("admin-accounts-body");
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">暂无网站账号</td></tr>';
    return;
  }
  items.forEach((a) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.uid)}</td>
      <td class="acc-pw">${a.password ? escapeHtml(a.password) : '<span class="hint">未存明文</span>'}</td>
      <td>${a.enabled ? "正常" : '<span class="text-danger">禁用</span>'}</td>
      <td>${a.is_admin ? '<span class="badge">管理员</span>' : "普通"}</td>
      <td class="row-actions">
        <button class="btn" data-act="rename" data-user="${escapeHtml(a.username)}">改名</button>
        <button class="btn" data-act="password" data-user="${escapeHtml(a.username)}">改密码</button>
        <button class="btn" data-act="enabled" data-user="${escapeHtml(a.username)}">${a.enabled ? "禁用" : "启用"}</button>
        <button class="btn" data-act="admin" data-user="${escapeHtml(a.username)}">${a.is_admin ? "取消管理员" : "设管理员"}</button>
        <button class="btn btn-danger" data-act="delete" data-user="${escapeHtml(a.username)}">删除</button>
      </td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const user = btn.dataset.user;
      const out = $("admin-accounts-result");
      let payload = { op: "account", target: user };
      if (act === "rename") {
        const value = prompt(`把账号「${user}」改名为：`, user);
        if (value === null || !value.trim()) return;
        payload.account_action = "rename";
        payload.value = value.trim();
      } else if (act === "password") {
        const value = prompt(`给账号「${user}」设置新密码（至少6位）：`, "");
        if (value === null || !value.trim()) return;
        payload.account_action = "password";
        payload.value = value.trim();
      } else if (act === "enabled") {
        payload.account_action = "enabled";
        payload.value = btn.textContent.includes("启用");
      } else if (act === "admin") {
        payload.account_action = "admin";
        payload.value = btn.textContent.includes("设管理员");
      } else if (act === "delete") {
        if (!confirm(`确定删除网站账号「${user}」？`)) return;
        payload.account_action = "delete";
      }
      try {
        const r = await api("/api/admin/op", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        out.textContent = r.message || "已提交";
        void loadAdminAccounts();
      } catch (e) {
        out.textContent = e.message;
      }
    });
  });
}

// ---------- 管理员：图片 ----------

async function loadAdminImages() {
  const data = await api("/api/admin/images");
  const items = (data.data && data.data.items) || [];
  const grid = $("admin-images");
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = '<p class="hint">暂无图片</p>';
    return;
  }
  items.forEach((img) => {
    const item = document.createElement("div");
    item.className = "image-item";
    item.innerHTML = `<img src="${escapeHtml(img.url)}" alt="图片" loading="lazy"/>
      <span class="hint">${escapeHtml(img.owner_name || img.owner_user_id || "")}</span>
      <button class="btn btn-danger" data-id="${escapeHtml(img.id)}">删除</button>`;
    grid.appendChild(item);
    item.querySelector("button").addEventListener("click", async () => {
      if (!confirm("确定删除这张图片吗？")) return;
      await adminOp({ op: "delete_image", image_id: img.id });
      void loadAdminImages();
    });
  });
}

// ---------- 管理员：商城 ----------

async function loadAdminShop() {
  const data = await api("/api/admin/shop");
  const d = data.data || {};
  const products = d.products || [];
  const orders = d.orders || [];
  let html = "<h3>商品</h3><div class='shop-grid'>";
  if (!products.length) html += '<p class="hint">暂无商品</p>';
  products.forEach((p) => {
    html += `<div class="shop-item"><div class="shop-name">${escapeHtml(p.name)}</div>
      <div class="shop-cost">${p.cost} 积分</div><div class="shop-stock">库存 ${p.stock < 0 ? "∞" : p.stock}</div>
      <button class="btn btn-danger" data-pid="${escapeHtml(p.id)}">删除</button></div>`;
  });
  html += "</div><h3>订单</h3>";
  if (!orders.length) html += '<p class="hint">暂无订单</p>';
  html += "<div class='history'>";
  orders.slice(0, 50).forEach((o) => {
    html += `<div class="history-item">${escapeHtml(o.product_name)} · ${escapeHtml(o.user_name || o.user_id)} · ${o.cost}积分 · ${o.status === "pending" ? "待发货" : o.status === "done" ? "已发货" : "已取消"}
      ${o.status === "pending" ? `<button class="btn" data-oid="${escapeHtml(o.id)}">发货</button>` : ""}</div>`;
  });
  html += "</div>";
  const box = $("admin-shop");
  box.innerHTML = html;
  box.querySelectorAll("button[data-pid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确定删除该商品吗？")) return;
      await adminOp({ op: "delete_product", product_id: btn.dataset.pid });
      void loadAdminShop();
    });
  });
  box.querySelectorAll("button[data-oid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await adminOp({ op: "deliver", order_id: btn.dataset.oid });
      void loadAdminShop();
    });
  });
}

// ---------- 管理员：漂流瓶 ----------

async function loadAdminBottles() {
  const data = await api("/api/admin/bottles");
  const items = (data.data && data.data.items) || [];
  const box = $("admin-bottles");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无漂流瓶</p>';
    return;
  }
  items.forEach((b) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `<b>${escapeHtml(b.id)}</b> · ${escapeHtml(b.author_name || "匿名")} · ${b.status}
      <br/>${escapeHtml((b.content || "").slice(0, 60))}
      <div class="row-actions">
        <button class="btn" data-id="${escapeHtml(b.id)}" data-act="approve">通过</button>
        <button class="btn" data-id="${escapeHtml(b.id)}" data-act="takedown">下架</button>
        <button class="btn btn-danger" data-id="${escapeHtml(b.id)}" data-act="ban">封禁</button>
        <button class="btn btn-danger" data-id="${escapeHtml(b.id)}" data-act="delete">删除</button>
      </div>`;
    box.appendChild(div);
    div.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.act === "delete" && !confirm("确定删除该漂流瓶吗？")) return;
        await adminOp({ op: "bottle_action", bottle_id: btn.dataset.id, action: btn.dataset.act });
        void loadAdminBottles();
      });
    });
  });
}

// ---------- 管理员：公告 ----------

async function loadAdminAnnouncement() {
  const data = await api("/api/announcements");
  const d = data.data || {};
  $("admin-announcement-current").textContent = d.content
    ? `当前公告：${escapeHtml(d.content)}（${fmtTime(d.updated_at)}）`
    : "当前暂无公告。";
  $("admin-announcement-input").value = d.content || "";
  $("admin-announcement-result").textContent = "";
}

function bindAdminAnnouncement() {
  $("admin-announcement-btn").addEventListener("click", async () => {
    const content = $("admin-announcement-input").value.trim();
    const out = $("admin-announcement-result");
    out.textContent = "提交中…";
    try {
      const data = await api("/api/admin/announcement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      out.textContent = data.message || "已保存";
      void loadAdminAnnouncement();
      void loadAnnouncement();
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 管理员：抽奖 / 瓜分池 ----------

function prizeRow(p) {
  p = p || {};
  return `<div class="prize-row">
    <input type="text" placeholder="名称（如 一等奖）" class="prize-name" value="${escapeHtml(p.name || "")}" />
    <input type="number" min="0" placeholder="积分" class="prize-points" value="${Number(p.points || 0)}" />
    <input type="number" min="0" placeholder="权重" class="prize-weight" value="${Number(p.weight || 1)}" />
    <button class="btn btn-danger prize-del">删除</button>
  </div>`;
}

function prizeRows() {
  return Array.from(document.querySelectorAll("#admin-lottery-prizes .prize-row")).map((row) => ({
    name: row.querySelector(".prize-name").value.trim(),
    points: Number(row.querySelector(".prize-points").value) || 0,
    weight: Number(row.querySelector(".prize-weight").value) || 0,
  }));
}

function renderPrizeEditor(prizes) {
  const box = $("admin-lottery-prizes");
  box.innerHTML = "<div class='prize-head'><span>奖品名称</span><span>积分</span><span>权重</span><span></span></div>" +
    (prizes.length ? prizes.map(prizeRow).join("") : prizeRow());
  box.querySelectorAll(".prize-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".prize-row").remove();
    });
  });
}

async function loadAdminLottery() {
  const data = await api("/api/admin/lottery");
  const d = data.data || {};
  $("admin-lottery-cost").value = d.cost || 10;
  renderPrizeEditor(d.prizes || []);
  const s = d.split || {};
  $("admin-split-balance").value = s.balance || 0;
  $("admin-split-min").value = s.min_share || 1;
  $("admin-split-max").value = s.max_share || 50;
  $("admin-split-result").textContent = s.finished ? "当前瓜分池已瓜分完，可重新设置余额开启新一轮。" : "";
  const recBox = $("admin-split-records");
  recBox.innerHTML = "";
  const records = s.records || [];
  if (!records.length) {
    recBox.innerHTML = '<p class="hint">本轮暂无瓜分记录。</p>';
  }
  records.slice(0, 50).forEach((r) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `${escapeHtml(r.user_name || r.user_id)} · +${Number(r.amount)} 积分<br/><span class="hint">${fmtTime(r.t)}</span>`;
    recBox.appendChild(div);
  });
  $("admin-lottery-result").textContent = "";
}

function bindAdminLottery() {
  $("admin-lottery-add-prize").addEventListener("click", () => {
    const box = $("admin-lottery-prizes");
    box.insertAdjacentHTML("beforeend", prizeRow());
    box.querySelector(".prize-row:last-child .prize-del").addEventListener("click", (e) => {
      e.target.closest(".prize-row").remove();
    });
  });
  $("admin-lottery-save").addEventListener("click", async () => {
    const cost = Number($("admin-lottery-cost").value) || 0;
    const prizes = prizeRows().filter((p) => p.name);
    const out = $("admin-lottery-result");
    if (cost < 1) {
      out.textContent = "单次消耗积分需大于 0。";
      return;
    }
    if (!prizes.length) {
      out.textContent = "至少需要一个有效奖品。";
      return;
    }
    out.textContent = "保存中…";
    try {
      const data = await api("/api/admin/lottery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cost, prizes }),
      });
      out.textContent = data.message || "已提交";
    } catch (e) {
      out.textContent = e.message;
    }
  });
  $("admin-split-save").addEventListener("click", async () => {
    const balance = Number($("admin-split-balance").value) || 0;
    const minShare = Number($("admin-split-min").value) || 1;
    const maxShare = Number($("admin-split-max").value) || minShare;
    const out = $("admin-split-result");
    out.textContent = "保存中…";
    try {
      const data = await api("/api/admin/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance, min_share: minShare, max_share: maxShare }),
      });
      out.textContent = data.message || "已提交";
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 站内邮箱 ----------

async function loadMail() {
  let data;
  try {
    data = await api("/api/mail/inbox");
  } catch (e) {
    return;
  }
  const d = data.data || {};
  const box = $("mail-list");
  box.innerHTML = "";
  const items = d.items || [];
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无邮件，点右上角「写邮件」。</p>';
    return;
  }
  items.forEach((m) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const dir = m.mine ? "→ 发给" : "← 来自";
    const other = m.mine ? m.to_name : m.from_name;
    const unreadMark = !m.mine && !m.read ? "🔴" : "";
    const claimBtn = !m.mine && m.points > 0 && !m.claimed
      ? `<button class="btn btn-sm btn-primary mail-claim" data-id="${escapeHtml(m.id)}">领取 ${m.points} 积分</button>`
      : !m.mine && m.points > 0 && m.claimed
        ? `<span class="hint">积分已领取</span>`
        : "";
    div.innerHTML = `<div class="mail-item">
      <div class="mail-head">
        <span class="mail-subject">${unreadMark} ${escapeHtml(m.subject || "(无主题)")}</span>
        <span class="hint">${escapeHtml(dir)} ${escapeHtml(other)} · ${fmtTime(m.created_at)}</span>
      </div>
      <div class="mail-content">${escapeHtml(m.content)}</div>
      <div class="row-actions">${claimBtn}</div>
    </div>`;
    box.appendChild(div);
    if (!m.mine && !m.read) {
      void api("/api/mail/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mail_id: m.id }),
      });
    }
  });
  box.querySelectorAll(".mail-claim").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      $("mail-compose-result").textContent = "领取中…";
      try {
        const r = await api("/api/mail/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mail_id: btn.dataset.id }),
        });
        alert(r.message || "已提交");
        await loadMail();
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
  });
}

function bindMail() {
  $("mail-compose-btn").addEventListener("click", () => {
    $("mail-compose-overlay").classList.remove("hidden");
    $("mail-compose-result").textContent = "";
  });
  $("mail-cancel-btn").addEventListener("click", () => {
    $("mail-compose-overlay").classList.add("hidden");
  });
  $("mail-send-btn").addEventListener("click", async () => {
    const to = $("mail-to").value.trim();
    const subject = $("mail-subject").value.trim();
    const content = $("mail-content").value.trim();
    const points = Number($("mail-points").value) || 0;
    const out = $("mail-compose-result");
    if (!to) {
      out.textContent = "请填写收件人。";
      return;
    }
    if (!content) {
      out.textContent = "请填写内容。";
      return;
    }
    out.textContent = "发送中…";
    try {
      const r = await api("/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, content, points }),
      });
      out.textContent = r.message || "已发送";
      if (r.status === "ok") {
        $("mail-compose-overlay").classList.add("hidden");
        $("mail-to").value = "";
        $("mail-subject").value = "";
        $("mail-content").value = "";
        $("mail-points").value = "";
        await loadMail();
      }
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 意见反馈 ----------

async function loadFeedbackMine() {
  let data;
  try {
    data = await api("/api/feedback/mine");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("feedback-mine");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">还没有提交过反馈。</p>';
    return;
  }
  items.forEach((f) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const statusTag = f.status ? "✅ 已处理" : "⏳ 待处理";
    div.innerHTML = `<b>${statusTag}</b> ${escapeHtml(f.content)}
      ${f.reply ? `<br/>管理员回复：${escapeHtml(f.reply)}` : ""}
      <br/><span class="hint">${fmtTime(f.created_at)}</span>`;
    box.appendChild(div);
  });
}

function bindFeedback() {
  $("feedback-submit-btn").addEventListener("click", async () => {
    const input = $("feedback-input");
    const content = input.value.trim();
    const out = $("feedback-result");
    if (!content) {
      out.textContent = "请输入反馈内容。";
      return;
    }
    out.textContent = "提交中…";
    try {
      const r = await api("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      out.textContent = r.message || "已提交";
      input.value = "";
      await loadFeedbackMine();
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

async function loadAdminFeedback() {
  let data;
  try {
    data = await api("/api/admin/feedback");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("admin-feedback-list");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无反馈。</p>';
    return;
  }
  items.forEach((f) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const statusTag = f.status ? "✅" : "⏳";
    div.innerHTML = `${statusTag} <b>${escapeHtml(f.username)}</b>（${escapeHtml(f.uid)}）· ${fmtTime(f.created_at)}
      <br/>${escapeHtml(f.content)}
      ${f.reply ? `<div class="hint">已回复：${escapeHtml(f.reply)}</div>` : ""}
      <div class="row-actions">
        <button class="btn btn-sm admin-fb-reply" data-id="${escapeHtml(f.id)}">回复</button>
      </div>`;
    box.appendChild(div);
  });
  box.querySelectorAll(".admin-fb-reply").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const reply = prompt("回复内容：", "");
      if (reply === null) return;
      try {
        await api("/api/admin/feedback/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: btn.dataset.id, reply: reply.trim() }),
        });
        await loadAdminFeedback();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

// ---------- 管理员：全服积分记录 ----------

let adminLedgerUid = "";

async function loadAdminLedger() {
  let data;
  try {
    data = await api(`/api/admin/ledger?uid=${encodeURIComponent(adminLedgerUid)}&limit=1000`);
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const body = $("admin-ledger-body");
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">暂无记录</td></tr>';
    return;
  }
  items.slice(0, 500).forEach((e) => {
    const tr = document.createElement("tr");
    const delta = Number(e.delta || 0);
    const sign = delta > 0 ? "+" : "";
    const cls = delta >= 0 ? "ledger-in" : "ledger-out";
    tr.innerHTML = `<td class="hint">${fmtTime(e.t)}</td>
      <td>${escapeHtml(e.name)}</td>
      <td class="${cls}">${sign}${fmtPoints(delta)}</td>
      <td>${escapeHtml(e.reason || "-")}</td>
      <td>${escapeHtml(e.note || "-")}</td>
      <td class="strong">${fmtPoints(e.balance)}</td>`;
    body.appendChild(tr);
  });
}

function bindAdminLedger() {
  $("admin-ledger-filter").addEventListener("click", () => {
    adminLedgerUid = $("admin-ledger-uid").value.trim();
    void loadAdminLedger();
  });
  $("admin-ledger-broadcast").addEventListener("click", async () => {
    const subject = prompt("全服邮件主题（可留空）：", "");
    if (subject === null) return;
    const content = prompt("全服邮件内容：", "");
    if (content === null || !content.trim()) {
      alert("内容不能为空。");
      return;
    }
    try {
      const r = await api("/api/admin/mail/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), content: content.trim() }),
      });
      alert(r.message || "已发送");
    } catch (e) {
      alert(e.message);
    }
  });
}

// ---------- 每日任务 ----------

async function loadTasks() {
  let data;
  try {
    data = await api("/api/tasks");
  } catch (e) {
    return;
  }
  const tasks = (data.data && data.data.tasks) || [];
  const box = $("tasks-list");
  box.innerHTML = "";
  if (!tasks.length) {
    box.innerHTML = '<p class="hint">暂无任务。</p>';
    return;
  }
  tasks.forEach((t) => {
    const div = document.createElement("div");
    div.className = "task-item";
    const btnState = t.claimed
      ? "已领取"
      : t.done
        ? `领取 ${t.reward} 积分`
        : "未完成";
    div.innerHTML = `
      <div class="task-info">
        <div class="task-name">${t.done ? "✅" : "⬜"} ${escapeHtml(t.label)}</div>
        <div class="task-reward">奖励 +${t.reward} 积分</div>
      </div>
      <button class="btn ${t.done && !t.claimed ? "btn-primary" : ""} task-claim" data-key="${escapeHtml(t.key)}" ${t.claimed || !t.done ? "disabled" : ""}>${btnState}</button>`;
    box.appendChild(div);
  });
  box.querySelectorAll(".task-claim").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      $("tasks-result").textContent = "领取中…";
      try {
        const r = await api("/api/tasks/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: btn.dataset.key }),
        });
        $("tasks-result").textContent = r.message || "已提交";
        setTimeout(loadTasks, 3000);
      } catch (e) {
        $("tasks-result").textContent = e.message;
        btn.disabled = false;
      }
    });
  });
}

// ---------- 竞拍 ----------

async function loadAuction() {
  let data;
  try {
    data = await api("/api/auction");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("auction-list");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无进行中的竞拍。</p>';
    return;
  }
  items.forEach((a) => {
    const div = document.createElement("div");
    div.className = "auction-item";
    const endsIn = Math.max(0, Math.floor((a.ends_at - Date.now() / 1000) / 60));
    const topLabel = a.is_top
      ? `<span class="hint">您是当前最高出价者</span>`
      : `<span class="hint">当前最高：${escapeHtml(a.current_bidder_name || "-")} ${a.current_bid} 积分</span>`;
    div.innerHTML = `
      <div class="auction-name">${escapeHtml(a.name)} ${a.finished ? "(已结束)" : ""}</div>
      <div class="auction-desc">${escapeHtml(a.desc || "")}</div>
      <div class="auction-meta">起拍 ${a.start_price} · 加价 ${a.increment} · 剩余约 ${endsIn} 分钟</div>
      <div class="auction-bid-row">
        ${topLabel}
        <input type="number" class="auction-amount" placeholder="出价≥${a.current_bid + a.increment}" />
        <button class="btn btn-primary auction-bid-btn" data-id="${escapeHtml(a.id)}" ${a.finished || a.is_top ? "disabled" : ""}>出 价</button>
      </div>`;
    box.appendChild(div);
    div.querySelector(".auction-bid-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const amount = Number(btn.closest(".auction-bid-row").querySelector(".auction-amount").value);
      if (!Number.isInteger(amount) || amount < 1) {
        $("auction-result").textContent = "请输入有效的出价。";
        return;
      }
      btn.disabled = true;
      $("auction-result").textContent = "出价中…";
      try {
        const r = await api("/api/auction/bid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auction_id: btn.dataset.id, amount }),
        });
        $("auction-result").textContent = r.message || "已提交";
        setTimeout(loadAuction, 3000);
      } catch (e) {
        $("auction-result").textContent = e.message;
        btn.disabled = false;
      }
    });
  });
}

// ---------- 我的收藏 ----------

async function loadFavorites() {
  let data;
  try {
    data = await api("/api/me/favorites");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const grid = $("favorites-grid");
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = '<p class="hint">还没有收藏的图片。</p>';
    return;
  }
  items.forEach((img) => {
    const item = document.createElement("div");
    item.className = "image-item";
    item.innerHTML = `<img src="${escapeHtml(img.url)}" alt="图片" loading="lazy"/><span class="hint">${escapeHtml(img.owner_name || "")}</span>`;
    grid.appendChild(item);
  });
}

// ---------- 管理员：生成兑换码 ----------

async function loadAdminRedeemGen() {
  $("admin-redeem-gen-codes").innerHTML = "";
  $("admin-redeem-gen-result").textContent = "";
}

function bindAdminRedeemGen() {
  $("admin-redeem-gen-btn").addEventListener("click", async () => {
    const points = Number($("admin-redeem-points").value) || 0;
    const count = Number($("admin-redeem-count").value) || 0;
    const out = $("admin-redeem-gen-result");
    if (points < 1 || count < 1) {
      out.textContent = "请输入有效的积分与数量。";
      return;
    }
    out.textContent = "生成中…";
    try {
      const r = await api("/api/admin/redeem/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points, count }),
      });
      out.textContent = r.message || "已提交";
      setTimeout(async () => {
        // 轮询等待兑换码回传
        for (let i = 0; i < 6; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const data = await api("/api/admin/redeem_codes?recent=1").catch(() => ({}));
          out.textContent = "已生成，可在机器人 Web 管理页查看兑换码。";
          break;
        }
      }, 1000);
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 管理员：竞拍 ----------

async function loadAdminAuction() {
  let data;
  try {
    data = await api("/api/auction");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("admin-auction-all");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">暂无竞拍。</p>';
    return;
  }
  items.forEach((a) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `${escapeHtml(a.name)} · 当前 ${a.current_bid} 积分 · ${escapeHtml(a.current_bidder_name || "-")} · ${a.finished ? "已结束" : `剩 ${Math.max(0, Math.floor((a.ends_at - Date.now() / 1000) / 60))} 分钟`}<br/><span class="hint">${fmtTime(a.created_at)}</span>`;
    box.appendChild(div);
  });
}

function bindAdminAuction() {
  $("admin-auction-create-btn").addEventListener("click", async () => {
    const name = $("admin-auction-name").value.trim();
    const desc = $("admin-auction-desc").value.trim();
    const start = Number($("admin-auction-start").value) || 0;
    const increment = Number($("admin-auction-increment").value) || 1;
    const duration = Number($("admin-auction-duration").value) || 24;
    const out = $("admin-auction-result");
    if (!name) {
      out.textContent = "请填写商品名称。";
      return;
    }
    out.textContent = "创建中…";
    try {
      const r = await api("/api/admin/auction/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, desc, start_price: start, increment, duration_hours: duration }),
      });
      out.textContent = r.message || "已提交";
      $("admin-auction-name").value = "";
      $("admin-auction-desc").value = "";
      setTimeout(loadAdminAuction, 3000);
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ---------- 管理员通用 ----------

async function adminOp(payload) {
  try {
    const data = await api("/api/admin/op", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    alert(data.message || "已提交");
  } catch (e) {
    alert(e.message);
  }
}

// 改用户名后轮询等待插件同步生效，成功后刷新会话与界面（避免改完掉登录）。
async function confirmProfileRename(newUsername) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const data = await api("/api/me");
      if (data.status === "ok" && data.data) {
        if (data.data.username === newUsername) {
          showApp(data.data);
          $("profile-result").textContent = "用户名已修改成功。";
          return;
        }
        continue;
      }
    } catch (e) {
      continue;
    }
  }
  $("profile-result").textContent = "修改已提交，若稍后仍未生效请重新登录。";
  void loadMe();
}

// ---------- 五子棋（联机房间，1v1，2秒轮询） ----------

const GOMOKU_SIZE = 15;
let gomokuGame = null;
let gomokuTimer = null;
let gomokuMyColor = 0; // 1=黑(先手) 2=白(后手)

function startGomokuPolling() {
  if (gomokuTimer) return;
  gomokuTimer = setInterval(() => void loadGomokuState(), 2000);
}

function stopGomokuPolling() {
  if (gomokuTimer) {
    clearInterval(gomokuTimer);
    gomokuTimer = null;
  }
}

async function loadGomoku() {
  await loadGomokuTick();
  startGomokuPolling();
}

async function loadGomokuTick() {
  // 每 2 秒刷新：当前对局 + 大厅全部等待加入的房间（一键加入列表实时更新）
  const data = await api("/api/gomoku/me");
  const d = (data.data) || {};
  gomokuGame = d.active || null;
  gomokuMyColor = 0;
  if (gomokuGame) {
    if (gomokuGame.player_black_uid === String(currentUser.uid)) gomokuMyColor = 1;
    else if (gomokuGame.player_white_uid === String(currentUser.uid)) gomokuMyColor = 2;
  }
  renderGomokuLobby(d.waiting || []);
  renderGomokuGame();
}

function gomokuAvatar(uid) {
  uid = String(uid || "");
  if (/^\d+$/.test(uid)) {
    return `<img src="https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uid)}&s=100" alt="" referrerpolicy="no-referrer"/>`;
  }
  const letter = (uid || "?").charAt(0).toUpperCase();
  let hue = 0;
  for (const ch of uid) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="gm-avatar-letter" style="background:hsl(${hue},60%,55%)">${escapeHtml(letter)}</span>`;
}

function gomokuPlayerCard(label, uid, name, color, isTurn, qq) {
  const stone = `<span class="gm-stone gm-stone-${color}"></span>`;
  const turn = isTurn ? '<em class="gm-turn-tag">落子中</em>' : "";
  return `<div class="gm-player${isTurn ? " gm-active" : ""}">
    ${stone}
    <span class="gm-avatar">${gomokuAvatar(qq || uid)}</span>
    <div class="gm-info">
      <div class="gm-name">${escapeHtml(name || "?")} ${turn}</div>
      <div class="gm-qq">QQ：${escapeHtml(qq || uid)}</div>
    </div>
    <span class="gm-side">${label}</span>
  </div>`;
}

function renderGomokuLobby(waiting) {
  const box = $("gomoku-waiting");
  if (!waiting.length) {
    box.innerHTML = '<p class="hint">暂无等待中的房间，点击「创建房间」或输入房间号加入。</p>';
    return;
  }
  box.innerHTML = waiting
    .map(
      (g) => `<div class="gomoku-room-item">
        <span class="gm-avatar">${gomokuAvatar(g.player_black_qq || g.player_black_uid)}</span>
        <span>${escapeHtml(g.player_black_name || g.player_black_uid)} 创建的房间</span>
        <span class="hint">房间号：${escapeHtml(g.game_id)}</span>
        <button class="btn" data-join="${escapeHtml(g.game_id)}">加入</button>
      </div>`
    )
    .join("");
  box.querySelectorAll("button[data-join]").forEach((btn) => {
    btn.addEventListener("click", () => void gomokuJoin(btn.dataset.join));
  });
}

function renderGomokuGame() {
  const roomEl = $("gomoku-room");
  const gameEl = $("gomoku-game");
  const lobbyEl = $("gomoku-lobby");
  const out = $("gomoku-result");
  if (!gomokuGame) {
    roomEl.classList.add("hidden");
    gameEl.classList.add("hidden");
    lobbyEl.classList.remove("hidden");
    out.textContent = "";
    return;
  }
  if (gomokuGame.status === "waiting") {
    roomEl.classList.remove("hidden");
    gameEl.classList.add("hidden");
    lobbyEl.classList.add("hidden");
    out.textContent = "";
    roomEl.innerHTML = `<div class="gomoku-room-wait">
      <h3>房间已创建，等待对手加入…</h3>
      <p>房间号：<b class="gm-code">${escapeHtml(gomokuGame.game_id)}</b>  （可发给朋友让他「加入房间」）</p>
      <p class="hint">你执黑先手</p>
      <button id="gomoku-cancel-btn" class="btn btn-danger">取消房间</button>
    </div>`;
    $("gomoku-cancel-btn").addEventListener("click", () => void gomokuResign());
    return;
  }
  roomEl.classList.add("hidden");
  lobbyEl.classList.add("hidden");
  gameEl.classList.remove("hidden");
  out.textContent = "";

  const blackUid = gomokuGame.player_black_uid;
  const whiteUid = gomokuGame.player_white_uid;
  const isBlack = gomokuMyColor === 1;
  const turn = gomokuGame.current_turn;
  const myTurn = gomokuGame.status === "playing" && turn === gomokuMyColor;
  const myCard = gomokuPlayerCard(
    isBlack ? "我 · 黑" : "我 · 白",
    isBlack ? blackUid : whiteUid,
    isBlack ? gomokuGame.player_black_name : gomokuGame.player_white_name,
    isBlack ? 1 : 2,
    myTurn && gomokuGame.status === "playing",
    isBlack ? gomokuGame.player_black_qq : gomokuGame.player_white_qq
  );
  const opCard = gomokuPlayerCard(
    isBlack ? "对方 · 白" : "对方 · 黑",
    isBlack ? whiteUid : blackUid,
    isBlack ? gomokuGame.player_white_name : gomokuGame.player_black_name,
    isBlack ? 2 : 1,
    !myTurn && gomokuGame.status === "playing",
    isBlack ? gomokuGame.player_white_qq : gomokuGame.player_black_qq
  );
  $("gomoku-players").innerHTML = isBlack
    ? myCard + opCard
    : opCard + myCard;

  const board = gomokuGame.board || [];
  const lastMove = gomokuGame.last_move || null;
  const boardEl = $("gomoku-board");
  boardEl.innerHTML = "";
  boardEl.style.gridTemplateColumns = `repeat(${GOMOKU_SIZE}, 1fr)`;
  for (let r = 0; r < GOMOKU_SIZE; r++) {
    for (let c = 0; c < GOMOKU_SIZE; c++) {
      const cell = document.createElement("button");
      cell.className = "gm-cell";
      cell.type = "button";
      cell.dataset.r = r;
      cell.dataset.c = c;
      const v = board[r] ? board[r][c] : 0;
      if (v === 1) cell.classList.add("gm-stone-black");
      else if (v === 2) cell.classList.add("gm-stone-white");
      else if (gomokuGame.status === "playing" && myTurn) cell.classList.add("gm-empty");
      if (lastMove && lastMove.r === r && lastMove.c === c && v) cell.classList.add("gm-last");
      if (gomokuGame.status === "playing" && myTurn) {
        cell.addEventListener("click", () => void gomokuMove(r, c));
      }
      boardEl.appendChild(cell);
    }
  }

  let statusText = "";
  if (gomokuGame.status === "waiting") {
    statusText = "等待对手加入…";
  } else if (gomokuGame.status === "playing") {
    statusText = myTurn ? "轮到你落子（点击棋盘）" : "等待对方落子…";
  } else {
    if (gomokuGame.winner) {
      const winnerUid = gomokuGame.winner === 1 ? blackUid : whiteUid;
      statusText =
        winnerUid === String(currentUser.uid)
          ? "🎉 你赢了！"
          : gomokuGame.resign_by
            ? "对方认输，你赢了！"
            : "你输了";
    } else {
      statusText = "对局结束";
    }
  }
  $("gomoku-status").textContent = statusText;

  const resignBtn = $("gomoku-resign-btn");
  resignBtn.textContent = gomokuGame.status === "finished" ? "离开" : "认输 / 离开";

  renderGomokuChat();
}

function renderGomokuChat() {
  const box = $("gomoku-chat");
  if (!gomokuGame) return;
  const chat = gomokuGame.chat || [];
  if (!chat.length) {
    box.innerHTML = '<p class="hint">暂无消息，开始聊天吧。</p>';
    return;
  }
  const myUid = String(currentUser.uid);
  box.innerHTML = chat
    .map((m) => {
      const mine =
        String(m.uid) === myUid ||
        String(m.uid) === (currentUser ? currentUser.uid_code : "") ||
        (!!m.qq && String(m.qq) === myUid);
      return `<div class="chat-msg ${mine ? "mine" : ""}">
        <span class="chat-avatar">${gomokuAvatar(m.qq || m.uid)}</span>
        <div class="chat-bubble">
          <div class="chat-meta">${escapeHtml(m.name || m.uid)}</div>
          <div class="chat-text">${escapeHtml(m.content)}</div>
        </div>
      </div>`;
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

async function gomokuCreate() {
  const out = $("gomoku-result");
  out.textContent = "创建中…";
  try {
    const data = await api("/api/gomoku/create", { method: "POST" });
    out.textContent = data.message || "已创建";
    await loadGomoku();
  } catch (e) {
    out.textContent = e.message;
  }
}

async function gomokuJoin(gameId) {
  const out = $("gomoku-result");
  out.textContent = "加入中…";
  try {
    const data = await api("/api/gomoku/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId }),
    });
    out.textContent = data.message || "已加入";
    await loadGomoku();
  } catch (e) {
    out.textContent = e.message;
  }
}

async function gomokuMove(r, c) {
  if (!gomokuGame) return;
  try {
    await api("/api/gomoku/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gomokuGame.game_id, r, c }),
    });
    await loadGomokuState();
  } catch (e) {
    $("gomoku-result").textContent = e.message;
  }
}

async function gomokuChat() {
  const input = $("gomoku-chat-input");
  const content = input.value.trim();
  if (!content || !gomokuGame) return;
  input.value = "";
  try {
    await api("/api/gomoku/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gomokuGame.game_id, content }),
    });
    await loadGomokuState();
  } catch (e) {
    $("gomoku-result").textContent = e.message;
  }
}

async function gomokuResign() {
  if (!gomokuGame) return;
  if (!confirm("确定要认输 / 离开当前对局吗？")) return;
  try {
    const data = await api("/api/gomoku/resign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gomokuGame.game_id }),
    });
    $("gomoku-result").textContent = data.message || "已离开";
    gomokuGame = null;
    await loadGomoku();
  } catch (e) {
    $("gomoku-result").textContent = e.message;
  }
}

function bindGomoku() {
  $("gomoku-create-btn").addEventListener("click", () => void gomokuCreate());
  $("gomoku-join-btn").addEventListener("click", () => {
    const code = $("gomoku-join-code").value.trim();
    if (!code) {
      $("gomoku-result").textContent = "请输入房间号。";
      return;
    }
    void gomokuJoin(code);
  });
  $("gomoku-resign-btn").addEventListener("click", () => void gomokuResign());
  $("gomoku-chat-send-btn").addEventListener("click", () => void gomokuChat());
  $("gomoku-chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void gomokuChat();
  });
}

// ---------- 聊天室（3秒轮询） ----------

let chatLastId = 0;
let chatTimer = null;
let chatLoaded = false;

// 通用：服务端已解析好的 avatar 优先，否则退回本地按 QQ 取
function userAvatar(item, name) {
  const url = item && item.avatar;
  if (url) {
    return `<span class="chat-avatar"><img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" /></span>`;
  }
  return qqAvatar(
    item && (item.qq || item.author_uid || item.uid),
    name || (item && (item.author_name || item.username)),
  );
}

function qqAvatar(uid, name) {
  uid = String(uid || "");
  name = String(name || "");
  const safeUid = /^\d+$/.test(uid) ? uid : "";
  if (safeUid) {
    return `<span class="chat-avatar"><img src="https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(safeUid)}&s=100" alt="" referrerpolicy="no-referrer" /></span>`;
  }
  const letter = (name || "?").charAt(0).toUpperCase();
  let hue = 0;
  for (const ch of uid + name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="chat-avatar chat-avatar-letter" style="background:hsl(${hue},60%,55%)">${escapeHtml(letter)}</span>`;
}

function startChatPolling() {
  if (chatTimer) return;
  chatTimer = setInterval(() => void loadChatMessages(), 3000);
}

function stopChatPolling() {
  if (chatTimer) {
    clearInterval(chatTimer);
    chatTimer = null;
  }
}

async function loadChat() {
  chatLoaded = true;
  await loadChatMessages();
  await loadChatRedpackets();
  startChatPolling();
}

async function loadChatMessages() {
  if (!chatLoaded || currentPage !== "chat") return;
  let data;
  try {
    data = await api(`/api/chat/messages?after_id=${chatLastId}&limit=100`);
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("chat-messages");
  if (chatLastId === 0) box.innerHTML = "";
  const meUid = currentUser ? currentUser.uid : "";
  const meCode = currentUser ? (currentUser.uid_code || "") : "";
  let newCount = 0;
  items.forEach((m) => {
    if (m.id <= chatLastId && chatLastId > 0) return;
    // 兼容新旧数据：老消息用 QQ 记，新消息用永久 UID 记
    const mine =
      String(m.uid) === String(meCode) ||
      String(m.uid) === String(meUid) ||
      (!!m.qq && String(m.qq) === String(meUid));
    const div = document.createElement("div");
    div.className = `chat-msg ${mine ? "mine" : ""}`;
    const replyBlock = m.reply
      ? `<div class="chat-reply-quote">↩ ${escapeHtml(m.reply.username)}：${escapeHtml(m.reply.content)}</div>`
      : "";
    div.innerHTML = `
      ${mine ? "" : qqAvatar(m.qq || m.uid, m.username)}
      <div class="chat-bubble" data-mid="${m.id}">
        <div class="chat-name">${escapeHtml(m.username)}</div>
        ${replyBlock}
        <div class="chat-text">${escapeHtml(m.content)}</div>
        <div class="chat-time">${fmtTime(m.created_at)} <button class="chat-reply-link btn-sm" data-mid="${m.id}" data-name="${escapeHtml(m.username)}">回复</button></div>
      </div>
      ${mine ? qqAvatar(m.qq || m.uid, m.username) : ""}`;
    box.appendChild(div);
    if (m.id > chatLastId) chatLastId = m.id;
    newCount++;
  });
  if (newCount > 0) box.scrollTop = box.scrollHeight;
  box.querySelectorAll(".chat-reply-link").forEach((btn) => {
    btn.addEventListener("click", () => setChatReply(btn.dataset.mid, btn.dataset.name));
  });
}

let chatReplyId = 0;
let chatReplyName = "";

function setChatReply(mid, name) {
  chatReplyId = Number(mid || 0);
  chatReplyName = decodeURIComponent(String(name || ""));
  const bar = $("chat-reply-bar");
  if (!chatReplyId) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `回复 @${escapeHtml(chatReplyName)} <button class="btn btn-sm" id="chat-reply-cancel">取消</button>`;
  $("chat-reply-cancel").addEventListener("click", () => {
    chatReplyId = 0;
    chatReplyName = "";
    bar.classList.add("hidden");
  });
}

async function loadChatRedpackets() {
  if (currentPage !== "chat") return;
  let data;
  try {
    data = await api("/api/redpackets");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("chat-redpackets");
  if (!items.length) {
    box.innerHTML = "";
    return;
  }
  const html = items
    .map((p) => {
      const modeLabel = p.mode === "fixed" ? "均分" : "拼手气";
      const btn = p.mine
        ? `<button class="btn btn-disabled" disabled>我发的</button>`
        : p.grabbed
          ? `<button class="btn btn-disabled" disabled>已抢过</button>`
          : `<button class="btn btn-primary rp-grab" data-id="${escapeHtml(p.id)}">抢</button>`;
      return `<div class="rp-card">
        <span class="rp-emoji">🧧</span>
        <div class="rp-info">
          <div class="rp-title">${escapeHtml(p.sender_name)} 的红包（${modeLabel}）</div>
          <div class="rp-meta">剩 ${fmtPoints(p.remaining)}/${fmtPoints(p.total)} 积分 · 已领 ${p.claims.length}/${p.count} 份</div>
        </div>
        ${btn}
      </div>`;
    })
    .join("");
  box.innerHTML = `<div class="rp-list">${html}</div>`;
  box.querySelectorAll(".rp-grab").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      $("chat-result").textContent = "抢红包中…";
      try {
        const r = await api("/api/redpackets/grab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packet_id: b.dataset.id }),
        });
        $("chat-result").textContent = r.message || "已提交";
        setTimeout(() => void loadChatRedpackets(), 3500);
        setTimeout(() => void loadMyPoints(), 4000);
      } catch (err) {
        $("chat-result").textContent = err.message;
        b.disabled = false;
      }
    });
  });
}

function bindChat() {
  $("chat-send-btn").addEventListener("click", () => void sendChatMessage());
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });
  $("chat-dice-btn").addEventListener("click", () => {
    const roll = Math.floor(Math.random() * 6) + 1;
    const slot = Math.floor(Math.random() * 100) % 7;
    const emojis = ["🍒", "🍋", "🔔", "⭐", "7️⃣", "🍉", "💎"];
    $("chat-input").value = `🎲 掷出 ${roll}`;
    void sendChatMessage();
    setTimeout(() => {
      $("chat-input").value = `🎰 ${emojis[slot]} ${emojis[(slot + 1) % 7]} ${emojis[(slot + 2) % 7]}`;
      void sendChatMessage();
    }, 800);
  });
  $("chat-img-btn").addEventListener("click", () => $("chat-img-file").click());
  $("chat-img-file").addEventListener("change", async () => {
    const file = $("chat-img-file").files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    $("chat-result").textContent = "图片上传中…";
    try {
      const data = await api("/api/upload", { method: "POST", body: fd });
      const url = data.data && data.data.url;
      if (!url) {
        $("chat-result").textContent = "图片上传失败";
        return;
      }
      $("chat-img-file").value = "";
      await api("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `[图片] ${url}`, reply_to_id: chatReplyId || 0 }),
      });
      chatReplyId = 0;
      chatReplyName = "";
      $("chat-reply-bar").classList.add("hidden");
      $("chat-result").textContent = "";
      await loadChatMessages();
    } catch (e) {
      $("chat-result").textContent = e.message;
    }
  });
  $("chat-redpacket-btn").addEventListener("click", async () => {
    const total = prompt("红包总金额（积分）：", "100");
    if (total === null) return;
    const totalN = Number(total);
    if (!Number.isInteger(totalN) || totalN < 1) {
      $("chat-result").textContent = "请输入大于 0 的整数金额。";
      return;
    }
    const count = prompt("红包份数：", "5");
    if (count === null) return;
    const countN = Number(count);
    if (!Number.isInteger(countN) || countN < 1) {
      $("chat-result").textContent = "请输入大于 0 的整数份数。";
      return;
    }
    if (countN > 100) {
      $("chat-result").textContent = "红包份数最多 100 份。";
      return;
    }
    if (totalN < countN) {
      $("chat-result").textContent = "红包总金额不能少于份数。";
      return;
    }
    const mode = confirm("是否均分？（取消则拼手气）") ? "fixed" : "random";
    $("chat-result").textContent = "发红包中…";
    try {
      const r = await api("/api/redpackets/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total: totalN, count: countN, mode }),
      });
      $("chat-result").textContent = r.message || "已提交";
      setTimeout(() => void loadChatRedpackets(), 3500);
      setTimeout(() => void loadMyPoints(), 4000);
    } catch (e) {
      $("chat-result").textContent = e.message;
    }
  });
}

async function sendChatMessage() {
  const input = $("chat-input");
  const content = input.value.trim();
  if (!content) return;
  input.value = "";
  $("chat-result").textContent = "发送中…";
  try {
    const r = await api("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, reply_to_id: chatReplyId || 0 }),
    });
    chatReplyId = 0;
    chatReplyName = "";
    $("chat-reply-bar").classList.add("hidden");
    $("chat-result").textContent = "";
    await loadChatMessages();
  } catch (e) {
    $("chat-result").textContent = e.message;
    input.value = content;
  }
}

// ---------- 留言板（1分钟刷新） ----------

let boardTimer = null;
let boardLoaded = false;

function startBoardPolling() {
  if (boardTimer) return;
  boardTimer = setInterval(() => void loadBoard(), 60000);
}

function stopBoardPolling() {
  if (boardTimer) {
    clearInterval(boardTimer);
    boardTimer = null;
  }
}

async function loadBoard() {
  boardLoaded = true;
  if (currentPage !== "board") return;
  let data;
  try {
    data = await api("/api/board");
  } catch (e) {
    return;
  }
  const items = (data.data && data.data.items) || [];
  const box = $("board-list");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="hint">还没有留言，来抢个沙发吧。</p>';
    startBoardPolling();
    return;
  }
  items.forEach((m) => {
    const div = document.createElement("div");
    div.className = "board-item";
    const likeLabel = m.liked_by_me ? "已赞" : `赞 ${m.like_count}`;
    const deleteBtn = m.mine || currentUser.is_admin
      ? `<button class="btn btn-danger btn-sm board-del" data-id="${escapeHtml(m.id)}">删除</button>`
      : "";
    const pinBtn = currentUser.is_admin
      ? `<button class="btn btn-sm board-pin" data-id="${escapeHtml(m.id)}">${m.pinned ? "取消置顶" : "置顶"}</button>`
      : "";
    div.innerHTML = `
      <div class="board-head">
        ${userAvatar(m, m.author_name)}
        <div class="board-author">
          <b>${escapeHtml(m.author_name)}</b>
          ${m.pinned ? '<span class="badge">📌 置顶</span>' : ""}
          <span class="hint">${fmtTime(m.created_at)}</span>
        </div>
        <div class="row-actions">
          <button class="btn btn-sm board-like" data-id="${escapeHtml(m.id)}">${m.liked_by_me ? "❤️" : "🤍"} ${m.like_count}</button>
          <button class="btn btn-sm board-reply-toggle" data-id="${escapeHtml(m.id)}">回复</button>
          ${pinBtn}
          ${deleteBtn}
        </div>
      </div>
      <div class="board-content">${escapeHtml(m.content)}</div>
      <div class="board-replies">
        ${m.replies.map((r) => `
          <div class="board-reply">
            ${userAvatar(r, r.author_name)}
            <div class="board-reply-body">
              <div><b>${escapeHtml(r.author_name)}</b> <span class="hint">${fmtTime(r.created_at)}</span>
                ${(r.mine || currentUser.is_admin) ? `<button class="btn btn-danger btn-sm board-reply-del" data-mid="${escapeHtml(m.id)}" data-rid="${escapeHtml(r.id)}">删</button>` : ""}
              </div>
              <div>${escapeHtml(r.content)}</div>
            </div>
          </div>`).join("")}
        <div class="board-reply-input hidden" data-mid="${escapeHtml(m.id)}">
          <input type="text" placeholder="回复…（最多200字）" maxlength="200" />
          <button class="btn btn-sm btn-primary board-reply-send">回复</button>
        </div>
      </div>`;
    box.appendChild(div);
  });
  bindBoardActions(box);
  startBoardPolling();
}

function bindBoardActions(root) {
  root.querySelectorAll(".board-like").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/api/board/like", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: btn.dataset.id }),
        });
        await loadBoard();
      } catch (e) {
        btn.disabled = false;
        $("board-result").textContent = e.message;
      }
    });
  });
  root.querySelectorAll(".board-reply-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const box = root.querySelector(`.board-reply-input[data-mid="${btn.dataset.id}"]`);
      if (box) box.classList.toggle("hidden");
    });
  });
  root.querySelectorAll(".board-reply-send").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const box = btn.closest(".board-reply-input");
      const input = box.querySelector("input");
      const content = input.value.trim();
      if (!content) return;
      btn.disabled = true;
      try {
        await api("/api/board/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: box.dataset.mid, content }),
        });
        await loadBoard();
      } catch (e) {
        btn.disabled = false;
        $("board-result").textContent = e.message;
      }
    });
  });
  root.querySelectorAll(".board-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确定删除这条留言吗？")) return;
      try {
        await api("/api/board/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: btn.dataset.id }),
        });
        await loadBoard();
      } catch (e) {
        $("board-result").textContent = e.message;
      }
    });
  });
  root.querySelectorAll(".board-reply-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确定删除这条回复吗？")) return;
      try {
        await api("/api/board/delete_reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: btn.dataset.mid, reply_id: btn.dataset.rid }),
        });
        await loadBoard();
      } catch (e) {
        $("board-result").textContent = e.message;
      }
    });
  });
  root.querySelectorAll(".board-pin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const isPinned = btn.textContent.includes("取消");
        await api("/api/board/pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: btn.dataset.id, pinned: !isPinned }),
        });
        await loadBoard();
      } catch (e) {
        $("board-result").textContent = e.message;
      }
    });
  });
}

function bindBoard() {
  $("board-post-btn").addEventListener("click", async () => {
    const input = $("board-input");
    const content = input.value.trim();
    if (!content) {
      $("board-result").textContent = "请输入留言内容。";
      return;
    }
    $("board-result").textContent = "发布中…";
    try {
      const r = await api("/api/board/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      $("board-result").textContent = r.message || "已发布";
      input.value = "";
      await loadBoard();
    } catch (e) {
      $("board-result").textContent = e.message;
    }
  });
}

// ---------- 初始化 ----------

function init() {
  try {
    const h = (location.hash || "").replace(/^#/, "");
    if (h && PAGE_LOADERS[h] !== undefined) {
      setTimeout(() => switchPage(h), 0);
    }
  } catch (e) {}
  bindTheme();
  bindCollapse();
  bindAuthTabs();
  bindLogin();
  bindRecover();
  bindRegister();
  bindSidebar();
  bindSignIn();
  bindUpload();
  bindRandom();
  bindRedeem();
  bindWall();
  bindProfile();
  bindAdminAnnouncement();
  bindAdminLottery();
  bindChat();
  bindBoard();
  bindGomoku();
  bindMail();
  bindRank();
  bindAdminRedeemGen();
  bindAdminAuction();
  bindFeedback();
  bindAdminLedger();
  bindSettings();
  bindViewerPage();
  $("auth-offline-toggle").addEventListener("click", toggleOfflineMode);
  applyOfflineMode();
  void setupBackground();
  boot();
}

// 启动流程：免责声明 -> 更新公告 -> 版本校验 -> 进入应用
function boot() {
  let agreed = false;
  try {
    agreed = localStorage.getItem("disclaimer-agreed") === "1";
  } catch (e) {
    agreed = false;
  }
  if (!agreed) {
    $("disclaimer-overlay").classList.remove("hidden");
    $("disclaimer-agree").addEventListener("click", () => {
      try {
        localStorage.setItem("disclaimer-agreed", "1");
      } catch (e) {
        /* 忽略存储异常 */
      }
      $("disclaimer-overlay").classList.add("hidden");
      showUpdateNotes();
    });
    return;
  }
  $("disclaimer-overlay").classList.add("hidden");
  showUpdateNotes();
}

// 更新公告：每次版本更新时在下方新增一条，每个版本仅对用户显示一次
const UPDATE_NOTES = [
  {
    version: "v5.21.39",
    date: "2026-09-13",
    items: [
      "身份系统全面升级：cookieQQ注册验证码 + 永久UID + openid绑定（NapCat私聊 /积分 cookie → 网站注册 → 官方机器人 /积分 绑定 UID）",
      "官方机器人未绑定UID前，积分指令会被拦截并提示绑定步骤；绑定确认后自动合并历史积分",
      "新增 /积分 我的：查看账号信息，支持「解绑本渠道」与「注销绑定」（二次确认）",
      "新增解析链「UID → QQ号 → QQ昵称」：转账/查询/图片作者都会显示好认的名字",
      "帮助改为两级菜单：总菜单（8大分类）→ 点击查看对应分菜单；按钮随当前功能自动切换",
      "新增管理员菜单（仅管理员可见/可进）：积分管理 / 商城管理 / 账号管理 / 数据管理 / 瓶子管理",
      "未绑定UID时，官方机器人只显示一个「绑定账号」按钮",
      "总菜单底部新增 [网站主站] [照片墙] 跳转按钮",
      "快捷按钮自动带入参数：发红包→抢红包(带红包ID)、上传图片→删除这张(带图片ID)、投瓶/捡瓶→评论这个瓶子(带编号)、随机/查看图片→赞赏这张(带图片ID)",
      "漂流瓶存储改用 GitHub；作者与评论显示昵称+QQ头像（以前是ID且无头像）",
      "修复 /积分帮助 会误调用 LLM：指令处理完即终止事件，不再落到默认流程",
      "修复网站聊天室：自己发的消息显示在左边、头像不对（兼容UID与QQ两种口径）",
      "修复网站头像错位：留言板/棋局/聊天室头像全部改为「UID→真实QQ」再取图",
      "修复「我的积分」不显示（改为按永久UID取数）；照片墙/图床 GitHub 化",
      "更新公告弹窗：支持拖动、✕/Esc/点空白关闭、手机端适配（底部弹出、可滚动）",
      "新增版本锁：网站与插件版本号不一致时，自动锁定为「离线模式」，积分相关功能不可用（防止新老版本混跑）",
    ],
  },
  {
    version: "v5.20.0",
    date: "2026-08-16",
    items: [
      "新增五子棋：联机房间 1v1 对战，创建/加入房间、显示双方QQ头像与用户名、对局内聊天、2秒自动同步",
      "插件离线也能玩：不再整站黑屏，改为顶部提示条，聊天/留言/邮箱/反馈/五子棋照常可用",
      "新增网站设置：自选主题（亮/暗）、外接API随机竖屏动漫背景、自定义换图间隔（默认10秒）、换一张",
      "新增观赏模式：全屏查看动漫背景（完整比例显示），点击屏幕换一张、Esc 退出",
      "新增连接状态显示：页脚与设置页显示插件 在线/离线、版本、最近同步时间",
      "新增账号管理（管理页）：查看所有账号密码、改名、重置密码、禁用/启用、设管理员、删除",
      "插件新增指令：/积分 网站账号 查看密码 用户名、全部密码（管理员）",
      "修复改不了用户名：cookieQQ按QQ号跨渠道校验，改完不掉登录",
      "修复同一个QQ号可以反复注册网站账号",
      "个人资料头像改为QQ头像",
    ],
  },
  {
    version: "4.2.13",
    date: "2026-08-16",
    items: [
      "新增五子棋：联机房间 1v1 对战，支持创建/加入房间、显示双方QQ头像与用户名、对局内聊天、2秒自动同步",
      "新增账号管理（管理页）：查看所有账号密码、改名、重置密码、禁用/启用、设管理员、删除",
      "插件新增指令：/积分 网站账号 查看密码 用户名、全部密码（管理员）",
      "修复改不了用户名：cookieQQ改为按QQ号跨渠道校验，改完不再掉登录",
      "修复同一个QQ号可以反复注册网站账号（同一QQ号只能注册一个）",
      "个人资料头像改为显示QQ头像",
      "同步间隔默认降到 5 秒（网站操作更快生效）",
    ],
  },
  {
    version: "4.2.1",
    date: "2026-08-15",
    items: [
      "新增意见反馈入口（提交后可在「意见反馈」页查看管理员回复）",
      "新增全服邮件：管理员可一键给所有用户发站内信",
      "新增全服积分使用记录（管理页）与「我的全部使用记录」",
      "修复刷新页面会掉登录（会话密钥持久化，多 worker 一致）",
      "修复账号显示为匿名（显示名自动回退到网站用户名）",
      "修复管理用户表格在窄屏溢出、留言板作者名字竖着显示",
    ],
  },
];

function closeUpdateNotes() {
  const latest = UPDATE_NOTES[0];
  try {
    if (latest) localStorage.setItem("update-notes-seen", latest.version);
  } catch (e) {
    /* 忽略存储异常 */
  }
  const ov = $("update-overlay");
  if (ov) ov.classList.add("hidden");
  void checkVersion();
}

// 弹窗可拖动（鼠标 + 触摸通用，指针事件）
function initOverlayDrag() {
  const card = $("update-card");
  const head = $("update-head");
  if (!card || !head) return;
  let dragging = false;
  let sx = 0, sy = 0, ox = 0, oy = 0;
  const onDown = (e) => {
    if (e.target.closest("button")) return;
    const r = card.getBoundingClientRect();
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    ox = r.left;
    oy = r.top;
    card.style.position = "fixed";
    card.style.margin = "0";
    card.style.transform = "none";
    card.style.width = r.width + "px";
    card.style.left = r.left + "px";
    card.style.top = r.top + "px";
    try {
      head.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
  };
  const onMove = (e) => {
    if (!dragging) return;
    card.style.left = ox + (e.clientX - sx) + "px";
    card.style.top = oy + (e.clientY - sy) + "px";
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    const r = card.getBoundingClientRect();
    card.style.left =
      Math.max(4, Math.min(r.left, window.innerWidth - r.width - 4)) + "px";
    card.style.top =
      Math.max(4, Math.min(r.top, window.innerHeight - r.height - 4)) + "px";
  };
  head.addEventListener("pointerdown", onDown);
  head.addEventListener("pointermove", onMove);
  head.addEventListener("pointerup", onUp);
  head.addEventListener("pointercancel", onUp);
}

function showUpdateNotes() {
  try {
    const seen = localStorage.getItem("update-notes-seen") || "";
    const latest = UPDATE_NOTES[0];
    if (!latest || seen === latest.version) {
      void checkVersion();
      return;
    }
    const body = $("update-overlay-body");
    body.innerHTML =
      `<p class="hint">${escapeHtml(latest.date)} · v${escapeHtml(latest.version)}</p>` +
      `<ul>${latest.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
    const ov = $("update-overlay");
    ov.classList.remove("hidden");
    $("update-close").addEventListener("click", closeUpdateNotes);
    const xBtn = $("update-x");
    if (xBtn) xBtn.addEventListener("click", closeUpdateNotes);
    // 点弹窗外的遮罩也能关
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeUpdateNotes();
    });
    // Esc 关闭
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !ov.classList.contains("hidden")) {
        closeUpdateNotes();
      }
    });
    initOverlayDrag();
  } catch (e) {
    void checkVersion();
  }
}

async function checkVersion() {
  $("version-refresh").addEventListener("click", () => void checkVersion());
  try {
    const data = await api("/api/version");
    const d = data.data || {};
    if (d.web_version) {
      $("footer-version").textContent =
        `网站 v${escapeHtml(d.web_version)}` +
        (d.plugin_version ? ` · 插件 v${escapeHtml(d.plugin_version)}` : "") +
        (offlineMode
          ? " · 离线模式"
          : d.ok
            ? " · 在线"
            : " · 离线");
    }
    const banner = $("offline-banner");
    if (!d.ok) {
      // 版本不同步 / 插件离线 → 强制「离线模式」，只能使用离线功能
      const pv = String(d.plugin_version || "").replace(/^v/, "");
      const wv = String(d.web_version || "").replace(/^v/, "");
      const mismatch = !!pv && !!wv && pv !== wv;
      if (!offlineMode) {
        offlineMode = true;
        try {
          localStorage.setItem("offline-mode", "1");
        } catch (e) {
          /* 忽略 */
        }
        applyOfflineMode();
      }
      banner.textContent =
        "🔒 " +
        (mismatch
          ? `版本不同步（网站 ${wv} / 插件 ${pv}）——已锁定为「离线模式」`
          : d.message || "插件未同步——已锁定为「离线模式」") +
        "：聊天室/留言板/邮箱/反馈/五子棋可用，积分相关功能不可用。";
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  } catch (e) {
    // 版本接口异常时放行，避免整站不可用
  }
  await loadMe();
}

init();
