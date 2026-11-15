import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { parseWebActions, webActionsFormDraft, bundleWebActions } from "../src/shared/web-actions.js";
import { WebActionsEditor } from "../src/web-templates/web-actions-editor.js";
import { registerWebActionRoutes } from "../src/plugins/service-admin-http/routes-web-actions.js";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { registerMiddleware, operatorMayAccess } from "../src/plugins/service-admin-http/middleware.js";
import { getCoordinator, setCoordinator } from "../src/shared/coordinator-registry.js";

const config = { on_load: [{ type: "wait" as const, delay_ms: 0 }], groups: { custom: [{ type: "click" as const, selector: "#button" }] } };
function fixture() {
  const cell = { id: "block", layout_id: "layout", entity_id: "entity", content_type: "web", options: { fit: "cover", web_actions: structuredClone(config) } };
  const entity = { id: "entity", type: "web", web_url: "https://app.example/", smart_url_json: null };
  let assigned = true, delivered = true, supported = true, allowed = true;
  const sent: { id: string; message: object; queue?: boolean }[] = [];
  const repo = {
    adapter: { dialect: () => "sqlite", get: async (sql: string) => allowed || !sql.startsWith("SELECT source_id") ? null : { source_id: "source" } },
    isSetupComplete: async () => true,
    getDisplayById: async (id: string) => id === "display" ? { id, kiosk_id: "kiosk" } : null,
    getLayoutCellById: async (id: string) => id === cell.id ? cell : null,
    getEntityById: async () => entity,
    getKioskById: async () => ({ capabilities: supported ? ["web-action-groups-v1"] : [] }),
    layoutsForDisplayId: async () => assigned ? [{ id: "layout" }] : [],
  };
  setCoordinator({ ...getCoordinator(), sendToKiosk: (id,message,queue) => { sent.push({id,message,queue}); return delivered; } });
  const app = new H3();
  registerWebActionRoutes(app, { repo } as never);
  const post = (group = "custom", body = { layout_id: "layout", cell_id: "block" }, display = "display") => app.request(`http://bf.test/api/displays/${display}/web-actions/${group}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, repo, cell, entity, post, sent,
    assign: (v: boolean) => { assigned = v; }, deliver: (v: boolean) => { delivered = v; }, support: (v: boolean) => { supported = v; },
    allow: (v: boolean) => { allowed = v; },
  };
}

test("generic action drafts retain row order, selector equals signs and user-authored groups", () => {
  const draft = webActionsFormDraft({ web_on_load_step_2_type: "wait", web_on_load_step_2_value: "0", web_group_4_name: "my-action", web_group_4_step_8_type: "fill", web_group_4_step_8_value: 'input[name="user"]=a=b', web_group_4_step_1_type: "javascript", web_group_4_step_1_value: "window.custom();" });
  assert.deepEqual(parseWebActions(draft), { on_load: [{type: "wait", delay_ms: 0}], groups: { "my-action": [{type: "javascript", script: "window.custom();"}, {type: "fill", selector: 'input[name="user"]', value: "a=b"}] } });
  assert.throws(() => webActionsFormDraft({web_group_0_name: "same",web_group_3_name: "same"}), /unique/);
  assert.throws(() => parseWebActions({on_load: [],groups: {"invalid/name": []}}), /Group names/);
  assert.throws(() => parseWebActions({on_load: [{type:"click",selector:""}], groups: {}}), /selector/);
  assert.throws(() => parseWebActions({on_load: [{type:"wait",delay_ms:-1}], groups:{}}), /wait times/);
  assert.throws(() => parseWebActions({on_load: [{type:"fill",selector:"#x",value_encrypted:"cipher"}], groups:{}}), /plain step values/);
  assert.throws(() => parseWebActions({on_load:Array(51).fill({type:"wait"}),groups:{}}), /50 steps/);
  assert.throws(() => parseWebActions({on_load:[],groups:Object.fromEntries(Array.from({length:33},(_,i)=>[`group${i}`,[]]))}), /32 action groups/);
  assert.equal(parseWebActions({on_load: [], groups: {}}), null);
});

test("binding revisions track actions, content and entity authentication but ignore geometry", t => {
  const original = getCoordinator(); t.after(() => setCoordinator(original));
  const f = fixture();
  const bundle = () => bundleWebActions(f.cell as never, f.entity as never)!;
  const revision = bundle().revision;
  assert.equal(bundleWebActions({...f.cell, col_span: 3} as never, f.entity as never)?.revision, revision);
  f.cell.options.web_actions.groups.custom[0]!.selector = "#edited";
  assert.notEqual(bundle().revision, revision);
  const edited = bundle().revision;
  f.entity.web_url = "https://different.example/";
  assert.notEqual(bundle().revision, edited);
  const content = bundle().revision;
  (f.entity as {smart_url_json: unknown}).smart_url_json = {login_detect_url:"/auth",steps:[{type:"click",selector:"#login"}]};
  assert.notEqual(bundle().revision, content);
});

test("API dispatches only a configured group bound to an assigned display and never queues offline actions", async t => {
  const original = getCoordinator(); t.after(() => setCoordinator(original));
  const f = fixture();
  const response = await f.post();
  assert.equal(response.status, 202);
  const body = await response.json() as {request_id: string};
  assert.ok(body.request_id);
  assert.deepEqual(f.sent, [{id:"kiosk",queue:false,message:{type:"web-action",request_id:body.request_id,display_id:"display",layout_id:"layout",cell_id:"block",group:"custom",revision:bundleWebActions(f.cell as never,f.entity as never)!.revision}}]);
  f.deliver(false); assert.equal((await f.post()).status, 503);
  f.sent.length=0;
  f.support(false); assert.equal((await f.post()).status, 409); f.support(true);
  assert.equal((await f.post("missing")).status, 404);
  assert.equal((await f.post("custom",{layout_id:"layout",cell_id:"other"})).status, 404);
  assert.equal((await f.post("custom",undefined,"other-tenant-display")).status, 404);
  f.assign(false); assert.equal((await f.post()).status, 404); f.assign(true);
  f.allow(false); assert.equal((await f.post()).status, 403); f.allow(true);
  f.cell.layout_id = "other"; assert.equal((await f.post()).status, 404);
  assert.deepEqual(f.sent, []);
});

test("web action API uses existing authentication and operator permission gates", async t => {
  const original = getCoordinator(); t.after(() => setCoordinator(original));
  const f=fixture();
  let valid=false;
  const app=new H3();
  registerMiddleware(app, {repo:f.repo,cookieName:"session",auth:{verifyApiKey:async()=>valid?{scopes:["admin"],key_prefix:"test"}:null}} as never);
  registerWebActionRoutes(app,{repo:f.repo} as never);
  const request=()=>app.request("http://bf.test/api/displays/display/web-actions/custom",{method:"POST",headers:{authorization:"Bearer bf-test","content-type":"application/json"},body:JSON.stringify({layout_id:"layout",cell_id:"block"})});
  assert.equal((await request()).status,401);
  valid=true; assert.equal((await request()).status,202);
  assert.equal(operatorMayAccess("/api/displays/display/web-actions/custom","POST"),true);
  assert.equal(operatorMayAccess("/api/displays/display/web-actions/custom","GET"),false);
});

test("block saves preserve other options, reject invalid actions before mutation, and allow removal", async t => {
  const original=getCoordinator();t.after(()=>setCoordinator(original));
  const f=fixture(), patches:Record<string,unknown>[]=[];
  let assigned=0;
  const app=new H3(); registerAdminRoutes(app,{repo:{...f.repo,assignCellEntity:async()=>{assigned++;},updateLayoutCell:async(_:string,patch:Record<string,unknown>)=>{patches.push(patch);}}} as never);
  const post=(body:Record<string,string>)=>app.request("http://bf.test/admin/layouts/layout/cells/block",{method:"POST",body:new URLSearchParams(body)});
  assert.equal((await post({web_actions_present:"1",web_group_0_name:"named",web_group_0_step_0_type:"click",web_group_0_step_0_value:"#run"})).status,302);
  assert.deepEqual(patches[0]?.options,{fit:"cover",web_actions:{on_load:[],groups:{named:[{type:"click",selector:"#run"}]}}});
  assert.equal(assigned,1);
  assert.equal((await post({web_actions_present:"1",web_group_0_name:"invalid name"})).status,422);
  assert.equal(assigned,1);
  patches.length=0;
  assert.equal((await post({web_actions_present:"1"})).status,302);
  assert.deepEqual(patches[0]?.options,{fit:"cover"});
});

test("editor escapes authored scripts and keeps entity authentication separate",()=>{
  const html=String(WebActionsEditor({config:{on_load:[{type:"javascript",script:'</textarea><script>alert("x")</script>'}],groups:config.groups}}));
  assert.match(html,/data-web-actions/);
  assert.doesNotMatch(html,/<script>alert/);
  assert.match(html,/Authentication stays on the entity/);
});


test("bundle encrypts action fills, keeps stable versions and excludes actions from virtual entity layouts", async () => {
  const { fixture } = await import("./smart-url.test.js");
  const { generateBundle } = await import("../src/shared/bundle.js");
  const f = fixture();
  (f.cells[0]!.options as Record<string,unknown>).web_actions = {on_load:[{type:"fill",selector:"#token",value:"private"}],groups:{custom:[{type:"fill",selector:"#other",value:"second"}]}};
  const make = () => generateBundle(f.repo as never,f.secrets as never,"kiosk","cluster");
  const bundle = (await make())!;
  const action = bundle.displays[0]!.layouts.find(l=>l.id==="layout")!.cells[0]!.web_actions!;
  assert.equal(action.on_load[0]!.value,undefined);
  assert.match(action.on_load[0]!.value_encrypted!,/^cipher-/);
  assert.equal(action.groups.custom![0]!.value,undefined);
  assert.equal(bundle.displays[0]!.layouts.filter(l=>l.id!=="layout").some(l=>l.cells.some(c=>c.web_actions)),false);
  assert.equal(bundle.version,(await make())!.version);
  action.groups.custom![0]!.value = "not stored";
  (f.cells[0]!.options as Record<string,any>).web_actions.groups.custom[0].value="changed";
  assert.notEqual(bundle.version,(await make())!.version);
});

test("device action results are bound to the reporting kiosk and desktop capabilities update on upgrade", async () => {
  const { registerKioskRoutes } = await import("../src/plugins/service-api-http/index.js");
  const app = new H3(), logged: Record<string,unknown>[] = [], updates:Record<string,unknown>[]=[];
  app.use(event=>{
    event.context.verifiedKiosk={id:"kiosk"};
    if (event.req.url.includes("web-actions/result")) event.context.obs={log:{info:(_:string,fields:Record<string,unknown>)=>{logged.push(fields);}}} as never;
  });
  registerKioskRoutes(app,{
    getDisplayById:async(id:string)=>({id,kiosk_id:id==="display"?"kiosk":"another"}),
    getKioskById:async()=>({id:"kiosk",enabled:true,capabilities:["gtk4"]}),
    updateKiosk:async(_:string,patch:Record<string,unknown>)=>{updates.push(patch);},
    trustedCasForKiosk:async()=>[], touchKiosk:async()=>{},getSetupExtra:async()=>null,listDisplaysForKiosk:async()=>[],
  } as never,{} as never,{} as never,{} as never,{} as never,{} as never,{publishTelemetry(){}} as never,"");
  const post=(path:string,body:unknown)=>app.request(`http://bf.test/api/kiosk/${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const result={request_id:"request",display_id:"display",cell_id:"block",group:"custom",ok:true};
  assert.equal((await post("web-actions/result",result)).status,200);
  assert.deepEqual(logged.pop(),{...result,error:""});
  assert.equal((await post("web-actions/result",{...result,display_id:"other"})).status,403);
  assert.equal((await post("heartbeat",{capabilities:["gtk4","web-action-groups-v1"]})).status,200);
  assert.deepEqual(updates[0],{capabilities:["gtk4","web-action-groups-v1"]});
});
