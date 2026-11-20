@echo off
rem MemoSim: builds the Windows installer (.exe).
rem Double-click this file. It installs any missing prerequisites with winget (JDK 21, Node 22, sbt, WiX 3),
rem then runs scripts\build-windows-app.ps1.
rem Result: %USERPROFILE%\dev\netlogo-chat-build\release\MemoSim-<version>.exe
setlocal EnableExtensions
pushd "%~dp0" || (echo ERR cannot open the repo folder & pause & exit /b 1)
set "REPO=%CD%"

echo ==^> MemoSim - Windows installer
echo     repo: %REPO%
echo.

where winget >nul 2>&1
if errorlevel 1 (
  echo ERR winget is not available. Install the prerequisites by hand - see docs\INSTALLERS.md
  goto :fail
)

rem ---- JDK 21 (needs jpackage) -------------------------------------------------------------------------------
call :find_jdk
if not defined JDKOK (
  echo ==^> installing JDK 21
  winget install --id EclipseAdoptium.Temurin.21.JDK -e --silent --accept-package-agreements --accept-source-agreements
  call :find_jdk
)
if not defined JDKOK (
  echo ERR JDK 21 with jpackage was not found. Install it: winget install EclipseAdoptium.Temurin.21.JDK
  goto :fail
)
set "PATH=%JAVA_HOME%\bin;%PATH%"
echo     JDK: %JAVA_HOME%

rem ---- Node.js (x64) -----------------------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo ==^> installing Node.js LTS
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
)
where node >nul 2>&1
if errorlevel 1 (
  echo ERR Node.js was not found. Install it: winget install OpenJS.NodeJS.LTS
  goto :fail
)
for /f "delims=" %%V in ('node -p "process.version+' '+process.arch"') do echo     Node: %%V

rem ---- sbt (the NetLogo build) -------------------------------------------------------------------------------
where sbt >nul 2>&1
if errorlevel 1 (
  echo ==^> installing sbt
  winget install --id sbt.sbt -e --silent --accept-package-agreements --accept-source-agreements
  if exist "C:\Program Files (x86)\sbt\bin" set "PATH=C:\Program Files (x86)\sbt\bin;%PATH%"
)
where sbt >nul 2>&1
if errorlevel 1 (
  echo ERR sbt was not found. Install it: winget install sbt.sbt
  goto :fail
)

rem ---- WiX Toolset 3 (needed by jpackage for .exe/.msi) ------------------------------------------------------
if not exist "C:\Program Files (x86)\WiX Toolset v3.14\bin\candle.exe" (
  echo ==^> installing WiX Toolset 3.14
  winget install --id WiXToolset.WiXToolset --version 3.14.1 -e --silent --accept-package-agreements --accept-source-agreements
  if exist "C:\Program Files (x86)\WiX Toolset v3.14\bin" set "PATH=C:\Program Files (x86)\WiX Toolset v3.14\bin;%PATH%"
)
if not exist "C:\Program Files (x86)\WiX Toolset v3.14\bin\candle.exe" (
  echo ERR WiX Toolset 3.14 was not found. Install it: winget install WiXToolset.WiXToolset --version 3.14.1
  goto :fail
)

echo.
echo ==^> building (several minutes; the first build also downloads npm packages and sbt dependencies)
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\build-windows-app.ps1"
if errorlevel 1 goto :fail

echo.
echo Done. Installer is in %USERPROFILE%\dev\netlogo-chat-build\release
dir /b "%USERPROFILE%\dev\netlogo-chat-build\release\*.exe"
popd
pause
exit /b 0

:fail
echo.
popd
pause
exit /b 1

rem ---- helpers ------------------------------------------------------------------------------------------------

:find_jdk
set "JDKOK="
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\jpackage.exe" set "JDKOK=1"
if defined JDKOK exit /b 0
for /d %%D in ("C:\Program Files\Eclipse Adoptium\jdk-21*") do if exist "%%~fD\bin\jpackage.exe" call :use_jdk "%%~fD"
if defined JDKOK exit /b 0
for /d %%D in ("C:\Program Files\Java\jdk-21*") do if exist "%%~fD\bin\jpackage.exe" call :use_jdk "%%~fD"
exit /b 0

:use_jdk
if defined JDKOK exit /b 0
set "JAVA_HOME=%~1"
set "JDKOK=1"
exit /b 0
