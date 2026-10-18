@echo off
rem OLYDISCORD : installe la derniere version dans Discord (double-clic)
set "SCRIPT=%TEMP%\install-olydiscord.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing 'https://github.com/liam-thorel/olydiscord/releases/latest/download/install-olydiscord.ps1' -OutFile $env:SCRIPT"
if errorlevel 1 (
    echo Impossible de telecharger l'installeur OLYDISCORD. Verifie ta connexion internet.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
echo.
pause
