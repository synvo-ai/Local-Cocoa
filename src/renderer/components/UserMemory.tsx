import { useCallback, useEffect, useMemo, useState, CSSProperties } from 'react';
import {
    ArrowUpDown,
    Brain,
    Calendar,
    ChevronDown,
    ChevronRight,
    Clock,
    FileText,
    Lightbulb,
    Link2,
    RefreshCw,
    Search,
    User
} from 'lucide-react';
import { cn } from '../lib/utils';

interface EpisodeMemory {
    id: string;
    user_id: string;
    summary: string;
    episode?: string;
    timestamp: string;
    subject?: string;
    metadata?: Record<string, unknown>;
}

interface ForesightMemory {
    id: string;
    user_id: string;
    content: string;
    evidence?: string;
    parent_episode_id?: string;
    metadata?: Record<string, unknown>;
}

interface EventLog {
    id: string;
    user_id: string;
    atomic_fact: string;
    timestamp: string;
    parent_episode_id?: string;
    metadata?: Record<string, unknown>;
}

interface UserProfile {
    user_id: string;
    user_name?: string;
    personality?: string[];
    interests?: string[];
    hard_skills?: Array<{ name: string; level: string }>;
    soft_skills?: Array<{ name: string; level: string }>;
}

interface MemorySummary {
    user_id: string;
    profile?: UserProfile;
    episodes_count: number;
    event_logs_count: number;
    foresights_count: number;
    recent_episodes: EpisodeMemory[];
    recent_foresights: ForesightMemory[];
}

type MemoryTab = 'overview' | 'episodes' | 'events' | 'foresights' | 'timeline';

type TimeRange = 'all' | '7d' | '30d' | '90d';

type TimelineEntry = {
    id: string;
    type: 'episode' | 'event' | 'foresight';
    title: string;
    body: string;
    timestamp?: string;
    parentEpisodeId?: string;
    sourcePath?: string;
    sourceName?: string;
};

