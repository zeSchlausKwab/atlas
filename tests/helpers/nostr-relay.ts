import type { ServerWebSocket } from "bun";
type Event = { id: string; kind: number; pubkey: string; created_at: number; tags: string[][] };
type Peer = ServerWebSocket<{ subscriptions: Map<string, any[]> }>;
/** Isolated test relay. No federation, forwarding or connections to public relays. */
export function localRelay() {
  const peers = new Set<Peer>(), events: Event[] = [], kinds = new Set<number>();
  const matches = (event: Event, f: any) => (!f.kinds || f.kinds.includes(event.kind)) && (!f.authors || f.authors.includes(event.pubkey)) && (!f.ids || f.ids.includes(event.id)) && (!f.since || event.created_at >= f.since) && Object.entries(f).filter(([k])=>k.startsWith("#")).every(([k,v])=>event.tags.some(t=>t[0]===k.slice(1)&&(v as string[]).includes(t[1]!)));
  const server = Bun.serve<{subscriptions:Map<string,any[]>}>({hostname:"127.0.0.1",port:0,fetch(request,server){ if(server.upgrade(request,{data:{subscriptions:new Map()}})) return; return new Response("Local test relay"); },websocket:{
    open(ws){peers.add(ws);},close(ws){peers.delete(ws);},message(ws,raw){
      const [type,id,...rest]=JSON.parse(String(raw));
      if(type==="REQ") { ws.data.subscriptions.set(id,rest); for(const e of events) if(rest.some((f: any)=>matches(e,f))) ws.send(JSON.stringify(["EVENT",id,e])); ws.send(JSON.stringify(["EOSE",id])); }
      if(type==="CLOSE") ws.data.subscriptions.delete(id);
      if(type==="EVENT") { const e=id as Event; kinds.add(e.kind); if(!events.some(v=>v.id===e.id)){events.push(e);for(const p of peers)for(const [sub,filters] of p.data.subscriptions)if(filters.some(f=>matches(e,f)))p.send(JSON.stringify(["EVENT",sub,e]));} ws.send(JSON.stringify(["OK",e.id,true,""])); }
    },
  }});
  return { url:`ws://127.0.0.1:${server.port}`,kinds,close:()=>server.stop(true) };
}
