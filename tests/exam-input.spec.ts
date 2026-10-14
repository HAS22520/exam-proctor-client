import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { protectExamInput } from '../app/main/security/exam-input';

test('在主进程阻断开发工具快捷键，保留正常编辑和中文输入', () => {
    const contents: any = new EventEmitter();
    let closed = 0;
    contents.closeDevTools = () => { closed++; };
    const events = [];
    protectExamInput(contents, { logViolation: (event) => events.push(event) });
    for (const input of [
        { key: 'F12' }, { key: 'I', control: true, shift: true }, { key: 'J', control: true, shift: true },
        { key: 'C', control: true, shift: true }, { key: 'i', meta: true, alt: true },
    ]) {
        let prevented = false;
        contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', ...input });
        assert.equal(prevented, true);
    }
    for (const input of [{ key: 'c', control: true }, { key: 'v', control: true }, { key: '中', isComposing: true }]) {
        contents.emit('before-input-event', { preventDefault: () => assert.fail('正常输入被阻断') }, { type: 'keyDown', ...input });
    }
    assert.equal(events.length, 5);
    contents.emit('devtools-opened');
    assert.equal(closed, 1);
});
