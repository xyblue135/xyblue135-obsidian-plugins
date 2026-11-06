# -*- coding: utf-8 -*-
"""
xyblue135 · 视频分诊 (video-triage) 核心脚本
用法:
  python triage.py --url <B站链接或BV号> --vault <vault路径> [--cookies-from-browser edge] [--no-llm] [--model small]

流程: yt-dlp 拉字幕(无字幕则下载音频+faster-whisper转写) → LLM要点抽取
      → 知识库本地比对 → LLM三档判定(skip/skim/watch) → 写收件箱笔记
说明: 网关地址与 key 从 vault 里「AI 元数据」插件的 data.json 读取, 本脚本不存储密钥。
"""
import argparse, json, os, re, subprocess, sys, time, glob

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

def log(stage, msg):
    print("[triage:%s] %s" % (stage, msg), flush=True)

# ---------------- 网关配置（读 skill-miner 的 data.json, 不落密钥） ----------------
def load_gateway(vault):
    p = os.path.join(vault, ".obsidian", "plugins", "00_xyblue135-skill-miner", "data.json")
    try:
        d = json.load(open(p, encoding="utf-8"))
        s = d.get("settings", {})
        return s.get("baseUrl", ""), s.get("apiKey", ""), s.get("model", "auto")
    except Exception:
        return "", "", "auto"

def llm_chat(base, key, model, messages, timeout=180):
    import urllib.request
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.2}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]

def extract_json(text):
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)

# ---------------- ① 字幕 / 转写 ----------------
def run(cmd, timeout=600):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def try_subtitles(url, work, cookies):
    """返回 (文本, [(t,文本)] 或 None) —— 有 CC 字幕时解析为带时间戳文本"""
    cmd = ["yt-dlp", "--skip-download", "--write-subs", "--write-auto-subs",
           "--sub-langs", "zh-CN,zh-Hans,zh,ai-zh", "--sub-format", "json3/srt/vtt/best",
           "-o", os.path.join(work, "sub"), "--no-update"]
    if cookies:
        cmd += ["--cookies-from-browser", cookies]
    code, out = run(cmd + [url])
    subs = glob.glob(os.path.join(work, "sub*.vtt")) + glob.glob(os.path.join(work, "sub*.srt")) + \
           glob.glob(os.path.join(work, "sub*.json3"))
    if not subs:
        return None
    f = sorted(subs, key=os.path.getsize, reverse=True)[0]
    log("sub", "字幕文件: " + os.path.basename(f))
    if f.endswith(".json3"):
        d = json.load(open(f, encoding="utf-8"))
        out = []
        for ev in d.get("events", []):
            t = (ev.get("tStartMs", 0)) / 1000.0
            txt = "".join(s.get("utf8", "") for s in ev.get("segs", []) if s.get("utf8")).strip()
            if txt and txt != "\n":
                out.append((t, txt))
        return out
    # srt / vtt 粗解析
    out, cur_t = [], None
    for line in open(f, encoding="utf-8", errors="replace"):
        m = re.match(r"(\d+):(\d+):(\d+)[.,](\d+)\s*-->", line.strip())
        if m:
            cur_t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000
            continue
        t = line.strip()
        if t and not t.isdigit() and "-->" not in t and cur_t is not None:
            out.append((cur_t, t))
    return out or None

def transcribe(url, work, model_size):
    """下载音频 → faster-whisper 转写, 返回 [(秒, 文本)]"""
    code, out = run(["yt-dlp", "-x", "--audio-format", "m4a", "--audio-quality", "5",
                     "-o", os.path.join(work, "audio.%(ext)s"), "--no-update", url])
    audio = os.path.join(work, "audio.m4a")
    if not os.path.exists(audio):
        raise RuntimeError("音频下载失败: " + out[-400:])
    log("asr", "音频就绪, 开始转写 (%s)" % model_size)
    from faster_whisper import WhisperModel
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="int8_float16")
    except Exception:
        log("asr", "CUDA 不可用, 回退 CPU")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, language="zh", vad_filter=True)
    out = []
    for seg in segments:
        t = seg.text.strip()
        if t:
            out.append((seg.start, t))
    return out

