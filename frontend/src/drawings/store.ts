import type { Drawing, DrawingDocument } from './model';
import { parseDrawingDocument, validateDrawing } from './model';
import { DrawingHistory } from './history';
type Listener=()=>void;
export class DrawingStore {
 private document: DrawingDocument={schemaVersion:1,drawings:[]}; private listeners=new Set<Listener>(); readonly history=new DrawingHistory();
 constructor(private storageKey:string) { if(typeof window!=='undefined')this.document=parseDrawingDocument(window.localStorage.getItem(storageKey)); }
 getSnapshot=()=>this.document.drawings;
 subscribe=(listener:Listener)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener)};
 private emit(){for(const listener of this.listeners)listener();if(typeof window!=='undefined')try{window.localStorage.setItem(this.storageKey,JSON.stringify(this.document))}catch{/* storage can be disabled or full */}}
 private replace(drawings:Drawing[],record=true){if(record)this.history.record(this.document.drawings);this.document={schemaVersion:1,drawings};this.emit()}
 add(d:Drawing){if(!validateDrawing(d))throw new Error('Invalid drawing');this.replace([...this.document.drawings,d])}
 update(id:string,fn:(d:Drawing)=>Drawing){const current=this.document.drawings, next=current.map(d=>d.id===id&&!d.locked?fn(d):d);if(next.some((d,i)=>d!==current[i]))this.replace(next)}
 commitEdit(before:Drawing[]){this.history.record(before);this.emit()}
 remove(id:string){this.replace(this.document.drawings.filter(d=>d.id!==id))}
 duplicate(id:string,newId:string){const d=this.document.drawings.find(x=>x.id===id);if(!d)return;const copy={...structuredClone(d),id:newId,locked:false,createdAt:Date.now(),updatedAt:Date.now()} as Drawing;this.add(copy)}
 toggleLock(id:string){this.replace(this.document.drawings.map(d=>d.id===id?{...d,locked:!d.locked,updatedAt:Date.now()}:d))}
 setVisibility(visible:boolean){this.replace(this.document.drawings.map(d=>({...d,style:{...d.style,visible}})))}
 undo(){const result=this.history.undo(this.document.drawings);if(result){this.document={schemaVersion:1,drawings:result};this.emit()}}
 redo(){const result=this.history.redo(this.document.drawings);if(result){this.document={schemaVersion:1,drawings:result};this.emit()}}
}
