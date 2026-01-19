/**
 * Year In Review Modal
 * 
 * A Spotify Wrapped-style annual file report showing:
 * - Total files and storage statistics
 * - Monthly activity heatmap
 * - File type distribution
 * - Top files by size
 * - Fun facts and highlights
 */

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
    X,
    FileText,
    Image,
    Video,
    Music,
    Archive,
    File,
    BookOpen,
    Calendar,
    HardDrive,
    TrendingUp,
    Award,
    Sparkles,
    Download,
    Cloud,
    Edit3,
    Folder,
    FolderOpen,
    ChevronRight,
    ChevronLeft,
    Clock,
    Zap,
    RefreshCw,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { ScannedFile, FileKind, FileOrigin } from '../types';
import cocoaMascot from '../assets/cocoa-mascot.png';
import synvoAiLogo from '../../../assets/synvo_logo.png';
import html2canvas from 'html2canvas';
import { useSkin, type Skin } from './skin-provider';

// ============================================
// Types
// ============================================

interface YearInReviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    files: ScannedFile[];
    year: number;
}

interface MonthStats {
    month: number;
    count: number;
    size: number;
}

interface DayActivity {
    date: string; // YYYY-MM-DD
    count: number;
    dayOfWeek: number; // 0 = Sunday, 6 = Saturday
    weekIndex: number; // Week number in the year
}

interface FileTypeStats {
    kind: FileKind;
    count: number;
    size: number;
    percentage: number;
}

interface TopFile {
    name: string;
    path: string;
    size: number;
    kind: FileKind;
    modifiedAt: string;
}

interface OriginStats {
    origin: FileOrigin;
    count: number;
    percentage: number;
}

// ============================================
// Constants
// ============================================

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FILE_TYPE_CONFIG: Record<FileKind, { label: string; icon: typeof File; color: string; gradient: string }> = {
    document: {
        label: 'Documents',
        icon: FileText,
        color: 'text-blue-400',
        gradient: 'from-blue-500 to-blue-600'
    },
    image: {
        label: 'Images',
        icon: Image,
        color: 'text-pink-400',
        gradient: 'from-pink-500 to-rose-500'
    },
    video: {
        label: 'Videos',
        icon: Video,
        color: 'text-purple-400',
        gradient: 'from-purple-500 to-violet-600'
    },
    audio: {
        label: 'Audio',
        icon: Music,
        color: 'text-green-400',
        gradient: 'from-green-500 to-emerald-500'
    },
    archive: {
        label: 'Archives',
        icon: Archive,
        color: 'text-amber-400',
        gradient: 'from-amber-500 to-orange-500'
    },
    book: {
        label: 'Books',
        icon: BookOpen,
        color: 'text-indigo-400',
        gradient: 'from-indigo-500 to-blue-600'
    },
    code: {
        label: 'Code',
        icon: File,
        color: 'text-cyan-400',
        gradient: 'from-cyan-500 to-teal-500'
    },
    presentation: {
        label: 'Presentations',
        icon: FileText,
        color: 'text-orange-400',
        gradient: 'from-orange-500 to-red-500'
    },
    spreadsheet: {
        label: 'Spreadsheets',
        icon: FileText,
        color: 'text-emerald-400',
        gradient: 'from-emerald-500 to-green-600'
    },
    other: {
        label: 'Other',
        icon: File,
        color: 'text-gray-400',
        gradient: 'from-gray-500 to-slate-600'
    },
};

const ORIGIN_CONFIG: Record<FileOrigin, { label: string; icon: typeof File; color: string }> = {
    downloaded: { label: 'Downloaded', icon: Download, color: 'text-blue-400' },
    synced: { label: 'Synced', icon: Cloud, color: 'text-purple-400' },
    created_here: { label: 'Created', icon: Edit3, color: 'text-green-400' },
    unknown: { label: 'Unknown', icon: Folder, color: 'text-gray-400' },
};

// ============================================
// Color Theme Configuration
// ============================================
// Two themes based on user's skin preference:
// - minimalist: Synvo AI cyan/teal theme
// - local-cocoa: Warm chocolate/amber theme

interface ColorTheme {
    // Slide backgrounds
    slideGradient: string;
    slideGradientAlt: string;

    // Primary accent color (for icons, highlights)
    primary: string;
    primaryLight: string;
    primaryDark: string;

    // Secondary accent
    secondary: string;
    secondaryLight: string;

    // Text gradient for titles
    titleGradient: string;

    // Bar chart / progress colors
    barShades: string[];
    dotColors: string[];

    // Activity grid colors (contribution graph)
    activityColors: {
        empty: string;
        level1: string;
        level2: string;
        level3: string;
        level4: string;
        level5: string;
        busiest: string;
    };

    // Timeline colors
    timelineGradient: string;
    timelineDot: string;
    timelineDotBorder: string;

    // Button gradient
    buttonGradient: string;
    buttonHoverGradient: string;

    // Card backgrounds
    cardBg: string;
    cardBorder: string;

    // Stat badge colors for top files
    badgeColors: string[];

    // For generated image (inline styles use hex colors)
    hex: {
        primary: string;
        primaryDark: string;
        secondary: string;
        background: string;
        cardBg: string;
        border: string;
        text: string;
        textMuted: string;
        activityEmpty: string;
        activityLevel1: string;
        activityLevel2: string;
        activityLevel3: string;
        activityLevel4: string;
        activityLevel5: string;
        busiest: string;
    };
}

const COLOR_THEMES: Record<Skin, ColorTheme> = {
    // Synvo AI - Cyan/Teal theme
    minimalist: {
        slideGradient: 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900',
        slideGradientAlt: 'bg-gradient-to-br from-slate-900 via-cyan-950/30 to-slate-900',
        primary: 'text-cyan-400',
        primaryLight: 'text-cyan-300',
        primaryDark: 'text-cyan-500',
        secondary: 'text-teal-400',
        secondaryLight: 'text-teal-300',
        titleGradient: 'bg-gradient-to-r from-cyan-400 to-teal-400',
        barShades: [
            'from-cyan-400 to-cyan-500',
            'from-teal-500 to-teal-600',
            'from-cyan-600 to-cyan-700',
            'from-teal-700 to-teal-800',
            'from-cyan-800 to-cyan-900',
        ],
        dotColors: ['bg-cyan-400', 'bg-teal-500', 'bg-cyan-600', 'bg-teal-700', 'bg-cyan-800'],
        activityColors: {
            empty: 'bg-slate-800/50',
            level1: 'bg-cyan-900/70',
            level2: 'bg-cyan-700/80',
            level3: 'bg-cyan-600',
            level4: 'bg-cyan-500',
            level5: 'bg-cyan-400',
            busiest: 'bg-yellow-500',
        },
        timelineGradient: 'bg-gradient-to-b from-cyan-500/50 via-teal-500/50 to-cyan-500/50',
        timelineDot: 'bg-cyan-500',
        timelineDotBorder: 'border-cyan-400',
        buttonGradient: 'bg-gradient-to-r from-cyan-500 to-teal-500',
        buttonHoverGradient: 'hover:from-cyan-400 hover:to-teal-400',
        cardBg: 'bg-slate-800/50',
        cardBorder: 'border-cyan-700/30',
        badgeColors: [
            'bg-cyan-400 text-slate-900',
            'bg-cyan-500/80 text-slate-900',
            'bg-cyan-600/60 text-white',
            'bg-white/10 text-white',
            'bg-white/10 text-white',
        ],
        hex: {
            primary: '#22d3ee',
            primaryDark: '#06b6d4',
            secondary: '#14b8a6',
            background: '#0f172a',
            cardBg: '#1e293b',
            border: '#334155',
            text: '#94a3b8',
            textMuted: '#64748b',
            activityEmpty: '#1e293b',
            activityLevel1: '#065f46',
            activityLevel2: '#059669',
            activityLevel3: '#10b981',
            activityLevel4: '#34d399',
            activityLevel5: '#6ee7b7',
            busiest: '#f97316',
        },
    },
    // Local Cocoa - Elegant Chocolate theme (warm, deep, sophisticated)
    'local-cocoa': {
        slideGradient: 'bg-gradient-to-br from-stone-950 via-stone-900 to-stone-950',
        slideGradientAlt: 'bg-gradient-to-br from-stone-950 via-stone-900/90 to-stone-950',
        primary: 'text-amber-500/90',
        primaryLight: 'text-amber-400/80',
        primaryDark: 'text-amber-600',
        secondary: 'text-stone-400',
        secondaryLight: 'text-stone-300',
        titleGradient: 'bg-gradient-to-r from-amber-600 to-amber-500',
        barShades: [
            'from-amber-700 to-amber-600',
            'from-stone-600 to-stone-500',
            'from-amber-800 to-amber-700',
            'from-stone-700 to-stone-600',
            'from-amber-900 to-amber-800',
        ],
        dotColors: ['bg-amber-600', 'bg-stone-500', 'bg-amber-700', 'bg-stone-600', 'bg-amber-800'],
        activityColors: {
            empty: 'bg-stone-800/40',
            level1: 'bg-stone-700/60',
            level2: 'bg-amber-900/70',
            level3: 'bg-amber-800/80',
            level4: 'bg-amber-700',
            level5: 'bg-amber-600',
            busiest: 'bg-amber-500',
        },
        timelineGradient: 'bg-gradient-to-b from-amber-700/40 via-stone-600/40 to-amber-700/40',
        timelineDot: 'bg-amber-700',
        timelineDotBorder: 'border-amber-600',
        buttonGradient: 'bg-gradient-to-r from-amber-700 to-amber-600',
        buttonHoverGradient: 'hover:from-amber-600 hover:to-amber-500',
        cardBg: 'bg-stone-800/40',
        cardBorder: 'border-stone-700/40',
        badgeColors: [
            'bg-amber-600 text-stone-950',
            'bg-amber-700/90 text-stone-100',
            'bg-amber-800/80 text-stone-100',
            'bg-stone-700/60 text-stone-200',
            'bg-stone-700/60 text-stone-200',
        ],
        hex: {
            primary: '#d97706',      // amber-600 - warm, muted gold
            primaryDark: '#b45309',  // amber-700 - deeper brown-gold
            secondary: '#a8a29e',    // stone-400 - sophisticated gray
            background: '#0c0a09',   // stone-950 - deep dark
            cardBg: '#1c1917',       // stone-900 - subtle card
            border: '#292524',       // stone-800 - soft border
            text: '#a8a29e',         // stone-400 - readable gray
            textMuted: '#78716c',    // stone-500 - muted text
            activityEmpty: '#1c1917',
            activityLevel1: '#44403c',  // stone-700
            activityLevel2: '#78350f',  // amber-900
            activityLevel3: '#92400e',  // amber-800
            activityLevel4: '#b45309',  // amber-700
            activityLevel5: '#d97706',  // amber-600
            busiest: '#d97706',         // amber-600 - same as primary, elegant
        },
    },
};

// ============================================
// Helper Functions
// ============================================

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatNumber(num: number): string {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
}

// ============================================
// Folder Tree Analysis for AI Insight
// ============================================

interface FolderStats {
    path: string;
    name: string;
    fileCount: number;
    totalSize: number;
    children: FolderStats[];
    sampleFiles: string[];
}

// Constants for robustness
const MAX_TREE_CHARS = 2500;      // Maximum characters for folder tree
const MAX_HOTSPOTS = 8;           // Maximum hotspot folders to show
const MAX_SAMPLE_FILES = 3;       // Maximum sample files per folder
const MAX_FILENAME_LENGTH = 35;   // Truncate long filenames

function truncateFilename(name: string): string {
    if (name.length <= MAX_FILENAME_LENGTH) return name;
    const ext = name.lastIndexOf('.');
    if (ext > 0 && name.length - ext < 10) {
        const extPart = name.substring(ext);
        const basePart = name.substring(0, MAX_FILENAME_LENGTH - extPart.length - 3);
        return basePart + '...' + extPart;
    }
    return name.substring(0, MAX_FILENAME_LENGTH - 3) + '...';
}

