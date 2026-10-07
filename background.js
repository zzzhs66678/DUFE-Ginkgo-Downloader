"use strict";

const ALLOWED_VIEW_HOSTS = new Set([
  "ginkgostu.dufe.edu.cn",
  "niu.edufe.com.cn",
  "niukczy.edufe.com.cn"
]);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || !["OPEN_VIEW_URL", "DOWNLOAD_FILE"].includes(request.type)) {
    return undefined;
  }

  const task = request.type === "OPEN_VIEW_URL"
    ? openViewUrl(request.url, { active: request.active !== false })
    : downloadFile(request.url, request.filename);

  task
    .then(result => sendResponse({ success: true, ...result }))
    .catch(error => sendResponse({ success: false, error: error.message }));

  return true;
});

function openViewUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("Missing view URL"));
      return;
    }

    let parsed;
    try {
      parsed = new URL(url, "https://ginkgostu.dufe.edu.cn/");
    } catch (_) {
      reject(new Error("Invalid view URL"));
      return;
    }

    if (!ALLOWED_VIEW_HOSTS.has(parsed.hostname)) {
      reject(new Error("View host is not allowed"));
      return;
    }

    chrome.tabs.create(
      {
        url: parsed.href,
        active: options.active !== false
      },
      tab => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve({ tabId: tab && tab.id });
      }
    );
  });
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    const parsed = parseDownloadUrl(url);
    if (!parsed) {
      reject(new Error("Download URL is not allowed"));
      return;
    }

    const options = {
      url: parsed.href,
      saveAs: false,
      conflictAction: "uniquify"
    };

    const safeName = buildDownloadFilename(filename);
    if (safeName) {
      options.filename = safeName;
    }

    chrome.downloads.download(options, downloadId => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve({ downloadId });
    });
  });
}

function parseDownloadUrl(url) {
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url, "https://ginkgostu.dufe.edu.cn/");
  } catch (_) {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  return parsed;
}

function buildDownloadFilename(filename) {
  if (!filename) return "";

  const cleaned = String(filename)
    .split("/")
    .map(part => part
      .replace(/[\\:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("/");

  if (!cleaned) return "";
  return `DUFE-Ginkgo/${cleaned}`.slice(0, 240);
}
