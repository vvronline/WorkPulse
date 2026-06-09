import { useState, useEffect } from "react";
import { BarChart3 } from "lucide-react";
import s from "./PollDisplay.module.css";
import { getPoll, votePoll } from "../../api";

interface PollData {
    question?: string;
    options?: string[];
    votes?: Record<string, Array<{ userId?: number | string } | number | string>>;
    closed_at?: string | null;
    multi_select?: boolean;
    [key: string]: unknown;
}

interface PollDisplayProps {
    pollId: number | string;
    userId?: number | string;
    isMine?: boolean;
}

export default function PollDisplay({ pollId, userId, isMine }: PollDisplayProps) {
    const [poll, setPoll] = useState<PollData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!pollId) return;
        setLoading(true);
        getPoll(pollId)
            .then(({ data }) => setPoll(data as PollData))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [pollId]);

    const handleVote = async (idx: number) => {
        try {
            const { data } = await votePoll(pollId, idx);
            setPoll(prev => prev ? { ...prev, votes: data.votes } : prev);
        } catch { /* ignore */ }
    };

    // Update votes from WS poll_vote event
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.pollId === pollId && detail?.votes) {
                setPoll(prev => prev ? { ...prev, votes: detail.votes } : prev);
            }
        };
        window.addEventListener("poll_vote_update", handler);
        return () => window.removeEventListener("poll_vote_update", handler);
    }, [pollId]);

    if (loading || !poll) return <div className={s.loading}>Loading poll...</div>;

    const options = poll.options || [];
    const votes = poll.votes || {};
    const totalVotes = Object.values(votes).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

    return (
        <div className={`${s.poll} ${isMine ? s.pollMine : ""}`}>
            <div className={s.question}><BarChart3 size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />{poll.question}</div>
            <div className={s.options}>
                {options.map((opt, i) => {
                    const voters = votes[i] || [];
                    const voterIds = voters.map(v => typeof v === "object" ? v.userId : v);
                    const count = voterIds.length;
                    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                    const myVote = voterIds.includes(userId);

                    return (
                        <button
                            key={i}
                            className={`${s.option} ${myVote ? s.voted : ""}`}
                            onClick={() => handleVote(i)}
                            disabled={!!poll.closed_at}
                        >
                            <div className={s.optBar} style={{ width: `${pct}%` }} />
                            <span className={s.optLabel}>{opt}</span>
                            <span className={s.optCount}>{count > 0 ? `${count} (${pct}%)` : ""}</span>
                            {myVote && <span className={s.check}>✓</span>}
                        </button>
                    );
                })}
            </div>
            <div className={s.meta}>
                {totalVotes} vote{totalVotes !== 1 ? "s" : ""}
                {poll.multi_select && " · Multiple choice"}
            </div>
        </div>
    );
}