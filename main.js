const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Notification, ipcMain, net, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");

const TITLEBAR_HEIGHT = 32;
const PARTITION = "persist:litewms";
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

let win = null;
let titlebarView = null;
let contentView = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("ru.litewms.desktop");

// ---------- настройки: сохранённый адрес кабинета и переключатели ----------
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }), "utf8");
}
const loadDomain = () => readSettings().url || "";
const saveDomain = (url) => writeSettings({ url });
const clearDomain = () => writeSettings({ url: "" });

// Принимает любой адрес: «litebox», «litebox.litewms.ru», «wms.firm.ru», «https://…».
// Без точки это сокращение для поддомена litewms.ru. http разрешён только для localhost.
function normalizeUrl(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Введите адрес кабинета");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value);
    if (!local && !value.includes(".")) value += ".litewms.ru";
    value = (local ? "http://" : "https://") + value;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("Некорректный адрес"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Разрешён только https");
  }
  return url.origin + "/";
}

// Защита от опечатки: по адресу должен отвечать бэкенд LiteWMS.
async function checkCabinet(url) {
  let response;
  try {
    response = await net.fetch(new URL("api/version", url).toString(), {
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("Кабинет не отвечает. Проверьте адрес и интернет");
  }
  let data = null;
  try { data = await response.json(); } catch { /* не JSON */ }
  if (!response.ok || !data || typeof data !== "object") {
    throw new Error("Это не кабинет LiteWMS");
  }
}

// ---------- окно ----------
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
  contentView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) });
}

function secureWebPrefs(extra = {}) {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra };
}

function createWindow() {
  win = new BaseWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    frame: false,
    title: "LiteWMS",
    icon: path.join(__dirname, "build", "icon.ico"),
    backgroundColor: "#0b0d12",
  });

  titlebarView = new WebContentsView({
    webPreferences: secureWebPrefs({ preload: path.join(__dirname, "preload-titlebar.js") }),
  });
  contentView = new WebContentsView({
    webPreferences: secureWebPrefs({
      partition: PARTITION,
      preload: path.join(__dirname, "preload-setup.js"),
    }),
  });
  win.contentView.addChildView(contentView);
  win.contentView.addChildView(titlebarView);
  titlebarView.webContents.loadFile(path.join(__dirname, "titlebar.html"));

  win.on("resize", layout);
  win.on("maximize", () => { layout(); sendMaxState(); });
  win.on("unmaximize", () => { layout(); sendMaxState(); });
  win.on("closed", () => {
    win = null;
    // Окна печати, открытые кабинетом, не должны держать приложение живым.
    BrowserWindow.getAllWindows().forEach((w) => w.close());
  });

  setupDownloads();
  setupLoginMemory(contentView.webContents);
  contentView.webContents.setUserAgent(`${contentView.webContents.getUserAgent()} LiteWMSDesktop/1.0`);
  guardNavigation(contentView.webContents);
  layout();
  win.maximize();
  win.show();
  openStart();

  // Первая проверка — после того как шапка успела загрузиться и подписаться
  // на shell:update-state, иначе первое событие уйдёт в пустоту.
  setTimeout(checkForUpdates, 4000);
  setInterval(checkForUpdates, 2 * 60 * 60 * 1000);
}

function sendMaxState() {
  titlebarView?.webContents.send("shell:max-state", !!win?.isMaximized());
}

