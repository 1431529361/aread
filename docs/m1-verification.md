# M1 真机验收清单（含 M0-B 回归）

M1 的代码与离线测试已完成，但当前开发环境没有 Android 设备/模拟器，以下设备侧结果必须按清单在真机上确认。
验收目标以 `android-app-spec.md` M1 为准：**带图片的真实 EPUB 正常阅读；GBK 编码 TXT 不乱码；DRM EPUB 被拒绝。**

M1 建立在 M0-B 之上，因此 **请先按 `m0-b-verification.md` 跑一遍 M0-B 回归**，再执行本文档的 M1 项。
两处 M0-B 清单需要按 M1 的新行为更新（见下文 §1）。

## 0. 构建与安装

- [ ] Android 8.0+（API 26）真机，开启开发者选项与 USB 调试，`adb devices` 能看到设备
- [ ] `cd mobile && npx expo run:android --device` 完成 dev build 编译并安装
- [ ] 不要用 Expo Go（op-sqlite、SecureStore 需要原生模块）
- [ ] 设置页诊断：FTS5 状态正常、Schema=7；导入 EPUB 后「分块数」增长

## 1. M0-B 清单中需要按 M1 更新的条目

| 位置 | M0-B 原文 | M1 新行为 |
| --- | --- | --- |
| TXT 导入 | GBK 明确提示“仅支持 UTF-8/UTF-16，GBK 将在 M1 支持”，书架不新增乱码书 | **GBK/GB18030 正常导入并正确显示中文**；无法识别的编码（如 Big5）才提示不支持 |
| 导入按钮 | 「＋ 导入 TXT」 | 「＋ 导入书籍」，可同时选 `.txt` 与 `.epub` |
| onboarding 第三步 | 只支持 TXT ≤50MB | 支持 TXT（UTF-8/UTF-16/GBK ≤50MB）与 EPUB（≤100MB） |

准备测试文件：

```bash
# GBK TXT（应正常显示中文）
printf '第一章 开始\n中文正文，用于验证 GBK 不乱码。\n\n第二章 继续\n第二段中文。\n' \
  | iconv -f UTF-8 -t GBK > /tmp/gbk.txt

# 带图片的真实 EPUB：随便找一本图文混排的公共版权 EPUB 即可
# 例如把 epub 放到 /tmp/with-images.epub
```

## 2. GBK TXT 不乱码（M1 验收项 2）

- [ ] 导入 `/tmp/gbk.txt`：导入完成弹窗显示「TXT · 编码 GB18030」
- [ ] 书架书名取文件名（不含 `.txt`）
- [ ] 阅读器中正文为正常简体中文，**没有任何乱码方块或问号**
- [ ] 关键词搜索该中文词：能命中，且结果片段是正常中文
- [ ] 划线该中文句子：划线高亮与书籍详情页引用文本都正常
- [ ] 把同一文件复制成 `.docx` 之外的二进制文件（如把一张 png 改名为 `x.txt`）导入：应提示“文件包含二进制内容”，不写入乱码书

## 3. 带图片的真实 EPUB（M1 验收项 1）

- [ ] 导入 `/tmp/with-images.epub`：弹窗显示「EPUB · <大小>」，书架出现书卡
- [ ] 书名/作者取自 EPUB 元数据（`dc:title` / `dc:creator`）
- [ ] 打开阅读器：
  - [ ] 顶部显示「书名 · 当前章节名」，下方出现「‹ 上一章 / 当前章 N/总数 / 下一章 ›」
  - [ ] 正文按原书段落/标题排版（标题变大加粗，引用块有左边线，列表有圆点）
  - [ ] **正文中的图片正常显示**（含封面页这种纯图片章节）
  - [ ] 「上一章 / 下一章」可翻章，翻到章节边界时按钮置灰
- [ ] 目录：点「目录」列出真实章节名（不是「第 N 节」占位），点任一条跳转到对应章节
- [ ] 若该书没有 nav/ncx 目录：列表退化为「第 1 节 / 第 2 节 …」，仍可跳转
- [ ] 划线：在 EPUB 章节里长按选中文字 →「划线」高亮；退出重进本章高亮仍在
- [ ] 划线跳转：书籍详情页「划线」列表点「跳到原文」→ 打开对应章节并滚动定位、闪烁提示
- [ ] 搜索与引用：EPUB 里搜关键词能命中；回答中的引用点开后能跳回对应章节
- [ ] 进度：翻几章后退出再进入，回到上次的章节与章内位置；顶部百分比在合理范围递增
- [ ] **飞行模式**（关闭 Wi-Fi + 移动数据）杀掉 App 重开：EPUB 正文与图片都能正常显示

## 4. DRM EPUB 被拒绝（M1 验收项 3）

