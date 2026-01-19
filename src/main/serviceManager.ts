import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { app } from 'electron';

import { config } from './config';

/**
 * Resolve a log path to an absolute path.
 * If the path is relative, it will be resolved relative to the user data directory.
 */
function resolveLogPath(logPath: string | undefined): string | undefined {
    if (!logPath) return undefined;

    if (path.isAbsolute(logPath)) {
        return logPath;
    }

    // Make relative paths relative to userData/logs directory
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');

    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    // If logPath is like "logs/embed.log", extract just the filename
    const fileName = path.basename(logPath);
    return path.join(logsDir, fileName);
}

interface ServiceConfig {
    modelPath: string;
    port: number;
    contextSize: number;
    threads: number;
    ngl: number;
    alias: string;
    type: 'embedding' | 'reranking' | 'vlm' | 'completion' | 'whisper';
    mmprojPath?: string;
    batchSize?: number;
    ubatchSize?: number;
    parallel?: number;  // Number of parallel slots for concurrent requests
}

export class ServiceManager extends EventEmitter {
    private processes: Map<string, ChildProcess> = new Map();
    private projectRoot: string;
    private llamaServerBin: string;
    private whisperServerBin: string;

    constructor(projectRoot: string) {
        super();
        this.projectRoot = projectRoot;
        this.llamaServerBin = config.paths.llamaServer;
        this.whisperServerBin = config.paths.whisperServer;
    }

    async startService(config: ServiceConfig): Promise<void> {
        if (this.processes.has(config.alias)) {
            console.log(`Service ${config.alias} is already running.`);
            return;
        }

        let binaryPath = this.llamaServerBin;
        const args: string[] = [];

        if (config.type === 'whisper') {
            binaryPath = this.whisperServerBin;
            if (!fs.existsSync(binaryPath)) {
                console.warn(`[ServiceManager] whisper-server binary not found at ${binaryPath}. Skipping ${config.alias}.`);
                return;
            }
            if (!fs.existsSync(config.modelPath)) {
                console.warn(`[ServiceManager] Model file not found at ${config.modelPath}. Skipping ${config.alias}.`);
                return;
            }

            args.push(
                '-m', config.modelPath,
                '--host', '127.0.0.1',
                '--port', config.port.toString(),
                '-t', config.threads.toString(),
                '--convert'
            );
        } else {
            // Llama Services
            if (!fs.existsSync(this.llamaServerBin)) {
                throw new Error(`llama-server binary not found at ${this.llamaServerBin}`);
            }
            if (!fs.existsSync(config.modelPath)) {
                // throw new Error(`Model file not found at ${config.modelPath}`);
                console.warn(`[ServiceManager] Model file not found at ${config.modelPath}. Skipping ${config.alias}.`);
                return;
            }

            args.push(
                '-m', config.modelPath,
                '--host', '127.0.0.1',
                '--port', config.port.toString(),
                '-c', config.contextSize.toString(),
                '-t', config.threads.toString(),
                '-ngl', config.ngl.toString()
            );

            if (config.type === 'embedding') {
                args.push('--embedding');
                // Remove hardcoded --pooling cls to allow model metadata to decide pooling type
                // or use --pooling <type> from config if needed in the future.

                const embedLogPath = resolveLogPath(process.env.EMBED_LOG_PATH);
                if (embedLogPath) {
                    args.push('--log-file', embedLogPath);
                }
            } else if (config.type === 'reranking') {
                args.push('--reranking');

                const rerankLogPath = resolveLogPath(process.env.RERANK_LOG_PATH);
                if (rerankLogPath) {
                    args.push('--log-file', rerankLogPath);
                }
            } else if (config.type === 'vlm' && config.mmprojPath) {
                args.push('--mmproj', config.mmprojPath);

                const vlmLogPath = resolveLogPath(process.env.VLM_LOG_PATH);
                if (vlmLogPath) {
                    args.push('--log-file', vlmLogPath);
                }
            }

            if (config.batchSize) {
                args.push('-b', config.batchSize.toString());
            }
            if (config.ubatchSize) {
                args.push('-ub', config.ubatchSize.toString());
            }
        }
        if (config.parallel) {
            args.push('-np', config.parallel.toString());
        }

        console.log(`[ServiceManager] Starting ${config.alias}`);
        console.log(`[ServiceManager] Binary: ${binaryPath}`);
        console.log(`[ServiceManager] Args: ${args.join(' ')}`);

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

        const env = {
            ...process.env,
            PATH: fullPath,
            HOME: process.env.HOME || app.getPath('home'),
            TMPDIR: process.env.TMPDIR || app.getPath('temp'),
            LANG: process.env.LANG || 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
        };

        // Initialize log stream for services that don't support native log file arguments (like whisper-server)
        let logStream: fs.WriteStream | null = null;
        if (config.type === 'whisper') {
            const logPath = resolveLogPath(process.env.WHISPER_LOG_PATH || 'whisper.log');
            if (logPath) {
                try {
                    logStream = fs.createWriteStream(logPath, { flags: 'a' });
                    console.log(`[ServiceManager] Redirecting ${config.alias} logs to ${logPath}`);
                    // Write header
                    logStream.write(`\n--- Session started at ${new Date().toISOString()} ---\n`);
                } catch (e) {
                    console.error(`[ServiceManager] Failed to create log stream for ${config.alias}: ${e}`);
                }
            }
        }

        const child = spawn(binaryPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        });

        child.stdout?.on('data', (data) => {
            console.log(`[${config.alias}] ${data.toString().trim()}`);
            if (logStream) {
                logStream.write(data);
            }
        });

        child.stderr?.on('data', (data) => {
            const logLine = data.toString().trim();
            // llama-server outputs all logs to stderr, including normal operation logs
            // Only treat logs as errors if they contain explicit error indicators
            const isError = /error|fail|exception|fatal|panic|crash/i.test(logLine) &&
                !/log_server_r:.*200/.test(logLine); // Exclude successful requests

            if (isError) {
                // Actual error messages
                console.error(`[${config.alias}] ${logLine}`);
            } else {
                // Normal logs (HTTP requests, parameter info, slot management, etc.) should be info level
                console.log(`[${config.alias}] ${logLine}`);
            }

            if (logStream) {
                logStream.write(data);
            }
        });

        child.on('close', (code) => {
            console.log(`[${config.alias}] exited with code ${code}`);
            this.processes.delete(config.alias);
            this.emit('service-stopped', { alias: config.alias, code });
            if (logStream) {
                logStream.end();
            }
        });

        this.processes.set(config.alias, child);
        this.emit('service-started', { alias: config.alias });
    }

    async stopService(alias: string): Promise<void> {
        const child = this.processes.get(alias);
        if (child) {
            console.log(`Stopping ${alias}...`);
            try {
                if (process.platform === 'win32' && child.pid) {
                    // Windows: Force kill process tree
                    execSync(`taskkill /pid ${child.pid} /T /F`);
                } else {
                    // Unix: Force kill
                    child.kill('SIGKILL');
                }
            } catch (e: any) {
                // Ignore errors if process is already dead
                console.log(`[ServiceManager] Error stopping ${alias}: ${e.message}`);
            }
            this.processes.delete(alias);
        }
    }

    async stopAll(): Promise<void> {
        for (const alias of this.processes.keys()) {
            await this.stopService(alias);
        }
    }

    isRunning(alias: string): boolean {
        return this.processes.has(alias);
    }
}
