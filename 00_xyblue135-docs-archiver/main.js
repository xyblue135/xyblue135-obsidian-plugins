/*
 * xyblue135 私人 · 文档归档推荐
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：
 *   为 00_docs 下的笔记推荐归档目标文件夹。AI 推荐为主（本地网关 /chat/completions），
 *   本地打分兜底（frontmatter 的 AI_tags / AI_summary + 字符 bigram 相似度，只读 metadataCache，不读全文）。
 *   附件由「00_xyblue135-mirror」按文件名单层索引在 00_assets/<笔记文件名>/，且笔记内的
 *   引用是仓库根路径（![](00_assets/<笔记名>/xx.png)），因此跨文件夹移动笔记不需要迁移附件。
 *   移动只调用 fileManager.renameFile，不改文件名，全库链接由 Obsidian 自动更新。
 * v1.0.0：初版。命令 + 右键菜单 + 丝带入口；Modal 内支持模糊搜索手动兜底。
 * v1.0.3：AI 接口字段改名 aiBaseUrl/aiApiKey/aiModel → baseUrl/apiKey/model，
 *         与库内其它 AI 插件统一；加载时自动迁移旧 data.json。
 */

'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
	notesRoot: 'my_blog/00_docs',
	assetsRoot: 'my_blog/00_assets',
	aiEnabled: true,
	// 以下三个字段名与库内其它 AI 插件（ai-search / metadata-ai /
	// skill-miner）保持一致：baseUrl / apiKey / model。
	baseUrl: 'http://127.0.0.1:31415/v1',
	// 密钥不写进源码：真实值放在 data.json，这样拷贝/发布 main.js 不会连带泄露 key。
	apiKey: '',
	model: 'auto',
	requestTimeoutSeconds: 90,
	maxSuggestions: 3,
	profileTagLimit: 6,
	profileTitleLimit: 2
};

/* ---------- 通用小工具 ---------- */

function normalizeTag(t) {
	return String(t == null ? '' : t).trim().toLowerCase();
}

function extractJson(content) {
	let raw = String(content == null ? '' : content);
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) raw = fence[1];
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error('AI 返回中没有 JSON');
	return JSON.parse(raw.slice(start, end + 1));
}

function withTimeout(promise, seconds) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('AI 请求超时（' + seconds + 's）')), Math.max(1, seconds) * 1000);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* 中文字符 bigram + ASCII 整词，做 Dice 相似度，无需分词器 */
function charBigrams(s) {
	const set = new Set();
	const tokens = String(s == null ? '' : s).split(/[\s\p{P}\p{S}]+/u);
	for (const t of tokens) {
		const lower = t.toLowerCase();
		if (!lower) continue;
		set.add(lower);
		for (let i = 0; i < lower.length - 1; i++) set.add(lower.slice(i, i + 2));
	}
	return set;
}

function dice(a, b) {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return (2 * inter) / (a.size + b.size);
}

/* ---------- 插件主体 ---------- */

