"""Offline integration checks using the real unpacked Chromium extension.

Run: python tests/browser_history.py
Requires Playwright + its Chromium browser. All website/API responses are fixtures;
preview/download APIs are intercepted inside the extension's service worker.
"""
import asyncio
import json
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://ginkgostu.dufe.edu.cn"
TERMS = [dict(batchNo=f"{i:02}", batchName=f"{2019 + i // 2}-{2020 + i // 2} 学年第{'二' if i % 2 else '一'}学期",
              beginDate=f"{2020 + (i - 1) // 2}-{'03' if i % 2 else '09'}-01", isCurrentTerm=int(i == 14)) for i in range(1, 15)]
HTML = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>白果云 · 测试课程</title>
<style>body{margin:0;background:#f4f6f8;color:#22334b;font:16px 'Microsoft YaHei',sans-serif}header{padding:24px 36px;background:white;border-bottom:1px solid #e3e8ed}main{padding:44px 36px}h1{font-size:24px}p{color:#748394}.course{margin-top:24px;padding:24px;background:white;border:1px solid #e3e8ed;max-width:480px;border-radius:8px}</style>
<header>白果云 · 云课堂</header><main><h1>我的课程</h1><p>2026—2027 学年第一学期</p><div class="course">课程与学习资源</div></main></html>"""


def resource(batch, ident, name="02 人格特征.pdf"):
    return dict(id=f"{batch}-{ident}", batchNo=batch, courseNo="C1", courseSeq="01",
                courseName="大学生心理健康教育", isDownload=1,
                sourceFileEntity=dict(fileName=name, fileType="pdf", fileSize="2.48 MB",
                                      viewUrl=f"https://niukczy.edufe.com.cn/fixture-{batch}-{ident}"))


def math_resource(batch, ident):
    item = resource(batch, ident, "第一章 函数与极限.pdf" if ident == 1 else "第二章 导数.pdf")
    # Same source IDs in different courses must remain in both course folders.
    item.update(courseNo="C2", courseSeq="02", courseName="高等数学（上）")
    return item


async def main():
    state = {}
    calls = []
    errors = []
    passed = []
    metrics = {"active": 0, "peak": 0}
    with tempfile.TemporaryDirectory(prefix="ginkgo-browser-test-") as profile:
        async with async_playwright() as p:
            context = await p.chromium.launch_persistent_context(
                profile, channel="chromium", headless=True,
                args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
                viewport={"width": 1280, "height": 850}, locale="zh-CN")
            await context.add_init_script("""localStorage.setItem('token','fixture-account');
                localStorage.setItem('batch','14'); localStorage.setItem('fingerprint','fixture-device');""")

            async def respond(route):
                req = route.request
                url = req.url
                if not url.startswith(ORIGIN):
                    await route.abort()
                    return
                path = url.removeprefix(ORIGIN).split("?")[0]
                if not path.startswith("/student/"):
                    await route.fulfill(content_type="text/html", body=HTML)
                    return
                batch = req.headers.get("batchno", "")
                body = json.loads(req.post_data or "{}")
                course_no = body.get("courseNo") or body.get("dcCoursewareSourceParam", {}).get("courseNo")
                calls.append(dict(path=path, batch=batch, body=body))
                delay = state.get("delay", {}).get((batch, path), 0)
                if delay:
                    await asyncio.sleep(delay)
                if state.get("auth_error"):
                    await route.fulfill(json={"code": "1000", "message": "expired", "data": None})
                    return
                if state.get("fail_path") == path or (course_no and state.get("fail_course") == course_no):
                    await route.fulfill(status=500, json={"code": "500", "data": None})
                    return
                if path.endswith("getTermList"):
                    data = TERMS
                elif path.endswith("queryCourseList"):
                    data = [] if batch == "01" else [{"dayList": [{"courseList": [
                        dict(courseNo="C1", courseSeq="01", courseName="大学生心理健康教育", teacherName="任老师", weekTimeId=1),
                        dict(courseNo="C1", courseSeq="01", courseName="大学生心理健康教育", teacherName="任老师", weekTimeId=2),
                        dict(courseNo="C2", courseSeq="02", courseName="高等数学（上）", teacherName="王老师", weekTimeId=3)
                    ]}]}]
                    if state.get("many_slots") and data:
                        courses = data[0]["dayList"][0]["courseList"]
                        data[0]["dayList"][0]["courseList"] = [
                            dict(course, weekTimeId=100 * index + slot)
                            for index, course in enumerate([courses[0], courses[2]], 1) for slot in range(1, 7)]
                elif path.endswith("getCourseInfo"):
                    no = body.get("dcCoursewareSourceParam", {}).get("courseNo")
                    data = {"sourceChapter": {"dcCoursewareSourceList": [] if no == "C2" else [resource(batch, 1)],
                                              "children": []}}
                    if no == "C2" and state.get("populate_c2"):
                        data["sourceChapter"]["dcCoursewareSourceList"] = [math_resource(batch, 1)]
                elif path.endswith("getCoursewareList"):
                    data = [] if body.get("courseNo") == "C2" else [resource(batch, 1), resource(batch, 2, "03 学业管理展示主题.pdf")]
                    if course_no == "C2" and state.get("populate_c2"):
                        data = [math_resource(batch, 1), math_resource(batch, 2)]
                elif path.endswith("studyCourse"):
                    data = True
                else:
                    await route.abort()
                    return
                try:
                    await route.fulfill(json={"code": "2000", "data": data})
                except Exception:
                    # A cancelled scan can close its request before fixture delay ends.
                    pass

            async def handle(route):
                resource_request = any(path in route.request.url for path in ("/student/getCourseInfo", "/student/getCoursewareList"))
                if resource_request:
                    metrics["active"] += 1
                    metrics["peak"] = max(metrics["peak"], metrics["active"])
                try:
                    await respond(route)
                finally:
                    if resource_request:
                        metrics["active"] -= 1

            await context.route("https://**/*", handle)
            worker = context.service_workers[0] if context.service_workers else await context.wait_for_event("serviceworker")
            await worker.evaluate("""() => {
                globalThis.testDownloads=[]; globalThis.testPreviews=[];
                chrome.downloads.download=(options, callback)=>{testDownloads.push(options);callback(42)};
                chrome.tabs.create=(options, callback)=>{testPreviews.push(options);callback({id:43})};
            }""")
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))

            async def fresh(path="/"):
                state.clear()
                calls.clear()
                await page.goto(ORIGIN + path)
                await expect(page.locator("#dufe-downloader-panel")).to_be_visible()

            async def history(batch="11", course="C1|01"):
                await page.locator('[data-view="history"]').click()
                await expect(page.locator("#dufe-course-select")).to_be_enabled()
                if batch != "11":
                    await page.locator("#dufe-term-select").select_option(batch)
                    await expect(page.locator("#dufe-course-select")).to_be_enabled()
                if course:
                    await page.locator("#dufe-course-select").select_option(course)
                    await expect(page.locator("#dufe-downloader-status")).to_contain_text("找到 2 个课件")

            await fresh()
            await history()
            await expect(page.locator("#dufe-term-select option")).to_have_count(14)
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            assert await page.evaluate("localStorage.getItem('batch')") == "14"
            assert all(x["batch"] == "11" for x in calls if x["path"].endswith(("getCourseInfo", "getCoursewareList")))
            assert not any(x["path"].endswith("studyCourse") for x in calls)
            passed.append("All 14 terms; historical auth header; chapter/session deduplication; browse is read-only")

            out = ROOT / "test-artifacts"
            out.mkdir(exist_ok=True)
            await page.screenshot(path=str(out / "history-desktop.png"))
            await page.locator("#dufe-downloader-panel").screenshot(path=str(out / "history-panel.png"))
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.screenshot(path=str(out / "history-mobile.png"))
            assert await page.locator("#dufe-downloader-content").evaluate("e => e.scrollWidth <= e.clientWidth")
            await page.set_viewport_size({"width": 1280, "height": 850})
            passed.append("Desktop/mobile layout; no panel horizontal overflow")

            await page.evaluate("""() => window.dispatchEvent(new CustomEvent('DUFE_GINKGO_API_RESPONSE', {detail:{url:'/student/getCoursewareList',requestBody:'{}',data:{code:'2000',data:[]}}}))""")
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            passed.append("Page captures cannot overwrite historical results")

            await page.locator('[data-action="open"]').first.click()
            await page.locator('[data-action="download"]').first.click()
            await expect(page.locator('[data-action="download"]').first).to_have_text("已开始")
            downloads = await worker.evaluate("testDownloads")
            assert len(downloads) == 1 and "2024-2025" in downloads[0]["filename"]
            assert len(await worker.evaluate("testPreviews")) == 1
            assert [x for x in calls if x["path"].endswith("studyCourse")][-1]["batch"] == "11"
            await page.locator('[data-action="download-all"]').click()
            await expect(page.locator('[data-action="download-all"]')).to_contain_text("已开始 2/2")
            assert len(await worker.evaluate("testDownloads")) == 3
            passed.append("Preview; single/batch downloads; historical folder and download-counter semester")

            await page.locator("#dufe-course-select").select_option("C2|02")
            await expect(page.locator(".dufe-empty-title")).to_have_text("这门课暂无可读取的课件")
            await page.locator("#dufe-term-select").select_option("01")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("没有查询到你的课程")
            await expect(page.locator("#dufe-course-select")).to_be_disabled()
            passed.append("Empty courseware and empty semester states")

            # Out-of-order semester response must not replace the newly selected one.
            state["delay"] = {("10", "/student/queryCourseList"): 0.8}
            await page.locator("#dufe-term-select").select_option("10")
            await page.locator("#dufe-term-select").select_option("11")
            await expect(page.locator("#dufe-course-select")).to_be_enabled()
            await page.locator("#dufe-course-select").select_option("C1|01")
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            await page.wait_for_timeout(1000)
            await expect(page.locator("#dufe-term-select")).to_have_value("11")
            passed.append("Rapid semester changes discard stale responses")

            state["delay"] = {("11", "/student/getCourseInfo"): 0.8}
            await page.locator("#dufe-course-select").select_option("C2|02")
            await page.locator('[data-view="page"]').click()
            await page.wait_for_timeout(1000)
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("打开课程页")
            await expect(page.locator(".dufe-file-item")).to_have_count(0)
            passed.append("Switching views cancels in-flight historical files")

            await fresh()
            state["fail_path"] = "/student/getCoursewareList"
            await history(course="")
            await page.locator("#dufe-course-select").select_option("C1|01")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("结果可能不完整")
            await expect(page.locator(".dufe-file-item")).to_have_count(1)
            state.clear()
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            passed.append("Partial failures are visible and refresh recovers")

            state["auth_error"] = True
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("登录已失效")
            await expect(page.locator(".dufe-file-item")).to_have_count(0)
            state.clear()
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            await page.evaluate("localStorage.setItem('token','new-account')")
            await expect(page.locator(".dufe-file-item")).to_have_count(0)
            await expect(page.locator("#dufe-course-select")).to_have_value("")
            passed.append("Business-code auth failure; recovery; account-change invalidation")

            await fresh()
            state.update(populate_c2=True, many_slots=True,
                         delay={("11", "/student/getCoursewareList"): 0.12})
            metrics["peak"] = 0
            await history(course="")
            calls.clear()
            await page.locator("#dufe-course-select").select_option(label="本学期全部课程（2 门）")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("课程 1/2")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("本学期全部 2 门课程")
            await expect(page.locator(".dufe-file-item")).to_have_count(4)
            await expect(page.locator(".dufe-course-heading")).to_have_count(2)
            await expect(page.locator('[data-action="download-all"]')).to_have_text("一键下载本学期（4）")
            assert await page.locator("#dufe-files-container > :first-child").get_attribute("data-action") == "download-all"
            assert 1 < metrics["peak"] <= 4, metrics
            assert len([x for x in calls if x["path"].endswith("getCourseInfo")]) == 2
            assert len([x for x in calls if x["path"].endswith("getCoursewareList")]) == 12
            assert all(x["batch"] == "11" for x in calls)
            assert not any(x["path"].endswith("studyCourse") for x in calls)
            assert await page.evaluate("localStorage.getItem('batch')") == "14"
            await page.locator("#dufe-downloader-panel").screenshot(path=str(out / "semester-panel.png"))
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.screenshot(path=str(out / "semester-mobile.png"))
            assert await page.locator("#dufe-downloader-content").evaluate("e => e.scrollWidth <= e.clientWidth")
            await page.set_viewport_size({"width": 1280, "height": 850})
            passed.append("Whole semester: all courses/slots, progress, grouped deduplication, at most 4 concurrent requests, mobile layout")

            before_downloads = len(await worker.evaluate("testDownloads"))
            await page.locator('[data-action="download-all"]').click()
            await expect(page.locator('[data-action="download-all"]')).to_contain_text("已开始 4/4")
            whole_downloads = (await worker.evaluate("testDownloads"))[before_downloads:]
            assert len(whole_downloads) == 4
            assert len({x["filename"].split("/")[2] for x in whole_downloads}) == 2
            assert all("2024-2025" in x["filename"] for x in whole_downloads)
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("本学期全部 2 门课程")
            await expect(page.locator("#dufe-course-select")).to_have_value("__all_courses__")
            passed.append("Whole-semester downloads retain course folders; refresh preserves all-course scope")

            state["fail_course"] = "C2"
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("结果可能不完整")
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            state.pop("fail_course")
            state["delay"] = {("11", "/student/getCourseInfo"): 0.8}
            calls.clear()
            await page.locator("#dufe-refresh-btn").click()
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("课程 1/2")
            await page.locator("#dufe-course-select").select_option("C2|02")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("找到 2 个课件")
            await expect(page.locator(".dufe-file-name").first).to_contain_text("函数与极限")
            await expect(page.locator(".dufe-course-heading")).to_have_count(0)
            assert not any(x["path"].endswith("getCoursewareList") and x["body"].get("courseNo") == "C1" for x in calls)
            passed.append("Failed course does not hide other courses; changing selection cancels whole-semester queue")

            await fresh("/course/detail/C1/01/1?courseName=心理健康")
            await expect(page.locator(".dufe-file-item")).to_have_count(2)
            assert all(x["batch"] == "14" for x in calls)
            await page.evaluate("localStorage.setItem('batch','13')")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("找到 2 个课件")
            await page.wait_for_timeout(1200)
            assert any(x["batch"] == "13" for x in calls)
            passed.append("Original detail-page scanning and native semester changes")

            await fresh("/course/chapters/C1/01")
            await expect(page.locator(".dufe-file-item")).to_have_count(1)
            await fresh("/course/list")
            await expect(page.locator("#dufe-downloader-status")).to_contain_text("2 门课程")
            passed.append("Original chapter and course-list scanning")
            assert not errors, errors
            await context.close()
            print(json.dumps({"passed": passed, "page_errors": errors}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
