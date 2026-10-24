import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogRetryControls } from '../app/renderer/components/LogRetryControls';
import { panelAccent, panelIconColor } from '../app/renderer/lib/panel-theme';
import { panelView } from '../app/renderer/lib/panel-view';
import { activityTiming } from '../app/renderer/lib/status-view';
import { DialogContent } from '../app/renderer/pages/DialogPage';
import { UploadContent } from '../app/renderer/pages/UploadPage';
import { applicationRoot, projectRoot } from '../scripts/project-layout';

// 静态 React 渲染与状态逻辑回归；不启动浏览器或进行 UI 验收。
test('监考状态球仅区分待认证、失败与成功，错误状态不能显示为成功', () => {
    assert.equal(panelView({}).state, 'pending');
    assert.equal(panelView({}).badge, '待认证');
    assert.equal(panelView({ authenticated: true }).state, 'success');
    assert.equal(panelView({ authenticated: true }).badge, '成功');
    for (const phase of ['authentication-error', 'network-error']) {
        const view = panelView({ phase, authenticated: true });
        assert.equal(view.state, 'failed');
        assert.equal(view.badge, '失败');
    }
    assert.equal(panelView({ ended: true, authenticated: false }).state, 'pending');
    assert.equal(panelView({ debug: true }).state, 'pending');
});

test('待认证颜色支持 OJ 的预设及自定义主题色，图标在深浅底色上均可辨认', () => {
    assert.equal(panelAccent('violet', false), '#7950f2');
    assert.equal(panelAccent('violet', true), '#b197fc');
    assert.equal(panelAccent('blue', false), '#228be6');
    assert.equal(panelAccent('rose', true), '#f06595');
    assert.equal(panelAccent('#12ABef', true), '#12ABef');
    assert.equal(panelAccent(null, false), '#3f879c');
    assert.equal(panelAccent('invalid', true), '#6bb3c7');
    assert.equal(panelIconColor('#ffffff'), '#142b3b');
    assert.equal(panelIconColor('#000000'), '#ffffff');
});

test('补传入口始终展示，按登录及忙碌状态禁用，展示逐份进度与未结束日志提醒', () => {
    const render = (status, pending = false) => renderToStaticMarkup(createElement(LogRetryControls, { status, pending, onRetry() {} }));
    assert.match(render({}), /disabled=""[^>]*title="请先登录原考试账号"[^>]*>补传日志/);
    assert.doesNotMatch(render({ loggedIn: true, pendingUploads: 0 }), /disabled=""/);
    const html = render({
        loggedIn: true,
        retrying: true,
        logRetry: { phase: 'uploading', total: 3, uploaded: 1, failed: 1, unreadable: 1, open: 2 },
        upload: { phase: 'uploading', tid: '1'.repeat(24), percent: 50, sent: 100, total: 200 },
    });
    assert.match(html, /disabled=""/);
    assert.match(html, /补传中…/);
    assert.match(html, /已上传 1\/3 份，失败 1 份/);
    assert.match(html, /50%（100 \/ 200 字节）/);
    assert.match(html, /<progress[^>]*value="50"/);
    assert.match(html, /另有 2 场监考尚未结束/);
    assert.match(html, /有 1 份日志状态无法读取/);
    assert.match(render({ loggedIn: true, logRetry: { phase: 'complete', total: 0 } }), /没有已结束且待补传的日志/);
});

test('React 上传页收到回执后才允许退出，区分离线保留并转义提示内容', () => {
    const render = (status) => renderToStaticMarkup(createElement(UploadContent, { status, onExit: () => {} }));
    assert.match(render({ upload: { phase: 'verifying', percent: 100 }, exitReady: false }), /disabled=""/);
    assert.match(render({ upload: { phase: 'verifying', percent: 100 } }), /服务端确认后/);
    assert.doesNotMatch(render({ upload: { phase: 'complete', percent: 100 }, exitReady: true }), /disabled=""/);
    assert.match(render({ upload: { phase: 'deferred' }, exitReady: true }), /稍后补传/);
    assert.match(render({ message: '<script>alert(1)</script>' }), /&lt;script&gt;/);
});

