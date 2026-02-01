import { ipcMain, shell, app, dialog } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { getHealth, getLocalKey } from '../backendClient';
import { WindowManager } from '../windowManager';
import { getLogsDirectory } from '../logger';
import { config } from '../config';
import { getRuntimeStatus } from '../runtimeMigration';

type RedactionResult = { text: string; redactions: number };

type RedactionRule = { pattern: RegExp; replacement: string };

const LOG_REDACTION_RULES: RedactionRule[] = [
    // API Keys & Tokens
    { pattern: /sk-[A-Za-z0-9_-]{16,}/g, replacement: '[API_KEY]' },
    { pattern: /X-API-Key\s*:\s*[^\s]+/gi, replacement: 'X-API-Key: [REDACTED]' },
    { pattern: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: 'Bearer [REDACTED]' },
    { pattern: /\btoken\b\s*[:=]\s*[^\s]+/gi, replacement: 'token=[REDACTED]' },
    // JWT Tokens (base64.base64.signature)
    { pattern: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, replacement: '[JWT_TOKEN]' },
    // Email addresses
    { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: '[EMAIL]' },
    // Query parameters (but preserve structure)
    { pattern: /([?&][^=\s]+)=([^&\s]+)/g, replacement: '$1=[REDACTED]' },
    // File system paths (macOS, Linux, Windows)
    { pattern: /(?:[A-Za-z]:\\[^\s"']+|\/(?:Users|home|var|private|etc|opt|Library|Volumes)\/[^\s"']+)/g, replacement: '[PATH]' },
    // User content fields (activity, summary, description, query, content)
    { pattern: /\b(activity|summary|description)\b\s*[:=]\s*.+/gi, replacement: '$1=[REDACTED]' },
    { pattern: /📝 User Query:\s*.+/g, replacement: '📝 User Query: [REDACTED]' },
    { pattern: /Content:\s*.{50,}/g, replacement: 'Content: [REDACTED]' },
    // IP addresses (IPv4)
    { pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, replacement: '[IP_ADDR]' },
    // Credit card patterns (basic)
    { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, replacement: '[CARD_NUM]' },
    // Password patterns
    { pattern: /\b(password|passwd|pwd)\b\s*[:=]\s*[^\s]+/gi, replacement: '$1=[REDACTED]' },
];

function redactSensitiveText(input: string): RedactionResult {
    let redactions = 0;
    let output = input;

    for (const rule of LOG_REDACTION_RULES) {
        output = output.replace(rule.pattern, (match, ...args) => {
            redactions += 1;
            if (rule.replacement.includes('$')) {
                const groups = args.slice(0, args.length - 2);
                return rule.replacement.replace(/\$(\d)/g, (_m, idx) => String(groups[Number(idx) - 1] ?? ''));
            }
            return rule.replacement;
        });
    }

    return { text: output, redactions };
}

export function registerSystemHandlers(windowManager: WindowManager) {
    ipcMain.handle('health:ping', async () => getHealth());

    ipcMain.handle('auth:get-local-key', async () => {
        return getLocalKey();
    });

    ipcMain.handle('system:open-external', async (_event, url: string) => {
        if (!url || typeof url !== 'string') {
            throw new Error('Missing url.');
        }
        const ALLOWED_PROTOCOLS = ['https:', 'http:', 'mailto:'];
        try {
            const parsed = new URL(url);
            if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
                throw new Error(`Blocked: unsafe protocol "${parsed.protocol}". Only ${ALLOWED_PROTOCOLS.join(', ')} allowed.`);
            }
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('Blocked:')) {
                throw e;
            }
            throw new Error('Invalid URL format.');
        }
        await shell.openExternal(url);
        return true;
    });

    ipcMain.handle('system:show-in-folder', async (_event, filePath: string) => {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Missing file path.');
        }
        // Resolve ~ to home directory if needed
        const resolvedPath = filePath.startsWith('~') 
            ? path.join(os.homedir(), filePath.slice(1)) 
            : filePath;
        
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        shell.showItemInFolder(resolvedPath);
        return true;
    });

    ipcMain.handle('system:specs', async () => {
        return {
            totalMemory: os.totalmem(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length
        };
    });

    ipcMain.handle('spotlight:show', async () => {
        await windowManager.showSpotlightWindow();
        return true;
    });

    ipcMain.handle('spotlight:toggle', async () => {
        await windowManager.toggleSpotlightWindow();
        return true;
    });

    ipcMain.on('spotlight:hide', () => {
        windowManager.hideSpotlightWindow();
    });

    ipcMain.on('spotlight:focus-request', (_event, payload: { fileId?: string }) => {
        if (!payload?.fileId) {
            return;
        }
        windowManager.hideSpotlightWindow();
        windowManager.focusMainWindow();
        windowManager.mainWindow?.webContents.send('spotlight:focus', { fileId: payload.fileId });
    });

    ipcMain.on('spotlight:open-request', (_event, payload: { fileId?: string }) => {
        if (!payload?.fileId) {
            return;
        }
        windowManager.hideSpotlightWindow();
        windowManager.focusMainWindow();
        windowManager.mainWindow?.webContents.send('spotlight:open', { fileId: payload.fileId });
    });

    // Broadcast notes changed to all windows
    ipcMain.on('notes:changed', () => {
        windowManager.broadcast('notes:refresh');
    });

    // Save image to file with dialog
    ipcMain.handle('system:save-image', async (_event, options: {
        data: string; // base64 data URL
        defaultName?: string;
        title?: string;
    }) => {
        const { data, defaultName = 'image.png', title = 'Save Image' } = options;

        const mainWindow = windowManager.mainWindow;
        if (!mainWindow) {
            throw new Error('No main window available');
        }

        const result = await dialog.showSaveDialog(mainWindow, {
            title,
            defaultPath: path.join(app.getPath('downloads'), defaultName),
            filters: [
                { name: 'PNG Image', extensions: ['png'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { saved: false, path: null };
        }

        // Extract base64 data from data URL
        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        await fs.promises.writeFile(result.filePath, buffer);

        return { saved: true, path: result.filePath };
    });

    ipcMain.handle('system:export-logs', async () => {
        const mainWindow = windowManager.mainWindow;
        if (!mainWindow) {
            throw new Error('No main window available');
        }

        const logFiles: { path: string; name: string }[] = [];
        
        const logsDir = getLogsDirectory();
        if (fs.existsSync(logsDir)) {
            const files = fs.readdirSync(logsDir);
            for (const file of files) {
                if (file.endsWith('.log') || file.endsWith('.old.log')) {
                    logFiles.push({
                        path: path.join(logsDir, file),
                        name: `electron/${file}`
                    });
                }
            }
        }
        
        const userDataLogFiles = ['electron-main.log', 'renderer.log'];
        for (const logFile of userDataLogFiles) {
            const logPath = path.join(path.dirname(config.paths.electronLogPath), logFile);
            if (fs.existsSync(logPath)) {
                logFiles.push({
                    path: logPath,
                    name: `electron/${logFile}`
                });
            }
        }

        if (logFiles.length === 0) {
            return { 
                exported: false, 
                path: null, 
                error: 'No log files found',
                redactionStats: { totalRedactions: 0, filesProcessed: 0 }
            };
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const defaultName = `LocalCocoa-logs-${timestamp}-redacted.zip`;

        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Sanitized Logs',
            defaultPath: path.join(app.getPath('downloads'), defaultName),
            filters: [
                { name: 'ZIP Archive', extensions: ['zip'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { exported: false, path: null, redactionStats: { totalRedactions: 0, filesProcessed: 0 } };
        }

        const zipPath = result.filePath;
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        let totalRedactions = 0;
        let filesProcessed = 0;

        return new Promise<{ exported: boolean; path: string | null; error?: string; redactionStats: { totalRedactions: number; filesProcessed: number } }>((resolve) => {
            output.on('close', () => {
                console.log(`[Logs] Exported ${logFiles.length} sanitized log files to ${zipPath} (${archive.pointer()} bytes, ${totalRedactions} items redacted)`);
                shell.showItemInFolder(zipPath);
                resolve({ 
                    exported: true, 
                    path: zipPath,
                    redactionStats: { totalRedactions, filesProcessed }
                });
            });

            archive.on('error', (err) => {
                console.error('[Logs] Error creating archive:', err);
                resolve({ exported: false, path: null, error: err.message, redactionStats: { totalRedactions, filesProcessed } });
            });

            archive.pipe(output);

            for (const logFile of logFiles) {
                if (fs.existsSync(logFile.path)) {
                    try {
                        const content = fs.readFileSync(logFile.path, 'utf-8');
                        const redacted = redactSensitiveText(content);
                        totalRedactions += redacted.redactions;
                        filesProcessed++;
                        archive.append(redacted.text, { name: logFile.name });
                    } catch (err) {
                        console.error(`[Logs] Failed to read/redact ${logFile.path}:`, err);
                        archive.append(`[Error reading file: ${err}]`, { name: logFile.name });
                    }
                }
            }

            const systemInfo = [
                `Local Cocoa Log Export (Sanitized)`,
                `===================================`,
                ``,
                `Export Time: ${new Date().toISOString()}`,
                `App Version: ${app.getVersion()}`,
                `Platform: ${os.platform()} ${os.release()}`,
                `Architecture: ${os.arch()}`,
                `Node Version: ${process.versions.node}`,
                `Electron Version: ${process.versions.electron}`,
                `Total Memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`,
                `Free Memory: ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB`,
                `CPUs: ${os.cpus().length}`,
                ``,
                `Privacy Notice:`,
                `  This export has been sanitized to remove sensitive information.`,
                `  ${totalRedactions} potentially sensitive items were redacted.`,
                ``,
                `Log Files Included:`,
                ...logFiles.map(f => `  - ${f.name}`)
            ].join('\n');

            archive.append(systemInfo, { name: 'system-info.txt' });

            archive.finalize();
        });
    });

    // Get logs directory path (for UI to show location)
    ipcMain.handle('system:get-logs-path', async () => {
        return getLogsDirectory();
    });

    // Get runtime status for debugging
    ipcMain.handle('system:get-runtime-status', async () => {
        return getRuntimeStatus();
    });
}
