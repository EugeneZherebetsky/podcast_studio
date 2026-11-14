/* global document, window */
'use strict';
const nameInput = document.querySelector('#name');
const valueInput = document.querySelector('#value');
const status = document.querySelector('#status');
const list = document.querySelector('#list');
async function refresh() {
  const response = await window.keys.list();
  if (!response.ok) { status.textContent = 'Storage unavailable or corrupt. No changes were made.'; return; }
  const selected = nameInput.value;
  nameInput.replaceChildren(); list.replaceChildren();
  for (const [name, present] of Object.entries(response.value)) {
    const option = document.createElement('option'); option.value = name; option.textContent = name; nameInput.append(option);
    const item = document.createElement('li'); item.textContent = `${name}: ${present ? 'stored' : 'not stored'}`; list.append(item);
  }
  if (selected) nameInput.value = selected;
}
document.querySelector('#save').addEventListener('click', async () => {
  const value = valueInput.value; valueInput.value = '';
  const result = await window.keys.set(nameInput.value, value);
  status.textContent = result.ok ? 'Saved but not used by this build, even after restart.' : 'Save failed. No changes were made.';
  if (result.ok) await refresh();
});
document.querySelector('#clear').addEventListener('click', async () => {
  valueInput.value = '';
  const result = await window.keys.clear(nameInput.value);
  status.textContent = result.ok ? 'Cleared. No restart was performed.' : 'Clear failed. No changes were made.';
  if (result.ok) await refresh();
});
void refresh();
