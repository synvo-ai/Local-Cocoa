import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'path';
import { loadEnvConfig, config } from './config';

// Set app name early for macOS menu bar and About panel
app.setName('Local Cocoa');

if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
        applicationName: 'Local Cocoa',
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        copyright: '© 2025 Synvo AI'
    });
}

// Load environment variables first before loading other modules (works in both dev and prod)
loadEnvConfig();

import './logger'; // Initialize logger
import { initializeRuntime } from './runtimeMigration';
import { WindowManager } from './windowManager';
import { ServiceManager } from './serviceManager';
import { ModelManager } from './modelManager';
import { PythonServer } from './pythonServer';
import { TrayManager } from './trayManager';
import { updateLogSettings } from './logger';
import { registerFileHandlers } from './ipc/files';
import { registerEmailHandlers } from './ipc/email';
import { registerNotesHandlers } from './ipc/notes';
import { registerChatHandlers } from './ipc/chat';
import { registerActivityHandlers } from './ipc/activity';
import { registerModelHandlers } from './ipc/models';
import { registerSystemHandlers } from './ipc/system';
import { registerScanHandlers } from './ipc/scan';
import { registerMemoryHandlers } from './ipc/memory';
import { registerMCPHandlers, initMCPServer } from './ipc/mcp';
import { initPluginManager } from './plugins';
import { startDirectMCPServer } from './mcpDirectServer';
import { ModelDownloadEvent } from './types';

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

const windowManager = new WindowManager();
const modelManager = new ModelManager(config.paths.modelRoot);
const serviceManager = new ServiceManager(config.paths.projectRoot);
const pythonServer = new PythonServer();
let trayManager: TrayManager | null = null;

// Initialize plugin manager
const pluginManager = initPluginManager();

function broadcastModelEvent(event: ModelDownloadEvent) {
    windowManager.broadcast('models:progress', event);
}

modelManager.on('event', (event: ModelDownloadEvent) => {
    broadcastModelEvent(event);
    if (event.state === 'completed') {
        console.log('[Main] Model download completed. Retrying service startup...');
        startServices().catch(console.error);
    }
});

async function startServices() {
    await modelManager.initializePromise;
    const modelConfig = await modelManager.getConfig();

    console.log('startServices() called');
    console.log(`app.isPackaged: ${app.isPackaged}, isDev: ${config.isDev}, env: ${process.env.NODE_ENV}`);

    // Resolve all model paths based on user's selected models
    // VLM model
    const activeModelId = modelConfig.activeModelId || 'vlm';
    const vlmModelPath = modelManager.getModelPath(activeModelId);
    const vlmDescriptor = modelManager.getDescriptor(activeModelId);
    let vlmMmprojPath: string | undefined;
    if (vlmDescriptor?.mmprojId) {
        vlmMmprojPath = modelManager.getModelPath(vlmDescriptor.mmprojId);
    } else if (activeModelId === 'vlm') {
        vlmMmprojPath = modelManager.getModelPath('vlm-mmproj');
    }

    // Embedding model
    const embeddingModelId = modelConfig.activeEmbeddingModelId || 'embedding-q4';
    const embeddingModelPath = modelManager.getModelPath(embeddingModelId);

    // Reranker model
    const rerankerModelId = modelConfig.activeRerankerModelId || 'reranker';
    const rerankerModelPath = modelManager.getModelPath(rerankerModelId);

    // Whisper model
    const whisperModelId = modelConfig.activeAudioModelId || 'whisper-small';
    const whisperModelPath = modelManager.getModelPath(whisperModelId);

    console.log(`Active models - VLM: ${activeModelId}, Embedding: ${embeddingModelId}, Reranker: ${rerankerModelId}, Whisper: ${whisperModelId}`);

    // Start Python Backend with config, including all model paths
    await pythonServer.start({
        LOCAL_RUNTIME_ROOT: config.paths.runtimeRoot,
        LOCAL_VISION_MAX_PIXELS: (modelConfig.visionMaxPixels || 1003520).toString(),
        LOCAL_PDF_ONE_CHUNK_PER_PAGE: String(modelConfig.pdfOneChunkPerPage ?? true),
        // Model file paths
        LOCAL_MODEL_VLM_FILE: vlmModelPath,
        LOCAL_MODEL_EMBEDDING_FILE: embeddingModelPath,
        LOCAL_MODEL_RERANK_FILE: rerankerModelPath,
        LOCAL_MODEL_WHISPER_FILE: whisperModelPath,
        LOCAL_MODEL_VLM_MMPROJ_FILE: vlmMmprojPath ? vlmMmprojPath: '',
        LOCAL_SERVICE_LOG_TO_FILE: config.backend.logToFile ?? 'false',
        LOCAL_SERVICE_BIN_PATH: config.paths.backendRoot,
        // Below variables are only effective in local-cocoa-service's dev build for debugpy support
        DEBUG: process.env.DEBUG ?? 'false',
        PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? '0',
        PYDEVD_DISABLE_FILE_VALIDATION: process.env.PYDEVD_DISABLE_FILE_VALIDATION ?? '0',
        DEBUGPY_PYTHON_PATH: process.env.DEBUGPY_PYTHON_PATH ?? '',
        LOCAL_SERVICE_DEBUG_WAIT: process.env.LOCAL_SERVICE_DEBUG_WAIT ?? 'false',
        LOCAL_SERVICE_DEBUG_PORT: process.env.LOCAL_SERVICE_DEBUG_PORT ?? ''
    });

    // Start MCP Direct Server (port 5566)
    startDirectMCPServer(windowManager);

    console.log('[Main] Starting services with config:', modelConfig);
    console.log('[Main] All models (VLM, Embedding, Reranker, Whisper) will be started on-demand by Python ModelManager');

    // NOTE: All AI models are now started on-demand by Python's ModelManager
    // This provides faster app startup, lower memory usage, and proper hibernation support.
    // The first request to each model type will trigger its startup.
}

