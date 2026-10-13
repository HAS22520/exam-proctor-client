/** 在截止时间内等待条件解除；每次检查之间让出事件循环。 */
export async function waitWhile(condition: () => boolean, deadline: number, intervalMs = 100): Promise<void> {
    async function check(): Promise<void> {
        if (!condition() || Date.now() >= deadline) return;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        await check();
    }
    await check();
}
