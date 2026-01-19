import type { IndexResultSnapshot } from '../types';

interface SummaryCardsProps {
    snapshot: IndexResultSnapshot | null;
    backendStatus: string;
    emailStatus?: { processing: number; pending: number };
    noteStatus?: { processing: number; pending: number };
    emailIndexedCount?: number;
    noteIndexedCount?: number;
    generalPendingCount?: number;
}

function readableSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function SummaryCards({
    snapshot,
    backendStatus,
    emailStatus,
    noteStatus,
    emailIndexedCount,
    noteIndexedCount,
    generalPendingCount
}: SummaryCardsProps) {
    if (!snapshot) {
        return (
            <div className="grid grid-cols-3 gap-4">
                {[1, 2, 3].map((item) => (
                    <div
                        key={item}
                        className="h-32 rounded-2xl border border-white/10 bg-white/5 animate-pulse"
                    />
                ))}
            </div>
        );
    }

    const { totalCount, totalSize, completedAt, byKind } = snapshot;
    const mailStatus = emailStatus ?? { processing: 0, pending: 0 };
    const notesStatus = noteStatus ?? { processing: 0, pending: 0 };
    const emailIndexed = emailIndexedCount ?? 0;
    const noteIndexed = noteIndexedCount ?? 0;
    const generalPending = generalPendingCount ?? 0;

    const rawDocumentIndexed = (byKind.document ?? 0) as number;
    const documentIndexed = Math.max(0, rawDocumentIndexed - emailIndexed - noteIndexed);
    const documentTotal = documentIndexed + Math.max(0, generalPending);

    const imageIndexed = (byKind.image ?? 0) as number;
    const videoIndexed = (byKind.video ?? 0) as number;
    const audioIndexed = (byKind.audio ?? 0) as number;
    const spreadsheetIndexed = (byKind.spreadsheet ?? 0) as number;
    const codeIndexed = (byKind.code ?? 0) as number;
    const bookIndexed = (byKind.book ?? 0) as number;
    const otherIndexed = Math.max(
        0,
        (byKind.other ?? 0) + (byKind.archive ?? 0) + (byKind.presentation ?? 0)
    );

    const emailPendingTotal = mailStatus.processing + mailStatus.pending;
    const notePendingTotal = notesStatus.processing + notesStatus.pending;
    const emailTotal = emailIndexed + emailPendingTotal;
    const notesTotal = noteIndexed + notePendingTotal;

    const combinedTotalCount = totalCount + noteIndexed;

    const orderedBreakdown: Array<{ key: string; label: string; indexed: number; total: number }> = [
        { key: 'documents', label: 'Documents', indexed: documentIndexed, total: documentTotal },
        { key: 'code', label: 'Code', indexed: codeIndexed, total: codeIndexed },
        { key: 'books', label: 'Books', indexed: bookIndexed, total: bookIndexed },
        { key: 'images', label: 'Images', indexed: imageIndexed, total: imageIndexed },
        { key: 'email', label: 'Email', indexed: emailIndexed, total: emailTotal },
        { key: 'notes', label: 'Notes', indexed: noteIndexed, total: notesTotal },
        { key: 'video', label: 'Video', indexed: videoIndexed, total: videoIndexed },
        { key: 'audio', label: 'Audio', indexed: audioIndexed, total: audioIndexed },
        { key: 'spreadsheets', label: 'Spreadsheets', indexed: spreadsheetIndexed, total: spreadsheetIndexed },
        { key: 'other', label: 'Other', indexed: otherIndexed, total: otherIndexed }
    ];

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-teal-400/40 bg-teal-400/10 p-4 shadow-glow">
                    <p className="text-xs uppercase tracking-wide text-teal-200/80">Total indexed files</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{combinedTotalCount}</p>
                    <p className="mt-2 text-[11px] text-teal-100/70">Updated {new Date(completedAt).toLocaleString()}</p>
                </div>
                <div className="rounded-2xl border border-sky-400/40 bg-sky-400/10 p-4 shadow-glow">
                    <p className="text-xs uppercase tracking-wide text-sky-200/80">Storage footprint</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{readableSize(totalSize)}</p>
                    <p className="mt-2 text-[11px] text-sky-100/70">Documents, media and archives</p>
                </div>
                <div className="rounded-2xl border border-violet-400/40 bg-violet-400/10 p-4 shadow-glow">
                    <p className="text-xs uppercase tracking-wide text-violet-200/80">RAG BACKEND</p>
                    <p className="mt-2 text-xl font-semibold text-white capitalize">{backendStatus}</p>
                    <p className="mt-2 text-[11px] text-violet-100/70">FastAPI server for retrieval preview</p>
                </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-300/90">Collection breakdown</p>
                <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
                    {orderedBreakdown.map((item) => {
                        const totalDisplay = Math.max(item.total, item.indexed);
                        const share = combinedTotalCount
                            ? Math.min(100, Math.round((item.indexed / combinedTotalCount) * 100))
                            : 0;
                        return (
                            <div
                                key={item.key}
                                className="rounded-xl border border-white/10 bg-slate-900/60 p-3"
                            >
                                <p className="text-xs uppercase tracking-wide text-slate-300/80">{item.label}</p>
                                <p className="mt-1 text-2xl font-semibold text-white">
                                    {item.indexed} / {totalDisplay}
                                </p>
                                <p className="mt-1 text-[11px] text-slate-300/80">
                                    {item.indexed === 1 ? 'Indexed file' : 'Indexed files'}
                                </p>
                                <p className="mt-1 text-[10px] uppercase tracking-wide text-cyan-200/70">
                                    {share}% of indexed corpus
                                </p>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
