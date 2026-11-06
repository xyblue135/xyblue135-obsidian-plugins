# xyblue135 · 视频分诊

粘贴 B 站链接 → 自动判定视频对你（你的知识库）值不值得看。

## 流程

yt-dlp 拉字幕（需 Cookie；无字幕走本地 whisper 转写）→ 网关 LLM 提取要点 → 与 00_docs 知识库标签/摘要比对 → 三档判定（⛔跳过 / ⚡速览 / ✅值得看）→ 非 skip 自动写收件箱笔记（status: undone），由「待完成工作台」接管。

## 本机依赖（已验证）

- yt-dlp、ffmpeg（已在 PATH）
- faster-whisper 1.2.1（RTX 4060 上 2 分钟视频约 7 秒转写）
- AI 网关：复用「AI 元数据」插件的 baseUrl/key/model，本插件不存密钥

## Cookie 说明

B 站字幕必须登录态。设置里填 Cookie 来源浏览器（edge/chrome/firefox），拉取时需该浏览器已关闭或允许读取；不填则全走 whisper 转写，一样能用。

## 已知边界

- 番剧/付费内容无会员只有预览（yt-dlp 提示）
- yt-dlp 被 B 站风控弄坏时升级：`pip install -U yt-dlp`
- whisper 模型首次自动下载（走 hf-mirror）