app.whenReady().then(async () => {
    // Initialize log level from config
    updateLogSettings();
    if (process.platform === 'darwin') {
        const iconPath = path.join(config.paths.projectRoot, 'assets', 'icon.png');
        app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    }

    windowManager.createApplicationMenu();

    // Validate and migrate runtime before starting services
    try {
        const runtimeValidation = await initializeRuntime();
        if (!runtimeValidation.valid) {
            console.error('[Main] Runtime validation failed. Some features may not work correctly.');
            // Continue anyway - services will report their own errors if binaries are missing
        }
    } catch (error) {
        console.error('[Main] Runtime initialization error:', error);
    }

    // Start backend services FIRST, then create window
    // This ensures API key is available before frontend makes requests
    try {
        await startServices();
    } catch (error) {
        console.error('Failed to start services:', error);
    }

    windowManager.createMainWindow().catch((error) => {
        console.error('Failed to create window', error);
    });

    windowManager.registerSpotlightShortcut();
    windowManager.registerQuickNoteShortcut();

    // Initialize plugin system
    try {
        await pluginManager.initialize();
        pluginManager.registerIPCHandlers();

        // Set main window reference for plugin notifications
        if (windowManager.mainWindow) {
            pluginManager.setMainWindow(windowManager.mainWindow);
        }

        console.log('[Main] Plugin system initialized');
    } catch (error) {
        console.error('[Main] Failed to initialize plugin system:', error);
    }

    // Create system tray
    trayManager = new TrayManager(windowManager);
    trayManager.createTray();

    app.on('activate', () => {
        if (windowManager.mainWindow) {
            if (!windowManager.mainWindow.isVisible()) {
                windowManager.mainWindow.show();
            } else {
                windowManager.mainWindow.focus();
            }
            return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
            windowManager.createMainWindow().catch((error) => console.error('Failed to recreate window', error));
        }
    });
});

app.on('window-all-closed', () => {
    console.log('App window-all-closed');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

let isQuitting = false;

app.on('before-quit', async (event) => {
    if (isQuitting) return;

    event.preventDefault();
    console.log('App before-quit: Stopping services...');

    try {
        await serviceManager.stopAll();
        pythonServer.stop();
    } catch (error) {
        console.error('Error stopping services:', error);
    } finally {
        isQuitting = true;
        app.quit();
    }
});

// Register IPC Handlers
registerFileHandlers(windowManager);
registerEmailHandlers();
registerNotesHandlers();
registerChatHandlers();
registerActivityHandlers();
registerModelHandlers(modelManager, serviceManager);
registerSystemHandlers(windowManager);
registerScanHandlers();
registerMemoryHandlers();
registerMCPHandlers(windowManager);

// Initialize MCP server (for Claude Desktop integration)
initMCPServer();
