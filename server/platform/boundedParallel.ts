/** Run items with a fixed maximum number of concurrent workers. */
async function forEachBounded<T>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), Math.max(items.length, 1)) },
        async () => {
            while (true) {
                const index = cursor++;
                if (index >= items.length) return;
                await fn(items[index], index);
            }
        },
    );
    await Promise.all(workers);
}

export { forEachBounded };