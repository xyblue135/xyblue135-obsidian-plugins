/* 离线全量重建检索索引 —— 给 agent / 命令行用，不用打开 Obsidian 点按钮。
 *
 *   node tools/rebuild-index.js            # 真重建并写盘
 *   node tools/rebuild-index.js --dry      # 只统计，不写盘
 *
 * 走的还是插件自己的 reconcile() + saveNow()，产物与「在 Obsidian 里点重建索引」同构：
 * index.json 的 version / whitelist / sections / hash 全部由插件代码算出，脚本只负责
 * ① 提供真实文件列表 ② 提供真实文件内容 ③ 模拟「元数据缓存已就绪」。
 *
 * 为什么必须模拟元数据缓存：parseDoc 在拿不到 frontmatter 时会打 fmFallback 标记，
 * 那个标记会让 Obsidian 下次启动把所有文档重新解析一遍（慢，且白跑）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPlugin, fakeApp, VAULT, PLUGIN_DIR } = require('./offline-harness.js');

const DRY = process.argv.includes('--dry');
const INDEX_FILE = path.join(PLUGIN_DIR, 'index.json');
const abs = (p) => path.join(VAULT, p);

/** 收集 vault 内所有 .md（跳过隐藏目录、.trash、.obsidian） */
function walk(dir, out) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) { walk(full, out); continue; }
    if (item.name.toLowerCase().endsWith('.md')) out.push(path.relative(VAULT, full).replace(/\\/g, '/'));
  }
  return out;
}

(async () => {
  const t0 = Date.now();
  const plugin = await loadPlugin();
  const idx = plugin.index;
  const internal = require(path.join(PLUGIN_DIR, 'main.js')).__internal || {};
  const parseFm = internal.parseFrontmatterFallback;
  if (typeof parseFm !== 'function') throw new Error('插件没有导出 parseFrontmatterFallback，无法模拟元数据缓存');

  const all = walk(VAULT, []).sort();
  const files = all.map((p) => ({ path: p, extension: 'md', basename: path.basename(p, '.md') }));

  /* 把 mock 换成真实文件系统 */
  fakeApp.vault.getMarkdownFiles = () => files;
  fakeApp.vault.getFiles = () => files;
  fakeApp.vault.cachedRead = async (f) => fs.readFileSync(abs(f.path), 'utf8');
  fakeApp.vault.read = fakeApp.vault.cachedRead;
  fakeApp.metadataCache.getFileCache = (f) => {
    const content = fs.readFileSync(abs(f.path), 'utf8');
    const fb = parseFm(content);
    if (!fb || !fb.fm) return null;
    return { frontmatter: fb.fm, frontmatterPosition: { end: { line: Math.max(0, fb.bodyStart - 1) } } };
  };
  fakeApp.vault.adapter.write = async (p, data) => { if (!DRY) fs.writeFileSync(abs(p), data); };
  fakeApp.vault.adapter.rename = async (from, to) => { if (!DRY) fs.renameSync(abs(from), abs(to)); };
  fakeApp.vault.adapter.remove = async (p) => { if (!DRY) { try { fs.unlinkSync(abs(p)); } catch (e) { /* 临时文件已不存在 */ } } };
  fakeApp.vault.adapter.exists = async (p) => fs.existsSync(abs(p));

  /* onload 里的 autoIndexOnStartup 已经起过一次 reconcile（此时拿到的是空文件列表），
     它留下的 _busy/_pending 会让我们的 reconcile 直接复用那个空结果。先复位。 */
  idx._busy = false;
  idx._pending = null;
  idx.docs.clear();

  const r = await idx.reconcile();
  if (!DRY) await idx.saveNow();

  const docs = [...idx.docs.values()];
  const noSec = docs.filter((d) => !(d.sections || []).length).length;
  const noStrong = docs.filter((d) => !String(d.strongText || '').trim()).length;
  const bodyChars = docs.reduce((n, d) => n + (d.sections || []).reduce((m, s) => m + String(s.t || '').length, 0), 0);

  console.log('vault 内 .md 总数      :', all.length);
  console.log('白名单内（进索引）      :', r.total);
  console.log('  ├ 新增 / 更新        :', r.added, '/', r.updated);
  console.log('  ├ 正文为空（纯元数据）:', noSec, '← 这些笔记只有 frontmatter，靠摘要文本检索');
  console.log('  └ strongText 为空的   :', noStrong, noStrong ? '⚠ 这些笔记搜不到' : '');
  console.log('正文总字数             :', bodyChars.toLocaleString());
  console.log('耗时                   :', ((Date.now() - t0) / 1000).toFixed(1), 's');

  if (DRY) { console.log('\n--dry：未写盘'); process.exit(0); }

  /* 落盘回读校验：结构对不对、能不能 load、有没有埋 fmFallback 雷 */
  const written = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const fmFallbackN = written.files.filter((f) => f.fmFallback === true).length;
  console.log('\nindex.json            :', (fs.statSync(INDEX_FILE).size / 1048576).toFixed(2), 'MB');
  console.log('  version / files     :', written.version, '/', written.files.length);
  console.log('  whitelist           :', written.whitelist);
  console.log('  fmFallback 标记     :', fmFallbackN, fmFallbackN ? '⚠ 下次启动会全量重解析' : '（无，正常）');

  idx.docs.clear();
  const ok = await idx.load();
  console.log('  重新 load()         :', ok ? 'OK' : '失败', 'docs =', idx.docs.size);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); process.exit(1); });
