import { useState, useRef, useEffect } from 'react';
import { searchTasks } from '../../../api';

export function useGlobalSearch() {
  const [globalSearch, setGlobalSearch] = useState('');
  const [globalResults, setGlobalResults] = useState([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const globalSearchRef = useRef(null);
  const globalSearchTimer = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (globalSearchRef.current && !globalSearchRef.current.contains(e.target)) {
        setGlobalSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleGlobalSearch = (value) => {
    setGlobalSearch(value);
    if (globalSearchTimer.current) clearTimeout(globalSearchTimer.current);
    if (!value.trim() || value.trim().length < 2) {
      setGlobalResults([]);
      setGlobalSearchOpen(false);
      setGlobalSearching(false);
      return;
    }
    setGlobalSearching(true);
    setGlobalSearchOpen(true);
    globalSearchTimer.current = setTimeout(async () => {
      try {
        const res = await searchTasks(value.trim());
        setGlobalResults(res.data);
      } catch {
        setGlobalResults([]);
      } finally {
        setGlobalSearching(false);
      }
    }, 300);
  };

  return {
    globalSearch, globalResults, globalSearching, globalSearchOpen,
    globalSearchRef, setGlobalSearchOpen, handleGlobalSearch,
  };
}
