#!/usr/bin/env bash
set -euo pipefail

HAS_TTY=0
if [ -t 1 ]; then
  HAS_TTY=1
fi

run_with_spinner() {
  local label="$1"
  shift

  if [ "$HAS_TTY" -eq 0 ]; then
    echo "${label}..."
    "$@"
    return
  fi

  local spinner='|/-\'
  local i=0

  echo "${label}..."
  "$@" &
  local cmd_pid=$!

  (
    while kill -0 "$cmd_pid" >/dev/null 2>&1; do
      printf '\r[%c] %s' "${spinner:i%4:1}" "${label}..."
      i=$(((i + 1) % 4))
      sleep 0.2
    done
  ) &
  local spinner_pid=$!

  wait "$cmd_pid"
  local cmd_status=$?

  kill "$spinner_pid" >/dev/null 2>&1 || true
  wait "$spinner_pid" >/dev/null 2>&1 || true

  if [ "$cmd_status" -eq 0 ]; then
    printf '\r[✔] %s\n' "${label}"
  else
    printf '\r[✖] %s (failed)\n' "${label}"
  fi

  return "$cmd_status"
}

# Packages the backend services into runtime/local_rag_dist using PyInstaller.
# This creates a standalone executable that doesn't require Python to be installed.
ROOT_DIR=$1

SERVICES_DIR="${ROOT_DIR}/services"
DIST_DIR="${ROOT_DIR}/runtime/local_rag_dist"
BUILD_DIR="${ROOT_DIR}/build/pyinstaller"
REQUESTED_PYTHON_VERSION="${PYTHON_VERSION:-3.11.11}"
REQUESTED_PYTHON_BIN="${PYTHON_BIN:-}"
PACKAGE_NAME="services"

if [ ! -d "${SERVICES_DIR}" ]; then
  echo "Services directory not found: ${SERVICES_DIR}" >&2
  exit 1
fi

if [ -n "${REQUESTED_PYTHON_BIN}" ]; then
  if [ ! -x "${REQUESTED_PYTHON_BIN}" ]; then
    echo "PYTHON_BIN points to a non-executable interpreter: ${REQUESTED_PYTHON_BIN}" >&2
    exit 1
  fi
  PYTHON_BIN="${REQUESTED_PYTHON_BIN}"
else
  PYTHON_BIN=""
  MAJOR_MINOR="${REQUESTED_PYTHON_VERSION%.*}"
  for candidate in "python${MAJOR_MINOR}" "python${MAJOR_MINOR//./}" "python3" "python"; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "${candidate}")"
      break
    fi
  done

  if [ -z "${PYTHON_BIN}" ]; then
    if ! command -v pyenv >/dev/null 2>&1; then
      echo "No suitable Python interpreter found. Install python${MAJOR_MINOR}, set PYTHON_BIN, or install pyenv." >&2
      exit 1
    fi
    echo "Using pyenv to provision Python ${REQUESTED_PYTHON_VERSION}."
    pyenv install -s "${REQUESTED_PYTHON_VERSION}"
    PYENV_ROOT="$(pyenv root)"
    PYTHON_BIN="${PYENV_ROOT}/versions/${REQUESTED_PYTHON_VERSION}/bin/python3"
  fi
fi

if [ ! -x "${PYTHON_BIN}" ]; then
  echo "Unable to execute Python interpreter at ${PYTHON_BIN}." >&2
  exit 1
fi

PY_VERSION_LABEL="$(${PYTHON_BIN} -c 'import platform; print(platform.python_version())')"
echo "Using Python ${PY_VERSION_LABEL} at ${PYTHON_BIN}"

# Clean up previous build artifacts
rm -rf "${DIST_DIR}"
rm -rf "${BUILD_DIR}"
mkdir -p "${DIST_DIR}"
mkdir -p "${BUILD_DIR}"

