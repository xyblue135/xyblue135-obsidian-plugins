import { Menu, Notice, Plugin, TAbstractFile, TFolder } from "obsidian";

interface FolderHiderData {
  hiddenFolders: string[];
}

type RevealTarget = {
  revealInFolder?: (item: TAbstractFile, ...args: unknown[]) => unknown;
};

type PatchedReveal = ((item: TAbstractFile, ...args: unknown[]) => unknown) & {
  __xyblue135FolderHiderPatched?: boolean;
};

const HIDDEN_CLASS = "xyblue135-folder-hider-hidden";

/** 规范化 Vault 相对路径：统一分隔符、去掉首尾与重复斜杠；根目录/空值/非字符串返回 null。 */
function normalizeHiddenPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const unified = path.replace(/\\/g, "/").trim();
  const trimmed = unified.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return trimmed.length > 0 ? trimmed : null;
}

/** child 是否等于 parent 或位于 parent 之下。 */
function isPathInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

export default class FolderHiderPlugin extends Plugin {
  private hiddenFolders = new Set<string>();
  private observer: MutationObserver | null = null;
  private refreshQueued = false;
  private refreshFrame: number | null = null;
  private unloaded = false;
  private patchedTargets = new Map<RevealTarget, () => void>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveQueued = false;

