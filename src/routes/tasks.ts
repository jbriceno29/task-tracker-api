import { Router, type Request, type Response } from 'express';
import db from '../db.js';
import { PRIORITIES, toTask, type Priority, type TaskRow } from '../types.js';

export const tasksRouter = Router();

// Prepared statements (compiled once, reused per request).
const listStmt = db.prepare('SELECT * FROM tasks ORDER BY id ASC');
const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
const insertStmt = db.prepare(
  'INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)',
);
const deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');

/** Parse and validate a route `:id` param, returning null when invalid. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const PRIORITY_ERROR = `Field "priority" must be one of: ${PRIORITIES.join(', ')}.`;
const COMPLETED_ERROR = 'Field "completed" must be "true" or "false".';
const DUE_DATE_ERROR =
  'Field "due_date" must be a valid date in YYYY-MM-DD format or null.';

/** True for a valid priority value (case-sensitive). */
function isValidPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * True when `s` is a real calendar date in strict `YYYY-MM-DD` form. The
 * round-trip check rejects impossible dates such as 2026-02-30 or 2026-13-01.
 */
function isValidDateOnly(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * GET /tasks
 * List tasks, oldest first. Optional query params (combined with AND):
 *   - completed: "true" | "false" (exact, lowercase)
 *   - priority: "low" | "medium" | "high" (case-sensitive)
 * Invalid, empty or repeated values return 400. Unknown params are ignored.
 */
tasksRouter.get('/', (req: Request, res: Response) => {
  const { completed, priority } = req.query;

  if (completed !== undefined && completed !== 'true' && completed !== 'false') {
    return res.status(400).json({ error: COMPLETED_ERROR });
  }

  if (priority !== undefined && !isValidPriority(priority)) {
    return res.status(400).json({ error: PRIORITY_ERROR });
  }

  if (completed === undefined && priority === undefined) {
    const rows = listStmt.all() as TaskRow[];
    return res.json(rows.map(toTask));
  }

  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (completed !== undefined) {
    conditions.push('completed = ?');
    values.push(completed === 'true' ? 1 : 0);
  }

  if (priority !== undefined) {
    conditions.push('priority = ?');
    values.push(priority);
  }

  const sql = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...values) as TaskRow[];
  res.json(rows.map(toTask));
});

/**
 * POST /tasks
 * Create a task from { "title": "...", "priority"?: "low"|"medium"|"high",
 * "due_date"?: "YYYY-MM-DD" | null }.
 */
tasksRouter.post('/', (req: Request, res: Response) => {
  const { title, priority, due_date } = req.body ?? {};

  if (typeof title !== 'string' || title.trim().length === 0) {
    return res
      .status(400)
      .json({ error: 'Field "title" is required and must be a non-empty string.' });
  }

  if (priority !== undefined && !isValidPriority(priority)) {
    return res.status(400).json({ error: PRIORITY_ERROR });
  }

  if (
    due_date !== undefined &&
    due_date !== null &&
    (typeof due_date !== 'string' || !isValidDateOnly(due_date))
  ) {
    return res.status(400).json({ error: DUE_DATE_ERROR });
  }

  const info = insertStmt.run(
    title.trim(),
    priority === undefined ? 'medium' : priority,
    due_date === undefined ? null : due_date,
  );
  const row = getStmt.get(info.lastInsertRowid) as TaskRow;
  res.status(201).json(toTask(row));
});

/**
 * PATCH /tasks/:id
 * Update any of title, completed, priority and due_date of a task.
 */
tasksRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: 'Invalid task id.' });
  }

  const existing = getStmt.get(id) as TaskRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: `Task ${id} not found.` });
  }

  const { title, completed, priority, due_date } = req.body ?? {};
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return res
        .status(400)
        .json({ error: 'Field "title" must be a non-empty string.' });
    }
    updates.push('title = ?');
    values.push(title.trim());
  }

  if (completed !== undefined) {
    if (typeof completed !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'Field "completed" must be a boolean.' });
    }
    updates.push('completed = ?');
    values.push(completed ? 1 : 0);
  }

  if (priority !== undefined) {
    if (!isValidPriority(priority)) {
      return res.status(400).json({ error: PRIORITY_ERROR });
    }
    updates.push('priority = ?');
    values.push(priority);
  }

  if (due_date !== undefined) {
    if (
      due_date !== null &&
      (typeof due_date !== 'string' || !isValidDateOnly(due_date))
    ) {
      return res.status(400).json({ error: DUE_DATE_ERROR });
    }
    updates.push('due_date = ?');
    values.push(due_date);
  }

  if (updates.length === 0) {
    return res
      .status(400)
      .json({
        error:
          'Provide at least one of "title", "completed", "priority" or "due_date" to update.',
      });
  }

  values.push(id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = getStmt.get(id) as TaskRow;
  res.json(toTask(row));
});

/**
 * DELETE /tasks/:id
 * Remove a task.
 */
tasksRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: 'Invalid task id.' });
  }

  const info = deleteStmt.run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: `Task ${id} not found.` });
  }

  res.status(204).send();
});

export default tasksRouter;
