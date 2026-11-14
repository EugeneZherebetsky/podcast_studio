/* global document, window */
const form = document.getElementById('settings');
const status = document.getElementById('status');
const fields = ['ollama', 'model', 'searxng'];
window.services.read().then((value) => {
  for (const key of fields) form.elements[key].value = value[key];
}).catch(() => { status.textContent = 'Could not read the saved settings.'; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = Object.fromEntries(fields.map((key) => [key, form.elements[key].value]));
  const result = await window.services.save(value);
  status.textContent = result;
});
document.getElementById('cancel').addEventListener('click', () => window.services.close());
