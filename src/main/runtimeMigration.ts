/**
 * Runtime Migration and Validation Module
 * Ensures the runtime directory structure is correct and handles migrations
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

// Current runtime schema version - increment when structure changes
const RUNTIME_SCHEMA_VERSION = 1;

interface RuntimeVersionInfo {
    schemaVersion: number;
    lastMigration: string;
    createdAt: string;
}

interface ValidationResult {
    valid: boolean;
    issues: string[];
    warnings: string[];
    migrations: string[];
}

// Expected binary directories (must exist in runtime for app to function)
const REQUIRED_BINARY_DIRS = [
    'local-cocoa-models',
];

// Data directories (will be created if missing)
const DATA_DIRS = [
    'synvo_db',
    'logs',
];

// Subdirectories within synvo_db that should exist
const SYNVO_DB_SUBDIRS = [
    'notes',
    'mail',
    'qdrant-data',
];

/**
 * Get the path to the runtime version file
 */
function getVersionFilePath(): string {
    return path.join(config.paths.runtimeRoot, '.runtime-version.json');
}

/**
 * Read the current runtime version info
 */
function readVersionInfo(): RuntimeVersionInfo | null {
    const versionPath = getVersionFilePath();
    if (!fs.existsSync(versionPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(versionPath, 'utf-8');
        return JSON.parse(content) as RuntimeVersionInfo;
    } catch {
        console.warn('[RuntimeMigration] Failed to read version file');
        return null;
    }
}

/**
 * Write the runtime version info
 */
function writeVersionInfo(info: RuntimeVersionInfo): void {
    const versionPath = getVersionFilePath();
    fs.writeFileSync(versionPath, JSON.stringify(info, null, 2));
}

/**
 * Validate the runtime directory structure
 */
export function validateRuntime(): ValidationResult {
    const result: ValidationResult = {
        valid: true,
        issues: [],
        warnings: [],
        migrations: [],
    };

    const runtimeRoot = config.paths.runtimeRoot;
    console.log(`[RuntimeMigration] Validating runtime at: ${runtimeRoot}`);

    // Check required binary directories
    for (const dir of REQUIRED_BINARY_DIRS) {
        const dirPath = path.join(runtimeRoot, dir);
        if (!fs.existsSync(dirPath)) {
            result.issues.push(`Missing required directory: ${dir}`);
            result.valid = false;
        } else {
            // Check if directory is not empty
            const files = fs.readdirSync(dirPath);
            if (files.length === 0) {
                result.warnings.push(`Directory is empty: ${dir}`);
            }
        }
    }

    // Validate llama-cpp has the server binary
    if (config.backend.launchPythonServer) {
        const checkFiles = [
            { path: config.paths.localCocoaServer, name: 'local cocoa server' },
            { path: config.paths.llamaServer, name: 'llama-server' },
            { path: config.paths.whisperServer, name: 'whisper-server' }
        ];

        checkFiles.forEach(item => {
            if (!fs.existsSync(item.path)) {
                result.issues.push(`Missing ${item.name} binary at: ${item.path}`);
                result.valid = false;
            }
        });
    }

    // Validate models directory has at least some models
    const modelsPath = config.paths.modelRoot;
    if (fs.existsSync(modelsPath)) {
        const models = fs.readdirSync(modelsPath).filter(f => f.endsWith('.gguf'));
        if (models.length === 0) {
            result.warnings.push('No .gguf models found in models directory');
        }
    } else {
        result.warnings.push(`Models directory does not exist: ${modelsPath}`);
    }

    // Check for legacy/unexpected directories
    const expectedDirs = new Set([
        ...REQUIRED_BINARY_DIRS,
        ...DATA_DIRS,
        'electron_data',      // Dev mode electron cache
        'synvo_db.empty.bak', // Backup template (acceptable)
    ]);

    if (fs.existsSync(runtimeRoot)) {
        const actualDirs = fs.readdirSync(runtimeRoot, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const dir of actualDirs) {
            if (!expectedDirs.has(dir)) {
                result.warnings.push(`Unexpected directory in runtime: ${dir}`);
            }
        }
    }

    return result;
}

/**
 * Ensure all required data directories exist
 */
export function ensureDataDirectories(): void {
    console.log('[RuntimeMigration] Ensuring data directories exist...');

    // Create main data directories
    const runtimeRootPath = config.paths.runtimeRoot;
    const logsPath = path.dirname(config.paths.electronLogPath);

    for (const dirPath of [runtimeRootPath, logsPath]) {
        if (!fs.existsSync(dirPath)) {
            console.log(`[RuntimeMigration] Creating directory: ${dirPath}`);
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    // Create synvo_db subdirectories
    for (const subdir of SYNVO_DB_SUBDIRS) {
        const subdirPath = path.join(runtimeRootPath, subdir);
        if (!fs.existsSync(subdirPath)) {
            console.log(`[RuntimeMigration] Creating subdirectory: ${subdirPath}`);
            fs.mkdirSync(subdirPath, { recursive: true });
        }
    }
}

/**
 * Run migrations if needed
 */
export function runMigrations(): string[] {
    const migrations: string[] = [];
    const versionInfo = readVersionInfo();
    const currentVersion = versionInfo?.schemaVersion ?? 0;

    console.log(`[RuntimeMigration] Current schema version: ${currentVersion}, target: ${RUNTIME_SCHEMA_VERSION}`);

    if (currentVersion < RUNTIME_SCHEMA_VERSION) {
        // Run migrations in order
        if (currentVersion < 1) {
            migrations.push(...migrateToV1());
        }
        // Add more migrations here as needed:
        // if (currentVersion < 2) { migrations.push(...migrateToV2()); }

        // Update version info
        writeVersionInfo({
            schemaVersion: RUNTIME_SCHEMA_VERSION,
            lastMigration: new Date().toISOString(),
            createdAt: versionInfo?.createdAt ?? new Date().toISOString(),
        });
    }

    return migrations;
}

/**
 * Migration to schema version 1
 * - Ensures standard directory structure
 * - Creates version tracking file
 */
function migrateToV1(): string[] {
    const migrations: string[] = [];
    console.log('[RuntimeMigration] Running migration to v1...');

    // Ensure all data directories exist
    ensureDataDirectories();
    migrations.push('Created standard data directory structure');

    return migrations;
}

/**
 * Main initialization function - validates and migrates runtime
 * Should be called early in app startup
 */
export async function initializeRuntime(): Promise<ValidationResult> {
    console.log('[RuntimeMigration] Initializing runtime...');

    // First ensure data directories exist
    ensureDataDirectories();

    // Run any pending migrations
    const migrations = runMigrations();

    // Validate the runtime structure
    const validation = validateRuntime();
    validation.migrations = migrations;

    // Log results
    if (validation.issues.length > 0) {
        console.error('[RuntimeMigration] Runtime validation issues:');
        for (const issue of validation.issues) {
            console.error(`  - ${issue}`);
        }
    }

    if (validation.warnings.length > 0) {
        console.warn('[RuntimeMigration] Runtime validation warnings:');
        for (const warning of validation.warnings) {
            console.warn(`  - ${warning}`);
        }
    }

    if (migrations.length > 0) {
        console.log('[RuntimeMigration] Migrations applied:');
        for (const migration of migrations) {
            console.log(`  - ${migration}`);
        }
    }

    console.log(`[RuntimeMigration] Runtime validation complete. Valid: ${validation.valid}`);

    return validation;
}

/**
 * Get current runtime status for debugging/display
 */
export function getRuntimeStatus(): {
    schemaVersion: number;
    runtimeRoot: string;
    dataPaths: typeof config.paths;
    validation: ValidationResult;
} {
    return {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        runtimeRoot: config.paths.runtimeRoot,
        dataPaths: config.paths,
        validation: validateRuntime(),
    };
}

