import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { DEFAULT_WEB_PERMISSIONS, resolveWebPermissions, webPermissionsForm } from "../src/shared/web-permissions.js";
import { EntityEditPage, EntityNewPage } from "../src/web-templates/admin-pages.js";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { generateBundle } from "../src/shared/bundle.js";
import { fixture } from "./smart-url.test.js";

test("audible autoplay is the default; capture and other grants require explicit entity choices", () => {
  assert.deepEqual(Object.entries(DEFAULT_WEB_PERMISSIONS).filter(([, enabled]) => enabled).map(([key]) => key), ["audio", "autoplay"]);
  assert.deepEqual(resolveWebPermissions(), DEFAULT_WEB_PERMISSIONS);
  assert.equal(resolveWebPermissions({ microphone: "true" } as never).microphone, false);
  assert.equal(resolveWebPermissions({ audio: false }).audio, false);
  const submitted = webPermissionsForm({web_permission_audio:"1", web_permission_microphone:"1", web_permission_camera:"true"});
  assert.equal(submitted.audio, true);
  assert.equal(submitted.autoplay, false);
  assert.equal(submitted.microphone, true);
  assert.equal(submitted.camera, false);
});

test("entity pages expose permissions independently from input flags, including managed web entities", () => {
  const {entity} = fixture();
  assert.match(String(EntityNewPage({user:"admin",cameras:[]})), /Web permissions/);
  for (const type of ["web", "html", "dashboard", "ablesign"]) {
    const html = String(EntityEditPage({user:"admin",cameras:[],entity:{...entity,type,managed:true,web_permissions_json:{microphone:true}} as never}));
    assert.match(html,/name="web_permission_microphone"[^>]*checked/);
    assert.match(html,/name="web_permission_audio"[^>]*checked/);
    assert.doesNotMatch(html,/name="web_permission_camera"[^>]*checked/);
  }
  assert.doesNotMatch(String(EntityEditPage({user:"admin",cameras:[],entity:{...entity,type:"camera"} as never})), /web_permissions_present/);
});

test("entity form saves permissions, supports revocation, and protects managed content from unrelated edits", async () => {
  const f = fixture(), patches:Record<string,unknown>[] = [], created:Record<string,unknown>[] = [];
  const app=new H3();
  app.use(event=>{event.context.user={username:"admin"} as never;});
  registerAdminRoutes(app,{repo:{...f.repo,getEntityByName:async()=>null,createEntity:async(data:Record<string,unknown>)=>{created.push(data);},updateEntity:async(_:string,data:Record<string,unknown>)=>{patches.push(data);}}} as never);
  const post=(path:string,body:Record<string,string>)=>app.request(`http://bf.test/admin/entities/${path}`,{method:"POST",body:new URLSearchParams(body)});
  assert.equal((await post("new",{type:"web",name:"App",web_url:"https://app.example",web_permissions_present:"1",web_permission_audio:"1",web_permission_autoplay:"1",web_permission_microphone:"1"})).status,302);
  assert.equal((created[0]!.web_permissions_json as Record<string,boolean>).microphone,true);
  assert.equal((await post("entity",{web_url:f.entity.web_url,web_permissions_present:"1"})).status,302);
  assert.ok(Object.values(patches.pop()!.web_permissions_json as object).every(v=>v===false),"unchecked grants are revoked");
  assert.equal((await post("entity",{web_url:f.entity.web_url})).status,302);
  assert.ok(!("web_permissions_json" in patches.pop()!),"legacy requests do not reset saved permissions");
  Object.assign(f.entity,{managed:true});
  assert.equal((await post("entity",{name:"tampered",web_url:"https://wrong",web_permissions_present:"1",web_permission_camera:"1"})).status,302);
  assert.deepEqual(patches.pop(),{web_permissions_json:webPermissionsForm({web_permission_camera:"1"})});
});

test("every entity block receives the same permissions; edits update the bundle and viewers omit Linux policy", async () => {
  const f=fixture();
  Object.assign(f.entity,{web_permissions_json:{audio:false,microphone:true}});
  Object.assign(f.cells[0]!.options,{web_permissions:{audio:true,camera:true}});
  const make=()=>generateBundle(f.repo as never,f.secrets as never,"kiosk","cluster");
  const bundle=(await make())!;
  const cells=bundle.displays[0]!.layouts.flatMap(l=>l.cells);
  assert.equal(cells.length,3);
  for (const cell of cells) assert.deepEqual(cell.web_permissions,resolveWebPermissions({audio:false,microphone:true}));
  assert.equal((await make())!.version,bundle.version);
  Object.assign(f.entity,{web_permissions_json:{audio:false,microphone:false}});
  assert.notEqual((await make())!.version,bundle.version);
  f.repo.getKioskById=async()=>({id:"kiosk",name:"Kiosk",capabilities:["android-viewer"],enabled:true,operator_console_enabled:true,encrypt_key_encrypted:"encrypted"} as never);
  Object.assign(f.secrets,{decryptString:()=>"cluster"});
  assert.ok((await make())!.displays.every(d=>d.layouts.every(l=>l.cells.every(c=>c.web_permissions===undefined))));
});