# Create a temporary venv for building
VENV_DIR="${BUILD_DIR}/venv"
echo "Creating build virtual environment..."
"${PYTHON_BIN}" -m venv "${VENV_DIR}"
VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

# Install dependencies + PyInstaller
echo "Installing dependencies..."
"${VENV_PY}" -m pip install --upgrade pip wheel
"${VENV_PIP}" install -r "${SERVICES_DIR}/app/requirements.txt"
"${VENV_PIP}" install pyinstaller

# Copy source files to build directory
echo "Preparing source files..."
mkdir -p "${BUILD_DIR}/services"
rsync -a \
  --exclude "__pycache__" \
  --exclude "*.pyc" \
  --exclude ".mypy_cache" \
  --exclude ".pytest_cache" \
  --exclude ".DS_Store" \
  --exclude "*.spec" \
  "${SERVICES_DIR}/" "${BUILD_DIR}/services/"

# Copy plugins directory to build directory as well (for relative path resolution in context.py)
PLUGINS_DIR="${ROOT_DIR}/plugins"
if [ -d "${PLUGINS_DIR}" ]; then
  echo "Copying plugins to build directory..."
  mkdir -p "${BUILD_DIR}/plugins"
  rsync -a \
    --exclude "__pycache__" \
    --exclude "*.pyc" \
    --exclude ".DS_Store" \
    --exclude ".pytest_cache" \
    "${PLUGINS_DIR}/" "${BUILD_DIR}/plugins/"
fi


# Copy main.py entry point
cp "${SERVICES_DIR}/app/main.py" "${BUILD_DIR}/main.py"

# Run PyInstaller
echo "Running PyInstaller (this may take several minutes)..."
cd "${BUILD_DIR}"

# Create a simpler inline spec to avoid import issues
"${VENV_PY}" -m PyInstaller \
  --name local_rag_server \
  --distpath "${DIST_DIR}" \
  --workpath "${BUILD_DIR}/work" \
  --specpath "${BUILD_DIR}" \
  --noconfirm \
  --clean \
  --collect-all uvicorn \
  --collect-all fastapi \
  --collect-all pydantic \
  --collect-all starlette \
  --collect-all qdrant_client \
  --collect-all tiktoken \
  --collect-all rapidocr_onnxruntime \
  --collect-all onnxruntime \
  --collect-all langdetect \
  --collect-all certifi \
  --collect-all services \
  --collect-all magika \
  --collect-all markitdown \
  --collect-all grpcio \
  --collect-all azure \
  --collect-all msal \
  --collect-all msgraph \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import email_validator \
  --hidden-import multipart \
  --hidden-import PIL \
  --hidden-import cv2 \
  --hidden-import numpy \
  --hidden-import fitz \
  --hidden-import xxhash \
  --hidden-import markdownify \
  --hidden-import markdown_it \
  --hidden-import msal \
  --hidden-import msal_extensions \
  --hidden-import azure.identity \
  --hidden-import msgraph \
  --hidden-import onnx \
  --hidden-import email \
  --exclude-module tkinter \
  --exclude-module matplotlib \
  --exclude-module scipy \
  --exclude-module pandas \
  --exclude-module torch \
  --exclude-module tensorflow \
  --paths "${BUILD_DIR}" \
  --paths "${BUILD_DIR}/plugins" \
  main.py

cd "${ROOT_DIR}"

# Prepare llama-cpp binaries (copy dylibs and fix rpath)
LLAMA_CPP_BIN="${ROOT_DIR}/runtime/llama-cpp/bin"
LLAMA_CPP_BUILD_BIN="${ROOT_DIR}/runtime/llama-cpp/build/bin"

