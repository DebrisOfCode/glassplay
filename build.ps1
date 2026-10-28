# Compila GlassPlay.
#
#   .\build.ps1            eseguibile Windows       -> dist\GlassPlay.exe
#   .\build.ps1 -Android   app Android (APK)        -> dist\GlassPlay.apk
#   .\build.ps1 -Legacy    app Android "legacy"     -> legacy\dist\GlassPlay-legacy.apk
#                          (TV box poco potenti, vedi legacy\README.md)
#   .\build.ps1 -Test      test unitari
#
# Con -Android e -Legacy: -Targets sceglie le architetture (aarch64, armv7, i686, x86_64) e
# -DebugBuild produce un APK di debug (ispezionabile con chrome://inspect).
#
# Usa la toolchain predefinita di rustup anche se nel PATH c'è un altro "cargo"
# (per esempio una versione GNU installata da un gestore di pacchetti).
param([switch]$Test, [switch]$Android, [switch]$Legacy, [switch]$DebugBuild, [string[]]$Targets)

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

# Architetture Android: nome per Tauri -> triple di Rust, ABI e nome usato da Gradle.
$AndroidAbis = @{
    aarch64 = @{ triple = 'aarch64-linux-android'; abi = 'arm64-v8a'; arch = 'arm64' }
    armv7   = @{ triple = 'armv7-linux-androideabi'; abi = 'armeabi-v7a'; arch = 'arm' }
    i686    = @{ triple = 'i686-linux-android'; abi = 'x86'; arch = 'x86' }
    x86_64  = @{ triple = 'x86_64-linux-android'; abi = 'x86_64'; arch = 'x86_64' }
}

