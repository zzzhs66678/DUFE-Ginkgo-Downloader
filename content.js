(function () {
  "use strict";

  const EVENT_NAME = "DUFE_GINKGO_API_RESPONSE";
  const API_ORIGIN = "https://ginkgostu.dufe.edu.cn";
  const POLL_URL_INTERVAL = 1000;
  const CONCURRENT_REQUESTS = 4;

  let panel = null;
  let filesData = [];
  let lastUrl = location.href;
  let isScanning = false;

  injectPageHook();
  whenBodyReady(() => {
    createPanel();
    setStatus("正在等待课件数据...");
    scanCurrentContext();
  });

  window.addEventListener(EVENT_NAME, event => handleCapturedApi(event.detail || {}));
  window.addEventListener("load", scanCurrentContext);
  window.addEventListener("popstate", scanCurrentContext);
  window.addEventListener("hashchange", scanCurrentContext);

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    scanCurrentContext();
  }, POLL_URL_INTERVAL);

  function injectPageHook() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageHook.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function whenBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }

    new MutationObserver((_records, observer) => {
      if (!document.body) return;
      observer.disconnect();
      callback();
    }).observe(document.documentElement, { childList: true });
  }

  function createPanel() {
    if (panel) return panel;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div id="dufe-downloader-panel">
        <div id="dufe-downloader-header">
          <div id="dufe-downloader-title">
            <span class="dufe-title-mark"></span>
            <span>银杏课件小助手</span>
          </div>
          <div id="dufe-downloader-controls">
            <button id="dufe-refresh-btn" title="重新扫描">↻</button>
            <button id="dufe-minimize-btn" title="收起">−</button>
            <button id="dufe-close-btn" title="关闭">×</button>
          </div>
        </div>
        <div id="dufe-downloader-content">
          <div id="dufe-downloader-status">正在准备...</div>
          <div id="dufe-files-container"></div>
        </div>
      </div>
    `;
    panel = wrapper.firstElementChild;
    document.body.appendChild(panel);

    makeDraggable(panel);

    panel.querySelector("#dufe-refresh-btn").addEventListener("click", () => {
      scanCurrentContext({ force: true });
    });
    panel.querySelector("#dufe-minimize-btn").addEventListener("click", event => {
      panel.classList.toggle("minimized");
      event.currentTarget.textContent = panel.classList.contains("minimized") ? "+" : "−";
    });
    panel.querySelector("#dufe-close-btn").addEventListener("click", () => {
      panel.style.display = "none";
    });
    panel.querySelector("#dufe-files-container").addEventListener("click", event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.getAttribute("data-action");
      if (action === "open") {
        openFileByIndex(Number(button.getAttribute("data-index")), button);
      }
      if (action === "download") {
        downloadFileByIndex(Number(button.getAttribute("data-index")), button);
      }
      if (action === "download-all") {
        downloadAllFiles(button);
      }
    });

    return panel;
  }

  function makeDraggable(element) {
    const header = element.querySelector("#dufe-downloader-header");
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener("mousedown", event => {
      if (event.target.closest("button")) return;
      event.preventDefault();

      const rect = element.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onStop);
    });

    function onMove(event) {
      element.style.left = `${initialLeft + event.clientX - startX}px`;
      element.style.top = `${initialTop + event.clientY - startY}px`;
      element.style.right = "auto";
    }

    function onStop() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onStop);
    }
  }

  async function scanCurrentContext(options = {}) {
    if (isScanning && !options.force) return;
    if (!panel && document.body) createPanel();

    const chaptersRoute = parseCourseChaptersRoute(location.pathname);
    if (chaptersRoute) {
      await runScan(async () => {
        setStatus("正在扫描章节资源...");
        const files = await fetchChapterResources(chaptersRoute);
        updateFilesList(files, getCourseNameFromUrl() || "章节页");
      });
      return;
    }

    const detailRoute = parseCourseDetailRoute(location.pathname);
    if (detailRoute) {
      await runScan(async () => {
        setStatus("正在扫描当前课程...");
        const files = await fetchCoursewareList(detailRoute);
        updateFilesList(files, getCourseNameFromUrl() || "课程页");
      });
      return;
    }

    if (location.pathname.startsWith("/course/list")) {
      await runScan(async () => {
        setStatus("正在扫描课程列表...");
        const courses = await fetchCourseList();
        const files = await fetchAllCoursewares(courses);
        updateFilesList(files, `${courses.length} 门课程`);
      });
    }
  }

  async function runScan(callback) {
    isScanning = true;
    try {
      await callback();
    } catch (error) {
      setStatus(`扫描失败：${error.message}`, "error");
    } finally {
      isScanning = false;
    }
  }

  function parseCourseDetailRoute(pathname) {
    const match = pathname.match(/^\/course\/detail\/([^/]+)\/([^/]+)\/(\d+)/);
    if (!match) return null;
    return {
      courseNo: decodeURIComponent(match[1]),
      courseSeq: decodeURIComponent(match[2]),
      weekTimeId: Number(match[3]),
      courseName: getCourseNameFromUrl()
    };
  }

  function parseCourseChaptersRoute(pathname) {
    const match = pathname.match(/^\/course\/chapters\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    return {
      courseNo: decodeURIComponent(match[1]),
      courseSeq: decodeURIComponent(match[2]),
      courseName: getCourseNameFromUrl()
    };
  }

  function getCourseNameFromUrl() {
    return new URLSearchParams(location.search).get("courseName") || "";
  }

  async function fetchCourseList() {
    const result = await apiRequest("/student/queryCourseList", {
      contentType: null
    });
    const weeks = getSuccessData(result) || [];
    const courses = [];

    weeks.forEach(week => {
      (week.dayList || []).forEach(day => {
        (day.courseList || []).forEach(course => {
          if (course.courseNo && course.courseSeq && course.weekTimeId) {
            courses.push(course);
          }
        });
      });
    });

    return uniqueBy(courses, course => `${course.courseNo}|${course.courseSeq}|${course.weekTimeId}`);
  }

  async function fetchAllCoursewares(courses) {
    const results = [];
    let cursor = 0;

    async function worker() {
      while (cursor < courses.length) {
        const index = cursor++;
        const course = courses[index];
        setStatus(`正在扫描 ${index + 1}/${courses.length}：${course.courseName || course.courseNo}`);

        try {
          const files = await fetchCoursewareList(course);
          results.push(...files);
        } catch (error) {
          console.warn("[DUFE Ginkgo Downloader] Courseware scan failed", course, error);
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(CONCURRENT_REQUESTS, courses.length) },
      worker
    ));

    return uniqueBy(results, file => file.id || file.url || `${file.courseName}|${file.name}`);
  }

  async function fetchCoursewareList(course) {
    const body = {
      courseNo: course.courseNo,
      courseSeq: course.courseSeq,
      weekTimeId: course.weekTimeId,
      weektimeId: course.weekTimeId
    };
    const result = await apiRequest("/student/getCoursewareList", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return normalizeCoursewares(getSuccessData(result) || [], course);
  }

  async function fetchChapterResources(course) {
    const result = await apiRequest("/student/getCourseInfo", {
      method: "POST",
      body: JSON.stringify({
        dcCoursewareSourceParam: {
          courseNo: course.courseNo,
          courseSeq: course.courseSeq
        }
      })
    });
    const data = getSuccessData(result);
    const resources = data && data.sourceChapter
      ? getResourceListFromChapter(data.sourceChapter)
      : [];
    return normalizeCoursewares(resources, course);
  }

  async function apiRequest(path, options = {}) {
    const headers = {
      ...getAuthHeaders(),
      ...(options.headers || {})
    };
    if (options.contentType !== null) {
      headers["Content-Type"] = options.contentType || "application/json";
    }

    const response = await fetch(new URL(path, API_ORIGIN).href, {
      method: options.method || "GET",
      credentials: "include",
      headers,
      body: options.body
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function getAuthHeaders() {
    const headers = {};
    const token = localStorage.getItem("token");
    const batch = localStorage.getItem("batch");
    const fingerprint = localStorage.getItem("fingerprint");

    if (token) headers.token = token;
    if (batch) headers.batchNo = batch;
    if (fingerprint) headers.fingerprint = fingerprint;
    return headers;
  }

  function handleCapturedApi(detail) {
    if (!detail.data) return;

    if (detail.url.includes("/student/getCoursewareList")) {
      const course = {
        ...(parseRequestBody(detail.requestBody) || {}),
        courseName: getCourseNameFromUrl()
      };
      const files = normalizeCoursewares(getSuccessData(detail.data) || [], course);
      updateFilesList(files, course.courseName || "page API");
    }

    if (detail.url.includes("/student/getCourseInfo")) {
      const data = getSuccessData(detail.data);
      const course = {
        ...(parseCourseChaptersRoute(location.pathname) || {}),
        courseName: getCourseNameFromUrl()
      };
      const files = data && data.sourceChapter
        ? normalizeCoursewares(getResourceListFromChapter(data.sourceChapter), course)
        : [];
      if (files.length) updateFilesList(files, course.courseName || "chapter API");
    }
  }

  function parseRequestBody(body) {
    if (!body || typeof body !== "string") return null;
    try {
      return JSON.parse(body);
    } catch (_) {
      return null;
    }
  }

  function getSuccessData(response) {
    if (!response) return null;
    if (Object.prototype.hasOwnProperty.call(response, "data")) return response.data;
    return response;
  }

  function getResourceListFromChapter(chapter) {
    const resources = [];
    if (!chapter) return resources;

    if (Array.isArray(chapter.dcCoursewareSourceList)) {
      resources.push(...chapter.dcCoursewareSourceList);
    }
    (chapter.children || []).forEach(child => {
      resources.push(...getResourceListFromChapter(child));
    });
    return resources;
  }

  function normalizeCoursewares(items, course) {
    return (items || [])
      .map(item => normalizeCourseware(item, course))
      .filter(file => file.name || file.url);
  }

  function normalizeCourseware(item, course = {}) {
    const source = item.sourceFileEntity || {};
    const viewUrl = absolutizeUrl(source.viewUrl || item.viewUrl || "");
    const downloadUrl = absolutizeUrl(findFirstUrl([
      source.downloadUrl,
      source.fileUrl,
      source.url,
      source.sourceUrl,
      source.ossUrl,
      source.path,
      source.filePath,
      item.downloadUrl,
      item.fileUrl,
      item.url,
      item.sourceUrl,
      item.ossUrl,
      item.path,
      item.filePath
    ]));
    return {
      id: String(item.id || source.id || item.sourceId || downloadUrl || viewUrl || ""),
      name: source.fileName || item.fileName || item.courseName || "untitled",
      url: viewUrl,
      downloadUrl,
      fileType: source.fileType || "",
      size: source.fileSize || "",
      courseName: item.courseName || course.courseName || "",
      courseNo: item.courseNo || course.courseNo || "",
      courseSeq: item.courseSeq || course.courseSeq || "",
      weekTimeId: item.weekTimeId || item.weektimeId || course.weekTimeId,
      isDownload: isTrue(item.isDownload),
      raw: item
    };
  }

  function absolutizeUrl(url) {
    if (!url) return "";
    try {
      return new URL(url, API_ORIGIN).href;
    } catch (_) {
      return url;
    }
  }

  function findFirstUrl(values) {
    return (values || []).find(value => {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      return /^https?:\/\//i.test(trimmed) || trimmed.startsWith("/");
    }) || "";
  }

  function updateFilesList(files, sourceLabel) {
    filesData = uniqueBy(files || [], file => file.id || file.url || file.name);
    if (!panel) return;

    panel.style.display = "block";

    const downloadableCount = filesData.filter(file => getDownloadUrl(file)).length;
    const platformAllowedCount = filesData.filter(file => file.isDownload).length;
    setStatus(
      `找到 ${filesData.length} 个课件，可下载 ${downloadableCount} 个，平台允许下载 ${platformAllowedCount} 个${sourceLabel ? `（${sourceLabel}）` : ""}`,
      filesData.length ? "success" : ""
    );

    const container = panel.querySelector("#dufe-files-container");
    if (!filesData.length) {
      container.innerHTML = `
        <div class="dufe-empty-state">
          <div class="dufe-empty-title">还没有发现课件</div>
          <div class="dufe-empty-text">打开课程章节页后点一下刷新。</div>
        </div>
      `;
      return;
    }

    const rows = filesData.map((file, index) => {
      const downloadDisabled = !getDownloadUrl(file);
      const openDisabled = !file.url;
      const accessLabel = file.isDownload ? "允许下载" : "仅可预览";
      return `
        <div class="dufe-file-item">
          <div class="dufe-file-info">
            <div class="dufe-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
            <div class="dufe-file-meta">
              ${escapeHtml([file.courseName, file.fileType, file.size, accessLabel].filter(Boolean).join(" · ") || "课件")}
            </div>
          </div>
          <div class="dufe-file-actions">
            <button class="dufe-download-btn" data-action="download" data-index="${index}" ${downloadDisabled ? "disabled" : ""}>
              ${downloadDisabled ? "无地址" : "下载"}
            </button>
            <button class="dufe-open-btn" data-action="open" data-index="${index}" ${openDisabled ? "disabled" : ""}>
              预览
            </button>
          </div>
        </div>
      `;
    }).join("");

    const allButton = downloadableCount > 1
      ? `<button class="dufe-download-all-btn" data-action="download-all">一键下载全部（${downloadableCount}）</button>`
      : "";

    container.innerHTML = rows + allButton;
  }

  async function openFileByIndex(index, button) {
    const file = filesData[index];
    if (!file || !file.url) return;

    button.disabled = true;
    button.textContent = "打开中";

    try {
      await openViewUrl(file, { active: true });
      button.textContent = "已打开";
      setTimeout(() => {
        button.disabled = false;
        button.textContent = "预览";
      }, 1800);
    } catch (error) {
      console.error("[DUFE Ginkgo Downloader] Open failed", error);
      button.textContent = "失败";
      setTimeout(() => {
        button.disabled = false;
        button.textContent = "重试";
      }, 2000);
    }
  }

  async function downloadFileByIndex(index, button) {
    const file = filesData[index];
    if (!file || !getDownloadUrl(file)) return;

    button.disabled = true;
    button.textContent = "下载中";

    try {
      await markDownloadCountIfAllowed(file);
      await downloadFile(file);
      button.textContent = "已开始";
      setTimeout(() => {
        button.disabled = false;
        button.textContent = "下载";
      }, 1800);
    } catch (error) {
      console.error("[DUFE Ginkgo Downloader] Download failed", error);
      button.textContent = "失败";
      setStatus(`下载失败：${file.name}（${error.message}）`, "error");
      setTimeout(() => {
        button.disabled = false;
        button.textContent = "重试";
      }, 2200);
    }
  }

  async function downloadAllFiles(button) {
    const downloadable = filesData
      .map((file, index) => ({ file, index }))
      .filter(item => getDownloadUrl(item.file));

    button.disabled = true;
    let successCount = 0;
    for (let i = 0; i < downloadable.length; i++) {
      button.textContent = `下载中 ${i + 1}/${downloadable.length}`;
      try {
        await markDownloadCountIfAllowed(downloadable[i].file);
        await downloadFile(downloadable[i].file);
        successCount += 1;
      } catch (error) {
        console.warn("[DUFE Ginkgo Downloader] Batch item failed", downloadable[i].file, error);
      }
      await sleep(350);
    }
    button.textContent = `已开始 ${successCount}/${downloadable.length}`;
    setStatus(`已提交 ${successCount}/${downloadable.length} 个下载任务，请在浏览器下载列表查看。`, successCount ? "success" : "error");
    setTimeout(() => {
      button.disabled = false;
      button.textContent = `一键下载全部（${downloadable.length}）`;
    }, 2500);
  }

  async function markDownloadCount(file) {
    if (!file.raw || !file.raw.id) return;

    const item = {
      ...file.raw,
      studyStatusEntity: {
        ...(file.raw.studyStatusEntity || {}),
        downloadCount: Number(file.raw.studyStatusEntity?.downloadCount || 0) + 1
      }
    };

    try {
      await apiRequest("/student/studyCourse", {
        method: "POST",
        body: JSON.stringify(item)
      });
    } catch (error) {
      console.warn("[DUFE Ginkgo Downloader] studyCourse update failed", error);
    }
  }

  async function markDownloadCountIfAllowed(file) {
    if (!file.isDownload) return;
    await markDownloadCount(file);
  }

  function openViewUrl(file, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "OPEN_VIEW_URL",
        url: file.url,
        active: options.active !== false
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || "Open failed"));
          return;
        }
        resolve(response.tabId);
      });
    });
  }

  function downloadFile(file) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_FILE",
        url: getDownloadUrl(file),
        filename: buildFilename(file)
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || "Download failed"));
          return;
        }
        resolve(response.downloadId);
      });
    });
  }

  function getDownloadUrl(file) {
    return file.downloadUrl || file.url || "";
  }

  function buildFilename(file) {
    const courseName = sanitizeFilename(file.courseName || "未命名课程");
    const fileName = sanitizeFilename(file.name || "未命名课件");
    return `${courseName}/${fileName}`;
  }

  function sanitizeFilename(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setStatus(text, type = "") {
    if (!panel) return;
    const status = panel.querySelector("#dufe-downloader-status");
    if (!status) return;
    status.textContent = text;
    status.className = type;
  }

  function isTrue(value) {
    return value === true || value === 1 || value === "1";
  }

  function uniqueBy(items, getKey) {
    const seen = new Set();
    const result = [];
    items.forEach(item => {
      const key = getKey(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(item);
    });
    return result;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text || "");
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  window.DUFEGinkgoDownloaderScan = () => scanCurrentContext({ force: true });
})();
