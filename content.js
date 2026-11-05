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
  let viewMode = "page";
  let terms = [];
  let historyBatch = "";
  let historyCourses = [];
  let historyCourseKey = "";
  let activeScan = null;
  let identity = readIdentity();

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
    const nextIdentity = readIdentity();
    const accountChanged = nextIdentity.token !== identity.token || nextIdentity.fingerprint !== identity.fingerprint;
    const pageChanged = location.href !== lastUrl || nextIdentity.batchNo !== identity.batchNo;
    if (!accountChanged && !pageChanged) return;
    identity = nextIdentity;
    lastUrl = location.href;
    if (accountChanged) {
      terms = [];
      historyCourses = [];
      historyCourseKey = "";
      historyBatch = "";
      renderHistorySelectors();
      refreshActiveView();
    } else if (viewMode === "page") {
      scanCurrentContext({ force: true });
    }
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
          <div class="dufe-view-switch" role="group" aria-label="课件来源">
            <button type="button" data-view="page" aria-pressed="true">当前页面</button>
            <button type="button" data-view="history" aria-pressed="false">历史学期</button>
          </div>
          <div id="dufe-history-filters" hidden>
            <label for="dufe-term-select">学期</label>
            <select id="dufe-term-select" disabled><option value="">正在读取学期…</option></select>
            <label for="dufe-course-select">课程</label>
            <select id="dufe-course-select" disabled><option value="">请先选择学期</option></select>
            <p class="dufe-history-hint">查看账号内的往期课件，网页当前学期保持不变。</p>
          </div>
          <div id="dufe-downloader-status" role="status" aria-live="polite">正在准备...</div>
          <div id="dufe-files-container"></div>
        </div>
      </div>
    `;
    panel = wrapper.firstElementChild;
    document.body.appendChild(panel);

    makeDraggable(panel);

    panel.querySelector("#dufe-refresh-btn").addEventListener("click", () => {
      refreshActiveView();
    });
    panel.querySelectorAll("[data-view]").forEach(button => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    panel.querySelector("#dufe-term-select").addEventListener("change", event => {
      historyBatch = event.target.value;
      historyCourseKey = "";
      historyCourses = [];
      renderHistorySelectors();
      loadHistoryCourses();
    });
    panel.querySelector("#dufe-course-select").addEventListener("change", event => {
      historyCourseKey = event.target.value;
      loadHistoryFiles();
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
    if (viewMode !== "page") return;
    if (isScanning && !options.force) return;
    if (!panel && document.body) createPanel();

    const chaptersRoute = parseCourseChaptersRoute(location.pathname);
    if (chaptersRoute) {
      await runScan(async scan => {
        setStatus("正在扫描章节资源...");
        const files = await fetchChapterResources(chaptersRoute, scan);
        if (isCurrentScan(scan)) updateFilesList(files, chaptersRoute.courseName || "章节页");
      });
      return;
    }

    const detailRoute = parseCourseDetailRoute(location.pathname);
    if (detailRoute) {
      await runScan(async scan => {
        setStatus("正在扫描当前课程...");
        const files = await fetchCoursewareList(detailRoute, scan);
        if (isCurrentScan(scan)) updateFilesList(files, detailRoute.courseName || "课程页");
      });
      return;
    }

    if (location.pathname.startsWith("/course/list")) {
      await runScan(async scan => {
        setStatus("正在扫描课程列表...");
        const courses = await fetchCourseList(scan);
        const result = await fetchAllCoursewares(courses, scan);
        if (isCurrentScan(scan)) {
          updateFilesList(result.files, `${new Set(courses.map(courseKey)).size} 门课程`);
          showPartialFailures(result.failed);
        }
      });
      return;
    }
    cancelScan();
    clearFiles();
    setStatus("打开课程页查看课件，或选择“历史学期”。");
  }

  function readIdentity() {
    return {
      token: localStorage.getItem("token") || "",
      batchNo: localStorage.getItem("batch") || "",
      fingerprint: localStorage.getItem("fingerprint") || ""
    };
  }

  function cancelScan() {
    activeScan?.controller.abort();
    activeScan = null;
    isScanning = false;
  }

  function clearFiles() {
    filesData = [];
    if (panel) panel.querySelector("#dufe-files-container").replaceChildren();
  }

  function isCurrentScan(scan) {
    const current = readIdentity();
    return activeScan === scan && !scan.signal.aborted && viewMode === scan.mode &&
      current.token === scan.token && current.fingerprint === scan.fingerprint &&
      (scan.mode === "history" || (current.batchNo === scan.batchNo && location.href === scan.url));
  }

  async function runScan(callback, batchNo) {
    cancelScan();
    clearFiles();
    const controller = new AbortController();
    const scan = { ...readIdentity(), controller, signal: controller.signal, mode: viewMode, url: location.href };
    if (batchNo !== undefined) scan.batchNo = batchNo;
    activeScan = scan;
    isScanning = true;
    try {
      if (!scan.token) throw new Error("请先登录白果云，再点击刷新。");
      await callback(scan);
    } catch (error) {
      if (isCurrentScan(scan) && error.name !== "AbortError") setStatus(`读取失败：${error.message}`, "error");
      scan.controller.abort();
    } finally {
      if (activeScan === scan) isScanning = false;
    }
  }

  function refreshActiveView() {
    if (viewMode === "history") return loadHistoryTerms();
    return scanCurrentContext({ force: true });
  }

  function switchView(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    cancelScan();
    clearFiles();
    panel.querySelectorAll("[data-view]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.view === mode));
    });
    panel.querySelector("#dufe-history-filters").hidden = mode !== "history";
    refreshActiveView();
  }

  function courseKey(course) { return `${course.courseNo}|${course.courseSeq}`; }

  function renderHistorySelectors() {
    if (!panel) return;
    const termSelect = panel.querySelector("#dufe-term-select");
    const courseSelect = panel.querySelector("#dufe-course-select");
    termSelect.replaceChildren(...(terms.length ? terms.map(term =>
      new Option(`${term.batchName}${isTrue(term.isCurrentTerm) ? "（当前）" : ""}`, term.batchNo)
    ) : [new Option("暂无学期，请点击刷新", "")]));
    termSelect.value = historyBatch;
    termSelect.disabled = !terms.length;
    courseSelect.replaceChildren(new Option(historyCourses.length ? `请选择课程（${historyCourses.length} 门）` : "该学期暂无课程", ""),
      ...historyCourses.map(course => new Option(
        `${course.courseName || course.courseNo}${course.teacherName ? ` · ${course.teacherName}` : ""} · ${course.courseSeq}班`, courseKey(course)
      )));
    courseSelect.value = historyCourseKey;
    courseSelect.disabled = !historyCourses.length;
  }

  async function loadHistoryTerms() {
    await runScan(async scan => {
      setStatus("正在读取全部学期…");
      panel.querySelector("#dufe-term-select").disabled = true;
      panel.querySelector("#dufe-course-select").disabled = true;
      const data = getSuccessData(await apiRequest("/student/term/getTermList", { contentType: null, scan }));
      if (!Array.isArray(data)) throw new Error("学期列表格式发生变化，请稍后重试。");
      if (!isCurrentScan(scan)) return;
      terms = uniqueBy(data.filter(term => term && term.batchNo && term.batchName), term => String(term.batchNo))
        .map(term => ({ ...term, batchNo: String(term.batchNo) }))
        .sort((a, b) => String(b.beginDate || "").localeCompare(String(a.beginDate || "")) || b.batchNo.localeCompare(a.batchNo, undefined, { numeric: true }));
      if (!terms.some(term => term.batchNo === historyBatch)) {
        historyBatch = (terms[3] || terms.find(term => !isTrue(term.isCurrentTerm)) || terms[0])?.batchNo || "";
        historyCourseKey = "";
      }
      historyCourses = [];
      renderHistorySelectors();
      if (!terms.length) { setStatus("账号未返回可查询的学期。"); return; }
      await loadHistoryCourses();
    });
  }

  async function loadHistoryCourses() {
    await runScan(async scan => {
      setStatus("正在读取所选学期的课程…");
      panel.querySelector("#dufe-course-select").disabled = true;
      const slots = await fetchCourseList(scan);
      if (!isCurrentScan(scan)) return;
      historyCourses = uniqueBy(slots, courseKey).map(course => ({
        ...course, slots: slots.filter(slot => courseKey(slot) === courseKey(course))
      }));
      if (!historyCourses.some(course => courseKey(course) === historyCourseKey)) historyCourseKey = "";
      renderHistorySelectors();
      if (historyCourseKey) { await loadHistoryFiles(); return; }
      setStatus(historyCourses.length ? `找到 ${historyCourses.length} 门课程，请选择要查看的课程。` : "该学期没有查询到你的课程，可换一个学期查看。");
    }, historyBatch);
  }

  async function loadHistoryFiles() {
    const course = historyCourses.find(item => courseKey(item) === historyCourseKey);
    if (!course) { cancelScan(); clearFiles(); setStatus("请选择要查看的课程。"); return; }
    const term = terms.find(item => item.batchNo === historyBatch);
    await runScan(async scan => {
      setStatus(`正在读取 ${course.courseName} 的课件…`);
      const files = [];
      let failed = 0;
      try { files.push(...await fetchChapterResources(course, scan)); }
      catch (error) {
        if (error.name === "AbortError" || error.authRequired) throw error;
        failed++;
      }
      const result = await fetchAllCoursewares(course.slots, scan);
      if (!isCurrentScan(scan)) return;
      files.push(...result.files);
      updateFilesList(files.map(file => ({ ...file, batchNo: scan.batchNo, batchName: term?.batchName || scan.batchNo, historical: true })), course.courseName);
      showPartialFailures(failed + result.failed);
    }, historyBatch);
  }

  function showPartialFailures(count) {
    if (count) setStatus(`已找到 ${filesData.length} 个课件；有 ${count} 处未能读取，结果可能不完整。点击刷新重试。`, "error");
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

  async function fetchCourseList(scan) {
    const result = await apiRequest("/student/queryCourseList", {
      contentType: null, scan
    });
    const weeks = getSuccessData(result) || [];
    if (!Array.isArray(weeks)) throw new Error("课程列表格式发生变化。");
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

  async function fetchAllCoursewares(courses, scan) {
    const results = [];
    let cursor = 0;
    let failed = 0;

    async function worker() {
      while (cursor < courses.length) {
        if (!isCurrentScan(scan)) return;
        const index = cursor++;
        const course = courses[index];
        setStatus(`正在读取课次 ${index + 1}/${courses.length}：${course.courseName || course.courseNo}`);

        try {
          const files = await fetchCoursewareList(course, scan);
          results.push(...files);
        } catch (error) {
          if (error.name === "AbortError" || error.authRequired) throw error;
          failed++;
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(CONCURRENT_REQUESTS, courses.length) },
      worker
    ));

    return { files: uniqueBy(results, file => file.id || file.url || `${file.courseName}|${file.name}`), failed };
  }

  async function fetchCoursewareList(course, scan) {
    const body = {
      courseNo: course.courseNo,
      courseSeq: course.courseSeq,
      weekTimeId: course.weekTimeId,
      weektimeId: course.weekTimeId
    };
    const result = await apiRequest("/student/getCoursewareList", {
      method: "POST", scan,
      body: JSON.stringify(body)
    });
    return normalizeCoursewares(getSuccessData(result) || [], { ...course, batchNo: scan?.batchNo });
  }

  async function fetchChapterResources(course, scan) {
    const result = await apiRequest("/student/getCourseInfo", {
      method: "POST", scan,
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
    return normalizeCoursewares(resources, { ...course, batchNo: scan?.batchNo });
  }

  async function apiRequest(path, options = {}) {
    const headers = {
      ...getAuthHeaders(options.scan),
      ...(options.headers || {})
    };
    if (options.contentType !== null) {
      headers["Content-Type"] = options.contentType || "application/json";
    }

    const response = await fetch(new URL(path, API_ORIGIN).href, {
      method: options.method || "GET",
      credentials: "include",
      headers,
      body: options.body,
      signal: options.scan?.signal
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw authenticationError();
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function getAuthHeaders(context = readIdentity()) {
    const headers = {};
    const { token, batchNo: batch, fingerprint } = context;

    if (token) headers.token = token;
    if (batch) headers.batchNo = batch;
    if (fingerprint) headers.fingerprint = fingerprint;
    return headers;
  }

  function handleCapturedApi(detail) {
    if (!detail.data || viewMode !== "page" || isScanning) return;
    if (detail.status && detail.status !== 200) return;
    if (detail.data.code !== undefined && String(detail.data.code) !== "2000") return;
    // Only accept passive results for the course currently on screen.
    const route = parseCourseChaptersRoute(location.pathname) || parseCourseDetailRoute(location.pathname);
    const request = parseRequestBody(detail.requestBody) || {};
    const requestedCourse = request.dcCoursewareSourceParam || request;
    if (!route || String(requestedCourse.courseNo) !== route.courseNo || String(requestedCourse.courseSeq) !== route.courseSeq) return;
    if (route.weekTimeId && String(requestedCourse.weekTimeId || requestedCourse.weektimeId) !== String(route.weekTimeId)) return;
    if (detail.batchNo && detail.batchNo !== readIdentity().batchNo) return;

    if (detail.url.includes("/student/getCoursewareList")) {
      if (!Array.isArray(detail.data.data)) return;
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

  function authenticationError() {
    return Object.assign(new Error("登录已失效或无权访问，请在白果云重新登录后刷新。"), { authRequired: true });
  }

  function getSuccessData(response) {
    if (!response) return null;
    if (response.code !== undefined && String(response.code) !== "2000") {
      if (["1000", "401", "403"].includes(String(response.code))) throw authenticationError();
      throw new Error(response.message || "平台暂时无法返回数据，请重试。");
    }
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
    if (!Array.isArray(items)) throw new Error("课件列表格式发生变化。");
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
      batchNo: String(item.batchNo || course.batchNo || localStorage.getItem("batch") || ""),
      accountToken: localStorage.getItem("token") || "",
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
          <div class="dufe-empty-title">${viewMode === "history" ? "这门课暂无可读取的课件" : "还没有发现课件"}</div>
          <div class="dufe-empty-text">${viewMode === "history" ? "可以换一门课程，或点击刷新重试。" : "打开课程章节页后点一下刷新。"}</div>
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
        console.warn("[DUFE Ginkgo Downloader] Batch item failed", downloadable[i].file.name, error);
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
    if (file.accountToken !== readIdentity().token) throw authenticationError();

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
        headers: { batchNo: file.batchNo },
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
      if (file.accountToken !== readIdentity().token) { reject(authenticationError()); return; }
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
      if (file.accountToken !== readIdentity().token) { reject(authenticationError()); return; }
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
    return `${file.historical ? `${sanitizeFilename(file.batchName || file.batchNo)}/` : ""}${courseName}/${fileName}`;
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

  window.DUFEGinkgoDownloaderScan = refreshActiveView;
})();
