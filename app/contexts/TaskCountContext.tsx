import { createContext, useContext, useEffect, useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

export interface CompletedTask {
  id: string;
  type: string;
  status: "completed" | "failed";
  resourceType: string | null;
  resourceTitle: string | null;
  fieldType: string | null;
  completedAt: string;
  processed?: number | null;
  total?: number | null;
  error?: string | null;
}

interface TaskCountContextType {
  runningTaskCount: number;
  recentlyCompletedTasks: CompletedTask[];
  refresh: () => void;
}

const TaskCountContext = createContext<TaskCountContextType | undefined>(undefined);

export function TaskCountProvider({ children }: { children: ReactNode }) {
  const location = useLocation();

  // State for polled data
  const [runningTaskCount, setRunningTaskCount] = useState(0);
  const [recentlyCompletedTasks, setRecentlyCompletedTasks] = useState<CompletedTask[]>([]);

  // Polling state
  const pollIntervalRef = useRef(2000);
  const errorCountRef = useRef(0);
  const completedTasksPollIntervalRef = useRef(2000);
  const completedTasksErrorCountRef = useRef(0);

  // Inflight guards to prevent double-fetching
  const tasksInflightRef = useRef(false);
  const completedInflightRef = useRef(false);

  // Stable fetch helpers — use regular fetch() instead of useFetcher.load()
  // so that route-matching errors don't bubble to ErrorBoundary and crash the app.
  const fetchTaskCount = useCallback(async (searchParams: string) => {
    if (tasksInflightRef.current) return;
    tasksInflightRef.current = true;
    try {
      const response = await fetch(`/api/running-tasks-count?${searchParams}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setRunningTaskCount(data?.count ?? 0);

      if (data?.error || data?.warning) {
        errorCountRef.current += 1;
        pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, 60000);
      } else if (errorCountRef.current > 0) {
        errorCountRef.current = 0;
        pollIntervalRef.current = Math.max(pollIntervalRef.current / 2, 2000);
      }
    } catch {
      errorCountRef.current += 1;
      pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, 60000);
    } finally {
      tasksInflightRef.current = false;
    }
  }, []);

  const fetchCompletedTasks = useCallback(async (searchParams: string) => {
    if (completedInflightRef.current) return;
    completedInflightRef.current = true;
    try {
      const response = await fetch(`/api/recently-completed-tasks?${searchParams}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      // Bail-out when the polled list is structurally identical to current
      // state. Without this, every 2s poll commits a new array reference (even
      // when nothing changed) → context value memo recomputes → every consumer
      // re-renders. useUnifiedContentEditor subscribes via useTaskCount(), so
      // ProductsPage was re-rendering every 2s in idle. Compare only the
      // fields that can change for a recently-completed task; if any differ,
      // accept the new array.
      const nextTasks: CompletedTask[] = data?.tasks ?? [];
      setRecentlyCompletedTasks(prev => {
        if (prev.length !== nextTasks.length) return nextTasks;
        for (let i = 0; i < prev.length; i++) {
          const a = prev[i];
          const b = nextTasks[i];
          if (
            a.id !== b.id ||
            a.status !== b.status ||
            a.processed !== b.processed ||
            a.total !== b.total ||
            a.error !== b.error ||
            a.completedAt !== b.completedAt
          ) {
            return nextTasks;
          }
        }
        return prev;
      });

      if (data?.error || data?.warning) {
        completedTasksErrorCountRef.current += 1;
        completedTasksPollIntervalRef.current = Math.min(completedTasksPollIntervalRef.current * 2, 60000);
      } else if (completedTasksErrorCountRef.current > 0) {
        completedTasksErrorCountRef.current = 0;
        completedTasksPollIntervalRef.current = Math.max(completedTasksPollIntervalRef.current / 2, 2000);
      }
    } catch {
      completedTasksErrorCountRef.current += 1;
      completedTasksPollIntervalRef.current = Math.min(completedTasksPollIntervalRef.current * 2, 60000);
    } finally {
      completedInflightRef.current = false;
    }
  }, []);

  // Refresh function — immediately re-fetches both endpoints
  const refresh = useCallback(() => {
    const searchParams = new URLSearchParams(location.search).toString();
    setTimeout(() => {
      fetchTaskCount(searchParams);
      fetchCompletedTasks(searchParams);
    }, 500); // Small delay to let DB write commit
  }, [location.search, fetchTaskCount, fetchCompletedTasks]);

  // Poll running tasks count using setTimeout chain (respects dynamic backoff)
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search).toString();
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const poll = () => {
      if (cancelled) return;
      fetchTaskCount(searchParams);
      timeoutId = setTimeout(poll, pollIntervalRef.current);
    };

    // Initial fetch + start chain
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [location.search, fetchTaskCount]);

  // Poll recently completed tasks using setTimeout chain
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search).toString();
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const poll = () => {
      if (cancelled) return;
      fetchCompletedTasks(searchParams);
      timeoutId = setTimeout(poll, completedTasksPollIntervalRef.current);
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [location.search, fetchCompletedTasks]);

  const value = useMemo(() => ({
    runningTaskCount,
    recentlyCompletedTasks,
    refresh,
  }), [runningTaskCount, recentlyCompletedTasks, refresh]);

  return (
    <TaskCountContext.Provider value={value}>
      {children}
    </TaskCountContext.Provider>
  );
}

export function useTaskCount() {
  const context = useContext(TaskCountContext);
  if (!context) {
    throw new Error("useTaskCount must be used within TaskCountProvider");
  }
  return context;
}
