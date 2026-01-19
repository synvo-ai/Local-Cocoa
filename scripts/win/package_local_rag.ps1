[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "The working directory")]
    [string]$ROOT_DIR
)

$ErrorActionPreference = "Stop"

$SERVICES_DIR = Join-Path $ROOT_DIR "services"
$DIST_DIR = Join-Path $ROOT_DIR "runtime\local_rag_dist"
$BUILD_DIR = Join-Path $ROOT_DIR "build\pyinstaller"
$PACKAGE_NAME = "services"

if (-not (Test-Path $SERVICES_DIR)) {
    Write-Error "Services directory not found: $SERVICES_DIR"
    exit 1
}

# Find Python
$PYTHON_BIN = Get-Command python -ErrorAction SilentlyContinue
if (-not $PYTHON_BIN) {
    $PYTHON_BIN = Get-Command py -ErrorAction SilentlyContinue
}

if (-not $PYTHON_BIN) {
    Write-Error "Python not found. Please install Python."
    exit 1
}

Write-Host "Using Python: $($PYTHON_BIN.Source)"

# Clean up previous builds
if (Test-Path $DIST_DIR) {
    Remove-Item -Path $DIST_DIR -Recurse -Force
}
if (Test-Path $BUILD_DIR) {
    Remove-Item -Path $BUILD_DIR -Recurse -Force
}
New-Item -ItemType Directory -Path $DIST_DIR | Out-Null
New-Item -ItemType Directory -Path $BUILD_DIR | Out-Null

# Create build venv
Write-Host "Creating build virtual environment..."
& $PYTHON_BIN -m venv (Join-Path $BUILD_DIR "venv")

$VENV_PY = Join-Path $BUILD_DIR "venv\Scripts\python.exe"
$VENV_PIP = Join-Path $BUILD_DIR "venv\Scripts\pip.exe"

# Install dependencies + PyInstaller
Write-Host "Installing dependencies..."
& $VENV_PY -m pip install --upgrade pip wheel
& $VENV_PIP install -r (Join-Path $SERVICES_DIR "app\requirements.txt")
& $VENV_PIP install pyinstaller

# Copy source files to build directory
Write-Host "Preparing source files..."
$DEST_PACKAGE_DIR = Join-Path $BUILD_DIR "services"
New-Item -ItemType Directory -Path $DEST_PACKAGE_DIR | Out-Null
Copy-Item -Path "$SERVICES_DIR\*" -Destination $DEST_PACKAGE_DIR -Recurse -Force -Exclude "__pycache__", "*.pyc", ".mypy_cache", ".pytest_cache", ".DS_Store", "*.spec"

# Copy plugins directory to build directory as well (for relative path resolution in context.py)
$PLUGINS_DIR = Join-Path $ROOT_DIR "plugins"
if (Test-Path $PLUGINS_DIR) {
    Write-Host "Copying plugins to build directory..."
    $DEST_PLUGINS_DIR = Join-Path $BUILD_DIR "plugins"
    New-Item -ItemType Directory -Path $DEST_PLUGINS_DIR | Out-Null
    Copy-Item -Path "$PLUGINS_DIR\*" -Destination $DEST_PLUGINS_DIR -Recurse -Force -Exclude "__pycache__", "*.pyc", ".DS_Store"
}

# Copy main.py entry point
Copy-Item -Path (Join-Path $SERVICES_DIR "app\main.py") -Destination (Join-Path $BUILD_DIR "main.py")

# Run PyInstaller
Write-Host "Running PyInstaller (this may take several minutes)..."
Push-Location $BUILD_DIR

