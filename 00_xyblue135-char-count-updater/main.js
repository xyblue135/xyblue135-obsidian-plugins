/*
 * xyblue135 私人 · Token 统计
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 * v4.0.0：移除 char_count 字段统计；移除全部黑名单配置（全局 / 忽略文件夹 / 字段级），
 *         改为白名单机制——仅处理白名单目录下的 Markdown（默认 00_docs 及其子笔记）。
 * v4.1.0：修复更新链静默失败、内部写入标记竞态、rename 丢更新、估算模式默认值、设置落盘竞态、
 *         汉字区间、frontmatter 解析、卸载清理等问题。
 */
"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  Notice,
  normalizePath,
  parseYaml,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  debounceMs: 5000,
  // 白名单：每行一个路径，可写文件夹（含全部子笔记）或单个文件；为空则不处理任何文件
  whitelist: "my_blog/00_docs",
  enableTokenCount: true,
  // 估算模式：false = 统一倍率（unifiedTokenFactor），true = 中英文分拆倍率；
  // 两者互斥，只有一组倍率参与计算。默认统一倍率，使 0.55 默认真实生效。
  splitTokenCount: false,
  unifiedTokenFactor: 0.55,
  chineseTokenFactor: 0.5,
  englishTokenFactor: 0.25,
  flushOnFileSwitch: true,
  flushOnWindowBlur: true,
  // 设置结构版本：用于把旧 data.json 迁移到新的估算模式语义（见 migrateSettings）
  settingsVersion: 2,
};

const SETTINGS_VERSION = 2;
const MIN_DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 60000;
const MIN_TOKEN_FACTOR = 0;
const MAX_TOKEN_FACTOR = 5;
const INTERNAL_WRITE_TIMEOUT_MS = 5000;
const TOKEN_WRITE_RETRY_TIMES = 1;
const TOKEN_WRITE_RETRY_DELAY_MS = 1000;
const FAILURE_NOTICE_INTERVAL_MS = 60000;
const SETTINGS_SAVE_DEBOUNCE_MS = 500;

class CharCountUpdaterPlugin extends Plugin {
  async onload() {
    this.unloaded = false;
    this.pendingUpdates = new Map();
    this.updateChains = new Map();
    this.internalWrites = new Map();
    this.saveChain = Promise.resolve();
    this.settingsSaveTimer = null;
    this.updateFailures = 0;
    this.lastUpdateError = null;
    this.lastFailureNoticeAt = 0;

    await this.loadSettings();

    this.addSettingTab(new CharCountSettingTab(this.app, this));
    this.addRibbonIcon("hash", "Token 统计 · 设置", () => { this.app.setting.open(); this.app.setting.openTabById("00_xyblue135-char-count-updater"); }).addClass("xyblue135-ribbon xyblue135-tool");

    this.app.workspace.onLayoutReady(() => {
      // 插件可能在库加载完成前就被停用，此时不要再向已卸载的实例注册全局监听
      if (this.unloaded) {
        return;
      }

      this.registerVaultEvents();
      this.registerFlushEvents();
    });
  }

  onunload() {
    this.unloaded = true;

    // 未落盘设置：先立即保存一次，避免关闭前改的设置丢失
    if (this.settingsSaveTimer) {
      clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
      void this.saveSettings();
    }

    // 仍在防抖等待中的文件先入队处理，避免最后一轮编辑的 token_count 被静默丢弃
    const pending = Array.from(this.pendingUpdates.values());
    for (const entry of pending) {
      clearTimeout(entry.timer);
    }
    this.pendingUpdates.clear();

    const settle =
      pending.length > 0
        ? Promise.all(pending.map((entry) => this.enqueueUpdate(entry.file)))
        : Promise.resolve();

    void settle
      .catch((err) => {
        console.warn("[token-count] 卸载前的最后一次更新失败", err);
      })
      .finally(() => {
        this.updateChains.clear();
        this.internalWrites.clear();
      });
  }

