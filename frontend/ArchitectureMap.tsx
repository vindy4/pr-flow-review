import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { FileCode2, GitBranch, Maximize2 } from 'lucide-react';
import type { ArchitectureEdge, ArchitectureFile, Layer, View } from './types';
import { connectionLabel, fileVersion, statusName, type ConnectionBundle } from './architecture';

type FileData = Record<string, unknown> & {file: ArchitectureFile; view: View; root: boolean; layer: string};
type FileNode = Node<FileData, 'architectureFile'>;
function FileCard({data,selected}: NodeProps<FileNode>) {
  const version=fileVersion(data.file,data.view)!;
  return <div className={`architecture-file-card ${selected?'selected':''} ${data.root?'feature-root':''}`}>
    <Handle type="target" position={Position.Left}/>
    <div className="architecture-card-top"><FileCode2 size={14}/><span>{data.layer}</span><span className={`status-pill ${data.file.status}`}>{statusName(data.file.status)}</span></div>
    <strong title={version.path}>{data.file.label}</strong>
    <small title={version.path}>{version.path.split('/').slice(-3,-1).join('/')}</small>
    <div className="role-tags">{version.roles.length ? version.roles.map(role=><span key={role}>{role}</span>):<span>{data.layer}</span>}</div>
    <Handle type="source" position={Position.Right}/>
  </div>;
}
const nodeTypes={architectureFile:FileCard};
export default function ArchitectureMap({files,edges,layers,view,root,selectedId,selectedEdgeId,onFile,onEdge}: {
 files:ArchitectureFile[];edges:ArchitectureEdge[];layers:Layer[];view:View;root:string;
 selectedId:string|null;selectedEdgeId:string|null;onFile:(file:ArchitectureFile)=>void;onEdge:(edge:ArchitectureEdge)=>void;
}) {
 const [instance,setInstance]=useState<ReactFlowInstance|null>(null);
 const graph=useMemo(()=>{
  const used=layers.filter(layer=>files.some(file=>fileVersion(file,view)?.layer===layer.id));
  const positions=new Map<string,{x:number;y:number}>();
  const labels:Node[]=[];
  used.forEach((layer,column)=>{
   // Keep facade and implementation in order within their architectural lane.
   const lane=files.filter(f=>fileVersion(f,view)?.layer===layer.id);
   const depth=(id:string,seen=new Set<string>()):number=>{
    if(seen.has(id)) return 0;
    const next=new Set([...seen,id]);
    return Math.max(0,...edges.filter(e=>e.target===id&&lane.some(f=>f.id===e.source)).map(e=>1+depth(e.source,next)));
   };
   lane.sort((a,b)=>depth(a.id)-depth(b.id)||a.path.localeCompare(b.path));
   labels.push({id:`layer:${layer.id}`,position:{x:column*360,y:0},data:{label:layer.label},type:'default',draggable:false,selectable:false,style:{width:240,height:36,border:0,background:'var(--raised)',color:'var(--text)',fontSize:14,fontWeight:650,borderRadius:7},className:'architecture-layer-label'});
   lane.forEach((file,row)=>positions.set(file.id,{x:column*360,y:58+row*165}));
  });
  const nodes:Node[]=[...labels,...files.map(file=>({id:file.id,type:'architectureFile',position:positions.get(file.id)!,width:240,height:120,selected:selectedId===file.id&&!selectedEdgeId,data:{file,view,root:file.id===root,layer:layers.find(l=>l.id===fileVersion(file,view)?.layer)?.label||'Unclassified'}}))];
  const graphEdges:Edge[]=edges.map(edge=>{
   const selected=edge.id===selectedEdgeId||(edge as ConnectionBundle).memberIds?.includes(selectedEdgeId||'');
   return {id:edge.id,source:edge.source,target:edge.target,type:'smoothstep',label:connectionLabel(edge),ariaLabel:connectionLabel(edge),selected,markerEnd:{type:MarkerType.ArrowClosed,color:selected?'var(--accent)':'var(--graph-line)'},style:{stroke:selected?'var(--accent)':'var(--graph-line)',strokeWidth:selected?2.5:1.6,strokeDasharray:edge.relation==='imports'?'5 5':edge.status==='removed'?'7 4':undefined},labelStyle:{fontSize:12,fill:'var(--text-muted)'},labelBgStyle:{fill:'var(--canvas)'},labelBgPadding:[6,4]};
  });
  return {nodes,edges:graphEdges};
 },[files,edges,layers,view,root,selectedId,selectedEdgeId]);
 const structureKey=files.map(f=>f.id).join('|')+view;
 useEffect(()=>{if(instance&&files.length){const timer=window.setTimeout(()=>instance.fitView({padding:.12,maxZoom:1,duration:250}),90);return()=>window.clearTimeout(timer);}},[instance,structureKey]);
 return <section className="architecture-map" aria-label="File relationship map">
  <div className="panel-heading"><div><h2><GitBranch size={16}/> {root==='all'?'PR relationships':'File relationships'}</h2><span className="heading-sub">Callers and dependencies across application layers</span></div><button className="icon-button" title="Fit relationship map" onClick={()=>instance?.fitView({padding:.12,maxZoom:1,duration:250})}><Maximize2 size={16}/></button></div>
  <div className="architecture-map-toolbar"><span>{files.length} files · {edges.length} connections</span></div>
  <div className="architecture-canvas">{files.length?<ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={setInstance} onNodeClick={(_,node)=>{const file=files.find(f=>f.id===node.id);if(file)onFile(file);}} onEdgeClick={(_,edge)=>{const item=edges.find(e=>e.id===edge.id);if(item)onEdge(item);}} fitView minZoom={.08} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} proOptions={{hideAttribution:true}}><Background gap={24} color="var(--graph-dot)"/><Controls showInteractive={false}/></ReactFlow>:<div className="graph-empty"><h3>No file relationships to show</h3><p>Choose another file or change the map scope to inspect available relationships.</p></div>}</div>
  <div className="architecture-map-note">Arrows show resolved source dependencies.</div>
 </section>;
}
