import assert from "node:assert/strict";
import test from "node:test";
import { generateBundle } from "../src/shared/bundle.js";
import { fixture } from "./smart-url.test.js";
import { findReportedDisplayMatch } from "../src/plugins/service-api-http/index.js";

test("hardware identity preserves disabled settings when monitor positions change",()=>{
  const displays=[{id:"disabled",name:"Office",native_name:"DP-1",index:0,is_enabled:false},
    {id:"enabled",name:"TV",native_name:"DP-2",index:1,is_enabled:true}];
  assert.equal(findReportedDisplayMatch(displays,new Set(),"DP-2",0)?.id,"enabled");
  assert.equal(findReportedDisplayMatch(displays,new Set(),"New-connector",0),undefined);
});

test("bundle hardware identity survives editable titles and changes version on topology changes",async()=>{
  const f=fixture();
  const display={id:"display",index:1,name:"My display title",native_name:"DP-2",is_enabled:true,default_layout_id:"layout"};
  const repo={...f.repo,listDisplaysForKiosk:async()=>[display]};
  const make=()=>generateBundle(repo as never,f.secrets as never,"kiosk","cluster");
  const first=(await make())!;
  assert.equal(first.displays[0]!.name,"My display title");assert.equal(first.displays[0]!.native_name,"DP-2");
  assert.equal(first.displays[0]!.physical_index,1);
  display.native_name="DP-3";
  assert.notEqual((await make())!.version,first.version);
});

const pgUrl=process.env["BF_TEST_PG_URL"];
test("native display identity is persisted across renames and sparse monitor positions in PostgreSQL",{skip:!pgUrl},async()=>{
  const {PgAdapter}=await import("../src/shared/db/pg-adapter.js");
  const {initDb,createTenantSchema}=await import("../src/shared/db/init.js");
  const {randomBytes}=await import("node:crypto");
  const admin=new PgAdapter(pgUrl!);const name=`bf_display_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const url=new URL(pgUrl!);url.pathname=`/${name}`;
  const log={info(){},warn(){}};
  let db:Awaited<ReturnType<typeof initDb>>|undefined;
  try {
    db=await initDb({url:url.toString(),host:"",port:5432,user:"",password:"",database:name,poolMax:4},log);
    const {repo}=db;
    const kiosk=await repo.createKiosk({name:"Desktop",key_hash:"fixture",key_prefix:"fixture"});
    const first=await repo.createDisplayForKiosk(kiosk.id,{name:"First",index:0});
    const second=await repo.createDisplayForKiosk(kiosk.id,{name:"Second",index:1});
    await repo.updateDisplay(first.id,{name:"Office",native_name:"DP-1",is_enabled:false});
    await repo.updateDisplay(second.id,{name:"TV",native_name:"DP-2",index:0});
    const displays=await repo.listDisplaysForKiosk(kiosk.id);
    assert.equal(displays.find(display=>display.id===first.id)!.native_name,"DP-1");
    assert.equal(displays.find(display=>display.id===first.id)!.is_enabled,false);
    assert.equal(findReportedDisplayMatch(displays,new Set(),"DP-2",0)!.id,second.id);
    const tenant=await repo.createTenant({name:"Another tenant",slug:"another-tenant"});
    await createTenantSchema(repo.adapter,tenant.slug,log);
    await repo.adapter.withSearchPath(tenant.schema_name,async()=>{
      const other=await repo.createKiosk({name:"Other",key_hash:"fixture",key_prefix:"fixture"});
      const display=await repo.createDisplayForKiosk(other.id,{name:"Other"});
      assert.equal(display.native_name,null);
      await repo.updateDisplay(display.id,{native_name:"HDMI-A-1"});
      assert.equal((await repo.getDisplayById(display.id))!.native_name,"HDMI-A-1");
    });
  } finally {await db?.close();await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.close();}
});