if [ -d "${LLAMA_CPP_BUILD_BIN}" ] && [ -d "${LLAMA_CPP_BIN}" ]; then
  echo "Preparing llama-cpp binaries..."
  
  # Copy dylib files to bin directory
  if ls "${LLAMA_CPP_BUILD_BIN}"/*.dylib 1> /dev/null 2>&1; then
    cp "${LLAMA_CPP_BUILD_BIN}"/*.dylib "${LLAMA_CPP_BIN}/"
    echo "  - Copied dylib files to bin directory"
  fi
  
  # Fix rpath in llama-server (macOS only)
  if [ "$(uname)" = "Darwin" ] && [ -f "${LLAMA_CPP_BIN}/llama-server" ]; then
    # Remove any existing hardcoded rpath and add relative path
    install_name_tool -delete_rpath "${LLAMA_CPP_BUILD_BIN}" "${LLAMA_CPP_BIN}/llama-server" 2>/dev/null || true
    # Check if @executable_path is already in rpath
    if ! otool -l "${LLAMA_CPP_BIN}/llama-server" | grep -q "@executable_path"; then
      install_name_tool -add_rpath "@executable_path" "${LLAMA_CPP_BIN}/llama-server" 2>/dev/null || true
    fi
    echo "  - Fixed rpath in llama-server"
  fi
fi

# Copy llama-cpp binaries to dist
LLAMA_CPP_SRC="${ROOT_DIR}/runtime/llama-cpp/bin"
LLAMA_CPP_DEST="${DIST_DIR}/llama-cpp/bin"
if [ -d "${LLAMA_CPP_SRC}" ]; then
  mkdir -p "${LLAMA_CPP_DEST}"
  rsync -a "${LLAMA_CPP_SRC}/" "${LLAMA_CPP_DEST}/"
  echo "Copied llama-cpp binaries into ${LLAMA_CPP_DEST}."
else
  echo "Warning: llama-cpp/bin not found at ${LLAMA_CPP_SRC}; skipping binary bundle." >&2
fi

# Write launcher script
echo "Writing launcher to ${DIST_DIR}/run.sh..."
cat > "${DIST_DIR}/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for PyInstaller bundle first
if [ -d "${ROOT_DIR}/local_rag_server" ] && [ -x "${ROOT_DIR}/local_rag_server/local_rag_server" ]; then
  exec "${ROOT_DIR}/local_rag_server/local_rag_server" "$@"
fi

# Fallback to standalone executable
if [ -x "${ROOT_DIR}/local_rag_server" ]; then
  exec "${ROOT_DIR}/local_rag_server" "$@"
fi

echo "local_rag_server executable not found in ${ROOT_DIR}" >&2
exit 1
EOF
chmod +x "${DIST_DIR}/run.sh"

# Write README
echo "Writing README to ${DIST_DIR}/README.md..."
cat > "${DIST_DIR}/README.md" <<EOF
# Local RAG Agent Distribution

This directory is generated by \`scripts/linux/package_local_rag.sh\` using Python ${PY_VERSION_LABEL}.
It contains a standalone PyInstaller bundle that includes all Python dependencies.
Run \`./run.sh\` to start the FastAPI service.

Environment variables:
- LOCAL_RAG_HOST: Host to bind to (default: 127.0.0.1)
- LOCAL_RAG_PORT: Port to listen on (default: 8890)
- LOCAL_RAG_HOME: Data directory for RAG storage
- LOCAL_LLM_URL, LOCAL_EMBEDDING_URL, LOCAL_RERANK_URL: Service URLs

The \`llama-cpp/bin\` folder contains the llama.cpp server binaries.
EOF

# Cleanup build directory
echo "Cleaning up build artifacts..."
rm -rf "${BUILD_DIR}"

echo ""
echo "✅ Successfully packaged ${PACKAGE_NAME} into ${DIST_DIR}"
echo "   Using Python ${PY_VERSION_LABEL}"
echo ""
echo "Distribution layout:"
ls -la "${DIST_DIR}"
echo ""
if [ -d "${DIST_DIR}/local_rag_server" ]; then
  echo "PyInstaller bundle contents:"
  ls -la "${DIST_DIR}/local_rag_server" | head -20
fi