# Compila l'APK con la configurazione indicata e restituisce il percorso del file prodotto.
function Build-Apk([string[]]$extra) {
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
    # Librerie native di compilazioni precedenti: finirebbero nell'APK anche per architetture non richieste.
    $jniLibs = Join-Path $root 'src-tauri\gen\android\app\src\main\jniLibs'
    Remove-Item -Recurse -Force $jniLibs -ErrorAction SilentlyContinue
    $base = @('tauri', 'android', 'build', '--apk') + $extra
    if ($DebugBuild) { $base += '--debug' }
    $cmd = $base
    if ($Targets) { $cmd += @('--target') + $Targets }
    $kind = if ($DebugBuild) { 'debug' } else { 'release' }
    Push-Location (Join-Path $root 'src-tauri')
    try {
        if (-not (Test-Path 'gen\android')) {
            & $cargo tauri android init | Out-Host
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        # Out-Host: l'output della compilazione non deve finire nel valore restituito.
        & $cargo @cmd | Out-Host
        if ($LASTEXITCODE -ne 0) {
            # Tauri mette la libreria Rust nel progetto Android con un collegamento simbolico, che
            # Windows permette solo in "modalità sviluppatore". Senza, si ferma subito dopo la
            # compilazione, lasciando vuota la cartella jniLibs\<abi>: allora la libreria si copia
            # qui, un'architettura alla volta, e l'APK si assembla direttamente con Gradle.
            if (-not (Test-Path $jniLibs)) { exit $LASTEXITCODE } # errore prima: compilazione non riuscita
            Write-Warning 'Collegamenti simbolici non permessi (modalità sviluppatore di Windows disattivata): copio le librerie.'
            $list = if ($Targets) { $Targets } else { @('aarch64', 'armv7', 'i686', 'x86_64') }
            foreach ($t in $list) {
                $abi = $AndroidAbis[$t]
                if (-not $abi) { Write-Error "Architettura sconosciuta: $t"; exit 1 }
                & $cargo @($base + @('--target', $t)) | Out-Host
                $lib = Join-Path $root "src-tauri\target\$($abi.triple)\$kind\libglassplay_lib.so"
                if (-not (Test-Path (Join-Path $jniLibs $abi.abi)) -or -not (Test-Path $lib)) { Write-Error "Compilazione per $t non riuscita"; exit 1 }
                Copy-Item $lib (Join-Path $jniLibs $abi.abi) -Force
            }
            $gradleProfile = if ($DebugBuild) { 'Debug' } else { 'Release' }
            $gradle = @(
                "assembleUniversal$gradleProfile",
                "-PabiList=$(($list | ForEach-Object { $AndroidAbis[$_].abi }) -join ',')",
                "-ParchList=$(($list | ForEach-Object { $AndroidAbis[$_].arch }) -join ',')",
                "-PtargetList=$($list -join ',')",
                # La libreria è già al suo posto: niente compilazione Rust dentro Gradle.
                '-x', "rustBuildUniversal$gradleProfile", '--warn'
            )
            & (Join-Path $root 'src-tauri\gen\android\gradlew.bat') --project-dir (Join-Path $root 'src-tauri\gen\android') @gradle | Out-Host
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    } finally {
        Pop-Location
    }
    $apk = Get-ChildItem (Join-Path $root 'src-tauri\gen\android\app\build\outputs\apk') -Recurse -Filter '*.apk' |
        Where-Object { $_.FullName -match "\\$kind\\" } | Sort-Object LastWriteTime | Select-Object -Last 1
    return $apk.FullName
}

if ($Android) {
    New-Item -ItemType Directory -Force $dist | Out-Null
    $apk = Build-Apk @()
    Copy-Item $apk (Join-Path $dist 'GlassPlay.apk') -Force
    Write-Host "Pronto: $dist\GlassPlay.apk"
    exit 0
}

if ($Legacy) {
    # Interfaccia della versione legacy: quella normale più legacy\lite.css e legacy\lite.js,
    # preparata in legacy\build\ui (non nel repository) e convertita per le WebView vecchie.
    $legacyDir = Join-Path $root 'legacy'
    $stage = Join-Path $legacyDir 'build\ui'
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item (Join-Path $root 'ui\*') $stage -Recurse
    Copy-Item (Join-Path $legacyDir 'lite.css'), (Join-Path $legacyDir 'lite.js') $stage
    $index = Join-Path $stage 'index.html'
    $html = [IO.File]::ReadAllText($index)
    $link = '<link rel="stylesheet" href="style.css">'
    if (-not $html.Contains($link)) { Write-Error "index.html: riga dello stile non trovata ($link)"; exit 1 }
    $html = $html.Replace($link, "$link`n  <link rel=`"stylesheet`" href=`"lite.css`">`n  <script src=`"lite.js`"></script>")
    [IO.File]::WriteAllText($index, $html)

    # JavaScript e CSS riscritti per Chromium 66 (la WebView di serie di Android 9) e compressi.
    # hls.js è già compatibile. Serve Node.js; senza, l'app funziona solo con WebView aggiornate.
    if (Get-Command npx -ErrorAction SilentlyContinue) {
        Push-Location $stage
        try {
            & npx --yes esbuild@0.24.2 app.js i18n.js lite.js style.css lite.css --target=chrome66 --minify --outdir=. --allow-overwrite --log-level=warning
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally {
            Pop-Location
        }
    } else {
        Write-Warning 'Node.js (npx) non trovato: interfaccia non convertita per le WebView più vecchie.'
    }

    # Solo ARM: i TV box non hanno processori x86 (APK più piccolo).
    if (-not $Targets) { $Targets = @('armv7', 'aarch64') }
    # adult-filter: le liste escludono i canali per adulti (src-tauri\src\adult.rs).
    $apk = Build-Apk @('--config', (Join-Path $legacyDir 'tauri.legacy.conf.json'), '--features', 'adult-filter')
    $out = Join-Path $legacyDir 'dist'
    New-Item -ItemType Directory -Force $out | Out-Null
    Copy-Item $apk (Join-Path $out 'GlassPlay-legacy.apk') -Force
    Write-Host "Pronto: $out\GlassPlay-legacy.apk"
    exit 0
}

New-Item -ItemType Directory -Force $dist | Out-Null
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
