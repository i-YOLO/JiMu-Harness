import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build } from "electron-builder";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);

function option(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

const allowed = new Set(["--dir", "--signed", "--version", "--output"]);
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  if (argument === "--version" || argument === "--output") {
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
  }
}

const signed = argumentsList.includes("--signed");
const packageJson = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const config = structuredClone(packageJson.build);
const version = option("--version");
const output = option("--output");
if (version !== undefined) config.extraMetadata = { ...config.extraMetadata, version };
if (output !== undefined) config.directories = { ...config.directories, output };

if (signed) {
  const required = [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_CODE_SIGNING_ENDPOINT",
    "AZURE_CODE_SIGNING_ACCOUNT_NAME",
    "AZURE_CERTIFICATE_PROFILE_NAME",
    "AZURE_PUBLISHER_NAME",
  ];
  for (const name of required) if (!process.env[name]) throw new Error(`Signed Windows builds require ${name}`);
  config.win.azureSignOptions = {
    endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
    codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
    certificateProfileName: process.env.AZURE_CERTIFICATE_PROFILE_NAME,
    publisherName: process.env.AZURE_PUBLISHER_NAME,
  };
  config.win.forceCodeSigning = true;
} else {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  config.win.forceCodeSigning = false;
}

const target = argumentsList.includes("--dir") ? "dir" : "nsis";
await build({
  targets: Platform.WINDOWS.createTarget([target], Arch.x64),
  config,
  publish: "never",
});
