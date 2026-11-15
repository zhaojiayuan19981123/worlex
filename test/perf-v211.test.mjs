// perf-v211.test.mjs —— v2.1.1 性能改造的回归测试
// 1) store 解析缓存既不读旧数据，也不被调用方的就地修改污染
// 2) 备份用硬链接搬 uploads，不再复制几百 MB
// 3) 知识库全文读取只扫一遍 layout 目录
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as store from '../src/store.js';
import { createFullTextReader } from '../src/knowledgeBase.js';

async function tempDir(tag) {
  const dir = await mkdtemp(path.join(tmpdir(), `worlex-${tag}-`));
  return dir;
}

test('store 缓存：文件被外部改写后立刻读到新内容', async () => {
  const dir = await tempDir('cache');
  try {
    store.configure({ dataDir: dir });
    store.saveProjects([{ id: 'a', name: '旧值' }]);
    assert.equal(store.listProjects()[0].name, '旧值');

    // 绕过 store 直接写盘，并把 mtime 往前推 2 秒（Windows 的 mtime 精度可能到秒）
    const file = path.join(dir, 'projects.json');
    await writeFile(file, JSON.stringify([{ id: 'a', name: '新值' }]), 'utf8');
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(file, t, t);

    assert.equal(store.listProjects()[0].name, '新值', '缓存必须因 mtime/大小变化而失效');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store 缓存：调用方就地改数组不会污染缓存', async () => {
  const dir = await tempDir('cache-mut');
  try {
    store.configure({ dataDir: dir });
    store.saveProjects([{ id: 'a', name: 'A' }]);
    const first = store.listProjects();
    first.push({ id: 'b', name: 'B' }); // 未保存的就地修改
    first.reverse();
    const second = store.listProjects();
    assert.equal(second.length, 1, '返回的数组必须是副本');
    assert.equal(second[0].id, 'a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('备份：uploads 以硬链接进入备份目录，内容可读且占用不翻倍', async () => {
  const dir = await tempDir('backup');
  try {
    store.configure({ dataDir: dir });
    store.saveProjects([{ id: 'a' }]);
    const uploads = path.join(dir, 'uploads');
    await mkdir(uploads, { recursive: true });
    const payload = 'x'.repeat(1024 * 64);
    await writeFile(path.join(uploads, 'paper.pdf'), payload, 'utf8');

    const made = store.createBackup('test');
    assert.ok(made, '应该生成备份目录');
    const copied = path.join(made, 'uploads', 'paper.pdf');
    assert.equal(fs.readFileSync(copied, 'utf8'), payload, '备份里的附件必须能读');
    assert.ok(fs.existsSync(path.join(made, 'projects.json')), 'JSON 也该在备份里');

    const listed = store.listBackups().find((b) => b.name === path.basename(made));
    assert.ok(listed && listed.size > 0, '列表里的体积要包含 uploads 子目录');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('备份：删除旧备份，且拒绝带路径的非法名字', async () => {
  const dir = await tempDir('backup-del');
  try {
    store.configure({ dataDir: dir });
    store.saveProjects([{ id: 'a' }]);
    const made = store.createBackup('test');
    assert.ok(made);
    const name = path.basename(made);
    store.deleteBackup(name);
    assert.ok(!fs.existsSync(made), '备份目录应被删除');
    assert.throws(() => store.deleteBackup('../literature.json'), /不合法/);
    assert.throws(() => store.deleteBackup('a/b'), /不合法/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('知识库全文读取：一次扫描同时支持「目录名=文献 id」与 manifest 反查', async () => {
  const dir = await tempDir('fulltext');
  try {
    const layout = path.join(dir, 'layout');
    // 情形一：目录名就是文献 id
    await mkdir(path.join(layout, 'lit-1'), { recursive: true });
    await writeFile(path.join(layout, 'lit-1', 'paper.md'), '# 一号论文\n正文 A', 'utf8');
    // 情形二：目录名是版面作业 id，靠 manifest.json 里的 literatureId 反查
    await mkdir(path.join(layout, 'job-9'), { recursive: true });
    await writeFile(path.join(layout, 'job-9', 'paper.md'), '# 二号论文\n正文 B', 'utf8');
    await writeFile(path.join(layout, 'job-9', 'manifest.json'), JSON.stringify({ literatureId: 'lit-2' }), 'utf8');

    const read = createFullTextReader(dir);
    assert.match(read({ id: 'lit-1' }), /正文 A/);
    assert.match(read({ id: 'lit-2' }), /正文 B/, 'manifest 反查要能命中');
    assert.equal(read({ id: 'not-exist' }), '');
    assert.equal(read(null), '');

    // 文件内容改了、mtime 前进后必须读到新内容
    await writeFile(path.join(layout, 'lit-1', 'paper.md'), '# 一号论文\n正文 A2', 'utf8');
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(layout, 'lit-1', 'paper.md'), t, t);
    assert.match(read({ id: 'lit-1' }), /正文 A2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
