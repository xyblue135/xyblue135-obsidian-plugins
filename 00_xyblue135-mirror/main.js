/*
 * xyblue135 私人 · 附件镜像
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  TFile,
  TFolder,
  normalizePath,
  ButtonComponent
} = require("obsidian");

const DEFAULT_SETTINGS = {
  notesRoot: "00_docs",
  attachmentsRoot: "00_assets",
  structureMode: "note",
  fileNameMode: "smart",
  handlePaste: true,
  handleDrop: true,
  syncOnNoteRename: true,
  deleteAttachmentsWithNote: true,
  // v2.1：删除 Markdown 时弹出“删除附件 / 删除文档”勾选确认对话框（默认全部勾选）。
  deleteDialogEnabled: true,
  // 修复 8.12：旧插件垃圾桶只迁移一次，避免每次启动都执行并清空恢复记录。
  trashMigrationDone: false,
  // v2.1：启动时是否给「所有」笔记预建空附件目录。
  // 默认关闭——空目录在真实库里会堆到几十上百个，附件目录改为首次粘贴时按需创建。
  createFoldersForAllNotes: false,
  recycleHistory: []
};

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"
]);

// Obsidian 中适合直接嵌入正文预览的附件。
// 图片和 PDF 使用 ![]()；压缩包、Office 等普通附件使用 []()。
const EMBED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf"]);

// v2.1：删除勾选确认对话框。
// 两个复选框「删除附件」「删除文档」默认全部勾选；点取消则什么都不删除。
class MirrorDeleteDialog extends Modal {
  constructor(app, plugin, file, folderInfo) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.folderInfo = folderInfo;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mirror-attachments-delete-modal");

    contentEl.createEl("h3", { text: "删除文件" });

    const infoEl = contentEl.createDiv({
      cls: "mirror-attachments-delete-info"
    });
    infoEl.createEl("div", {
      cls: "mirror-attachments-delete-path",
      text: this.file.path
    });

    if (this.folderInfo) {
      const attLine = infoEl.createDiv({
        cls: "mirror-attachments-delete-attachment"
      });
      attLine.createSpan({ text: "附件目录：" });
      attLine.createEl("code", { text: this.folderInfo.path });
      attLine.createSpan({
        text: `（${this.folderInfo.fileCount} 个文件）`
      });
      if (this.folderInfo.sharedNotes > 0) {
        infoEl.createDiv({
          cls: "mirror-attachments-delete-warning",
          text: `⚠ 仍有 ${this.folderInfo.sharedNotes} 篇同名笔记共享此附件目录，勾选“删除附件”会影响它们。`
        });
      }
    } else {
      infoEl.createDiv({
        cls: "mirror-attachments-delete-none",
        text: "未找到对应的附件镜像目录，本次只能删除文档。"
      });
    }

    const optionsEl = contentEl.createDiv({
      cls: "mirror-attachments-delete-options"
    });

    let attachmentCheckbox = null;
    // 修复 8.3：① 关闭“删除文章时同步回收附件”后不再提供附件删除选项；
    // ② 共享目录（仍有同名笔记）默认/强制不删附件，与自动路径的引用计数一致。
    const attachmentsEnabled = this.plugin.settings.deleteAttachmentsWithNote !== false;
    if (this.folderInfo && !attachmentsEnabled) {
      infoEl.createDiv({
        cls: "mirror-attachments-delete-none",
        text: "设置中已关闭“删除文章时同步回收附件”，本次只删除文档。"
      });
    } else if (this.folderInfo && this.folderInfo.sharedNotes > 0) {
      infoEl.createDiv({
        cls: "mirror-attachments-delete-none",
        text: "该附件目录仍被同名笔记共享，本次只删除文档，附件会保留。"
      });
    } else if (this.folderInfo) {
      new Setting(optionsEl)
        .setName("删除附件")
        .setDesc("将该笔记对应的附件镜像目录移入系统回收站")
        .addToggle((checkbox) => {
          attachmentCheckbox = checkbox;
          checkbox.setValue(true);
        });
    }

    let documentCheckbox = null;
    new Setting(optionsEl)
      .setName("删除文档")
      .setDesc("删除这篇 Markdown 笔记本身（移入系统回收站）")
      .addToggle((checkbox) => {
        documentCheckbox = checkbox;
        checkbox.setValue(true);
      });

    // v2.1.1：按钮放到模态框底部按钮区，避免被内容区域裁剪/压住。
    // 修复：Modal 没有 addButton 方法（旧写法抛 TypeError，导致按钮不出现、无法确认删除）。
    const buttonContainer = contentEl.createDiv({
      cls: "modal-button-container"
    });

    new ButtonComponent(buttonContainer)
      .setButtonText("取消")
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText("确认删除")
      .setWarning()
      .onClick(async () => {
        const deleteAttachments = attachmentCheckbox
          ? attachmentCheckbox.getValue()
          : false;
        const deleteDocument = documentCheckbox
          ? documentCheckbox.getValue()
          : false;
        this.close();
        await this.plugin.executeManualDelete(this.file, {
          deleteAttachments,
          deleteDocument
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// v2.1：同名笔记共享附件目录的“归属查看”对话框。
// 共享本身是设计如此（目录键 = 文件名），但一旦同组里真放了附件，
// 光看目录里的时间戳文件名无法判断它属于哪一篇，所以这里按正文引用反查归属。
class MirrorDuplicateDialog extends Modal {
  constructor(app, plugin, report) {
    super(app);
    this.plugin = plugin;
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mirror-attachments-duplicate-modal");

    contentEl.createEl("h3", { text: "同名笔记与附件归属" });

    if (!this.report.length) {
      contentEl.createEl("div", {
        cls: "mirror-attachments-audit-summary is-ok",
        text: "没有发现同名 Markdown。"
      });
      const bar = contentEl.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(bar)
        .setButtonText("关闭")
        .onClick(() => this.close());
      return;
    }

    contentEl.createEl("p", {
      text: `共 ${this.report.length} 组同名笔记。附件目录按文件名共享，同组笔记指向同一批附件；下面按“正文是否引用该附件”反查每张图的归属。`
    });

    for (const group of this.report) {
      const box = contentEl.createDiv({
        cls: "mirror-attachments-audit-group is-conflict"
      });

      box.createEl("div", {
        cls: "mirror-attachments-audit-group-title",
        text:
          `${group.basename} · ${group.count} 篇 · 共享 ${group.folderPath}` +
          `（${group.fileCount} 个附件）` +
          (group.caseConflict
            ? "（含仅大小写不同的文件名，Windows 上共用同一目录）"
            : "")
      });

      const list = box.createEl("ul");
      for (const path of group.notePaths) list.createEl("li", { text: path });

      if (!group.folderExists) {
        box.createEl("div", {
          cls: "mirror-attachments-audit-summary is-warning",
          text: "附件目录尚不存在，暂无需处理。"
        });
      } else if (!group.fileCount) {
        box.createEl("div", {
          cls: "mirror-attachments-audit-summary is-ok",
          text: "该目录是空的，暂无附件归属问题。"
        });
      } else {
        box.createEl("div", {
          text:
            `归属统计：独占 ${group.exclusiveOwner} 个、被多篇共同引用 ${group.sharedFiles} 个、` +
            `无人引用 ${group.orphanFiles} 个。`
        });
        for (const owner of group.ownership) {
          if (!owner.notes.length) continue;
          box.createEl("div", {
            text: `· ${owner.name} ← ${owner.notes.length} 篇：${owner.notes.join(" , ")}`
          });
        }
        if (group.sharedFiles > 0 || group.orphanFiles > 0) {
          box.createEl("div", {
            cls: "mirror-attachments-delete-warning",
            text:
              "⚠ 存在多篇共用或无人引用的附件。需要分家时，先把同组笔记改成不同文件名，" +
              "再手动把附件移进各自的新目录（插件不会自动拆分，避免误搬）。"
          });
        }
      }

      const actions = box.createDiv({ cls: "modal-button-container" });
      new ButtonComponent(actions)
        .setButtonText("打开附件目录")
        .onClick(async () => {
          const note = this.app.vault.getAbstractFileByPath(group.notePaths[0]);
          if (note instanceof TFile) await this.plugin.revealAttachmentFolder(note);
        });
    }

    const bar = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(bar)
      .setButtonText("关闭")
      .onClick(() => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

module.exports = class MirrorAttachmentsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.migrateLegacyFlatAttachmentRootIfNeeded();
    await this.migratePluginTrashToSystemTrash();
    this.addSettingTab(new MirrorAttachmentsSettingTab(this.app, this));
    this.addRibbonIcon("images", "附件镜像 · 设置", () => { this.app.setting.open(); this.app.setting.openTabById("00_xyblue135-mirror"); }).addClass("xyblue135-ribbon xyblue135-tool");

    // v2.1：同名笔记默认静默共享附件目录，事后很难发现；
    // 这里给一个随时可查的入口（设置页“重复文件名”面板里也有同款按钮）。
    this.addCommand({
      id: "check-duplicate-notes",
      name: "检查同名笔记（附件归属）",
      callback: () => {
        void this.showDuplicateReport();
      }
    });

    // v2.1：手动勾选删除流程进行中时，跳过 delete 事件的自动回收。
    // 用 Set 记录“本次手动删除的文档路径”，delete 事件（可能异步触发）
    // 命中后消费一次即跳过，避免“只勾选删除文档”时附件又被自动回收。
    this.manualDeleteGuard = new Set();

    // 修复 8.20：附件“取名 + 落盘”走串行队列。
    // 并发粘贴同名附件时，避免两次 importFiles 都判定同一个名字可用，
    // 后一个 createBinary 因文件已存在而失败（用户看到“保存失败”）。
    this.importQueue = Promise.resolve();

    // v2.1：不再默认「给每篇笔记预建空附件目录」。
    // 旧行为在 762 篇笔记的库上造出 340 个空目录（占 45%），既没有附件也没有用处；
    // 附件目录改为首次粘贴时按需创建（importFiles 内已有 ensureFolder）。
    // 确实需要全量补建时：设置页「结构校验 → 补建缺失目录」，或把开关打开。
    if (this.settings.createFoldersForAllNotes) {
      this.app.workspace.onLayoutReady(() => {
        void this.ensureAllNoteFolders().catch((err) => {
          console.error("[xyblue135 私人·附件镜像] initial folder sync failed:", err);
          new Notice("xyblue135 私人·附件镜像：初始化共享附件目录失败，请查看控制台。");
        });
      });
    }

    // 新建 Markdown 时只做「同名检查」，不再顺手建一个空目录。
    // 目录改由首次粘贴附件时按需创建（importFiles → ensureFolder），避免空目录堆积。
    // 如果别的目录已经存在同名 Markdown，则明确提示“共享”，而不是创建第二份附件目录。
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.isManagedNotePath(file.path)) return;

        void this.ensureSharedAttachmentFolderForNote(file, {
          notifyDuplicate: true,
          createFolder: false
        }).catch((err) => {
          console.error("[xyblue135 私人·附件镜像] create duplicate check failed:", err);
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, info) => {
        if (!this.settings.handlePaste || evt.defaultPrevented) return;

        // Windows / Electron 在“资源管理器复制文件 → Obsidian 粘贴”时，
        // 某些文件类型（例如 ZIP）不一定稳定出现在 DataTransfer.files 中，
        // 但通常仍可从 DataTransfer.items 的 file item 取到。
        // 因此统一从 files + items 两个入口收集，并做去重。
        const files = this.getFilesFromDataTransfer(evt.clipboardData);

        if (!files.length) return;

        const note = info && info.file;
        if (!(note instanceof TFile) || note.extension !== "md") return;

        // 接管文件/图片粘贴，阻止 Obsidian 默认附件逻辑。
        // 修复 8.2 / 8.6：在 preventDefault 之前先抓取选区快照，
        // 后面即使创建附件要花几秒，链接也会插回粘贴时的位置。
        const anchor = this.getEditorAnchor(editor);
        // 修复 8.7：同时记下纯文本兜底内容，导入全部失败时至少不静默丢内容。
        const fallbackText = this.getPlainTextFromDataTransfer(evt.clipboardData);

        evt.preventDefault();
        evt.stopPropagation();

        void this.importFiles(files, note, editor, anchor, fallbackText).catch((err) => {
          console.error("[xyblue135 私人·附件镜像] paste failed:", err);
          new Notice("xyblue135 私人·附件镜像：粘贴附件失败，请查看控制台。");
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, info) => {
        if (!this.settings.handleDrop || evt.defaultPrevented) return;

        const files = this.getFilesFromDataTransfer(evt.dataTransfer);

        // Obsidian 内部拖动通常没有系统 FileList / file item，因此不会误拦截。
        if (!files.length) return;

        const note = info && info.file;
        if (!(note instanceof TFile) || note.extension !== "md") return;

        // 修复 8.2 / 8.6：同样在 preventDefault 前抓取选区快照。
        const anchor = this.getEditorAnchor(editor);

        evt.preventDefault();
        evt.stopPropagation();

        void this.importFiles(files, note, editor, anchor).catch((err) => {
          console.error("[xyblue135 私人·附件镜像] drop failed:", err);
          new Notice("xyblue135 私人·附件镜像：拖入附件失败，请查看控制台。");
        });
      })
    );

    // Markdown 仅在“文件名本身发生变化”时处理附件目录。
    // 单纯移动父目录、重命名 00_docs 根目录不会改变 00_assets/<文件名>/，因此不搬附件。
    // 仍使用串行队列，避免批量重命名时发生并发冲突。
    this.renameSyncQueue = Promise.resolve();
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.settings.syncOnNoteRename) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;

        // 立即保存事件发生时的新路径，避免排队期间 file.path 又发生变化。
        const newPath = file.path;
        this.renameSyncQueue = this.renameSyncQueue
          .then(() => this.syncAttachmentFolderAfterRename(newPath, oldPath))
          .catch((err) => {
            console.error("[xyblue135 私人·附件镜像] rename sync failed:", err);
            new Notice("xyblue135 私人·附件镜像：同步附件目录失败，请查看控制台。");
          });
      })
    );

    // Markdown 真正删除时按“同名引用计数”决定是否回收附件。
    // 只要 Vault 中仍有另一篇同名 Markdown，00_assets/<文件名>/ 就继续保留。
    // 只有最后一个同名 Markdown 被删除时，才进入插件自己的可恢复垃圾桶。
    // 注意：手动勾选删除流程（executeManualDelete）会先自行处理附件并置位
    // skipAutoTrash，因此这里必须跳过，避免重复回收。
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        // 手动勾选删除流程已自行处理附件：命中守卫则消费并跳过自动回收。
        if (file && this.manualDeleteGuard.has(file.path)) {
          this.manualDeleteGuard.delete(file.path);
          return;
        }
        if (!this.settings.deleteAttachmentsWithNote) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.isManagedNotePath(file.path)) return;

        void this.trashAttachmentFolderAfterNoteDelete(file.path).catch((err) => {
          console.error("[xyblue135 私人·附件镜像] delete sync failed:", err);
          new Notice("xyblue135 私人·附件镜像：关联删除附件目录失败，请查看控制台。");
        });
      })
    );

    // 左侧文件树右键 Markdown -> 打开对应附件目录。
    // v2.1：开启删除确认后，同时把 Obsidian 默认的“删除”项替换为
    // “删除…（可勾选附件）”，确保取消 = 什么都不删除。
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        if (
          this.settings.deleteDialogEnabled &&
          this.isManagedNotePath(file.path)
        ) {
          this.replaceDeleteMenuItems(menu, file);
        }

        menu.addItem((item) => {
          item
            .setTitle("📂 打开对应附件目录")
            .onClick(() => {
              void this.revealAttachmentFolder(file);
            });
        });
      })
    );

    // v2.1：文件树中按 Delete 键删除 Markdown 时，先弹出勾选确认。
    // 使用 capture 阶段监听并阻止 Obsidian 默认删除动作。
    const deleteKeyHandler = (event) => {
      if (!this.settings.deleteDialogEnabled) return;
      if (event.key !== "Delete") return;

      // 只在文件树容器内生效；编辑器中的 Delete 是删除字符，绝不能拦。
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      // 修复 8.5：文件树里的内联重命名输入框、搜索框等可编辑控件一律放行，
      // 否则按 Delete 想删一个字符都会被打断并弹出删除对话框。
      if (target.isContentEditable) return;
      if (
        typeof target.closest === "function" &&
        target.closest(
          "input, textarea, select, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']"
        )
      ) {
        return;
      }

      const inExplorer =
        target.closest(".nav-files-container") ||
        target.closest(".workspace-leaf-content[data-type='file-explorer']") ||
        target.closest(".tree-item[data-path]");
      if (!inExplorer) return;

      const files = this.getSelectedExplorerFiles();
      const mdFiles = files.filter(
        (f) =>
          f instanceof TFile &&
          f.extension === "md" &&
          this.isManagedNotePath(f.path)
      );
      if (!mdFiles.length) return;

      // 修复 8.4：多选时不再“提示不支持、却照样删第一篇”。
      // 直接放行，让 Obsidian 原生批量删除接手（附件由 delete 事件按引用计数回收）。
      // 修复 8.1：混合选择（受管笔记 + PDF/文件夹）同样放行，
      // 否则只拦下那一篇笔记，其余选中对象的删除会被静默吞掉。
      if (files.length > 1) {
        new Notice(
          `xyblue135 私人·附件镜像：已选中 ${files.length} 个对象，本次交给 Obsidian 原生批量删除（附件按同名引用计数回收）。`,
          6000
        );
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void this.openDeleteDialog(mdFiles[0]);
    };
    document.addEventListener("keydown", deleteKeyHandler, true);
    this.register(() => {
      document.removeEventListener("keydown", deleteKeyHandler, true);
    });

    // v2.1：命令面板 / 快捷键 / 文件树“删除按钮”触发的删除命令统一走勾选确认。
    // 关键修复：删除命令的目标文件是“文件树中选中的文件”，不是当前打开的笔记。
    // 之前写死 getActiveFile() 会导致：在文件树点 B 的删除、却用编辑器里打开的
    // A 当目标，从而弹错文件、甚至吞掉 B 的删除（表现为“删不掉 / 没确认”）。
    // 这里优先取选中的 Markdown 文件，取不到才回退到活动文件，与 Delete 键逻辑一致。
    const originalExecuteCommand = this.app.commands.executeCommandById.bind(
      this.app.commands
    );
    this.app.commands.executeCommandById = async (commandId, ...args) => {
      if (
        this.settings.deleteDialogEnabled &&
        typeof commandId === "string" &&
        /delete-file/.test(commandId)
      ) {
        const selected = this.getSelectedExplorerFiles();
        const mdFiles = selected.filter(
          (f) =>
            f instanceof TFile &&
            f.extension === "md" &&
            this.isManagedNotePath(f.path)
        );

        // 修复 8.1：选中的是 PDF / 文件夹 / 00_docs 之外的 Markdown 等“本插件不该管”的
        // 目标时，绝不替换成“当前打开的笔记”，直接交回 Obsidian 原生删除逻辑。
        if (selected.length && !mdFiles.length) {
          return originalExecuteCommand(commandId, ...args);
        }

        // 修复 8.4：多选时不再“只删第一篇”，交回 Obsidian 原生批量删除；
        // 附件回收由 vault delete 事件按同名引用计数处理。
        // 修复 8.1：混合选择（受管笔记 + PDF/文件夹）也整体交回，
        // 避免只处理笔记、把其余选中对象的删除吞掉。
        if (selected.length > 1) {
          new Notice(
            `xyblue135 私人·附件镜像：已选中 ${selected.length} 个对象，本次交给 Obsidian 原生批量删除（附件按同名引用计数回收）。`,
            6000
          );
          return originalExecuteCommand(commandId, ...args);
        }

        let target = mdFiles.length ? mdFiles[0] : null;

        // 修复 8.1：只有“文件树选择集为空”时才回退到当前打开的笔记。
        if (!target && !selected.length) {
          const activeFile = this.app.workspace.getActiveFile();
          if (
            activeFile instanceof TFile &&
            activeFile.extension === "md" &&
            this.isManagedNotePath(activeFile.path)
          ) {
            target = activeFile;
          }
        }
        if (target) {
          await this.openDeleteDialog(target);
          return;
        }
      }
      return originalExecuteCommand(commandId, ...args);
    };
    this.register(() => {
      this.app.commands.executeCommandById = originalExecuteCommand;
    });
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    // 修复 8.14：data.json 被手改/旧版本写成 null、数字等错误类型时，
    // 不能让 Object.assign 覆盖默认值——notesRoot 变成空串会“接管整个库”。
    let migrated = false;
    for (const key of ["notesRoot", "attachmentsRoot", "structureMode", "fileNameMode"]) {
      if (typeof this.settings[key] !== "string") {
        this.settings[key] = DEFAULT_SETTINGS[key];
        migrated = true;
      }
    }
    for (const key of [
      "handlePaste",
      "handleDrop",
      "syncOnNoteRename",
      "deleteAttachmentsWithNote",
      "deleteDialogEnabled",
      "trashMigrationDone"
    ]) {
      if (typeof this.settings[key] !== "boolean") {
        this.settings[key] = DEFAULT_SETTINGS[key];
        migrated = true;
      }
    }

    // v2.0.1：新安装统一使用 00_assets。
    // 若 data.json 来自 v2.0.0 且仍是 attachment，则交给安全迁移函数处理；
    // 不直接改路径，避免旧目录尚未搬迁时先创建一套新的空目录。
    this.legacyFlatRootMigrationNeeded = this.cleanRoot(loaded.attachmentsRoot || "") === "attachment";

    // v2.0：固定使用“单层文件名共享附件目录”：00_assets/<basename>/。
    // 同名 Markdown 共享目录；附件命名继续沿用智能规则。
    if (this.settings.structureMode !== "note") {
      this.settings.structureMode = "note";
      migrated = true;
    }
    if (this.settings.syncOnNoteRename !== true) {
      this.settings.syncOnNoteRename = true;
      migrated = true;
    }
    if (!Array.isArray(this.settings.recycleHistory)) {
      this.settings.recycleHistory = [];
      migrated = true;
    }
    if (this.settings.fileNameMode !== "smart") {
      this.settings.fileNameMode = "smart";
      migrated = true;
    }

    if (migrated) await this.saveData(this.settings);
  }

  async migrateLegacyFlatAttachmentRootIfNeeded() {
    if (!this.legacyFlatRootMigrationNeeded) return;

    const oldRoot = normalizePath("attachment");
    const newRoot = normalizePath("00_assets");
    const oldNode = this.app.vault.getAbstractFileByPath(oldRoot);
    const newNode = this.app.vault.getAbstractFileByPath(newRoot);

    // 两个目录同时存在时绝不自动合并，也不自动删除任何一边。
    // 继续保留旧配置，并提示用户手动确认，避免覆盖或误归并附件。
    if (oldNode && newNode) {
      new Notice(
        "xyblue135 私人·附件镜像：同时检测到 attachment 与 00_assets，已停止自动迁移。请先手动确认数据，再把附件根目录改为 00_assets。",
        10000
      );
      return;
    }

    // 旧 v2.0.0 单层目录存在、新目录不存在：整体安全改名。
    // 使用 FileManager，让 Obsidian 有机会同步 Vault 内相关链接。
    if (oldNode && !newNode) {
      if (!(oldNode instanceof TFolder)) {
        new Notice("xyblue135 私人·附件镜像：Vault 根目录存在名为 attachment 的非文件夹对象，无法自动迁移。", 10000);
        return;
      }

      try {
        await this.app.fileManager.renameFile(oldNode, newRoot);
        this.settings.attachmentsRoot = newRoot;
        this.legacyFlatRootMigrationNeeded = false;
        await this.saveSettings();
        new Notice("xyblue135 私人·附件镜像：已将旧 attachment 安全迁移为 00_assets。", 7000);
      } catch (err) {
        console.error("[xyblue135 私人·附件镜像] migrate attachment -> 00_assets failed:", err);
        new Notice("xyblue135 私人·附件镜像：attachment → 00_assets 自动迁移失败，已保留旧配置和数据。", 10000);
      }
      return;
    }

    // 旧目录不存在（或新目录已经存在而旧目录不存在），只更新配置即可。
    this.settings.attachmentsRoot = newRoot;
    this.legacyFlatRootMigrationNeeded = false;
    await this.saveSettings();
  }

  // 一次性迁移：把旧版插件自制垃圾桶整体移入系统回收站，并清空恢复记录。
  async migratePluginTrashToSystemTrash() {
    // 修复 8.12：加一次性标记，迁移过就不再执行；
    // 避免从备份/Sync 恢复出 _MirrorAttachmentsTrash 后每次启动都被静默回收。
    if (this.settings.trashMigrationDone) return;

    const recycleRoot = this.getRecycleRoot();
    const recycleNode = this.app.vault.getAbstractFileByPath(recycleRoot);

    if (!(recycleNode instanceof TFolder)) {
      // 没有需要迁移的目录：只记标记，不动 recycleHistory（历史恢复记录不该被清空）。
      this.settings.trashMigrationDone = true;
      await this.saveSettings();
      return;
    }

    try {
      await this.app.vault.trash(recycleNode, true);
      this.settings.recycleHistory = [];
      // 只有真正迁移了目录才清空恢复记录。
      this.settings.trashMigrationDone = true;
      await this.saveSettings();
      new Notice("xyblue135 私人·附件镜像：已将旧插件垃圾桶移入系统回收站。", 7000);
    } catch (err) {
      console.error("[xyblue135 私人·附件镜像] migrate plugin trash failed:", err);
      new Notice("xyblue135 私人·附件镜像：旧插件垃圾桶迁移失败，请手动处理。", 10000);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getManagedMarkdownFiles() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isManagedNotePath(file.path));
  }

  getNoteBasenameFromPath(notePath) {
    const normalized = normalizePath(notePath || "");
    const fileName = normalized.split("/").pop() || "";
    return this.stripExtension(fileName);
  }

  getNotesByBasename(basename, excludePath = "") {
    const excluded = excludePath ? normalizePath(excludePath) : "";
    // 修复 8.11：Windows 上大小写不同即同一附件目录，因此按小写比较文件名。
    const key = String(basename || "").toLowerCase();
    return this.getManagedMarkdownFiles().filter(
      (file) =>
        String(file.basename || "").toLowerCase() === key &&
        (!excluded || normalizePath(file.path) !== excluded)
    );
  }

  getDuplicateNoteGroups() {
    const groups = new Map();
    for (const note of this.getManagedMarkdownFiles()) {
      // 修复 8.11：按小写分组，大小写不同的同名笔记算同一共享组。
      const key = String(note.basename || "").toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    }

    return Array.from(groups.values())
      .filter((notes) => notes.length > 1)
      .map((notes) => {
        const names = new Set(notes.map((file) => file.basename));
        return {
          basename: notes[0].basename,
          count: notes.length,
          // 大小写重名（Test.md / test.md）在审计面板单独提示。
          caseConflict: names.size > 1,
          notePaths: notes
            .map((file) => file.path)
            .sort((a, b) => a.localeCompare(b, "zh-CN")),
          folderPath: this.getAttachmentFolderForBasename(notes[0].basename)
        };
      })
      .sort((a, b) => b.count - a.count || a.basename.localeCompare(b.basename, "zh-CN"));
  }

  // v2.1：把“同名但共享目录”这件事查清楚——每张附件到底被哪几篇正文引用。
  // 只读，不搬任何文件；用于判断要不要给同名笔记改名。
  async buildDuplicateReport() {
    const groups = this.getDuplicateNoteGroups();
    const report = [];

    for (const group of groups) {
      const folder = this.getAbstractFileByPathCI(group.folderPath);
      const files =
        folder instanceof TFolder
          ? (folder.children || []).filter((child) => child instanceof TFile)
          : [];

      const notes = [];
      for (const notePath of group.notePaths) {
        const note = this.app.vault.getAbstractFileByPath(notePath);
        let text = "";
        if (note instanceof TFile) {
          try {
            text = await this.app.vault.cachedRead(note);
          } catch (err) {
            text = "";
          }
        }
        notes.push({ path: notePath, text });
      }

      const ownership = files.map((file) => ({
        name: file.name,
        notes: notes
          .filter((note) => note.text.includes(file.name))
          .map((note) => note.path)
      }));

      report.push({
        basename: group.basename,
        count: group.count,
        caseConflict: group.caseConflict,
        folderPath: group.folderPath,
        folderExists: folder instanceof TFolder,
        fileCount: files.length,
        notePaths: group.notePaths,
        ownership,
        exclusiveOwner: ownership.filter((item) => item.notes.length === 1).length,
        sharedFiles: ownership.filter((item) => item.notes.length > 1).length,
        orphanFiles: ownership.filter((item) => item.notes.length === 0).length
      });
    }

    return report;
  }

  async showDuplicateReport() {
    try {
      const report = await this.buildDuplicateReport();
      new MirrorDuplicateDialog(this.app, this, report).open();
    } catch (err) {
      console.error("[xyblue135 私人·附件镜像] duplicate report failed:", err);
      new Notice("xyblue135 私人·附件镜像：统计同名笔记失败，请查看控制台。");
    }
  }

  getAttachmentFolderForBasename(basename) {
    const attachmentRoot = this.cleanRoot(this.settings.attachmentsRoot) || "00_assets";
    return normalizePath(`${attachmentRoot}/${basename}`);
  }

  async ensureSharedAttachmentFolderForNote(note, options = {}) {
    const folderPath = this.getAttachmentFolderForNotePath(note.path);
    const existing = this.getAbstractFileByPathCI(folderPath);
    const peers = this.getNotesByBasename(note.basename, note.path);
    // v2.1：允许“只检查不建目录”（新建笔记时用），空目录不再无意义地堆出来。
    const shouldCreate = options.createFolder !== false;

    if (existing && !(existing instanceof TFolder)) {
      if (!shouldCreate) {
        return { folderPath, sharedWith: peers.length, created: false };
      }
      throw new Error(`无法创建目录：${folderPath} 已存在同名文件`);
    }

    const needsCreate = shouldCreate && !(existing instanceof TFolder);
    if (needsCreate) await this.ensureFolder(folderPath);

    if (options.notifyDuplicate && peers.length) {
      const preview = peers.slice(0, 3).map((file) => file.path).join("\n");
      const more = peers.length > 3 ? `\n另有 ${peers.length - 3} 篇同名笔记` : "";
      // v2.1：明确指出“已有多少附件会被共用”，否则用户不知道共享会带来什么后果。
      const current = this.getAbstractFileByPathCI(folderPath);
      const fileCount =
        current instanceof TFolder
          ? (current.children || []).filter((child) => child instanceof TFile).length
          : 0;
      const baggage = fileCount
        ? `\n该目录已有 ${fileCount} 个附件，本篇文章将与上面 ${peers.length} 篇共用这一批附件。`
        : "";
      new Notice(
        `xyblue135 私人·附件镜像：检测到同名笔记「${note.basename}」\n不会重复创建附件目录，将共享：${folderPath}\n${preview}${more}${baggage}\n如需查看附件归属，运行命令「检查同名笔记（附件归属）」。`,
        10000
      );
    }

    return { folderPath, sharedWith: peers.length };
  }

  async ensureAllNoteFolders() {
    if (this.settings.structureMode !== "note") {
      return { created: 0, conflicts: [] };
    }

    let created = 0;
    const conflicts = [];

    for (const note of this.getManagedMarkdownFiles()) {
      const folderPath = this.getAttachmentFolderForNotePath(note.path);
      // 修复 8.11：按不区分大小写解析，大小写不同的同名目录不再重复补建。
      const existing = this.getAbstractFileByPathCI(folderPath);

      if (existing instanceof TFolder) continue;

      if (existing) {
        conflicts.push({
          notePath: note.path,
          folderPath,
          reason: "目标位置存在同名文件，无法建立目录"
        });
        continue;
      }

      try {
        await this.ensureFolder(folderPath);
        created += 1;
      } catch (err) {
        conflicts.push({
          notePath: note.path,
          folderPath,
          reason: err && err.message ? err.message : String(err)
        });
      }
    }

    return { created, conflicts };
  }

  // 修复 8.17：删除从未被调用的死代码 getRequiredAttachmentPaths / getFoldersUnderRoot。

  async auditFolderConsistency() {
    const attachmentRoot = this.cleanRoot(this.settings.attachmentsRoot) || "00_assets";
    const notes = this.getManagedMarkdownFiles();
    const groups = new Map();

    for (const note of notes) {
      // 修复 8.11：按小写分组，大小写不同的同名笔记共享同一个物理目录。
      const key = String(note.basename || "").toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note.path);
    }

    const expected = new Map();
    for (const notePaths of groups.values()) {
      const basename = this.getNoteBasenameFromPath(notePaths[0]);
      const folderPath = this.getAttachmentFolderForBasename(basename);
      expected.set(this.normalizeKey(folderPath), { basename, notePaths, folderPath });
    }

    const missing = [];
    const conflicts = [];
    for (const group of expected.values()) {
      const existing = this.getAbstractFileByPathCI(group.folderPath);
      if (existing instanceof TFolder) continue;
      if (existing) {
        conflicts.push({
          notePath: group.notePaths.join(" | "),
          folderPath: group.folderPath,
          reason: "应为共享附件文件夹，但当前位置存在同名文件"
        });
      } else {
        missing.push({
          basename: group.basename,
          notePaths: group.notePaths,
          folderPath: group.folderPath
        });
      }
    }

    // 单层模式只把 00_assets 根目录的直接子目录当作“文章附件目录”。
    // 文章附件目录内部的子文件夹属于附件内容，不参与结构校验。
    const expectedPaths = new Set(Array.from(expected.keys()));
    const rootFolder = this.getAbstractFileByPathCI(normalizePath(attachmentRoot));
    const extra = [];
    if (rootFolder instanceof TFolder) {
      for (const child of rootFolder.children || []) {
        if (!(child instanceof TFolder)) continue;
        const path = normalizePath(child.path);
        if (this.isRecyclePath(path)) continue;
        if (!expectedPaths.has(this.normalizeKey(path))) extra.push({ folderPath: path });
      }
    }

    const duplicates = this.getDuplicateNoteGroups();

    // 修复 8.11：仅大小写不同的同名组单独报为冲突，提示用户统一命名。
    for (const group of duplicates) {
      if (!group.caseConflict) continue;
      conflicts.push({
        notePath: group.notePaths.join(" | "),
        folderPath: group.folderPath,
        reason: "文件名仅大小写不同：Windows 上会共用同一附件目录，建议统一命名"
      });
    }

    return {
      supported: true,
      notesCount: notes.length,
      expectedCount: expected.size,
      duplicateGroups: duplicates,
      missing,
      extra,
      conflicts,
      attachmentRoot
    };
  }

  async repairFolderConsistency(auditResult = null) {
    const audit = auditResult || await this.auditFolderConsistency();
    let created = 0;
    const conflicts = [...(audit.conflicts || [])];

    for (const item of audit.missing || []) {
      try {
        await this.ensureFolder(item.folderPath);
        created += 1;
      } catch (err) {
        conflicts.push({
          notePath: (item.notePaths || []).join(" | "),
          folderPath: item.folderPath,
          reason: err && err.message ? err.message : String(err)
        });
      }
    }

    // v2.0 安全原则：不自动回收“多余”目录。
    // 它们可能是旧镜像结构、历史绝对链接仍在引用的目录，或用户手工保存的数据。
    return { created, preservedExtra: (audit.extra || []).length, conflicts };
  }

  cleanRoot(path) {
    // 修复 8.14：data.json 被手工改成数字/对象时不能直接 .trim()，否则整插件启动即崩。
    if (path === null || path === undefined) return "";
    path = String(path).trim().replace(/^\/+|\/+$/g, "");
    return path ? normalizePath(path) : "";
  }

  // 修复 8.10：设置页文本输入落盘前的规范化与校验。
  // 空字符串会让 notesRoot 变成“托管整个库”，必须挡住中间态。
  validateRootSetting(key, rawValue) {
    const value = this.cleanRoot(rawValue);
    const label = key === "notesRoot" ? "笔记根目录" : "附件根目录";

    if (!value) {
      return { ok: false, value, reason: `${label}不能为空` };
    }

    const otherKey = key === "notesRoot" ? "attachmentsRoot" : "notesRoot";
    const otherValue = this.normalizeKey(
      this.cleanRoot(this.settings[otherKey]) || (otherKey === "attachmentsRoot" ? "00_assets" : "")
    );
    const lower = this.normalizeKey(value);

    if (otherValue) {
      if (
        lower === otherValue ||
        lower.startsWith(otherValue + "/") ||
        otherValue.startsWith(lower + "/")
      ) {
        return { ok: false, value, reason: `${label}不能与另一个根目录重叠` };
      }
    }

    return { ok: true, value };
  }

  // ---- 修复 8.11 / 8.13：Windows 路径大小写不敏感的统一处理 ----

  // 用小写形式作为比较键：Windows 上 00_assets/API 与 00_assets/api 是同一个物理目录。
  normalizeKey(path) {
    return normalizePath(path || "").toLowerCase();
  }

  samePath(a, b) {
    return this.normalizeKey(a) === this.normalizeKey(b);
  }

  // 在父目录的 children 里按不区分大小写查找（索引按原始字符串匹配，查不到时用这个兜底）。
  findChildByLowerCase(parentPath, name) {
    const parent = parentPath
      ? this.app.vault.getAbstractFileByPath(normalizePath(parentPath))
      : (typeof this.app.vault.getRoot === "function" ? this.app.vault.getRoot() : null);
    if (!(parent instanceof TFolder)) return null;

    const target = String(name || "").toLowerCase();
    for (const child of parent.children || []) {
      if (String(child.name || "").toLowerCase() === target) return child;
    }
    return null;
  }

  // 逐段按不区分大小写解析路径：精确命中优先，否则回读真实已存在的大小写。
  getAbstractFileByPathCI(path) {
    const normalized = normalizePath(path || "");
    if (!normalized) return null;

    const exact = this.app.vault.getAbstractFileByPath(normalized);
    if (exact) return exact;

    let current = null;
    for (const part of normalized.split("/").filter(Boolean)) {
      current = this.findChildByLowerCase(current ? current.path : "", part);
      if (!current) return null;
    }
    return current;
  }

  isManagedNotePath(notePath) {
    // 修复 8.13：统一小写后比较，避免设置里写成 00_Docs 就让整个插件静默失效。
    const normalized = this.normalizeKey(notePath);
    const notesRoot = this.normalizeKey(this.cleanRoot(this.settings.notesRoot));
    const attachmentRoot = this.normalizeKey(
      this.cleanRoot(this.settings.attachmentsRoot) || "00_assets"
    );

    // 配置了 00_docs 根目录时，只管理该目录下的 Markdown，
    // 防止删除附件根目录中的 .md 附件时发生误关联。
    if (notesRoot) {
      return normalized.startsWith(notesRoot + "/");
    }

    // notesRoot 为空代表允许管理整个库，但仍排除附件根目录自身。
    return !(
      normalized === attachmentRoot ||
      normalized.startsWith(attachmentRoot + "/")
    );
  }

  // 修复 8.17：删除从未被调用的死代码 getRelativeNotePath。

  stripExtension(path) {
    return path.replace(/\.md$/i, "");
  }

  parentPath(path) {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(0, i) : "";
  }

  getAttachmentFolderForNotePath(notePath) {
    const basename = this.getNoteBasenameFromPath(notePath);
    return this.getAttachmentFolderForBasename(basename);
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path);
    if (!normalized) return;

    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      const parent = current;
      const desired = parent ? `${parent}/${part}` : part;

      // 修复 8.11：精确命中优先；否则在父目录 children 里按小写回读，
      // 避免 00_assets/API 已存在时 createFolder("00_assets/api") 报“已存在”，
      // 随后 getAbstractFileByPath 又返回 undefined 导致整条粘贴失败。
      let existing = this.app.vault.getAbstractFileByPath(desired);
      if (!existing) existing = this.findChildByLowerCase(parent, part);

      if (!existing) {
        try {
          const created = await this.app.vault.createFolder(desired);
          existing =
            created instanceof TFolder
              ? created
              : (this.app.vault.getAbstractFileByPath(desired) ||
                 this.findChildByLowerCase(parent, part));
        } catch (err) {
          // 文件夹批量改名时可能有多个事件同时尝试建立同一父目录。
          // 如果失败后发现目录已经由另一任务创建，则视为成功。
          const afterCreate =
            this.app.vault.getAbstractFileByPath(desired) ||
            this.findChildByLowerCase(parent, part);
          if (!(afterCreate instanceof TFolder)) throw err;
          existing = afterCreate;
        }
      }

      if (!(existing instanceof TFolder)) {
        const actual = existing && existing.path ? existing.path : desired;
        throw new Error(`无法创建目录：${actual} 已存在同名文件`);
      }

      // 使用真实存在的大小写继续拼接，后续层级才不会因大小写差异再查不到。
      current = normalizePath(existing.path || desired);
    }
  }

  getRecycleRoot() {
    const attachmentRoot =
      this.cleanRoot(this.settings.attachmentsRoot) || "00_assets";
    return normalizePath(`${attachmentRoot}/_MirrorAttachmentsTrash`);
  }

  isRecyclePath(path) {
    const normalized = normalizePath(path || "");
    const recycleRoot = this.getRecycleRoot();
    return normalized === recycleRoot || normalized.startsWith(recycleRoot + "/");
  }

  async trashFolderSafely(folder) {
    if (!(folder instanceof TFolder)) return false;

    if (
      this.app.fileManager &&
      typeof this.app.fileManager.trashFile === "function"
    ) {
      await this.app.fileManager.trashFile(folder);
    } else {
      await this.app.vault.trash(folder, false);
    }

    return true;
  }

  async cleanupEmptyAttachmentParents(startPath) {
    const attachmentRoot = normalizePath(
      this.cleanRoot(this.settings.attachmentsRoot) || "00_assets"
    );

    let current = normalizePath(startPath || "");
    let cleaned = 0;

    // 只允许清理附件根目录之下，根目录自身永远保留。
    while (
      current &&
      current !== attachmentRoot &&
      current.startsWith(attachmentRoot + "/")
    ) {
      const folder = this.app.vault.getAbstractFileByPath(current);

      // 已不存在时继续检查更上一级；非文件夹对象则停止，避免误操作。
      if (!folder) {
        current = this.parentPath(current);
        continue;
      }
      if (!(folder instanceof TFolder)) break;

      // 只回收真正的空目录。一旦遇到仍有内容的父目录立即停止。
      if ((folder.children || []).length !== 0) break;

      const parent = this.parentPath(current);
      await this.trashFolderSafely(folder);
      cleaned += 1;
      current = parent;
    }

    return cleaned;
  }

  getFilesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];

    const result = [];
    const seen = new Set();

    const addFile = (file) => {
      if (!file || typeof file.arrayBuffer !== "function") return;

      // 同一个系统文件可能同时出现在 files 和 items 中。
      // 用稳定的 File 元数据去重，避免一次粘贴生成两个副本。
      const key = [
        file.name || "",
        Number.isFinite(file.size) ? file.size : "",
        Number.isFinite(file.lastModified) ? file.lastModified : "",
        file.type || ""
      ].join("\u0000");

      if (seen.has(key)) return;
      seen.add(key);
      result.push(file);
    };

    for (const file of Array.from(dataTransfer.files || [])) {
      addFile(file);
    }

    for (const item of Array.from(dataTransfer.items || [])) {
      if (!item || item.kind !== "file" || typeof item.getAsFile !== "function") {
        continue;
      }

      try {
        addFile(item.getAsFile());
      } catch (err) {
        console.warn("[xyblue135 私人·附件镜像] cannot read DataTransferItem:", err);
      }
    }

    return result;
  }

  // 修复 8.7：粘贴时顺手取纯文本，全部导入失败时用它在原位置兜底插入，
  // 避免“已经 preventDefault 了默认粘贴，正文却什么都没有”。
  getPlainTextFromDataTransfer(dataTransfer) {
    try {
      if (!dataTransfer || typeof dataTransfer.getData !== "function") return "";
      return dataTransfer.getData("text/plain") || "";
    } catch (err) {
      return "";
    }
  }

  // 修复 8.2 / 8.6：在事件同步阶段抓取选区快照，后续异步导入不再依赖实时光标。
  getEditorAnchor(editor) {
    try {
      if (!editor || typeof editor.getCursor !== "function") return null;
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      if (!from || typeof from.line !== "number") return null;
      return { from, to: to && typeof to.line === "number" ? to : from };
    } catch (err) {
      console.warn("[xyblue135 私人·附件镜像] cannot read editor selection:", err);
      return null;
    }
  }

  // 插入前确认编辑器仍属于同一篇笔记，否则不要把链接写进别的文件。
  isEditorAliveForNote(editor, note) {
    if (!editor || !note) return false;
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.path !== note.path) return false;
    const editorFile = editor.file;
    if (editorFile && editorFile.path && editorFile.path !== note.path) return false;
    return true;
  }

  insertTextAtAnchor(editor, anchor, text) {
    try {
      if (anchor && typeof editor.replaceRange === "function") {
        editor.replaceRange(text, anchor.from, anchor.to || anchor.from);
        return true;
      }
      if (typeof editor.replaceSelection === "function") {
        editor.replaceSelection(text);
        return true;
      }
    } catch (err) {
      console.error("[xyblue135 私人·附件镜像] insert text failed:", err);
    }
    return false;
  }

  insertLinksAtAnchor(editor, note, anchor, text) {
    if (!this.isEditorAliveForNote(editor, note)) {
      new Notice(
        `xyblue135 私人·附件镜像：附件已保存，但当前笔记已切换，链接没有写入正文。\n请手动粘贴：\n${text}`,
        9000
      );
      return;
    }
    if (!this.insertTextAtAnchor(editor, anchor, text)) {
      new Notice(
        `xyblue135 私人·附件镜像：附件已保存，但无法写入正文，请手动粘贴：\n${text}`,
        9000
      );
    }
  }

  insertFallbackText(editor, note, anchor, fallbackText) {
    if (!fallbackText) return;
    if (!this.isEditorAliveForNote(editor, note)) return;
    this.insertTextAtAnchor(editor, anchor, fallbackText);
  }

  // 修复 8.20：把“取名 + createBinary”串行化，并对“已存在”错误重试。
  enqueueImport(task) {
    const run = this.importQueue.then(task, task);
    this.importQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async createAttachmentWithUniqueName(file, targetFolder, buffer) {
    return this.enqueueImport(async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const naming = this.getImportFileName(file, targetFolder);
        const targetPath = normalizePath(`${targetFolder}/${naming.name}`);
        try {
          const created = await this.app.vault.createBinary(targetPath, buffer);
          return { naming, created };
        } catch (err) {
          lastError = err;
          const message = String((err && err.message) || err || "");
          // 只有“已存在”这类冲突才值得重新取名重试，其它错误直接抛出。
          if (!/exist|already|已存在|已占用/i.test(message)) throw err;
        }
      }
      throw lastError;
    });
  }

  sanitizeFileName(name) {
    let safe = String(name || "")
      // Windows 非法字符 + ASCII 控制字符统一替换成短横线。
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .trim();

    if (!safe || safe === "." || safe === "..") {
      safe = "附件";
    }

    // Windows 保留设备名在跨平台 Vault 中也容易产生同步问题。
    const stem = safe.split(".")[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      safe = `_${safe}`;
    }

    return safe;
  }

  makeOriginalFileName(file) {
    const rawName = file && file.name ? file.name : "";
    let safeName = this.sanitizeFileName(rawName);
    const ext = this.getExt(rawName, file && file.type);

    // 某些剪贴板 File 没有可靠的 name，只能从 MIME 推断扩展名。
    if (!safeName.includes(".") && ext && ext !== "bin") {
      safeName = `${safeName}.${ext}`;
    }

    return safeName;
  }

  makeUniqueOriginalFileName(file, targetFolder) {
    const desiredName = this.makeOriginalFileName(file);
    const dot = desiredName.lastIndexOf(".");
    const hasExt = dot > 0 && dot < desiredName.length - 1;
    const baseName = hasExt ? desiredName.slice(0, dot) : desiredName;
    const extension = hasExt ? desiredName.slice(dot) : "";

    let candidate = desiredName;
    let index = 1;

    // 修复 8.15：Windows 上 Photo.PNG 与 photo.png 是同一个物理文件，
    // 因此判重必须不区分大小写，否则会静默覆盖既有附件。
    const folder = this.getAbstractFileByPathCI(targetFolder);
    const taken = new Set();
    if (folder instanceof TFolder) {
      for (const child of folder.children || []) {
        taken.add(String(child.name || "").toLowerCase());
      }
    }
    const isTaken = (name) =>
      taken.has(String(name).toLowerCase()) ||
      !!this.app.vault.getAbstractFileByPath(normalizePath(`${targetFolder}/${name}`));

    while (isTaken(candidate)) {
      candidate = `${baseName} (${index})${extension}`;
      index += 1;
    }

    return {
      name: candidate,
      renamed: candidate !== desiredName,
      desiredName
    };
  }

  getImportFileName(file, targetFolder) {
    const ext = this.getExt(file && file.name, file && file.type);
    if (EMBED_EXTENSIONS.has(ext)) {
      return {
        name: this.makeTimestampFileName(file, targetFolder),
        renamed: false,
        desiredName: null,
        embedded: true
      };
    }

    return {
      ...this.makeUniqueOriginalFileName(file, targetFolder),
      embedded: false
    };
  }

  getExt(fileName, mimeType) {
    const safe = fileName || "";
    const dot = safe.lastIndexOf(".");

    if (dot > 0 && dot < safe.length - 1) {
      return safe.slice(dot + 1).toLowerCase();
    }

    const mimeMap = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "application/pdf": "pdf"
    };

    return mimeMap[mimeType] || "bin";
  }

  formatTimestamp(ms) {
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, "0");
    const p3 = (n) => String(n).padStart(3, "0");

    // 纯数字毫秒级时间戳：YYYYMMDDHHmmssSSS
    // 例如：20260809021530123.png
    return (
      d.getFullYear() +
      p2(d.getMonth() + 1) +
      p2(d.getDate()) +
      p2(d.getHours()) +
      p2(d.getMinutes()) +
      p2(d.getSeconds()) +
      p3(d.getMilliseconds())
    );
  }

  makeTimestampFileName(file, targetFolder) {
    const ext = this.getExt(file.name, file.type);

    // 一次粘贴多个附件时，循环可能快于 1ms。
    // 使用“单调递增”的毫秒时间：如果当前时间没有前一个名字新，
    // 就在前一个时间基础上 +1ms。这样仍然是纯时间戳，不需要 -1/-2。
    let ms = Math.max(Date.now(), (this.lastAttachmentTimestampMs || 0) + 1);

    while (true) {
      const name = `${this.formatTimestamp(ms)}.${ext}`;
      const path = normalizePath(`${targetFolder}/${name}`);

      // 修复 8.15：同样按不区分大小写判重。
      if (
        !this.app.vault.getAbstractFileByPath(path) &&
        !this.getAbstractFileByPathCI(path)
      ) {
        this.lastAttachmentTimestampMs = ms;
        return name;
      }

      // 极小概率目录中已有相同时间戳，则继续顺延 1ms。
      ms += 1;
    }
  }

  escapeAltText(text) {
    return (text || "")
      .replace(/\\/g, "\\\\")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
  }

  markdownSafePath(path) {
    // 保留中文和目录结构，只转义 Markdown 链接里常见的问题字符。
    // 修复 8.19：方括号是链接目标的边界字符，不转义会把「方案[最终版].docx」这类
    // 文件名截断成错误链接。% 必须最先处理，避免二次编码。
    return path
      .replace(/%/g, "%25")
      .replace(/ /g, "%20")
      .replace(/#/g, "%23")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\[/g, "%5B")
      .replace(/\]/g, "%5D");
  }

  // 修复 8.17：删除从未被调用的死代码 getRelativePath。

  makeMarkdownLink(createdFile, sourceNote) {
    // 使用以 Obsidian 仓库根目录为基准的绝对路径。
    // 例如：00_assets/test/image.png -> /00_assets/test/image.png
    const vaultAbsolutePath = `/${normalizePath(createdFile.path).replace(/^\/+/, "")}`;
    const safePath = this.markdownSafePath(vaultAbsolutePath);
    const description = this.escapeAltText(
      createdFile.name || createdFile.basename || "附件"
    );

    const ext = (createdFile.extension || "").toLowerCase();
    const shouldEmbed = EMBED_EXTENSIONS.has(ext);

    if (shouldEmbed) {
      // 可直接预览的附件（图片 / PDF）使用嵌入语法。
      // alt 固定为空，保持笔记正文简洁：![](/00_assets/test/file.ext)
      return `![](${safePath})`;
    }

    // ZIP / RAR / 7Z / Office 等不可直接预览的普通附件只插入链接，
    // 不加感叹号，避免让 Obsidian 尝试把压缩包等内容嵌入正文。
    return `[${description}](${safePath})`;
  }

  async importFiles(files, note, editor, anchor = null, fallbackText = "") {
    const desiredFolder = this.getAttachmentFolderForNotePath(note.path);
    // 修复 8.2 / 8.6：优先使用事件同步阶段抓到的选区快照。
    const insertAt = anchor || this.getEditorAnchor(editor);
    const attachmentRoot = normalizePath(
      this.cleanRoot(this.settings.attachmentsRoot) || "00_assets"
    );

    let targetFolder = desiredFolder;
    let folderReady = true;

    try {
      await this.ensureFolder(targetFolder);
    } catch (err) {
      console.error("[xyblue135 私人·附件镜像] cannot create target folder:", err);
      // 修复 8.7：目录建不出来时先退回附件根目录兜底，
      // 不再“剪贴板已被拦截、正文却什么都没有”。
      try {
        await this.ensureFolder(attachmentRoot);
        targetFolder = attachmentRoot;
        new Notice(
          `xyblue135 私人·附件镜像：目标目录无法创建，已改存到附件根目录\n${desiredFolder}\n→ ${attachmentRoot}`,
          8000
        );
      } catch (fallbackErr) {
        console.error("[xyblue135 私人·附件镜像] fallback attachment root failed:", fallbackErr);
        new Notice(
          `xyblue135 私人·附件镜像：目标目录无法创建，本次没有保存任何附件，请稍后重试。\n${desiredFolder}`,
          8000
        );
        folderReady = false;
      }
    }

    if (!folderReady) {
      // 一个附件也存不了：把纯文本兜底写回正文，别让这一次粘贴彻底丢失。
      this.insertFallbackText(editor, note, insertAt, fallbackText);
      return;
    }

    const links = [];
    const renamed = [];
    const failed = [];

    for (const file of files) {
      if (!file || typeof file.arrayBuffer !== "function") {
        failed.push(file && file.name ? file.name : "未知附件");
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        // 修复 8.20：取名 + 落盘放进串行队列，并对同名冲突自动重新取名重试。
        const { naming, created } = await this.createAttachmentWithUniqueName(
          file,
          targetFolder,
          buffer
        );

        links.push(this.makeMarkdownLink(created, note));

        if (naming.renamed) {
          renamed.push({
            from: naming.desiredName,
            to: naming.name
          });
        }
      } catch (err) {
        console.error(`[xyblue135 私人·附件镜像] failed to import ${file.name || "file"}:`, err);
        failed.push(file.name || "未知附件");
      }
    }

    if (links.length) {
      // 多附件之间留一个空行，图片、PDF 和普通附件混排时更清楚。
      // 修复 8.2 / 8.6：写到粘贴时抓到的位置；笔记已切换则只提示、不乱插。
      this.insertLinksAtAnchor(editor, note, insertAt, links.join("\n\n"));
    } else if (failed.length) {
      // 修复 8.17：导入全部失败时回收本次可能新建的空目录，并兜底插入纯文本。
      await this.cleanupEmptyAttachmentParents(targetFolder);
      this.insertFallbackText(editor, note, insertAt, fallbackText);
    }

    if (renamed.length === 1) {
      new Notice(
        `xyblue135 私人·附件镜像：文件已存在，保存为 ${renamed[0].to}`,
        5000
      );
    } else if (renamed.length > 1) {
      const preview = renamed
        .slice(0, 3)
        .map((item) => `${item.from} → ${item.to}`)
        .join("\n");
      const more = renamed.length > 3 ? `\n另有 ${renamed.length - 3} 个重名附件` : "";
      new Notice(`xyblue135 私人·附件镜像：${renamed.length} 个重名附件已自动改名\n${preview}${more}`, 7000);
    }

    if (failed.length) {
      const preview = failed.slice(0, 3).join("、");
      const more = failed.length > 3 ? ` 等 ${failed.length} 个文件` : "";
      new Notice(
        `xyblue135 私人·附件镜像：${failed.length} 个附件保存失败：${preview}${more}`,
        7000
      );
    }

    if (links.length) {
      new Notice(
        `xyblue135 私人·附件镜像：已保存 ${links.length} 个附件到 ${targetFolder}`,
        4500
      );
    } else if (failed.length) {
      new Notice("xyblue135 私人·附件镜像：没有附件成功保存，请查看控制台。", 6000);
    }
  }

  async revealAttachmentFolder(note) {
    const folderPath =
      this.getAttachmentFolderForNotePath(note.path);

    const folder =
      this.getAbstractFileByPathCI(folderPath);

    if (!(folder instanceof TFolder)) {
      new Notice(
        `xyblue135 私人·附件镜像：对应附件目录尚不存在：${folderPath}`,
        5000
      );
      return;
    }

    const leaves =
      this.app.workspace.getLeavesOfType("file-explorer");

    const leaf =
      leaves && leaves.length ? leaves[0] : null;

    const view = leaf && leaf.view;

    if (view && typeof view.revealInFolder === "function") {
      await view.revealInFolder(folder);

      if (
        typeof this.app.workspace.revealLeaf === "function"
      ) {
        await this.app.workspace.revealLeaf(leaf);
      }
      return;
    }

    // 某些 Obsidian 版本没有公开 revealInFolder，至少给出准确目录。
    new Notice(
      `xyblue135 私人·附件镜像：附件目录：${folderPath}`,
      7000
    );
  }

  // 修复 8.9：同名笔记之外，还要看真实的链接引用。
  // 插件自己就会制造跨文件引用（改名后旧目录保留、用户手工复制绝对链接），
  // 所以回收前用 metadataCache.resolvedLinks 反查：还有别的笔记链接到该目录内文件就不回收。
  getNotesReferencingFolder(folder, excludeNotePath = "") {
    const result = [];
    try {
      const metadataCache = this.app.metadataCache;
      const resolved = metadataCache && metadataCache.resolvedLinks;
      if (!resolved || !folder) return result;

      const prefix = this.normalizeKey(folder.path) + "/";
      const excluded = excludeNotePath ? this.normalizeKey(excludeNotePath) : "";

      for (const source of Object.keys(resolved)) {
        if (excluded && this.normalizeKey(source) === excluded) continue;
        const links = resolved[source] || {};
        for (const dest of Object.keys(links)) {
          if (this.normalizeKey(dest).startsWith(prefix)) {
            result.push(source);
            break;
          }
        }
      }
    } catch (err) {
      console.warn("[xyblue135 私人·附件镜像] scan folder links failed:", err);
    }
    return result;
  }

  // 修复 8.9（保守补充）：resolvedLinks 只覆盖 Obsidian 能解析的链接，
  // 正文里手写、代码块里记录的 /00_assets/<名>/ 绝对路径它看不到。
  // 因此回收前再对受管笔记做一次纯文本扫描：命中该目录路径即视为“仍被引用”。
  async getNotesMentioningFolder(folder, excludeNotePath = "") {
    const result = [];
    if (!folder) return result;

    const needle = "/" + this.normalizeKey(folder.path) + "/";
    const excluded = excludeNotePath ? this.normalizeKey(excludeNotePath) : "";

    for (const note of this.getManagedMarkdownFiles()) {
      if (excluded && this.normalizeKey(note.path) === excluded) continue;
      try {
        const text = await this.app.vault.cachedRead(note);
        if (String(text || "").toLowerCase().includes(needle)) result.push(note.path);
      } catch (err) {
        // 读不到内容就无法证明“没有引用”，按仍有引用处理（宁可少删）。
        console.warn("[xyblue135 私人·附件镜像] cannot read note for reference scan:", err);
        result.push(note.path);
      }
    }

    return result;
  }

  // 修复 8.9：链接解析 + 正文纯文本扫描合并去重，作为回收前的真实引用判定。
  async collectFolderReferences(folder, excludeNotePath = "") {
    const merged = new Set(this.getNotesReferencingFolder(folder, excludeNotePath));
    for (const path of await this.getNotesMentioningFolder(folder, excludeNotePath)) {
      merged.add(path);
    }
    return Array.from(merged).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  async trashAttachmentFolderAfterNoteDelete(notePath) {
    const basename = this.getNoteBasenameFromPath(notePath);
    const remainingNotes = this.getNotesByBasename(basename, notePath);
    const folderPath = this.getAttachmentFolderForBasename(basename);
    const attachmentRoot = this.cleanRoot(this.settings.attachmentsRoot) || "00_assets";

    // 共享引用仍存在：只更新“引用关系”，绝不碰附件目录。
    if (remainingNotes.length > 0) {
      const preview = remainingNotes.slice(0, 3).map((file) => file.path).join("\n");
      const more = remainingNotes.length > 3 ? `\n另有 ${remainingNotes.length - 3} 篇` : "";
      new Notice(
        `xyblue135 私人·附件镜像：已删除一篇「${basename}」，但仍有 ${remainingNotes.length} 篇同名笔记共享附件。\n附件保持不动：${folderPath}\n${preview}${more}`,
        8000
      );
      return;
    }

    // 修复 8.11：按不区分大小写解析真实目录。
    if (this.samePath(folderPath, attachmentRoot)) return;

    const folder = this.getAbstractFileByPathCI(folderPath);
    if (!(folder instanceof TFolder)) return;

    // 修复 8.9：还有别的笔记用绝对路径引用这个目录里的文件时，跳过回收并列出受影响笔记。
    // 修复 8.9：判定改为“链接解析 + 正文纯文本扫描”，命中任意一种都跳过。
    const referencing = await this.collectFolderReferences(folder, notePath);
    if (referencing.length) {
      const preview = referencing.slice(0, 3).join("\n");
      const more = referencing.length > 3 ? `\n另有 ${referencing.length - 3} 篇` : "";
      new Notice(
        `xyblue135 私人·附件镜像：这是最后一篇「${basename}」，但仍有 ${referencing.length} 篇笔记引用该附件目录，已跳过回收。\n${folderPath}\n${preview}${more}`,
        9000
      );
      return;
    }

    await this.trashToSystemTrash(folder);

    new Notice(
      `xyblue135 私人·附件镜像：这是最后一篇「${basename}」，共享附件已移入系统回收站\n${folderPath}`,
      6000
    );
  }

  // ---- v2.1：删除勾选确认流程 ----

  getSelectedExplorerFiles() {
    try {
      const leaves = this.app.workspace.getLeavesOfType("file-explorer");
      for (const leaf of leaves) {
        const view = leaf && leaf.view;
        if (view && typeof view.getSelectedFiles === "function") {
          const files = view.getSelectedFiles();
          if (Array.isArray(files) && files.length) return files;
        }
      }
    } catch (err) {
      console.warn("[xyblue135 私人·附件镜像] getSelectedFiles failed:", err);
    }

    // 兜底：直接从文件树 DOM 读取选中的行。
    const result = [];
    document.querySelectorAll(".nav-file-title.is-selected").forEach((el) => {
      const path = el.getAttribute("data-path");
      if (!path) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) result.push(file);
    });
    return result;
  }

  replaceDeleteMenuItems(menu, file) {
    // 修复 8.16：不再用「包含」关键词粗暴匹配，否则「删除未使用附件」
    // 这类第三方插件菜单项也会被静默移除。改为精确标题集合 + 排除带子菜单的项。
    const deleteTitles = new Set([
      "删除",
      "删除…",
      "删除...",
      "删除文件",
      "删除文件夹",
      "删除笔记",
      "移到回收站",
      "移至回收站",
      "移动至回收站",
      "永久删除",
      "delete",
      "delete…",
      "delete...",
      "delete file",
      "delete folder",
      "delete note",
      "move to trash",
      "move to system trash",
      "delete permanently"
    ]);
    try {
      const items = menu["items"];
      if (Array.isArray(items)) {
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (!item) continue;
          // 带子菜单的项（如「删除 →」二级菜单）不是核心删除项，跳过。
          if (item.submenu) continue;
          const title = (
            (item.titleEl && item.titleEl.textContent) ||
            item.title ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
          if (deleteTitles.has(title)) {
            items.splice(i, 1);
          }
        }
      }
    } catch (err) {
      console.warn(
        "[xyblue135 私人·附件镜像] replace delete menu item failed:",
        err
      );
    }

    menu.addItem((item) => {
      item
        .setTitle("删除…（可勾选附件）")
        .setIcon("trash")
        .onClick(() => {
          void this.openDeleteDialog(file);
        });
    });
  }

  async openDeleteDialog(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return;

    const basename = this.getNoteBasenameFromPath(file.path);
    const folderPath = this.getAttachmentFolderForBasename(basename);
    // 修复 8.11：按不区分大小写解析真实目录。
    const folder = this.getAbstractFileByPathCI(folderPath);
    const sharedNotes = this.getNotesByBasename(basename, file.path);

    const folderInfo =
      folder instanceof TFolder
        ? {
            path: folderPath,
            fileCount: (folder.children || []).filter(
              (child) => child instanceof TFile
            ).length,
            sharedNotes: sharedNotes.length
          }
        : null;

    new MirrorDeleteDialog(this.app, this, file, folderInfo).open();
  }

  // 附件回收统一走系统回收站（Windows 回收站），不再使用插件自制垃圾桶。
  async trashToSystemTrash(abstractFile) {
    await this.app.vault.trash(abstractFile, true);
  }

  async executeManualDelete(file, options) {
    const { deleteAttachments, deleteDocument } = options || {};
    const basename = this.getNoteBasenameFromPath(file.path);
    const folderPath = this.getAttachmentFolderForBasename(basename);
    const attachmentRoot =
      this.cleanRoot(this.settings.attachmentsRoot) || "00_assets";
    // 修复 8.11：按不区分大小写解析真实目录。
    const folder = this.getAbstractFileByPathCI(folderPath);
    const isProtectedFolder =
      !(folder instanceof TFolder) ||
      this.samePath(folderPath, attachmentRoot) ||
      this.isRecyclePath(folderPath);

    // 修复 8.3：手动勾选删除必须和自动路径共用同一套“同名引用计数”，
    // 并且尊重“删除文章时同步回收附件”这个全局开关。
    const peers = this.getNotesByBasename(basename, file.path);
    const attachmentsEnabled = this.settings.deleteAttachmentsWithNote !== false;
    let wantAttachments = !!deleteAttachments && !isProtectedFolder;

    if (wantAttachments && !attachmentsEnabled) {
      wantAttachments = false;
      new Notice(
        "xyblue135 私人·附件镜像：设置里已关闭“删除文章时同步回收附件”，本次只删除文档，附件保持不动。",
        8000
      );
    }

    if (wantAttachments && peers.length) {
      wantAttachments = false;
      const preview = peers.slice(0, 3).map((peer) => peer.path).join("\n");
      const more = peers.length > 3 ? `\n另有 ${peers.length - 3} 篇` : "";
      new Notice(
        `xyblue135 私人·附件镜像：仍有 ${peers.length} 篇同名笔记共享该附件目录，已跳过附件回收。\n${folderPath}\n${preview}${more}`,
        9000
      );
    }

    if (wantAttachments) {
      // 修复 8.9：同名笔记之外还有别的笔记引用该目录时同样不回收
      //（链接解析 + 正文纯文本扫描，命中任一即跳过）。
      const referencing = await this.collectFolderReferences(folder, file.path);
      if (referencing.length) {
        wantAttachments = false;
        const preview = referencing.slice(0, 3).join("\n");
        const more = referencing.length > 3 ? `\n另有 ${referencing.length - 3} 篇` : "";
        new Notice(
          `xyblue135 私人·附件镜像：仍有 ${referencing.length} 篇笔记引用该附件目录，已跳过附件回收。\n${folderPath}\n${preview}${more}`,
          9000
        );
      }
    }

    // 1) 附件：移入系统回收站。
    if (wantAttachments) {
      try {
        await this.trashToSystemTrash(folder);
        new Notice(
          `xyblue135 私人·附件镜像：附件目录已移入系统回收站\n${folderPath}`,
          6000
        );
        // 修复 8.17：附件目录被回收后，顺手清理因此变空的上级附件目录。
        await this.cleanupEmptyAttachmentParents(this.parentPath(folderPath));
      } catch (err) {
        console.error(
          "[xyblue135 私人·附件镜像] manual delete attachments failed:",
          err
        );
        new Notice(
          "xyblue135 私人·附件镜像：删除附件失败，请查看控制台。",
          7000
        );
      }
    }

    // 2) 文档：移入系统回收站。把路径加入守卫集合，delete 事件（可能异步
    //    触发）命中后跳过自动回收，保证“只勾选删除文档”时附件不被回收。
    if (deleteDocument) {
      const guardPath = file.path;
      this.manualDeleteGuard.add(guardPath);
      // 修复 8.8：守卫是“一次性 token + 超时自清”。
      // 若 delete 事件没命中（删除期间被同步/重命名，或文件已被外部删掉），
      // 守卫会在 5 秒后自动过期，不会永久残留并误跳过日后同名文档的回收。
      setTimeout(() => {
        this.manualDeleteGuard.delete(guardPath);
      }, 5000);
      try {
        if (
          this.app.fileManager &&
          typeof this.app.fileManager.trashFile === "function"
        ) {
          await this.app.fileManager.trashFile(file);
        } else {
          await this.app.vault.trash(file, false);
        }
        new Notice(
          `xyblue135 私人·附件镜像：已删除文档\n${file.path}`,
          5000
        );
      } catch (err) {
        this.manualDeleteGuard.delete(file.path);
        console.error(
          "[xyblue135 私人·附件镜像] manual delete document failed:",
          err
        );
        new Notice(
          "xyblue135 私人·附件镜像：删除文档失败，请查看控制台。",
          7000
        );
      }
    }
  }

  async syncAttachmentFolderAfterRename(newNotePath, oldPath) {
    const oldManaged = this.isManagedNotePath(oldPath);
    const newManaged = this.isManagedNotePath(newNotePath);
    if (!oldManaged && !newManaged) return;

    const oldBasename = this.getNoteBasenameFromPath(oldPath);
    const newBasename = this.getNoteBasenameFromPath(newNotePath);
    const oldFolder = this.getAttachmentFolderForBasename(oldBasename);
    const newFolder = this.getAttachmentFolderForBasename(newBasename);

    // 从管理范围外移入：加入当前文件名对应的共享附件组。
    if (!oldManaged && newManaged) {
      const note = this.app.vault.getAbstractFileByPath(newNotePath);
      if (note instanceof TFile) await this.ensureSharedAttachmentFolderForNote(note, { notifyDuplicate: true });
      return;
    }

    // 从管理范围移出：附件绝不删除。根目录误改名也只会走到这里。
    if (oldManaged && !newManaged) {
      new Notice(
        `xyblue135 私人·附件镜像：文章移出管理根目录，附件保持不动\n${oldPath}\n→ ${newNotePath}\n${oldFolder}`,
        7000
      );
      return;
    }

    // 仅移动父目录时 basename 不变，所以单层附件结构完全无需处理。
    // 修复 8.11：仅大小写不同的改名（Test.md → test.md）在 Windows 上是同一个
    // 物理目录，同样视为“basename 未变”，不再误判为“新文件名已有附件目录”。
    if (String(oldBasename || "").toLowerCase() === String(newBasename || "").toLowerCase()) {
      return;
    }

    const oldRemaining = this.getNotesByBasename(oldBasename, oldPath);
    const newPeers = this.getNotesByBasename(newBasename, newNotePath);
    // 修复 8.11：附件目录一律按不区分大小写解析，避免大小写差异导致查不到。
    const oldAbstract = this.getAbstractFileByPathCI(oldFolder);
    const newAbstract = this.getAbstractFileByPathCI(newFolder);

    // 修复 8.18：新附件路径被普通文件占用时，下面三个分支原本全部落空、静默返回。
    if (newAbstract && !(newAbstract instanceof TFolder)) {
      new Notice(
        `xyblue135 私人·附件镜像：新附件路径存在同名文件，无法建立目录：${newFolder}\n旧目录保留：${oldFolder}`,
        9000
      );
      return;
    }

    // 旧名字仍被其他笔记引用：旧共享目录必须留下。新名字建立/加入另一共享目录。
    if (oldRemaining.length > 0) {
      if (!(newAbstract instanceof TFolder)) await this.ensureFolder(newFolder);

      new Notice(
        `xyblue135 私人·附件镜像：笔记已改名，但「${oldBasename}」仍有 ${oldRemaining.length} 篇笔记共享旧附件，因此不搬动旧目录。\n新笔记今后使用：${newFolder}` +
          (newPeers.length ? `\n「${newBasename}」已有 ${newPeers.length} 篇同名笔记，将共享新目录。` : "") +
          `\n原正文中的旧附件链接保持有效。`,
        9000
      );
      return;
    }

    // 旧名字已经没有其他引用。如果新目录不存在，可以安全把整目录随“文件名”迁移。
    if (oldAbstract instanceof TFolder && !newAbstract) {
      await this.ensureFolder(this.parentPath(newFolder));
      if (this.app.fileManager && typeof this.app.fileManager.renameFile === "function") {
        await this.app.fileManager.renameFile(oldAbstract, newFolder);
      } else {
        await this.app.vault.rename(oldAbstract, newFolder);
      }
      new Notice(`xyblue135 私人·附件镜像：附件目录已随笔记文件名更新\n${oldFolder}\n→ ${newFolder}`, 6000);
      return;
    }

    // 新名字已经有共享目录时不做自动合并。保留旧目录，避免误覆盖或打乱旧链接。
    if (newAbstract instanceof TFolder) {
      new Notice(
        `xyblue135 私人·附件镜像：新文件名「${newBasename}」已有附件目录，将加入共享。\n为避免自动合并造成数据损失，旧目录保留：${oldFolder}\n今后新附件保存到：${newFolder}`,
        9000
      );
      return;
    }

    // 原来没有附件目录时，只需为新名字补建。
    if (!(oldAbstract instanceof TFolder)) {
      await this.ensureFolder(newFolder);
    }
  }

};

class MirrorAttachmentsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mirror-attachments-settings");

    const hero = containerEl.createDiv({
      cls: "mirror-attachments-hero"
    });
    const heroTop = hero.createDiv({
      cls: "mirror-attachments-hero-top"
    });
    const heroText = heroTop.createDiv({
      cls: "mirror-attachments-hero-text"
    });
    heroText.createEl("h2", {
      text: "xyblue135 私人 · 附件镜像"
    });
    heroText.createEl("p", {
      text:
        "使用单层附件结构：不同目录下的同名 Markdown 共享同一个附件文件夹，并通过实时引用计数保护共享附件。"
    });
    heroTop.createEl("span", {
      cls: "mirror-attachments-version-badge",
      text: "v2.0.2"
    });

    const badges = hero.createDiv({
      cls: "mirror-attachments-badges"
    });
    ["单层结构", "同名共享", "引用计数"].forEach((label) => {
      badges.createEl("span", {
        cls: "mirror-attachments-badge",
        text: label
      });
    });

    this.createSectionTitle(
      containerEl,
      "1. 存储结构",
      "附件不再镜像 00_docs 父目录，只按 Markdown 文件名建立一层文件夹；同名笔记主动共享。"
    );

    new Setting(containerEl)
      .setName("笔记根目录")
      .setDesc("被插件管理的 Markdown 根目录，例如 00_docs。输入完成后（失焦或停顿）才会保存并校验。")
      .addText((text) => {
        text.setPlaceholder("00_docs").setValue(this.plugin.settings.notesRoot);
        this.bindRootTextInput(text, "notesRoot", "笔记根目录");
      });

    new Setting(containerEl)
      .setName("附件根目录")
      .setDesc("单层共享附件根目录，建议使用 00_assets。输入完成后（失焦或停顿）才会保存并校验。")
      .addText((text) => {
        text.setPlaceholder("00_assets").setValue(this.plugin.settings.attachmentsRoot);
        this.bindRootTextInput(text, "attachmentsRoot", "附件根目录");
      });

    const structureCard = containerEl.createDiv({
      cls: "mirror-attachments-info-card"
    });
    structureCard.createEl("div", {
      cls: "mirror-attachments-info-title",
      text: "单层共享映射规则"
    });
    structureCard.createEl("code", {
      text: "00_docs/A/test.md + 00_docs/B/test.md  ↔  00_assets/test/"
    });
    structureCard.createEl("p", {
      text:
        "父目录完全解耦；移动 00_docs 子目录不会搬附件。同名文件名视为同一个共享附件组。"
    });

    this.createSectionTitle(
      containerEl,
      "2. 导入行为",
      "控制系统文件复制粘贴与拖入。附件统一保存到当前 Markdown 文件名对应的共享目录。"
    );

    new Setting(containerEl)
      .setName("接管 Ctrl+V 附件")
      .setDesc(
        "检测到剪贴板中的系统文件时，阻止 Obsidian 默认处理并保存到当前文件名对应的共享附件目录。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.handlePaste)
          .onChange(async (value) => {
            this.plugin.settings.handlePaste = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("接管拖入附件")
      .setDesc(
        "接管从系统文件管理器拖入的图片、PDF、Office、ZIP、RAR、7Z 等文件。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.handleDrop)
          .onChange(async (value) => {
            this.plugin.settings.handleDrop = value;
            await this.plugin.saveSettings();
          })
      );

    const clipboardHint = containerEl.createDiv({
      cls: "mirror-attachments-tip"
    });
    clipboardHint.createEl("strong", { text: "Windows 文件粘贴兼容：" });
    clipboardHint.appendText(
      "同时读取 clipboardData.files 与 clipboardData.items，并自动去重，避免 ZIP 等文件复制后无法生成链接。"
    );

    this.createSectionTitle(
      containerEl,
      "3. 命名与 Markdown 规则",
      "先判断附件是否适合直接预览，再自动决定文件名和 Markdown 形式；无需手工选择。"
    );

    const ruleGrid = containerEl.createDiv({
      cls: "mirror-attachments-rule-grid"
    });

    this.createRuleCard(ruleGrid, {
      title: "嵌入式资源",
      tag: "时间戳 + ![]()",
      extensions: "PNG / JPG / JPEG / GIF / WebP / BMP / SVG / AVIF / PDF",
      example: "![](/00_assets/test/20260812151230001.png)",
      description: "图片和 PDF 使用毫秒级时间戳保存并直接嵌入正文，避免截图类文件名大量重复。",
      className: "is-embed"
    });

    this.createRuleCard(ruleGrid, {
      title: "非嵌入式附件",
      tag: "原文件名 + []()",
      extensions: "ZIP / RAR / 7Z / DOC / DOCX / XLS / XLSX / PPT / PPTX / 其他文件",
      example: "[项目源码.zip](/00_assets/test/项目源码.zip)",
      description: "压缩包、Office 等保留可读原名；重名自动变为 (1)、(2)…，正文显示完整文件名和扩展名。",
      className: "is-link"
    });

    const namingNote = containerEl.createDiv({
      cls: "mirror-attachments-tip mirror-attachments-tip-accent"
    });
    namingNote.createEl("strong", { text: "文件名安全处理：" });
    namingNote.appendText(
      "普通附件仅替换 Windows 非法字符（\\ / : * ? \" < > |）并处理保留设备名；中文、空格和括号会尽量原样保留。"
    );

    const multiPasteNote = containerEl.createDiv({
      cls: "mirror-attachments-tip"
    });
    multiPasteNote.createEl("strong", { text: "批量粘贴：" });
    multiPasteNote.appendText(
      "多个附件之间自动留一个空行；单个文件失败不会中断整批导入，并会给出单独提示。"
    );

    const linkNote = containerEl.createDiv({
      cls: "mirror-attachments-tip"
    });
    linkNote.createEl("strong", { text: "路径规则：" });
    linkNote.appendText(
      "所有链接均从 Vault 根目录开始，例如 /00_assets/test/...；移动 Markdown 父目录不会改变附件路径。"
    );

    this.createSectionTitle(
      containerEl,
      "4. 共享关系与重名检查",
      "检查每个文件名对应的共享附件目录，并列出所有同名 Markdown。孤立目录只报告，不自动删除。"
    );

    const auditActions = new Setting(containerEl)
      .setName("共享附件结构校验")
      .setDesc("重新扫描共享关系；自动操作只补建缺失目录，不会删除任何孤立目录。");

    const auditPanel = containerEl.createDiv({
      cls: "mirror-attachments-audit-panel"
    });

    auditActions.addButton((button) =>
      button
        .setButtonText("重新校验")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.refreshAuditPanel(auditPanel);
          } finally {
            button.setDisabled(false);
          }
        })
    );

    auditActions.addButton((button) =>
      button
        .setButtonText("补建缺失目录")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const audit = await this.plugin.auditFolderConsistency();
            const result = await this.plugin.repairFolderConsistency(audit);
            const conflictText = result.conflicts.length
              ? `，仍有 ${result.conflicts.length} 个冲突需手动处理`
              : "";

            new Notice(
              `xyblue135 私人·附件镜像：已补建 ${result.created} 个缺失目录；${result.preservedExtra} 个孤立目录仅报告、未删除${conflictText}`,
              7000
            );
            await this.refreshAuditPanel(auditPanel);
          } catch (err) {
            console.error("[xyblue135 私人·附件镜像] repair failed:", err);
            new Notice("xyblue135 私人·附件镜像：自动纠错失败，请查看控制台。");
          } finally {
            button.setDisabled(false);
          }
        })
    );

    void this.refreshAuditPanel(auditPanel);

    const duplicateActions = new Setting(containerEl)
      .setName("同名 Markdown 检查")
      .setDesc("列出不同目录下文件名完全相同的 Markdown；这些笔记会共享同一个附件目录。");

    const duplicatePanel = containerEl.createDiv({
      cls: "mirror-attachments-audit-panel"
    });

    duplicateActions.addButton((button) =>
      button
        .setButtonText("检查重名")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            this.refreshDuplicatePanel(duplicatePanel);
          } finally {
            button.setDisabled(false);
          }
        })
    );

    this.refreshDuplicatePanel(duplicatePanel);

    this.createSectionTitle(
      containerEl,
      "5. 删除保护",
      "删除时先检查同名 Markdown 引用数；只有最后一个引用消失时，才把共享附件目录移入系统回收站。"
    );

    new Setting(containerEl)
      .setName("删除文章时弹出勾选确认")
      .setDesc("开启后，在文件树右键删除或按 Delete 键删除 Markdown 时，会先弹出对话框，可分别勾选“删除附件”“删除文档”（默认全部勾选）；点取消则什么都不删除。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteDialogEnabled)
          .onChange(async (value) => {
            this.plugin.settings.deleteDialogEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("删除文章时同步回收附件")
      .setDesc("开启后，删除 Markdown 会实时统计同名笔记；仍有同名笔记时附件不动，最后一篇删除时才回收。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteAttachmentsWithNote)
          .onChange(async (value) => {
            this.plugin.settings.deleteAttachmentsWithNote = value;
            await this.plugin.saveSettings();
          })
      );

    // v2.1：空目录的产生源头。默认关闭，附件目录改为首次粘贴时才建。
    new Setting(containerEl)
      .setName("启动时为所有笔记预建附件目录")
      .setDesc(
        "默认关闭。开启后每次启动都会给 00_docs 里每一篇笔记建一个空附件目录，没有附件的笔记会留下大量空目录（本库实测占 45%）。" +
          "需要补齐时，用下方“结构校验 → 补建缺失目录”按需执行即可。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createFoldersForAllNotes === true)
          .onChange(async (value) => {
            this.plugin.settings.createFoldersForAllNotes = value;
            await this.plugin.saveSettings();
          })
      );

    this.createSectionTitle(
      containerEl,
      "6. 快捷操作",
      "减少手动查找附件目录的步骤。"
    );

    const shortcutCard = containerEl.createDiv({
      cls: "mirror-attachments-info-card mirror-attachments-shortcut-card"
    });
    shortcutCard.createEl("div", {
      cls: "mirror-attachments-info-title",
      text: "文件树右键"
    });
    shortcutCard.createEl("p", {
      text:
        "在左侧文件树右键任意受管理的 Markdown，选择“📂 打开对应附件目录”，即可定位到它按文件名共享的附件文件夹。"
    });
  }

  // 修复 8.10：文本输入不再每敲一个字符就写盘。
  // 只在失焦或停顿 1.2 秒后提交一次，并且先校验（空值/越界的中间态直接回滚）。
  bindRootTextInput(text, key, label) {
    let timer = null;

    // 修复 8.10：输入框仍有焦点时不落盘。用户把 00_docs 改成 01_docs 的过程中
    // 会经过 "0"、"00_" 之类的中间态，这些中间态一旦被写进 settings，
    // isManagedNotePath 就可能短暂接管/漏管一大片笔记。这里只在失焦/回车时提交。
    const stillTyping = () => {
      const el = text.inputEl;
      const doc = el && el.ownerDocument;
      return !!(doc && doc.activeElement && doc.activeElement === el);
    };

    const commit = async (force) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (!force && stillTyping()) return;

      const raw = typeof text.getValue === "function" ? text.getValue() : "";
      if (raw === this.plugin.settings[key]) return;

      const check = this.plugin.validateRootSetting(key, raw);
      if (!check.ok) {
        new Notice(
          `xyblue135 私人·附件镜像：${label}“${raw}”无效（${check.reason}），已恢复为 ${this.plugin.settings[key]}。`,
          8000
        );
        text.setValue(this.plugin.settings[key]);
        return;
      }

      this.plugin.settings[key] = check.value;
      if (check.value !== raw) text.setValue(check.value);
      await this.plugin.saveSettings();
    };

    text.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void commit(false);
      }, 1200);
    });

    if (text.inputEl && typeof text.inputEl.addEventListener === "function") {
      text.inputEl.addEventListener("blur", () => {
        void commit(true);
      });
    }
  }

  createSectionTitle(containerEl, title, description) {
    const section = containerEl.createDiv({
      cls: "mirror-attachments-section-heading"
    });
    section.createEl("h3", { text: title });
    if (description) {
      section.createEl("p", { text: description });
    }
  }

  createRuleCard(containerEl, options) {
    const card = containerEl.createDiv({
      cls: `mirror-attachments-rule-card ${options.className || ""}`.trim()
    });
    const top = card.createDiv({
      cls: "mirror-attachments-rule-card-top"
    });
    top.createEl("strong", { text: options.title });
    top.createEl("span", {
      cls: "mirror-attachments-rule-tag",
      text: options.tag
    });
    card.createEl("div", {
      cls: "mirror-attachments-rule-exts",
      text: options.extensions
    });
    card.createEl("p", {
      text: options.description
    });
    card.createEl("code", {
      text: options.example
    });
  }

  refreshDuplicatePanel(panelEl) {
    panelEl.empty();
    const groups = this.plugin.getDuplicateNoteGroups();

    if (!groups.length) {
      panelEl.createEl("div", {
        cls: "mirror-attachments-audit-summary is-ok",
        text: "没有发现同名 Markdown。"
      });
      return;
    }

    panelEl.createEl("div", {
      cls: "mirror-attachments-audit-summary is-warning",
      text: `发现 ${groups.length} 组同名 Markdown。它们会按文件名共享附件目录。`
    });

    // v2.1：同名组可能已经共用了同一批附件，这里给一个入口看归属。
    const buttonRow = panelEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttonRow)
      .setButtonText("查看附件归属")
      .onClick(() => {
        void this.plugin.showDuplicateReport();
      });

    for (const group of groups) {
      const box = panelEl.createDiv({ cls: "mirror-attachments-audit-group is-conflict" });
      box.createEl("div", {
        cls: "mirror-attachments-audit-group-title",
        // 修复 8.11：仅大小写不同的组单独标注，提示它们共用同一物理目录。
        text: `${group.basename} · ${group.count} 篇 · 共享 ${group.folderPath}` +
          (group.caseConflict ? "（含仅大小写不同的文件名，Windows 上共用同一目录）" : "")
      });
      const list = box.createEl("ul");
      for (const path of group.notePaths) list.createEl("li", { text: path });
    }
  }

  async refreshAuditPanel(panelEl) {
    panelEl.empty();
    panelEl.createEl("div", {
      cls: "mirror-attachments-audit-loading",
      text: "正在校验……"
    });

    let audit;
    try {
      audit = await this.plugin.auditFolderConsistency();
    } catch (err) {
      console.error("[xyblue135 私人·附件镜像] audit failed:", err);
      panelEl.empty();
      panelEl.createEl("div", {
        cls: "mirror-attachments-audit-summary is-error",
        text: "校验失败，请查看开发者控制台。"
      });
      return;
    }

    panelEl.empty();

    if (!audit.supported) {
      panelEl.createEl("div", {
        cls: "mirror-attachments-audit-summary is-warning",
        text: "当前目录模式不支持一对一校验。"
      });
      return;
    }

    // v2.1：附件目录已改为「首次粘贴时按需创建」，
    // 所以“这篇笔记还没有附件目录”是正常状态，不再计入需关注项（否则一开面板就是几百条）。
    const issueCount = audit.extra.length + audit.conflicts.length;
    const missingNote = audit.missing.length
      ? `另有 ${audit.missing.length} 篇笔记尚未建附件目录（按需创建，属正常）。`
      : "";

    panelEl.createEl("div", {
      cls: "mirror-attachments-audit-summary " + (issueCount ? "is-warning" : "is-ok"),
      text: issueCount
        ? `发现 ${issueCount} 项需关注：孤立目录 ${audit.extra.length}，路径冲突 ${audit.conflicts.length}。当前 ${audit.notesCount} 篇 Markdown 对应 ${audit.expectedCount} 个共享附件目录。${missingNote}`
        : `校验正常：${audit.notesCount} 篇 Markdown 对应 ${audit.expectedCount} 个共享附件目录；其中 ${audit.duplicateGroups.length} 组为同名共享。${missingNote}`
    });

    if (audit.extra.length) {
      this.renderAuditGroup(
        panelEl,
        "孤立目录（仅报告，不自动删除）",
        audit.extra.map((item) => item.folderPath),
        "is-extra"
      );
    }

    if (audit.conflicts.length) {
      this.renderAuditGroup(
        panelEl,
        "路径冲突（需手动处理）",
        audit.conflicts.map(
          (item) => `${item.folderPath} — ${item.reason}`
        ),
        "is-conflict"
      );
    }
  }

  renderAuditGroup(panelEl, title, items, className) {
    const group = panelEl.createDiv({
      cls: `mirror-attachments-audit-group ${className}`
    });
    group.createEl("div", {
      cls: "mirror-attachments-audit-group-title",
      text: `${title}（${items.length}）`
    });

    const list = group.createEl("ul");
    for (const item of items) {
      list.createEl("li", { text: item });
    }
  }
}
