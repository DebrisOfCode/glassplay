# Compila GlassPlay.
#
#   .\build.ps1            eseguibile Windows  -> dist\GlassPlay.exe
#   .\build.ps1 -Android   app Android (APK)   -> dist\GlassPlay.apk
#   .\build.ps1 -Test      test unitari
#
# Usa la toolchain predefinita di rustup anche se nel PATH c'è un altro "cargo"
# (per esempio una versione GNU installata da un gestore di pacchetti).
param([switch]$Test, [switch]$Android)

$root = $PSScriptRoot
$manifest = Join-Path $root 'src-tauri\Cargo.toml'
$dist = Join-Path $root 'dist'

if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $cargo = rustup which cargo
    $env:RUSTC = rustup which rustc
    $env:RUSTDOC = rustup which rustdoc
} else {
    $cargo = 'cargo'
}

# Nei binari Rust restano i percorsi dei sorgenti (cartella utente, registro di cargo):
# li sostituiamo con nomi neutri, così gli eseguibili distribuiti non contengono dati personali.
$sep = [char]0x1F
$remap = @("--remap-path-prefix=$root=glassplay", "--remap-path-prefix=$HOME=~")
if ($env:CARGO_HOME) { $remap += "--remap-path-prefix=$($env:CARGO_HOME)=cargo" }
if ($env:RUSTUP_HOME) { $remap += "--remap-path-prefix=$($env:RUSTUP_HOME)=rustup" }
$env:CARGO_ENCODED_RUSTFLAGS = $remap -join $sep

if ($Test) {
    & $cargo test --manifest-path $manifest
    exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force $dist | Out-Null

if ($Android) {
    if (-not $env:ANDROID_HOME) {
        $default = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
        if (Test-Path $default) { $env:ANDROID_HOME = $default } else { Write-Error 'Android SDK non trovato: imposta ANDROID_HOME'; exit 1 }
    }
    if (-not $env:NDK_HOME) {
        # L'NDK più recente installato nell'SDK.
        $ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue |
            Sort-Object { [version]$_.Name } | Select-Object -Last 1
        if (-not $ndk) { Write-Error "NDK non trovato in $env:ANDROID_HOME\ndk"; exit 1 }
        $env:NDK_HOME = $ndk.FullName
    }
    Push-Location (Join-Path $root 'src-tauri')
    try {
        if (-not (Test-Path 'gen\android')) {
            & $cargo tauri android init
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        & $cargo tauri android build --apk
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
    $apk = Get-ChildItem (Join-Path $root 'src-tauri\gen\android\app\build\outputs\apk') -Recurse -Filter '*.apk' |
        Sort-Object LastWriteTime | Select-Object -Last 1
    Copy-Item $apk.FullName (Join-Path $dist 'GlassPlay.apk') -Force
    Write-Host "Pronto: $dist\GlassPlay.apk"
    exit 0
}

& $cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$built = Join-Path $root 'src-tauri\target\release\glassplay.exe'
try {
    Copy-Item $built (Join-Path $dist 'GlassPlay.exe') -Force -ErrorAction Stop
    Write-Host "Pronto: $dist\GlassPlay.exe"
} catch {
    # Succede se GlassPlay è aperto: l'eseguibile nuovo resta comunque in target\release.
    Write-Warning "Impossibile aggiornare dist\GlassPlay.exe (l'app è aperta?). Eseguibile nuovo: $built"
    exit 1
}