// Кабинет открывает окна для печати: PDF по blob:, а также пустое окно (about:blank),
// в которое страница сама пишет этикетку и вызывает print(). Всё это оставляем внутри
// приложения и с сохранением opener (этикетке нужен скрипт основной страницы).
// Внешние сайты уходят в обычный браузер.
const guarded = new WeakSet();
function guardNavigation(contents) {
  if (guarded.has(contents)) return;
  guarded.add(contents);
  const cabinetOrigin = () => {
    try { return new URL(contents.getURL()).origin; } catch { return ""; }
  };
  const isOwn = (target) => {
    if (target === "about:blank") return true;
    try { return new URL(target).origin === cabinetOrigin(); } catch { return false; }
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 760,
          autoHideMenuBar: true,
          icon: path.join(__dirname, "build", "icon.ico"),
          backgroundColor: "#ffffff",
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => addPrintBar(child.webContents));
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || isOwn(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

// Панель «Печать / Скачать PDF» в окнах, которые кабинет открыл для печати. Документ в них
// страница пишет сама (document.write), поэтому панель добавляем после каждой загрузки.
const BAR_SCRIPT = `(function () {
  if (!window.__lwEnsureBar) {
    window.__lwEnsureBar = function () {
      var root = document.documentElement;
      if (!root || !document.body) return;
      if (!document.getElementById("lw-bar-style")) {
        var st = document.createElement("style");
        st.id = "lw-bar-style";
        st.textContent = "#lw-bar{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:0 12px;background:#fff;border-bottom:1px solid #ccc;box-sizing:border-box;font:14px 'Segoe UI',sans-serif}"
          + "#lw-bar button{padding:6px 16px;border:0;border-radius:6px;background:#0a5f5b;color:#fff;font-size:14px;cursor:pointer}"
          + "#lw-bar button.lw-alt{background:#e9ecef;color:#222}"
          + "@media screen{body{padding-top:48px !important}}@media print{#lw-bar{display:none !important}}";
        root.appendChild(st);
      }
      if (!document.getElementById("lw-bar")) {
        var bar = document.createElement("div");
        bar.id = "lw-bar";
        var print = document.createElement("button");
        print.textContent = "Печать";
        print.onclick = function () { window.print(); };
        var save = document.createElement("button");
        save.className = "lw-alt";
        save.textContent = "Скачать PDF";
        save.onclick = function () { console.log("__LW_SAVE_PDF__"); };
        bar.appendChild(print);
        bar.appendChild(save);
        document.body.insertBefore(bar, document.body.firstChild);
      }
    };
  }
  window.__lwEnsureBar();
})()`;

function addPrintBar(contents) {
  const inject = () => { contents.executeJavaScript(BAR_SCRIPT).catch(() => {}); };
  contents.on("dom-ready", inject);
  contents.on("did-finish-load", inject);
  // Кнопка «Скачать PDF» сообщает о клике через консоль: у окон печати нет своего моста.
  contents.on("console-message", (...args) => {
    const message = args[0] && typeof args[0].message === "string" ? args[0].message : args[2];
    if (message === "__LW_SAVE_PDF__") savePdfOf(contents).catch(() => {});
  });
}

async function savePdfOf(contents) {
  const title = (contents.getTitle() || "document").replace(/[\/:*?"<>|]+/g, " ").trim() || "document";
  const data = await contents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  fs.mkdirSync(app.getPath("downloads"), { recursive: true });
  const target = uniquePath(app.getPath("downloads"), `${title}.pdf`);
  fs.writeFileSync(target, data);
  const note = new Notification({ title: "Файл скачан", body: path.basename(target) });
  note.on("click", () => shell.showItemInFolder(target));
  note.show();
}

// Те же правила для окон, которые кабинет открыл сам (этикетка может открыть ещё окно).
app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() === "window") guardNavigation(contents);
});

// Скачивание (xlsx, zip, csv): без диалога, в «Загрузки», с уведомлением.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function setupDownloads() {
  session.fromPartition(PARTITION).on("will-download", (_e, item) => {
    const target = uniquePath(app.getPath("downloads"), item.getFilename() || "download");
    item.setSavePath(target);
    item.once("done", (_ev, state) => {
      if (state !== "completed") return;
      const note = new Notification({ title: "Файл скачан", body: path.basename(target) });
      note.on("click", () => shell.showItemInFolder(target));
      note.show();
    });
  });
}