& $VENV_PY -m PyInstaller `
    --name local_rag_server `
    --distpath $DIST_DIR `
    --workpath (Join-Path $BUILD_DIR "work") `
    --specpath $BUILD_DIR `
    --paths $BUILD_DIR `
    --paths (Join-Path $BUILD_DIR "plugins") `
    --noconfirm `
    --clean `
    --collect-all uvicorn `
    --collect-all fastapi `
    --collect-all pydantic `
    --collect-all starlette `
    --collect-all qdrant_client `
    --collect-all tiktoken `
    --collect-all rapidocr_onnxruntime `
    --collect-all onnxruntime `
    --collect-all langdetect `
    --collect-all certifi `
    --collect-all services `
    --collect-all magika `
    --collect-all markitdown `
    --collect-all grpcio `
    --collect-all azure `
    --collect-all msal `
    --collect-all msgraph `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.protocols.websockets.auto `
    --hidden-import uvicorn.lifespan.on `
    --hidden-import email_validator `
    --hidden-import multipart `
    --hidden-import PIL `
    --hidden-import cv2 `
    --hidden-import numpy `
    --hidden-import fitz `
    --hidden-import xxhash `
    --hidden-import markdownify `
    --hidden-import markdown_it `
    --hidden-import msal `
    --hidden-import msal_extensions `
    --hidden-import azure.identity `
    --hidden-import msgraph `
    --hidden-import onnx `
    --hidden-import email `
    --exclude-module tkinter `
    --exclude-module matplotlib `
    --exclude-module scipy `
    --exclude-module pandas `
    --exclude-module torch `
    --exclude-module tensorflow `
    main.py

Pop-Location

# Copy llama-cpp binaries (including DLLs)
$LLAMA_CPP_SRC = Join-Path $ROOT_DIR "runtime\llama-cpp"
$LLAMA_CPP_DEST = Join-Path $DIST_DIR "llama-cpp"

if (Test-Path $LLAMA_CPP_SRC) {
    New-Item -ItemType Directory -Path $LLAMA_CPP_DEST -Force | Out-Null
    # Copy .exe and .dll files
    Get-ChildItem -Path $LLAMA_CPP_SRC -Include "*.exe", "*.dll" -Recurse | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $LLAMA_CPP_DEST -Force
    }
    Write-Host "Copied llama-cpp binaries into $LLAMA_CPP_DEST."
}
else {
    Write-Warning "llama-cpp not found at $LLAMA_CPP_SRC; skipping binary bundle."
}

# Create run.ps1 launcher
$RUN_PS1 = Join-Path $DIST_DIR "run.ps1"
$RUN_PS1_CONTENT = @"
`$ErrorActionPreference = "Stop"
`$ROOT_DIR = `$PSScriptRoot

# Check for PyInstaller bundle
`$EXECUTABLE = Join-Path `$ROOT_DIR "local_rag_server\local_rag_server.exe"
if (Test-Path `$EXECUTABLE) {
    & `$EXECUTABLE @args
    exit `$LASTEXITCODE
}

Write-Error "local_rag_server.exe not found in `$ROOT_DIR"
exit 1
"@
Set-Content -Path $RUN_PS1 -Value $RUN_PS1_CONTENT

# Create run.sh for compatibility (e.g. if run in git bash)
$RUN_SH = Join-Path $DIST_DIR "run.sh"
$RUN_SH_CONTENT = @"
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="`$(cd "`$(dirname "`${BASH_SOURCE[0]}")" && pwd)"

# Check for PyInstaller bundle
if [ -d "`$ROOT_DIR/local_rag_server" ] && [ -x "`$ROOT_DIR/local_rag_server/local_rag_server.exe" ]; then
    exec "`$ROOT_DIR/local_rag_server/local_rag_server.exe" "`$@"
fi

echo "local_rag_server.exe not found in `$ROOT_DIR" >&2
exit 1
"@
Set-Content -Path $RUN_SH -Value $RUN_SH_CONTENT -Encoding ASCII

# Write README
$README = Join-Path $DIST_DIR "README.md"
$README_CONTENT = @"
# Local RAG Agent Distribution

This directory is generated by ``scripts/win/package_local_rag.ps1`` using PyInstaller.
It contains a standalone executable that includes all Python dependencies.
Run ``.\run.ps1`` to start the FastAPI service.

Environment variables:
- LOCAL_RAG_HOST: Host to bind to (default: 127.0.0.1)
- LOCAL_RAG_PORT: Port to listen on (default: 8890)
- LOCAL_RAG_HOME: Data directory for RAG storage

The ``llama-cpp`` folder contains the llama.cpp server binaries.
"@
Set-Content -Path $README -Value $README_CONTENT

# Cleanup build directory
Write-Host "Cleaning up build artifacts..."
Remove-Item -Path $BUILD_DIR -Recurse -Force

Write-Host ""
Write-Host "Successfully packaged $PACKAGE_NAME into $DIST_DIR" -ForegroundColor Green
Write-Host ""
Write-Host "Distribution layout:"
Get-ChildItem $DIST_DIR | Format-Table Name, Length
