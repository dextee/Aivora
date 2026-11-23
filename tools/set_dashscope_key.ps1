# Writes the Model Studio (DashScope) connection into a GITIGNORED .env.local at the repo
# root, so AIVORA picks it up at boot without the value ever appearing in chat, in shell
# history, or in a tracked file.
#
#   Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\set_dashscope_key.ps1
#
# Safety properties:
#   - the key is read with a masked prompt and is never echoed, logged or written elsewhere
#   - only variable NAMES are printed back to you
#   - the target file is verified to be git-ignored before anything is written
#   - existing unrelated variables in .env.local are preserved

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo ".env.local"

Write-Output "Repo   : $repo"
Write-Output "Target : $target"

# 1. Refuse to write anywhere git would track it.
Push-Location $repo
$ignored = & git check-ignore ".env.local" 2>$null
Pop-Location
if (-not $ignored) {
  Write-Output "ABORT: .env.local is NOT git-ignored in this repo. Fix .gitignore first."
  exit 1
}
Write-Output "Git    : .env.local is ignored (cannot be committed)"

# 2. Masked prompt for the secret.
$secure = Read-Host "Paste your Model Studio API key (input is hidden)" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$plain = $plain.Trim()
if ($plain.Length -lt 8) {
  Write-Output "ABORT: that does not look like a key (too short). Nothing was written."
  exit 1
}

# 3. Non-secret companions, with the app's existing defaults shown.
$ws = Read-Host "Workspace ID (Enter to keep ws-lj7gmtttiltwjlyv)"
$region = Read-Host "Region (Enter to keep ap-southeast-1)"

# 4. Merge into the existing file so unrelated variables survive.
$lines = @()
if (Test-Path -LiteralPath $target) {
  $lines = @(Get-Content -LiteralPath $target)
}
function Set-Var([string[]]$existing, [string]$name, [string]$value) {
  $out = @()
  $found = $false
  foreach ($l in $existing) {
    if ($l -match ("^\s*" + [regex]::Escape($name) + "\s*=")) { $out += ($name + "=" + $value); $found = $true }
    else { $out += $l }
  }
  if (-not $found) { $out += ($name + "=" + $value) }
  return $out
}
$lines = Set-Var $lines "DASHSCOPE_API_KEY" $plain
if ($ws) { $lines = Set-Var $lines "WORKSPACE_ID" $ws.Trim() }
if ($region) { $lines = Set-Var $lines "QWEN_REGION" $region.Trim() }

# 5. Write UTF-8 without BOM (a BOM breaks the first variable name).
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($target, (($lines -join "`n") + "`n"), $utf8)

$plain = $null
Write-Output ""
Write-Output "WROTE .env.local with these variable names:"
foreach ($l in $lines) { if ($l -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=") { Write-Output ("  - " + $Matches[1]) } }
Write-Output ""
Write-Output "Restart the app, then check:  GET /api/keyinfo  ->  source should read 'env-file'."
