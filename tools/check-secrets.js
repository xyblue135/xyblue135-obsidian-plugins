#!/usr/bin/env node
/**
 * check-secrets.js —— 提交前扫一遍，别把密钥推进公开仓库。
 *
 * 用法（在 .obsidian 目录下）：
 *     node tools/check-secrets.js
 *     node tools/check-secrets.js --all      # 连未跟踪文件一起扫
 *
 * 退出码：0 干净 / 1 发现问题
 *
 * 只扫「会被 git 跟踪的文件」。data.json 已被 .gitignore 挡住，
 * 所以它里面的明文 key 不会报警 —— 这里要抓的是「不小心写进源码或 README」的情况。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INCLUDE_UNTRACKED = process.argv.includes('--all');

/** 已知凭证前缀 —— 命中即高危 */
const PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'OpenAI 风格 key'],
  [/\bfreellmapi-[A-Za-z0-9]{16,}/g, 'freellmapi key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'Google API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS Access Key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '私钥'],
];

/** 赋值式：key 字段后面跟着非空字符串（排除空串与明显的占位符） */
const ASSIGN = [
  [/"api_?key"\s*:\s*"([^"]{12,})"/gi, 'JSON 里的 apiKey'],
  [/aiApiKey\s*[:=]\s*["']([^"']{12,})["']/g, 'aiApiKey 赋值'],
  [/api_?key\s*[:=]\s*["']([^"']{12,})["']/gi, 'apiKey 赋值'],
];

const PLACEHOLDER = /^(your|xxx|test|demo|example|placeholder|changeme|<|\.\.\.|\*+)/i;

function trackedFiles() {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const files = out.split('\0').filter(Boolean);
  if (!INCLUDE_UNTRACKED) return files;
  // 追加未跟踪但未被忽略的文件
  const un = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(files.concat(un.split('\0').filter(Boolean)))];
}

const TEXT_EXT = /\.(js|mjs|cjs|ts|json|md|css|txt|yml|yaml|sh|ps1)$/i;
const hits = [];

for (const rel of trackedFiles()) {
  if (!TEXT_EXT.test(rel)) continue;
  const abs = path.join(ROOT, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 注释里讨论写法是正常的，跳过纯注释行
    const t = line.trim();
    const isComment = t.startsWith('//') || t.startsWith('#') || t.startsWith('*');

    for (const [re, label] of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) hits.push({ rel, line: i + 1, label, sample: m[0].slice(0, 12) + '…' });
    }
    if (isComment) return;
    for (const [re, label] of ASSIGN) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;
      const val = m[1];
      if (PLACEHOLDER.test(val)) continue;   // your-key-here / xxxxx / <填这里>
      if (/^\$\{.*\}$/.test(val)) continue;  // 模板占位
      hits.push({ rel, line: i + 1, label, sample: val.slice(0, 8) + '…(len ' + val.length + ')' });
    }
  });
}

if (!hits.length) {
  console.log('✅ 没发现密钥。' + (INCLUDE_UNTRACKED ? '（含未跟踪文件）' : ''));
  process.exit(0);
}

console.log('❌ 发现 ' + hits.length + ' 处疑似密钥：\n');
for (const h of hits) {
  console.log(`   ${h.rel}:${h.line}`);
  console.log(`      ${h.label}  ${h.sample}`);
}
console.log('\n处理方式：把值改成空串或占位符，真实值只放进 data.json（已被 .gitignore 挡住）。');
process.exit(1);
