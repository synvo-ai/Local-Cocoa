import { Tray, Menu, nativeImage, app, MenuItemConstructorOptions } from 'electron';
import path from 'path';
import { config } from './config';
import { WindowManager } from './windowManager';

export class TrayManager {
    private tray: Tray | null = null;
    private windowManager: WindowManager;

    constructor(windowManager: WindowManager) {
        this.windowManager = windowManager;
    }

    public createTray() {
        let trayIcon: Electron.NativeImage;
        
        if (process.platform === 'darwin') {
            // For macOS, use colored tray icon
            const iconPath = path.join(config.paths.projectRoot, 'assets', 'tray-iconTemplate.png');
            trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
        } else {
            // For Windows, use the regular colored icon
            const iconPath = path.join(config.paths.projectRoot, 'assets', 'icon.png');
            trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
        }

        this.tray = new Tray(trayIcon);
        this.tray.setToolTip('Local Cocoa');

        this.updateContextMenu();

        // On Windows, left-click focuses main window
        if (process.platform === 'win32') {
            this.tray.on('click', () => {
                this.windowManager.focusMainWindow();
            });
        }
    }

    private updateContextMenu() {
        if (!this.tray) return;

        const isMac = process.platform === 'darwin';

        const menuTemplate: MenuItemConstructorOptions[] = [
            {
                label: '📝 Quick Note',
                accelerator: isMac ? 'Command+Shift+N' : 'Ctrl+Shift+N',
                click: async () => {
                    await this.windowManager.showSpotlightNotes();
                }
            },
            {
                label: '🔍 Search',
                accelerator: isMac ? 'Command+Shift+Space' : 'Ctrl+Alt+Space',
                click: async () => {
                    await this.windowManager.showSpotlightWindow();
                }
            },
            { type: 'separator' },
            {
                label: 'Open Local Cocoa',
                click: () => {
                    this.windowManager.focusMainWindow();
                }
            },
            { type: 'separator' },
            {
                label: 'Quit',
                accelerator: isMac ? 'Command+Q' : 'Alt+F4',
                click: () => {
                    app.quit();
                }
            }
        ];

        const contextMenu = Menu.buildFromTemplate(menuTemplate);
        this.tray.setContextMenu(contextMenu);
    }

    public destroy() {
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
    }
}

