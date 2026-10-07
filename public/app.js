const $ = id => document.getElementById(id);
let token, current, runId, active = false, dirty = false, lastPause = '';
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token ?? '', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
const guard = fn => async (...args) => { try { await fn(...args); } catch (error) { notice(error.message); } };
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function list() {
  const flows = await api('/api/flows');
  $('flow-list').replaceChildren(...flows.map(flow => {
    const card = node('button', flow.name, `flow-card${current?.flow.id === flow.id ? ' active' : ''}`);
    card.append(node('small', flow.error ?? `${flow.steps} steps · ${new URL(flow.url).hostname}`));
    card.onclick = guard(async () => {
      if (active) throw new Error('Stop or finish the current run before switching flows.');
      if (dirty && !window.confirm('Discard unsaved YAML changes?')) return;
      await select(flow.id);
    });
    return card;
  }));
}
async function select(id, preserveInputs = false) {
  const previous = {};
  if (preserveInputs) $('inputs').querySelectorAll('input').forEach(input => previous[input.name] = input.value);
  current = await api(`/api/flows/${encodeURIComponent(id)}`);
  $('empty').hidden = true; $('workspace').hidden = false;
  $('flow-name').textContent = current.flow.name; $('flow-url').textContent = current.flow.url;
  $('yaml').value = current.source; dirty = false; $('edit-status').textContent = 'Saved';
  $('inputs').replaceChildren(...Object.entries(current.flow.inputs).map(([name, definition]) => {
    const label = node('label', `${name}${definition.required ? ' *' : ''}`);
    const input = document.createElement('input'); input.name = name; input.value = previous[name] ?? ''; input.autocomplete = 'off';
    label.append(input); return label;
  }));
  renderSteps();
  await list();
  await history();
}
function renderSteps() {
  const selected = $('repair-step').value;
  $('repair-step').replaceChildren(...current.flow.steps.map(step => { const option = node('option', step.id); option.value = step.id; return option; }));
  $('step-count').textContent = String(current.flow.steps.length);
  $('steps').replaceChildren(...current.flow.steps.map(step => {
    const li = node('li', step.instruction); li.append(node('small', step.plan ? `${step.plan.actions.length} actions · ${step.learned?.status ?? 'authored plan'}` : 'Missing plan · resolves on next run')); return li;
  }));
  if (current.flow.steps.some(step => step.id === selected)) $('repair-step').value = selected;
}
async function refreshDefinition() {
  if (dirty) return;
  const updated = await api(`/api/flows/${encodeURIComponent(current.flow.id)}`);
  if (updated.revision === current.revision) return;
  current = updated;
  $('yaml').value = current.source;
  $('edit-status').textContent = 'Saved';
  renderSteps();
}
function setActive(value) { active = value; for (const id of ['run', 'repair', 'save', 'new-flow', 'empty-new', 'add-step']) $(id).disabled = value; $('yaml').readOnly = value; $('stop').hidden = !value; }
async function start(repair = false) {
  if (dirty) throw new Error('Save your YAML before running.');
  const inputs = {};
  $('inputs').querySelectorAll('input').forEach(input => { if (input.value !== '') inputs[input.name] = input.value; });
  notice(''); lastPause = '';
  const run = await api(`/api/flows/${current.flow.id}/run`, { method: 'POST', body: JSON.stringify({ inputs, ...(repair ? { repairStep: $('repair-step').value } : {}) }) });
  runId = run.id; setActive(true); $('run-panel').hidden = false; await poll();
}
async function history() {
  const runs = (await api('/api/runs')).filter(run => run.flowId === current.flow.id);
  $('run-history').replaceChildren(...runs.map(run => {
    const button = node('button', `${new Date(run.startedAt).toLocaleString()} · ${run.status}`);
    button.onclick = guard(async () => {
      if (active) throw new Error('Finish or stop the active run first.');
      const saved = await api(`/api/runs/${run.id}`);
      $('run-panel').hidden = false;
      renderRun(saved);
    });
    return button;
  }));
}
function renderRun(run) {
    $('run-status').textContent = `${run.mode} · ${run.status}${run.stepId ? ` · ${run.stepId}` : ''}`;
    $('events').textContent = run.events.map(event => `${new Date(event.at).toLocaleTimeString()}  ${event.message}`).join('\n');
    $('handoff').hidden = !run.pause;
    if (run.pause && JSON.stringify(run.pause) !== lastPause) {
      lastPause = JSON.stringify(run.pause); $('pause-message').textContent = run.pause.message;
      $('pause-input').hidden = run.pause.kind !== 'input'; $('pause-input').value = '';
      $('decisions').replaceChildren(...run.pause.choices.map(decision => {
        const names = { continue: 'Continue', retry: 'Retry', done: 'I completed this manually', stop: 'Stop' };
        const button = node('button', names[decision]);
        button.onclick = guard(async () => {
          await api(`/api/runs/${runId}/respond`, { method: 'POST', body: JSON.stringify({ decision, ...(run.pause.kind === 'input' ? { value: $('pause-input').value } : {}) }) });
          lastPause = ''; await poll();
        });
        return button;
      }));
    }
    $('outputs').replaceChildren();
    if (Object.keys(run.outputs ?? {}).length) $('outputs').append(node('h2', 'Extracted results'), node('pre', JSON.stringify(run.outputs, null, 2)));
    $('run-artifacts').replaceChildren();
    const log = node('a', 'Open run log'); log.href = `/api/runs/${run.id}/log`; log.target = '_blank';
    $('run-artifacts').append(log);
    if (run.events.some(event => event.message.startsWith('LLM '))) {
      const llm = node('a', 'Open LLM log'); llm.href = `/api/runs/${run.id}/llm-log`; llm.target = '_blank';
      $('run-artifacts').append(llm);
    }
    for (const screenshot of run.screenshots ?? []) {
      const link = node('a', `${screenshot.stepId} · ${screenshot.phase}`);
      link.href = `/api/runs/${run.id}/screenshots/${encodeURIComponent(screenshot.file)}`; link.target = '_blank';
      const image = document.createElement('img'); image.src = link.href; image.alt = link.textContent; image.loading = 'lazy';
      link.append(image); $('run-artifacts').append(link);
    }
    if (run.status === 'failed') notice(run.events.at(-1)?.message ?? 'Run failed');
}
async function poll() {
  if (!runId) return;
  try {
    const run = await api(`/api/runs/${runId}`);
    renderRun(run);
    await refreshDefinition();
    if (!['running', 'paused'].includes(run.status)) {
      setActive(false); runId = undefined;
      if (!dirty) await select(current.flow.id, true);
      return;
    }
    setTimeout(poll, 600);
  } catch (error) { notice(error.message); if (active) setTimeout(poll, 1500); }
}
$('add-step').onclick = () => {
  let number = current.flow.steps.length + 1;
  while (current.flow.steps.some(step => step.id === `step-${number}`)) number++;
  $('step-form').reset();
  $('step-form').elements.id.value = `step-${number}`;
  $('step-dialog').showModal();
};
$('cancel-step').onclick = () => $('step-dialog').close();
$('step-form').onsubmit = guard(async event => {
  event.preventDefault();
  if (active) throw new Error('Finish or stop the run before adding a step.');
  const button = $('submit-step'); button.disabled = true;
  try {
    const body = { ...Object.fromEntries(new FormData(event.target)), source: $('yaml').value, revision: current.revision };
    await api(`/api/flows/${current.flow.id}/steps`, { method: 'POST', body: JSON.stringify(body) });
    $('step-dialog').close();
    await select(current.flow.id, true);
    notice('Step added and flow saved.');
  } finally { button.disabled = false; }
});
$('new-flow').onclick = $('empty-new').onclick = () => $('new-dialog').showModal();
$('cancel-new').onclick = () => $('new-dialog').close();
$('new-form').elements.name.addEventListener('input', event => {
  $('new-form').elements.id.value = event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
});
$('new-form').onsubmit = guard(async event => {
  event.preventDefault();
  const form = new FormData(event.target); const body = Object.fromEntries(form);
  await api('/api/flows', { method: 'POST', body: JSON.stringify(body) });
  $('new-dialog').close(); event.target.reset(); await select(body.id); notice('Flow created. Replace the first instruction and add your steps.');
});
$('yaml').addEventListener('input', () => { dirty = true; $('edit-status').textContent = 'Unsaved'; });
$('yaml').addEventListener('keydown', event => { if (event.key === 'Tab' && !event.target.readOnly) { event.preventDefault(); const el = event.target; el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end'); dirty = true; $('edit-status').textContent = 'Unsaved'; } });
$('save').onclick = guard(async () => {
  await api(`/api/flows/${current.flow.id}`, { method: 'PUT', body: JSON.stringify({ source: $('yaml').value, revision: current.revision }) });
  await select(current.flow.id, true); notice('Saved.');
});
$('run').onclick = guard(() => start()); $('repair').onclick = guard(() => start(true));
$('stop').onclick = guard(async () => { await api(`/api/runs/${runId}/stop`, { method: 'POST', body: '{}' }); });
guard(async () => { token = (await api('/api/session')).token; await list(); })();
