param(
  [Parameter(Mandatory = $true)] [string] $BaselineInstaller,
  [Parameter(Mandatory = $true)] [string] $Installer,
  [Parameter(Mandatory = $true)] [string] $Version,
  [ValidateSet("NotSigned", "Valid")] [string] $ExpectedSignature = "NotSigned",
  [string] $PublisherName = ""
)

$ErrorActionPreference = "Stop"
if ($env:CI -ne "true") { throw "The installer lifecycle test may run only on an ephemeral CI runner." }
if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is required." }

$installRoot = Join-Path $env:LOCALAPPDATA "Programs\JiMu"
$executable = Join-Path $installRoot "JiMu.exe"
$uninstaller = Join-Path $installRoot "Uninstall JiMu.exe"
$userData = Join-Path $env:LOCALAPPDATA "JiMu"
$knowledgeRoot = Join-Path $env:USERPROFILE "JiMu-Knowledge"
$userDataSentinel = Join-Path $userData "installer-smoke-sentinel.txt"
$knowledgeSentinel = Join-Path $knowledgeRoot "installer-smoke-sentinel.txt"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "JiMu.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "JiMu.lnk"

function Wait-ForPath([string] $Path, [bool] $Present) {
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ((Test-Path -LiteralPath $Path) -eq $Present) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for path state $Present`: $Path"
}

function Install-JiMu([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Installer is missing: $Path" }
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode): $Path" }
  Wait-ForPath $executable $true
}

function Assert-Signature([string] $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ([string]$signature.Status -ne $ExpectedSignature) {
    throw "Expected $ExpectedSignature signature for $Path, received $($signature.Status): $($signature.StatusMessage)"
  }
  if ($ExpectedSignature -eq "Valid" -and $PublisherName) {
    if (-not $signature.SignerCertificate) { throw "The valid signature has no signer certificate: $Path" }
    $actualPublisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($actualPublisher -cne $PublisherName) {
      throw "Expected publisher '$PublisherName', received '$actualPublisher': $Path"
    }
  }
}

if (Test-Path -LiteralPath $installRoot) { throw "Installer test requires a clean runner: $installRoot already exists." }

Install-JiMu (Resolve-Path -LiteralPath $BaselineInstaller)
New-Item -ItemType Directory -Force -Path $userData, $knowledgeRoot | Out-Null
Set-Content -LiteralPath $userDataSentinel -Value "preserve-user-data" -Encoding Ascii
Set-Content -LiteralPath $knowledgeSentinel -Value "preserve-knowledge" -Encoding Ascii

Install-JiMu (Resolve-Path -LiteralPath $Installer)
if (-not (Test-Path -LiteralPath $userDataSentinel)) { throw "Upgrade removed the user-data sentinel." }
if (-not (Test-Path -LiteralPath $knowledgeSentinel)) { throw "Upgrade removed the Knowledge sentinel." }
Wait-ForPath $desktopShortcut $true
Wait-ForPath $startMenuShortcut $true

$productVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if (-not $productVersion.StartsWith($Version, [StringComparison]::Ordinal)) {
  throw "Installed version $productVersion does not start with $Version."
}
Assert-Signature (Resolve-Path -LiteralPath $Installer)
Assert-Signature $executable

pnpm --filter "@i-yolo/jimu-desktop" test:packaged:win -- $executable
if ($LASTEXITCODE -ne 0) { throw "Installed application smoke test failed with $LASTEXITCODE." }

$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  & $executable (Join-Path $PSScriptRoot "smoke-windows-conpty.mjs") --resources (Join-Path $installRoot "resources")
  if ($LASTEXITCODE -ne 0) { throw "Packaged ConPTY smoke test failed with $LASTEXITCODE." }
} finally {
  if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
}

$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstallProcess.ExitCode)." }
Wait-ForPath $installRoot $false
Wait-ForPath $desktopShortcut $false
Wait-ForPath $startMenuShortcut $false
if (-not (Test-Path -LiteralPath $userDataSentinel)) { throw "Uninstall removed the user-data sentinel." }
if (-not (Test-Path -LiteralPath $knowledgeSentinel)) { throw "Uninstall removed the Knowledge sentinel." }

Remove-Item -LiteralPath $userData, $knowledgeRoot -Recurse -Force
Write-Output "JiMu Windows install, upgrade, smoke, and uninstall lifecycle passed."
