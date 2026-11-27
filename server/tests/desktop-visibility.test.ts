import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { fixture } from "./smart-url.test.js";
import { generateBundle } from "../src/shared/bundle.js";
import { registerViewerDeviceAuth } from "../src/shared/display-session.js";
import { registerKioskRoutes } from "../src/plugins/service-api-http/index.js";

test("desktop disable removes assignments, preserves enrollment and updates, and re-enable restores content", async () => {
  const f = fixture();
  const kiosk = {id:"kiosk",name:"Desktop",enabled:true,capabilities:["windows"],managed_image:false};
  const displays = [
    {id:"first",name:"Desktop: DISPLAY1",index:0,is_enabled:true,default_layout_id:"layout",width_px:1280,height_px:720},
    {id:"second",name:"Desktop: DISPLAY2",index:1,is_enabled:true,default_layout_id:"layout",width_px:1280,height_px:720},
  ];
  const repo = {...f.repo, getKioskById:async()=>kiosk, listDisplaysForKiosk:async()=>displays,
    touchKiosk:async()=>{},getSetupExtra:async()=>null,deleteDisplayIfUnused:async()=>false,
    updateDisplay:async(id:string,patch:object)=>Object.assign(displays.find(d=>d.id===id)!,patch),
  };
  const make=()=>generateBundle(repo as never,f.secrets as never,"kiosk","cluster");
  assert.equal((await make())!.displays.length,2);
  displays[0]!.is_enabled=false;
  const one=(await make())!;
  assert.deepEqual(one.displays.map(d=>[d.id,d.physical_index]),[["second",1]],"filtering cannot move DISPLAY2 onto DISPLAY1");
  displays[1]!.is_enabled=false;
  const none=(await make())!;
  assert.deepEqual(none.displays,[]); assert.equal(none.display,null); assert.deepEqual(none.layouts,[]);
  assert.equal((await make())!.version,none.version);
  const app=new H3();
  const auth={verifyKioskKey:async(key:string)=>key==="device-key"?{id:"kiosk",schema_name:"public",tenant_slug:"default"}:null};
  registerViewerDeviceAuth(app,repo as never,auth as never,f.secrets as never);
  registerKioskRoutes(app,repo as never,auth as never,f.secrets as never,{} as never,{} as never,{} as never,{publishTelemetry:()=>{}} as never,"");
  const headers={authorization:"Bearer device-key","content-type":"application/json"};
  const heartbeat=()=>app.request("https://bf.test/api/kiosk/heartbeat",{method:"POST",headers,body:JSON.stringify({displays:[
    {index:0,name:"DISPLAY1",width_px:1920,height_px:1080,power_state:"awake"},
    {index:1,name:"DISPLAY2",width_px:1280,height_px:720,power_state:"awake"},
  ]})});
  assert.equal((await heartbeat()).status,200);
  assert.ok(displays.every(d=>!d.is_enabled),"heartbeats must preserve disabled displays even after geometry changes");
  displays[1]!.is_enabled=true;
  kiosk.enabled=false;
  const disabled=await app.request("https://bf.test/api/kiosk/bundle",{headers});
  assert.equal(disabled.status,200);assert.deepEqual((await disabled.json() as {displays:unknown[]}).displays,[]);
  const policy=await heartbeat();assert.equal(policy.status,200);
  assert.ok("update_schedule" in await policy.json() as object,"background updates retain their schedule");
  app.get("/api/kiosk/os/check",()=>({status:"up_to_date"}));
  assert.equal((await app.request("https://bf.test/api/kiosk/os/check",{headers})).status,200);
  app.get("/api/kiosk/private-content",()=>({secret:true}));
  assert.equal((await app.request("https://bf.test/api/kiosk/private-content",{headers})).status,401);
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle",{headers:{cookie:"betterframe_kiosk_key=device-key"}})).status,401);
  kiosk.enabled=true;
  assert.deepEqual((await make())!.displays.map(d=>d.id),["second"]);
});
