/*
 * xyblue135 私人 · 图片缩放与相框
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const CURRENT_SETTINGS_VERSION = 5;
const FRAME_THEMES = {
    'mc-cherry': {
        id: 'mc-cherry',
        name: 'MC 樱花木',
        description: '低饱和粉色像素木框，接近 Minecraft 樱花木的柔和粉木层次。',
        borderWidth: 4,
        pixelUnit: 1,
        margin: 12,
        radius: 0,
        mainColor: '#d88f9f',
        backgroundColor: '#f4c6ce',
        innerDarkColor: '#8f5966',
        lightColor: '#efb4c0',
        outerColor: '#a96877',
        shadowColor: '#5a2d3c',
        shadowOpacity: 0.22
    },
    'mc-deepslate': {
        id: 'mc-deepslate',
        name: 'MC 深板岩',
        description: '深灰黑像素层，适合终端、服务器、网络拓扑等技术截图。',
        borderWidth: 4,
        pixelUnit: 1,
        margin: 12,
        radius: 0,
        mainColor: '#4b515a',
        backgroundColor: '#272b31',
        innerDarkColor: '#111419',
        lightColor: '#717a86',
        outerColor: '#343940',
        shadowColor: '#080a0d',
        shadowOpacity: 0.46
    },
    'mc-crimson': {
        id: 'mc-crimson',
        name: 'MC 绯红木',
        description: '下界绯红木风格，酒红与暗紫层次更强，适合强调型截图。',
        borderWidth: 4,
        pixelUnit: 1,
        margin: 12,
        radius: 0,
        mainColor: '#98465d',
        backgroundColor: '#5c2439',
        innerDarkColor: '#32101f',
        lightColor: '#cb6681',
        outerColor: '#712d47',
        shadowColor: '#330b1b',
        shadowOpacity: 0.38
    },
    'mc-amethyst': {
        id: 'mc-amethyst',
        name: 'MC 紫水晶',
        description: '紫水晶簇的深浅紫层次，明亮但不过分刺眼。',
        borderWidth: 4,
        pixelUnit: 1,
        margin: 12,
        radius: 0,
        mainColor: '#9e70d2',
        backgroundColor: '#d9c7ef',
        innerDarkColor: '#50356f',
        lightColor: '#c9a6eb',
        outerColor: '#704b98',
        shadowColor: '#382550',
        shadowOpacity: 0.32
    },
    'oxidized-copper': {
        id: 'oxidized-copper',
        name: '氧化铜',
        description: '青铜与氧化铜绿组合，偏工业、机械、基础设施风格。',
        borderWidth: 3,
        pixelUnit: 1,
        margin: 12,
        radius: 2,
        mainColor: '#4fa99f',
        backgroundColor: '#b9ddd8',
        innerDarkColor: '#245b56',
        lightColor: '#7ac8bd',
        outerColor: '#347f77',
        shadowColor: '#1c4d49',
        shadowOpacity: 0.32
    },
    'black-gold': {
        id: 'black-gold',
        name: '黑金典藏',
        description: '哑黑底配香槟金多层边框，偏高级展示和作品集风格。',
        borderWidth: 3,
        pixelUnit: 2,
        margin: 14,
        radius: 3,
        mainColor: '#c9aa5f',
        backgroundColor: '#171717',
        innerDarkColor: '#5d491d',
        lightColor: '#ead48f',
        outerColor: '#312812',
        shadowColor: '#000000',
        shadowOpacity: 0.48
    },
    'frost-glass': {
        id: 'frost-glass',
        name: '冰霜玻璃',
        description: '浅蓝银白层次和柔和阴影，适合浅色主题和干净的文档截图。',
        borderWidth: 2,
        pixelUnit: 1,
        margin: 14,
        radius: 10,
        mainColor: '#b8d9e8',
        backgroundColor: '#edf9ff',
        innerDarkColor: '#729fb5',
        lightColor: '#ffffff',
        outerColor: '#9bc7dc',
        shadowColor: '#557b8d',
        shadowOpacity: 0.24
    },
    'cyber-neon': {
        id: 'cyber-neon',
        name: '赛博霓虹',
        description: '青绿、紫色和洋红的霓虹层，适合深色主题、代码和监控面板。',
        borderWidth: 3,
        pixelUnit: 1,
        margin: 14,
        radius: 5,
        mainColor: '#39f0d0',
        backgroundColor: '#07151b',
        innerDarkColor: '#ff4fd8',
        lightColor: '#8bfff1',
        outerColor: '#625dff',
        shadowColor: '#00d9ff',
        shadowOpacity: 0.42
    }
};
const DEFAULT_SETTINGS = {
    settingsVersion: CURRENT_SETTINGS_VERSION,
    modifier: 'Shift',
    step: 0.15,
    minScale: 0.35,
    maxScale: 4.0,
    showScaleBadge: true,
    frameEnabled: true,
    frameTheme: 'mc-cherry',
    frameBorderWidth: FRAME_THEMES['mc-cherry'].borderWidth,
    framePixelUnit: FRAME_THEMES['mc-cherry'].pixelUnit,
    frameMargin: FRAME_THEMES['mc-cherry'].margin,
    frameRadius: FRAME_THEMES['mc-cherry'].radius,
    frameMainColor: FRAME_THEMES['mc-cherry'].mainColor,
    frameBackgroundColor: FRAME_THEMES['mc-cherry'].backgroundColor,
    frameInnerDarkColor: FRAME_THEMES['mc-cherry'].innerDarkColor,
    frameLightColor: FRAME_THEMES['mc-cherry'].lightColor,
    frameOuterColor: FRAME_THEMES['mc-cherry'].outerColor,
    frameShadowColor: FRAME_THEMES['mc-cherry'].shadowColor,
    frameShadowOpacity: FRAME_THEMES['mc-cherry'].shadowOpacity
};
class LocalImageHoverZoomPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.imageStates = new WeakMap();
        this.badgeEl = null;
        this.badgeTimer = null;
        this.frameObserver = null;
        this.refreshTimer = null;
        // 9.3：缓存“图片资源 → 源码 embed 是否标准 ![]()”的判定结果，元数据变化时清空。
        this.embedMatchCache = new Map();
        // 9.8：防抖写盘定时器与串行写入队列。
        this.saveTimer = null;
        this.pendingSave = Promise.resolve();
    }
    async onload() {
        await this.loadSettings();
        // 只监听 Obsidian 当前界面中的 DOM 事件，不读取或改写 Markdown 文件内容。
        // 9.4 修复：主窗口与每个弹出窗口（pop-out）都要注册同一套监听，否则弹窗里的图片无法缩放。
        this.registerWindowListeners(document);
        for (const doc of this.getAllDocuments()) {
            if (doc !== document)
                this.registerWindowListeners(doc);
        }
        this.registerEvent(this.app.workspace.on('window-open', (workspaceWindow, win) => {
            // 9.4：window-open 的回调参数是 (WorkspaceWindow, Window)，第二个是窗口对象而不是 document，
            // 必须取出它的 document 再注册监听/写 CSS 变量，否则弹窗里的相框变量根本写不进去。
            const doc = (win && win.document) || (workspaceWindow && workspaceWindow.doc) || null;
            if (!doc)
                return;
            this.registerWindowListeners(doc);
            // 新窗口可能还没有 leaf，先直接给这个窗口写入 CSS 变量再整体刷新一次。
            if (doc.documentElement)
                this.applyFrameCssVariablesTo(doc.documentElement);
            this.applyFrameCssVariables();
            if (this.frameObserver && doc.body)
                this.frameObserver.observe(doc.body, { childList: true, subtree: true });
            this.scheduleRefreshFrameClasses();
        }));
        // 相框只标记标准 Markdown 的 ![]() 图片；MutationObserver 用于处理后续动态渲染。
        this.startFrameObserver();
        this.applyFrameCssVariables();
        this.scheduleRefreshFrameClasses();
        // 切换笔记、布局变化或元数据刷新后重新核对，避免旧 DOM 标记残留。
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefreshFrameClasses()));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleRefreshFrameClasses()));
        this.registerEvent(this.app.metadataCache.on('changed', () => {
            // 9.3：元数据变化后清空 embed 匹配缓存，避免读到过期判定。
            this.embedMatchCache.clear();
            this.scheduleRefreshFrameClasses();
        }));
        this.addCommand({
            id: 'toggle-image-frame',
            name: '切换图片相框',
            callback: async () => {
                this.settings.frameEnabled = !this.settings.frameEnabled;
                await this.saveSettings();
                this.refreshFrameClasses();
            }
        });
        this.addSettingTab(new ImageHoverZoomSettingTab(this.app, this));
        this.addRibbonIcon("zoom-in", "图片缩放 · 设置", () => { this.app.setting.open(); this.app.setting.openTabById("00_xyblue135-image-zoom"); }).addClass("xyblue135-ribbon xyblue135-tool");
    }
    onunload() {
        var _a;
        this.resetAllImages();
        this.removeAllFrameClasses();
        this.removeFrameCssVariables();
        (_a = this.frameObserver) === null || _a === void 0 ? void 0 : _a.disconnect();
        this.frameObserver = null;
        if (this.refreshTimer !== null)
            window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        // 9.8：卸载时取消尚未执行的防抖写盘。
        if (this.saveTimer !== null)
            window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.removeBadge();
    }
    /** 9.4：在指定窗口的 document 上注册滚轮与双击监听，主窗口和弹出窗口共用同一套逻辑。 */
    registerWindowListeners(doc) {
        this.registerDomEvent(doc, 'wheel', (event) => this.onWheel(event), {
            capture: true,
            passive: false
        });
        // 按住设定组合键双击图片，可恢复该图片到首次缩放前的显示尺寸。
        this.registerDomEvent(doc, 'dblclick', (event) => this.onDoubleClick(event), true);
    }
    /** 9.4：主窗口 + 所有弹出窗口对应的 document 列表（用于相框标记与 CSS 变量写入）。 */
    getAllDocuments() {
        const docs = [document];
        this.app.workspace.iterateAllLeaves((leaf) => {
            var _a, _b, _c;
            const doc = (_c = (_b = (_a = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _a === void 0 ? void 0 : _a.containerEl) === null || _b === void 0 ? void 0 : _b.ownerDocument) !== null && _c !== void 0 ? _c : null;
            if (doc && !docs.includes(doc))
                docs.push(doc);
        });
        return docs;
    }
    async loadSettings() {
        const raw = (await this.loadData());
        const oldSettings = raw !== null && raw !== void 0 ? raw : {};
        const theme = this.isValidTheme(oldSettings.frameTheme)
            ? oldSettings.frameTheme
            : DEFAULT_SETTINGS.frameTheme;
        // 9.2 修复：逐字段回退源改为“已解析出的主题”的参数；只有自定义主题才回退到默认樱花木，
        // 避免勾选 frost-glass / black-gold 时被补成 mc-cherry 的边框、留白与配色。
        const preset = theme === 'custom'
            ? {
                borderWidth: DEFAULT_SETTINGS.frameBorderWidth,
                pixelUnit: DEFAULT_SETTINGS.framePixelUnit,
                margin: DEFAULT_SETTINGS.frameMargin,
                radius: DEFAULT_SETTINGS.frameRadius,
                mainColor: DEFAULT_SETTINGS.frameMainColor,
                backgroundColor: DEFAULT_SETTINGS.frameBackgroundColor,
                innerDarkColor: DEFAULT_SETTINGS.frameInnerDarkColor,
                lightColor: DEFAULT_SETTINGS.frameLightColor,
                outerColor: DEFAULT_SETTINGS.frameOuterColor,
                shadowColor: DEFAULT_SETTINGS.frameShadowColor,
                shadowOpacity: DEFAULT_SETTINGS.frameShadowOpacity
            }
            : FRAME_THEMES[theme];
        this.settings = {
            settingsVersion: CURRENT_SETTINGS_VERSION,
            modifier: this.isValidModifier(oldSettings.modifier) ? oldSettings.modifier : DEFAULT_SETTINGS.modifier,
            step: typeof oldSettings.step === 'number' ? oldSettings.step : DEFAULT_SETTINGS.step,
            minScale: typeof oldSettings.minScale === 'number' ? oldSettings.minScale : DEFAULT_SETTINGS.minScale,
            maxScale: typeof oldSettings.maxScale === 'number' ? oldSettings.maxScale : DEFAULT_SETTINGS.maxScale,
            showScaleBadge: typeof oldSettings.showScaleBadge === 'boolean' ? oldSettings.showScaleBadge : DEFAULT_SETTINGS.showScaleBadge,
            frameEnabled: typeof oldSettings.frameEnabled === 'boolean' ? oldSettings.frameEnabled : DEFAULT_SETTINGS.frameEnabled,
            frameTheme: theme,
            frameBorderWidth: typeof oldSettings.frameBorderWidth === 'number' ? oldSettings.frameBorderWidth : preset.borderWidth,
            framePixelUnit: typeof oldSettings.framePixelUnit === 'number' ? oldSettings.framePixelUnit : preset.pixelUnit,
            frameMargin: typeof oldSettings.frameMargin === 'number' ? oldSettings.frameMargin : preset.margin,
            frameRadius: typeof oldSettings.frameRadius === 'number' ? oldSettings.frameRadius : preset.radius,
            frameMainColor: this.validColor(oldSettings.frameMainColor, preset.mainColor),
            frameBackgroundColor: this.validColor(oldSettings.frameBackgroundColor, preset.backgroundColor),
            frameInnerDarkColor: this.validColor(oldSettings.frameInnerDarkColor, preset.innerDarkColor),
            frameLightColor: this.validColor(oldSettings.frameLightColor, preset.lightColor),
            frameOuterColor: this.validColor(oldSettings.frameOuterColor, preset.outerColor),
            frameShadowColor: this.validColor(oldSettings.frameShadowColor, preset.shadowColor),
            frameShadowOpacity: typeof oldSettings.frameShadowOpacity === 'number' ? oldSettings.frameShadowOpacity : preset.shadowOpacity
        };
        // 9.5 修复：settingsVersion 真正参与迁移——先读旧版本号，再逐级向上补齐字段，
        // 只有迁移确实发生时才写盘，避免每次启动都无条件重写 data.json。
        const loadedVersion = Number(oldSettings.settingsVersion) || 1;
        let migrated = false;
        if (loadedVersion < 3 && !this.isValidTheme(oldSettings.frameTheme)) {
            // v3：只有早期数据确实没有（或没有合法）主题标识时才回落到默认主题。
            // 这里必须判断原始值：否则任何缺 settingsVersion 但已选好主题的老配置会被改回樱花木并写盘。
            this.settings.frameTheme = DEFAULT_SETTINGS.frameTheme;
            migrated = true;
        }
        if (loadedVersion < 4) {
            // v4：补齐圆角、阴影色与阴影强度这三个后来新增的字段。
            if (typeof oldSettings.frameRadius !== 'number')
                this.settings.frameRadius = preset.radius;
            if (this.validColor(oldSettings.frameShadowColor, '') === '')
                this.settings.frameShadowColor = preset.shadowColor;
            if (typeof oldSettings.frameShadowOpacity !== 'number')
                this.settings.frameShadowOpacity = preset.shadowOpacity;
            migrated = true;
        }
        if (loadedVersion < CURRENT_SETTINGS_VERSION) {
            // v5：相框未配置的字段改为跟随主题预设（见上面的 preset 回退），迁移只需记录版本号。
            migrated = true;
        }
        if (migrated) {
            this.settings.settingsVersion = CURRENT_SETTINGS_VERSION;
            await this.saveSettings();
        }
    }
    validColor(value, fallback) {
        return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
    }
    isValidModifier(value) {
        return value === 'Alt' || value === 'Shift' || value === 'Ctrl' || value === 'Meta';
    }
    isValidTheme(value) {
        // 9.6 修复：不能用 in 判断，否则 constructor / toString 等原型链属性名也会通过校验。
        return value === 'custom' || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(FRAME_THEMES, value));
    }
    isModifierPressed(event) {
        switch (this.settings.modifier) {
            case 'Alt': return event.altKey;
            case 'Ctrl': return event.ctrlKey;
            case 'Meta': return event.metaKey;
            default: return event.shiftKey;
        }
    }
    /**
     * 用于缩放的“正文图片”筛选。
     * 这里仍允许标准 Markdown 图片和 Obsidian 的其他正文图片，但排除界面图标、弹窗等。
     */
    isZoomableMarkdownImage(img) {
        if (!img.closest('.markdown-preview-view, .markdown-source-view, .markdown-rendered, .cm-editor'))
            return false;
        if (img.closest('.mod-settings, .modal-container, .menu, .suggestion-container, .view-header, .workspace-tab-header'))
            return false;
        if (img.matches('.emoji, .icon, .view-header-icon img, .nav-file-icon img'))
            return false;
        return true;
    }
    /**
     * 相框严格只认标准 Markdown 图片语法 ![]()。
     *
     * v1.4.1 修复：不能再用 `.internal-embed / .image-embed` 判断 Wiki 图片，
     * 因为 Obsidian 1.12.x 的 Live Preview 对标准 Markdown 本地图片也可能使用
     * `.image-embed` 容器。这里改为以 metadataCache 记录的原始 Markdown 为准。
     *
     * 为了处理“同一个图片文件既被 ![]() 又被 ![[...]] 引用”的情况，
     * 还会按照同资源图片在当前渲染区域中的 DOM 顺序，与源码 embed 顺序一一对应。
     */
    isStandardMarkdownImage(img) {
        if (!this.isZoomableMarkdownImage(img))
            return false;
        // 排除 Callout / Admonition 等组件内部自带的图标图片。
        if (img.closest('.callout-icon, .admonition-icon, .callout-title'))
            return false;
        // 9.3 修复：一次遍历同时拿到文件与视图容器，不再各扫一遍 leaf 列表。
        const leafContext = this.getLeafContextForElement(img);
        const file = leafContext.file;
        if (!file)
            return false;
        const imgSrc = this.getImageSource(img);
        if (!imgSrc)
            return false;
        // 9.3 修复：源码 embed 的匹配与标准语法判定走缓存，避免每帧重复解析链接。
        const standardFlags = this.getStandardFlagsForImage(file, imgSrc);
        if (!standardFlags.length)
            return false;
        // 同一渲染区域中，找出所有指向相同资源的图片，按 DOM 顺序与源码顺序对应。
        // 这能避免同一张图片同时存在 ![]() 和 ![[...]] 时误判。
        const renderRoot = img.closest('.markdown-preview-view, .markdown-source-view, .markdown-rendered, .cm-editor') ||
            leafContext.containerEl;
        if (renderRoot) {
            const sameResourceImages = Array.from(renderRoot.querySelectorAll('img'))
                .filter((candidate) => this.isZoomableMarkdownImage(candidate))
                .filter((candidate) => this.urlsEquivalent(this.getImageSource(candidate), imgSrc));
            const index = sameResourceImages.indexOf(img);
            if (index >= 0 && index < standardFlags.length) {
                return standardFlags[index];
            }
        }
        // 无法建立顺序映射时：只有全部匹配项都是标准 Markdown 才放行，宁可不加也不误加。
        return standardFlags.every((isStandard) => isStandard);
    }
    /** 一次遍历 markdown leaf，同时返回元素所在视图的容器与文件。 */
    getLeafContextForElement(element) {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view === null || view === void 0 ? void 0 : view.containerEl) {
                if (view.containerEl.contains(element)) {
                    return { file: view.file !== null && view.file !== void 0 ? view.file : null, containerEl: view.containerEl };
                }
            }
        }
        return { file: this.app.workspace.getActiveFile(), containerEl: null };
    }
    /**
     * 返回该图片资源在源码中的每条 embed 是否为标准 ![]() 语法（已按源码位置排序），
     * 结果按 文件路径 + 资源地址 缓存，metadataCache 变化时整体失效。
     */
    getStandardFlagsForImage(file, imgSrc) {
        const key = `${file.path}\u0000${imgSrc}`;
        const cached = this.embedMatchCache.get(key);
        if (cached)
            return cached;
        const cache = this.app.metadataCache.getFileCache(file);
        const embeds = cache === null || cache === void 0 ? void 0 : cache.embeds;
        const flags = (embeds !== null && embeds !== void 0 ? embeds : [])
            .filter((embed) => this.embedMatchesImageSource(embed, imgSrc, file))
            .sort((a, b) => {
            var _a, _b, _c, _d;
            const ao = (_b = (_a = a === null || a === void 0 ? void 0 : a.position) === null || _a === void 0 ? void 0 : _a.start) === null || _b === void 0 ? void 0 : _b.offset;
            const bo = (_d = (_c = b === null || b === void 0 ? void 0 : b.position) === null || _c === void 0 ? void 0 : _c.start) === null || _d === void 0 ? void 0 : _d.offset;
            return (ao !== null && ao !== void 0 ? ao : 0) - (bo !== null && bo !== void 0 ? bo : 0);
        })
            .map((embed) => this.isStandardMarkdownEmbed(embed));
        this.embedMatchCache.set(key, flags);
        return flags;
    }
    /** 判断 metadataCache 中的一条 embed 是否来自标准 Markdown 图片语法。 */
    isStandardMarkdownEmbed(embed) {
        var _a;
        const original = String((_a = embed === null || embed === void 0 ? void 0 : embed.original) !== null && _a !== void 0 ? _a : '').trim();
        return /^!\[[\s\S]*?\]\s*\(/.test(original);
    }
    /** 获取图片当前渲染资源地址，并做统一规范化。 */
    getImageSource(img) {
        return this.normalizeUrl(img.currentSrc || img.src || img.getAttribute('src') || '');
    }
    /** 判断 metadataCache 的 embed 最终是否指向给定图片资源。 */
    embedMatchesImageSource(embed, imgSrc, file) {
        var _a;
        const link = String((_a = embed === null || embed === void 0 ? void 0 : embed.link) !== null && _a !== void 0 ? _a : '').trim();
        if (!link)
            return false;
        // 外部图片直接比较 URL。
        if (/^(https?:|data:|file:)/i.test(link)) {
            return this.urlsEquivalent(imgSrc, this.normalizeUrl(link));
        }
        // Vault 内图片用 Obsidian 解析后的资源 URL 比较。
        const destination = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
        if (!destination)
            return false;
        const resourceUrl = this.normalizeUrl(this.app.vault.getResourcePath(destination));
        return this.urlsEquivalent(imgSrc, resourceUrl);
    }
    /** 找到元素所在 Markdown 视图的根容器。 */
    getViewContainerForElement(element) {
        // 9.3：与 getFileForElement 共用同一次 leaf 遍历。
        return this.getLeafContextForElement(element).containerEl;
    }
    getFileForElement(element) {
        return this.getLeafContextForElement(element).file;
    }
    normalizeUrl(value) {
        if (!value)
            return '';
        try {
            return decodeURI(value).replace(/#.*$/, '');
        }
        catch (_a) {
            return value.replace(/#.*$/, '');
        }
    }
    urlsEquivalent(a, b) {
        if (!a || !b)
            return false;
        if (a === b)
            return true;
        // Electron/Obsidian 有时会给资源 URL 添加查询参数，这里忽略 query 再比较。
        const stripQuery = (value) => value.replace(/\?.*$/, '');
        return stripQuery(a) === stripQuery(b);
    }
    getZoomImage(target) {
        // 9.4：弹出窗口是独立 realm，instanceof Element / HTMLImageElement 会跨 realm 恒为 false，
        // 这里改用结构判断，否则弹窗里即使收到滚轮事件也永远命中不到图片。
        if (!target || typeof target.closest !== 'function')
            return null;
        const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
        const img = tagName === 'img' ? target : target.closest('img');
        if (!img)
            return null;
        return this.isZoomableMarkdownImage(img) ? img : null;
    }
    startFrameObserver() {
        var _a;
        (_a = this.frameObserver) === null || _a === void 0 ? void 0 : _a.disconnect();
        this.frameObserver = new MutationObserver((mutations) => {
            let foundImage = false;
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    // 9.4：跨 realm 不能用 instanceof，改为结构判断，弹窗里的新图片也能触发刷新。
                    if (!node || typeof node.querySelector !== 'function')
                        continue;
                    if (node.tagName === 'IMG' || node.querySelector('img')) {
                        foundImage = true;
                        break;
                    }
                }
                if (foundImage)
                    break;
            }
            if (foundImage)
                this.scheduleRefreshFrameClasses();
        });
        // 9.4：主窗口与每个弹出窗口的 body 都要观察，弹窗中新渲染的图片才会补上相框。
        for (const doc of this.getAllDocuments()) {
            if (doc.body)
                this.frameObserver.observe(doc.body, { childList: true, subtree: true });
        }
        this.register(() => { var _a; return (_a = this.frameObserver) === null || _a === void 0 ? void 0 : _a.disconnect(); });
    }
    scheduleRefreshFrameClasses() {
        if (this.refreshTimer !== null)
            window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refreshFrameClasses();
        }, 80);
    }
    updateFrameClass(img) {
        const shouldHaveFrame = this.settings.frameEnabled && this.isStandardMarkdownImage(img);
        img.classList.toggle('xyblue135-markdown-image-frame', shouldHaveFrame);
    }
    refreshFrameClasses() {
        // 9.3 修复：只扫描 Markdown 视图内的图片，不再对整个 document 做全量 img 重扫。
        // 9.4：主窗口与每个弹出窗口分别扫描，弹窗里的图片也能套上相框。
        for (const doc of this.getAllDocuments()) {
            doc.querySelectorAll('.markdown-preview-view img, .markdown-source-view img').forEach((img) => this.updateFrameClass(img));
        }
    }
    removeAllFrameClasses() {
        // 9.4：逐个窗口清理相框标记。
        for (const doc of this.getAllDocuments()) {
            doc.querySelectorAll('img.xyblue135-markdown-image-frame').forEach((img) => {
                img.classList.remove('xyblue135-markdown-image-frame');
            });
        }
    }
    applyTheme(themeId) {
        // 9.6 修复：同样用 hasOwnProperty 取主题，主题不存在时不要写 undefined 参数，
        // 退回自定义并保持现有外观。
        const theme = Object.prototype.hasOwnProperty.call(FRAME_THEMES, themeId) ? FRAME_THEMES[themeId] : null;
        if (!theme) {
            this.settings.frameTheme = 'custom';
            return;
        }
        this.settings.frameTheme = themeId;
        this.settings.frameBorderWidth = theme.borderWidth;
        this.settings.framePixelUnit = theme.pixelUnit;
        this.settings.frameMargin = theme.margin;
        this.settings.frameRadius = theme.radius;
        this.settings.frameMainColor = theme.mainColor;
        this.settings.frameBackgroundColor = theme.backgroundColor;
        this.settings.frameInnerDarkColor = theme.innerDarkColor;
        this.settings.frameLightColor = theme.lightColor;
        this.settings.frameOuterColor = theme.outerColor;
        this.settings.frameShadowColor = theme.shadowColor;
        this.settings.frameShadowOpacity = theme.shadowOpacity;
    }
    markThemeCustom() {
        this.settings.frameTheme = 'custom';
    }
    applyFrameCssVariables() {
        // 9.4 修复：CSS 变量写到每个窗口的 documentElement，弹出窗口里的相框才会生效。
        for (const doc of this.getAllDocuments()) {
            if (doc.documentElement)
                this.applyFrameCssVariablesTo(doc.documentElement);
        }
    }
    applyFrameCssVariablesTo(root) {
        const unit = Math.max(1, Math.round(this.settings.framePixelUnit));
        const shadow = this.hexToRgba(this.settings.frameShadowColor, this.settings.frameShadowOpacity);
        root.style.setProperty('--xyblue135-frame-border-width', `${this.settings.frameBorderWidth}px`);
        root.style.setProperty('--xyblue135-frame-margin', `${this.settings.frameMargin}px`);
        root.style.setProperty('--xyblue135-frame-radius', `${this.settings.frameRadius}px`);
        root.style.setProperty('--xyblue135-frame-main', this.settings.frameMainColor);
        root.style.setProperty('--xyblue135-frame-background', this.settings.frameBackgroundColor);
        root.style.setProperty('--xyblue135-frame-inner-dark', this.settings.frameInnerDarkColor);
        root.style.setProperty('--xyblue135-frame-light', this.settings.frameLightColor);
        root.style.setProperty('--xyblue135-frame-outer', this.settings.frameOuterColor);
        root.style.setProperty('--xyblue135-frame-layer-1', `${2 * unit}px`);
        root.style.setProperty('--xyblue135-frame-layer-2', `${5 * unit}px`);
        root.style.setProperty('--xyblue135-frame-layer-3', `${7 * unit}px`);
        root.style.setProperty('--xyblue135-frame-shadow-y', `${8 * unit}px`);
        root.style.setProperty('--xyblue135-frame-shadow-blur', `${16 * unit}px`);
        root.style.setProperty('--xyblue135-frame-shadow', shadow);
    }
    hexToRgba(hex, opacity) {
        const clean = hex.replace('#', '');
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        const a = Math.min(1, Math.max(0, opacity));
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    removeFrameCssVariables() {
        // 9.4 修复：逐个窗口清理相框 CSS 变量。
        for (const doc of this.getAllDocuments()) {
            const root = doc.documentElement;
            if (!root)
                continue;
            [
            '--xyblue135-frame-border-width',
            '--xyblue135-frame-margin',
            '--xyblue135-frame-radius',
            '--xyblue135-frame-main',
            '--xyblue135-frame-background',
            '--xyblue135-frame-inner-dark',
            '--xyblue135-frame-light',
            '--xyblue135-frame-outer',
            '--xyblue135-frame-layer-1',
            '--xyblue135-frame-layer-2',
            '--xyblue135-frame-layer-3',
            '--xyblue135-frame-shadow-y',
            '--xyblue135-frame-shadow-blur',
            '--xyblue135-frame-shadow'
            ].forEach((name) => root.style.removeProperty(name));
        }
    }
    onWheel(event) {
        if (!this.isModifierPressed(event))
            return;
        const img = this.getZoomImage(event.target);
        if (!img)
            return;
        const state = this.ensureState(img);
        // 9.1 修复：按住 Shift 时 Chromium/Electron 会把滚轮纵轴换算到 deltaX（此时 deltaY 为 0），
        // 两轴取符号并忽略 0，避免 deltaY 恒为 0 时方向被固定判为缩小。
        const rawDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        if (rawDelta === 0)
            return;
        // 沿用原语义：滚轮向上（负增量）放大，向下（正增量）缩小。
        const direction = -Math.sign(rawDelta);
        const nextScale = this.clamp(state.scale + direction * this.settings.step, this.settings.minScale, this.settings.maxScale);
        // 9.7 修复：到达上下限时不再吞掉事件，只给提示并 return，让页面可以继续滚动。
        if (nextScale === state.scale) {
            this.showScaleLimitBadge(event, state.scale, direction);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        state.scale = Number(nextScale.toFixed(3));
        // 修改真实 width / height，让图片参与浏览器布局重排，因此会影响旁边和下方文字。
        const nextWidth = Math.max(1, state.baseWidth * state.scale);
        const nextHeight = Math.max(1, state.baseHeight * state.scale);
        img.style.setProperty('width', `${nextWidth.toFixed(2)}px`, 'important');
        img.style.setProperty('height', `${nextHeight.toFixed(2)}px`, 'important');
        img.classList.add('hiz-layout-active');
        img.classList.toggle('hiz-zoomed-out', state.scale < 1);
        if (this.settings.showScaleBadge) {
            this.showBadge(event.clientX, event.clientY, state.scale, nextWidth, nextHeight, img.ownerDocument);
        }
    }
    onDoubleClick(event) {
        if (!this.isModifierPressed(event))
            return;
        const img = this.getZoomImage(event.target);
        if (!img)
            return;
        event.preventDefault();
        event.stopPropagation();
        this.resetImage(img);
    }
    ensureState(img) {
        const existing = this.imageStates.get(img);
        if (existing)
            return existing;
        const rect = img.getBoundingClientRect();
        const baseWidth = rect.width > 0 ? rect.width : (img.clientWidth || img.naturalWidth || 1);
        let baseHeight = rect.height > 0 ? rect.height : (img.clientHeight || img.naturalHeight || 0);
        if (baseHeight <= 0) {
            const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalHeight / img.naturalWidth : 1;
            baseHeight = baseWidth * ratio;
        }
        const state = {
            scale: 1,
            baseWidth,
            baseHeight,
            originalWidth: this.captureInlineStyle(img, 'width'),
            originalHeight: this.captureInlineStyle(img, 'height')
        };
        this.imageStates.set(img, state);
        return state;
    }
    captureInlineStyle(img, property) {
        return {
            value: img.style.getPropertyValue(property),
            priority: img.style.getPropertyPriority(property)
        };
    }
    restoreInlineStyle(img, property, snapshot) {
        if (snapshot.value)
            img.style.setProperty(property, snapshot.value, snapshot.priority);
        else
            img.style.removeProperty(property);
    }
    resetImage(img) {
        const state = this.imageStates.get(img);
        if (state) {
            this.restoreInlineStyle(img, 'width', state.originalWidth);
            this.restoreInlineStyle(img, 'height', state.originalHeight);
        }
        else {
            img.style.removeProperty('width');
            img.style.removeProperty('height');
        }
        img.classList.remove('hiz-layout-active', 'hiz-zoomed-out');
        this.imageStates.delete(img);
        this.removeBadge();
    }
    resetAllImages() {
        // 9.4：逐个窗口把所有被缩放过的图片恢复原状。
        for (const doc of this.getAllDocuments()) {
            doc.querySelectorAll('img.hiz-layout-active').forEach((img) => this.resetImage(img));
        }
    }
    showBadge(x, y, scale, width, height, doc) {
        this.showBadgeText(x, y, `${Math.round(scale * 100)}% · ${Math.round(width)}×${Math.round(height)} px`, doc);
    }
    /** 9.7：到达缩放上下限时给出提示，替代原先“事件被吞掉却没有任何反馈”。 */
    showScaleLimitBadge(event, scale, direction) {
        if (!this.settings.showScaleBadge)
            return;
        const target = event.target;
        // 9.4：同样不能用 instanceof Element（弹窗跨 realm），取 ownerDocument 作为提示层所在窗口。
        const doc = (target && target.ownerDocument) || document;
        const text = `${direction > 0 ? '已达最大倍率' : '已达最小倍率'} · ${Math.round(scale * 100)}%`;
        this.showBadgeText(event.clientX, event.clientY, text, doc);
    }
    showBadgeText(x, y, text, doc) {
        // 9.4：提示浮层建在事件所属窗口里，弹窗缩放时不会跑到主窗口。
        const targetDoc = doc || document;
        if (this.badgeEl && this.badgeEl.ownerDocument !== targetDoc)
            this.removeBadge();
        if (!this.badgeEl) {
            // 9.4：用原生 DOM 创建，避免依赖只在主窗口注入的 createDiv/setText 扩展。
            this.badgeEl = targetDoc.createElement('div');
            this.badgeEl.className = 'hiz-scale-badge';
            targetDoc.body.appendChild(this.badgeEl);
        }
        this.badgeEl.textContent = text;
        this.badgeEl.style.left = `${x + 14}px`;
        this.badgeEl.style.top = `${y + 14}px`;
        if (this.badgeTimer !== null)
            window.clearTimeout(this.badgeTimer);
        this.badgeTimer = window.setTimeout(() => this.removeBadge(), 850);
    }
    removeBadge() {
        var _a;
        if (this.badgeTimer !== null) {
            window.clearTimeout(this.badgeTimer);
            this.badgeTimer = null;
        }
        (_a = this.badgeEl) === null || _a === void 0 ? void 0 : _a.remove();
        this.badgeEl = null;
    }
    clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }
    async saveSettings() {
        // 9.8 修复：CSS 变量立即生效，写盘走串行队列（同时只有一个 saveData 在跑），
        // 失败时用 Notice 提示，避免未捕获的 promise rejection。
        this.applyFrameCssVariables();
        this.pendingSave = this.pendingSave
            .then(() => this.saveData(this.settings))
            .catch((error) => {
                new obsidian_1.Notice(`设置保存失败：${error && error.message ? error.message : error}`);
            });
        return this.pendingSave;
    }
    /** 9.8 修复：滑块、取色器这类连续调节只立即重算 CSS 变量，250ms 防抖后再写一次盘。 */
    scheduleSaveSettings() {
        this.applyFrameCssVariables();
        if (this.saveTimer !== null)
            window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            this.saveSettings();
        }, 250);
    }
}
exports.default = LocalImageHoverZoomPlugin;
class ImageHoverZoomSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '图片布局临时缩放' });
        containerEl.createEl('p', {
            text: '缩放只改变当前 Obsidian DOM，不修改 Markdown、图片附件、alt 或图片路径。'
        });
        new obsidian_1.Setting(containerEl)
            .setName('缩放组合键')
            .setDesc('鼠标放到正文图片上，按住该按键再滚动。默认 Shift。')
            .addDropdown((dropdown) => dropdown
            .addOption('Shift', 'Shift')
            .addOption('Alt', 'Alt')
            .addOption('Ctrl', 'Ctrl')
            .addOption('Meta', 'Meta / Command')
            .setValue(this.plugin.settings.modifier)
            .onChange(async (value) => {
            this.plugin.settings.modifier = value;
            await this.saveNow();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('每次缩放幅度')
            .setDesc('默认 0.15，即每格约 15%。')
            .addSlider((slider) => slider
            .setLimits(0.05, 0.5, 0.05)
            .setValue(this.plugin.settings.step)
            .setDynamicTooltip()
            .onChange(async (value) => {
            this.plugin.settings.step = value;
            this.saveLater();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('最大放大倍率')
            .setDesc('例如 4.0 表示最多放大到首次显示尺寸的 400%。')
            .addSlider((slider) => slider
            .setLimits(1.5, 8, 0.5)
            .setValue(this.plugin.settings.maxScale)
            .setDynamicTooltip()
            .onChange(async (value) => {
            this.plugin.settings.maxScale = value;
            this.saveLater();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('显示临时倍率提示')
            .setDesc('缩放时在鼠标附近短暂显示倍率和当前像素尺寸。')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.showScaleBadge)
            .onChange(async (value) => {
            this.plugin.settings.showScaleBadge = value;
            if (!value)
                this.plugin.removeBadge();
            await this.saveNow();
        }));
        containerEl.createEl('h2', { text: '图片相框主题' });
        containerEl.createEl('p', {
            text: '重要：相框只作用于标准 Markdown 图片语法 ![]()。不会给 # / ## 标题、![[图片]]、Callout 图标、Obsidian 界面图片或 HTML <img> 套边框。'
        });
        new obsidian_1.Setting(containerEl)
            .setName('启用图片相框')
            .setDesc('关闭后只保留图片缩放功能。')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.frameEnabled)
            .onChange(async (value) => {
            this.plugin.settings.frameEnabled = value;
            await this.saveNow();
            this.plugin.refreshFrameClasses();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('主题预设')
            .setDesc(this.getThemeDescription())
            .addDropdown((dropdown) => {
            for (const theme of Object.values(FRAME_THEMES)) {
                dropdown.addOption(theme.id, theme.name);
            }
            dropdown.addOption('custom', '自定义');
            dropdown.setValue(this.plugin.settings.frameTheme);
            dropdown.onChange(async (value) => {
                const themeId = value;
                if (themeId !== 'custom')
                    this.plugin.applyTheme(themeId);
                else
                    this.plugin.settings.frameTheme = 'custom';
                await this.saveNow();
                this.plugin.refreshFrameClasses();
                this.display();
            });
        });
        // 主题说明卡片，方便快速理解各预设的用途。
        const themeList = containerEl.createDiv({ cls: 'xyblue135-theme-list' });
        for (const theme of Object.values(FRAME_THEMES)) {
            const item = themeList.createDiv({ cls: 'xyblue135-theme-item' });
            item.createEl('strong', { text: theme.name });
            item.createSpan({ text: ` — ${theme.description}` });
        }
        containerEl.createEl('h3', { text: '高级自定义' });
        containerEl.createEl('p', {
            text: '下面任意参数一旦手动修改，主题会自动切换为“自定义”。你也可以随时重新选择某个预设恢复整套参数。'
        });
        this.addNumberSlider(containerEl, '主体边框厚度', '最靠近图片的边框厚度。', 'frameBorderWidth', 1, 10, 1);
        this.addNumberSlider(containerEl, '像素层级粗细', '控制外侧三层框的扩张步幅。MC 风格建议 1。', 'framePixelUnit', 1, 3, 1);
        this.addNumberSlider(containerEl, '相框外侧留白', '相框与旁边文字之间的距离。', 'frameMargin', 0, 28, 1);
        this.addNumberSlider(containerEl, '圆角', '0 为 MC 方块像素风；冰霜、赛博主题可使用更大圆角。', 'frameRadius', 0, 18, 1);
        this.addColorSetting(containerEl, '主体颜色', '最靠近图片的主体边框颜色。', 'frameMainColor');
        this.addColorSetting(containerEl, '底层颜色', '图片边缘底色。', 'frameBackgroundColor');
        this.addColorSetting(containerEl, '内层深色', '第一层深色纹理。', 'frameInnerDarkColor');
        this.addColorSetting(containerEl, '高亮颜色', '中间高亮层。', 'frameLightColor');
        this.addColorSetting(containerEl, '外层颜色', '最外层边框颜色。', 'frameOuterColor');
        this.addColorSetting(containerEl, '阴影颜色', '相框外侧投影颜色。', 'frameShadowColor');
        new obsidian_1.Setting(containerEl)
            .setName('阴影强度')
            .setDesc('0 表示关闭投影；只影响阴影，不影响多层边框。')
            .addSlider((slider) => slider
            .setLimits(0, 0.7, 0.02)
            .setValue(this.plugin.settings.frameShadowOpacity)
            .setDynamicTooltip()
            .onChange(async (value) => {
            this.plugin.markThemeCustom();
            this.plugin.settings.frameShadowOpacity = value;
            this.saveLater();
        }));
        new obsidian_1.Setting(containerEl)
            .setName('恢复当前预设')
            .setDesc('如果当前是自定义，则恢复默认 MC 樱花木；否则重新载入当前预设的完整参数。')
            .addButton((button) => button
            .setButtonText('恢复')
            .onClick(async () => {
            const current = this.plugin.settings.frameTheme;
            const target = current === 'custom' ? 'mc-cherry' : current;
            this.plugin.applyTheme(target);
            await this.saveNow();
            this.plugin.refreshFrameClasses();
            this.display();
        }));
    }
    getThemeDescription() {
        const id = this.plugin.settings.frameTheme;
        if (id === 'custom')
            return '当前使用自定义参数。';
        const theme = FRAME_THEMES[id];
        // 9.6 修复：主题名非法（例如原型链属性名）时给出安全文案，避免显示 “undefined：undefined”。
        if (!theme)
            return '当前使用自定义参数。';
        return `${theme.name}：${theme.description}`;
    }
    addNumberSlider(containerEl, name, desc, key, min, max, step) {
        new obsidian_1.Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addSlider((slider) => slider
            .setLimits(min, max, step)
            .setValue(this.plugin.settings[key])
            .setDynamicTooltip()
            .onChange(async (value) => {
            this.plugin.markThemeCustom();
            this.plugin.settings[key] = value;
            this.saveLater();
        }));
    }
    addColorSetting(containerEl, name, desc, key) {
        new obsidian_1.Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addColorPicker((picker) => picker
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
            this.plugin.markThemeCustom();
            this.plugin.settings[key] = value;
            this.saveLater();
        }))
            .addText((text) => text
            .setPlaceholder('#d88f9f')
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
            if (!/^#[0-9a-fA-F]{6}$/.test(value))
                return;
            this.plugin.markThemeCustom();
            this.plugin.settings[key] = value;
            this.saveLater();
        }));
    }
    /** 9.8 修复：设置页统一写入入口，保存失败时给出界面提示而不是静默 rejection。 */
    async saveNow() {
        try {
            await this.plugin.saveSettings();
        }
        catch (error) {
            new obsidian_1.Notice(`设置保存失败：${error && error.message ? error.message : error}`);
        }
    }
    /** 9.8 修复：连续调节走防抖保存，避免拖动滑块时每个 tick 都整份写盘。 */
    saveLater() {
        try {
            this.plugin.scheduleSaveSettings();
        }
        catch (error) {
            new obsidian_1.Notice(`设置保存失败：${error && error.message ? error.message : error}`);
        }
    }
}
