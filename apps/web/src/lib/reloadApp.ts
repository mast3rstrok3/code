/** Refresh cached build files before reloading after a chunk failure. */
export async function reloadApp(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const assets = new Set(
      Array.from(
        document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>(
          'link[rel="modulepreload"][href], link[rel="stylesheet"][href], script[type="module"][src]',
        ),
        (element) => ("href" in element ? element.href : element.src),
      ).filter((href) => {
        const url = new URL(href, document.baseURI);
        return /^https?:$/.test(url.protocol) && url.origin === window.location.origin;
      }),
    );
    const pending = [...assets];
    await Promise.all(
      Array.from({ length: Math.min(6, pending.length) }, async () => {
        while (!controller.signal.aborted) {
          const url = pending.pop();
          if (url === undefined) return;
          try {
            const response = await fetch(url, { cache: "reload", signal: controller.signal });
            // Consume the complete body so the cache contains the replacement before navigation.
            await response.arrayBuffer();
          } catch {
            // A removed chunk can return 404 or fail to load. The new index selects its replacement.
          }
        }
      }),
    );
  } finally {
    clearTimeout(timeout);
    window.location.reload();
  }
}
