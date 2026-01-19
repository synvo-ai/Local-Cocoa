import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { config } from './config';
import { createDebugLogger } from './debug';
import { setSessionToken } from './backendClient';

export class PythonServer {
    private process: ChildProcess | null = null;
    private executablePath: string;
    private scriptPath: string;
    private sessionToken: string | null = null;

    constructor() {
        this.scriptPath = config.paths.backendScript;

        // In production, look for the PyInstaller bundle
        if (!config.isDev) {
            const resourcesPath = process.resourcesPath;
            // PyInstaller creates a folder with the executable inside
            // On Windows it's .exe, on macOS/Linux no extension
            const exeName = process.platform === 'win32' ? 'local_rag_server.exe' : 'local_rag_server';
            const bundlePath = path.join(resourcesPath, 'local_rag_dist', 'local_rag_server', exeName);
            if (fs.existsSync(bundlePath)) {
                this.executablePath = bundlePath;
            } else {
                // Fallback to the shell/ps1 script
                this.executablePath = '';
            }
        } else {
            this.executablePath = '';
        }
    }

    async start(envOverrides: Record<string, string> = {}): Promise<void> {
        const debugLog = createDebugLogger('PythonServer');

        // Skip starting Python server if SKIP_PYTHON_SERVER is set
        // Useful when debugging backend separately via VS Code
        if (process.env.SKIP_PYTHON_SERVER === '1') {
            console.log('[Backend] Skipping Python server start (SKIP_PYTHON_SERVER=1)');
            return;
        }

        if (this.process) {
            console.log('[Backend] Python server already running');
            return;
        }

        const port = config.ports.backend;

        // Kill any existing process on the backend port
        try {
            if (process.platform === 'win32') {
                const output = execSync(`netstat -ano | findstr :${port}`).toString();
                const lines = output.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length > 4 && parts[1].endsWith(`:${port}`)) {
                        const pid = parts[parts.length - 1];
                        if (pid && pid !== '0') {
                            execSync(`taskkill /F /PID ${pid}`);
                        }
                    }
                }
            } else {
                const pid = execSync(`lsof -t -i:${port}`).toString().trim();
                if (pid) {
                    execSync(`kill -9 ${pid}`);
                }
            }
        } catch (e) {
            // No existing process found - this is expected
        }

        debugLog(`Starting from ${this.scriptPath}`);

        // Data paths differ between dev and production:
        // - Dev mode: Use {projectRoot}/runtime/ for easy debugging and data isolation
        // - Prod mode: Use ~/Library/Application Support/Local Cocoa/ (standard app data location)
        let ragHome: string;
        let logsDir: string;
        if (config.isDev) {
            // In dev mode, store data in project's runtime directory
            ragHome = path.join(config.projectRoot, 'runtime', 'local_rag');
            logsDir = path.join(config.projectRoot, 'runtime', 'logs');
        } else {
            // In production, use Electron's standard userData path
            const userDataPath = app.getPath('userData');
            ragHome = path.join(userDataPath, 'local_rag');
            logsDir = path.join(userDataPath, 'logs');
        }
        const milvusUri = path.join(ragHome, 'rag.milvus.db');

        // Ensure the directory exists
        if (!fs.existsSync(ragHome)) {
            console.log(`[Backend] Creating directory: ${ragHome}`);
            fs.mkdirSync(ragHome, { recursive: true });
        }

        // Force kill any process holding the database file
        try {
            if (process.platform !== 'win32') {
                const pids = execSync(`lsof -t "${milvusUri}"`).toString().trim().split('\n');
                for (const pid of pids) {
                    if (pid) {
                        execSync(`kill -9 ${pid}`);
                    }
                }
            }
        } catch (e) {
            // Ignore if no process found
        }

        // Clean up potential lock files from crashed sessions
        const lockFile = `${milvusUri}.lock`;
        if (fs.existsSync(lockFile)) {
            try {
                fs.unlinkSync(lockFile);
            } catch (e) {
                // ignore
            }
        }

        // Ensure PATH includes common system directories
        // This is important when launched from Finder (double-click .app) where PATH is minimal
        // On Windows, PATH separator is ';', on Unix it's ':'
        const isWin = process.platform === 'win32';
        const pathSep = isWin ? ';' : ':';
        const systemPath = isWin 
            ? '' // Windows doesn't need additional system paths
            : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
        const existingPath = process.env.PATH || '';
        const fullPath = systemPath 
            ? (existingPath ? `${existingPath}${pathSep}${systemPath}` : systemPath)
            : existingPath;

        // Ensure logs directory exists
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        const env = {
            ...process.env,
            ...envOverrides,
            // Ensure essential environment variables are set for GUI-launched apps
            PATH: fullPath,
            HOME: process.env.HOME || app.getPath('home'),
            TMPDIR: process.env.TMPDIR || app.getPath('temp'),
            // Locale settings to avoid encoding issues
            LANG: process.env.LANG || 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
            // App-specific environment variables (use absolute paths for packaged apps)
            LOCAL_RAG_PORT: config.ports.backend.toString(),
            LOCAL_RAG_HOME: ragHome,
            LOCAL_MILVUS_URI: milvusUri,
            LOCAL_QDRANT_PATH: path.join(ragHome, 'qdrant_data'),
            LOCAL_AGENT_LOG_PATH: path.join(logsDir, 'local_agent.log'),
            LOCAL_LLM_URL: process.env.LOCAL_LLM_URL ?? `http://127.0.0.1:${config.ports.vlm}`,
            LOCAL_VISION_URL: process.env.LOCAL_VISION_URL ?? `http://127.0.0.1:${config.ports.vlm}`,
            LOCAL_EMBEDDING_URL: process.env.LOCAL_EMBEDDING_URL ?? `http://127.0.0.1:${config.ports.embedding}`,
            LOCAL_RERANK_URL: process.env.LOCAL_RERANK_URL ?? `http://127.0.0.1:${config.ports.reranker}`,
            // Memory extraction settings
            LOCAL_ENABLE_MEMORY_EXTRACTION: process.env.LOCAL_ENABLE_MEMORY_EXTRACTION ?? 'true',
            LOCAL_MEMORY_USER_ID: process.env.LOCAL_MEMORY_USER_ID ?? 'default_user',
            PYTHONPATH: '',
            PYTHONUNBUFFERED: '1',
            // Bypass proxy for localhost connections
            no_proxy: 'localhost,127.0.0.1,0.0.0.0',
            NO_PROXY: 'localhost,127.0.0.1,0.0.0.0'
        };

        try {
            if (this.executablePath && fs.existsSync(this.executablePath)) {
                // Use PyInstaller executable directly
                debugLog(`Using PyInstaller executable: ${this.executablePath}`);
                this.process = spawn(this.executablePath, [], {
                    env,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } else if (config.isDev) {
                // Dev mode: Spawn using node launcher script or direct python/uvicorn
                // We'll spawn the launch-backend.js script using 'node' but we need to ensure stdout is piped
                // Actually, launching the node script adds a layer. 
                // Let's emulate launch-backend.js logic here using the venv python.

                const rootDir = config.projectRoot;
                const venvDir = path.join(rootDir, '.venv');
                const isWin = process.platform === 'win32';
                let pythonPath = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

                if (!fs.existsSync(pythonPath)) {
                    // Fallback to searching PATH or just 'python'
                    debugLog(`Venv python not found at ${pythonPath}, trying 'python3' or 'python'`);
                    // This is risky, but try generic 'python'
                    pythonPath = 'python';
                }

                // Match arguments from launch-backend.js
                // -m uvicorn services.app.app:app --host ... --port ... --reload
                const args = [
                    '-m', 'uvicorn',
                    'services.app.app:app',
                    '--host', '127.0.0.1', // Env var usually, but default is fine
                    '--port', config.ports.backend.toString(),
                    '--reload',
                    '--reload-dir', path.join(rootDir, 'services'),
                    '--reload-dir', path.join(rootDir, 'config')
                ];

                // PYTHONPATH should be rootDir so 'services.app.app' imports work
                env.PYTHONPATH = rootDir;

                debugLog(`Starting Dev Backend: ${pythonPath} ${args.join(' ')}`);

                this.process = spawn(pythonPath, args, {
                    env,
                    cwd: rootDir,
                    stdio: ['ignore', 'pipe', 'pipe'] // Pipe stdout/stderr to capture token
                });

            } else if (process.platform === 'win32') {
                // Windows fallback to PowerShell script
                this.process = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
                    env,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } else {
                // Unix fallback to shell script
                debugLog(`Using shell script: ${this.scriptPath}`);
                this.process = spawn('/bin/bash', [this.scriptPath], {
                    env,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            }
            debugLog(`Spawned PID: ${this.process?.pid}`);
        } catch (spawnError: any) {
            debugLog(`ERROR: ${spawnError.message}`);
            throw spawnError;
        }

        this.process.stdout?.on('data', (data) => {
            const str = data.toString().trim();
            debugLog(`stdout: ${str}`);

            // Check for session token
            if (str.includes('SERVER_SESSION_TOKEN:')) {
                const match = str.match(/SERVER_SESSION_TOKEN:\s*(\S+)/);
                if (match && match[1]) {
                    this.sessionToken = match[1];
                    setSessionToken(this.sessionToken!);
                    debugLog('Session token captured from stdout');
                }
            }
        });

        this.process.stderr?.on('data', (data) => {
            debugLog(`stderr: ${data.toString().trim()}`);
        });

        this.process.on('error', (err) => {
            debugLog(`ERROR: ${err.message}`);
            this.process = null;
        });

        this.process.on('close', (code) => {
            if (code !== 0) {
                debugLog(`Exited with code ${code}`);
            }
            this.process = null;
        });

        // Wait for the backend to be ready (key captured)
        await this.waitForReady(port, debugLog);
    }

    private async waitForReady(port: number, debugLog: (msg: string) => void, timeoutMs: number = 30000): Promise<void> {
        const startTime = Date.now();
        const checkInterval = 500;

        while (Date.now() - startTime < timeoutMs) {
            if (!this.process) {
                debugLog('Backend exited unexpectedly');
                throw new Error('Backend process exited unexpectedly');
            }

            if (this.sessionToken) {
                try {
                    const response = await fetch(`http://127.0.0.1:${port}/health`, {
                        method: 'GET',
                        headers: {
                            'X-API-Key': this.sessionToken
                        },
                        signal: AbortSignal.timeout(2000)
                    });
                    if (response.ok || response.status === 403) {
                        debugLog('Backend ready');
                        return;
                    }
                } catch (e) {
                    // Server not ready yet
                }
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        debugLog('Timeout waiting for backend');
    }

    stop() {
        if (this.process) {
            console.log('Stopping Python server...');
            try {
                if (process.platform === 'win32') {
                    // On Windows, we might need to kill the process tree
                    execSync(`taskkill /pid ${this.process.pid} /T /F`);
                } else {
                    this.process.kill('SIGKILL');
                }
            } catch (e: any) {
                // Ignore errors if process is already dead
                console.log(`[PythonServer] Error stopping server: ${e.message}`);
            }
            this.process = null;
        }
    }
}
