(function () {
  "use strict";

  if (window.__dufeGinkgoDownloaderHooked) {
    return;
  }
  window.__dufeGinkgoDownloaderHooked = true;

  const EVENT_NAME = "DUFE_GINKGO_API_RESPONSE";
  const API_PATTERNS = [
    "/student/getCoursewareList",
    "/student/getCourseInfo",
    "/student/queryCourseList"
  ];

  function toUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function shouldCapture(url) {
    return API_PATTERNS.some(pattern => url.includes(pattern));
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  }

  function emit(detail) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = toUrl(args[0]);
    const init = args[1] || {};
    const response = await originalFetch.apply(this, args);

    if (url && shouldCapture(url)) {
      const clone = response.clone();
      clone.text().then(text => {
        emit({
          transport: "fetch",
          url,
          method: init.method || "GET",
          requestBody: init.body || "",
          status: response.status,
          batchNo: new Headers(init.headers || (args[0] instanceof Request ? args[0].headers : {})).get("batchNo") || "",
          data: parseJson(text)
        });
      }).catch(() => {});
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === "batchno") this.__dufeGinkgoBatch = String(value);
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dufeGinkgoUrl = toUrl(url);
    this.__dufeGinkgoMethod = method || "GET";
    this.__dufeGinkgoBatch = "";
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__dufeGinkgoUrl && shouldCapture(this.__dufeGinkgoUrl)) {
      this.addEventListener("load", function () {
        emit({
          transport: "xhr",
          url: this.__dufeGinkgoUrl,
          method: this.__dufeGinkgoMethod,
          requestBody: body || "",
          status: this.status,
          batchNo: this.__dufeGinkgoBatch,
          data: parseJson(this.responseText)
        });
      });
    }

    return originalSend.apply(this, arguments);
  };

  console.log("[DUFE Ginkgo Downloader] API hook installed");
})();
