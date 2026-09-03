import { useState, useCallback, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { searchMessages as apiSearch } from "../../api";
import s from "./MessageSearch.module.css";

interface SearchResult {
  id: number | string;
  sender_name?: string;
  content?: string;
  created_at?: string;
  [key: string]: unknown;
}

function highlightMatch(
  text: string | undefined,
  query: string,
): React.ReactNode {
  if (!query || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={s.highlight}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface MessageSearchProps {
  convId: number | string;
  onJumpTo: (result: SearchResult) => void;
  onClose: () => void;
}

export default function MessageSearch({
  convId,
  onJumpTo,
  onClose,
}: MessageSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (q: string) => {
      if (!q || q.trim().length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const { data } = await apiSearch(q, convId);
        const next = data as SearchResult[];
        setResults(next);
        setActiveIndex(next.length ? 0 : -1);
      } catch {
        setResults([]);
        setActiveIndex(-1);
      }
      setLoading(false);
    },
    [convId],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => doSearch(v), 300);
  };

  const navigate = (direction: -1 | 1) => {
    if (results.length === 0) return;
    const next = Math.max(
      0,
      Math.min(results.length - 1, activeIndex + direction),
    );
    setActiveIndex(next);
    onJumpTo(results[next]);
  };

  return (
    <div className={s.overlay}>
      <div className={s.modal}>
        <div className={s.header}>
          <Search size={17} />
          <input
            className={s.input}
            placeholder="Search this chat…"
            value={query}
            onChange={onChange}
            autoFocus
          />
          <span className={s.count}>
            {results.length
              ? `${activeIndex + 1}/${results.length}`
              : query.trim().length < 2
                ? "Type"
                : "No matches"}
          </span>
          <button
            className={s.navBtn}
            onClick={() => navigate(-1)}
            disabled={activeIndex <= 0}
            aria-label="Previous result"
          >
            <ChevronUp size={18} />
          </button>
          <button
            className={s.navBtn}
            onClick={() => navigate(1)}
            disabled={activeIndex < 0 || activeIndex >= results.length - 1}
            aria-label="Next result"
          >
            <ChevronDown size={18} />
          </button>
          <button
            className={s.closeBtn}
            onClick={onClose}
            aria-label="Close search"
          >
            <X size={17} />
          </button>
        </div>
        <div className={s.results}>
          {loading && <div className={s.loading}>Searching...</div>}
          {!loading && results.length === 0 && query.length >= 2 && (
            <div className={s.empty}>No results found</div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              className={s.result}
              data-active={activeIndex === results.indexOf(r)}
              onClick={() => {
                const index = results.indexOf(r);
                setActiveIndex(index);
                onJumpTo(r);
              }}
            >
              <span className={s.sender}>{r.sender_name}</span>
              <span className={s.content}>
                {highlightMatch(r.content, query.trim())}
              </span>
              <span className={s.date}>
                {new Date(r.created_at as string).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