// Generic folder names that don't provide insight
const GENERIC_FOLDERS = new Set([
    // System folders
    'Desktop', 'Downloads', 'Documents', 'Library', 'Pictures', 'Movies', 'Music',
    'Applications', 'Users', 'home', 'var', 'tmp', 'usr', 'bin', 'etc', 'root',
    // Dev folders
    'node_modules', '.git', '__pycache__', '.cache', 'dist', 'build', 'out', 'target',
    'src', 'lib', 'assets', 'public', 'static', 'images', 'img', 'css', 'js', 'scripts',
    // Generic content folders
    'Video', 'Videos', 'Audio', 'Audios', 'Photo', 'Photos', 'Image', 'Images',
    'Data', 'Backup', 'Backups', 'Archive', 'Archives', 'Temp', 'Cache',
    'Attachments', 'Files', 'Folder', 'New Folder', 'Untitled', 'Misc',
    // Common app folders
    'Logs', 'logs', 'Config', 'config', 'Settings', 'Preferences'
]);

// Extract meaningful folder name from path
function getMeaningfulFolderName(path: string): string {
    // Remove /Users/username prefix
    let displayPath = path;
    const userMatch = path.match(/^\/Users\/[^/]+\/(.+)$/);
    if (userMatch) {
        displayPath = userMatch[1];
    }

    // Get the last meaningful folder name (not generic ones)
    const parts = displayPath.split('/').filter(Boolean);

    // Find the most specific (deepest) folder name
    for (let i = parts.length - 1; i >= 0; i--) {
        if (!GENERIC_FOLDERS.has(parts[i])) {
            // Return this folder + parent context
            if (i > 0 && GENERIC_FOLDERS.has(parts[i - 1])) {
                return `${parts[i - 1]}/${parts[i]}`;
            }
            return parts[i];
        }
    }

    return parts[parts.length - 1] || displayPath;
}

/**
 * Extract specific project names and activities for monthly summary
 * Focus on meaningful project names, not generic folders
 */
function extractProjectInsights(files: ScannedFile[]): string {
    if (files.length === 0) return 'No files.';

    // Group by directory
    const dirGroups: Record<string, { count: number; size: number; types: Record<string, number> }> = {};

    for (const file of files) {
        const lastSlash = file.path.lastIndexOf('/');
        const dirPath = lastSlash > 0 ? file.path.substring(0, lastSlash) : '/';

        if (!dirGroups[dirPath]) {
            dirGroups[dirPath] = { count: 0, size: 0, types: {} };
        }
        dirGroups[dirPath].count++;
        dirGroups[dirPath].size += file.size;
        dirGroups[dirPath].types[file.kind] = (dirGroups[dirPath].types[file.kind] || 0) + 1;
    }

    // Extract project-level paths (find the deepest meaningful folder)
    const projectStats: Record<string, { count: number; size: number; types: Record<string, number>; paths: string[] }> = {};

    for (const [dirPath, stats] of Object.entries(dirGroups)) {
        // Find the project name from path
        const userMatch = dirPath.match(/^\/Users\/[^/]+\/(.+)$/);
        const relativePath = userMatch ? userMatch[1] : dirPath;
        const parts = relativePath.split('/').filter(Boolean);

        // Find first non-generic folder as project identifier
        let projectName = '';
        let projectDepth = 0;

        for (let i = 0; i < parts.length; i++) {
            if (!GENERIC_FOLDERS.has(parts[i])) {
                // This is likely a project name
                projectName = parts[i];
                projectDepth = i;
                break;
            }
        }

        // If no project found, use the path structure
        if (!projectName) {
            projectName = parts.length > 1 ? parts[1] : parts[0] || 'root';
        }

        if (!projectStats[projectName]) {
            projectStats[projectName] = { count: 0, size: 0, types: {}, paths: [] };
        }
        projectStats[projectName].count += stats.count;
        projectStats[projectName].size += stats.size;
        projectStats[projectName].paths.push(relativePath);
        for (const [type, cnt] of Object.entries(stats.types)) {
            projectStats[projectName].types[type] = (projectStats[projectName].types[type] || 0) + cnt;
        }
    }

    // Sort by file count and take top projects
    const topProjects = Object.entries(projectStats)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

    // Build concise output
    const lines: string[] = [];

    for (const [name, stats] of topProjects) {
        const pct = Math.round((stats.count / files.length) * 100);
        const dominantType = Object.entries(stats.types).sort((a, b) => b[1] - a[1])[0];
        const typeStr = dominantType ? ` (${dominantType[0]})` : '';

        // Only include if it's meaningful (>5% of activity or >50 files)
        if (pct >= 5 || stats.count >= 50) {
            lines.push(`• "${name}": ${stats.count} files${typeStr}`);
        }
    }

    if (lines.length === 0) {
        // Fallback: just describe the activity
        const totalTypes: Record<string, number> = {};
        files.forEach(f => { totalTypes[f.kind] = (totalTypes[f.kind] || 0) + 1; });
        const mainType = Object.entries(totalTypes).sort((a, b) => b[1] - a[1])[0];
        return `Scattered activity across ${Object.keys(dirGroups).length} folders, mostly ${mainType?.[0] || 'mixed'} files.`;
    }

    return lines.join('\n');
}

/**
 * Find "hotspot" folders - directories where files are actually concentrated
 * Instead of showing ~/Desktop (14000 files), show ~/Desktop/egocity (14000 files)
 */
function buildFolderTreeForAnalysis(files: ScannedFile[]): string {
    if (files.length === 0) return 'No files found.';

    // Group files by their FULL directory path
    const dirGroups: Record<string, ScannedFile[]> = {};

    for (const file of files) {
        const lastSlash = file.path.lastIndexOf('/');
        const dirPath = lastSlash > 0 ? file.path.substring(0, lastSlash) : '/';

        if (!dirGroups[dirPath]) {
            dirGroups[dirPath] = [];
        }
        dirGroups[dirPath].push(file);
    }

    // Find "hotspot" directories - where most files are concentrated
    // Sort by file count to find the most active directories
    const sortedDirs = Object.entries(dirGroups)
        .map(([path, files]) => ({
            path,
            count: files.length,
            size: files.reduce((sum, f) => sum + f.size, 0),
            files: files.slice(0, 10), // Keep samples
        }))
        .sort((a, b) => b.count - a.count);

    // Take top hotspot directories
    const hotspots = sortedDirs.slice(0, MAX_HOTSPOTS);
    const hotspotTotal = hotspots.reduce((sum, h) => sum + h.count, 0);

    // Build output
    const lines: string[] = [];
    lines.push(`Activity concentrated in ${sortedDirs.length} folders:`);
    lines.push('');

    for (const hotspot of hotspots) {
        const folderName = getMeaningfulFolderName(hotspot.path);
        const percentage = Math.round((hotspot.count / files.length) * 100);

        // Get the short path for context
        let shortPath = hotspot.path;
        const userMatch = hotspot.path.match(/^\/Users\/[^/]+\/(.+)$/);
        if (userMatch) {
            shortPath = '~/' + userMatch[1];
        }

        lines.push(`📂 "${folderName}" - ${hotspot.count.toLocaleString()} files (${percentage}%)`);
        lines.push(`   Path: ${shortPath}`);

        // Analyze file types in this folder
        const typeCount: Record<string, number> = {};
        const extCount: Record<string, number> = {};
        for (const file of hotspot.files) {
            typeCount[file.kind] = (typeCount[file.kind] || 0) + 1;
            const ext = file.extension.toLowerCase();
            if (ext) extCount[ext] = (extCount[ext] || 0) + 1;
        }

        // Get dominant file type
        const dominantType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0];
        if (dominantType) {
            lines.push(`   Type: mostly ${dominantType[0]} files`);
        }

        // Sample file names (to understand the content)
        const samples = hotspot.files
            .slice(0, MAX_SAMPLE_FILES)
            .map(f => truncateFilename(f.name));
        if (samples.length > 0) {
            lines.push(`   Examples: ${samples.join(', ')}`);
        }

        lines.push('');
    }

    // Summary of coverage
    const coveragePercent = Math.round((hotspotTotal / files.length) * 100);
    if (coveragePercent < 100 && sortedDirs.length > MAX_HOTSPOTS) {
        const otherCount = files.length - hotspotTotal;
        lines.push(`+ ${otherCount.toLocaleString()} files scattered across ${sortedDirs.length - MAX_HOTSPOTS} other folders`);
    }

    // Safety truncation
    let result = lines.join('\n');
    if (result.length > MAX_TREE_CHARS) {
        result = result.substring(0, MAX_TREE_CHARS) + '\n...(truncated)';
    }

    return result;
}

const MAX_PROMPT_LENGTH = 3000; // Safety limit for total prompt

function generateBusiestDayPrompt(
    date: string,
    totalFiles: number,
    totalSize: number,
    folderTree: string,
    byType: Record<string, { count: number; size: number }>
): string {
    const dateStr = new Date(date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Format type breakdown (top 5 types only)
    const typeBreakdown = Object.entries(byType)
        .filter(([_, data]) => data.count > 0)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([type, data]) => `- ${type}: ${data.count.toLocaleString()} files`)
        .join('\n');

    const prompt = `Analyze this file activity and summarize what the user was doing.

Date: ${dateStr}
Total: ${totalFiles.toLocaleString()} files (${formatSize(totalSize)})

Types:
${typeBreakdown}

Hotspot folders (where files were actually concentrated):
${folderTree}

Based on the SPECIFIC folder names shown above, provide a 2-3 sentence insight. Guidelines:
- Based on the folder names and example files, infer the project name if any. Don't use generic ones like Desktop/Downloads
- If there's a dominant folder with many files, name its full path specifically
Be specific and avoid generic statements like "organizing files".`;

    // Safety truncation
    if (prompt.length > MAX_PROMPT_LENGTH) {
        const truncatedTree = folderTree.substring(0, folderTree.length - (prompt.length - MAX_PROMPT_LENGTH) - 50);
        return prompt.replace(folderTree, truncatedTree + '\n...(more folders)');
    }

    return prompt;
}

// ============================================
// Slide Components
// ============================================

interface SlideProps {
    children: React.ReactNode;
    className?: string;
}

function Slide({ children, className }: SlideProps) {
    return (
        <div className={cn(
            "flex flex-col items-center justify-center min-h-[500px] p-8 text-center",
            className
        )}>
            {children}
        </div>
    );
}

// Intro Slide
function IntroSlide({ year, totalFiles, totalSize, theme }: { year: number; totalFiles: number; totalSize: number; theme: ColorTheme }) {
    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-6 animate-fade-in">
                <div className={cn("flex items-center justify-center gap-3", theme.primary, "opacity-80")}>
                    <Sparkles className="h-5 w-5" />
                    <span className="text-sm font-medium uppercase tracking-widest">Your Year In Files</span>
                    <Sparkles className="h-5 w-5" />
                </div>
                <h1 className={cn("text-8xl font-black text-transparent bg-clip-text tracking-tight", theme.titleGradient)}>
                    {year}
                </h1>
                <p className="text-xl text-white/70 max-w-md">
                    Let&apos;s take a look back at what you created, collected, and stored this year.
                </p>
                <div className="relative mt-8">
                    <div className={cn("flex items-center justify-center gap-8 rounded-2xl px-8 py-6 border", theme.cardBg, theme.cardBorder)}>
                        <div className="text-center">
                            <p className={cn("text-4xl font-bold", theme.primary)}>{formatNumber(totalFiles)}</p>
                            <p className="text-sm text-white/50">Files</p>
                        </div>
                        <div className="h-12 w-px bg-white/20" />
                        <div className="text-center">
                            <p className={cn("text-4xl font-bold", theme.primary)}>{formatSize(totalSize)}</p>
                            <p className="text-sm text-white/50">Total Size</p>
                        </div>
                    </div>
                    {/* Cocoa mascot - bottom right of stats card */}
                    <img
                        src={cocoaMascot}
                        alt="Local Cocoa"
                        className="absolute -bottom-4 -right-6 h-14 w-14 opacity-80 drop-shadow-lg"
                    />
                </div>
                {/* File type disclaimer */}
                <p className="text-xs text-white/40 mt-6">
                    - File types include documents, images, videos, audio, compressed files, and books only
                </p>
            </div>
        </Slide>
    );
}

