import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitWhile } from '../app/shared/async';

test('等待条件按顺序重查，条件解除后停止计时', async () => {
    let checks = 0;
    await waitWhile(() => ++checks < 3, Date.now() + 60000, 1);
    assert.equal(checks, 3);
});

test('已过期的等待立即结束，仍保留最终条件检查', async () => {
    let checks = 0;
    await waitWhile(() => {
        checks++;
        return true;
    }, Date.now() - 1, 1);
    assert.equal(checks, 1);
});