  registerVaultEvents() {
    if (!this.app || this.unloaded) {
      return;
    }

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        if (!this.isWhitelisted(file.path) || this.consumeInternalWrite(file.path)) {
          return;
        }

        this.scheduleUpdate(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        if (this.isWhitelisted(file.path)) {
          this.scheduleUpdate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.clearPathState(oldPath);

        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        this.clearPathState(file.path);

        // 改名会清掉旧路径上的待处理项，这里对新路径重新入队，
        // 否则防抖窗口内的这次编辑会被永久丢掉（含“改名后进入白名单”的情况）
        if (this.isWhitelisted(file.path)) {
          this.scheduleUpdate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.clearPathState(file.path);
        }
      })
    );
  }

  registerFlushEvents() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.settings.flushOnFileSwitch) {
          void this.flushPendingUpdates();
        }
      })
    );

    this.registerDomEvent(window, "blur", () => {
      if (this.settings.flushOnWindowBlur) {
        void this.flushPendingUpdates();
      }
    });
  }

  clearPathState(path) {
    const pending = this.pendingUpdates.get(path);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingUpdates.delete(path);
    }

    this.updateChains.delete(path);
    this.internalWrites.delete(path);
  }

  scheduleUpdate(file) {
    const previous = this.pendingUpdates.get(file.path);

    if (previous) {
      clearTimeout(previous.timer);
    }

    const timer = setTimeout(() => {
      this.pendingUpdates.delete(file.path);
      void this.enqueueUpdate(file);
    }, this.settings.debounceMs);

    this.pendingUpdates.set(file.path, {
      file,
      timer,
    });
  }

  async flushPendingUpdates() {
    const entries = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    for (const entry of entries) {
      clearTimeout(entry.timer);
    }

    await Promise.all(
      entries.map((entry) => this.enqueueUpdate(entry.file))
    );
  }

  enqueueUpdate(file) {
    const previous = this.updateChains.get(file.path) ?? Promise.resolve();

    const next = previous
      .catch((err) => {
        // 前一环失败不影响后续（但必须留痕，不能完全静默）
        console.warn("[token-count] 上一次更新失败（已忽略，继续排队）", file.path, err);
        return undefined;
      })
      .then(() => this.updateFile(file))
      .catch((err) => {
        this.reportUpdateFailure(file, err);
        return undefined;
      })
      .finally(() => {
        if (this.updateChains.get(file.path) === next) {
          this.updateChains.delete(file.path);
        }
      });

    this.updateChains.set(file.path, next);
    return next;
  }

  // 记录并提示更新失败：控制台始终有日志，Notice 做节流（首次立即提示，之后每 60 秒最多一次）
  reportUpdateFailure(file, err) {
    this.updateFailures += 1;
    this.lastUpdateError = {
      path: file.path,
      message: String(err && err.message ? err.message : err),
      at: Date.now(),
    };

    console.error("[token-count] 更新 token_count 失败", file.path, err);

    const now = Date.now();

    if (now - this.lastFailureNoticeAt >= FAILURE_NOTICE_INTERVAL_MS) {
      this.lastFailureNoticeAt = now;
      new Notice(
        `Token 统计：更新 ${file.path} 失败（本次会话累计 ${this.updateFailures} 次），详见控制台 [token-count]`
      );
    }
  }

  consumeInternalWrite(path) {
    const until = this.internalWrites.get(path);

    if (!until) {
      return false;
    }

    this.internalWrites.delete(path);
    return Date.now() <= until;
  }

  markInternalWrite(path) {
    this.internalWrites.set(path, Date.now() + INTERNAL_WRITE_TIMEOUT_MS);
  }

  // ── 路径解析工具 ──────────────────────────────────────

  parsePathList(raw) {
    if (!raw || typeof raw !== "string") {
      return [];
    }
    return raw
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => normalizePath(p).replace(/\/$/, ""));
  }

  pathMatches(path, entry) {
    const normalized = normalizePath(path);
    // 精确匹配文件路径
    if (normalized === entry) {
      return true;
    }
    // 前缀匹配文件夹路径（含其全部子笔记）
    if (normalized.startsWith(entry + "/")) {
      return true;
    }
    return false;
  }

  pathMatchesAny(path, entries) {
    return entries.some((entry) => this.pathMatches(path, entry));
  }

  // ── 白名单（处理范围） ────────────────────────────────

  getWhitelist() {
    return this.parsePathList(this.settings.whitelist);
  }

  isWhitelisted(path) {
    const entries = this.getWhitelist();
    if (entries.length === 0) {
      return false;
    }
    return this.pathMatchesAny(path, entries);
  }

  // ── Frontmatter 解析 ──────────────────────────────────

  getFrontmatterMatch(content) {
    const bomOffset = content.charCodeAt(0) === 0xfeff ? 1 : 0;
    const source = content.slice(bomOffset);
    const match = source.match(
      /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
    );

    return match
      ? {
          source,
          full: match[0],
          block: match[1],
        }
      : null;
  }

  extractBody(content) {
    const frontmatter = this.getFrontmatterMatch(content);
    const source = frontmatter
      ? frontmatter.source.slice(frontmatter.full.length)
      : content.charCodeAt(0) === 0xfeff
        ? content.slice(1)
        : content;

    return source.replace(/\r\n/g, "\n");
  }

  // 用 Obsidian 自带的 YAML 解析器读取 frontmatter，避免行首正则被块标量、嵌套键误伤
  readFrontmatterObject(content) {
    const frontmatter = this.getFrontmatterMatch(content);

    if (!frontmatter) {
      return null;
    }

    try {
      const parsed = parseYaml(frontmatter.block);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      // 解析失败（YAML 不合法）时回退到下面的正则实现，保证旧行为不至于完全失效
      console.warn("[token-count] frontmatter YAML 解析失败，回退到正则匹配", err);
      return null;
    }
  }

  hasFrontmatterKey(content, key) {
    const data = this.readFrontmatterObject(content);

    if (data) {
      // 只认顶层键：嵌套 map 里的同名键不算“字段已存在”
      return Object.prototype.hasOwnProperty.call(data, key);
    }

    const frontmatter = this.getFrontmatterMatch(content);

    if (!frontmatter) {
      return false;
    }

    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedKey}\\s*:`, "m").test(frontmatter.block);
  }

  readFrontmatterValue(content, key) {
    const data = this.readFrontmatterObject(content);

    if (data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        return undefined;
      }

      const value = data[key];

      if (value === null || value === undefined) {
        return "";
      }

      return typeof value === "object" ? JSON.stringify(value) : String(value);
    }

    const frontmatter = this.getFrontmatterMatch(content);

    if (!frontmatter) {
      return undefined;
    }

    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = frontmatter.block.match(
      new RegExp(`^${escapedKey}\\s*:\\s*(.*?)\\s*$`, "m")
    );

    if (!match) {
      return undefined;
    }

    const value = match[1].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value;
  }

  // 读取 token_count 数字值：容忍千分位等分隔符，无法解析时返回 NaN
  readTokenCountNumber(content) {
    const raw = this.readFrontmatterValue(content, "token_count");

    if (raw === undefined || raw === null) {
      return Number.NaN;
    }

    return Number.parseFloat(String(raw).replace(/[,\s_]/g, ""));
  }

  isHanCodePoint(codePoint) {
    return (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x2ebef) ||
      (codePoint >= 0x2ebf0 && codePoint <= 0x2ee5d) ||
      (codePoint >= 0x2f800 && codePoint <= 0x2fa1f) ||
      // CJK 扩展 G / H / I 区（U+30000–U+323AF），生僻字、古籍字都在这里
      (codePoint >= 0x30000 && codePoint <= 0x323af)
    );
  }

  analyzeBody(body) {
    let charCount = 0;
    let chineseCount = 0;

    for (const character of body) {
      charCount += 1;

      if (this.isHanCodePoint(character.codePointAt(0))) {
        chineseCount += 1;
      }
    }

    return {
      charCount,
      chineseCount,
      englishCount: charCount - chineseCount,
    };
  }

  calculateTokenCount(stats) {
    if (this.settings.splitTokenCount) {
      return Math.round(
        stats.chineseCount * this.settings.chineseTokenFactor +
          stats.englishCount * this.settings.englishTokenFactor
      );
    }

    return Math.round(stats.charCount * this.settings.unifiedTokenFactor);
  }

  async updateFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    if (!this.settings.enableTokenCount || !this.isWhitelisted(file.path)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const frontmatter = this.getFrontmatterMatch(content);

    if (!frontmatter) {
      return;
    }

    // 00_metadata 单点模式:正文没有 token_count 时,改写到 sidecar(存在且含该键才写)
    let targetFile = file;
    let targetContent = content;
    if (!this.hasFrontmatterKey(content, "token_count")) {
      const sidecar = this.findMetadataSidecar(file);
      if (!sidecar) {
        return;
      }
      targetFile = sidecar;
      targetContent = await this.app.vault.cachedRead(sidecar);
      if (!this.hasFrontmatterKey(targetContent, "token_count")) {
        return;
      }
    }

    const body = this.extractBody(content);
    const stats = this.analyzeBody(body);
    const tokenCount = this.calculateTokenCount(stats);

    const existingTokenCount = this.readTokenCountNumber(targetContent);

    // NaN（值为空或非数字）一律视为“不一致”，需要写入
    if (Number.isFinite(existingTokenCount) && existingTokenCount === tokenCount) {
      return;
    }

    this.markInternalWrite(targetFile.path);

    try {
      await this.processFrontMatterWithRetry(targetFile, tokenCount);
    } catch (err) {
      // 写入失败必须立刻撤销「内部写入」标记，
      // 否则用户接下来的第一次真实编辑会被当成插件自己的写入而丢弃
      this.internalWrites.delete(targetFile.path);
      throw err;
    }
  }

  // 与 metadata-ai 的 sidecarNameCandidates 一致:平铺名 + 重名 FNV-1a 哈希后缀。
  metadataSidecarCandidates(path) {
    const base = String(path || "").replace(/\.md$/i, "").split("/").pop() || "untitled";
    let hash = 0x811c9dc5;
    for (let i = 0; i < path.length; i += 1) {
      hash ^= path.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return [
      "00_metadata/" + base + ".md",
      "00_metadata/" + base + "__" + (hash >>> 0).toString(16).padStart(8, "0") + ".md",
    ];
  }

  findMetadataSidecar(file) {
    for (const name of this.metadataSidecarCandidates(file.path)) {
      const abstract = this.app.vault.getAbstractFileByPath(name);
      if (!(abstract instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(abstract);
      const doc = cache && cache.frontmatter ? cache.frontmatter.doc : null;
      if (!doc || doc === file.path) return abstract;
    }
    return null;
  }

  // 写入 token_count：失败时延迟重试一次，最终仍失败则抛出，由调用链记录
  async processFrontMatterWithRetry(file, tokenCount) {
    let lastError;

    for (let attempt = 0; attempt <= TOKEN_WRITE_RETRY_TIMES; attempt += 1) {
      try {
        await this.app.fileManager.processFrontMatter(file, (metadata) => {
          metadata.token_count = tokenCount;
        });
        return;
      } catch (err) {
        lastError = err;

        if (attempt < TOKEN_WRITE_RETRY_TIMES) {
          console.warn(
            "[token-count] 写入 token_count 失败，1 秒后重试",
            file.path,
            err
          );
          await new Promise((resolve) =>
            setTimeout(resolve, TOKEN_WRITE_RETRY_DELAY_MS)
          );
        }
      }
    }

    throw lastError;
  }

  validateNumber(value, fallback, min, max) {
    const number = Number.parseFloat(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(Math.max(number, min), max);
  }

  validateSettings(settings) {
    return {
      debounceMs: Math.round(
        this.validateNumber(
          settings.debounceMs,
          DEFAULT_SETTINGS.debounceMs,
          MIN_DEBOUNCE_MS,
          MAX_DEBOUNCE_MS
        )
      ),
      whitelist:
        typeof settings.whitelist === "string"
          ? settings.whitelist
          : DEFAULT_SETTINGS.whitelist,
      enableTokenCount:
        settings.enableTokenCount === undefined
          ? DEFAULT_SETTINGS.enableTokenCount
          : Boolean(settings.enableTokenCount),
      splitTokenCount:
        settings.splitTokenCount === undefined
          ? DEFAULT_SETTINGS.splitTokenCount
          : Boolean(settings.splitTokenCount),
      unifiedTokenFactor: this.validateNumber(
        settings.unifiedTokenFactor,
        DEFAULT_SETTINGS.unifiedTokenFactor,
        MIN_TOKEN_FACTOR,
        MAX_TOKEN_FACTOR
      ),
      chineseTokenFactor: this.validateNumber(
        settings.chineseTokenFactor,
        DEFAULT_SETTINGS.chineseTokenFactor,
        MIN_TOKEN_FACTOR,
        MAX_TOKEN_FACTOR
      ),
      englishTokenFactor: this.validateNumber(
        settings.englishTokenFactor,
        DEFAULT_SETTINGS.englishTokenFactor,
        MIN_TOKEN_FACTOR,
        MAX_TOKEN_FACTOR
      ),
      flushOnFileSwitch:
        settings.flushOnFileSwitch === undefined
          ? DEFAULT_SETTINGS.flushOnFileSwitch
          : Boolean(settings.flushOnFileSwitch),
      flushOnWindowBlur:
        settings.flushOnWindowBlur === undefined
          ? DEFAULT_SETTINGS.flushOnWindowBlur
          : Boolean(settings.flushOnWindowBlur),
      settingsVersion: SETTINGS_VERSION,
    };
  }

  // 旧版 data.json（没有 settingsVersion）迁移：
  // 旧版把默认值 splitTokenCount: true 一并写进了 data.json，无法区分「默认填充」与「用户显式开启」，
  // 因此这里只补缺失字段，绝不改写已有的值——否则会静默改掉用户配置，
  // 并让已按分拆倍率算出的 token_count 口径突然变化（4.4）。
  // 「统一倍率永远不生效」的问题由默认值 + 设置页明示当前生效模式来解决。
  migrateSettings(raw) {
    // 全新安装（没有 data.json）不需要迁移，直接走默认值
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
      return { settings: {}, changed: false };
    }

    if (Number(raw.settingsVersion) >= SETTINGS_VERSION) {
      return { settings: raw, changed: false };
    }

    const settings = Object.assign({}, raw);

    if (settings.splitTokenCount === undefined) {
      settings.splitTokenCount = DEFAULT_SETTINGS.splitTokenCount;
    }

    settings.settingsVersion = SETTINGS_VERSION;
    return { settings, changed: true };
  }

  async loadSettings() {
    const { settings, changed } = this.migrateSettings((await this.loadData()) ?? {});
    this.settings = this.validateSettings(settings);

    if (changed) {
      const modeText = this.settings.splitTokenCount
        ? "中英文分拆倍率（统一倍率不参与计算）"
        : "统一倍率（中文/英文分拆倍率不参与计算）";

      console.info(
        "[token-count] 已升级旧版设置结构，保留原有估算模式：",
        modeText,
        "unifiedTokenFactor =",
        this.settings.unifiedTokenFactor
      );

      new Notice(
        `Token 统计：设置结构已升级（保留了原有的估算模式「${modeText}」），可在插件设置中随时切换。`
      );

      try {
        await this.saveData(this.settings);
      } catch (err) {
        console.error("[token-count] 写回迁移后的设置失败", err);
      }
    }
  }

  // 文本类设置逐字输入时只做防抖保存，避免把 “5”→“250” 这类中间值落盘
  scheduleSaveSettings() {
    if (this.settingsSaveTimer) {
      clearTimeout(this.settingsSaveTimer);
    }

    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.saveSettings();
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  }

  // 立即落盘（失焦 / 关闭页面 / 卸载时调用）
  flushSettingsSave() {
    if (this.settingsSaveTimer) {
      clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
    }

    return this.saveSettings();
  }

  async saveSettings() {
    // 串行化落盘：多个 saveData 并发时最后写入的可能是中间值，这里用一条 promise 链排队
    this.saveChain = (this.saveChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        this.settings = this.validateSettings(this.settings);
        await this.saveData(this.settings);
      })
      .catch((err) => {
        console.error("[token-count] 保存设置失败", err);
      });

    return this.saveChain;
  }
}

class CharCountSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 文本输入失焦：立刻落盘，并把输入框校正为校验后的真实值（避免输入框显示的与 data.json 不一致）
  registerTextCommit(input, readValidated) {
    input.inputEl.addEventListener("blur", () => {
      void this.plugin.flushSettingsSave().then(() => {
        if (typeof readValidated === "function") {
          input.setValue(readValidated());
        }
      });
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "xyblue135 私人 · Token 统计" });
    containerEl.createEl("p", {
      text: "插件只修改 YAML 中已经存在的 token_count 字段，绝不会创建字段或 frontmatter。",
      cls: "setting-item-description",
    });

    // ═══ ① 白名单（处理范围）═══
    containerEl.createEl("h3", { text: "① 白名单（处理范围）" });
    containerEl.createEl("p", {
      text: "只有白名单命中的文件才会被处理，其余一律跳过。每行一个 Vault 相对路径：写文件夹则包含其全部子笔记，写具体 .md 则是单个文件。白名单为空时不处理任何文件。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("白名单目录 / 文件")
      .setDesc("默认 my_blog/00_docs（含其下全部子笔记）。每行一个路径，例如 my_blog/00_docs")
      .addTextArea((text) => {
        const input = text
          .setPlaceholder("my_blog/00_docs")
          .setValue(this.plugin.settings.whitelist)
          .onChange((value) => {
            // 逐字输入只做防抖保存，失焦时立即落盘
            this.plugin.settings.whitelist = value;
            this.plugin.scheduleSaveSettings();
          });

        this.registerTextCommit(input);
        return input;
      });

    // ═══ ② token_count 总开关 ═══
    containerEl.createEl("h3", { text: "② token_count 总开关" });

    new Setting(containerEl)
      .setName("Token 估算 · token_count")
      .setDesc("【开】编辑后更新 Token 估算值（依赖下方倍率设置）；【关】完全不碰此字段。默认开。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableTokenCount)
          .onChange(async (value) => {
            this.plugin.settings.enableTokenCount = value;
            await this.plugin.saveSettings();
          })
      );

    // ═══ ③ Token 估算参数（仅 token_count 开启时生效）═══
    containerEl.createEl("h3", { text: "③ Token 估算参数（仅 token_count 开启时生效）" });

    // 明确指出「当前真正生效的是哪一组倍率」，避免调了不生效的倍率却毫无反馈
    const activeModeText = this.plugin.settings.splitTokenCount
      ? `当前生效：中英文分拆 —— token_count = 汉字数 × ${this.plugin.settings.chineseTokenFactor} + 英文及其他字符数 × ${this.plugin.settings.englishTokenFactor}（统一倍率 ${this.plugin.settings.unifiedTokenFactor} 不参与计算）`
      : `当前生效：统一倍率 —— token_count = 正文字符数 × ${this.plugin.settings.unifiedTokenFactor}（中文/英文分拆倍率不参与计算）`;

    containerEl.createEl("p", {
      text: activeModeText,
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("中英文分别估算")
      .setDesc(
        "【开】汉字与英文及其他字符各用一组倍率（下方中文/英文倍率生效，统一倍率被忽略）；【关】全部字符统一乘统一倍率（中文/英文倍率被忽略）。两种模式互斥，同一时刻只有一组倍率真实生效。默认关（统一倍率 0.55）。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.splitTokenCount)
          .onChange(async (value) => {
            this.plugin.settings.splitTokenCount = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("中文字符倍率")
      .setDesc(
        this.plugin.settings.splitTokenCount
          ? "默认 0.50；识别 Unicode 汉字，包含常用字和扩展区汉字（当前生效）"
          : "默认 0.50；识别 Unicode 汉字，包含常用字和扩展区汉字（当前未生效，仅「中英文分别估算」开启时参与计算）"
      )
      .addText((text) => {
        const input = text
          .setPlaceholder("0.50")
          .setValue(String(this.plugin.settings.chineseTokenFactor))
          .onChange((value) => {
            this.plugin.settings.chineseTokenFactor = value;
            this.plugin.scheduleSaveSettings();
          });

        this.registerTextCommit(input, () =>
          String(this.plugin.settings.chineseTokenFactor)
        );
        return input;
      });

    new Setting(containerEl)
      .setName("英文及其他字符倍率")
      .setDesc(
        this.plugin.settings.splitTokenCount
          ? "默认 0.25；用于英文、数字、空格、标点、Markdown 和代码字符（当前生效）"
          : "默认 0.25；用于英文、数字、空格、标点、Markdown 和代码字符（当前未生效，仅「中英文分别估算」开启时参与计算）"
      )
      .addText((text) => {
        const input = text
          .setPlaceholder("0.25")
          .setValue(String(this.plugin.settings.englishTokenFactor))
          .onChange((value) => {
            this.plugin.settings.englishTokenFactor = value;
            this.plugin.scheduleSaveSettings();
          });

        this.registerTextCommit(input, () =>
          String(this.plugin.settings.englishTokenFactor)
        );
        return input;
      });

    new Setting(containerEl)
      .setName("统一 Token 倍率")
      .setDesc(
        this.plugin.settings.splitTokenCount
          ? "默认 0.55；token_count = 正文 Unicode 字符数 × 统一倍率（当前未生效，仅「中英文分别估算」关闭时参与计算）"
          : "默认 0.55；token_count = 正文 Unicode 字符数 × 统一倍率（当前生效）"
      )
      .addText((text) => {
        const input = text
          .setPlaceholder("0.55")
          .setValue(String(this.plugin.settings.unifiedTokenFactor))
          .onChange((value) => {
            this.plugin.settings.unifiedTokenFactor = value;
            this.plugin.scheduleSaveSettings();
          });

        this.registerTextCommit(input, () =>
          String(this.plugin.settings.unifiedTokenFactor)
        );
        return input;
      });

    // ═══ ④ 自动更新节奏 ═══
    containerEl.createEl("h3", { text: "④ 自动更新节奏" });

    new Setting(containerEl)
      .setName("防抖延迟（毫秒）")
      .setDesc("停止编辑后多久更新；建议 3000～8000")
      .addText((text) => {
        const input = text
          .setPlaceholder("5000")
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange((value) => {
            // 先只记原始字符串：逐字落盘会把 “5” 按最小值 250 写进 data.json
            this.plugin.settings.debounceMs = value;
            this.plugin.scheduleSaveSettings();
          });

        this.registerTextCommit(input, () => String(this.plugin.settings.debounceMs));
        return input;
      });

    new Setting(containerEl)
      .setName("切换文件时立即更新")
      .setDesc("切换笔记时立即处理仍在防抖等待中的文件")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.flushOnFileSwitch)
          .onChange(async (value) => {
            this.plugin.settings.flushOnFileSwitch = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("窗口失焦时立即更新")
      .setDesc("切换到其他应用时处理仍在防抖等待中的文件")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.flushOnWindowBlur)
          .onChange(async (value) => {
            this.plugin.settings.flushOnWindowBlur = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = CharCountUpdaterPlugin;
