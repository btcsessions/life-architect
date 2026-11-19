// "Next up": one ordered list from three things the user gives — importance, due date, time needed.
import type { Task } from "./db.ts";

export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export interface Ranked {
  task: Task;
  score: number;
  /** Short reasons shown next to the task, e.g. ["High importance", "Due tomorrow", "About 90 min"]. */
  why: string[];
}

const IMPORTANCE = { 1: 15, 2: 35, 3: 60 } as Record<number, number>;
const IMPORTANCE_LABEL = { 1: "Low importance", 2: "Medium importance", 3: "High importance" } as Record<number, string>;

export function dueLabel(days: number): string {
  if (days < 0) return days === -1 ? "Due yesterday" : `${-days} days overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

export function minutesLabel(m: number): string {
  if (m < 60) return `About ${m} min`;
  const h = m / 60;
  return `About ${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
}

export function scoreTask(t: Task, day: string): Ranked {
  const why = [IMPORTANCE_LABEL[t.importance] ?? IMPORTANCE_LABEL[2]];
  let score = IMPORTANCE[t.importance] ?? IMPORTANCE[2];

  let days: number | null = null;
  if (t.due) {
    days = daysBetween(day, t.due);
    if (days < 0) score += 50 + Math.min(20, -days * 5);
    else if (days === 0) score += 45;
    else if (days === 1) score += 35;
    else if (days <= 3) score += 25;
    else if (days <= 7) score += 12;
    else score += 3;
    why.push(dueLabel(days));
  }

  if (t.minutes != null) {
    // Quick wins float up a little; long jobs close to their deadline need starting now.
    if (t.minutes <= 15) score += 8;
    else if (t.minutes <= 30) score += 4;
    if (t.minutes >= 90 && days != null && days <= 2) score += 10;
    why.push(minutesLabel(t.minutes));
  }
  return { task: t, score, why };
}

/** Tasks that need the user, best first. Delegated, done and snoozed tasks are left out. */
export function rank(tasks: Task[], day: string): Ranked[] {
  return tasks
    .filter((t) => t.status === "open" && !t.delegate && !(t.snoozed_until && t.snoozed_until > day))
    .map((t) => scoreTask(t, day))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.task.due ?? "9999").localeCompare(b.task.due ?? "9999") ||
        a.task.id - b.task.id,
    );
}
