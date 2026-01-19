const path = require('path');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');

const rootDir = path.resolve(__dirname, '..');
const envName = 'dev';

dotenvExpand.expand(dotenv.config({ path: path.join(rootDir, 'config', `.env`) }));
dotenvExpand.expand(dotenv.config({ path: path.join(rootDir, 'config', `.env.${envName}`) }));

console.log(process.env.LOCAL_RAG_PORT || '8000');
