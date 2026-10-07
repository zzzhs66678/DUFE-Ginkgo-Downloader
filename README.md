# DUFE Ginkgo Courseware Downloader

This is a Manifest V3 browser extension migrated from the XMUFD idea to DUFE Ginkgo Cloud Classroom.

It targets `https://ginkgostu.dufe.edu.cn/course/list` and course detail pages. The extension:

- detects `/student/getCoursewareList` and `/student/getCourseInfo` responses from the page;
- actively supports `/course/chapters/:courseNo/:courseSeq` chapter pages;
- can actively scan the course list through `/student/queryCourseList`;
- extracts courseware metadata from `sourceFileEntity`;
- downloads every detected courseware file into the browser's local download folder with one click;
- keeps a preview button for `sourceFileEntity.viewUrl` when the platform only exposes a view URL;
- calls `/student/studyCourse` before downloading a platform-downloadable item to keep the platform's download counter behavior aligned.

Downloads are saved under the browser download directory in a `DUFE-Ginkgo/` subfolder. The extension prefers direct file fields such as `downloadUrl` or `fileUrl`, and falls back to `sourceFileEntity.viewUrl` when no direct file URL is exposed.

The extension mirrors Ginkgo's frontend request authentication shape: same-origin requests include the logged-in page's `token`, `batchNo`, and `fingerprint` request headers when they are available in the page runtime.

## XMUFD migration map

| XMUFD behavior | DUFE Ginkgo behavior |
| --- | --- |
| Limit extension to the teaching platform host | Limit extension to `https://ginkgostu.dufe.edu.cn/*` |
| Inject `content.js` and `styles.css` at `document_start` | Inject `content.js`, `styles.css`, and a page-world `pageHook.js` at `document_start` |
| Detect resource API responses from `fetch` and XHR | Detect `/student/getCoursewareList` and `/student/getCourseInfo` responses from `fetch` and XHR |
| Infer resource identity from the page URL | Infer `courseNo`, `courseSeq`, and optional `weekTimeId` from course detail/chapter URLs |
| Fetch `upload_references` when the page has an activity id | Fetch `/student/getCoursewareList` or `/student/getCourseInfo` for the current course |
| Convert `fileId` to a real URL in `background.js` | Use `sourceFileEntity.viewUrl` directly, matching the Ginkgo frontend |
| Trigger download with `chrome.downloads.download` | Download direct file URLs when exposed, otherwise fall back to `sourceFileEntity.viewUrl` |

## Release package

Run:

```powershell
.\scripts\build-release.ps1
```

The zip file will be created under `release/`. It is intended to be used like the XMUFD release package: download or copy the zip, unzip it, then load the unpacked extension folder in the browser.

## Install locally

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select the unzipped extension folder.
5. Open `https://ginkgostu.dufe.edu.cn/course/list` after logging in.

You can manually rescan from the floating panel, or run this in the page console:

```js
DUFEGinkgoDownloaderScan()
```
