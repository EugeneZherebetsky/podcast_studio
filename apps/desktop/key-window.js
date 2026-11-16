/* global document, window */
'use strict';
const nameInput = document.querySelector('#name');
const valueInput = document.querySelector('#value');
const status = document.querySelector('#status');
const list = document.querySelector('#list');
const enabled = document.querySelector('#enabled');
const launch = document.querySelector('#launch');
const NEXT_LAUNCH = 'The running server was not changed. Finish any jobs, then quit and reopen Podcast Studio to apply.';
let ticked = [];
async function saveActivation() {
  const result = await window.keys.setActivation({ enabled: enabled.checked, keys: ticked });
  await refresh();
  status.textContent = result.ok ? `Activation choice saved. ${NEXT_LAUNCH}` : 'The activation choice could not be saved. Nothing was changed.';
}
async function refresh() {
  const [response, activation] = await Promise.all([window.keys.list(), window.keys.activation()]);
  if (!response.ok || !activation.ok) { status.textContent = 'Storage unavailable or corrupt. No changes were made.'; return; }
  const { usable, launch: started } = activation.value;
  enabled.checked = activation.value.enabled;
  ticked = activation.value.keys;
  launch.textContent = started.state === 'failed' ? 'This launch: stored keys could not be read, so the server started without any key.'
    : started.state === 'partial' ? `This launch: a stored key had an unsupported format and was not used. Given to the server: ${started.names.join(', ') || 'none'}.`
      : started.names.length ? `This launch: ${started.names.join(', ')} given to the server.` : 'This launch: no stored key was given to the server.';
  const selected = nameInput.value;
  nameInput.replaceChildren(); list.replaceChildren();
  for (const [name, present] of Object.entries(response.value)) {
    const option = document.createElement('option'); option.value = name; option.textContent = name; nameInput.append(option);
    const item = document.createElement('li');
    if (usable.includes(name)) {
      const label = document.createElement('label');
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = ticked.includes(name);
      box.addEventListener('change', () => { ticked = box.checked ? [...ticked, name] : ticked.filter((other) => other !== name); void saveActivation(); });
      label.append(box, ` ${name}: ${present ? 'stored' : 'not stored'}. Tick to use it for cloud speech.`);
      item.append(label);
    } else item.textContent = `${name}: ${present ? 'stored' : 'not stored'}. Never given to the server: the desktop app has no generation path that uses this provider.`;
    list.append(item);
  }
  if (selected) nameInput.value = selected;
}
enabled.addEventListener('change', () => { void saveActivation(); });
document.querySelector('#save').addEventListener('click', async () => {
  const value = valueInput.value; valueInput.value = '';
  const result = await window.keys.set(nameInput.value, value);
  status.textContent = result.ok ? `Saved. ${NEXT_LAUNCH}` : 'Save failed. No changes were made.';
  if (result.ok) await refresh();
});
document.querySelector('#clear').addEventListener('click', async () => {
  valueInput.value = '';
  const result = await window.keys.clear(nameInput.value);
  status.textContent = result.ok ? `Cleared from storage. A key already given to the running server stays in use until you quit. ${NEXT_LAUNCH}` : 'Clear failed. No changes were made.';
  if (result.ok) await refresh();
});
void refresh();
