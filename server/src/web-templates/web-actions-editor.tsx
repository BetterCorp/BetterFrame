import type { SmartUrlStep } from "../schemas/wire/smart-url.js";
import { SMART_URL_STEP_TYPES } from "../schemas/wire/smart-url.js";
import type { WebActions } from "../shared/web-actions.js";

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function stepValue(step: SmartUrlStep): string {
  return step.type === "fill" ? `${step.selector ?? ""}=${step.value ?? ""}` : step.url ?? step.selector ?? step.script ?? (step.delay_ms == null ? "" : String(step.delay_ms));
}
function Step({ prefix, index, step }: { prefix: string; index: number; step: SmartUrlStep }) {
  return <div data-step-index={String(index)} style="display:grid;grid-template-columns:90px 1fr auto;gap:4px;margin:6px 0">
    <select name={`${prefix}_${index}_type`} class="form-input">{SMART_URL_STEP_TYPES.map(type => <option value={type} selected={step.type === type}>{type}</option>)}</select>
    <textarea name={`${prefix}_${index}_value`} rows="2" class="form-input" maxlength="10000" placeholder="URL, selector, selector=value, milliseconds, or JavaScript">{escapeText(stepValue(step))}</textarea>
    <button type="button" data-command="remove-step" class="btn btn-sm btn-danger">×</button>
  </div>;
}
function Steps({ prefix, steps, label }: { prefix: string; steps: SmartUrlStep[]; label: string }) {
  return <fieldset data-step-prefix={prefix} style="border:0;padding:0"><legend style="font-size:0.8rem">{label}</legend>
    <div data-step-rows="1">{steps.map((step,index) => <Step prefix={prefix} index={index} step={step} />)}</div>
    <button type="button" class="btn btn-sm btn-ghost" data-command="add-step">+ Add step</button>
  </fieldset>;
}
function Group({ index, name, steps }: { index: number; name: string; steps: SmartUrlStep[] }) {
  return <div data-web-group-index={String(index)} style="border-top:1px solid #ddd;margin-top:12px;padding-top:8px">
    <label>Group name</label><input class="form-input" name={`web_group_${index}_name`} value={name} maxlength="64" pattern="[A-Za-z][A-Za-z0-9_.-]{0,63}" required />
    <Steps prefix={`web_group_${index}_step`} steps={steps} label="Group steps" />
    <button type="button" data-command="remove-group" class="btn btn-sm btn-danger">Remove group</button>
  </div>;
}
export function WebActionsEditor({ config }: { config?: WebActions | null }) {
  const stepTemplate = String(<Step prefix="template" index={0} step={{ type: "click", selector: "" }} />);
  const groupTemplate = String(<Group index={0} name="" steps={[]} />);
  const handler = `(function(event){var b=event.target.closest('button[data-command]');if(!b)return;event.preventDefault();var root=b.closest('[data-web-actions]'),command=b.dataset.command;
if(command==='remove-step'){b.closest('[data-step-index]').remove();return;}
if(command==='remove-group'){b.closest('[data-web-group-index]').remove();return;}
if(command==='add-step'){var f=b.closest('[data-step-prefix]'),prefix=f.dataset.stepPrefix,n=Array.from(f.querySelectorAll('[data-step-index]')).reduce(function(m,e){return Math.max(m,Number(e.dataset.stepIndex)+1)},0),box=document.createElement('div');box.innerHTML=${JSON.stringify(stepTemplate)};var row=box.firstElementChild;row.dataset.stepIndex=String(n);row.querySelectorAll('[name]').forEach(function(e){e.name=prefix+'_'+n+'_'+e.name.split('_').pop()});f.querySelector('[data-step-rows]').appendChild(row);return;}
if(command==='add-group'){var n=Array.from(root.querySelectorAll('[data-web-group-index]')).reduce(function(m,e){return Math.max(m,Number(e.dataset.webGroupIndex)+1)},0),box=document.createElement('div');box.innerHTML=${JSON.stringify(groupTemplate)};var group=box.firstElementChild;group.dataset.webGroupIndex=String(n);group.querySelectorAll('[name]').forEach(function(e){e.name=e.name.replace('web_group_0_','web_group_'+n+'_')});group.querySelector('[data-step-prefix]').dataset.stepPrefix='web_group_'+n+'_step';root.querySelector('[data-group-list]').appendChild(group);}})(event)`;
  return <div data-web-actions="1" onclick={handler} class="card" style="box-shadow:none;border:1px solid #eee;margin:12px 0;padding:10px">
    <h4 style="margin:0 0 8px">Web actions</h4><input type="hidden" name="web_actions_present" value="1" />
    <p class="form-hint">Uses the existing step types. Fill: selector=value. Authentication stays on the entity.</p>
    <Steps prefix="web_on_load_step" steps={config?.on_load ?? []} label="On-load steps" />
    <p class="form-hint">Run when this block is shown and ready, after entity login.</p>
    <div data-group-list="1">{Object.entries(config?.groups ?? {}).map(([name,steps],index) => <Group index={index} name={name} steps={steps} />)}</div>
    <button type="button" class="btn btn-sm btn-ghost" data-command="add-group">+ Add action group</button>
    <div data-web-actions-error="1" role="alert" style="color:#b91c1c"></div>
  </div>;
}
