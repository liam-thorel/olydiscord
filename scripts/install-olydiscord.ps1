# OLYDISCORD — installation / désinstallation pour Windows (Windows PowerShell 5.1 ou PowerShell 7)
#
# Le plus simple : double-cliquer sur Installer-OLYDISCORD.cmd (dans la release GitHub).
# À la main :
#   & ([scriptblock]::Create((irm https://github.com/liam-thorel/olydiscord/releases/latest/download/install-olydiscord.ps1)))
#   ... -Branch ptb      pour Discord PTB (ou canary)
#   ... -Uninstall       pour revenir au Discord normal
#
# Ce que fait le script :
#   1. télécharge les fichiers d'OLYDISCORD (dernière release de liam-thorel/olydiscord) dans %APPDATA%\OLYDISCORD\dist ;
#   2. télécharge l'installeur officiel de Vencord (github.com/Vencord/Installer) et lui fait injecter ces fichiers
#      dans Discord (VENCORD_DEV_INSTALL : il charge le dossier ci-dessus au lieu du Vencord officiel) ;
#   3. ferme puis relance Discord.
# Les mises à jour arrivent ensuite toutes seules (Paramètres → Vencord → Updater).

param(
    [ValidateSet("auto", "stable", "ptb", "canary")]
    [string]$Branch = "auto",
    [switch]$Uninstall,
    # pour tester : télécharge les fichiers sans toucher à Discord
    [switch]$DownloadOnly,
    [string]$InstallDir = (Join-Path $env:APPDATA "OLYDISCORD")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest est très lent avec la barre de progression
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "liam-thorel/olydiscord"
$Files = @("patcher.js", "preload.js", "renderer.js", "renderer.css")
$InstallerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
$Headers = @{ "User-Agent" = "OLYDISCORD-installer" }

$Discords = [ordered]@{
    stable = @{ Folder = "Discord"; Exe = "Discord.exe"; Name = "Discord" }
    ptb    = @{ Folder = "DiscordPTB"; Exe = "DiscordPTB.exe"; Name = "Discord PTB" }
    canary = @{ Folder = "DiscordCanary"; Exe = "DiscordCanary.exe"; Name = "Discord Canary" }
}

function Step($message) { Write-Host "-> $message" -ForegroundColor Cyan }
function Done($message) { Write-Host "OK $message" -ForegroundColor Green }

function Get-DiscordPath($key) { Join-Path $env:LOCALAPPDATA $Discords[$key].Folder }

try {
    Write-Host ""
    Write-Host "  OLYDISCORD" -ForegroundColor Magenta
    Write-Host ""

    # ── Quel Discord ? ──────────────────────────────────────────────────────
    if ($Branch -eq "auto") {
        $Branch = $Discords.Keys | Where-Object { Test-Path (Join-Path (Get-DiscordPath $_) "Update.exe") } | Select-Object -First 1
        if (-not $Branch -and -not $DownloadOnly) {
            throw "Discord n'est pas installé sur ce PC (dossier %LOCALAPPDATA%\Discord introuvable). Installe-le depuis https://discord.com/download puis relance."
        }
    }
    if ($Branch) {
        $Target = $Discords[$Branch]
        $DiscordPath = Get-DiscordPath $Branch
        if (-not $DownloadOnly -and -not (Test-Path (Join-Path $DiscordPath "Update.exe"))) {
            throw "$($Target.Name) n'est pas installé ($DiscordPath introuvable)."
        }
    }

    $Dist = Join-Path $InstallDir "dist"
    New-Item -ItemType Directory -Force -Path $Dist | Out-Null

    # ── Fichiers d'OLYDISCORD ───────────────────────────────────────────────
    if (-not $Uninstall) {
        Step "Téléchargement de la dernière version d'OLYDISCORD"
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
        foreach ($file in $Files) {
            $asset = $release.assets | Where-Object { $_.name -eq $file } | Select-Object -First 1
            if (-not $asset) { throw "La release « $($release.name) » ne contient pas $file." }
            Invoke-WebRequest $asset.browser_download_url -OutFile (Join-Path $Dist $file) -Headers $Headers -UseBasicParsing
        }
        Done "$($release.name) téléchargé dans $Dist"
    }

    if ($DownloadOnly) {
        Done "Téléchargement seul : Discord n'a pas été modifié."
        return
    }

    # ── Installeur officiel de Vencord ──────────────────────────────────────
    Step "Téléchargement de l'installeur Vencord"
    $cli = Join-Path $InstallDir "VencordInstallerCli.exe"
    Invoke-WebRequest $InstallerUrl -OutFile $cli -Headers $Headers -UseBasicParsing

    Step "Fermeture de $($Target.Name)"
    Get-Process -Name ($Target.Exe -replace "\.exe$", "") -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2

    # l'installeur injecte <VENCORD_USER_DATA_DIR>\dist\patcher.js au lieu du Vencord officiel
    $env:VENCORD_USER_DATA_DIR = $InstallDir
    $env:VENCORD_DEV_INSTALL = "1"
    $action = if ($Uninstall) { "--uninstall" } else { "--install" }
    Step $(if ($Uninstall) { "Retrait d'OLYDISCORD de $($Target.Name)" } else { "Installation dans $($Target.Name)" })
    & $cli $action --branch $Branch
    if ($LASTEXITCODE -ne 0) { throw "L'installeur Vencord a échoué (code $LASTEXITCODE)." }

    Step "Redémarrage de $($Target.Name)"
    Start-Process (Join-Path $DiscordPath "Update.exe") -ArgumentList "--processStart", $Target.Exe

    Write-Host ""
    if ($Uninstall) {
        Done "OLYDISCORD est retiré : $($Target.Name) est revenu à la normale."
    } else {
        Done "OLYDISCORD est installé !"
        Write-Host "   Dans Discord : Paramètres > Profils > section OLYDISCORD > « Se connecter à OLYDISCORD »."
        Write-Host "   Les mises à jour arrivent toutes seules (Paramètres > Vencord > Updater)."
    }
} catch {
    Write-Host ""
    Write-Host "ERREUR : $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