// ---------- запоминание входа ----------
// У Electron нет менеджера паролей, а кабинет входит с remember:false (сессия на
// сутки) — без этого оператор вводил пароль каждый день. Сам кабинет не меняем:
// оболочка видит запрос входа на уровне сети, после успешного ответа хранит почту
// и пароль своего кабинета, зашифровав их средствами ОС (safeStorage — на Windows
// это DPAPI, расшифровать может только эта учётная запись Windows), и на форме
// входа подставляет их и входит сама. Ровно одна попытка: неверный пароль стирает
// сохранённое и оставляет форму человеку. «Выход» тоже стирает — иначе под другим
// пользователем не войти: оболочка тут же впустила бы обратно.
const LOGIN_FORM_SCRIPT = `(function () {
  if (window.__lwLoginWatch) return;
  window.__lwLoginWatch = true;
  var reported = false;
  setInterval(function () {
    var found = !!document.querySelector('form input[name="email"][autocomplete="username"]')
      && !!document.querySelector('form input[name="password"]');
    if (found && !reported) console.log("__LW_LOGIN_FORM__");
    reported = found;
  }, 700);
})()`;

const cabinetOrigin = () => {
  try { return new URL(loadDomain()).origin; } catch { return ""; }
};
const isCabinetApi = (url, apiPath) => {
  try {
    const u = new URL(url);
    return u.origin === cabinetOrigin() && u.pathname === apiPath;
  } catch {
    return false;
  }
};

function loadCredentials() {
  const saved = readSettings().login;
  if (!saved || saved.origin !== cabinetOrigin() || !saved.email || !saved.password) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return { email: saved.email, password: safeStorage.decryptString(Buffer.from(saved.password, "base64")) };
  } catch {
    return null;
  }
}
function saveCredentials(email, password) {
  // Без шифрования ОС пароль на диск открытым текстом не кладём — просто не запоминаем.
  if (!safeStorage.isEncryptionAvailable()) return;
  writeSettings({
    login: {
      origin: cabinetOrigin(),
      email,
      password: safeStorage.encryptString(password).toString("base64"),
    },
  });
}
const clearCredentials = () => writeSettings({ login: null });

let autoLoginTried = false;
let autoLoginPending = false;

function setupLoginMemory(contents) {
  const pendingLogins = new Map();
  const requests = session.fromPartition(PARTITION).webRequest;
  const filter = { urls: ["*://*/api/login", "*://*/api/logout"] };

  requests.onBeforeRequest(filter, (details, callback) => {
    if (details.method === "POST" && isCabinetApi(details.url, "/api/login")) {
      try {
        const body = JSON.parse(Buffer.concat((details.uploadData || []).map((p) => p.bytes || Buffer.alloc(0))).toString("utf8"));
        if (body && body.email && body.password) {
          pendingLogins.set(details.id, { email: String(body.email), password: String(body.password) });
        }
      } catch { /* не JSON — не наш вход */ }
    }
    callback({});
  });

  requests.onCompleted(filter, (details) => {
    if (details.method !== "POST") return;
    if (isCabinetApi(details.url, "/api/logout")) {
      clearCredentials();
      return;
    }
    if (!isCabinetApi(details.url, "/api/login")) return;
    const creds = pendingLogins.get(details.id);
    pendingLogins.delete(details.id);
    const wasAuto = autoLoginPending;
    autoLoginPending = false;
    if (details.statusCode === 200 && creds) {
      saveCredentials(creds.email, creds.password);
      autoLoginTried = false;
    } else if (wasAuto && [401, 403].includes(details.statusCode)) {
      // Пароль сменили — сохранённый больше не годится.
      clearCredentials();
    }
  });
  requests.onErrorOccurred(filter, (details) => {
    pendingLogins.delete(details.id);
    autoLoginPending = false;
  });

  const injectWatch = () => {
    if (!contents.getURL().startsWith("file:")) contents.executeJavaScript(LOGIN_FORM_SCRIPT).catch(() => {});
  };
  contents.on("dom-ready", injectWatch);
  contents.on("console-message", (...args) => {
    const message = args[0] && typeof args[0].message === "string" ? args[0].message : args[2];
    if (message === "__LW_LOGIN_FORM__") autoLogin(contents);
  });
}

