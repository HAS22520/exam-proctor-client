import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UploadContent } from '../app/renderer/pages/UploadPage';
import { DialogContent } from '../app/renderer/pages/DialogPage';
import { panelView } from '../app/renderer/lib/panel-view';
import { activityTiming } from '../app/renderer/lib/status-view';
import { applicationRoot, projectRoot } from '../scripts/project-layout';

// 静态 React 渲染与状态逻辑回归；不启动浏览器或进行 UI 验收。
test('React upload page requires the receipt before enabling exit, distinguishes offline retention and escapes messages', () => {
  const render = (status) => renderToStaticMarkup(createElement(UploadContent, { status, onExit: () => {} }));
  assert.match(render({ upload: { phase: 'verifying', percent: 100 }, exitReady: false }), /disabled=""/);
  assert.match(render({ upload: { phase: 'verifying', percent: 100 } }), /服务端确认后/);
  assert.doesNotMatch(render({ upload: { phase: 'complete', percent: 100 }, exitReady: true }), /disabled=""/);
  assert.match(render({ upload: { phase: 'deferred' }, exitReady: true }), /稍后补传/);
  assert.match(render({ message: '<script>alert(1)</script>' }), /&lt;script&gt;/);
});

test('React prompts retain explicit defaults and all exit choices; update blockers stay visible rather than looking busy', () => {
  const html = renderToStaticMarkup(createElement(DialogContent, { busy: false, onRespond: () => {}, model: {
    title: '退出', message: '如何退出？', buttons: ['继续考试', '保留日志退出', '上传日志并结束监考'], defaultId: 0, cancelId: 0,
  } }));
  for (const label of ['继续考试', '保留日志退出', '上传日志并结束监考']) assert.match(html, new RegExp(label));
  const view = panelView({ update: { phase: 'available', enabled: true, canHotUpdate: true, blocked: true, blockedReason: '未上传 1 份日志', version: '1.0.1', buildVersion: '2026101301', source: 'asar' } });
  assert.equal(view.busy, false); assert.equal(view.installBlocked, true);
  assert.match(view.warning, /未上传/); assert.match(view.version, /1\.0\.1.*2026101301.*ASAR/);
  assert.match(activityTiming({ busy: true, kind: 'network', stage: 'restore', label: '恢复', estimatedMinMs: 1000, estimatedMaxMs: 3000 }, 5000), /已等待 5 秒.*超出参考/);
});

test('bundled React and sandbox bridges are complete; installer has directory selection, manual finish and persistent data', () => {
  const output = applicationRoot();
  for (const page of ['upload', 'waiting', 'console', 'dialog']) {
    const html = fs.readFileSync(path.join(output, `app/renderer/${page}.html`), 'utf8');
    assert.match(html, new RegExp(`entries/${page}.js`));
    const bundle = fs.readFileSync(path.join(output, `app/renderer/entries/${page}.js`), 'utf8');
    assert.doesNotMatch(bundle, /require\(["'](?:react|react-dom|node:)/);
  }
  const preload = fs.readFileSync(path.join(output, 'app/preload/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /require\(["'](?:react|react-dom|\.\/|\.\.\/)/);
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).build;
  assert.equal(config.nsis.oneClick, false); assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.runAfterFinish, false); assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  assert.match(fs.readFileSync(path.join(projectRoot, 'config/installer.nsh'), 'utf8'), /以管理员身份运行/);
  const ico = fs.readFileSync(path.join(output, 'icons/icon.ico')), icns = fs.readFileSync(path.join(output, 'icons/icon.icns'));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  assert.equal(icns.subarray(0, 4).toString(), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
});
