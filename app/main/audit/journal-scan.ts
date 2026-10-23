import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JournalState, Trace } from '../contracts';

/** 单份状态损坏不会阻断其余日志；不跟随日志目录链接，也不修改任何原始文件。 */
export function scanJournals(directory: string, uid: number, allowedOrigins: string[], trace: Trace = () => {}) {
    const entries: { key: string, directory: string, state: JournalState }[] = [];
    let unreadable = 0;
    if (!uid || !fs.existsSync(directory)) return { entries, unreadable };
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const journalDirectory = path.join(directory, entry.name);
        try {
            const filename = path.join(journalDirectory, 'state.json');
            if (!fs.lstatSync(filename).isFile()) throw new Error('日志状态必须是普通文件');
            const state: JournalState = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!state?.binding || !['open', 'closing', 'pending-upload', 'uploaded'].includes(state.phase)) {
                throw new Error('日志状态格式无效');
            }
            if (state.binding.uid !== uid || !allowedOrigins.includes(state.binding.origin)) continue;
            entries.push({ key: entry.name, directory: journalDirectory, state });
        } catch (error) {
            unreadable++;
            trace('error', 'logs.scan-failed', { journal: entry.name, message: (error as Error).message });
        }
    }
    return { entries, unreadable };
}
