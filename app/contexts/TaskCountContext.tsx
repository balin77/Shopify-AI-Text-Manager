import { createContext, useContext, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { useFetcher, useLocation } from "@remix-run/react";

export interface CompletedTask {
  id: string;
  type: string;
  resourceType: string | null;
  resourceTitle: string | null;
  fieldType: string | null;
  completedAt: string;
}

interface TaskCountContextType {
  runningTaskCount: number;
  recentlyCompletedTasks: CompletedTask[];
  refresh: () => void;
}

const TaskCountContext = createContext<TaskCountContextType | undefined>(undefined);

export function TaskCountProvider({ children }: { children: ReactNode }) {
  const location = useLocation();

  // Fetchers for polling
  const tasksFetcher = useFetcher<{ count: number }>();
  const tasksFetcherRef = useRef(tasksFetcher);
  tasksFetcherRef.current = tasksFetcher;

  const completedTasksFetcher = useFetcher<{ tasks: CompletedTask[] }>();
  const completedTasksFetcherRef = useRef(completedTasksFetcher);
  completedTasksFetcherRef.current = completedTasksFetcher;

  // Polling state
  const pollIntervalRef = useRef(2000);
  const errorCountRef = useRef(0);
  const completedTasksPollIntervalRef = useRef(2000);
  const completedTasksErrorCountRef = useRef(0);
  const hasFetchedCountOnceRef = useRef(false);
  const hasFetchedCompletedOnceRef = useRef(false);

  // Derive running task count
  const runningTaskCount = (tasksFetcher.data?.count !== undefined && !isNaN(tasksFetcher.data.count))
    ? tasksFetcher.data.count
    : 0;

  // Derive recently completed tasks
  const recentlyCompletedTasks = completedTasksFetcher.data?.tasks ?? [];

  // Refresh function — immediately re-fetches both endpoints
  const refresh = useCallback(() => {
    const searchParams = new URLSearchParams(location.search);
    setTimeout(() => {
      if (tasksFetcherRef.current.state === "idle") {
        tasksFetcherRef.current.load(`/api/running-tasks-count?${searchParams.toString()}`);
      }
      if (completedTasksFetcherRef.current.state === "idle") {
        completedTasksFetcherRef.current.load(`/api/recently-completed-tasks?${searchParams.toString()}`);
      }
    }, 500); // Small delay to let DB write commit
  }, [location.search]);

  // Poll running tasks count
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);

    const fetchTaskCount = () => {
      if (tasksFetcherRef.current.state === "idle") {
        tasksFetcherRef.current.load(`/api/running-tasks-count?${searchParams.toString()}`);
      }
    };

    // Initial fetch
    fetchTaskCount();

    // Set up polling interval
    const interval = setInterval(fetchTaskCount, pollIntervalRef.current);

    // Backwards-compatible: listen for legacy event
    const handleTaskCountChanged = () => {
      setTimeout(fetchTaskCount, 500);
    };
    window.addEventListener('task-count-changed', handleTaskCountChanged);

    return () => {
      clearInterval(interval);
      window.removeEventListener('task-count-changed', handleTaskCountChanged);
    };
  }, [location.search]);

  // Poll recently completed tasks
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);

    const fetchCompletedTasks = () => {
      if (completedTasksFetcherRef.current.state === "idle") {
        completedTasksFetcherRef.current.load(`/api/recently-completed-tasks?${searchParams.toString()}`);
      }
    };

    // Initial fetch
    fetchCompletedTasks();

    // Set up polling interval
    const interval = setInterval(fetchCompletedTasks, completedTasksPollIntervalRef.current);

    return () => {
      clearInterval(interval);
    };
  }, [location.search]);

  // Exponential backoff for running tasks fetcher
  useEffect(() => {
    // Skip until we've received at least one real response
    if (tasksFetcher.state !== "idle") return;
    if (tasksFetcher.data === undefined) return; // Initial state — no response yet

    if (!hasFetchedCountOnceRef.current) {
      hasFetchedCountOnceRef.current = true;
    }

    const data = tasksFetcher.data as any;
    const hasError = data?.error || data?.warning;

    if (hasError) {
      errorCountRef.current += 1;
      const newInterval = Math.min(pollIntervalRef.current * 2, 60000);
      pollIntervalRef.current = newInterval;
    } else if (errorCountRef.current > 0) {
      errorCountRef.current = 0;
      const newInterval = Math.max(pollIntervalRef.current / 2, 2000);
      pollIntervalRef.current = newInterval;
    }
  }, [tasksFetcher.state, tasksFetcher.data]);

  // Exponential backoff for completed tasks fetcher
  useEffect(() => {
    if (completedTasksFetcher.state !== "idle") return;
    if (completedTasksFetcher.data === undefined) return;

    if (!hasFetchedCompletedOnceRef.current) {
      hasFetchedCompletedOnceRef.current = true;
    }

    const data = completedTasksFetcher.data as any;
    const hasError = data?.error || data?.warning;

    if (hasError) {
      completedTasksErrorCountRef.current += 1;
      const newInterval = Math.min(completedTasksPollIntervalRef.current * 2, 60000);
      completedTasksPollIntervalRef.current = newInterval;
    } else if (completedTasksErrorCountRef.current > 0) {
      completedTasksErrorCountRef.current = 0;
      const newInterval = Math.max(completedTasksPollIntervalRef.current / 2, 2000);
      completedTasksPollIntervalRef.current = newInterval;
    }
  }, [completedTasksFetcher.state, completedTasksFetcher.data]);

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
