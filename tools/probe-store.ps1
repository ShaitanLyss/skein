# Does `claude auth login` honour CLAUDE_SECURESTORAGE_CONFIG_DIR?
#
# The one step the per-process-account design rests on and the one step that
# cannot be probed headlessly: it needs a browser round trip. Everything else is
# established (see `.claude/rules/accounts.md`) — an empty store dir reports
# `loggedIn: false`, a dir holding a credential reports `authMethod: claude.ai`
# with the account's email and plan, and a real turn runs under it while its
# transcript still lands in the shared config dir.
#
# What is unknown is whether the *writer* looks at the same variable the reader
# does. If it does not, this login overwrites `~/.claude/.credentials.json` with
# whichever account you sign in as — so the global credential is backed up
# first, hashed before and after, and restored on request if it moved.
#
# Sign in as the SECOND account. If the variable is honoured, the store this
# leaves behind is a real one and nothing further is needed to set it up.

$ErrorActionPreference = 'Stop'

$store  = Join-Path $HOME '.claude\accounts\probe'
$global = Join-Path $HOME '.claude\.credentials.json'
$backup = "$global.probe-backup"

function Fingerprint($path) {
  if (-not (Test-Path $path)) { return $null }
  return [pscustomobject]@{
    Hash  = (Get-FileHash $path -Algorithm SHA256).Hash
    Wrote = (Get-Item $path).LastWriteTimeUtc
  }
}

Write-Host ''
Write-Host '  probing CLAUDE_SECURESTORAGE_CONFIG_DIR against `claude auth login`' -ForegroundColor Cyan
Write-Host ''

$before = Fingerprint $global
if ($before) {
  Copy-Item $global $backup -Force
  Write-Host "  global credential backed up to $backup"
  Write-Host "  its hash before: $($before.Hash.Substring(0,16))…"
} else {
  Write-Host '  no global credential to back up (not signed in globally)' -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $store | Out-Null
Write-Host "  store dir: $store"
Write-Host ''
Write-Host '  a browser will open. sign in as the SECOND account.' -ForegroundColor Cyan
Write-Host ''

$env:CLAUDE_SECURESTORAGE_CONFIG_DIR = $store
Remove-Item Env:\CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue

try { & claude auth login --claudeai } catch { Write-Host "  login threw: $_" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  ── what happened ─────────────────────────────────────────────' -ForegroundColor Cyan

$landed = Test-Path (Join-Path $store '.credentials.json')
$after  = Fingerprint $global
$moved  = $before -and $after -and ($before.Hash -ne $after.Hash)

Write-Host "  store dir now holds: $(((Get-ChildItem -Force $store -ErrorAction SilentlyContinue).Name) -join ', ')"
Write-Host "  credential landed in the store dir: $landed"
Write-Host "  global credential changed: $moved"

if ($landed -and -not $moved) {
  Write-Host ''
  Write-Host '  VERDICT: honoured. the writer uses the variable, the global sign-in is untouched.' -ForegroundColor Green
  Write-Host '  this store is real — the design works, and this account is already set up.'
  Write-Host "  whose account it is:"
  & claude auth status 2>&1 | Select-Object -First 8
} elseif ($moved) {
  Write-Host ''
  Write-Host '  VERDICT: ignored by the writer. the global credential was overwritten.' -ForegroundColor Red
  Write-Host "  restore it with:  Copy-Item '$backup' '$global' -Force"
} else {
  Write-Host ''
  Write-Host '  VERDICT: nothing was written anywhere — the login did not complete.' -ForegroundColor Yellow
  Write-Host '  inconclusive; run it again and finish the browser step.'
}

Remove-Item Env:\CLAUDE_SECURESTORAGE_CONFIG_DIR
Write-Host ''
