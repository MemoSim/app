#Requires -Version 5.1
<#
  Builds the MemoSim Windows installer from the MemoSim repo plus a NetLogo Desktop checkout.
  Self-contained output: Java runtime, NetLogo Desktop, extensions (gis/nw/py), models, chat server, Node.

    powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1 -Type msi
    powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1 -SkipWeb -SkipScala   # reuse last builds

  Result: <BuildRoot>\release\MemoSim-<version>.exe   (or .msi)
  User data (projects, settings, logs) lives in %APPDATA%\NetLogo Chat and survives reinstalls.

  Needs on the build machine: JDK 21 (JAVA_HOME), sbt, Node 22 x64, Git, and WiX Toolset 3.x for .exe/.msi
  (choco install wixtoolset --version=3.14.1). Run `npm ci` in the repo once before the first build.
#>
param(
  [string]$NetLogoSrc,
  [string]$BuildRoot,
  [string]$Version,
  [ValidateSet("exe", "msi")] [string]$Type = "exe",
  [switch]$SkipWeb,
  [switch]$SkipScala
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

# defaults (resolved here, not in the param block, so the script also starts on a machine without these variables)
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$ChatDir  = Split-Path -Parent $PSScriptRoot
# monorepo layout first (chat/ and desktop/ side by side), legacy checkout second
if (-not $NetLogoSrc) {
  $sibling = Join-Path (Split-Path $ChatDir -Parent) "desktop"
  $NetLogoSrc = if (Test-Path (Join-Path $sibling "build.sbt")) { $sibling } else { Join-Path $UserHome "dev\netlogo-desktop" }
}
# jpackage cannot handle a path with spaces, and Windows user names often contain one ("My mac win"),
# so fall back to a drive-root folder instead of failing the build on the user's profile path
if (-not $BuildRoot) {
  $preferred = Join-Path $UserHome "dev\netlogo-chat-build"
  $BuildRoot = if ($preferred -match '\s') { "C:\nl-chat-build" } else { $preferred }
  if ($BuildRoot -match '\s') { Die "no space-free build directory available; pass -BuildRoot (e.g. C:\nl-chat-build)" }
}
if (-not $Version) { $Version = if ($env:APP_VERSION) { $env:APP_VERSION } else { "1.1.4" } }

$AppName  = "MemoSim"
$MainCls  = "org.nlogo.app.App"
$B        = Join-Path $BuildRoot "win"
$InputDir = Join-Path $B "input"
$Content  = Join-Path $B "content"
$Runtime  = Join-Path $B "runtime"
$Release  = Join-Path $BuildRoot "release"
$Log      = Join-Path $ChatDir "build-windows.log"

function Say([string]$Msg) { Write-Host "==> $Msg" -ForegroundColor Cyan }
# Emit a GitHub annotation as well as a console line: job logs are served by a host that is unreachable from
# some networks, while annotations come back over api.github.com.
function Die([string]$Msg) { Write-Host "ERR $Msg" -ForegroundColor Red; Write-Host "::error title=MemoSim build ::$Msg"; exit 1 }

# Native tools write progress and warnings to stderr; in Windows PowerShell 5.1 a redirected stderr line becomes a
# terminating error while $ErrorActionPreference is Stop. Run such commands through cmd.exe and check the exit code instead.
function Invoke-Batch([string]$CommandLine, [string]$WorkDir) {
  $bat = Join-Path $env:TEMP ("nl-chat-step-" + [guid]::NewGuid().ToString('N') + ".bat")
  $lines = @("@echo off")
  if ($WorkDir) { $lines += "cd /d `"$WorkDir`"" }
  $lines += $CommandLine
  Set-Content -Path $bat -Value $lines -Encoding ASCII
  try { cmd /c $bat; $code = $LASTEXITCODE } finally { Remove-Item $bat -Force -ErrorAction SilentlyContinue }
  return $code
}

function Invoke-Step([string]$What, [scriptblock]$Body) {
  Say $What
  & $Body
  if ($LASTEXITCODE -ne 0) { Die "$What failed (exit $LASTEXITCODE)" }
}

# ---- 0. checks ------------------------------------------------------------------------------------------------

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Die "run this on Windows (jpackage cannot cross-build a Windows installer)" }
if ($BuildRoot -match '\s') { Die "BuildRoot must not contain spaces (jpackage limitation): $BuildRoot" }
if (-not (Test-Path (Join-Path $NetLogoSrc "build.sbt"))) { Die "NetLogo source not found: $NetLogoSrc (set -NetLogoSrc)" }
if (-not (Test-Path (Join-Path $ChatDir "package.json"))) { Die "not the MemoSim repo: $ChatDir" }
if (-not $env:JAVA_HOME) {
  # JAVA_HOME is not always set by the JDK installer; fall back to the usual locations
  $candidates = @(
    (Get-ChildItem "C:\Program Files\Eclipse Adoptium\jdk-21*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending),
    (Get-ChildItem "C:\Program Files\Java\jdk-21*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  ) | Where-Object { $_ } | Select-Object -First 1
  if (-not $candidates) { Die "JDK 21 not found; set JAVA_HOME (winget install EclipseAdoptium.Temurin.21.JDK)" }
  $env:JAVA_HOME = $candidates.FullName
  $env:PATH = (Join-Path $env:JAVA_HOME "bin") + ";" + $env:PATH
  Write-Host "    using JDK at $env:JAVA_HOME"
}

$JdkBin   = Join-Path $env:JAVA_HOME "bin"
$Jpackage = Join-Path $JdkBin "jpackage.exe"
$Jlink    = Join-Path $JdkBin "jlink.exe"
foreach ($tool in @($Jpackage, $Jlink)) { if (-not (Test-Path $tool)) { Die "missing $tool (JDK 21 required)" } }
foreach ($cmd in @("sbt", "node", "npx", "jar")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Die "$cmd not found on PATH" }
}
if (-not $SkipScala -and -not (Get-Command sh.exe -ErrorAction SilentlyContinue)) {
  # sh.exe is not always on PATH even when Git Bash is installed; add its folder when present.
  $gitSh = "C:\Program Files\Git\usr\bin"
  if (Test-Path (Join-Path $gitSh "sh.exe")) {
    $env:PATH = $gitSh + ";" + $env:PATH
  } else {
    Die "Git Bash sh.exe is required to build NetLogo interface resources; add Git's usr\bin folder to PATH"
  }
}

$NodeArch = (& node -p "process.arch").Trim()
if ($NodeArch -ne "x64") { Die "Node must be x64 for a Windows x64 build (found $NodeArch)" }

if ($Type -in @("exe", "msi")) {
  $candle = (Get-Command candle.exe -ErrorAction SilentlyContinue)
  if (-not $candle -and -not (Test-Path "C:\Program Files (x86)\WiX Toolset v3.14\bin\candle.exe")) {
    Die "WiX Toolset 3.x is required for .$Type (choco install wixtoolset --version=3.14.1)"
  }
}

# better-sqlite3 ships a ready-made win32-x64 binary. npm would still run node-gyp for it (it has a binding.gyp and no
# install script), which needs Visual Studio, so install without scripts. The check above doubles as "dependencies are usable".
$SqliteBinary = Join-Path $ChatDir "node_modules\better-sqlite3\prebuilds\win32-x64.node"
if (-not (Test-Path $SqliteBinary)) {
  Say "installing npm packages (first build)"
  $npmLog = Join-Path $env:TEMP "nl-chat-npm.log"
  if (Test-Path (Join-Path $ChatDir "node_modules")) {
    Invoke-Batch "rd /s /q `"node_modules`"" $ChatDir | Out-Null
    if (Test-Path (Join-Path $ChatDir "node_modules")) { Die "could not remove node_modules (close anything using it)" }
  }
  if ((Invoke-Batch "npm ci --ignore-scripts > `"$npmLog`" 2>&1" $ChatDir) -ne 0) {
    Get-Content $npmLog -Tail 15 | ForEach-Object { Write-Host "    $_" }
    Die "npm ci failed, see $npmLog"
  }
  if (-not (Test-Path $SqliteBinary)) { Die "npm ci did not provide better-sqlite3 for win32-x64" }
}

# ---- 1. NetLogo (Scala) ----------------------------------------------------------------------------------------
if (-not $SkipScala) {
  $splashSvg = Join-Path $ChatDir "packaging\memosim-splash.svg"
  $splashPng = Join-Path $NetLogoSrc "netlogo-gui\resources\images\memosim-splash.png"
  $splashFont = Join-Path $NetLogoSrc "autogen\images\Inter-Medium.ttf"
  # ImageMagick is installed by winget/choco into Program Files and not always added to PATH
  if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
    $found = Get-ChildItem "C:\Program Files" -Recurse -Filter magick.exe -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $env:PATH = $found.DirectoryName + ";" + $env:PATH; Write-Host "    using $($found.FullName)" }
    else { Die "ImageMagick not found (winget install ImageMagick.ImageMagick)" }
  }
  & magick -background none -font $splashFont $splashSvg $splashPng
  # The Windows ImageMagick build often lacks the librsvg delegate, so SVG->PNG conversion fails even though
  # PNG annotation (used by the NetLogo banner task) works. The splash PNG is committed, so only warn.
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    note: splash regeneration failed (no SVG delegate); keeping the committed memosim-splash.png" -ForegroundColor Yellow
  }
}

if (-not $SkipScala) {
  Say "compiling NetLogo Desktop"
  # NetLogoPackaging/JavaPackager read .jdks.yaml while sbt loads the project, and Source.fromFile throws when it is
  # absent, so a clean checkout cannot even evaluate the build. The file is gitignored and only needed for `dist`
  # tasks, while an unparsable/empty file is tolerated: create it when missing.
  $jdkFile = Join-Path $NetLogoSrc ".jdks.yaml"
  if (-not (Test-Path $jdkFile)) {
    Say "creating a placeholder .jdks.yaml (required for sbt project loading)"
    Set-Content -Path $jdkFile -Encoding ASCII -Value @(
      "# Generated by build-windows-app.ps1; sbt loads this file at project evaluation time.",
      "# Populate it with - vendor/version/architecture/path entries to run the `dist` packaging tasks."
    )
  }
  # sbt's resource generator shells out to `sh stage.sh` for the two TypeScript bundles (colorpicker,
  # codetab), which runs `npm ci` and fails here with EUSAGE. Both bundles are committed, so the script
  # becomes a no-op instead of being run.
  $gitBash = "C:\Program Files\Git\bin\bash.exe"
  foreach ($proj in @("colorpicker", "codetab")) {
    $projDir = Join-Path $NetLogoSrc "netlogo-gui\$proj"
    if (-not (Test-Path (Join-Path $projDir "stage.sh"))) { continue }
    if (-not (Test-Path (Join-Path $projDir "out\index.html"))) { Die "$proj bundle is missing from the checkout (out/index.html)" }
    if (-not (Test-Path $gitBash)) { Die "git bash not found at $gitBash; sbt needs it to evaluate the $proj bundle" }
    Say "neutralising $proj/stage.sh (the built bundle in out/ is committed)"
    # sbt's resource generator runs `sh stage.sh`, which does `npm ci` and then copies the webpack output into
    # out/. The output is committed and complete, and npm cannot run in this shell (EUSAGE), so replacing the
    # script with a no-op is both correct and deterministic. Regenerate out/ on a dev machine when sources change.
    $stageShim = @('#! /bin/sh', '# replaced by scripts/build-windows-app.ps1: out/ is committed; npm is unavailable here', 'exit 0')
    Set-Content -Path (Join-Path $projDir "stage.sh") -Encoding ASCII -Value $stageShim
  }
  Push-Location $NetLogoSrc
  try {
    $compileCode = Invoke-Batch "sbt -batch netlogo/compile > `"$Log`" 2>&1" $NetLogoSrc
    # Surface the Scala errors on the console: a CI run that only says "see build-windows.log" is undiagnosable.
    if ($compileCode -ne 0 -or (Select-String -Path $Log -Pattern "^\[error\]" -Quiet)) {
      if (Test-Path $Log) {
        Get-Content $Log -Tail 80 | ForEach-Object { Write-Host "    $_" }
        # annotations (max 10 per step) so the real Scala error is visible without the log download
        Select-String -Path $Log -Pattern '(?i)^\[error\]|error:|Exception' |
          Select-Object -Last 8 | ForEach-Object { Write-Host "::error::scala: $($_.Line.Trim())" }
      }
      Die "Scala build failed (exit $compileCode), log at $Log"
    }
    $cpOut = Join-Path $env:TEMP "nl-chat-classpath.txt"
    $cpExit = Invoke-Batch "sbt -batch `"export netlogo/Runtime/fullClasspath`" > `"$cpOut`" 2>&1" $NetLogoSrc
    if ($null -eq $cpExit -or $cpExit -ne 0) {
      Get-Content $cpOut -Tail 30 | ForEach-Object { Write-Host "    $_" }
      Select-String -Path $cpOut -Pattern '(?i)error|exception|not found|failed' |
        Select-Object -Last 8 | ForEach-Object { Write-Host "::error::classpath: $($_.Line.Trim())" }
      Die "NetLogo runtime resource build failed (exit $cpExit), log at $cpOut"
    }
    $cp = Get-Content $cpOut -ErrorAction SilentlyContinue | Where-Object { $_ -match '^[A-Za-z]:\\' } | Select-Object -Last 1
    if (-not $cp) { Die "could not read the NetLogo runtime classpath from sbt" }
    New-Item -ItemType Directory -Force -Path (Join-Path $NetLogoSrc "chat-dev") | Out-Null
    Set-Content -Path (Join-Path $NetLogoSrc "chat-dev\classpath.txt") -Value $cp -Encoding ASCII
  } finally { Pop-Location }
}
$ClasspathFile = Join-Path $NetLogoSrc "chat-dev\classpath.txt"
if (-not (Test-Path $ClasspathFile)) { Die "no classpath; run without -SkipScala" }
$Classpath = (Get-Content $ClasspathFile -Raw).Trim()
if (-not $Classpath) { Die "empty classpath file: $ClasspathFile" }

# ---- 2. chat server (Next standalone) --------------------------------------------------------------------------

$ServerBuild = Join-Path $ChatDir ".next-app"
if (-not $SkipWeb) {
  Say "building chat server"
  Push-Location $ChatDir
  try {
    Remove-Item $ServerBuild -Recurse -Force -ErrorAction SilentlyContinue
    $env:NEXT_DIST_DIR = ".next-app"
    $nextLog = Join-Path $env:TEMP "nl-chat-next.log"
    if ((Invoke-Batch "npx next build > `"$nextLog`" 2>&1") -ne 0) {
      Get-Content $nextLog -Tail 15 | ForEach-Object { Write-Host "    $_" }
      Die "next build failed, see $nextLog"
    }
    Get-Content $nextLog -Tail 4 | ForEach-Object { Write-Host "    $_" }
  } finally { Pop-Location; Remove-Item Env:\NEXT_DIST_DIR -ErrorAction SilentlyContinue }
}
$Standalone = Join-Path $ServerBuild "standalone\server.js"
if (-not (Test-Path $Standalone)) { Die "no standalone server build (run without -SkipWeb)" }

# ---- 3. assemble ----------------------------------------------------------------------------------------------

Say "assembling"
if (Test-Path $B) { Remove-Item $B -Recurse -Force }
New-Item -ItemType Directory -Force -Path $InputDir, (Join-Path $Content "server"), (Join-Path $Content "node\bin"), (Join-Path $Content "docs"), (Join-Path $Content "extensions") | Out-Null

$i = 0
foreach ($e in ($Classpath -split ';' | Where-Object { $_ -and (Test-Path $_) })) {
  if (Test-Path $e -PathType Container) {
    $i++
    $parent = Split-Path (Split-Path $e -Parent) -Parent
    $name = "{0:D2}-{1}-classes.jar" -f $i, (Split-Path $parent -Leaf)
    if ((Invoke-Batch "jar --create --file `"$(Join-Path $InputDir $name)`" -C `"$e`" .") -ne 0) { Die "could not package $e" }
  } else {
    Copy-Item $e (Join-Path $InputDir (Split-Path $e -Leaf)) -Force
  }
}
$MainJar = Get-ChildItem $InputDir -Filter "*-classes.jar" | Select-Object -First 1
if (-not $MainJar) { Die "no classes jar produced from the NetLogo classpath" }
Write-Host ("    {0} jars, main: {1}" -f (Get-ChildItem $InputDir).Count, $MainJar.Name)

# Package the NetLogo GUI resource tree explicitly. On Windows, netlogo-gui/resources contains two
# directory symlinks (codetab, colorpicker) and sbt's recursive glob silently yields nothing for the
# whole directory, so `sbt netlogo/compile` leaves images/ (and themes/fonts/i18n/system) out of
# target/classes. The app then dies at startup with ExceptionInInitializerError because
# /images/memosim-splash.png is missing. Do not rely on sbt's copy; stage and verify the resources here.
$GuiResources  = Join-Path $NetLogoSrc "netlogo-gui\resources"
$SharedResMain = Join-Path $NetLogoSrc "shared\resources\main"
if (-not (Test-Path $GuiResources -PathType Container)) { Die "NetLogo GUI resources not found: $GuiResources" }
$ResourceStage = Join-Path $B "resources"
if (Test-Path $ResourceStage) { Remove-Item $ResourceStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ResourceStage | Out-Null
Get-ChildItem $GuiResources -Force |
  Where-Object { $_.Name -notin @("codetab", "colorpicker") } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $ResourceStage $_.Name) -Recurse -Force }
# the symlinks resolve to <project>\<name>\out; copy the real bundle target instead of the link
foreach ($bundle in @(@{ Name = "codetab"; Dir = "netlogo-gui\codetab\out" },
                       @{ Name = "colorpicker"; Dir = "netlogo-gui\colorpicker\out" })) {
  $bundleSrc = Join-Path $NetLogoSrc $bundle.Dir
  if (-not (Test-Path $bundleSrc -PathType Container)) { Die "missing $($bundle.Name) bundle: $bundleSrc" }
  Copy-Item -LiteralPath $bundleSrc -Destination (Join-Path $ResourceStage $bundle.Name) -Recurse -Force
}
if (Test-Path $SharedResMain -PathType Container) {
  Get-ChildItem $SharedResMain -Force | ForEach-Object {
    $dest = Join-Path $ResourceStage $_.Name
    if ($_.PSIsContainer -and (Test-Path $dest)) {
      Copy-Item -Path (Join-Path $_.FullName "*") -Destination $dest -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
    }
  }
}
$ResourcesJar = Join-Path $InputDir "99-netlogo-resources.jar"
if ((Invoke-Batch "jar --create --file `"$ResourcesJar`" -C `"$ResourceStage`" .") -ne 0) {
  Die "could not package NetLogo GUI resources"
}
$resourceListing = & (Join-Path $JdkBin "jar.exe") tf $ResourcesJar
foreach ($required in @("images/memosim-splash.png", "images/memosim-icon.png",
                        "images/banner-versionless.png", "codetab/index.html", "colorpicker/index.html")) {
  if ($resourceListing -notcontains $required) { Die "packaged resources are missing $required" }
}
Write-Host ("    resources: {0} files" -f (Get-ChildItem $ResourceStage -Recurse -File).Count)

foreach ($d in (Get-ChildItem (Join-Path $NetLogoSrc "extensions") -Directory)) {
  $jars = Get-ChildItem $d.FullName -Filter "*.jar" -File
  if (-not $jars) { continue }
  $target = Join-Path $Content "extensions\$($d.Name)"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $jars | Copy-Item -Destination $target -Force
  $py = Join-Path $d.FullName "pyext.py"
  if (Test-Path $py) { Copy-Item $py $target -Force }
}
# The extension jars are gitignored upstream, so a fresh checkout has no jars to copy: say so instead of
# crashing on an empty list (Set-StrictMode turns $null.Name into a terminating error).
$extCopied = @(Get-ChildItem (Join-Path $Content "extensions") -ErrorAction SilentlyContinue)
if ($extCopied.Count -eq 0) {
  Write-Host "    note: no extension jars found under $NetLogoSrc\extensions (gis/nw/py will be absent)" -ForegroundColor Yellow
} else {
  Write-Host ("    extensions: " + ($extCopied.Name -join " "))
}
Copy-Item (Join-Path $NetLogoSrc "models") (Join-Path $Content "models") -Recurse -Force

$ServerDest = Join-Path $Content "server"
Get-ChildItem (Join-Path $ServerBuild "standalone") -Force | Where-Object { $_.Name -notlike '.env*' } | Copy-Item -Destination $ServerDest -Recurse -Force
Get-ChildItem $ServerDest -Force -Recurse -File -Filter '.env*' | Remove-Item -Force
New-Item -ItemType Directory -Force -Path (Join-Path $ServerDest ".next-app") | Out-Null
Copy-Item (Join-Path $ServerBuild "static") (Join-Path $ServerDest ".next-app\static") -Recurse -Force
Copy-Item (Join-Path $ChatDir "public") (Join-Path $ServerDest "public") -Recurse -Force
if (-not (Test-Path (Join-Path $ServerDest "public\nlw\2.15.3.html"))) { Write-Host "    note: NetLogo Web page missing in public\nlw (web edition only)" }

# bundled node (the server runs on it, not on the user's Node)
$nodeSrc = (Get-Command node).Source
Copy-Item $nodeSrc (Join-Path $Content "node\bin\node.exe") -Force

# keep only the Windows sqlite binary; drop build-only modules
$prebuilds = Join-Path $ServerDest "node_modules\better-sqlite3\prebuilds"
if (Test-Path $prebuilds) {
  Get-ChildItem $prebuilds -Filter "*.node" -Recurse | Where-Object { $_.FullName -notmatch 'win32' } | Remove-Item -Force
}
Remove-Item (Join-Path $ServerDest "node_modules\typescript") -Recurse -Force -ErrorAction SilentlyContinue
$DocsSource = Join-Path $NetLogoSrc "chat-dev\manual"
$DocsTarget = Join-Path $Content "docs"
$requiredDocs = @("index.html", "tutorial.html", "dictionary.html", "legal.html", "manual.pdf", "docs.css", "docs.js", "dict\quickhelp.csv", "assets\memosim-icon.png")
foreach ($doc in $requiredDocs) {
  if (-not (Test-Path (Join-Path $DocsSource $doc) -PathType Leaf)) { Die "offline Help file is missing: $DocsSource\$doc" }
}
Get-ChildItem $DocsSource -Force | Copy-Item -Destination $DocsTarget -Recurse -Force

# ---- 3b. license and attribution files (GPL-2.0-or-later §1, §2(c), §3) ---------------------------------------
# Every distributed build must carry these. Contents\licenses sits next to the app payload so a recipient can
# read the license without launching the app; the same texts are reachable in-app from
# Help > Licenses and Attribution (docs\legal.html) and Settings > About.
$LicensesTarget = Join-Path $Content "licenses"
New-Item -ItemType Directory -Force -Path $LicensesTarget | Out-Null
$requiredNotices = @(
  (Join-Path $ChatDir "LICENSE"),
  (Join-Path $ChatDir "LICENSING.md"),
  (Join-Path $ChatDir "THIRD_PARTY_NOTICES.md"),
  (Join-Path $DocsSource "licenses\GPL-2.0.txt"),
  (Join-Path $DocsSource "licenses\CC-BY-SA-3.0.txt"),
  (Join-Path $ChatDir "public\nlw\NOTICE.txt")
)
foreach ($notice in $requiredNotices) {
  if (-not (Test-Path $notice -PathType Leaf)) { Die "license/notice file is missing: $notice" }
  Copy-Item $notice -Destination $LicensesTarget -Force
}
if (-not (Test-Path (Join-Path $DocsSource "legal.html") -PathType Leaf)) { Die "attribution page is missing: $DocsSource\legal.html" }
Write-Host ("    licenses: " + ((Get-ChildItem $LicensesTarget | ForEach-Object Name) -join ' '))

# ---- 4. Java runtime -------------------------------------------------------------------------------------------

Say "creating Java runtime (jlink)"
Invoke-Step "jlink" { & $Jlink --add-modules ALL-MODULE-PATH --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output $Runtime }
Write-Host ("    runtime: {0:N0} MB" -f ((Get-ChildItem $Runtime -Recurse | Measure-Object Length -Sum).Sum / 1MB))

# ---- 5. installer ----------------------------------------------------------------------------------------------

Say "packaging $AppName ($Type)"
if (Test-Path $Release) { Remove-Item $Release -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Release | Out-Null
$ico = Join-Path $ChatDir "packaging\AppIcon.ico"
if (-not (Test-Path $ico)) { Die "packaging\AppIcon.ico is missing (run packaging\make-ico.sh)" }

$jpackageArgs = @(
  "--type", $Type, "--name", $AppName, "--app-version", $Version, "--vendor", "MemoSim",
  "--description", "Chat with an LLM that builds NetLogo models",
  "--icon", $ico,
  "--input", $InputDir, "--main-jar", $MainJar.Name, "--main-class", $MainCls,
  "--runtime-image", $Runtime,
  "--app-content", ((@('extensions', 'models', 'server', 'node', 'docs', 'licenses') | ForEach-Object { Join-Path $Content $_ }) -join ','),
  "--java-options", "-Xmx4G",
  "--java-options", "-Dnetlogo.product.name=MemoSim",
  "--java-options", '-Dnetlogo.extensions.dir=$APPDIR\..\extensions',
  "--java-options", '-Dnetlogo.models.dir=$APPDIR\..\models',
  "--java-options", '-Dnetlogo.docs.dir=$APPDIR\..\docs',
  "--java-options", '-Dnetlogo.chat.server.dir=$APPDIR\..\server',
  "--java-options", '-Dnetlogo.chat.node=$APPDIR\..\node\bin\node.exe',
  "--java-options", "-Dcom.sun.webkit.useHTTP2Loader=false",
  "--java-options", "-Dcom.sun.media.jai.disableMediaLib=true",
  "--java-options", "-Dprism.lcdtext=false", "--java-options", "-Dswing.aatext=true",
  "--java-options", "-Dfile.encoding=UTF-8",
  "--java-options", "--add-opens=java.base/java.lang=ALL-UNNAMED",
  "--win-menu", "--win-shortcut", "--win-per-user-install", "--win-dir-chooser",
  "--dest", $Release
)

& $Jpackage @jpackageArgs
if ($LASTEXITCODE -ne 0) { Die "jpackage failed" }

$out = Get-ChildItem $Release -File | Select-Object -First 1
if (-not $out) { Die "jpackage produced no installer in $Release" }
Write-Host ("    installer: {0} ({1:N0} MB)" -f $out.FullName, ($out.Length / 1MB))
Write-Host "    note: unsigned; SmartScreen will warn until the installer is code-signed"
Say "done"
