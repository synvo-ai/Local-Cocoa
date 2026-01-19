import { BrowserWindow, shell, Menu, MenuItemConstructorOptions, app, globalShortcut } from 'electron';
import path from 'path';
import { config } from './config';

export class WindowManager {
    public mainWindow: BrowserWindow | null = null;
    public spotlightWindow: BrowserWindow | null = null;
    public quickNoteWindow: BrowserWindow | null = null;
    private isQuitting = false;
    private spotlightShortcutRetryTimer: NodeJS.Timeout | null = null;
    private readonly SPOTLIGHT_SHORTCUT = process.platform === 'darwin'
        ? 'Command+Shift+Space'
        : 'Ctrl+Alt+Space';
    private readonly QUICK_NOTE_SHORTCUT = process.platform === 'darwin'
        ? 'Command+Shift+N'
        : 'Ctrl+Shift+N';

    constructor() {
        app.on('before-quit', () => {
            this.isQuitting = true;
        });

        app.on('will-quit', () => {
            globalShortcut.unregisterAll();
            if (this.spotlightShortcutRetryTimer) {
                clearTimeout(this.spotlightShortcutRetryTimer);
                this.spotlightShortcutRetryTimer = null;
            }
        });
    }

    public async createMainWindow() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.focus();
            return;
        }

        this.mainWindow = new BrowserWindow({
            width: config.windows.main.width,
            height: config.windows.main.height,
            backgroundColor: config.windows.main.backgroundColor,
            icon: path.join(config.projectRoot, 'assets', 'icon.png'),
            ...(process.platform === 'darwin' ? {
                titleBarStyle: 'hiddenInset',
                trafficLightPosition: { x: 16, y: 16 },
            } : {
                titleBarStyle: 'hidden',
                titleBarOverlay: {
                    color: config.windows.main.backgroundColor,
                    symbolColor: '#ffffff',
                    height: 35
                }
            }),
            webPreferences: {
                preload: config.paths.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                webSecurity: false
            }
        });

        this.mainWindow.on('close', (event) => {
            if (this.isQuitting) {
                return;
            }
            // Only hide on macOS
            if (process.platform === 'darwin') {
                event.preventDefault();
                this.mainWindow?.hide();
            }
            // On Windows/Linux, let the window close naturally.
            // This will trigger 'window-all-closed', which will quit the app.
        });

        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });

        this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            try {
                const parsed = new URL(url);
                if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
                    shell.openExternal(url).catch((err) => console.error('Failed to open external url:', err));
                } else {
                    console.warn(`Blocked openExternal for unsafe protocol: ${parsed.protocol}`);
                }
            } catch (e) {
                console.error('Invalid URL for openExternal:', url);
            }
            return { action: 'deny' };
        });

        this.mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12' && input.type === 'keyDown') {
                this.mainWindow?.webContents.toggleDevTools();
            }
        });

        if (config.isDev) {
            await this.mainWindow.loadURL(config.devServerUrl);
        } else {
            await this.mainWindow.loadFile(path.join(config.paths.dist, 'index.html'));
        }

        if (!app.isPackaged) {
            this.mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    }

    public async ensureSpotlightWindow(): Promise<BrowserWindow> {
        if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
            return this.spotlightWindow;
        }

        this.spotlightWindow = new BrowserWindow({
            width: config.windows.spotlight.width,
            height: config.windows.spotlight.height,
            show: false,
            frame: false,
            resizable: false,
            fullscreenable: false,
            backgroundColor: '#00000000',
            transparent: true,
            hasShadow: true,
            skipTaskbar: true,
            alwaysOnTop: true,
            // macOS specific: don't show in Mission Control, allow overlay on fullscreen
            ...(process.platform === 'darwin' ? {
                type: 'panel',
                hiddenInMissionControl: true
            } : {}),
            webPreferences: {
                preload: config.paths.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });

        this.spotlightWindow.setVisibleOnAllWorkspaces(true);

        this.spotlightWindow.setMenuBarVisibility(false);

        this.spotlightWindow.on('closed', () => {
            this.spotlightWindow = null;
        });

        // Don't auto-hide on blur - let user close manually with Esc or close button
        // This prevents flashing when switching between apps

        try {
            if (config.isDev) {
                const spotlightURL = new URL(config.devServerUrl);
                spotlightURL.searchParams.set('view', 'spotlight');
                await this.spotlightWindow.loadURL(spotlightURL.toString());
            } else {
                await this.spotlightWindow.loadFile(path.join(config.paths.dist, 'index.html'), {
                    query: { view: 'spotlight' }
                });
            }
        } catch (error) {
            console.error('Failed to load spotlight search window', error);
        }

        return this.spotlightWindow;
    }

    public async showSpotlightWindow(initialTab?: 'search' | 'notes') {
        const window = await this.ensureSpotlightWindow();
        if (window.isVisible()) {
            window.focus();
            // Send tab switch command if tab specified
            if (initialTab) {
                window.webContents.send('spotlight:switch-tab', { tab: initialTab });
            }
            return;
        }
        window.center();

        // On macOS, use showInactive first then focus just the spotlight window
        // This prevents the main window from being activated
        if (process.platform === 'darwin') {
            window.showInactive();
            // Small delay then focus just this window
            setTimeout(() => {
                window.focus();
            }, 50);
        } else {
            window.show();
            window.focus();
        }

        // Send tab switch command if tab specified
        if (initialTab) {
            // Small delay to ensure window is ready
            setTimeout(() => {
                window.webContents.send('spotlight:switch-tab', { tab: initialTab });
            }, 100);
        }
    }

    public async showSpotlightNotes() {
        await this.showSpotlightWindow('notes');
    }

    public hideSpotlightWindow() {
        if (this.spotlightWindow && !this.spotlightWindow.isDestroyed()) {
            this.spotlightWindow.hide();
        }
    }

    public async toggleSpotlightWindow() {
        if (this.spotlightWindow && !this.spotlightWindow.isDestroyed() && this.spotlightWindow.isVisible()) {
            this.hideSpotlightWindow();
            return;
        }
        await this.showSpotlightWindow();
    }

    public async ensureQuickNoteWindow(): Promise<BrowserWindow> {
        if (this.quickNoteWindow && !this.quickNoteWindow.isDestroyed()) {
            return this.quickNoteWindow;
        }

        this.quickNoteWindow = new BrowserWindow({
            width: 480,
            height: 360,
            show: false,
            frame: false,
            resizable: true,
            fullscreenable: false,
            backgroundColor: '#1e293b',
            transparent: false,
            hasShadow: true,
            skipTaskbar: false,
            alwaysOnTop: true,
            minWidth: 320,
            minHeight: 200,
            webPreferences: {
                preload: config.paths.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });

        this.quickNoteWindow.setMenuBarVisibility(false);

        this.quickNoteWindow.on('closed', () => {
            this.quickNoteWindow = null;
        });

        this.quickNoteWindow.on('blur', () => {
            // Don't auto-hide to allow user to finish typing
        });

        try {
            if (config.isDev) {
                const quickNoteURL = new URL(config.devServerUrl);
                quickNoteURL.searchParams.set('view', 'quicknote');
                await this.quickNoteWindow.loadURL(quickNoteURL.toString());
            } else {
                await this.quickNoteWindow.loadFile(path.join(config.paths.dist, 'index.html'), {
                    query: { view: 'quicknote' }
                });
            }
        } catch (error) {
            console.error('Failed to load quick note window', error);
        }

        return this.quickNoteWindow;
    }

    public async showQuickNoteWindow() {
        const window = await this.ensureQuickNoteWindow();
        if (window.isVisible()) {
            window.focus();
            return;
        }
        window.center();
        window.show();
        window.focus();
    }

    public hideQuickNoteWindow() {
        if (this.quickNoteWindow && !this.quickNoteWindow.isDestroyed()) {
            this.quickNoteWindow.hide();
        }
    }

    public closeQuickNoteWindow() {
        if (this.quickNoteWindow && !this.quickNoteWindow.isDestroyed()) {
            this.quickNoteWindow.close();
        }
    }

    public async toggleQuickNoteWindow() {
        if (this.quickNoteWindow && !this.quickNoteWindow.isDestroyed() && this.quickNoteWindow.isVisible()) {
            this.hideQuickNoteWindow();
            return;
        }
        await this.showQuickNoteWindow();
    }

    public registerSpotlightShortcut(retryCount = 0) {
        const registered = globalShortcut.register(this.SPOTLIGHT_SHORTCUT, () => {
            void this.toggleSpotlightWindow();
        });

        if (!registered) {
            if (retryCount >= 5) {
                console.warn(`Failed to register spotlight shortcut (${this.SPOTLIGHT_SHORTCUT}) after 5 attempts. Giving up.`);
                return;
            }
            const nextDelay = Math.min(5000, 500 * (retryCount + 1));
            console.warn(`Failed to register spotlight shortcut (${this.SPOTLIGHT_SHORTCUT}). Retrying in ${nextDelay} ms.`);
            if (this.spotlightShortcutRetryTimer) {
                clearTimeout(this.spotlightShortcutRetryTimer);
            }
            this.spotlightShortcutRetryTimer = setTimeout(() => this.registerSpotlightShortcut(retryCount + 1), nextDelay);
        } else {
            if (this.spotlightShortcutRetryTimer) {
                clearTimeout(this.spotlightShortcutRetryTimer);
                this.spotlightShortcutRetryTimer = null;
            }
            console.info(`Spotlight shortcut registered (${this.SPOTLIGHT_SHORTCUT}).`);
        }
    }

    public registerQuickNoteShortcut() {
        const registered = globalShortcut.register(this.QUICK_NOTE_SHORTCUT, () => {
            void this.showSpotlightNotes();
        });

        if (registered) {
            console.info(`Quick Note shortcut registered (${this.QUICK_NOTE_SHORTCUT}).`);
        } else {
            console.warn(`Failed to register quick note shortcut (${this.QUICK_NOTE_SHORTCUT}).`);
        }
    }

    public focusMainWindow() {
        if (!this.mainWindow) {
            return;
        }
        if (this.mainWindow.isMinimized()) {
            this.mainWindow.restore();
        }
        if (!this.mainWindow.isVisible()) {
            this.mainWindow.show();
        }
        this.mainWindow.focus();
    }

    public broadcast(channel: string, ...args: any[]) {
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
                win.webContents.send(channel, ...args);
            }
        });
    }

    public createApplicationMenu() {
        const isMac = process.platform === 'darwin';

        const template: MenuItemConstructorOptions[] = [
            // { role: 'appMenu' }
            ...(isMac
                ? [{
                    label: app.name,
                    submenu: [
                        { label: `About ${app.name}`, role: 'about' },
                        { type: 'separator' },
                        { role: 'services' },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' }
                    ]
                } as MenuItemConstructorOptions]
                : []),
            // { role: 'fileMenu' }
            {
                label: 'File',
                submenu: [
                    { role: 'close' }
                ]
            },
            // { role: 'editMenu' }
            {
                label: 'Edit',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { role: 'delete' },
                    { role: 'selectAll' }
                ]
            },
            // { role: 'viewMenu' }
            {
                label: 'View',
                submenu: [
                    { role: 'reload' },
                    { role: 'forceReload' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    { role: 'resetZoom' },
                    { role: 'zoomIn' },
                    { role: 'zoomOut' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' },
                    { type: 'separator' },
                    {
                        label: 'Toggle Spotlight',
                        accelerator: this.SPOTLIGHT_SHORTCUT,
                        click: async () => {
                            await this.toggleSpotlightWindow();
                        }
                    }
                ]
            },
            // { role: 'windowMenu' }
            {
                label: 'Window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    ...(isMac
                        ? [
                            { type: 'separator' },
                            { role: 'front' },
                            { type: 'separator' },
                            { role: 'window' }
                        ]
                        : [
                            { role: 'close' }
                        ])
                ] as MenuItemConstructorOptions[]
            },
            {
                role: 'help',
                submenu: [
                    {
                        label: 'Learn More',
                        click: async () => {
                            await shell.openExternal('https://github.com/synvo-ai/local-cocoa');
                        }
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);

        // Force update the menu on macOS
        if (isMac) {
            Menu.setApplicationMenu(menu);
        }
    }
}