// GitHub-style Contribution Graph Slide
function ContributionGraphSlide({
    dailyActivity,
    year,
    busiestDay,
    totalFiles,
    busiestDayFiles,
    busiestDayTypeStats,
    aiInsight,
    isLoadingInsight,
    insightError,
    onGenerateInsight,
    theme
}: {
    dailyActivity: DayActivity[];
    year: number;
    busiestDay: { date: string; count: number } | null;
    totalFiles: number;
    busiestDayFiles: ScannedFile[];
    busiestDayTypeStats: Record<string, { count: number; size: number }>;
    // AI Insight props (lifted state)
    aiInsight: string | null;
    isLoadingInsight: boolean;
    insightError: string | null;
    onGenerateInsight: () => void;
    theme: ColorTheme;
}) {
    // Build the contribution grid
    // GitHub shows Sun-Sat as rows (7 rows), weeks as columns (52-53 columns)
    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Create a map for quick lookup
    const activityMap = useMemo(() => {
        const map = new Map<string, number>();
        dailyActivity.forEach(d => map.set(d.date, d.count));
        return map;
    }, [dailyActivity]);

    // Get max count for color scaling
    const maxCount = useMemo(() => {
        return Math.max(...dailyActivity.map(d => d.count), 1);
    }, [dailyActivity]);

    // Build the grid: 53 weeks x 7 days
    const grid = useMemo(() => {
        const weeks: Array<Array<{ date: string; count: number; isCurrentYear: boolean }>> = [];

        // Start from the first day of the year
        const startDate = new Date(year, 0, 1);
        // Find the first Sunday on or before Jan 1
        const firstSunday = new Date(startDate);
        firstSunday.setDate(startDate.getDate() - startDate.getDay());

        // End at Dec 31
        const endDate = new Date(year, 11, 31);

        const currentDate = new Date(firstSunday);
        let currentWeek: Array<{ date: string; count: number; isCurrentYear: boolean }> = [];

        while (currentDate <= endDate || currentWeek.length > 0) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const isCurrentYear = currentDate.getFullYear() === year;

            currentWeek.push({
                date: dateStr,
                count: isCurrentYear ? (activityMap.get(dateStr) || 0) : 0,
                isCurrentYear
            });

            if (currentWeek.length === 7) {
                weeks.push(currentWeek);
                currentWeek = [];
            }

            currentDate.setDate(currentDate.getDate() + 1);

            // Stop if we've passed end of year and completed the week
            if (currentDate > endDate && currentWeek.length === 0) {
                break;
            }
        }

        // Add any remaining days
        if (currentWeek.length > 0) {
            weeks.push(currentWeek);
        }

        return weeks;
    }, [year, activityMap]);

    // Get color based on activity level (fixed thresholds for better visibility)
    // Busiest day gets special gold color
    const getActivityColor = (count: number, isCurrentYear: boolean, isBusiestDay: boolean) => {
        if (!isCurrentYear) return 'bg-white/5';
        if (isBusiestDay) return theme.activityColors.busiest;
        if (count === 0) return theme.activityColors.empty;
        if (count <= 5) return theme.activityColors.level1;
        if (count <= 10) return theme.activityColors.level2;
        if (count <= 100) return theme.activityColors.level3;
        if (count <= 1000) return theme.activityColors.level4;
        return theme.activityColors.level5;
    };

    // Month labels positioning - only show months from the current year (skip Dec from previous year)
    const monthPositions = useMemo(() => {
        const positions: Array<{ month: string; weekIndex: number }> = [];
        let lastMonth = -1;

        grid.forEach((week, weekIndex) => {
            // Find a day in this week that belongs to the current year
            const dayInYear = week.find(d => {
                if (!d.isCurrentYear) return false;
                const date = new Date(d.date);
                return date.getFullYear() === year;
            });

            if (dayInYear) {
                const date = new Date(dayInYear.date);
                const month = date.getMonth();
                // Only add if it's a new month AND skip if it would be Dec from the start
                // (which would mean we're showing Dec from the year grid padding)
                if (month !== lastMonth) {
                    // Skip the first position if it's December (it would be from grid padding)
                    if (positions.length === 0 && month === 11) {
                        lastMonth = month;
                        return;
                    }
                    positions.push({ month: MONTH_NAMES[month], weekIndex });
                    lastMonth = month;
                }
            }
        });

        return positions;
    }, [grid, year]);

    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-6 w-full max-w-3xl animate-fade-in">
                <div className="space-y-2">
                    <Calendar className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <h2 className="text-3xl font-bold text-white">Your {year} Timeline</h2>
                    <p className="text-white/60">
                        {totalFiles.toLocaleString()} files across {dailyActivity.filter(d => d.count > 0).length} active days
                    </p>
                </div>

                {/* GitHub-style Contribution Graph */}
                <div className={cn("backdrop-blur rounded-xl p-4 overflow-x-auto border", theme.cardBg, theme.cardBorder)}>
                    {/* Month labels */}
                    <div className="relative h-4 mb-1 ml-8">
                        {monthPositions.map((pos, idx) => (
                            <span
                                key={idx}
                                className="absolute text-[10px] text-white/50 font-medium whitespace-nowrap"
                                style={{ left: `${pos.weekIndex * 12}px` }}
                            >
                                {pos.month}
                            </span>
                        ))}
                    </div>

                    {/* Grid with day labels */}
                    <div className="flex">
                        {/* Day labels column */}
                        <div className="flex flex-col justify-between mr-1 py-0.5">
                            {DAY_LABELS.map((day, idx) => (
                                <div
                                    key={day}
                                    className="text-[9px] text-white/40 h-[10px] leading-[10px]"
                                    style={{ visibility: idx % 2 === 1 ? 'visible' : 'hidden' }}
                                >
                                    {day}
                                </div>
                            ))}
                        </div>

                        {/* Contribution grid */}
                        <div className="flex gap-[2px]">
                            {grid.map((week, weekIdx) => (
                                <div key={weekIdx} className="flex flex-col gap-[2px]">
                                    {week.map((day, dayIdx) => {
                                        const isBusiestDay = busiestDay && day.date === busiestDay.date;
                                        return (
                                            <div
                                                key={day.date}
                                                className={cn(
                                                    "w-[10px] h-[10px] rounded-[2px] transition-all hover:ring-1 hover:ring-white/50",
                                                    getActivityColor(day.count, day.isCurrentYear, !!isBusiestDay),
                                                    isBusiestDay && "ring-2 ring-yellow-400 ring-offset-1 ring-offset-stone-900"
                                                )}
                                                title={day.isCurrentYear
                                                    ? `${new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${day.count} files${isBusiestDay ? ' 🏆 Busiest day!' : ''}`
                                                    : ''
                                                }
                                            />
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Legend */}
                    <div className="flex items-center justify-end gap-1 mt-3 text-[10px] text-white/50">
                        <span>Less</span>
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.empty)} title="0 files" />
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.level1)} title="1-5 files" />
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.level2)} title="6-10 files" />
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.level3)} title="11-100 files" />
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.level4)} title="101-1000 files" />
                        <div className={cn("w-[10px] h-[10px] rounded-[2px]", theme.activityColors.level5)} title=">1000 files" />
                        <span>More</span>
                    </div>
                </div>

                {/* Busiest Day Highlight */}
                {busiestDay && busiestDay.count > 0 && (
                    <div className="bg-yellow-600/10 backdrop-blur rounded-xl p-4 border border-yellow-600/20 space-y-3">
                        <div className="flex items-center gap-4">
                            <div className="h-12 w-12 rounded-full bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
                                <Award className="h-6 w-6 text-yellow-400" />
                            </div>
                            <div className="text-left flex-1">
                                <p className="text-white font-semibold">
                                    {new Date(busiestDay.date).toLocaleDateString('en-US', {
                                        weekday: 'long',
                                        month: 'long',
                                        day: 'numeric'
                                    })} was your busiest day
                                </p>
                                <p className="text-yellow-300/80 text-sm">
                                    {busiestDay.count.toLocaleString()} files modified
                                </p>
                            </div>
                            {/* AI Insight Button */}
                            {!aiInsight && !isLoadingInsight && (
                                <button
                                    onClick={onGenerateInsight}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 text-xs font-medium transition-colors"
                                >
                                    <Sparkles className="h-3.5 w-3.5" />
                                    Explain
                                </button>
                            )}
                        </div>

                        {/* Loading state */}
                        {isLoadingInsight && (
                            <div className="flex items-center gap-3 text-yellow-300/70 text-sm border-t border-yellow-500/20 pt-3 mt-2">
                                <div className="h-4 w-4 border-2 border-yellow-400/30 border-t-yellow-400 rounded-full animate-spin flex-shrink-0" />
                                <span className="text-left">Analyzing file activity...</span>
                            </div>
                        )}

                        {/* AI Insight display */}
                        {aiInsight && (
                            <div className="border-t border-yellow-500/20 pt-3 mt-2">
                                <div className="flex items-start gap-3">
                                    <Sparkles className="h-4 w-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                                    <p className="text-white/90 text-sm leading-relaxed text-left">
                                        {aiInsight}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Error state */}
                        {insightError && (
                            <div className="text-red-400/80 text-sm text-left border-t border-yellow-500/20 pt-3 mt-2">
                                {insightError}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Slide>
    );
}

// File Types Slide
function FileTypesSlide({ typeStats, files, theme }: { typeStats: FileTypeStats[]; files: ScannedFile[]; theme: ColorTheme }) {
    const topTypes = typeStats.filter(t => t.count > 0).slice(0, 6);
    const topType = topTypes[0];

    // Find representative files for each type
    // Use OLDEST file - gives a nostalgic "remember when" feeling for year review
    const representativeFiles = useMemo(() => {
        const result: Record<string, ScannedFile | null> = {};
        for (const type of topTypes) {
            const filesOfType = files
                .filter(f => f.kind === type.kind)
                // Sort by modification time (oldest first - for nostalgia)
                .sort((a, b) => new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime());

            // Try to find a file with a meaningful name (not generic like IMG_001, DSC_0001, etc.)
            const meaningfulFile = filesOfType.find(f => {
                const name = f.name.toLowerCase();
                // Skip generic camera/screenshot names
                if (/^(img_|dsc_|screenshot|screen shot|untitled|新建)/i.test(name)) return false;
                // Skip numbered-only files like 001.png, 1234.jpg
                if (/^\d+\.\w+$/.test(name)) return false;
                return true;
            });

            result[type.kind] = meaningfulFile || filesOfType[0] || null;
        }
        return result;
    }, [topTypes, files]);

    const openFile = (path: string) => {
        window.api.openFile(path);
    };

    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-6 w-full max-w-2xl animate-fade-in">
                <div className="space-y-2">
                    <Folder className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <h2 className="text-3xl font-bold text-white">Your File Mix</h2>
                    <p className="text-white/60">What types of files you worked with most</p>
                </div>

                {/* Top Type Hero */}
                {topType && (
                    <div className={cn("backdrop-blur rounded-2xl p-5 border", theme.cardBg, theme.cardBorder)}>
                        <div className="flex items-center gap-4">
                            <div className={cn("h-14 w-14 rounded-2xl flex items-center justify-center bg-gradient-to-br", theme.barShades[0])}>
                                {(() => {
                                    const Icon = FILE_TYPE_CONFIG[topType.kind].icon;
                                    return <Icon className="h-7 w-7 text-white" />;
                                })()}
                            </div>
                            <div className="text-left flex-1">
                                <p className={cn("text-sm opacity-80", theme.primary)}>Your #1 file type</p>
                                <p className="text-xl font-bold text-white">
                                    {FILE_TYPE_CONFIG[topType.kind].label}
                                </p>
                                <p className="text-white/60 text-sm">
                                    {topType.count.toLocaleString()} files · {Math.round(topType.percentage)}% of total
                                </p>
                            </div>
                        </div>
                        {/* Representative file for top type */}
                        {representativeFiles[topType.kind] && (() => {
                            const file = representativeFiles[topType.kind]!;
                            const date = new Date(file.modifiedAt);
                            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                            return (
                                <button
                                    onClick={() => openFile(file.path)}
                                    className="mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-left"
                                >
                                    <span className="text-base flex-shrink-0">💭</span>
                                    <span className={cn("text-xs italic opacity-80", theme.primaryLight)}>Remember this?</span>
                                    <span className="text-sm text-white/80 truncate flex-1">
                                        {file.name}
                                    </span>
                                    <span className="text-xs text-white/30">{dateStr}</span>
                                </button>
                            );
                        })()}
                    </div>
                )}

                {/* Other Types Grid with representative files */}
                <div className="grid grid-cols-3 gap-3">
                    {topTypes.slice(1, 7).map((type) => {
                        const config = FILE_TYPE_CONFIG[type.kind];
                        const Icon = config.icon;
                        const repFile = representativeFiles[type.kind];
                        return (
                            <div key={type.kind} className={cn("backdrop-blur rounded-xl p-3 border", theme.cardBg, theme.cardBorder)}>
                                <div className="text-center mb-2">
                                    <Icon className={cn("h-5 w-5 mx-auto mb-1", theme.primary)} />
                                    <p className="text-white font-medium text-sm">{config.label}</p>
                                    <p className="text-white/50 text-xs">{type.count.toLocaleString()}</p>
                                </div>
                                {/* Representative file */}
                                {repFile && (() => {
                                    const date = new Date(repFile.modifiedAt);
                                    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                    return (
                                        <button
                                            onClick={() => openFile(repFile.path)}
                                            className="w-full mt-2 pt-2 border-t border-white/10 text-left hover:bg-white/5 rounded px-1 py-1 transition-colors"
                                            title={`${repFile.name} · ${dateStr}`}
                                        >
                                            <p className="text-[10px] text-white/40 truncate">
                                                {repFile.name}
                                            </p>
                                            <p className="text-[9px] text-white/30">
                                                {dateStr}
                                            </p>
                                        </button>
                                    );
                                })()}
                            </div>
                        );
                    })}
                </div>
            </div>
        </Slide>
    );
}

// Storage Slide
function StorageSlide({ typeStats, totalSize, theme }: { typeStats: FileTypeStats[]; totalSize: number; theme: ColorTheme }) {
    const sortedBySize = [...typeStats]
        .filter(t => t.size > 0)
        .sort((a, b) => b.size - a.size)
        .slice(0, 5);

    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-8 w-full max-w-2xl animate-fade-in">
                <div className="space-y-2">
                    <HardDrive className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <h2 className="text-3xl font-bold text-white">Storage Breakdown</h2>
                    <p className="text-white/60">
                        You stored <span className={cn("font-semibold", theme.primary)}>{formatSize(totalSize)}</span> of files
                    </p>
                </div>

                {/* Stacked Bar */}
                <div className="w-full h-8 rounded-full overflow-hidden flex bg-white/10">
                    {sortedBySize.map((type, idx) => {
                        const width = (type.size / totalSize) * 100;
                        if (width < 1) return null;
                        return (
                            <div
                                key={type.kind}
                                className={cn("h-full bg-gradient-to-r", theme.barShades[idx] || theme.barShades[4])}
                                style={{ width: `${width}%` }}
                                title={`${FILE_TYPE_CONFIG[type.kind].label}: ${formatSize(type.size)}`}
                            />
                        );
                    })}
                </div>

                {/* Legend */}
                <div className="space-y-2">
                    {sortedBySize.map((type, idx) => {
                        const config = FILE_TYPE_CONFIG[type.kind];
                        const Icon = config.icon;
                        const percentage = (type.size / totalSize) * 100;
                        return (
                            <div key={type.kind} className="flex items-center gap-3 bg-white/5 rounded-lg p-3 border border-white/10">
                                <div className={cn("h-3 w-3 rounded-full", theme.dotColors[idx] || theme.dotColors[4])} />
                                <Icon className="h-5 w-5 text-white/60" />
                                <span className="text-white font-medium flex-1 text-left">{config.label}</span>
                                <span className="text-white/50 text-sm">{formatSize(type.size)}</span>
                                <span className={cn("text-sm w-12 text-right opacity-80", theme.primary)}>{percentage.toFixed(1)}%</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Slide>
    );
}

// Top Files Slide
function TopFilesSlide({ topFiles, theme }: { topFiles: TopFile[]; theme: ColorTheme }) {
    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-8 w-full max-w-2xl animate-fade-in">
                <div className="space-y-2">
                    <TrendingUp className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <h2 className="text-3xl font-bold text-white">Your Largest Files</h2>
                    <p className="text-white/60">The biggest files taking up your storage</p>
                </div>

                <div className="space-y-2">
                    {topFiles.slice(0, 5).map((file, idx) => {
                        const config = FILE_TYPE_CONFIG[file.kind];
                        const Icon = config.icon;
                        return (
                            <div
                                key={file.path}
                                className="flex items-center gap-4 bg-white/5 backdrop-blur rounded-xl p-4 border border-white/10"
                            >
                                <div className={cn(
                                    "h-10 w-10 rounded-lg flex items-center justify-center text-lg font-bold",
                                    theme.badgeColors[idx] || theme.badgeColors[4]
                                )}>
                                    {idx + 1}
                                </div>
                                <Icon className="h-5 w-5 flex-shrink-0 text-white/60" />
                                <div className="flex-1 min-w-0 text-left">
                                    <p className="text-white font-medium truncate">{file.name}</p>
                                    <p className="text-white/40 text-xs truncate">{file.path}</p>
                                </div>
                                <span className={cn("font-semibold", theme.primary)}>{formatSize(file.size)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Slide>
    );
}

// Month names constant (outside component to prevent re-creation)
const MONTH_FULL_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// Monthly Recap Slide - AI-powered month-by-month summary
function MonthlyRecapSlide({
    monthStats,
    monthlyFiles,
    year,
    isActive,
    theme
}: {
    monthStats: MonthStats[];
    monthlyFiles: ScannedFile[][];
    year: number;
    isActive: boolean;
    theme: ColorTheme;
}) {
    const storageKey = `year-review-monthly-${year}`;

    // Calculate monthly highlights (top folder and file for each month)
    const monthlyHighlights = useMemo(() => {
        return monthlyFiles.map((files, month) => {
            if (files.length === 0) return null;

            // Find top folder (excluding generic ones)
            const folderCounts: Record<string, { count: number; path: string }> = {};
            for (const file of files) {
                const lastSlash = file.path.lastIndexOf('/');
                const dirPath = lastSlash > 0 ? file.path.substring(0, lastSlash) : '/';
                const folderName = getMeaningfulFolderName(dirPath);

                // Skip if the folder name is generic
                if (GENERIC_FOLDERS.has(folderName)) continue;

                if (!folderCounts[folderName]) {
                    folderCounts[folderName] = { count: 0, path: dirPath };
                }
                folderCounts[folderName].count++;
            }

            const topFolder = Object.entries(folderCounts)
                .filter(([name]) => !GENERIC_FOLDERS.has(name))
                .sort((a, b) => b[1].count - a[1].count)[0];

            // Find largest/most notable file (skip tiny files and files in generic folders)
            const notableFile = files
                .filter(f => {
                    if (f.size < 1024) return false; // At least 1KB
                    // Check if file is in a generic folder
                    const pathParts = f.path.split('/');
                    const parentFolder = pathParts[pathParts.length - 2];
                    return !GENERIC_FOLDERS.has(parentFolder);
                })
                .sort((a, b) => b.size - a.size)[0]
                // Fallback: if no file found outside generic folders, just get largest
                || files.filter(f => f.size > 1024).sort((a, b) => b.size - a.size)[0];

            return {
                folder: topFolder ? { name: topFolder[0], path: topFolder[1].path, count: topFolder[1].count } : null,
                file: notableFile ? { name: notableFile.name, path: notableFile.path, size: notableFile.size } : null,
            };
        });
    }, [monthlyFiles]);

    // Initialize state from sessionStorage if available
    const [monthSummaries, setMonthSummaries] = useState<Record<number, string>>(() => {
        try {
            const saved = sessionStorage.getItem(storageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                return parsed.summaries || {};
            }
            // eslint-disable-next-line no-empty
        } catch { }
        return {};
    });
    const [loadingMonth, setLoadingMonth] = useState<number | null>(null);
    const [visibleMonths, setVisibleMonths] = useState<number[]>(() => {
        try {
            const saved = sessionStorage.getItem(storageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                return parsed.visible || [];
            }
            // eslint-disable-next-line no-empty
        } catch { }
        return [];
    });
    const [hasCompleted, setHasCompleted] = useState<boolean>(() => {
        try {
            const saved = sessionStorage.getItem(storageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                return parsed.completed || false;
            }
            // eslint-disable-next-line no-empty
        } catch { }
        return false;
    });
    const [hasStarted, setHasStarted] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);

    // Ref to prevent re-runs of progressive loading
    const hasGeneratedRef = useRef(false);

    // Save to sessionStorage whenever summaries update
    useEffect(() => {
        if (Object.keys(monthSummaries).length > 0) {
            sessionStorage.setItem(storageKey, JSON.stringify({
                summaries: monthSummaries,
                visible: visibleMonths,
                completed: hasCompleted
            }));
        }
    }, [monthSummaries, visibleMonths, hasCompleted, storageKey]);

    // Refresh/regenerate all summaries
    const handleRefresh = useCallback(() => {
        // Clear storage and state
        sessionStorage.removeItem(storageKey);
        setMonthSummaries({});
        setVisibleMonths([]);
        setHasCompleted(false);
        setHasStarted(false);
        setIsGenerating(false);
        hasGeneratedRef.current = false;
        // Trigger restart
        setTimeout(() => setHasStarted(true), 300);
    }, [storageKey]);

    // Open folder or file in Finder
    const openInFinder = useCallback((path: string) => {
        window.api.openFile(path);
    }, []);

    // Generate prompt for a specific month
    const generateMonthPrompt = useCallback((month: number, files: ScannedFile[]): string => {
        const projectInsights = extractProjectInsights(files);
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Get type breakdown
        const typeCount: Record<string, number> = {};
        files.forEach(f => {
            typeCount[f.kind] = (typeCount[f.kind] || 0) + 1;
        });
        const mainTypes = Object.entries(typeCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');

        return `Write a personal recap for the user in ONE sentence (under 30 words).

${MONTH_FULL_NAMES[month]} ${year}: ${files.length.toLocaleString()} files, mainly ${mainTypes}

Active projects:
${projectInsights}

Use "You" (second person). Be warm and specific.
Focus on project names from above. Skip generic folders like Downloads/Desktop.`;
    }, [year]);

    // Generate summary for a single month
    const generateMonthlySummary = useCallback(async (month: number) => {
        const files = monthlyFiles[month];
        if (files.length === 0) {
            setMonthSummaries(prev => ({ ...prev, [month]: 'No activity this month.' }));
            return;
        }

        if (files.length < 10) {
            setMonthSummaries(prev => ({
                ...prev,
                [month]: `Light activity with ${files.length} files.`
            }));
            return;
        }

        setLoadingMonth(month);
        try {
            const prompt = generateMonthPrompt(month, files);
            const response = await window.api.ask(prompt, 1, 'chat');
            const summary = response.answer?.trim() || 'Unable to generate summary.';
            setMonthSummaries(prev => ({ ...prev, [month]: summary }));
        } catch (error) {
            console.error(`Failed to generate summary for month ${month}:`, error);
            setMonthSummaries(prev => ({
                ...prev,
                [month]: `${files.length.toLocaleString()} files modified.`
            }));
        } finally {
            setLoadingMonth(null);
        }
    }, [monthlyFiles, generateMonthPrompt]);

    // Progressive loading effect
    useEffect(() => {
        // Skip if already completed (restored from sessionStorage)
        if (hasCompleted) {
            hasGeneratedRef.current = true;
            return;
        }

        if (!hasStarted || isGenerating || hasGeneratedRef.current) return;

        hasGeneratedRef.current = true;
        setIsGenerating(true);

        const loadMonths = async () => {
            for (let month = 0; month < 12; month++) {
                // First show the month (animate in)
                setVisibleMonths(prev => [...prev, month]);

                // Wait for animation to complete before starting AI
                await new Promise(resolve => setTimeout(resolve, 400));

                // Generate summary (this already takes time due to API call)
                await generateMonthlySummary(month);

                // Pause before showing next month
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            setIsGenerating(false);
            setHasCompleted(true);
        };

        loadMonths();
    }, [hasStarted, isGenerating, hasCompleted, generateMonthlySummary]);

    // Start loading when slide becomes active (only if not already completed)
    useEffect(() => {
        if (hasCompleted || !isActive || hasStarted) return;
        const timer = setTimeout(() => setHasStarted(true), 500);
        return () => clearTimeout(timer);
    }, [isActive, hasStarted, hasCompleted]);

    return (
        <Slide className={cn(theme.slideGradient, "!text-left")}>
            <div className="space-y-4 w-full max-w-2xl animate-fade-in">
                <div className="space-y-2 mb-6 text-center">
                    <Clock className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <div className="flex items-center justify-center gap-2">
                        <h2 className="text-3xl font-bold text-white">Your Year in Review</h2>
                        <button
                            onClick={handleRefresh}
                            disabled={isGenerating}
                            className={cn(
                                "p-1.5 rounded-full transition-all",
                                isGenerating
                                    ? "opacity-30 cursor-not-allowed"
                                    : "hover:bg-white/10 text-white/40 hover:text-white/80"
                            )}
                            title="Regenerate summaries"
                        >
                            <RefreshCw className={cn("h-4 w-4", isGenerating && "animate-spin")} />
                        </button>
                    </div>
                    <p className="text-white/60">Month by month breakdown</p>
                </div>

                {/* Timeline container with scroll */}
                <div className="max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                    <div className="relative pl-8">
                        {/* Timeline line - positioned to align with dot centers */}
                        <div className={cn("absolute left-[17px] top-0 bottom-0 w-0.5", theme.timelineGradient)} />

                        {/* Months */}
                        <div className="space-y-3">
                            {MONTH_FULL_NAMES.map((monthName, month) => {
                                const isVisible = visibleMonths.includes(month);
                                const isLoading = loadingMonth === month;
                                const summary = monthSummaries[month];
                                const stats = monthStats[month];
                                const hasActivity = stats.count > 0;
                                const highlights = monthlyHighlights[month];

                                return (
                                    <div
                                        key={month}
                                        className={cn(
                                            "relative transition-all duration-700 ease-out",
                                            isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-6"
                                        )}
                                    >
                                        {/* Timeline dot */}
                                        <div className={cn(
                                            "absolute -left-5 top-2 w-3 h-3 rounded-full border-2 transition-colors",
                                            hasActivity
                                                ? cn(theme.timelineDot, theme.timelineDotBorder)
                                                : "bg-slate-700 border-slate-600"
                                        )} />

                                        {/* Month content */}
                                        <div className={cn(
                                            "bg-white/5 rounded-lg p-3 border transition-all",
                                            hasActivity
                                                ? "border-white/10"
                                                : "border-white/5 opacity-50"
                                        )}>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="font-semibold text-white">
                                                    {monthName}
                                                </span>
                                                <span className="text-xs text-white/40">
                                                    {stats.count > 0
                                                        ? `${stats.count.toLocaleString()} files · ${formatSize(stats.size)}`
                                                        : 'No activity'
                                                    }
                                                </span>
                                            </div>

                                            {/* AI Summary */}
                                            <div className="text-sm text-white/70 mb-2">
                                                {isLoading ? (
                                                    <div className={cn("flex items-center gap-2 opacity-70", theme.primary)}>
                                                        <div className={cn("w-3 h-3 border-2 rounded-full animate-spin", theme.timelineDotBorder, "border-t-current opacity-30")} style={{ borderTopColor: 'currentColor', borderTopWidth: '2px' }} />
                                                        <span>Analyzing...</span>
                                                    </div>
                                                ) : summary ? (
                                                    <span>{summary}</span>
                                                ) : !hasActivity ? (
                                                    <span className="text-white/40 italic">—</span>
                                                ) : (
                                                    <span className="text-white/30">Waiting...</span>
                                                )}
                                            </div>

                                            {/* Monthly Highlights */}
                                            {hasActivity && highlights && summary && !isLoading && (
                                                <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-white/5">
                                                    {highlights.folder && (
                                                        <button
                                                            onClick={() => openInFinder(highlights.folder!.path)}
                                                            className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors text-xs text-white/60 hover:text-white/90"
                                                            title={`Open folder: ${highlights.folder.path}`}
                                                        >
                                                            <FolderOpen className={cn("h-3 w-3", theme.primary)} />
                                                            <span className="truncate max-w-[120px]">{highlights.folder.name}</span>
                                                            <span className="text-white/30">({highlights.folder.count})</span>
                                                        </button>
                                                    )}
                                                    {highlights.file && (
                                                        <button
                                                            onClick={() => openInFinder(highlights.file!.path)}
                                                            className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors text-xs text-white/60 hover:text-white/90"
                                                            title={`Open file: ${highlights.file.path}`}
                                                        >
                                                            <File className={cn("h-3 w-3", theme.secondary)} />
                                                            <span className="truncate max-w-[120px]">{highlights.file.name}</span>
                                                            <span className="text-white/30">({formatSize(highlights.file.size)})</span>
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </Slide>
    );
}

// Fun Facts Slide
function FunFactsSlide({
    totalFiles,
    totalSize,
    avgFilesPerDay,
    year,
    files,
    theme
}: {
    totalFiles: number;
    totalSize: number;
    avgFilesPerDay: number;
    year: number;
    files: ScannedFile[];
    theme: ColorTheme;
}) {
    // Find the file closest to 5am (the ultimate night owl moment)
    // 5am is the boundary - anything before 5am counts as "staying up late"
    const nightOwlFile = useMemo(() => {
        let closestTo5am: ScannedFile | null = null;
        let closestMinutes = Infinity; // minutes away from 5:00 AM

        for (const file of files) {
            const date = new Date(file.modifiedAt);
            const hour = date.getHours();
            const minutes = date.getMinutes();

            // Only consider files between 10pm (22:00) and 5am (05:00)
            if (hour >= 22 || hour < 5) {
                // Calculate minutes until 5am
                // 22:00 -> 7*60=420 min to 5am
                // 00:00 -> 5*60=300 min to 5am
                // 04:59 -> 1 min to 5am
                let minutesTo5am: number;
                if (hour >= 22) {
                    minutesTo5am = (24 - hour + 5) * 60 - minutes;
                } else {
                    minutesTo5am = (5 - hour) * 60 - minutes;
                }

                if (minutesTo5am < closestMinutes) {
                    closestMinutes = minutesTo5am;
                    closestTo5am = file;
                }
            }
        }

        if (closestTo5am) {
            const date = new Date(closestTo5am.modifiedAt);
            const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return { file: closestTo5am, time: timeStr };
        }
        return null;
    }, [files]);

    // Find favorite and laziest day of week (using averages)
    const dayOfWeekStats = useMemo(() => {
        const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const FILE_CAP_PER_DAY = 500; // Cap to prevent single outlier day from skewing

        // Group by actual date first, then apply cap
        const dateGroups: Record<string, number> = {};
        for (const file of files) {
            const dateKey = file.modifiedAt.split('T')[0];
            dateGroups[dateKey] = (dateGroups[dateKey] || 0) + 1;
        }

        // Sum files by day of week with cap
        for (const [dateKey, count] of Object.entries(dateGroups)) {
            const day = new Date(dateKey).getDay();
            dayCounts[day] += Math.min(count, FILE_CAP_PER_DAY);
        }

        // Find max and min
        let maxDay = 0, minDay = 0;
        let maxCount = 0, minCount = Infinity;
        dayCounts.forEach((count, day) => {
            if (count > maxCount) { maxCount = count; maxDay = day; }
            if (count < minCount && count > 0) { minCount = count; minDay = day; }
        });

        // Calculate percentages
        const totalFiles = dayCounts.reduce((a, b) => a + b, 0);
        const busyPercentage = totalFiles > 0 ? Math.round((maxCount / totalFiles) * 100) : 0;
        const lazyPercentage = totalFiles > 0 ? Math.round((minCount / totalFiles) * 100) : 0;

        return {
            busyDay: dayNames[maxDay],
            busyCount: maxCount,
            busyPercentage,
            lazyDay: dayNames[minDay],
            lazyCount: minCount,
            lazyPercentage
        };
    }, [files]);

    // Find most active hour of day (using total counts with cap)
    const mostActiveHour = useMemo(() => {
        const hourCounts = Array(24).fill(0);
        const FILE_CAP_PER_HOUR_PER_DAY = 200; // Cap to prevent single outlier day from skewing

        // Group by date+hour first, then apply cap
        const dateHourGroups: Record<string, number> = {};
        for (const file of files) {
            const date = new Date(file.modifiedAt);
            const dateKey = file.modifiedAt.split('T')[0];
            const hour = date.getHours();
            const key = `${dateKey}_${hour}`; // Use underscore to avoid confusion with date dashes
            dateHourGroups[key] = (dateHourGroups[key] || 0) + 1;
        }

        // Apply cap and sum by hour
        for (const [key, count] of Object.entries(dateHourGroups)) {
            const hour = parseInt(key.split('_')[1]);
            hourCounts[hour] += Math.min(count, FILE_CAP_PER_HOUR_PER_DAY);
        }

        // Find max
        let maxHour = 0;
        let maxCount = 0;
        hourCounts.forEach((count, hour) => {
            if (count > maxCount) {
                maxCount = count;
                maxHour = hour;
            }
        });

        // Format hour range nicely (e.g., "2-3 PM")
        const formatHour = (h: number) => {
            if (h === 0) return '12 AM';
            if (h < 12) return `${h} AM`;
            if (h === 12) return '12 PM';
            return `${h - 12} PM`;
        };
        const hourStr = `${formatHour(maxHour)}-${formatHour((maxHour + 1) % 24)}`;

        // Calculate percentage of total
        const totalFiles = hourCounts.reduce((a, b) => a + b, 0);
        const percentage = totalFiles > 0 ? Math.round((maxCount / totalFiles) * 100) : 0;

        return { hour: hourStr, count: maxCount, percentage };
    }, [files]);

    // Calculate average files per month
    const avgFilesPerMonth = useMemo(() => {
        return Math.round(files.length / 12);
    }, [files]);

    const openFile = (path: string) => {
        window.api.openFile(path);
    };

    // Format night owl date
    const nightOwlDate = nightOwlFile
        ? new Date(nightOwlFile.file.modifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';

    const funFacts = [
        {
            icon: Calendar,
            label: "Most Active Day",
            value: dayOfWeekStats.busyDay,
            subtitle: `${dayOfWeekStats.busyCount.toLocaleString()} files (${dayOfWeekStats.busyPercentage}%) · ${dayOfWeekStats.lazyDay} laziest`,
            color: theme.primary
        },
        {
            icon: Clock,
            label: "Peak Hour",
            value: mostActiveHour.hour,
            subtitle: `${mostActiveHour.count.toLocaleString()} files (${mostActiveHour.percentage}%)`,
            color: theme.primary
        },
        nightOwlFile && {
            icon: Zap,
            label: "🦉 Night Owl Moment",
            value: `${nightOwlFile.time} · ${nightOwlDate}`,
            subtitle: nightOwlFile.file.name.length > 25
                ? nightOwlFile.file.name.substring(0, 25) + '...'
                : nightOwlFile.file.name,
            color: theme.primary,
            onClick: () => openFile(nightOwlFile.file.path)
        },
        {
            icon: HardDrive,
            label: "Storage Growth",
            value: `${formatSize(totalSize / 12)}/month`,
            subtitle: `${avgFilesPerMonth.toLocaleString()} files/month`,
            color: theme.primary
        }
    ].filter(Boolean);

    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-8 w-full max-w-2xl animate-fade-in">
                <div className="space-y-2">
                    <Sparkles className={cn("h-10 w-10 mx-auto", theme.primary)} />
                    <h2 className="text-3xl font-bold text-white">Fun Facts</h2>
                    <p className="text-white/60">Interesting insights from your {year}</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    {funFacts.map((fact, idx) => {
                        if (!fact) return null;
                        const Icon = fact.icon;
                        const isClickable = 'onClick' in fact && fact.onClick;
                        const Wrapper = isClickable ? 'button' : 'div';
                        return (
                            <Wrapper
                                key={idx}
                                className={cn(
                                    "bg-white/5 backdrop-blur rounded-2xl p-6 text-left border border-white/10",
                                    isClickable && "hover:bg-white/10 transition-colors cursor-pointer"
                                )}
                                onClick={isClickable ? fact.onClick : undefined}
                            >
                                <Icon className={cn("h-8 w-8 mb-3", fact.color)} />
                                <p className="text-white/50 text-sm">{fact.label}</p>
                                <p className="text-white font-semibold text-lg">{fact.value}</p>
                                {'subtitle' in fact && fact.subtitle && (
                                    <p className={cn(
                                        "text-white/40 text-xs mt-1 truncate",
                                        isClickable && "hover:text-white/60"
                                    )}>{fact.subtitle}</p>
                                )}
                            </Wrapper>
                        );
                    })}
                </div>
            </div>
        </Slide>
    );
}

// Outro Slide
function OutroSlide({
    year,
    totalFiles,
    onSaveReport,
    isSaving,
    theme
}: {
    year: number;
    totalFiles: number;
    onSaveReport: () => void;
    isSaving: boolean;
    theme: ColorTheme;
}) {
    return (
        <Slide className={theme.slideGradient}>
            <div className="space-y-6 animate-fade-in">
                <Sparkles className={cn("h-12 w-12 mx-auto animate-pulse", theme.primary)} />
                <h2 className={cn("text-4xl font-bold text-transparent bg-clip-text", theme.titleGradient)}>
                    That&apos;s a wrap on {year}!
                </h2>
                <p className="text-xl text-white/70 max-w-md">
                    You managed <span className={cn("font-bold", theme.primary)}>{totalFiles.toLocaleString()}</span> files this year.
                    Here&apos;s to an even more productive {year + 1}!
                </p>

                {/* Save Report Button */}
                <button
                    onClick={onSaveReport}
                    disabled={isSaving}
                    className={cn("mt-4 flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed mx-auto", theme.buttonGradient, theme.buttonHoverGradient)}
                >
                    {isSaving ? (
                        <>
                            <RefreshCw className="h-5 w-5 animate-spin" />
                            Generating...
                        </>
                    ) : (
                        <>
                            <Download className="h-5 w-5" />
                            Save as Image
                        </>
                    )}
                </button>

                <div className="mt-8 space-y-2">
                    <div className="text-white/30 text-sm flex items-center justify-center gap-2">
                        <span>Generated by</span>
                        <span className={cn("font-semibold", theme.primary)}>Local Cocoa</span>
                        <img
                            src={cocoaMascot}
                            alt="Local Cocoa"
                            className="h-5 w-5 inline-block"
                        />
                    </div>
                    <div className="text-white/20 text-xs flex items-center justify-center gap-2">
                        <span>Powered by</span>
                        <span className="font-medium text-white/40">Synvo AI</span>
                        <img
                            src={synvoAiLogo}
                            alt="Synvo AI"
                            className="h-4 w-4 inline-block"
                        />
                    </div>
                </div>
            </div>
        </Slide>
    );
}

// ============================================
// Main Component
// ============================================

export function YearInReviewModal({ isOpen, onClose, files, year }: YearInReviewModalProps) {
    const [currentSlide, setCurrentSlide] = useState(0);

    // Get current skin and corresponding color theme
    const { skin } = useSkin();
    const theme = COLOR_THEMES[skin];

    // AI Insight state (lifted here to persist across slide changes)
    const [aiInsight, setAiInsight] = useState<string | null>(null);
    const [isLoadingInsight, setIsLoadingInsight] = useState(false);
    const [insightError, setInsightError] = useState<string | null>(null);

    // Save report state
    const [isSaving, setIsSaving] = useState(false);

    // Calculate all stats
    const stats = useMemo(() => {
        if (files.length === 0) return null;

        // Total stats
        const totalFiles = files.length;
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Monthly stats and files grouping
        const monthStats: MonthStats[] = Array.from({ length: 12 }, (_, i) => ({
            month: i,
            count: 0,
            size: 0,
        }));

        const monthlyFiles: ScannedFile[][] = Array.from({ length: 12 }, () => []);
        const dailyCounts: Record<string, number> = {};

        files.forEach(file => {
            const date = new Date(file.modifiedAt);
            const month = date.getMonth();
            monthStats[month].count++;
            monthStats[month].size += file.size;
            monthlyFiles[month].push(file);

            const dayKey = date.toISOString().split('T')[0];
            dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;
        });

        // Busiest day
        const busiestDay = Object.entries(dailyCounts).reduce<{ date: string; count: number } | null>(
            (max, [date, count]) => {
                if (!max || count > max.count) {
                    return { date, count };
                }
                return max;
            },
            null
        );

        // Daily activity for contribution graph
        const dailyActivity: DayActivity[] = Object.entries(dailyCounts).map(([date, count]) => {
            const d = new Date(date);
            return {
                date,
                count,
                dayOfWeek: d.getDay(),
                weekIndex: Math.floor((d.getTime() - new Date(year, 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))
            };
        });

        // File type stats
        const typeMap: Record<FileKind, { count: number; size: number }> = {} as any;
        files.forEach(file => {
            if (!typeMap[file.kind]) {
                typeMap[file.kind] = { count: 0, size: 0 };
            }
            typeMap[file.kind].count++;
            typeMap[file.kind].size += file.size;
        });

        const typeStats: FileTypeStats[] = Object.entries(typeMap)
            .map(([kind, data]) => ({
                kind: kind as FileKind,
                count: data.count,
                size: data.size,
                percentage: (data.count / totalFiles) * 100,
            }))
            .sort((a, b) => b.count - a.count);

        // Origin stats
        const originMap: Record<FileOrigin, number> = {} as any;
        files.forEach(file => {
            const origin = file.origin || 'unknown';
            originMap[origin] = (originMap[origin] || 0) + 1;
        });

        const originStats: OriginStats[] = Object.entries(originMap)
            .map(([origin, count]) => ({
                origin: origin as FileOrigin,
                count,
                percentage: (count / totalFiles) * 100,
            }))
            .sort((a, b) => b.count - a.count);

        // Top files by size
        const topFiles: TopFile[] = [...files]
            .sort((a, b) => b.size - a.size)
            .slice(0, 10)
            .map(f => ({
                name: f.name,
                path: f.path,
                size: f.size,
                kind: f.kind,
                modifiedAt: f.modifiedAt,
            }));

        // Unique extensions
        const extensions = new Set(files.map(f => f.extension.toLowerCase()));

        // Average files per day (rough estimate based on days in year)
        const daysInYear = Object.keys(dailyCounts).length || 1;
        const avgFilesPerDay = totalFiles / daysInYear;

        // Busiest day files and type stats for AI analysis
        const busiestDayDate = busiestDay?.date || '';
        const busiestDayFiles: ScannedFile[] = busiestDayDate
            ? files.filter(f => f.modifiedAt.startsWith(busiestDayDate))
            : [];

        const busiestDayTypeStats: Record<string, { count: number; size: number }> = {};
        for (const file of busiestDayFiles) {
            const kind = file.kind;
            if (!busiestDayTypeStats[kind]) {
                busiestDayTypeStats[kind] = { count: 0, size: 0 };
            }
            busiestDayTypeStats[kind].count++;
            busiestDayTypeStats[kind].size += file.size;
        }

        return {
            totalFiles,
            totalSize,
            monthStats,
            monthlyFiles,
            dailyActivity,
            typeStats,
            originStats,
            topFiles,
            busiestDay,
            busiestDayFiles,
            busiestDayTypeStats,
            avgFilesPerDay,
            uniqueExtensions: extensions.size,
        };
    }, [files, year]);

    // Generate AI insight callback
    const generateInsight = useCallback(async () => {
        if (!stats?.busiestDay || stats.busiestDayFiles.length === 0) return;

        setIsLoadingInsight(true);
        setInsightError(null);

        try {
            const folderTree = buildFolderTreeForAnalysis(stats.busiestDayFiles);
            const totalSize = stats.busiestDayFiles.reduce((sum, f) => sum + f.size, 0);
            const busiestDay = stats.busiestDay!;
            const prompt = generateBusiestDayPrompt(
                busiestDay.date,
                busiestDay.count,
                totalSize,
                folderTree,
                stats.busiestDayTypeStats
            );

            const response = await window.api.ask(prompt, 1, 'chat');
            setAiInsight(response.answer?.trim() || 'Unable to generate insight.');
        } catch (error) {
            console.error('Failed to generate insight:', error);
            setInsightError('Failed to generate insight. Please try again.');
        } finally {
            setIsLoadingInsight(false);
        }
    }, [stats]);

    // Handle save report as image - renders ALL slides as one long image
    const handleSaveReport = useCallback(async () => {
        if (isSaving || !stats) return;

        setIsSaving(true);

        try {
            // Get monthly summaries from sessionStorage
            const storageKey = `year-review-monthly-${year}`;
            let monthlySummaries: Record<number, string> = {};
            try {
                const stored = sessionStorage.getItem(storageKey);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    monthlySummaries = parsed.summaries || {};
                }
            } catch (e) { /* ignore */ }

            // Prepare file types data (typeStats is already FileTypeStats[])
            const fileTypes = stats.typeStats.slice(0, 6).map(t => ({
                label: FILE_TYPE_CONFIG[t.kind]?.label || t.kind,
                count: t.count,
                size: t.size,
                percentage: Math.round(t.percentage)
            }));

            const storageTypes = [...stats.typeStats]
                .sort((a, b) => b.size - a.size)
                .slice(0, 5)
                .map(t => ({
                    label: FILE_TYPE_CONFIG[t.kind]?.label || t.kind,
                    size: formatSize(t.size),
                    percentage: Math.round((t.size / stats.totalSize) * 100)
                }));

            // Build contribution graph data - properly aligned grid
            const dateCountMap: Record<string, number> = {};
            stats.dailyActivity.forEach(d => {
                dateCountMap[d.date] = d.count;
            });

            // Build a 53x7 grid (53 weeks, 7 days)
            // Week 0 starts at the first Sunday on or before Jan 1
            const jan1 = new Date(year, 0, 1);
            const jan1Day = jan1.getDay(); // 0=Sun, 1=Mon, etc

            // Calculate the Sunday that starts week 0
            const firstSunday = new Date(jan1);
            firstSunday.setDate(1 - jan1Day);

            const gridData: { week: number; day: number; count: number; date: string; inYear: boolean }[] = [];

            for (let week = 0; week < 53; week++) {
                for (let day = 0; day < 7; day++) {
                    const cellDate = new Date(firstSunday);
                    cellDate.setDate(firstSunday.getDate() + week * 7 + day);
                    const dateStr = cellDate.toISOString().split('T')[0];
                    const inYear = cellDate.getFullYear() === year;
                    gridData.push({
                        week,
                        day,
                        count: inYear ? (dateCountMap[dateStr] || 0) : 0,
                        date: dateStr,
                        inYear
                    });
                }
            }

            // Calculate fun facts data
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const dayCounts = [0, 0, 0, 0, 0, 0, 0];
            const hourCounts = Array(24).fill(0);
            const FILE_CAP_PER_DAY = 500;
            const FILE_CAP_PER_HOUR = 200;

            // Group files by date for day-of-week stats
            const dateGroups: Record<string, number> = {};
            const dateHourGroups: Record<string, number> = {};
            let nightOwlCandidate: { file: ScannedFile; minutesTo5am: number } | null = null;

            for (const file of files) {
                const dateKey = file.modifiedAt.split('T')[0];
                dateGroups[dateKey] = (dateGroups[dateKey] || 0) + 1;

                const date = new Date(file.modifiedAt);
                const hour = date.getHours();
                const hourKey = `${dateKey}_${hour}`;
                dateHourGroups[hourKey] = (dateHourGroups[hourKey] || 0) + 1;

                // Check for night owl (10pm-5am, closest to 5am)
                if (hour >= 22 || hour < 5) {
                    const minutes = date.getMinutes();
                    let minutesTo5am: number;
                    if (hour >= 22) {
                        minutesTo5am = (24 - hour + 5) * 60 - minutes;
                    } else {
                        minutesTo5am = (5 - hour) * 60 - minutes;
                    }
                    if (!nightOwlCandidate || minutesTo5am < nightOwlCandidate.minutesTo5am) {
                        nightOwlCandidate = { file, minutesTo5am };
                    }
                }
            }

            // Day of week stats with cap
            for (const [dateKey, count] of Object.entries(dateGroups)) {
                const day = new Date(dateKey).getDay();
                dayCounts[day] += Math.min(count, FILE_CAP_PER_DAY);
            }

            // Hour stats with cap
            for (const [key, count] of Object.entries(dateHourGroups)) {
                const hour = parseInt(key.split('_')[1]);
                hourCounts[hour] += Math.min(count, FILE_CAP_PER_HOUR);
            }

            // Find busiest day
            let maxDayIdx = 0, maxDayCount = 0;
            dayCounts.forEach((count, idx) => {
                if (count > maxDayCount) { maxDayCount = count; maxDayIdx = idx; }
            });
            const totalDayFiles = dayCounts.reduce((a, b) => a + b, 0);

            // Find peak hour
            let maxHourIdx = 0, maxHourCount = 0;
            hourCounts.forEach((count, idx) => {
                if (count > maxHourCount) { maxHourCount = count; maxHourIdx = idx; }
            });
            const totalHourFiles = hourCounts.reduce((a, b) => a + b, 0);
            const formatHour = (h: number) => {
                if (h === 0) return '12 AM';
                if (h < 12) return `${h} AM`;
                if (h === 12) return '12 PM';
                return `${h - 12} PM`;
            };

            const funFactsData = {
                busyDay: dayNames[maxDayIdx],
                busyCount: maxDayCount,
                busyPercentage: totalDayFiles > 0 ? Math.round((maxDayCount / totalDayFiles) * 100) : 0,
                peakHour: `${formatHour(maxHourIdx)}-${formatHour((maxHourIdx + 1) % 24)}`,
                peakCount: maxHourCount,
                peakPercentage: totalHourFiles > 0 ? Math.round((maxHourCount / totalHourFiles) * 100) : 0,
                nightOwl: nightOwlCandidate ? {
                    time: new Date(nightOwlCandidate.file.modifiedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                    fileName: nightOwlCandidate.file.name.length > 30
                        ? nightOwlCandidate.file.name.substring(0, 27) + '...'
                        : nightOwlCandidate.file.name
                } : null
            };

            // Create a temporary container
            const tempContainer = document.createElement('div');
            tempContainer.style.position = 'absolute';
            tempContainer.style.left = '-9999px';
            tempContainer.style.top = '0';
            document.body.appendChild(tempContainer);

            const W = 600;

            // Helper for contribution colors - use theme hex colors
            const getColor = (count: number, isBusiest: boolean) => {
                if (isBusiest) return theme.hex.busiest;
                if (count === 0) return theme.hex.activityEmpty;
                if (count <= 5) return theme.hex.activityLevel1;
                if (count <= 10) return theme.hex.activityLevel2;
                if (count <= 100) return theme.hex.activityLevel3;
                if (count <= 1000) return theme.hex.activityLevel4;
                return theme.hex.activityLevel5;
            };

            // Build contribution grid HTML - 53 columns (weeks), 7 rows (days)
            let gridHTML = '<div style="display:flex; gap:2px; justify-content:center;">';
            for (let w = 0; w < 53; w++) {
                gridHTML += '<div style="display:flex; flex-direction:column; gap:2px;">';
                for (let d = 0; d < 7; d++) {
                    const cell = gridData.find(c => c.week === w && c.day === d);
                    if (!cell || !cell.inYear) {
                        // Empty cell for days outside the year
                        gridHTML += `<div style="width:8px; height:8px; border-radius:2px; background:transparent;"></div>`;
                    } else {
                        const isBusiest = cell.date === stats.busiestDay?.date;
                        const color = getColor(cell.count, isBusiest);
                        gridHTML += `<div style="width:8px; height:8px; border-radius:2px; background:${color};"></div>`;
                    }
                }
                gridHTML += '</div>';
            }
            gridHTML += '</div>';

            // Build monthly timeline HTML
            let monthlyHTML = '';
            for (let m = 0; m < 12; m++) {
                const monthData = stats.monthStats[m];
                const summary = monthlySummaries[m];
                if (monthData.count === 0) continue;

                monthlyHTML += `
                <div style="display:flex; gap:16px; margin-bottom:16px;">
                    <div style="width:50px; text-align:right;">
                        <div style="font-size:14px; font-weight:600; color:${theme.hex.primary};">${MONTH_NAMES[m]}</div>
                    </div>
                    <div style="width:3px; background:${theme.hex.border}; border-radius:2px;"></div>
                    <div style="flex:1;">
                        <div style="font-size:14px; color:${theme.hex.text};">${monthData.count.toLocaleString()} files · ${formatSize(monthData.size)}</div>
                        ${summary ? `<div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">${summary}</div>` : ''}
                    </div>
                </div>`;
            }

            // Build complete HTML
            tempContainer.innerHTML = `
<div style="width:${W}px; background:${theme.hex.background}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:white; padding:0;">

<!-- INTRO -->
<div style="padding:32px; background:${theme.hex.background}; position:relative;">
    <!-- Header with logos -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
        <img src="${synvoAiLogo}" style="height:40px; width:auto;" alt="Synvo AI" />
        <img src="${cocoaMascot}" style="height:48px; width:auto;" alt="Local Cocoa" />
    </div>
    
    <!-- Main content -->
    <div style="text-align:center; padding:20px 0;">
        <div style="color:${theme.hex.primary}; font-size:11px; letter-spacing:3px; margin-bottom:4px; text-transform:uppercase;">Your Year In Files</div>
        <div style="color:${theme.hex.textMuted}; font-size:12px; margin-bottom:16px;">Presented by Local Cocoa</div>
        <div style="font-size:72px; font-weight:900; color:${theme.hex.primary}; line-height:1;">${year}</div>
        <p style="color:${theme.hex.text}; font-size:15px; margin:20px 0;">Let's take a look back at what you created, collected, and stored this year.</p>
        <table style="margin:12px auto 0 auto; background:${theme.hex.cardBg}; border-radius:12px; border-collapse:separate; border-spacing:0;">
            <tr>
                <td style="padding:20px 40px; text-align:center; vertical-align:middle;">
                    <div style="font-size:28px; font-weight:bold; color:${theme.hex.primary};">${formatNumber(stats.totalFiles)}</div>
                    <div style="font-size:12px; color:${theme.hex.textMuted}; margin-top:4px;">Files</div>
                </td>
                <td style="width:1px; background:${theme.hex.border}; padding:0;"></td>
                <td style="padding:20px 40px; text-align:center; vertical-align:middle;">
                    <div style="font-size:28px; font-weight:bold; color:${theme.hex.primary};">${formatSize(stats.totalSize)}</div>
                    <div style="font-size:12px; color:${theme.hex.textMuted}; margin-top:4px;">Total Size</div>
                </td>
            </tr>
        </table>
        <p style="color:${theme.hex.textMuted}; font-size:10px; margin-top:20px; opacity:0.6;">- File types include documents, images, videos, audio, compressed files, and books only</p>
    </div>
</div>

<!-- CONTRIBUTION GRAPH -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Activity Overview</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">Your file activity throughout ${year}</div>
    </div>
    <div style="display:flex; justify-content:center; margin-bottom:16px;">
        <div style="font-size:10px; color:${theme.hex.textMuted}; display:flex; gap:16px;">
            <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span>
            <span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span>
        </div>
    </div>
    ${gridHTML}
    <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:16px;">
        <span style="font-size:10px; color:${theme.hex.textMuted};">Less</span>
        <div style="width:8px; height:8px; border-radius:2px; background:${theme.hex.activityEmpty};"></div>
        <div style="width:8px; height:8px; border-radius:2px; background:${theme.hex.activityLevel1};"></div>
        <div style="width:8px; height:8px; border-radius:2px; background:${theme.hex.activityLevel2};"></div>
        <div style="width:8px; height:8px; border-radius:2px; background:${theme.hex.activityLevel3};"></div>
        <div style="width:8px; height:8px; border-radius:2px; background:${theme.hex.activityLevel4};"></div>
        <span style="font-size:10px; color:${theme.hex.textMuted};">More</span>
    </div>
    ${stats.busiestDay ? `
    <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:16px; margin-top:20px; border-left:3px solid ${theme.hex.busiest};">
        <div style="font-size:15px; font-weight:600; color:white;">
            ${new Date(stats.busiestDay.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} - Busiest Day
        </div>
        <div style="font-size:13px; color:${theme.hex.secondary}; margin-top:4px;">${stats.busiestDay.count.toLocaleString()} files modified</div>
        ${aiInsight ? `<div style="margin-top:12px; padding-top:12px; border-top:1px solid ${theme.hex.border}; font-size:13px; color:${theme.hex.text}; line-height:1.5;">${aiInsight}</div>` : ''}
    </div>
    ` : ''}
</div>

<!-- MONTHLY TIMELINE -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:24px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Month by Month</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">Your journey through ${year}</div>
    </div>
    ${monthlyHTML}
</div>

<!-- FILE TYPES -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Your File Mix</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">What types of files you worked with</div>
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">
        ${fileTypes.map(t => `
        <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:14px; text-align:center;">
            <div style="font-size:14px; font-weight:600; color:white;">${t.label}</div>
            <div style="font-size:12px; color:${theme.hex.primary}; margin-top:2px;">${t.count.toLocaleString()} files</div>
            <div style="font-size:11px; color:${theme.hex.textMuted};">${t.percentage}%</div>
        </div>
        `).join('')}
    </div>
</div>

<!-- STORAGE BREAKDOWN -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Storage Breakdown</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">Where your ${formatSize(stats.totalSize)} went</div>
    </div>
    ${storageTypes.map(t => `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <div style="width:80px; font-size:13px; color:${theme.hex.text}; text-align:right;">${t.label}</div>
        <div style="flex:1; height:18px; background:${theme.hex.cardBg}; border-radius:4px; overflow:hidden;">
            <div style="width:${t.percentage}%; height:100%; background:${theme.hex.primaryDark}; border-radius:4px;"></div>
        </div>
        <div style="width:65px; text-align:right; font-size:13px; color:${theme.hex.primary}; font-weight:500;">${t.size}</div>
    </div>
    `).join('')}
</div>

<!-- TOP FILES -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Your Largest Files</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">The heavy hitters</div>
    </div>
    <table style="width:100%; border-collapse:separate; border-spacing:0 6px;">
        ${stats.topFiles.slice(0, 5).map((file, idx) => {
                // Truncate filename to fit - max 35 chars
                let displayName = file.name;
                if (displayName.length > 35) {
                    const ext = displayName.lastIndexOf('.') > 0 ? displayName.slice(displayName.lastIndexOf('.')) : '';
                    const base = displayName.slice(0, displayName.lastIndexOf('.') > 0 ? displayName.lastIndexOf('.') : displayName.length);
                    displayName = base.slice(0, 30 - ext.length) + '...' + ext;
                }
                return `
        <tr>
            <td style="background:${theme.hex.cardBg}; border-radius:8px 0 0 8px; padding:12px; width:36px; text-align:center; vertical-align:middle;">
                <div style="width:24px; height:24px; border-radius:5px; background:${theme.hex.primaryDark}; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; font-size:12px; color:white;">${idx + 1}</div>
            </td>
            <td style="background:${theme.hex.cardBg}; padding:12px 8px; vertical-align:middle;">
                <div style="font-size:13px; color:white;">${displayName}</div>
            </td>
            <td style="background:${theme.hex.cardBg}; border-radius:0 8px 8px 0; padding:12px; width:70px; text-align:right; vertical-align:middle;">
                <div style="font-size:13px; color:${theme.hex.primary}; font-weight:500;">${formatSize(file.size)}</div>
            </td>
        </tr>`;
            }).join('')}
    </table>
</div>

<!-- FUN FACTS -->
<div style="padding:32px; background:${theme.hex.background}; border-top:1px solid ${theme.hex.cardBg};">
    <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:bold; color:white;">Fun Facts</div>
        <div style="font-size:13px; color:${theme.hex.textMuted}; margin-top:4px;">Interesting insights from your ${year}</div>
    </div>
    <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:10px;">
        <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:14px;">
            <div style="font-size:11px; color:${theme.hex.textMuted}; margin-bottom:4px;">Most Active Day</div>
            <div style="font-size:20px; font-weight:bold; color:${theme.hex.primary};">${funFactsData.busyDay}</div>
            <div style="font-size:10px; color:${theme.hex.textMuted}; margin-top:2px;">${funFactsData.busyCount.toLocaleString()} files (${funFactsData.busyPercentage}%)</div>
        </div>
        <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:14px;">
            <div style="font-size:11px; color:${theme.hex.textMuted}; margin-bottom:4px;">Peak Hour</div>
            <div style="font-size:20px; font-weight:bold; color:${theme.hex.primary};">${funFactsData.peakHour}</div>
            <div style="font-size:10px; color:${theme.hex.textMuted}; margin-top:2px;">${funFactsData.peakCount.toLocaleString()} files (${funFactsData.peakPercentage}%)</div>
        </div>
        ${funFactsData.nightOwl ? `
        <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:14px;">
            <div style="font-size:11px; color:${theme.hex.textMuted}; margin-bottom:4px;">🦉 Night Owl Moment</div>
            <div style="font-size:16px; font-weight:bold; color:${theme.hex.primary};">${funFactsData.nightOwl.time}</div>
            <div style="font-size:10px; color:${theme.hex.textMuted}; margin-top:2px;">${funFactsData.nightOwl.fileName}</div>
        </div>
        ` : ''}
        <div style="background:${theme.hex.cardBg}; border-radius:10px; padding:14px;">
            <div style="font-size:11px; color:${theme.hex.textMuted}; margin-bottom:4px;">Storage Growth</div>
            <div style="font-size:20px; font-weight:bold; color:${theme.hex.primary};">${formatSize(stats.totalSize / 12)}/mo</div>
            <div style="font-size:10px; color:${theme.hex.textMuted}; margin-top:2px;">${Math.round(stats.totalFiles / 12).toLocaleString()} files/month</div>
        </div>
    </div>
</div>

<!-- OUTRO -->
<div style="padding:48px 32px; background:${theme.hex.background}; text-align:center; border-top:1px solid ${theme.hex.cardBg};">
    <div style="font-size:28px; font-weight:bold; color:${theme.hex.primary}; margin-bottom:12px;">That's a wrap on ${year}!</div>
    <p style="font-size:15px; color:${theme.hex.text}; line-height:1.5; max-width:400px; margin:0 auto;">
        You managed <span style="font-weight:bold; color:${theme.hex.primary};">${stats.totalFiles.toLocaleString()}</span> files this year.
        Here's to an even more productive ${year + 1}!
    </p>
    <div style="margin-top:28px; text-align:center;">
        <div style="font-size:12px; color:${theme.hex.textMuted}; display:flex; align-items:center; justify-content:center; gap:6px;">
            <span>Generated by</span>
            <span style="color:${theme.hex.primary}; font-weight:600;">Local Cocoa</span>
            <img src="${cocoaMascot}" style="height:16px; width:16px;" alt="Local Cocoa" />
        </div>
        <div style="font-size:11px; color:${theme.hex.textMuted}; opacity:0.7; margin-top:8px; display:flex; align-items:center; justify-content:center; gap:6px;">
            <span>Powered by</span>
            <span style="font-weight:500;">Synvo AI</span>
            <img src="${synvoAiLogo}" style="height:14px; width:14px;" alt="Synvo AI" />
        </div>
    </div>
</div>

</div>`;

            // Wait for DOM to render
            await new Promise(resolve => setTimeout(resolve, 300));

            // Capture using html2canvas
            const canvas = await html2canvas(tempContainer.firstElementChild as HTMLElement, {
                backgroundColor: theme.hex.background,
                scale: 2,
                logging: false,
            });

            // Cleanup
            document.body.removeChild(tempContainer);

            // Convert and save
            const dataUrl = canvas.toDataURL('image/png');
            const result = await window.api.saveImage({
                data: dataUrl,
                defaultName: `Year-In-Review-${year}.png`,
                title: 'Save Year In Review Report'
            });

            if (result.saved) {
                console.log('Report saved to:', result.path);
            }
        } catch (error) {
            console.error('Failed to save report:', error);
        } finally {
            setIsSaving(false);
        }
    }, [year, isSaving, stats, aiInsight, theme, files]);

    // Reset AI insight when modal closes
    useEffect(() => {
        if (!isOpen) {
            setAiInsight(null);
            setInsightError(null);
        }
    }, [isOpen]);

    // Slides array
    const slides = useMemo(() => {
        if (!stats) return [];

        return [
            <IntroSlide key="intro" year={year} totalFiles={stats.totalFiles} totalSize={stats.totalSize} theme={theme} />,
            <ContributionGraphSlide
                key="contribution"
                dailyActivity={stats.dailyActivity}
                year={year}
                busiestDay={stats.busiestDay}
                totalFiles={stats.totalFiles}
                busiestDayFiles={stats.busiestDayFiles}
                busiestDayTypeStats={stats.busiestDayTypeStats}
                aiInsight={aiInsight}
                isLoadingInsight={isLoadingInsight}
                insightError={insightError}
                onGenerateInsight={generateInsight}
                theme={theme}
            />,
            <MonthlyRecapSlide
                key="monthly-recap"
                monthStats={stats.monthStats}
                monthlyFiles={stats.monthlyFiles}
                year={year}
                isActive={currentSlide === 2}
                theme={theme}
            />,
            <FileTypesSlide key="types" typeStats={stats.typeStats} files={files} theme={theme} />,
            <StorageSlide key="storage" typeStats={stats.typeStats} totalSize={stats.totalSize} theme={theme} />,
            <TopFilesSlide key="top" topFiles={stats.topFiles} theme={theme} />,
            <FunFactsSlide
                key="facts"
                totalFiles={stats.totalFiles}
                totalSize={stats.totalSize}
                avgFilesPerDay={stats.avgFilesPerDay}
                year={year}
                files={files}
                theme={theme}
            />,
            <OutroSlide key="outro" year={year} totalFiles={stats.totalFiles} onSaveReport={handleSaveReport} isSaving={isSaving} theme={theme} />,
        ];
    }, [stats, year, aiInsight, isLoadingInsight, insightError, generateInsight, currentSlide, handleSaveReport, isSaving, theme]);

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            } else if (e.key === 'ArrowRight' || e.key === ' ') {
                setCurrentSlide(prev => Math.min(prev + 1, slides.length - 1));
            } else if (e.key === 'ArrowLeft') {
                setCurrentSlide(prev => Math.max(prev - 1, 0));
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, slides.length, onClose]);

    // Reset slide when opening
    useEffect(() => {
        if (isOpen) {
            setCurrentSlide(0);
        }
    }, [isOpen]);

    if (!isOpen || !stats) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Navigation - Left Button (outside modal, 10px gap) */}
            <button
                onClick={() => setCurrentSlide(prev => Math.max(prev - 1, 0))}
                disabled={currentSlide === 0}
                className="absolute left-[calc(50%-384px-48px-10px)] top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-0 disabled:pointer-events-none transition-all"
            >
                <ChevronLeft className="h-6 w-6" />
            </button>

            {/* Navigation - Right Button (outside modal, 10px gap) */}
            <button
                onClick={() => setCurrentSlide(prev => Math.min(prev + 1, slides.length - 1))}
                disabled={currentSlide === slides.length - 1}
                className={cn(
                    "absolute right-[calc(50%-384px-48px-10px)] top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all",
                    currentSlide === slides.length - 1
                        ? "opacity-0 pointer-events-none"
                        : "animate-bounce-gentle"
                )}
            >
                <ChevronRight className="h-6 w-6" />
            </button>

            {/* Modal */}
            <div className="relative w-full max-w-3xl mx-16 md:mx-20 rounded-3xl overflow-hidden shadow-2xl">
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/20 hover:bg-black/40 text-white/80 hover:text-white transition-colors"
                >
                    <X className="h-5 w-5" />
                </button>

                {/* Current Slide */}
                <div className="relative overflow-hidden">
                    {slides[currentSlide]}
                </div>

                {/* Dots - Bottom Center */}
                <div className="absolute bottom-4 left-0 right-0 flex items-center justify-center gap-2">
                    {slides.map((_, idx) => (
                        <button
                            key={idx}
                            onClick={() => setCurrentSlide(idx)}
                            className={cn(
                                "h-2 rounded-full transition-all",
                                idx === currentSlide
                                    ? "w-6 bg-white"
                                    : "w-2 bg-white/40 hover:bg-white/60"
                            )}
                        />
                    ))}
                </div>

                {/* Progress bar */}
                <div className="absolute top-0 left-0 right-0 h-1 bg-white/10">
                    <div
                        className="h-full bg-white/60 transition-all duration-300"
                        style={{ width: `${((currentSlide + 1) / slides.length) * 100}%` }}
                    />
                </div>
            </div>
        </div>
    );
}

