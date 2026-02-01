import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import { EventEmitter } from 'events';
import { app } from 'electron';

import { config } from './config';

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
            } else if (config.type === 'reranking') {
                args.push('--reranking');
            } else if (config.type === 'vlm' && config.mmprojPath) {
                args.push('--mmproj', config.mmprojPath);
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

        const child = spawn(binaryPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env
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
        });

        child.on('close', (code) => {
            console.log(`[${config.alias}] exited with code ${code}`);
            this.processes.delete(config.alias);
            this.emit('service-stopped', { alias: config.alias, code });
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