  async onload(): Promise<void> {
    this.unloaded = false;
    // 10.1 兼容手写/损坏的 data.json：过滤非字符串、拆字符、null 等非法项，规范化后回写迁移。
    const rawData = (await this.loadData()) as { hiddenFolders?: unknown } | null;
    const rawList: unknown = rawData && typeof rawData === "object" ? rawData.hiddenFolders : undefined;
    let needsMigration = rawData !== null && rawData !== undefined && !Array.isArray(rawList);
    for (const entry of Array.isArray(rawList) ? rawList : []) {
      const normalized = normalizeHiddenPath(entry);
      if (normalized === null) {
        needsMigration = true;
        continue;
      }
      if (normalized !== entry) needsMigration = true;
      this.hiddenFolders.add(normalized);
    }
    if (needsMigration) await this.saveHiddenFolders();

    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
      if (!(file instanceof TFolder)) return;
      const folderPath = normalizeHiddenPath(file.path);
      // 根目录不可隐藏：藏起来会让整棵文件树消失且无法再右键恢复。
      if (!folderPath || file === this.app.vault.getRoot?.()) return;

      if (this.hiddenFolders.has(folderPath)) {
        menu.addItem((item) => item.setTitle("取消隐藏此文件夹").setIcon("eye").onClick(async () => {
          await this.unhidePath(folderPath);
        }));
        return;
      }

      menu.addItem((item) => item.setTitle("隐藏此文件夹").setIcon("eye-off").onClick(async () => {
        this.hiddenFolders.add(folderPath);
        await this.saveHiddenFolders();
        this.applyHiddenFolders();
      }));
    }));

    this.addCommand({
      id: "unhide-all-folders",
      name: "取消隐藏全部文件夹",
      callback: () => {
        void this.unhideAllFolders();
      },
    });

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file.path)));

    this.app.workspace.onLayoutReady(() => {
      // 布局就绪前插件可能已被禁用/重载，此时不得再创建 observer 或标记 DOM。
      if (this.unloaded) return;
      this.patchRevealInFolder();
      this.startObserver();
      this.applyHiddenFolders();
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.patchRevealInFolder();
      this.startObserver();
      this.queueRefresh();
    }));

    this.register(() => this.observer?.disconnect());
  }

  onunload(): void {
    this.unloaded = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.refreshFrame !== null) {
      cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }
    this.refreshQueued = false;
    for (const unpatch of [...this.patchedTargets.values()]) unpatch();
    this.patchedTargets.clear();
    document.querySelectorAll(`.nav-folder.${HIDDEN_CLASS}`).forEach((el) => el.classList.remove(HIDDEN_CLASS));
  }

  private saveHiddenFolders(): Promise<void> {
    // 10.5 串行化写盘：并发 saveData 会互相覆盖；rejection 必须捕获，否则隐藏状态静默丢失。
    // 已排队但尚未执行的多次修改只保留一次写入，且写入时取内存中的最新快照。
    if (this.saveQueued) return this.saveChain;
    this.saveQueued = true;
    const write = (): Promise<void> => {
      this.saveQueued = false;
      return this.saveData({ hiddenFolders: [...this.hiddenFolders].sort() } satisfies FolderHiderData).catch((error: unknown) => {
        console.error("[xyblue135-files-hider] 保存隐藏列表失败", error);
        new Notice("文件夹隐藏列表保存失败，请检查 data.json 是否可写");
      });
    };
    this.saveChain = this.saveChain.then(write, write);
    return this.saveChain;
  }

  private applyHiddenFolders(): void {
    // 10.4 一次查询 + 跳过已标记节点，避免每次刷新都重新增删 class 触发样式重算。
    const hideTargets = new Set<Element>();
    if (this.hiddenFolders.size > 0) {
      document.querySelectorAll<HTMLElement>(".nav-folder-title[data-path]").forEach((title) => {
        const path = normalizeHiddenPath(title.dataset?.path);
        if (!path || !this.hiddenFolders.has(path)) return;
        const folder = title.closest(".nav-folder");
        if (!folder) return;
        hideTargets.add(folder);
        if (!folder.classList.contains(HIDDEN_CLASS)) folder.classList.add(HIDDEN_CLASS);
      });
    }

    document.querySelectorAll(`.nav-folder.${HIDDEN_CLASS}`).forEach((folder) => {
      if (!hideTargets.has(folder)) folder.classList.remove(HIDDEN_CLASS);
    });
  }

  /** 文件浏览器根容器；取不到时退回 body（回调内会做轻量过滤）。 */
  private getObserverRoot(): Element {
    return document.querySelector('.workspace-leaf-content[data-type="file-explorer"] .nav-files-container')
      ?? document.querySelector(".nav-files-container")
      ?? document.body;
  }

  private startObserver(): void {
    if (this.unloaded) return;
    this.observer?.disconnect();
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
    this.observer.observe(this.getObserverRoot(), { childList: true, subtree: true });
  }

  /** 只有真正新增/移除了文件树节点时才排队刷新，忽略应用内其他 DOM 变动。 */
  private handleMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        const el = node as Element;
        if (typeof el.matches !== "function") continue;
        if (el.matches(".nav-folder, .nav-folder-title") || el.querySelector(".nav-folder, .nav-folder-title")) {
          this.queueRefresh();
          return;
        }
      }
      if (this.hiddenFolders.size === 0) continue;
      for (const node of Array.from(mutation.removedNodes)) {
        const el = node as Element;
        if (typeof el.matches !== "function") continue;
        if (el.matches(".nav-folder") || el.querySelector(".nav-folder")) {
          this.queueRefresh();
          return;
        }
      }
    }
  }

  private queueRefresh(): void {
    if (this.unloaded || this.refreshQueued) return;
    this.refreshQueued = true;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refreshQueued = false;
      if (this.unloaded) return;
      this.applyHiddenFolders();
    });
  }

  /** 取消隐藏单个文件夹（原样路径，仅匹配精确项）。 */
  private async unhidePath(path: string): Promise<void> {
    const target = normalizeHiddenPath(path);
    if (!target) return;
    if (!this.hiddenFolders.delete(target)) return;
    this.applyHiddenFolders();
    await this.saveHiddenFolders();
  }

  /** 兜底出口：清空隐藏列表，用于空文件夹等无法右键恢复的场景。 */
  private async unhideAllFolders(): Promise<void> {
    const count = this.hiddenFolders.size;
    if (count === 0) return;
    this.hiddenFolders.clear();
    this.applyHiddenFolders();
    await this.saveHiddenFolders();
    new Notice(`已取消隐藏 ${count} 个文件夹`);
  }

  private revealPath(path: string | undefined): void {
    const target = normalizeHiddenPath(path);
    if (!target) return;
    const matched = [...this.hiddenFolders].filter((hidden) => isPathInside(target, hidden));
    if (matched.length === 0) return;

    for (const hidden of matched) this.hiddenFolders.delete(hidden);
    this.applyHiddenFolders();
    void this.saveHiddenFolders();
  }

  private patchRevealTarget(target: RevealTarget | null | undefined): void {
    if (this.unloaded || !target) return;
    if (this.patchedTargets.has(target)) return;
    if (typeof target.revealInFolder !== "function") return;

    const original = target.revealInFolder as PatchedReveal;
    if (original.__xyblue135FolderHiderPatched) return;

    const plugin = this;
    const patched: PatchedReveal = function (this: RevealTarget, item: TAbstractFile, ...args: unknown[]) {
      plugin.revealPath(item?.path);
      return original.call(this, item, ...args);
    };
    patched.__xyblue135FolderHiderPatched = true;
    target.revealInFolder = patched;

    // 10.7 每个目标只登记一次；已销毁视图的补丁在 patchRevealInFolder 中回收，闭包不会无界增长。
    this.patchedTargets.set(target, () => {
      if (target.revealInFolder === patched) target.revealInFolder = original;
    });
  }

  /** 当前仍存活的补丁候选（内部插件实例 + 现存 file-explorer 视图）。 */
  private collectRevealTargets(): RevealTarget[] {
    const targets: RevealTarget[] = [];
    const push = (target: RevealTarget | null | undefined): void => {
      if (target && typeof target === "object" && !targets.includes(target)) targets.push(target);
    };

    const appAny = this.app as unknown as {
      internalPlugins?: {
        getEnabledPluginById?: (id: string) => RevealTarget | undefined;
        getPluginById?: (id: string) => { instance?: RevealTarget; plugin?: RevealTarget } | undefined;
      };
    };

    const internal = appAny.internalPlugins;
    push(internal?.getEnabledPluginById?.("file-explorer"));
    const wrapper = internal?.getPluginById?.("file-explorer");
    push(wrapper?.instance);
    push(wrapper?.plugin);
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      push(leaf.view as unknown as RevealTarget);
    }
    return targets;
  }

  private patchRevealInFolder(): void {
    if (this.unloaded) return;
    const targets = this.collectRevealTargets();
    const live = new Set<RevealTarget>(targets);

    for (const [target, unpatch] of [...this.patchedTargets]) {
      if (live.has(target)) continue;
      unpatch();
      this.patchedTargets.delete(target);
    }

    for (const target of targets) this.patchRevealTarget(target);
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    const oldKey = normalizeHiddenPath(oldPath);
    const newKey = normalizeHiddenPath(file?.path);
    if (!oldKey || !newKey) return;
    const replacements: Array<[string, string]> = [];
    for (const hidden of this.hiddenFolders) {
      if (hidden === oldKey) replacements.push([hidden, newKey]);
      else if (hidden.startsWith(oldKey + "/")) replacements.push([hidden, newKey + hidden.slice(oldKey.length)]);
    }
    if (replacements.length === 0) return;

    for (const [oldHidden, newHidden] of replacements) {
      this.hiddenFolders.delete(oldHidden);
      this.hiddenFolders.add(newHidden);
    }
    void this.saveHiddenFolders();
    this.queueRefresh();
  }

  private handleDelete(path: string): void {
    const key = normalizeHiddenPath(path);
    if (!key) return;
    let changed = false;
    for (const hidden of [...this.hiddenFolders]) {
      if (isPathInside(hidden, key)) {
        this.hiddenFolders.delete(hidden);
        changed = true;
      }
    }
    if (changed) void this.saveHiddenFolders();
  }
}