function autoLogin(contents) {
  if (autoLoginTried) return;
  try {
    if (new URL(contents.getURL()).origin !== cabinetOrigin()) return;
  } catch {
    return;
  }
  const creds = loadCredentials();
  if (!creds) return;
  autoLoginTried = true;
  autoLoginPending = true;
  // Поля Vue (v-model) слушают событие input: значение ставим нативным сеттером и
  // шлём событие, иначе форма отправит пустые строки.
  const script = `(function (email, password) {
    var form = document.querySelector('form input[name="email"]');
    form = form && form.form;
    if (!form) return false;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    var fill = function (name, value) {
      var input = form.querySelector('input[name="' + name + '"]');
      if (!input) return false;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    if (!fill("email", email) || !fill("password", password)) return false;
    form.requestSubmit();
    return true;
  })(${JSON.stringify(creds.email)}, ${JSON.stringify(creds.password)})`;
  contents.executeJavaScript(script)
    .then((ok) => { if (!ok) autoLoginPending = false; })
    .catch(() => { autoLoginPending = false; });
}

function openStart() {
  const url = loadDomain();
  if (url) {
    contentView.webContents.loadURL(url).catch(() => showSetup("Не удалось открыть кабинет. Проверьте адрес"));
  } else {
    showSetup("");
  }
}

function showSetup(error) {
  contentView.webContents.loadFile(path.join(__dirname, "setup.html"), { query: { error } });
}

// ---------- IPC ----------
const fromTitlebar = (e) => titlebarView && e.sender === titlebarView.webContents;
const fromContent = (e) => contentView && e.sender === contentView.webContents;

