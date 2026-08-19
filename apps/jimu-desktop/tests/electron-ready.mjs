/** Wait until the Harness reports ready and accepts an ordinary workspace call. */
export async function waitForHarnessReady(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let diagnostic = "Harness did not publish a status";
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(async () => {
        const status = await window.jimu.harness.status();
        if (status.phase !== "ready") return { ready: false, diagnostic: JSON.stringify(status) };
        try {
          await window.jimu.harness.call("workspace.list", {});
          return { ready: true, diagnostic: "ready" };
        } catch (error) {
          return { ready: false, diagnostic: error instanceof Error ? error.message : String(error) };
        }
      });
      if (state.ready) return;
      diagnostic = state.diagnostic;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for the JiMu Harness: ${diagnostic}`);
}

/** Wait until the packaged Harness publishes its Loader inventory. */
export async function waitForPluginInventory(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.jimu.plugins.snapshot());
    if (snapshot.entries?.length > 0) return;
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for the JiMu plugin inventory");
}
