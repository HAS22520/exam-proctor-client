import type { AuditSink } from '../contracts';

/** 正式窗口不开放开发工具；只阻断调试组合键，保留编辑器正常输入和右键行为。 */
export function protectExamInput(contents: Electron.WebContents, logger: AuditSink) {
    contents.on('before-input-event', (event, input) => {
        const key = input.key.toLowerCase();
        const blocked = key === 'f12' || ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key))
            || (input.meta && input.alt && ['i', 'j', 'c'].includes(key));
        if (!blocked) return;
        event.preventDefault();
        if (input.type === 'keyDown' && !input.isAutoRepeat) {
            logger.logViolation({ source: 'CLIENT', type: 'BLOCKED_DEVTOOLS_SHORTCUT', target: input.key, detail: '' });
        }
    });
    contents.on('devtools-opened', () => contents.closeDevTools());
}
