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

## 历史学期课件（v0.2.1）

在“银杏课件小助手”标题下切换到 **历史学期**：

1. 选择学期。列表显示账号接口返回的全部学期；首次打开默认选中网页最近三个学期之前的一个学期。
2. 选择一门课程，或选下拉框顶部的 **本学期全部课程**。插件合并所选课程的章节资源与各课次课件，去除同一课程内的重复项。
3. 整学期扫描显示课程和课次进度，完成后按课程分组。使用“预览”“下载”或“一键下载本学期”；只选一门课时仍使用“一键下载全部”。批量下载只包含当前列表已读取且有下载地址的课件。

整学期扫描按课程依次读取，最多同时发送 4 个课次请求。切换课程、学期或视图会取消旧扫描；一处读取失败不会阻断其余课程，结果会提示可能不完整。点击刷新会保留“本学期全部课程”选择并重新扫描。

历史课件保存到 `DUFE-Ginkgo/学期/课程/文件名`。切回 **当前页面** 即恢复原来的页面扫描方式。右上角刷新按钮刷新当前所选视图。

学期选择仅用于插件自己的请求，不修改网页的 `localStorage.batch`，也不会切换白果云主页面的学期。浏览列表不会提交学习状态；用户主动下载且平台允许下载的课件仍沿用原有下载次数记录逻辑，并使用该课件所属学期。

列表只包含当前登录账号能查询的课程和资源。旧学期可能没有课程，个别资源也可能已撤回或无法打开；查询失败会提示重试，部分请求失败时明确标注结果可能不完整。更换登录账号后会清空此前的选择与课件。

实现依据：白果云前端对 `/student/term/getTermList` 的返回结果使用 `slice(-3)`；插件直接使用完整列表，并为自己的请求指定 `batchNo`。2026-11-06 已验证账号可以读取 2024—2025 学年第二学期的课程、章节和部分课件文件，不代表所有历史文件都仍可用。

## Development checks

The integration checks load the actual extension in Chromium with fixture responses. They do not log into the school or download real courseware.

```sh
python -m pip install -r tests/requirements.txt
python -m playwright install chromium
python tests/browser_history.py
node --check content.js
node --check pageHook.js
```

Coverage includes all-term selection, request semester isolation, chapter/session deduplication, rapid switching, account changes, partial failures, empty states, original page scanning, preview/download messaging, and desktop/mobile screenshots under `test-artifacts/`.

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