export function UserMemory() {
    const [activeTab, setActiveTab] = useState<MemoryTab>('overview');
    const [userId] = useState('default_user');
    const [summary, setSummary] = useState<MemorySummary | null>(null);
    const [episodes, setEpisodes] = useState<EpisodeMemory[]>([]);
    const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
    const [foresights, setForesights] = useState<ForesightMemory[]>([]);
    const [loading, setLoading] = useState(false);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [searchTerm, setSearchTerm] = useState('');
    const [timeRange, setTimeRange] = useState<TimeRange>('all');
    const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
    const [showLinkedOnly, setShowLinkedOnly] = useState(false);
    const [focusedEpisodeId, setFocusedEpisodeId] = useState<string | null>(null);

    const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
    const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

    const fetchSummary = useCallback(async () => {
        setLoading(true);
        try {
            const api = window.api;
            if (api?.memoryGetSummary) {
                const data = await api.memoryGetSummary(userId);
                setSummary(data);
            } else {
                // Mock data for development
                setSummary({
                    user_id: userId,
                    episodes_count: 0,
                    event_logs_count: 0,
                    foresights_count: 0,
                    recent_episodes: [],
                    recent_foresights: [],
                });
            }
        } catch (error) {
            console.error('Failed to fetch memory summary', error);
        } finally {
            setLoading(false);
        }
    }, [userId]);

    const fetchEpisodes = useCallback(async () => {
        setLoading(true);
        try {
            const api = window.api;
            if (api?.memoryGetEpisodes) {
                const data = await api.memoryGetEpisodes(userId, 50, 0);
                setEpisodes(data);
            }
        } catch (error) {
            console.error('Failed to fetch episodes', error);
        } finally {
            setLoading(false);
        }
    }, [userId]);

    const fetchEventLogs = useCallback(async (limit = 100, offset = 0) => {
        setLoading(true);
        try {
            const api = window.api;
            if (api?.memoryGetEventLogs) {
                const data = await api.memoryGetEventLogs(userId, limit, offset);
                setEventLogs(data);
            }
        } catch (error) {
            console.error('Failed to fetch event logs', error);
        } finally {
            setLoading(false);
        }
    }, [userId]);

    const fetchForesights = useCallback(async (limit = 50) => {
        setLoading(true);
        try {
            const api = window.api;
            if (api?.memoryGetForesights) {
                const data = await api.memoryGetForesights(userId, limit);
                setForesights(data);
            }
        } catch (error) {
            console.error('Failed to fetch foresights', error);
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => {
        if (activeTab === 'overview') {
            void fetchSummary();
            void fetchEventLogs(5, 0);
        } else if (activeTab === 'episodes') {
            void fetchEpisodes();
        } else if (activeTab === 'events') {
            void fetchEventLogs(100, 0);
        } else if (activeTab === 'foresights') {
            void fetchForesights(50);
        } else if (activeTab === 'timeline') {
            void fetchEpisodes();
            void fetchEventLogs(100, 0);
            void fetchForesights(50);
        }
    }, [activeTab, fetchSummary, fetchEpisodes, fetchEventLogs, fetchForesights]);

    const toggleExpand = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const formatDate = (dateStr: string) => {
        try {
            const date = new Date(dateStr);
            return date.toLocaleString();
        } catch {
            return dateStr;
        }
    };

    const formatDateShort = (dateStr?: string) => {
        if (!dateStr) return 'No timestamp';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
            });
        } catch {
            return dateStr;
        }
    };

    const normalizeText = (value: string) => value.toLowerCase();

    const matchesSearch = (value: string) => {
        if (!searchTerm.trim()) return true;
        return normalizeText(value).includes(normalizeText(searchTerm.trim()));
    };

    const inTimeRange = (dateStr?: string) => {
        if (!dateStr) {
            return timeRange === 'all';
        }
        if (timeRange === 'all') return true;
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return timeRange === 'all';
        const now = Date.now();
        const diffMs = now - date.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (timeRange === '7d') return diffDays <= 7;
        if (timeRange === '30d') return diffDays <= 30;
        return diffDays <= 90;
    };

    const episodesById = useMemo(() => {
        const map = new Map<string, EpisodeMemory>();
        episodes.forEach(ep => map.set(ep.id, ep));
        return map;
    }, [episodes]);

    const eventsByEpisode = useMemo(() => {
        const map = new Map<string, EventLog[]>();
        eventLogs.forEach(log => {
            if (!log.parent_episode_id) return;
            const list = map.get(log.parent_episode_id) ?? [];
            list.push(log);
            map.set(log.parent_episode_id, list);
        });
        return map;
    }, [eventLogs]);

    const foresightsByEpisode = useMemo(() => {
        const map = new Map<string, ForesightMemory[]>();
        foresights.forEach(fs => {
            if (!fs.parent_episode_id) return;
            const list = map.get(fs.parent_episode_id) ?? [];
            list.push(fs);
            map.set(fs.parent_episode_id, list);
        });
        return map;
    }, [foresights]);

    const extractSource = (metadata?: Record<string, unknown>) => {
        if (!metadata) return null;
        const sourceName =
            (metadata.file_name as string | undefined) ??
            (metadata.fileName as string | undefined) ??
            (metadata.name as string | undefined);
        const sourcePath =
            (metadata.file_path as string | undefined) ??
            (metadata.filePath as string | undefined) ??
            (metadata.path as string | undefined);
        if (!sourceName && !sourcePath) return null;
        return { sourceName, sourcePath };
    };

    const handleOpenSource = async (path?: string) => {
        if (!path) return;
        try {
            await window.api?.openFile?.(path);
        } catch (error) {
            console.error('Failed to open file', error);
        }
    };

    const handleJumpToEpisode = useCallback((episodeId?: string) => {
        if (!episodeId) return;
        setActiveTab('episodes');
        setFocusedEpisodeId(episodeId);
    }, []);

    const filteredEpisodes = useMemo(() => {
        const items = episodes.filter(ep => {
            const text = `${ep.subject ?? ''} ${ep.summary ?? ''} ${ep.episode ?? ''}`;
            return matchesSearch(text) && inTimeRange(ep.timestamp);
        });
        items.sort((a, b) => {
            const aTime = new Date(a.timestamp).getTime();
            const bTime = new Date(b.timestamp).getTime();
            if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
            return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
        });
        return items;
    }, [episodes, searchTerm, timeRange, sortOrder]);

    const filteredEventLogs = useMemo(() => {
        const items = eventLogs.filter(log => {
            const parent = log.parent_episode_id ? episodesById.get(log.parent_episode_id) : undefined;
            const text = `${log.atomic_fact ?? ''} ${parent?.subject ?? ''} ${parent?.summary ?? ''}`;
            const linkedOk = showLinkedOnly ? Boolean(log.parent_episode_id) : true;
            return matchesSearch(text) && linkedOk && inTimeRange(log.timestamp);
        });
        items.sort((a, b) => {
            const aTime = new Date(a.timestamp).getTime();
            const bTime = new Date(b.timestamp).getTime();
            if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
            return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
        });
        return items;
    }, [eventLogs, episodesById, searchTerm, showLinkedOnly, timeRange, sortOrder]);

    const filteredForesights = useMemo(() => {
        const items = foresights.filter(fs => {
            const parent = fs.parent_episode_id ? episodesById.get(fs.parent_episode_id) : undefined;
            const text = `${fs.content ?? ''} ${fs.evidence ?? ''} ${parent?.subject ?? ''}`;
            const linkedOk = showLinkedOnly ? Boolean(fs.parent_episode_id) : true;
            const timestamp = parent?.timestamp;
            return matchesSearch(text) && linkedOk && inTimeRange(timestamp);
        });
        return items;
    }, [foresights, episodesById, searchTerm, showLinkedOnly, timeRange]);

    const timelineEntries = useMemo(() => {
        const entries: TimelineEntry[] = [];
        episodes.forEach(ep => {
            const source = extractSource(ep.metadata);
            entries.push({
                id: ep.id,
                type: 'episode',
                title: ep.subject || 'Episode',
                body: ep.summary,
                timestamp: ep.timestamp,
                sourcePath: source?.sourcePath,
                sourceName: source?.sourceName,
            });
        });
        eventLogs.forEach(log => {
            const parent = log.parent_episode_id ? episodesById.get(log.parent_episode_id) : undefined;
            const source = extractSource(parent?.metadata);
            entries.push({
                id: log.id,
                type: 'event',
                title: parent?.subject ? `Event from ${parent.subject}` : 'Event log',
                body: log.atomic_fact,
                timestamp: log.timestamp,
                parentEpisodeId: log.parent_episode_id,
                sourcePath: source?.sourcePath,
                sourceName: source?.sourceName,
            });
        });
        foresights.forEach(fs => {
            const parent = fs.parent_episode_id ? episodesById.get(fs.parent_episode_id) : undefined;
            const source = extractSource(parent?.metadata);
            entries.push({
                id: fs.id,
                type: 'foresight',
                title: parent?.subject ? `Foresight from ${parent.subject}` : 'Foresight',
                body: fs.content,
                timestamp: parent?.timestamp,
                parentEpisodeId: fs.parent_episode_id,
                sourcePath: source?.sourcePath,
                sourceName: source?.sourceName,
            });
        });
        const filtered = entries.filter(entry => {
            const text = `${entry.title} ${entry.body}`;
            return matchesSearch(text) && inTimeRange(entry.timestamp);
        });
        filtered.sort((a, b) => {
            const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            if (aTime === bTime) return 0;
            return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
        });
        return filtered;
    }, [episodes, eventLogs, foresights, episodesById, searchTerm, timeRange, sortOrder]);

    const recentEpisodes = useMemo(() => {
        const items = summary?.recent_episodes ?? [];
        return items.filter(ep => {
            const text = `${ep.subject ?? ''} ${ep.summary ?? ''}`;
            return matchesSearch(text) && inTimeRange(ep.timestamp);
        });
    }, [summary, searchTerm, timeRange]);

    const recentForesights = useMemo(() => {
        const items = summary?.recent_foresights ?? [];
        return items.filter(fs => {
            const parent = fs.parent_episode_id ? episodesById.get(fs.parent_episode_id) : undefined;
            const text = `${fs.content ?? ''} ${fs.evidence ?? ''} ${parent?.subject ?? ''}`;
            const timestamp = parent?.timestamp;
            return matchesSearch(text) && inTimeRange(timestamp);
        });
    }, [summary, episodesById, searchTerm, timeRange]);

    const recentEvents = useMemo(() => {
        const items = eventLogs.slice(0, 5);
        return items.filter(log => {
            const parent = log.parent_episode_id ? episodesById.get(log.parent_episode_id) : undefined;
            const text = `${log.atomic_fact ?? ''} ${parent?.subject ?? ''}`;
            return matchesSearch(text) && inTimeRange(log.timestamp);
        });
    }, [eventLogs, episodesById, searchTerm, timeRange]);

    useEffect(() => {
        if (activeTab !== 'episodes' || !focusedEpisodeId) return;
        setExpandedIds(prev => {
            if (prev.has(focusedEpisodeId)) return prev;
            const next = new Set(prev);
            next.add(focusedEpisodeId);
            return next;
        });
        const targetId = `episode-${focusedEpisodeId}`;
        window.requestAnimationFrame(() => {
            const element = document.getElementById(targetId);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }, [activeTab, focusedEpisodeId]);

    const tabs: { id: MemoryTab; label: string; icon: React.ReactNode }[] = [
        { id: 'overview', label: 'Overview', icon: <User className="h-4 w-4" /> },
        { id: 'episodes', label: 'Episodes', icon: <Brain className="h-4 w-4" /> },
        { id: 'events', label: 'Events', icon: <Clock className="h-4 w-4" /> },
        { id: 'foresights', label: 'Foresights', icon: <Lightbulb className="h-4 w-4" /> },
        { id: 'timeline', label: 'Timeline', icon: <Calendar className="h-4 w-4" /> },
    ];

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex-none border-b px-6 pt-8 pb-4" style={dragStyle}>
                <div className="flex items-center justify-between" style={noDragStyle}>
                    <div>
                        <h1 className="text-2xl font-bold">User Memory</h1>
                        <p className="text-muted-foreground text-sm mt-1">
                            View and manage your personal memories and insights
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            if (activeTab === 'overview') {
                                void fetchSummary();
                                void fetchEventLogs(5, 0);
                            }
                            else if (activeTab === 'episodes') void fetchEpisodes();
                            else if (activeTab === 'events') void fetchEventLogs(100, 0);
                            else if (activeTab === 'foresights') void fetchForesights(50);
                            else if (activeTab === 'timeline') {
                                void fetchEpisodes();
                                void fetchEventLogs(100, 0);
                                void fetchForesights(50);
                            }
                        }}
                        disabled={loading}
                        className={cn(
                            "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                            "bg-primary text-primary-foreground hover:bg-primary/90",
                            loading && "opacity-50 cursor-not-allowed"
                        )}
                    >
                        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                        Refresh
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-2 mt-4" style={noDragStyle}>
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                                activeTab === tab.id
                                    ? "bg-accent text-accent-foreground"
                                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                            )}
                        >
                            {tab.icon}
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Filters */}
                <div className="mt-4 flex flex-wrap items-center gap-3" style={noDragStyle}>
                    <div className="flex w-full max-w-md items-center gap-2 rounded-lg border bg-background px-3 py-2 shadow-sm">
                        <Search className="h-4 w-4 text-muted-foreground" />
                        <input
                            value={searchTerm}
                            onChange={event => setSearchTerm(event.target.value)}
                            placeholder="Search memories..."
                            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        />
                    </div>
                    <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
                        {(['all', '7d', '30d', '90d'] as TimeRange[]).map(range => (
                            <button
                                key={range}
                                onClick={() => setTimeRange(range)}
                                className={cn(
                                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                                    timeRange === range
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {range === 'all' ? 'All time' : range.toUpperCase()}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={() => setSortOrder(prev => (prev === 'newest' ? 'oldest' : 'newest'))}
                        className={cn(
                            "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                            "hover:bg-accent/60"
                        )}
                    >
                        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                        {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
                    </button>
                    {(activeTab === 'events' || activeTab === 'foresights') && (
                        <button
                            onClick={() => setShowLinkedOnly(prev => !prev)}
                            className={cn(
                                "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                                showLinkedOnly ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                            )}
                        >
                            <Link2 className="h-3.5 w-3.5" />
                            Linked only
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6">
                {activeTab === 'overview' && (
                    <div className="space-y-6">
                        {/* Stats Cards */}
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                            <button
                                onClick={() => setActiveTab('episodes')}
                                className="rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:bg-accent/30"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="rounded-lg bg-primary/10 p-2">
                                        <Brain className="h-5 w-5 text-primary" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold">{summary?.episodes_count ?? 0}</p>
                                        <p className="text-xs text-muted-foreground">Episodes</p>
                                    </div>
                                </div>
                            </button>
                            <button
                                onClick={() => setActiveTab('events')}
                                className="rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-blue-500/40 hover:bg-accent/30"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="rounded-lg bg-blue-500/10 p-2">
                                        <Clock className="h-5 w-5 text-blue-500" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold">{summary?.event_logs_count ?? 0}</p>
                                        <p className="text-xs text-muted-foreground">Event Logs</p>
                                    </div>
                                </div>
                            </button>
                            <button
                                onClick={() => setActiveTab('foresights')}
                                className="rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-amber-500/40 hover:bg-accent/30"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="rounded-lg bg-amber-500/10 p-2">
                                        <Lightbulb className="h-5 w-5 text-amber-500" />
                                    </div>
                                    <div>
                                        <p className="text-2xl font-bold">{summary?.foresights_count ?? 0}</p>
                                        <p className="text-xs text-muted-foreground">Foresights</p>
                                    </div>
                                </div>
                            </button>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-3">
                            {/* Profile */}
                            <div className="rounded-xl border bg-card shadow-sm lg:col-span-2">
                                <div className="border-b px-4 py-3">
                                    <h3 className="font-semibold">Profile Snapshot</h3>
                                </div>
                                <div className="p-4">
                                    {summary?.profile ? (
                                        <div className="space-y-4">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <p className="text-lg font-semibold">
                                                        {summary.profile.user_name || 'User'}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {summary.profile.user_id}
                                                    </p>
                                                </div>
                                                <div className="rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                                    Profile memory
                                                </div>
                                            </div>
                                            <div className="grid gap-3 md:grid-cols-2">
                                                <div>
                                                    <p className="text-xs font-semibold uppercase text-muted-foreground">Personality</p>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {(summary.profile.personality ?? []).length > 0 ? (
                                                            summary.profile.personality?.map(item => (
                                                                <span key={item} className="rounded-full border px-2 py-0.5 text-xs">
                                                                    {item}
                                                                </span>
                                                            ))
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">No personality data</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-xs font-semibold uppercase text-muted-foreground">Interests</p>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {(summary.profile.interests ?? []).length > 0 ? (
                                                            summary.profile.interests?.map(item => (
                                                                <span key={item} className="rounded-full border px-2 py-0.5 text-xs">
                                                                    {item}
                                                                </span>
                                                            ))
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">No interests yet</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-xs font-semibold uppercase text-muted-foreground">Hard Skills</p>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {(summary.profile.hard_skills ?? []).length > 0 ? (
                                                            summary.profile.hard_skills?.map(skill => (
                                                                <span key={`${skill.name}-${skill.level}`} className="rounded-full border px-2 py-0.5 text-xs">
                                                                    {skill.name} {skill.level ? `(${skill.level})` : ''}
                                                                </span>
                                                            ))
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">No hard skills yet</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-xs font-semibold uppercase text-muted-foreground">Soft Skills</p>
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {(summary.profile.soft_skills ?? []).length > 0 ? (
                                                            summary.profile.soft_skills?.map(skill => (
                                                                <span key={`${skill.name}-${skill.level}`} className="rounded-full border px-2 py-0.5 text-xs">
                                                                    {skill.name} {skill.level ? `(${skill.level})` : ''}
                                                                </span>
                                                            ))
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">No soft skills yet</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                                            No profile memory yet. It will appear after conversations are processed.
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Recent Events */}
                            <div className="rounded-xl border bg-card shadow-sm">
                                <div className="border-b px-4 py-3">
                                    <h3 className="font-semibold">Recent Events</h3>
                                </div>
                                <div className="p-4">
                                    {recentEvents.length > 0 ? (
                                        <div className="space-y-3">
                                            {recentEvents.map(log => {
                                                const parent = log.parent_episode_id ? episodesById.get(log.parent_episode_id) : undefined;
                                                return (
                                                    <div key={log.id} className="rounded-lg border p-3">
                                                        <p className="text-sm">{log.atomic_fact}</p>
                                                        <p className="mt-1 text-xs text-muted-foreground">
                                                            {formatDate(log.timestamp)}
                                                            {parent?.subject ? ` • ${parent.subject}` : ''}
                                                        </p>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground text-center py-8">
                                            No recent events found.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-2">
                            {/* Recent Episodes */}
                            <div className="rounded-xl border bg-card shadow-sm">
                                <div className="border-b px-4 py-3">
                                    <h3 className="font-semibold">Recent Episodes</h3>
                                </div>
                                <div className="p-4">
                                    {recentEpisodes.length > 0 ? (
                                        <div className="space-y-3">
                                            {recentEpisodes.map(ep => (
                                                <div key={ep.id} className="rounded-lg border p-3">
                                                    <p className="text-sm font-medium">{ep.summary}</p>
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        {formatDate(ep.timestamp)}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground text-center py-8">
                                            No episodes yet. Start conversations to build your memory.
                                        </p>
                                    )}
                                </div>
                            </div>

                            {/* Recent Foresights */}
                            <div className="rounded-xl border bg-card shadow-sm">
                                <div className="border-b px-4 py-3">
                                    <h3 className="font-semibold">Recent Foresights</h3>
                                </div>
                                <div className="p-4">
                                    {recentForesights.length > 0 ? (
                                        <div className="space-y-3">
                                            {recentForesights.map(fs => (
                                                <div key={fs.id} className="rounded-lg border p-3">
                                                    <p className="text-sm">{fs.content}</p>
                                                    {fs.evidence && (
                                                        <p className="text-xs text-muted-foreground mt-1">
                                                            Evidence: {fs.evidence}
                                                        </p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground text-center py-8">
                                            No foresights yet. They will be extracted from your memories.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'episodes' && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-sm shadow-sm">
                            <span className="text-muted-foreground">{filteredEpisodes.length} episodes</span>
                            <button
                                onClick={() => {
                                    if (expandedIds.size > 0) {
                                        setExpandedIds(new Set());
                                    } else {
                                        setExpandedIds(new Set(filteredEpisodes.map(ep => ep.id)));
                                    }
                                }}
                                className="text-xs font-medium text-primary hover:underline"
                            >
                                {expandedIds.size > 0 ? 'Collapse all' : 'Expand all'}
                            </button>
                        </div>
                        {filteredEpisodes.length > 0 ? (
                            filteredEpisodes.map(ep => {
                                const relatedEvents = eventsByEpisode.get(ep.id) ?? [];
                                const relatedForesights = foresightsByEpisode.get(ep.id) ?? [];
                                const source = extractSource(ep.metadata);
                                return (
                                    <div
                                        key={ep.id}
                                        id={`episode-${ep.id}`}
                                        className="rounded-xl border bg-card shadow-sm overflow-hidden"
                                    >
                                        <button
                                            onClick={() => toggleExpand(ep.id)}
                                            className="w-full flex items-center justify-between p-4 text-left hover:bg-accent/50 transition-colors"
                                        >
                                            <div className="flex items-center gap-3">
                                                {expandedIds.has(ep.id) ? (
                                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                                ) : (
                                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                                )}
                                                <div>
                                                    <p className="font-medium">{ep.subject || 'Episode'}</p>
                                                    <p className="text-sm text-muted-foreground line-clamp-1">
                                                        {ep.summary}
                                                    </p>
                                                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            {relatedEvents.length} events
                                                        </span>
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            {relatedForesights.length} foresights
                                                        </span>
                                                        {source?.sourceName && (
                                                            <span className="rounded-full border px-2 py-0.5">
                                                                Source: {source.sourceName}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            <span className="text-xs text-muted-foreground">
                                                {formatDate(ep.timestamp)}
                                            </span>
                                        </button>
                                        {expandedIds.has(ep.id) && (
                                            <div className="border-t p-4 bg-muted/30 space-y-4">
                                                <p className="text-sm whitespace-pre-wrap">{ep.episode || ep.summary}</p>
                                                {(relatedEvents.length > 0 || relatedForesights.length > 0) && (
                                                    <div className="rounded-lg border bg-background p-3">
                                                        <p className="text-xs font-semibold uppercase text-muted-foreground">Linked memories</p>
                                                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                                                            {relatedEvents.length > 0 && (
                                                                <div className="rounded-md border p-2">
                                                                    <p className="text-xs font-medium text-muted-foreground">Events</p>
                                                                    <ul className="mt-1 space-y-1 text-xs">
                                                                        {relatedEvents.slice(0, 3).map(log => (
                                                                            <li key={log.id} className="line-clamp-1">
                                                                                {log.atomic_fact}
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                </div>
                                                            )}
                                                            {relatedForesights.length > 0 && (
                                                                <div className="rounded-md border p-2">
                                                                    <p className="text-xs font-medium text-muted-foreground">Foresights</p>
                                                                    <ul className="mt-1 space-y-1 text-xs">
                                                                        {relatedForesights.slice(0, 3).map(fs => (
                                                                            <li key={fs.id} className="line-clamp-1">
                                                                                {fs.content}
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                                {source?.sourcePath && (
                                                    <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs">
                                                        <div className="truncate text-muted-foreground">
                                                            {source.sourcePath}
                                                        </div>
                                                        <button
                                                            onClick={() => handleOpenSource(source.sourcePath)}
                                                            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                        >
                                                            Open file
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-center py-12">
                                <Brain className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                                <p className="text-muted-foreground">No episodes found</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'events' && (
                    <div className="space-y-2">
                        {filteredEventLogs.length > 0 ? (
                            filteredEventLogs.map(log => {
                                const parent = log.parent_episode_id ? episodesById.get(log.parent_episode_id) : undefined;
                                const source = extractSource(parent?.metadata);
                                return (
                                    <div
                                        key={log.id}
                                        className="rounded-lg border bg-card p-3 shadow-sm"
                                    >
                                        <div className="flex items-start gap-3">
                                            <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                                            <div className="flex-1 space-y-2">
                                                <p className="text-sm">{log.atomic_fact}</p>
                                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                    <span>{formatDate(log.timestamp)}</span>
                                                    {parent?.subject && (
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            {parent.subject}
                                                        </span>
                                                    )}
                                                    {source?.sourceName && (
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            Source: {source.sourceName}
                                                        </span>
                                                    )}
                                                </div>
                                                {(parent || source?.sourcePath) && (
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {parent?.id && (
                                                            <button
                                                                onClick={() => handleJumpToEpisode(parent.id)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                <Link2 className="h-3 w-3" />
                                                                View episode
                                                            </button>
                                                        )}
                                                        {source?.sourcePath && (
                                                            <button
                                                                onClick={() => handleOpenSource(source.sourcePath)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                Open file
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-center py-12">
                                <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                                <p className="text-muted-foreground">No event logs found</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'foresights' && (
                    <div className="space-y-3">
                        {filteredForesights.length > 0 ? (
                            filteredForesights.map(fs => {
                                const parent = fs.parent_episode_id ? episodesById.get(fs.parent_episode_id) : undefined;
                                const source = extractSource(parent?.metadata);
                                return (
                                    <div
                                        key={fs.id}
                                        className="rounded-xl border bg-card p-4 shadow-sm"
                                    >
                                        <div className="flex items-start gap-3">
                                            <Lightbulb className="h-5 w-5 text-amber-500 mt-0.5" />
                                            <div className="flex-1 space-y-2">
                                                <p className="text-sm font-medium">{fs.content}</p>
                                                {fs.evidence && (
                                                    <p className="text-xs text-muted-foreground">
                                                        <span className="font-medium">Evidence:</span> {fs.evidence}
                                                    </p>
                                                )}
                                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                    {parent?.subject && (
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            {parent.subject}
                                                        </span>
                                                    )}
                                                    {source?.sourceName && (
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            Source: {source.sourceName}
                                                        </span>
                                                    )}
                                                </div>
                                                {(parent || source?.sourcePath) && (
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {parent?.id && (
                                                            <button
                                                                onClick={() => handleJumpToEpisode(parent.id)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                <Link2 className="h-3 w-3" />
                                                                View episode
                                                            </button>
                                                        )}
                                                        {source?.sourcePath && (
                                                            <button
                                                                onClick={() => handleOpenSource(source.sourcePath)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                Open file
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-center py-12">
                                <Lightbulb className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                                <p className="text-muted-foreground">No foresights found</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'timeline' && (
                    <div className="space-y-3">
                        {timelineEntries.length > 0 ? (
                            timelineEntries.map(entry => {
                                const typeLabel = entry.type === 'episode'
                                    ? 'Episode'
                                    : entry.type === 'event'
                                        ? 'Event'
                                        : 'Foresight';
                                const typeIcon = entry.type === 'episode'
                                    ? <Brain className="h-4 w-4 text-primary" />
                                    : entry.type === 'event'
                                        ? <Clock className="h-4 w-4 text-blue-500" />
                                        : <Lightbulb className="h-4 w-4 text-amber-500" />;
                                return (
                                    <div key={entry.id} className="rounded-xl border bg-card p-4 shadow-sm">
                                        <div className="flex items-start gap-3">
                                            <div className="mt-1">{typeIcon}</div>
                                            <div className="flex-1 space-y-2">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-xs font-semibold uppercase text-muted-foreground">
                                                        {typeLabel}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatDateShort(entry.timestamp)}
                                                    </span>
                                                </div>
                                                <p className="text-sm font-medium">{entry.title}</p>
                                                <p className="text-sm text-muted-foreground">{entry.body}</p>
                                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                    {entry.sourceName && (
                                                        <span className="rounded-full border px-2 py-0.5">
                                                            Source: {entry.sourceName}
                                                        </span>
                                                    )}
                                                </div>
                                                {(entry.parentEpisodeId || entry.sourcePath) && (
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {entry.parentEpisodeId && entry.type !== 'episode' && (
                                                            <button
                                                                onClick={() => handleJumpToEpisode(entry.parentEpisodeId)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                <Link2 className="h-3 w-3" />
                                                                View episode
                                                            </button>
                                                        )}
                                                        {entry.sourcePath && (
                                                            <button
                                                                onClick={() => handleOpenSource(entry.sourcePath)}
                                                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                                                            >
                                                                Open file
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-center py-12">
                                <Calendar className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                                <p className="text-muted-foreground">No timeline entries yet</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