def compress(tl, max_chars=7000):
    """时间轴文本 → 合并压缩给 LLM（保留头尾, 中段截断）"""
    lines = ["[%02d:%02d] %s" % (int(t // 60), int(t % 60), txt) for t, txt in tl]
    full = "\n".join(lines)
    if len(full) <= max_chars:
        return full
    head = "\n".join(lines[: max(10, int(len(lines) * 0.3))])
    tail = "\n".join(lines[-max(10, int(len(lines) * 0.3)):])
    return head + "\n…（中段已截断）…\n" + tail

# ---------------- ② 知识库本地比对 ----------------
FM = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)

def scan_vault(vault, root="00_docs"):
    """扫描知识库 frontmatter → [{path, title, tags, summary, depth}]"""
    base = os.path.join(vault, root)
    notes = []
    for dirpath, dirnames, filenames in os.walk(base):
        for fn in filenames:
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(dirpath, fn)
            try:
                text = open(full, encoding="utf-8", errors="replace").read(4096)
            except Exception:
                continue
            m = FM.match(text)
            if not m:
                continue
            fm, cur, tags = {}, None, []
            for line in m.group(1).split("\n"):
                s = line.strip()
                if s.startswith("- ") and cur == "AI_tags":
                    tags.append(s[2:].strip().strip("'\""))
                    continue
                km = re.match(r"^([A-Za-z_][\w\-]*)\s*:\s*(.*)$", s)
                if km:
                    cur, fm[km.group(1)] = km.group(1), km.group(2).strip()
            titles = fm.get("AI_title", "").strip("{}[]")
            notes.append({
                "path": os.path.relpath(full, os.path.join(vault, root)).replace(os.sep, "/"),
                "title": (titles.split(",")[0].strip("'\" ") if titles else fn[:-3]),
                "tags": tags,
                "summary": str(fm.get("AI_summary_short", ""))[:120],
                "depth": fm.get("AI_technical_depth", ""),
            })
    return notes

def recall(meta, video_tags, keywords, topk=8):
    """标签/关键词重叠打分, 取最相关候选笔记"""
    kws = set(t.lower() for t in video_tags) | set(k.lower() for k in keywords)
    scored = []
    for n in meta:
        ntags = set(t.lower() for t in n["tags"])
        hit = kws & ntags
        extra = sum(1 for k in kws if k and k in n["title"].lower())
        score = len(hit) * 2 + extra
        if score > 0:
            scored.append((score, hit, n))
    scored.sort(key=lambda x: -x[0])
    return scored[:topk]

# ---------------- ③ 主流程 ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--vault", required=True)
    ap.add_argument("--cookies-from-browser", dest="cookies", default="")
    ap.add_argument("--model", default="small")
    ap.add_argument("--inbox", default="00_docs/收件箱")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--keep-work", action="store_true")
    args = ap.parse_args()

    work = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
    os.makedirs(work, exist_ok=True)
    base, key, gmodel = load_gateway(args.vault)
    has_llm = bool(base and key) and not args.no_llm
    log("cfg", "LLM: %s | 模型: %s | cookies: %s" % ("可用" if has_llm else "关闭", gmodel, args.cookies or "无"))

    # ① 字幕优先, 无则转写
    tl = try_subtitles(args.url, work, args.cookies)
    src = "字幕"
    if not tl:
        log("sub", "无可用字幕(或未登录), 走 ASR 转写")
        tl = transcribe(args.url, work, args.model)
        src = "ASR转写"
    log("sub", "时间轴 %d 段 (%s)" % (len(tl), src))
    comp = compress(tl)

    # ② 要点抽取
    if has_llm:
        log("llm", "要点抽取中…")
        try:
            raw = llm_chat(base, key, gmodel, [
                {"role": "system", "content": "你是知识库助理。从视频字幕提取结构化要点, 只输出 JSON: "
                 "{\"title\":\"视频标题(<=20字)\", \"summary\":\"一句话概要(<=80字)\", "
                 "\"points\":[{\"t\":\"mm:ss\",\"point\":\"要点\"}] (最多10条), "
                 "\"tags\":[\"主题标签\"], \"keywords\":[\"关键术语\"]}"},
                {"role": "user", "content": "字幕如下(时间轴, 可能截断):\n" + comp},
            ])
            meta = extract_json(raw)
        except Exception as e:
            log("llm", "要点抽取失败, 降级本地模式: " + str(e)[:150])
            meta, has_llm = None, False
    else:
        meta = None
    if not meta:
        meta = {"title": "视频 " + args.url[-15:], "summary": comp[:80],
                "points": [{"t": "%02d:%02d" % (int(t // 60), int(t % 60)), "point": txt} for t, txt in tl[:10]],
                "tags": [], "keywords": []}

    # ③ 知识库比对
    notes = scan_vault(args.vault)
    hits = recall(notes, meta.get("tags", []), meta.get("keywords", []))
    log("match", "知识库 %d 篇, 命中候选 %d 篇" % (len(notes), len(hits)))

    # ④ 三档判定
    verdict = {"verdict": "watch", "reason": "（无 LLM, 仅本地比对粗判）", "new_knowledge": [], "jump": []}
    if has_llm:
        cand = "\n".join("- 《%s》[标签:%s 深度:%s] %s" % (n["title"], ",".join(n["tags"][:4]), n["depth"], n["summary"]) for _, _, n in hits) or "（无相似笔记）"
        log("llm", "判定中…")
        try:
            raw = llm_chat(base, key, gmodel, [
                {"role": "system", "content": "用户是运维/AI方向工程师, 维护个人知识库。根据视频要点与其知识库相似笔记, 判定视频对用户的价值。"
                 "只输出 JSON: {\"verdict\":\"skip|skim|watch\", \"reason\":\"判定理由(<=100字, 引用具体重叠笔记名)\", "
                 "\"new_knowledge\":[\"用户库里没有的新知识点\"], \"jump\":[\"值得跳看的时间点 mm:ss\"]}。"
                 "skip=核心内容用户已知; skim=只有个别点值得跳看; watch=有成块新知识。"},
                {"role": "user", "content": "【视频要点】\n标题: %s\n%s\n\n【知识库相似笔记】\n%s" %
                 (meta.get("title", ""), "\n".join("· " + p["point"] for p in meta.get("points", [])), cand)},
            ])
            verdict = extract_json(raw)
        except Exception as e:
            log("llm", "判定失败: " + str(e)[:150])
            if hits:
                verdict = {"verdict": "skim", "reason": "本地比对命中 %d 篇相似笔记(无 LLM 精判)" % len(hits),
                           "new_knowledge": [], "jump": []}
    elif hits:
        verdict["reason"] = "本地比对命中: " + ", ".join("《%s》" % n["title"] for _, _, n in hits[:3])

    # ⑤ 终端报告
    vmap = {"skip": "⛔ 跳过", "skim": "⚡ 速览", "watch": "✅ 值得看"}
    print("\n========== 分诊报告 ==========")
    print("视频: %s" % meta.get("title", ""))
    print("概要: %s" % meta.get("summary", ""))
    print("判定: %s" % vmap.get(verdict.get("verdict", "watch"), verdict.get("verdict")))
    print("理由: %s" % verdict.get("reason", ""))
    for k in verdict.get("new_knowledge", [])[:6]:
        print("  新知: " + str(k))
    for j in verdict.get("jump", [])[:5]:
        print("  跳看: " + str(j))
    if verdict.get("verdict") != "skip":
        print("要点:")
        for p in meta.get("points", [])[:10]:
            print("  [%s] %s" % (p.get("t", "?"), p.get("point", "")))
    print("==============================", flush=True)

    # ⑥ 收件箱笔记
    if verdict.get("verdict") != "skip":
        inbox = os.path.join(args.vault, args.inbox)
        os.makedirs(inbox, exist_ok=True)
        safe = re.sub(r'[\\/:*?"<>|]', "_", meta.get("title", "视频"))[:40]
        now = time.strftime("%Y%m%d%H%M%S") + "000"
        tags = meta.get("tags", [])[:5] or ["视频"]
        tok = int(len(comp) * 0.6)
        fm = ("---\nstatus: 🔴 undone\nvisibility: 🟢 open\nupdated: %s\ntoken_count: %d\n"
              "source: %s\ntriage: %s\nAI_tags:\n%s\nAI_summary_short: %s\n---\n"
              % (now, tok, args.url, verdict.get("verdict", "watch"),
                 "".join("  - %s\n" % t for t in tags), meta.get("summary", "")))
        body = "# %s\n\n> 来源: %s\n> 分诊: %s — %s\n\n## 要点时间轴\n%s\n" % (
            meta.get("title", "视频"), args.url,
            vmap.get(verdict.get("verdict", "watch")), verdict.get("reason", ""),
            "\n".join("- [%s] %s" % (p.get("t", "?"), p.get("point", "")) for p in meta.get("points", [])))
        note = os.path.join(inbox, safe + ".md")
        open(note, "w", encoding="utf-8").write(fm + body)
        print("[triage:done] 收件箱笔记: " + note, flush=True)
    else:
        print("[triage:done] 判定 skip, 未写笔记", flush=True)

    if not args.keep_work:
        for f in glob.glob(os.path.join(work, "sub*")) + glob.glob(os.path.join(work, "audio.*")):
            try:
                os.remove(f)
            except OSError:
                pass

if __name__ == "__main__":
    main()
