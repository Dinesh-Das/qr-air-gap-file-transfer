@echo off
setlocal DisableDelayedExpansion
set "QRFT_NODE=%~dp0runtime\node.exe"
if exist "%QRFT_NODE%" goto launch
for %%I in (node.exe) do set "QRFT_NODE=%%~$PATH:I"
if not defined QRFT_NODE goto missing_runtime

:launch
"%QRFT_NODE%" "%~dp0scripts\launch.mjs"
set "QRFT_LAUNCH_EXIT=%errorlevel%"
if not "%QRFT_LAUNCH_EXIT%"=="0" pause
exit /b %QRFT_LAUNCH_EXIT%

:missing_runtime
echo AirGap QR could not find its required runtime.
echo Ask the person who supplied this app for a complete Windows setup.
echo Details: this copy needs its bundled runtime or a supported Node.js installation.
pause
exit /b 1