- [ ] 导入一本 Adobe/DRM 加密的 EPUB：提示「这本书带有 DRM 保护，无法在本地阅读：…」，**书架不新增该书**
- [ ] 导入一本正文加密（`META-INF/encryption.xml` 指向正文）的 EPUB：同样被拒绝
- [ ] 导入一本仅做了字体混淆（IDPF / Adobe 字体算法）的 EPUB：**正常导入**（字体混淆不算 DRM）

## 5. 边界与异常

- [ ] 导入超过 100MB 的 EPUB：提示「EPUB 超过 100MB 上限，请拆分后再导入」
- [ ] 导入超过 50MB 的 TXT：提示「文件超过 50MB 上限，请拆分后再导入」
- [ ] 导入把 .zip 直接改名为 .epub 的文件：提示「无法解析文件内容，可能不是 EPUB 或文件已损坏」
- [ ] 重复导入同一 EPUB：提示「这本书已在书架」，不产生第二本
- [ ] 取消文件选择：不报错、不新增记录
- [ ] 删除 EPUB 书：书籍文件、索引、会话、划线全部清理（诊断数量可确认）
- [ ] 删除后重新导入同一文件：能正常导入（缓存已失效）

## 6. 已知限制（不作为 M1 阻塞项）

- **未采用 epub.js**：spec §10 风险 4 允许在 epub.js 失败时改为「JSZip 解析 + 章节 HTML 渲染」。为保证 TXT 与 EPUB 共用同一套字符 offset locator（划线/引用/索引完全一致）、完全离线且可单测，本项目直接采用该回退路线，`epubjs` 依赖仍在 `package.json` 中但 M1 未使用。
- **EPUB 全文不进对话上下文**：各 spine 文档的 offset 各自独立，无法与 TXT 的点子偏移共用。M1 中 EPUB 的提问仍走「检索命中 + 带 `href` 的引用」路径，`chat.ts` 不注入整本 `content`；M2 做跨书检索时再统一。
- **Big5 / Shift-JIS 可能被误判**：编码识别顺序为 BOM → 严格 UTF-8 → UTF-16 启发式 → GB18030。Big5、Shift-JIS 的字节也落在 GBK 双字节区间，可能被解成 GB18030 而显示为乱码；这类文件请先转码为 UTF-8。
- **空白会被归一化**：EPUB 消毒时空白在块内折叠（跨标签），`<pre>` 的缩进也会被压缩。这是为了让「纯文本 offset」与「WebView 渲染后的 textContent」严格一一对应，保证划线/引用能精确回跳。
- **EPUB 按章渲染**：单章 HTML 一次生成，超大单章（如整本书塞进一个 xhtml）仍可能打开较慢；符合 spec §9「按章节渲染」的要求。
- **目录锚点未精确滚动**：目录项带 `#fragment` 时只跳到该 spine 文档开头，不滚动到锚点位置。
- **GBK 映射表体积**：`src/core/import/gbkTable.ts` 约 66KB（base64 压缩的双字节表 + 209 段四字节表），由 `scripts/generate-gbk-table.mjs` 从 Node 的 `TextDecoder('gb18030')` 生成，可重复执行。

## 7. 离线自动化覆盖（`cd mobile && npm test`，389 项）

M1 新增/更新的离线测试：

- `epubSanitize.test.ts`：消毒不变量（块文本 === 渲染后 textContent）、跨标签空白折叠、行内标签保留、`<br>`/图片不占字符、图片块 `start===end`、块结构、图片引用收集
- `epubParse.test.ts`：container/OPF/manifest/spine/元数据、percent-encoding 与大小写容错、无 container 时 `.opf` 兜底、NOT_EPUB/CORRUPT/EMPTY、DRM（rights.xml、正文加密）与字体混淆放行
- `epubToc.test.ts`：EPUB3 `nav` 优先、回退 `toc.ncx`、`fallbackToc` 兜底、层级与锚点、标题空白折叠
- `epubHtml.test.ts`：块级 class、`data-s`/`data-e`、行内标签不被二次转义、空章提示、标题转义
- `epubContent.test.ts`：archive → 章节文本 → `chunkEpubDocuments` 全链路，逐块断言 `chapterText.slice(loc_start, loc_end) === chunk.text`
- `epubBytes.test.ts`：base64 与 Node `Buffer` 对齐、UTF-8 宽松解码、BOM/UTF-16 识别
- `gbk.test.ts`：GB18030 双字节/四字节解码与 Node `TextDecoder` 随机交叉验证、二进制启发式
- `txtImport.test.ts`：GBK 正解码、二进制/伪 TXT 拒绝、UTF-8/UTF-16 回归

## 8. 失败记录模板

```text
设备/系统：
构建方式（run:android / EAS）：
复现步骤：
预期：
实际：
导入文件（类型 / 大小 / 来源）：
设置页诊断（FTS5/流式/schema）：
adb logcat 关键行：
是否可稳定复现：
```