class DocsArchiverPlugin extends obsidian.Plugin {
	async onload() {
		const raw = (await this.loadData()) || {};
		// 兼容旧字段名：aiBaseUrl / aiApiKey / aiModel → baseUrl / apiKey / model
		// （1.0.3 之前写下的 data.json 里是 ai* 系列，迁移后立刻回写，避免两套键并存）
		let migrated = false;
		for (const [oldKey, newKey] of [
			['aiBaseUrl', 'baseUrl'],
			['aiApiKey', 'apiKey'],
			['aiModel', 'model']
		]) {
			if (Object.prototype.hasOwnProperty.call(raw, oldKey)) {
				if (raw[newKey] === undefined || raw[newKey] === '') raw[newKey] = raw[oldKey];
				delete raw[oldKey];
				migrated = true;
			}
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (migrated) await this.saveData(this.settings);

		this.addCommand({
			id: 'archive-current-note',
			name: '归档当前笔记（推荐目标文件夹）',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md' || !this.isUnderNotesRoot(file.path)) return false;
				if (!checking) this.openArchiver(file);
				return true;
			}
		});

		this.addRibbonIcon('archive', '归档当前笔记', () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md' || !this.isUnderNotesRoot(file.path)) {
				new obsidian.Notice('当前打开的不是 ' + this.settings.notesRoot + ' 下的笔记');
				return;
			}
			this.openArchiver(file);
		});
    // 品牌分组标记（见 snippets/xyblue135-brand.css）
    const __brandEl = document.querySelector('.side-dock-ribbon-action[aria-label="' + '归档当前笔记' + '"]');
    if (__brandEl) __brandEl.addClass('xyblue135-ribbon', 'xyblue135-ai');

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof obsidian.TFile && file.extension === 'md' && this.isUnderNotesRoot(file.path)) {
					menu.addItem((item) =>
						item
							.setTitle('归档到推荐文件夹')
							.setIcon('archive')
							.onClick(() => this.openArchiver(file))
					);
				}
			})
		);

		this.addSettingTab(new DocsArchiverSettingTab(this.app, this));
	}

	onunload() {}

	isUnderNotesRoot(path) {
		const root = (this.settings.notesRoot || '').replace(/\/+$/, '');
		if (!root) return false;
		return path === root || path.startsWith(root + '/');
	}

	/* 构建候选文件夹画像：只读 metadataCache，757 篇毫秒级 */
	buildFolderIndex() {
		const rootPath = (this.settings.notesRoot || '').replace(/\/+$/, '');
		const root = this.app.vault.getAbstractFileByPath(rootPath);
		const folders = [];
		const byPath = new Map();
		if (!(root instanceof obsidian.TFolder)) return { folders, byPath };

		const walk = (folder) => {
			for (const child of folder.children) {
				if (child instanceof obsidian.TFolder && !child.name.startsWith('.')) {
					const entry = { path: child.path, name: child.name, titles: [], tagFreq: new Map(), topTags: [], noteCount: 0 };
					folders.push(entry);
					byPath.set(child.path, entry);
					walk(child);
				}
			}
		};
		walk(root);

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(rootPath + '/')) continue;
			const dirPath = file.parent ? file.parent.path : '';
			const entry = byPath.get(dirPath);
			if (!entry) continue; // 直接位于 00_docs 根的暂存笔记不计入画像
			entry.noteCount++;
			if (entry.titles.length < 40) entry.titles.push(file.basename);
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache ? cache.frontmatter : null;
			if (!fm) continue;
			const tags = Array.isArray(fm.AI_tags) ? fm.AI_tags : typeof fm.AI_tags === 'string' ? [fm.AI_tags] : [];
			for (const t of tags) {
				const k = normalizeTag(t);
				if (!k) continue;
				entry.tagFreq.set(k, (entry.tagFreq.get(k) || 0) + 1);
			}
		}

		for (const entry of folders) {
			entry.topTags = Array.from(entry.tagFreq.entries())
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map((e) => e[0]);
		}
		return { folders, byPath };
	}

	/* 本地打分：标签命中 + 路径命中 + bigram 相似度，满分约 100 */
	localSuggestions(file, index, limit) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = (cache && cache.frontmatter) || {};
		const noteTags = (Array.isArray(fm.AI_tags) ? fm.AI_tags : []).map(normalizeTag).filter(Boolean);
		const queryText = file.basename + ' ' + noteTags.join(' ') + ' ' + String(fm.AI_summary_short || '').slice(0, 120);
		const queryGrams = charBigrams(queryText);
		const queryTagSet = new Set(noteTags);
		const currentDir = file.parent ? file.parent.path : '';

		const scored = [];
		for (const entry of index.folders) {
			if (entry.path === currentDir) continue; // 已在目标文件夹内的跳过
			const profileTagSet = new Set(entry.topTags || []);
			const tagHits = [];
			for (const t of queryTagSet) if (profileTagSet.has(t)) tagHits.push(t);
			const tagScore = queryTagSet.size ? (tagHits.length / queryTagSet.size) * 40 : 0;

			let pathScore = 0;
			for (const t of queryTagSet) if (entry.path.toLowerCase().includes(t)) pathScore += 12;
			pathScore = Math.min(pathScore, 30);

			const profileText = entry.path + ' ' + (entry.topTags || []).join(' ') + ' ' + entry.titles.slice(0, 10).join(' ');
			const sim = dice(queryGrams, charBigrams(profileText)) * 30;

			const score = tagScore + pathScore + sim;
			const reason = tagHits.length
				? '标签命中: ' + tagHits.slice(0, 3).join('、')
				: '标题/摘要相似度约 ' + Math.round((sim / 30) * 100) + '%';
			scored.push({ path: entry.path, score, reason, source: 'local' });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	/* AI 推荐：本地网关 /chat/completions，结构化 JSON 输出 */
	async aiSuggestions(file, index, limit) {
		if (!this.settings.aiEnabled) throw new Error('AI 推荐已在设置中关闭');
		if (!String(this.settings.apiKey || '').trim()) {
			throw new Error('未填写 API Key（设置 → 文档归档推荐 → AI 接口）');
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = (cache && cache.frontmatter) || {};
		const tags = (Array.isArray(fm.AI_tags) ? fm.AI_tags : []).join('、');
		const currentDir = file.parent ? file.parent.path : '';

		const lines = index.folders
			.filter((e) => e.path !== currentDir)
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((e) => {
				const t = e.topTags.slice(0, this.settings.profileTagLimit).join('、');
				const samples = e.titles.slice(0, this.settings.profileTitleLimit).join(' | ');
				let line = '- ' + e.path;
				if (t) line += ' ｜ 标签: ' + t;
				if (samples) line += ' ｜ 示例: ' + samples;
				return line;
			})
			.join('\n');

		const prompt = [
			'你是 Obsidian 笔记库的归档助手。根据笔记信息，从候选文件夹中选出最合适的归档位置。',
			'',
			'【笔记信息】',
			'标题: ' + file.basename,
			tags ? 'AI标签: ' + tags : '',
			fm.AI_summary_short ? '摘要: ' + String(fm.AI_summary_short).slice(0, 200) : '',
			'',
			'【候选文件夹】',
			lines,
			'',
			'【要求】',
			'1. 只能从候选列表中选择，禁止发明新路径。',
			'2. 最多推荐 ' + limit + ' 个，按匹配度从高到低排序。',
			'3. 每个给一句不超过 20 字的推荐理由。',
			'4. 只输出 JSON，不要输出任何解释或代码块标记，格式: {"suggestions":[{"path":"文件夹路径","reason":"理由"}]}'
		]
			.filter(Boolean)
			.join('\n');

		const url = this.settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
		const res = await obsidian.requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer ' + this.settings.apiKey
			},
			body: JSON.stringify({
				model: this.settings.model,
				temperature: 0,
				messages: [{ role: 'user', content: prompt }]
			}),
			throw: false
		});

		if (res.status !== 200) throw new Error('HTTP ' + res.status);
		const content =
			res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
				? res.json.choices[0].message.content
				: '';
		const parsed = extractJson(content);
		const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

		const out = [];
		const seen = new Set();
		for (const item of rawList) {
			if (out.length >= limit) break;
			const p = String((item && item.path) || '').replace(/\/+$/, '');
			if (!p || seen.has(p) || !index.byPath.has(p) || p === currentDir) continue;
			seen.add(p);
			out.push({
				path: p,
				reason: String((item && item.reason) || '').slice(0, 60) || 'AI 推荐',
				score: 100 - out.length,
				source: 'ai'
			});
		}
		if (!out.length) throw new Error('AI 未返回有效的候选路径');
		return out;
	}

	openArchiver(file) {
		const index = this.buildFolderIndex();
		if (!index.folders.length) {
			new obsidian.Notice('在 ' + this.settings.notesRoot + ' 下没有找到候选文件夹');
			return;
		}
		new ArchiverModal(this.app, this, file, index).open();
	}

	moveNote(file, folderPath) {
		const target = folderPath + '/' + file.name;
		if (this.app.vault.getAbstractFileByPath(target)) {
			new obsidian.Notice('目标已存在同名文件：' + target);
			return;
		}
		this.app.fileManager
			.renameFile(file, target)
			.then(() => {
				new obsidian.Notice(
					'已归档至 ' + folderPath + '（附件保留在 ' + this.settings.assetsRoot + '，无需迁移）',
					6000
				);
			})
			.catch((e) => {
				console.error('[docs-archiver] 移动失败', e);
				new obsidian.Notice('移动失败: ' + ((e && e.message) || e));
			});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* ---------- 归档弹窗 ---------- */

class ArchiverModal extends obsidian.Modal {
	constructor(app, plugin, file, index) {
		super(app);
		this.plugin = plugin;
		this.file = file;
		this.index = index;
		this.activeIdx = 0;
		this.closed = false;
		this.defaultItems = [];
		this.defaultLabel = '正在生成推荐…';
		this.displayed = [];
		this.displayLabel = '';
	}

	onOpen() {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.addClass('docs-archiver-modal');

		contentEl.createDiv({
			cls: 'docs-archiver-title',
			text: '归档《' + this.file.basename + '》'
		});
		contentEl.createDiv({
			cls: 'docs-archiver-sub',
			text: '附件按文件名存放在 ' + this.plugin.settings.assetsRoot + '/<笔记名>/，移动笔记无需迁移附件。'
		});

		const input = contentEl.createEl('input', {
			cls: 'docs-archiver-input',
			attr: { type: 'text', placeholder: '搜索文件夹路径，或等待推荐生成…' }
		});
		input.addEventListener('input', () => this.render(input.value));
		input.addEventListener('keydown', (e) => this.onKey(e));
		this.inputEl = input;

		this.listEl = contentEl.createDiv({ cls: 'docs-archiver-list' });
		contentEl.createDiv({ cls: 'docs-archiver-hint', text: '↑↓ 选择 · Enter 确认 · Esc 取消' });

		// 先出本地打分结果，保证 AI 不可用时也有内容
		const local = this.plugin.localSuggestions(this.file, this.index, this.plugin.settings.maxSuggestions);
		this.setDefault(local, '本地推荐');
		this.renderList();

		// 再异步拿 AI 推荐，成功则替换默认列表
		const limit = this.plugin.settings.maxSuggestions;
		withTimeout(this.plugin.aiSuggestions(this.file, this.index, limit), this.plugin.settings.requestTimeoutSeconds)
			.then((s) => {
				if (this.closed || this.hasFilter()) return;
				this.setDefault(s, 'AI 推荐');
				this.renderList();
			})
			.catch((e) => {
				console.warn('[docs-archiver] AI 不可用，使用本地推荐', e);
				if (this.closed || this.hasFilter()) return;
				this.setDefault(local, '本地推荐（AI 不可用: ' + String((e && e.message) || e).slice(0, 40) + '）');
				this.renderList();
			});

		setTimeout(() => input.focus(), 50);
	}

	onClose() {
		this.closed = true;
		this.contentEl.empty();
	}

	hasFilter() {
		return !!this.inputEl && this.inputEl.value.trim().length > 0;
	}

	setDefault(items, label) {
		this.defaultItems = items;
		this.defaultLabel = label;
		this.displayed = items;
		this.displayLabel = label;
		this.activeIdx = 0;
	}

	render(value) {
		const q = (value || '').trim().toLowerCase();
		if (!q) {
			this.displayed = this.defaultItems;
			this.displayLabel = this.defaultLabel;
		} else {
			const currentDir = this.file.parent ? this.file.parent.path : '';
			const matches = this.index.folders
				.filter((f) => f.path.toLowerCase().includes(q) && f.path !== currentDir)
				.slice(0, 20)
				.map((f) => ({ path: f.path, reason: f.noteCount + ' 篇笔记', score: 0, source: 'search' }));
			this.displayed = matches;
			this.displayLabel = '搜索结果';
		}
		this.activeIdx = 0;
		this.renderList();
	}

	renderList() {
		const listEl = this.listEl;
		if (!listEl) return;
		listEl.empty();
		listEl.createDiv({ cls: 'docs-archiver-label', text: this.displayLabel || this.defaultLabel });
		const items = this.displayed || [];
		if (!items.length) {
			listEl.createDiv({ cls: 'docs-archiver-empty', text: '没有匹配的文件夹' });
			return;
		}
		items.forEach((item, idx) => {
			const row = listEl.createDiv({ cls: 'docs-archiver-item' + (idx === this.activeIdx ? ' is-active' : '') });
			row.createDiv({ cls: 'docs-archiver-item-path', text: item.path });
			const meta = row.createDiv({ cls: 'docs-archiver-item-meta' });
			meta.createSpan({
				cls: 'docs-archiver-badge',
				text: item.source === 'ai' ? 'AI' : item.source === 'search' ? '搜索' : '本地'
			});
			meta.createSpan({ text: item.reason });
			row.addEventListener('click', () => this.choose(item));
			row.addEventListener('mouseenter', () => {
				this.activeIdx = idx;
				this.updateActive();
			});
		});
	}

	updateActive() {
		const rows = this.listEl ? Array.from(this.listEl.querySelectorAll('.docs-archiver-item')) : [];
		rows.forEach((row, idx) => row.toggleClass('is-active', idx === this.activeIdx));
	}

	onKey(e) {
		const items = this.displayed || [];
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (items.length) {
				this.activeIdx = (this.activeIdx + 1) % items.length;
				this.updateActive();
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (items.length) {
				this.activeIdx = (this.activeIdx - 1 + items.length) % items.length;
				this.updateActive();
			}
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = items[this.activeIdx];
			if (item) this.choose(item);
		}
	}

	choose(item) {
		this.close();
		this.plugin.moveNote(this.file, item.path);
	}
}

/* ---------- 设置页 ---------- */

class DocsArchiverSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'xyblue135 私人 · 文档归档推荐' });

		new obsidian.Setting(containerEl)
			.setName('笔记根目录')
			.setDesc('在此目录下提供归档推荐（默认 my_blog/00_docs）')
			.addText((t) =>
				t.setValue(this.plugin.settings.notesRoot).onChange(async (v) => {
					this.plugin.settings.notesRoot = v.trim() || 'my_blog/00_docs';
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('附件根目录')
			.setDesc('仅用于提示文案展示（默认 my_blog/00_assets，移动笔记时不会改动它）')
			.addText((t) =>
				t.setValue(this.plugin.settings.assetsRoot).onChange(async (v) => {
					this.plugin.settings.assetsRoot = v.trim() || 'my_blog/00_assets';
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('启用 AI 推荐')
			.setDesc('调用本地网关生成推荐；关闭或调用失败时自动降级为本地打分')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.aiEnabled).onChange(async (v) => {
					this.plugin.settings.aiEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('基础 URL')
			.setDesc('OpenAI 兼容接口，例如 http://127.0.0.1:31415/v1（自动拼接 /chat/completions）')
			.addText((t) =>
				t.setValue(this.plugin.settings.baseUrl).onChange(async (v) => {
					this.plugin.settings.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl;
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('API Key')
			.setDesc('本地网关的 key，字段名 apiKey（与库内其它 AI 插件一致）')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setValue(this.plugin.settings.apiKey).onChange(async (v) => {
					this.plugin.settings.apiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		new obsidian.Setting(containerEl)
			.setName('模型')
			.setDesc('网关侧的模型名（默认 auto）')
			.addText((t) =>
				t.setValue(this.plugin.settings.model).onChange(async (v) => {
					this.plugin.settings.model = v.trim() || 'auto';
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('AI 超时（秒）')
			.setDesc('超时后自动使用本地推荐（默认 90）')
			.addText((t) =>
				t.setValue(String(this.plugin.settings.requestTimeoutSeconds)).onChange(async (v) => {
					const n = parseInt(v, 10);
					this.plugin.settings.requestTimeoutSeconds = Number.isFinite(n) && n > 0 ? n : 90;
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('推荐数量')
			.setDesc('弹窗中展示的推荐条数（1~5，默认 3）')
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxSuggestions)).onChange(async (v) => {
					const n = parseInt(v, 10);
					this.plugin.settings.maxSuggestions = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('画像标签数')
			.setDesc('每个文件夹喂给 AI 的 top 标签个数（默认 6）')
			.addText((t) =>
				t.setValue(String(this.plugin.settings.profileTagLimit)).onChange(async (v) => {
					const n = parseInt(v, 10);
					this.plugin.settings.profileTagLimit = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 6;
					await this.plugin.saveSettings();
				})
			);

		new obsidian.Setting(containerEl)
			.setName('画像示例标题数')
			.setDesc('每个文件夹喂给 AI 的示例标题个数（默认 2）')
			.addText((t) =>
				t.setValue(String(this.plugin.settings.profileTitleLimit)).onChange(async (v) => {
					const n = parseInt(v, 10);
					this.plugin.settings.profileTitleLimit = Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 2;
					await this.plugin.saveSettings();
				})
			);
	}
}

module.exports = DocsArchiverPlugin;
