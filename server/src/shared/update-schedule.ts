export type UpdateScheduleWindow = {
  day: number;
  start: string;
  end: string;
};

export type UpdateSchedule = {
  mode: "always" | "windows";
  windows: UpdateScheduleWindow[];
};

export const DEFAULT_UPDATE_SCHEDULE: UpdateSchedule = {
  mode: "always",
  windows: [],
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeUpdateSchedule(raw: unknown): UpdateSchedule {
  if (!raw || typeof raw !== "object") return DEFAULT_UPDATE_SCHEDULE;
  const value = raw as Record<string, unknown>;
  if (value.mode !== "windows") return DEFAULT_UPDATE_SCHEDULE;
  const windows = Array.isArray(value.windows)
    ? value.windows
        .map(normalizeWindow)
        .filter((w): w is UpdateScheduleWindow => w != null)
    : [];
  return windows.length > 0 ? { mode: "windows", windows } : DEFAULT_UPDATE_SCHEDULE;
}

export function updateScheduleAllowsNow(schedule: UpdateSchedule, now = new Date()): boolean {
  if (schedule.mode === "always") return true;
  const day = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  return schedule.windows.some((window) => {
    const start = parseMinutes(window.start);
    const end = parseMinutes(window.end);
    if (start == null || end == null || start === end) return false;
    if (start < end) {
      return window.day === day && minute >= start && minute < end;
    }
    return (
      (window.day === day && minute >= start)
      || (((window.day + 1) % 7) === day && minute < end)
    );
  });
}

function normalizeWindow(raw: unknown): UpdateScheduleWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const day = Number(value.day);
  const start = typeof value.start === "string" ? value.start : "";
  const end = typeof value.end === "string" ? value.end : "";
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!TIME_RE.test(start) || !TIME_RE.test(end) || start === end) return null;
  return { day, start, end };
}

function parseMinutes(value: string): number | null {
  const match = TIME_RE.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
