const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');


const rootDir = path.resolve(__dirname, '..');
const envName = process.argv[2] || 'dev';

dotenvExpand.expand(dotenv.config({ path: path.join(rootDir, 'config', `.env`) }));
dotenvExpand.expand(dotenv.config({ path: path.join(rootDir, 'config', `.env.${envName}`) }));

const isWin = os.platform() === 'win32';
const venvDir = path.join(rootDir, '.venv');

// Determine Python executable path
let pythonPath;
if (isWin) {
    // Try standard venv path first
    pythonPath = path.join(venvDir, 'Scripts', 'python.exe');

    // If not found, check if user used 'python -m venv' which might put it in root or bin? 
    // Standard Windows venv is .venv/Scripts/python.exe
    if (!fs.existsSync(pythonPath)) {
        // Fallback: maybe they named it differently or it's not created yet
        // Try to find python in path
        console.warn(`Virtual environment python not found at ${pythonPath}.`);
    }
} else {
    pythonPath = path.join(venvDir, 'bin', 'python');
}

// Fallback to system python if venv doesn't exist (though venv is recommended)
if (!fs.existsSync(pythonPath)) {
    console.warn(`Virtual environment not found at ${pythonPath}. Trying system python...`);
    // On Windows, 'python' usually refers to the global python launcher or executable
    // We need to make sure we are using the one that has the dependencies installed.
    // If the user installed deps globally, 'python' is fine.
    // If they installed in a venv but we can't find it, this will fail.
    pythonPath = isWin ? 'python' : 'python3';
}

// Environment variables
const env = {
    ...process.env,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    PYTHONPATH: rootDir, // Absolute path is safer for refactored services
    LOCAL_COCOA_DEV_MODE: '1' // Enable dev mode file fallback
};


// Arguments for uvicorn
const posix = (value) => value.replace(/\\/g, '/');
const reloadDirs = [
    path.join(rootDir, 'services'),
    path.join(rootDir, 'config')
].filter((dir) => fs.existsSync(dir));


const args = [
    '-m', 'uvicorn',
    'services.app.app:app',
    '--host', process.env.LOCAL_RAG_HOST,
    '--port', process.env.LOCAL_RAG_PORT,
    '--reload'
];

for (const dir of reloadDirs) {
    args.push('--reload-dir', posix(dir));
}


console.log(`Starting backend with: ${pythonPath} ${args.join(' ')}`);

const child = spawn(pythonPath, args, {
    env: env,
    stdio: 'inherit',
    cwd: rootDir
});

child.on('error', (err) => {
    console.error('Failed to start backend process:', err);
});

child.on('exit', (code) => {
    process.exit(code);
});

const cleanup = () => {
    if (child && !child.killed) {
        console.log('Stopping backend process...');
        if (isWin) {
            try {
                require('child_process').execSync(`taskkill /pid ${child.pid} /f /t`);
            } catch (e) {
                // Ignore if process is already dead or access denied
                // console.log('Taskkill failed', e.message);
            }
        } else {
            child.kill();
        }
    }
};

process.on('SIGINT', () => {
    cleanup();
    process.exit();
});

process.on('SIGTERM', () => {
    cleanup();
    process.exit();
});