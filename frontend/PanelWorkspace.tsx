import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Columns2, Maximize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RotateCcw } from 'lucide-react';

type Widths = {left:number;right:number};
type PanelWorkspaceProps = {
 left:ReactNode;center:ReactNode;right?:ReactNode;revealKey?:string;className?:string;readingTarget?:'center'|'right';
 rightOpen?:boolean;onRightOpenChange?:(open:boolean)=>void;rightLabel?:string;rightDefaultWidth?:number;rightMinWidth?:number;storageKey?:string;
};
function savedWidths(key:string,defaults:Widths,rightMinWidth:number):Widths {
 try {
  const value=JSON.parse(localStorage.getItem(key)||'null');
  return {
   left:Number.isFinite(value?.left)?Math.max(200,Math.min(480,value.left)):defaults.left,
   right:Number.isFinite(value?.right)?Math.max(rightMinWidth,Math.min(1000,value.right)):defaults.right,
  };
 } catch {return defaults;}
}
export default function PanelWorkspace({left,center,right,revealKey,className='',readingTarget='right',rightOpen,onRightOpenChange,rightLabel='inspector',rightDefaultWidth=320,rightMinWidth=280,storageKey='flowreview:panel-widths'}:PanelWorkspaceProps) {
 const defaults={left:250,right:Math.max(rightMinWidth,Math.min(1000,rightDefaultWidth))};
 const [widths,setWidths]=useState(()=>savedWidths(storageKey,defaults,rightMinWidth));
 const [leftHidden,setLeftHidden]=useState(false);
 const [internalRightOpen,setInternalRightOpen]=useState(true);
 const [reading,setReading]=useState(false);
 const [size,setSize]=useState(1500);
 const element=useRef<HTMLDivElement>(null);
 const stopResizing=useRef<(()=>void)|null>(null);
 const isRightOpen=rightOpen??internalRightOpen;
 function changeRightOpen(open:boolean) {setInternalRightOpen(open);onRightOpenChange?.(open);}
 useEffect(()=>{
  const target=element.current;if(!target)return;
  const observer=new ResizeObserver(([entry])=>setSize(entry.contentRect.width));observer.observe(target);
  return()=>observer.disconnect();
 },[]);
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(widths));}catch{/* Layout still works without browser storage. */}},[widths,storageKey]);
 useEffect(()=>{if(revealKey!==undefined)changeRightOpen(true);},[revealKey]);
 useEffect(()=>{if(!isRightOpen)setReading(false);},[isRightOpen]);
 useEffect(()=>setReading(false),[readingTarget]);
 useEffect(()=>()=>stopResizing.current?.(),[]);
 const showLeft=!leftHidden&&!reading;
 const showRight=!!right&&isRightOpen&&!(reading&&readingTarget==='center');
 const budget=Math.max(0,size-300-(showLeft?8:0)-(showRight?8:0));
 const leftWidth=Math.min(widths.left,Math.max(200,budget-(showRight?rightMinWidth:0)));
 const rightMax=Math.max(rightMinWidth,budget-(showLeft?leftWidth:0));
 const rightWidth=Math.min(widths.right,rightMax);
 const leftMax=Math.max(200,Math.min(480,budget-(showRight?rightWidth:0)));
 function resize(side:'left'|'right',value:number) {
  const minimum=side==='left'?200:rightMinWidth;
  const maximum=side==='left'?leftMax:rightMax;
  setWidths(previous=>({...previous,[side]:Math.max(minimum,Math.min(maximum,value))}));
 }
 function divider(side:'left'|'right',width:number) {
  const minimum=side==='left'?200:rightMinWidth;
  const maximum=side==='left'?leftMax:rightMax;
  return <div className={`pane-divider ${side}`} role="separator" aria-label={`Resize ${side==='left'?'inventory':rightLabel}`} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)} tabIndex={0} onDoubleClick={()=>setWidths(defaults)} onKeyDown={event=>{
   if(event.key==='Home'||event.key==='End'){event.preventDefault();resize(side,event.key==='Home'?minimum:maximum);}
   else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
    event.preventDefault();resize(side,width+(event.key==='ArrowLeft'?-1:1)*(side==='left'?1:-1)*(event.shiftKey?60:24));
   }
  }} onPointerDown={event=>{
   if(event.button!==0)return;
   event.preventDefault();stopResizing.current?.();
   const handle=event.currentTarget,start=event.clientX,pointerId=event.pointerId;
   handle.setPointerCapture(pointerId);document.body.classList.add('resizing-panels');
   const move=(e:PointerEvent)=>resize(side,width+(e.clientX-start)*(side==='left'?1:-1));
   const stop=()=>{
    handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop);handle.removeEventListener('lostpointercapture',stop);
    if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);
    document.body.classList.remove('resizing-panels');stopResizing.current=null;
   };
   stopResizing.current=stop;
   handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);handle.addEventListener('lostpointercapture',stop);
  }}><span/></div>;
 }
 const columns=reading&&showRight?'minmax(0,1fr)':`${showLeft?`${leftWidth}px 8px `:''}minmax(0,1fr)${showRight?` 8px ${rightWidth}px`:''}`;
 const rightAction=`${isRightOpen?'Hide':'Show'} ${rightLabel}`;
 const expandAction=reading?'Restore layout':`Expand ${readingTarget==='center'?'reader':rightLabel}`;
 return <section className={`panel-workspace ${reading?'is-reading':''} ${className}`}>
  <div className="workspace-tools">
   <button onClick={()=>{setReading(false);setLeftHidden(value=>!value);}} title={leftHidden?'Show inventory':'Hide inventory'}>{leftHidden?<PanelLeftOpen size={14}/>:<PanelLeftClose size={14}/>}<span>{leftHidden?'Show':'Hide'} inventory</span></button>
   {right&&<button onClick={()=>{setReading(false);changeRightOpen(!isRightOpen);}} title={rightAction} aria-label={rightAction} aria-expanded={isRightOpen}>{isRightOpen?<PanelRightClose size={14}/>:<PanelRightOpen size={14}/>}<span>{rightAction}</span></button>}
   {(right||readingTarget==='center')&&<button className={reading?'active':''} aria-label={expandAction} onClick={()=>{changeRightOpen(true);setReading(value=>!value);}}>{reading?<Columns2 size={14}/>:<Maximize2 size={14}/>}<span>{expandAction}</span></button>}
   <button className="reset-panels" title="Reset panel sizes" onClick={()=>{setWidths(defaults);setLeftHidden(false);changeRightOpen(true);setReading(false);}}><RotateCcw size={13}/></button><small>Drag dividers to resize</small>
  </div>
  <div ref={element} className="workspace-panes" style={{'--pane-columns':columns,'--pane-right-width':`${widths.right}px`} as CSSProperties}>
   <div className="workspace-left" hidden={!showLeft}>{left}</div>{showLeft&&divider('left',leftWidth)}
   <div className="workspace-center" hidden={reading&&showRight&&readingTarget==='right'}>{center}</div>{showRight&&!reading&&divider('right',rightWidth)}
   {right&&<div className="workspace-right" hidden={!showRight}>{right}</div>}
  </div>
 </section>;
}
