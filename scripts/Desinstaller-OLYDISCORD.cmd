@echo off
rem OLYDISCORD : remet Discord a la normale (double-clic)
set "SCRIPT=%TEMP%\install-olydiscord.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing 'https://github.com/liam-thorel/olydiscord/releases/latest/download/install-olydiscord.ps1' -OutFile $env:SCRIPT"
if errorlevel 1 (
    echo Impossible de telecharger l'installeur OLYDISCORD. Verifie ta connexion internet.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Uninstall %*
echo.
pause
