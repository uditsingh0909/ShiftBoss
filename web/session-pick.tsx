// The session picker used wherever a task gets a session (task cards, the task page, New task, Promises).
// Besides the running sessions it offers "New session for this task…": a short form (name, folder, model),
// then ShiftBoss starts the session in herdr with the task's brief as its first prompt and assigns the task.
import { useState } from 'react';
import { resolveLead, taskSessionName } from '../shared/types';
import { act, api, Pick, useSnap } from './lib';

export const NEW_SESSION = '__new__';
const MODELS = [{ value: '', label: 'Claude Code default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];

/** Name, folder and model for a session started for a task; Start calls onStart (or the task's new-session API). */
export function NewSessionForm({ task, onDone, onStart, compact }: {
  task: { id: string; title: string; session?: string | null } | null;
  onDone: () => void;
  /** For a task not created yet (New task): the caller creates it, then starts the session. */
  onStart?: (spec: { name: string; cwd: string; model: string }) => Promise<void>;
  compact?: boolean;
}) {
  const snap = useSnap()!;
  const folders = [...new Set(snap.sessions.map((s) => s.cwd).filter(Boolean))];
  const lead = resolveLead(snap.sessions, snap.settings.leadSession ?? '');
  const prevCwd = snap.sessions.find((s) => s.name === task?.session)?.cwd;
  const [name, setName] = useState(task ? taskSessionName(task, snap.sessions.map((s) => s.name)) : '');
  const [cwd, setCwd] = useState(prevCwd ?? lead?.cwd ?? folders[0] ?? '');
  const [model, setModel] = useState('');
  // For a task not created yet the name may stay empty: ShiftBoss names it after the task.
  const ok = ((!name && !!onStart) || (/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(name) && !snap.sessions.some((s) => s.name === name))) && !!cwd.trim();
  const start = () => act(async () => {
    if (onStart) await onStart({ name, cwd: cwd.trim(), model });
    else await api('POST', `/api/tasks/${task!.id}/new-session`, { name, cwd: cwd.trim(), model: model || undefined });
    onDone();
  }, `Starting ${name || 'a new session'}: it gets the brief as soon as it is ready`);
  const p = 'ns-' + (task?.id ?? 'new');
  return (
    // A group, not a form: it can sit inside another form (New task).
    <div role="group" aria-label="New session" className="col well" style={{ gap: 10, padding: compact ? 10 : 14, flex: '1 1 100%', minWidth: 0 }}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (ok) void start(); } }}>
      <span style={{ fontSize: 13 }}>Start a new session{task ? ` for ${task.id}` : ''}. Its first prompt is the task's brief, so it starts right away.</span>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label htmlFor={p + '-name'} className="sr-only">Session name</label>
        <input id={p + '-name'} className="field mono" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder={onStart ? 'name (empty: named after the task)' : 'session-name'} style={{ flex: '1 1 180px', minWidth: 0, padding: '6px 10px' }} />
        <Pick id={p + '-cwd'} free width={240} label="Folder" value={cwd} onChange={setCwd} placeholder="Folder" options={folders.map((f) => ({ value: f }))} />
        <Pick id={p + '-model'} width={170} label="Model" value={model} onChange={setModel} options={MODELS} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="pill sm w" disabled={!ok} onClick={() => void start()}>Start session</button>
        <button type="button" className="pill sm" onClick={onDone}>Cancel</button>
        {name && snap.sessions.some((s) => s.name === name) && <span className="amber" style={{ fontSize: 12 }}>{name} is already running</span>}
        <span className="faint" style={{ fontSize: 12 }}>A folder Claude has not opened before asks "trust this folder?" in herdr; answer it there.</span>
      </div>
    </div>
  );
}

/**
 * A session picker with "New session for this task…" at the end. Picking a running session calls onChange;
 * picking the new one opens the form under the picker.
 */
export function SessionPick({ task, value, onChange, width = 150, label, emptyLabel = 'Unassigned', placeholder = 'Assign…', pill, id, prefix }: {
  task: { id: string; title: string; session?: string | null; stage?: number };
  value: string; onChange: (v: string) => void; width?: number; label: string; emptyLabel?: string; placeholder?: string; pill?: boolean; id?: string; prefix?: string;
}) {
  const snap = useSnap()!;
  const [creating, setCreating] = useState(false);
  const canStart = (task.stage ?? 0) < 6;
  return (
    <>
      <Pick id={id} pill={pill} prefix={prefix} width={width} label={label} value={value} placeholder={placeholder}
        onChange={(v) => { if (v === NEW_SESSION) setCreating(true); else { setCreating(false); onChange(v); } }}
        options={[...(canStart ? [{ value: NEW_SESSION, label: 'Create new session', action: true }] : []),
          { value: '', label: emptyLabel }, ...snap.sessions.map((x) => ({ value: x.name, hint: x.status }))]} />
      {creating && <NewSessionForm task={task} onDone={() => setCreating(false)} compact />}
    </>
  );
}
