const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Экран ввода адреса: мост только у локальной страницы.
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("shellSetup", {
    connect: (value) => ipcRenderer.invoke("setup:connect", value),
  });
} else {
  // Кабинет. Встроенный просмотрщик PDF в Electron не работает (окно с PDF остаётся
  // белым, процесс страницы падает), поэтому PDF показываем сами через pdf.js.
  // Страница кабинета при этом не меняется: подмена живёт только в приложении.
  contextBridge.exposeInMainWorld("__lwShell", {
    getPdfAssets: () => ipcRenderer.invoke("pdf:assets"),
    printFrame: (html) => ipcRenderer.invoke("print:frame", html),
  });
  webFrame.executeJavaScript(`(${lwInstallPdfShim.toString()})()`).catch(() => {});
}

// Выполняется в мире страницы (не в прелоаде): видит window.open и iframe кабинета.
function lwInstallPdfShim() {
  if (window.__lwPdfShim) return;
  window.__lwPdfShim = true;

  let libPromise = null;
  function loadLib() {
    if (!libPromise) {
      libPromise = window.__lwShell.getPdfAssets().then(({ lib, worker }) => {
        // exports/module/define затеняем, чтобы UMD-сборка села в window.pdfjsLib.
        new Function("exports", "module", "define", lib).call(window);
        const L = window.pdfjsLib;
        L.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
        return L;
      });
    }
    return libPromise;
  }

  // Рисует страницы PDF в картинки. Разрешение около 300 dpi, но не больше 3200 px по стороне.
  async function renderPdf(url) {
    const res = await fetch(url);
    const type = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    const isPdf = String.fromCharCode(...new Uint8Array(buf.slice(0, 5))) === "%PDF-";
    if (!isPdf) return { pdf: false, type };
    const L = await loadLib();
    const doc = await L.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(300 / 72, 3200 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      pages.push({ src: canvas.toDataURL("image/png"), w: base.width, h: base.height });
      canvas.width = 0;
      page.cleanup();
    }
    return { pdf: true, pages };
  }

  // Размер листа берём из самого PDF (важно для термоэтикеток): у каждого размера своя именованная страница.
  function buildCss(pages) {
    const names = new Map();
    let css = "";
    const pageName = (p) => {
      const key = Math.round(p.w) + "x" + Math.round(p.h);
      if (!names.has(key)) {
        names.set(key, "lw" + names.size);
        css += "@page " + names.get(key) + "{size:" + p.w + "pt " + p.h + "pt;margin:0}";
      }
      return names.get(key);
    };
    const named = pages.map(pageName);
    css += "@page{size:" + pages[0].w + "pt " + pages[0].h + "pt;margin:0}";
    css += "html,body{margin:0;background:#e9ecef}"
      + ".lwpg{display:block;margin:12px auto;background:#fff;box-shadow:0 1px 6px #0003;width:min(92vw,900px);height:auto}"
      + "@media print{html,body{background:#fff}"
      + ".lwpg{margin:0;box-shadow:none;width:var(--w);height:var(--h);break-after:page;page-break-after:always}"
      + ".lwpg:last-child{break-after:auto;page-break-after:auto}}";
    return { css, named };
  }

  function pageStyle(p, name) {
    return "page:" + name + ";--w:" + p.w + "pt;--h:" + p.h + "pt";
  }

  function fillWindow(w, pages) {
    const { css, named } = buildCss(pages);
    const doc = w.document;
    doc.title = "Печать";
    const style = doc.createElement("style");
    style.textContent = css;
    doc.head.appendChild(style);
    // Панель «Печать/Скачать» добавляет само приложение (id lw-bar): её не трогаем.
    Array.from(doc.body.children).forEach((n) => { if (n.id !== "lw-bar") n.remove(); });
    const loaded = pages.map((p, i) => new Promise((resolve) => {
      const img = doc.createElement("img");
      img.className = "lwpg";
      img.setAttribute("style", pageStyle(p, named[i]));
      img.onload = img.onerror = resolve;
      img.src = p.src;
      doc.body.appendChild(img);
    }));
    return Promise.all(loaded);
  }

  // window.open(blob:…): окно печати/просмотра. Окно about:blank того же источника, что и
  // кабинет, поэтому страница дальше ведёт себя как в браузере (print, focus, afterprint).
  const nativeOpen = window.open;
  window.open = function (url, target, features) {
    if (typeof url !== "string" || !url.startsWith("blob:")) return nativeOpen.apply(this, arguments);
    const w = nativeOpen.call(window, "", target, features);
    if (!w) return w;
    const nativePrint = w.print.bind(w);
    let ready = null;
    const guardPrint = () => { w.print = () => (ready || Promise.resolve()).then(() => nativePrint()); };
    guardPrint();
    try { const st = w.document.createElement("div"); st.textContent = "Готовим документ…"; w.document.body.appendChild(st); } catch (_) {}
    ready = renderPdf(url).then(async (result) => {
      if (result.pdf) {
        await fillWindow(w, result.pages);
        guardPrint();
        try { w.__lwEnsureBar && w.__lwEnsureBar(); } catch (_) {}
        return;
      }
      // Не PDF (xlsx, картинка, html): отдаём окну как есть; файл-загрузку окно после старта закрываем.
      w.location.href = url;
      if (!/^(text\/html|image\/)/i.test(result.type)) setTimeout(() => { try { w.close(); } catch (_) {} }, 2000);
    }).catch(() => {
      try { const st = w.document.createElement("div"); st.textContent = "Не удалось показать документ"; w.document.body.appendChild(st); } catch (_) {}
    });
    return w;
  };

  // Автопечать: при включённом тумблере кабинет печатает стикер скрытым iframe с blob-PDF
  // и вызывает contentWindow.print(). Такой фрейм приложение печатает молча на принтер из
  // настроек. Остальные скрытые фреймы (например, DataMatrix) печатаются как обычно.
  // При сбое тихой печати работает обычная печать браузера с диалогом.
  const cwDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    enumerable: cwDesc.enumerable,
    get() {
      const w = cwDesc.get.call(this);
      try {
        if (w && !w.__lwPrintHook && this.__lwAutoPrint) {
          const native = w.print;
          w.__lwPrintHook = true;
          w.print = function () {
            const html = "<!doctype html>" + w.document.documentElement.outerHTML;
            window.__lwShell.printFrame(html)
              .then((r) => { if (!r || !r.handled) native.call(w); })
              .catch(() => native.call(w));
          };
        }
      } catch (_) { /* чужой источник: печатаем как обычно */ }
      return w;
    },
  });

  // Скрытая печать (iframe с blob-PDF): отдаём фрейму готовые картинки через srcdoc,
  // а onload страницы вызываем только когда они загружены.
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
  Object.defineProperty(HTMLIFrameElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      if (typeof value !== "string" || !value.startsWith("blob:")) return srcDesc.set.call(this, value);
      const frame = this;
      frame.__lwAutoPrint = true;
      let handler = null;
      let ready = false;
      Object.defineProperty(frame, "onload", {
        configurable: true,
        get: () => handler,
        set: (fn) => { handler = fn; },
      });
      frame.addEventListener("load", (e) => { if (ready && handler) handler.call(frame, e); });
      renderPdf(value).then((result) => {
        ready = true;
        if (!result.pdf) return srcDesc.set.call(frame, value);
        const { css, named } = buildCss(result.pages);
        const imgs = result.pages.map((p, i) => '<img class="lwpg" style="' + pageStyle(p, named[i]) + '" src="' + p.src + '">').join("");
        frame.srcdoc = "<!doctype html><style>" + css + "</style>" + imgs;
      }).catch(() => { ready = true; srcDesc.set.call(frame, value); });
    },
  });
}
