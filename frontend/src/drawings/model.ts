import type { Time } from 'lightweight-charts';

export type DrawingType = 'horizontal' | 'fibonacci' | 'long-position' | 'short-position';
export type Anchor = { time: Time; logical?: number; price: number };
export type DrawingStyle = { color: string; width: 1 | 2 | 3 | 4; visible: boolean };
type BaseDrawing = { id: string; type: DrawingType; style: DrawingStyle; locked: boolean; createdAt: number; updatedAt: number };
export type HorizontalDrawing = BaseDrawing & { type: 'horizontal'; anchor: Anchor };
export type FibonacciDrawing = BaseDrawing & { type: 'fibonacci'; a: Anchor; b: Anchor; levels: readonly [0, .382, .5, .618, 1]; showLabels: boolean };
export type PositionDrawing = BaseDrawing & { type: 'long-position' | 'short-position'; entryTime: Time; startTime: Time; endTime: Time; entry: number; stopLoss: number; takeProfit: number };
export type Drawing = HorizontalDrawing | FibonacciDrawing | PositionDrawing;
export type DrawingDocument = { schemaVersion: 1; drawings: Drawing[] };
export const DEFAULT_STYLE: DrawingStyle = { color: '#f5c451', width: 2, visible: true };
export const FIB_LEVELS = [0, .382, .5, .618, 1] as const;
export function isFinitePrice(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n > 0; }
function validTime(t: unknown): t is Time { return (typeof t === 'number' && Number.isFinite(t)) || (typeof t === 'string' && t.length > 0) || (!!t && typeof t === 'object' && 'year' in t && 'month' in t && 'day' in t); }
export function validateDrawing(value: unknown): value is Drawing {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<Drawing> & Record<string, any>;
  if (typeof d.id !== 'string' || !d.id || typeof d.locked !== 'boolean' || !d.style || typeof d.style.visible !== 'boolean' || ![1,2,3,4].includes(d.style.width) || typeof d.style.color !== 'string') return false;
  if (!['horizontal','fibonacci','long-position','short-position'].includes(String(d.type))) return false;
  if (d.type === 'horizontal') return validTime(d.anchor?.time) && isFinitePrice(d.anchor?.price);
  if (d.type === 'fibonacci') return validTime(d.a?.time) && validTime(d.b?.time) && isFinitePrice(d.a?.price) && isFinitePrice(d.b?.price) && Array.isArray(d.levels) && d.levels.length === 5 && d.levels.every((x:number,i:number)=>x===FIB_LEVELS[i]);
  if (d.type === 'long-position' || d.type === 'short-position') return validTime(d.entryTime) && validTime(d.startTime) && validTime(d.endTime) && isFinitePrice(d.entry) && isFinitePrice(d.stopLoss) && isFinitePrice(d.takeProfit) && (d.type === 'long-position' ? d.stopLoss < d.entry && d.takeProfit > d.entry : d.stopLoss > d.entry && d.takeProfit < d.entry);
  return false;
}
export function parseDrawingDocument(raw: string | null): DrawingDocument {
  if (!raw) return { schemaVersion: 1, drawings: [] };
  try { const parsed = JSON.parse(raw); if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.drawings)) return { schemaVersion: 1, drawings: [] }; return { schemaVersion: 1, drawings: parsed.drawings.filter(validateDrawing) }; }
  catch { return { schemaVersion: 1, drawings: [] }; }
}
export const makeId = () => globalThis.crypto?.randomUUID?.() ?? `drawing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
