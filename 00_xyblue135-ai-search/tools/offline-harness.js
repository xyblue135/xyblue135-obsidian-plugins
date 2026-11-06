/* 离线跑插件的 harness：喂一个假 obsidian 模块，在 Node 里真实执行 onload。
 *
 * 用途：给 tools/rebuild-index.js 之类的一次性维护脚本提供「不启动 Obsidian 也能跑插件代码」的能力。
 * 不参与插件运行，Obsidian 不会加载本目录。
 *
 * 关键约束：
 * - PLUGIN_ROOT / VAULT 全部按本文件位置推导，不写死绝对路径（换机 / 改 vault 名都能用）。
 * - document / window / navigator 必须在 require main.js 之前挂到 global，否则插件顶层就崩。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const PLUGIN_DIR = path.resolve(__dirname, '..');                          // …/plugins/00_xyblue135-ai-search
const PLUGIN_ROOT = path.dirname(PLUGIN_DIR);                              // …/plugins
const VAULT = path.resolve(PLUGIN_ROOT, '../..');                           // vault 根
const PLUGIN_ID = path.basename(PLUGIN_DIR);

/* ---------- 最小 DOM 替身 ---------- */
const el = () => {
  const node = {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { node.children.push(c); return c; },
    prepend(c) { node.children.unshift(c); return c; },
    insertBefore(c) { return c; }, insertAfter(c) { return c; },
    removeChild() {}, remove() {}, empty() {}, detach() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    createDiv: () => el(), createEl: () => el(), createSpan: () => el(),
    setText() {}, setAttr() {}, addClass() { return node; },
    addClasses() { return node; }, removeClass() { return node; }, toggleClass() { return node; },
    hasClass: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, click() {}, scrollIntoView() {},
  };
  return node;
};
global.document = {
  createElement: el, createTextNode: () => el(), createDocumentFragment: el,
  body: el(), head: el(),
  querySelector: () => null, querySelectorAll: () => [],
  getElementById: () => null, getElementsByClassName: () => [],
  addEventListener() {}, removeEventListener() {},
};
global.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: () => {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
try { Object.defineProperty(global, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch (e) { /* 已有只读 navigator */ }

/* 万能链式控件替身：所有 setXxx / addXxx 都返回自身，避免 mock 追着真实调用一路补 */
const ctl = (inputEl) => {
  const o = {
    inputEl: inputEl || el(),
    setValue() { return o; }, setPlaceholder() { return o; }, setTooltip() { return o; },
    setDynamicTooltip() { return o; }, setDesc() { return o; }, setDisabled() { return o; },
    setClass() { return o; }, setCta() { return o; }, setWarning() { return o; },
    setButtonText() { return o; }, setIcon() { return o; }, setLimits() { return o; },
    addOption() { return o; }, addOptions() { return o; },
    onClick() { return o; }, onChange() { return o; },
  };
  return o;
};

/* ---------- 假 obsidian ---------- */
const eventRef = { on: () => eventRef, off: () => eventRef };

class FakeItemView {
  constructor(leaf) { this.leaf = leaf; this.contentEl = el(); this.app = fakeApp; }
  getViewType() { return 'x'; } getDisplayText() { return 'x'; } getIcon() { return 'x'; }
  async onOpen() {} async onClose() {} addAction() { return el(); }
}

const fakeApp = {
  vault: {
    on: () => eventRef, off: () => eventRef,
    getMarkdownFiles: () => [], getFiles: () => [], getAbstractFileByPath: () => null,
    read: async () => '', cachedRead: async () => '', create: async () => ({}), modify: async () => {},
    adapter: {
      // 相对 vault 根的路径（'my_blog/a.md'、'.obsidian/plugins/x/index.json'）
      read: async (p) => fs.readFileSync(path.join(VAULT, p), 'utf8'),
      write: async () => {}, exists: async () => false, mkdir: async () => {},
      list: async () => ({ files: [], folders: [] }), stat: async () => ({}),
    },
  },
  workspace: {
    on: () => eventRef, off: () => eventRef,
    onLayoutReady: (cb) => { try { cb(); } catch (e) { /* onLayoutReady 里的异常不影响主流程 */ } },
    getLeavesOfType: () => [], getLeaf: () => ({ setViewState: async () => {}, openFile: async () => {} }),
    getActiveFile: () => null, revealLeaf: () => {}, iterateAllLeaves: () => {}, detachLeavesOfType: () => {},
  },
  metadataCache: { on: () => eventRef, getFileCache: () => null, getFirstLinkpathDest: () => null },
  fileManager: { renameFile: async () => {}, processFrontMatter: async () => {} },
  plugins: { plugins: {} },
  commands: { executeCommandById: () => {} },
};

const fakeObsidian = {
  Plugin: class {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest || { dir: '.obsidian/plugins/' + PLUGIN_ID, id: PLUGIN_ID, version: '0.0.0' };
      this._cmd = []; this._views = []; this._tabs = []; this._ribbons = [];
    }
    async loadData() {
      try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data.json'), 'utf8')); } catch (e) { return {}; }
    }
    async saveData() {}
    addCommand(c) { this._cmd.push(c); return c; }
    addRibbonIcon() { const e = el(); this._ribbons.push(e); return e; }
    addSettingTab(t) { this._tabs.push(t); }
    registerView(type, maker) { this._views.push({ type, maker }); }
    registerEvent() {} registerInterval() {} registerDomEvent() {} registerMarkdownCodeBlockProcessor() {}
    registerObsidianProtocolHandler() {} registerEditorExtension() {}
    register(fn) { this._disposers = this._disposers || []; this._disposers.push(fn); return fn; }
    addStatusBarItem() { return el(); }
  },
  Modal: class { constructor(app) { this.app = app; this.contentEl = el(); this.titleEl = el(); } open() {} close() {} onOpen() {} onClose() {} },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = el(); this.contentEl = this.containerEl; } },
  ItemView: FakeItemView,
  Setting: class {
    constructor() { this.settingEl = el(); }
    setName() { return this; } setDesc() { return this; } setHeading() { return this; }
    setClass() { return this; } setDisabled() { return this; } setTooltip() { return this; }
    addText(cb) { cb(ctl()); return this; }
    addTextArea(cb) { cb(ctl()); return this; }
    addToggle(cb) { cb(ctl()); return this; }
    addDropdown(cb) { cb(ctl()); return this; }
    addSlider(cb) { cb(ctl()); return this; }
    addButton(cb) { cb(ctl()); return this; }
    addExtraButton(cb) { cb(ctl()); return this; }
    addMomentFormat(cb) { cb(ctl()); return this; }
    addSearch(cb) { cb(ctl()); return this; }
    addColorPicker(cb) { cb(ctl()); return this; }
    then(resolve) { return Promise.resolve(this).then(resolve); }
  },
  Notice: class { constructor(msg) { this.msg = msg; } },
  TFile: class { constructor(p) { this.path = p; this.extension = 'md'; this.basename = p; } },
  TFolder: class { constructor(p) { this.path = p; } },
  MarkdownRenderer: { render: async () => {}, renderMarkdown: async () => {} },
  normalizePath: (p) => String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
  setIcon: () => {},
  requestUrl: async () => ({ status: 200, json: {}, text: '' }),
  parseYaml: () => ({}), stringifyYaml: () => '',
  Component: class { load() {} unload() {} addChild(c) { return c; } },
  MarkdownView: class {},
  Menu: class { addItem(cb) { cb({ setTitle() { return this; }, setIcon() { return this; }, onClick() { return this; } }); return this; } },
  debounce: (fn) => fn, moment: () => ({ format: () => '' }),
  Platform: { isDesktop: true, isMobile: false },
};
fakeObsidian.FuzzySuggestModal = class extends fakeObsidian.Modal { constructor(app) { super(app); } };
fakeObsidian.SuggestModal = class extends fakeObsidian.Modal { constructor(app) { super(app); } };

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'obsidian') return fakeObsidian;
  return origLoad.apply(this, arguments);
};

/** 构造插件并执行 onload()。返回实例；调用方负责 process.exit。 */
async function loadPlugin() {
  const P = require(path.join(PLUGIN_DIR, 'main.js'));
  const plugin = new P(fakeApp, {
    dir: '.obsidian/plugins/' + PLUGIN_ID, id: PLUGIN_ID, version: '0.0.0',
  });
  await plugin.onload();
  return plugin;
}

module.exports = { loadPlugin, fakeApp, VAULT, PLUGIN_DIR, PLUGIN_ID };