test('React 弹窗保留默认及全部退出操作，明确展示更新阻止原因', () => {
    const html = renderToStaticMarkup(
        createElement(DialogContent, {
            busy: false,
            onRespond: () => {},
            model: {
                title: '退出',
                message: '如何退出？',
                buttons: ['继续考试', '保留日志退出', '上传日志并结束监考'],
                defaultId: 0,
                cancelId: 0,
            },
        }),
    );
    for (const label of ['继续考试', '保留日志退出', '上传日志并结束监考']) assert.match(html, new RegExp(label));
    const view = panelView({
        update: {
            phase: 'available',
            enabled: true,
            canHotUpdate: true,
            blocked: true,
            blockedReason: '未上传 1 份日志',
            version: '1.0.1',
            buildVersion: '2026101301',
            source: 'asar',
        },
    });
    assert.equal(view.busy, false);
    assert.equal(view.installBlocked, true);
    assert.match(view.warning, /未上传/);
    assert.match(view.version, /1\.0\.1.*2026101301.*ASAR/);
    assert.match(
        activityTiming({ busy: true, kind: 'network', stage: 'restore', label: '恢复', estimatedMinMs: 1000, estimatedMaxMs: 3000 }, 5000),
        /已等待 5 秒.*超出参考/,
    );
});

test('结束弹窗将继续和上传设为同级操作，不上传退出单列且操作编号不变', () => {
    const html = renderToStaticMarkup(
        createElement(DialogContent, {
            busy: false,
            onRespond: () => {},
            model: {
                title: '结束监考',
                message: '退出客户端还是结束监考？',
                buttons: ['继续监考', '保留日志退出', '上传日志并结束监考'],
                defaultId: 0,
                cancelId: 0,
                primaryIds: [0, 2],
                secondaryDetail: '保留日志退出不会结束监考',
            },
        }),
    );
    const primary = html.match(/<div class="dialog-actions dialog-primary-actions">([\s\S]*?)<\/div>/)[1];
    assert.match(primary, /继续监考/);
    assert.match(primary, /上传日志并结束监考/);
    assert.doesNotMatch(primary, /secondary|tertiary|保留日志退出/);
    assert.match(html, /class="tertiary"[^>]*>保留日志退出/);
    assert.match(html, /保留日志退出不会结束监考/);
});

test('React 资源及沙箱桥完整，安装器支持选目录、手动完成并保留数据', () => {
    const output = applicationRoot();
    for (const page of ['upload', 'waiting', 'console', 'dialog']) {
        const html = fs.readFileSync(path.join(output, `app/renderer/${page}.html`), 'utf8');
        assert.match(html, new RegExp(`entries/${page}.js`));
        const bundle = fs.readFileSync(path.join(output, `app/renderer/entries/${page}.js`), 'utf8');
        assert.doesNotMatch(bundle, /require\(["'](?:react|node:)/);
    }
    const preload = fs.readFileSync(path.join(output, 'app/preload/preload.js'), 'utf8');
    assert.doesNotMatch(preload, /require\(["'](?:react|\.\/|\.\.\/)/);
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).build;
    assert.equal(config.nsis.oneClick, false);
    assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
    assert.equal(config.nsis.runAfterFinish, false);
    assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
    assert.match(fs.readFileSync(path.join(projectRoot, 'config/installer.nsh'), 'utf8'), /以管理员身份运行/);
    const ico = fs.readFileSync(path.join(output, 'icons/icon.ico'));
    const icns = fs.readFileSync(path.join(output, 'icons/icon.icns'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 7);
    assert.equal(icns.subarray(0, 4).toString(), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);
});
