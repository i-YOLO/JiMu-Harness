import { createRequire } from "node:module";
import path from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.platform !== "win32") throw new Error("The ConPTY smoke test requires Windows");
const resourcesRoot = option("--resources");
if (!resourcesRoot) throw new Error("Usage: smoke-windows-conpty.mjs --resources <installed-resources>");

const require = createRequire(path.join(path.resolve(resourcesRoot), "app", "package.json"));
const nodePty = require("node-pty");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const terminal = nodePty.spawn(powershell, ["-NoLogo", "-NoProfile", "-Command", "Write-Output JIMU_WINDOWS_SMOKE"], {
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let output = "";
terminal.onData(data => { output += data; });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    terminal.kill();
    reject(new Error("ConPTY smoke test timed out"));
  }, 30_000);
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    if (exitCode === 0) resolve();
    else reject(new Error(`PowerShell exited with ${exitCode}: ${output}`));
  });
});
if (!output.includes("JIMU_WINDOWS_SMOKE")) throw new Error(`ConPTY output did not contain the marker: ${output}`);
console.log("Packaged node-pty ConPTY smoke test passed.");
