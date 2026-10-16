import type { Drawing } from './model';
type Snapshot = Drawing[];
export class DrawingHistory {
 private undoStack: Snapshot[]=[]; private redoStack: Snapshot[]=[];
 constructor(private limit=100) {}
 record(before: Drawing[]) { this.undoStack.push(structuredClone(before)); if(this.undoStack.length>this.limit)this.undoStack.shift(); this.redoStack=[]; }
 undo(current: Drawing[]): Drawing[] | null { const prev=this.undoStack.pop(); if(!prev)return null;this.redoStack.push(structuredClone(current));return structuredClone(prev); }
 redo(current: Drawing[]): Drawing[] | null { const next=this.redoStack.pop();if(!next)return null;this.undoStack.push(structuredClone(current));return structuredClone(next); }
 canUndo(){return this.undoStack.length>0} canRedo(){return this.redoStack.length>0}
}