ipcMain.handle("shell:minimize", (e) => { if (fromTitlebar(e)) win?.minimize(); });
ipcMain.handle("shell:toggle-maximize", (e) => {
  if (!fromTitlebar(e) || !win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle("shell:close", (e) => { if (fromTitlebar(e)) win?.close(); });
ipcMain.handle("shell:is-maximized", () => !!win?.isMaximized());

// ---------- настройки (шестерёнка в шапке) ----------
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: "Настройки",
    icon: path.join(__dirname, "build", "icon.ico"),
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    webPreferences: secureWebPrefs({ preload: path.join(__dirname, "preload-settings.js") }),
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
}
const fromSettings = (e) => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;

ipcMain.handle("shell:open-settings", (e) => { if (fromTitlebar(e)) openSettings(); });
ipcMain.handle("settings:get", (e) => {
  if (!fromSettings(e)) return {};
  const s = readSettings();
  return { url: s.url || "", printer: s.printer || "", version: app.getVersion() };
});
ipcMain.handle("settings:printers", async (e) => {
  if (!fromSettings(e)) return [];
  const list = await contentView.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName }));
});
ipcMain.handle("settings:save", (e, values) => {
  if (!fromSettings(e)) return;
  writeSettings({ printer: String(values.printer || "") });
});
ipcMain.handle("settings:change-cabinet", async (e, input) => {
  if (!fromSettings(e)) return { ok: false, error: "Недоступно" };
  try {
    const url = normalizeUrl(input);
    await checkCabinet(url);
    if (url !== loadDomain()) {
      // Другой кабинет: старый вход не должен переезжать вместе с адресом.
      await session.fromPartition(PARTITION).clearStorageData().catch(() => {});
      clearCredentials();
      autoLoginTried = false;
    }
    saveDomain(url);
    contentView.webContents.loadURL(url);
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Тихая печать стикера из скрытого фрейма (страница печатает так только при включённом
// тумблере «Автопечать»). Если печать не удалась, вернём handled:false: страница напечатает как обычно.
ipcMain.handle("print:frame", async (e, html) => {
  if (!contentView || e.sender !== contentView.webContents) return { handled: false };
  const settings = readSettings();
  const file = path.join(app.getPath("temp"), `litewms-print-${Date.now()}.html`);
  fs.writeFileSync(file, String(html), "utf8");
  const printWin = new BrowserWindow({ show: false, webPreferences: secureWebPrefs() });
  try {
    await printWin.loadFile(file);
    // Картинки этикетки внутри документа: ждём, пока они дорисуются.
    await printWin.webContents.executeJavaScript(
      "Promise.all(Array.from(document.images).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))"
    );
    const options = { silent: true, printBackground: true, margins: { marginType: "none" } };
    const printers = await printWin.webContents.getPrintersAsync();
    if (settings.printer && printers.some((p) => p.name === settings.printer)) options.deviceName = settings.printer;
    const size = pageSizeFromHtml(String(html));
    if (size) options.pageSize = size;
    const ok = await new Promise((resolve) => printWin.webContents.print(options, (success) => resolve(success)));
    return { handled: true, ok };
  } catch {
    return { handled: false };
  } finally {
    printWin.destroy();
    fs.unlink(file, () => {});
  }
});

// Размер листа из @page { size: 58mm 40mm } (мм, pt, px, in, cm) в микронах для print().
function pageSizeFromHtml(html) {
  const match = html.match(/@page[^{]*\{[^}]*?size:\s*([\d.]+)(mm|pt|px|in|cm)\s+([\d.]+)(mm|pt|px|in|cm)/i);
  if (!match) return null;
  const micron = { mm: 1000, cm: 10000, in: 25400, pt: 25400 / 72, px: 25400 / 96 };
  return {
    width: Math.round(parseFloat(match[1]) * micron[match[2].toLowerCase()]),
    height: Math.round(parseFloat(match[3]) * micron[match[4].toLowerCase()]),
  };
}

// Исходники pdf.js для показа PDF в окнах кабинета (см. preload-setup.js).
let pdfAssets = null;
ipcMain.handle("pdf:assets", () => {
  if (!pdfAssets) {
    const read = (name) => fs.readFileSync(path.join(__dirname, "vendor", name), "utf8");
    pdfAssets = { lib: read("pdf.min.js"), worker: read("pdf.worker.min.js") };
  }
  return pdfAssets;
});

// ---------- автообновление оболочки ----------
// Обновляется только сама Electron-оболочка (main.js, окна, печать). Сайт кабинета
// обновляется сам собой — этого механизма не касается.
// Файлы для проверки — релизы GitHub ahilespelid/litewms_electron (см. build.publish
// в package.json и PUBLISHING.md), не прод WMS.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let updateState = { status: "idle" };
function setUpdateState(next) {
  updateState = next;
  titlebarView?.webContents.send("shell:update-state", updateState);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("shell:update-state", updateState);
}

autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
autoUpdater.on("update-available", (info) => setUpdateState({ status: "available", version: info.version }));
autoUpdater.on("update-not-available", () => setUpdateState({ status: "idle" }));
autoUpdater.on("download-progress", (p) => setUpdateState({ status: "downloading", percent: Math.round(p.percent) }));
autoUpdater.on("update-downloaded", () => setUpdateState({ status: "ready" }));
autoUpdater.on("error", (err) => setUpdateState({ status: "error", message: err?.message || String(err) }));

function checkForUpdates() {
  // Не запакованная сборка (npm start) не имеет корректного app-update.yml — проверять нечего.
  if (!app.isPackaged) return;
  if (updateState.status === "downloading") return;
  autoUpdater.checkForUpdates().catch((err) => setUpdateState({ status: "error", message: err?.message || String(err) }));
}

ipcMain.handle("shell:check-update", (e) => { if (fromTitlebar(e) || fromSettings(e)) checkForUpdates(); });
ipcMain.handle("shell:download-update", (e) => {
  if (!fromTitlebar(e)) return;
  setUpdateState({ status: "downloading", percent: 0 });
  autoUpdater.downloadUpdate().catch((err) => setUpdateState({ status: "error", message: err?.message || String(err) }));
});
ipcMain.handle("shell:install-update", (e) => {
  if (!fromTitlebar(e)) return;
  // isSilent=true: без мастера установки. Приложение стоит на всех — вторая (isForceRunAfter)
  // сразу открывает его заново, чтобы оператор не остался с пустым столом.
  autoUpdater.quitAndInstall(true, true);
});
ipcMain.handle("shell:get-update-state", () => updateState);

ipcMain.handle("setup:connect", async (e, input) => {
  if (!fromContent(e) || !e.senderFrame.url.startsWith("file:")) return { ok: false, error: "Недоступно" };
  try {
    const url = normalizeUrl(input);
    await checkCabinet(url);
    saveDomain(url);
    contentView.webContents.loadURL(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on("window-all-closed", () => app.quit());
