// Connection form: paste a URL or fill the fields. The password is sent to the host only on Test or Save,
// and the host keeps it in VS Code SecretStorage, never in settings.
import { h } from './dom.js';
import { parseUrl } from '../core/connstr.js';

const PORTS = { postgres: 5432, mysql: 3306 };

export function startForm(vscode, app, data) {
  const c = Object.assign({ type: 'postgres', name: '', host: 'localhost', port: 5432, user: '', database: '', sslMode: 'disable', caFile: '', readOnly: false, file: '', savePassword: true }, data.conn || {});
  const editing = !!(data.conn && data.conn.id);
  const hasPassword = !!data.hasPassword;

  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, help ? h('span', { class: 'help' }, help) : null);
  const inp = (name, attrs = {}) => {
    const el = h('input', { name, id: `f-${name}`, type: 'text', ...attrs });
    el.value = c[name] === undefined || c[name] === null ? '' : String(c[name]);
    return el;
  };

  const typeSel = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Database type' });
  const types = [['postgres', 'PostgreSQL'], ['mysql', 'MySQL / MariaDB'], ['sqlite', 'SQLite file']];
  for (const [id, label] of types) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(c.type === id), class: 'seg-btn' + (c.type === id ? ' on' : '') }, label);
    b.addEventListener('click', () => setType(id));
    typeSel.append(b);
  }

  const url = h('input', { type: 'text', id: 'f-url', placeholder: 'postgres://user:password@host:5432/db?sslmode=require', spellcheck: 'false' });
  const urlBtn = h('button', { type: 'button', class: 'btn' }, 'Fill from URL');
  const name = inp('name', { placeholder: 'My database' });
  const host = inp('host');
  const port = inp('port', { type: 'number', min: '1', max: '65535' });
  const user = inp('user', { autocomplete: 'off' });
  const password = h('input', { type: 'password', id: 'f-password', autocomplete: 'new-password', placeholder: editing && hasPassword ? 'saved (leave empty to keep it)' : '' });
  const savePw = h('input', { type: 'checkbox', id: 'f-savePassword' });
  savePw.checked = c.savePassword !== false;
  const database = inp('database', { placeholder: 'optional' });
  const ssl = h('select', { id: 'f-sslMode' });
  for (const [v, l] of [['disable', 'disable (no SSL)'], ['prefer', 'prefer (SSL when the server has it)'], ['require', 'require (encrypt, do not check the certificate)'], ['verify-ca', 'verify-ca (check the certificate)'], ['verify-full', 'verify-full (check the certificate and host name)']]) {
    const o = h('option', { value: v }, l);
    if (c.sslMode === v) o.selected = true;
    ssl.append(o);
  }
  const ca = inp('caFile', { placeholder: 'optional, for verify-ca and verify-full' });
  const caBtn = h('button', { type: 'button', class: 'btn' }, 'Browse…');
  const ro = h('input', { type: 'checkbox', id: 'f-readOnly' });
  ro.checked = !!c.readOnly;
  const file = inp('file', { placeholder: '/path/to/app.db' });
  const fileBtn = h('button', { type: 'button', class: 'btn' }, 'Browse…');

  const server = h('div', { class: 'group' },
    h('div', { class: 'row2' }, field('Host', host), field('Port', port)),
    h('div', { class: 'row2' }, field('User', user), field('Password', password)),
    h('label', { class: 'check' }, savePw, ' Save the password in VS Code\'s secret storage (otherwise it is asked once per window)'),
    field('Database', database, 'Empty: the server default. PostgreSQL lists the other databases in the explorer too.'),
    field('SSL mode', ssl),
    h('div', { class: 'row-ca' }, field('CA certificate file', ca), caBtn));
  const sqlite = h('div', { class: 'group' }, h('div', { class: 'row-ca' }, field('SQLite file', file, 'A new file is created when it does not exist (unless the connection is read-only).'), fileBtn));
  const status = h('div', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  const test = h('button', { type: 'button', class: 'btn' }, 'Test connection');
  const save = h('button', { type: 'button', class: 'btn primary' }, editing ? 'Save' : 'Save and connect');
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');

  const form = h('form', { class: 'conn-form', autocomplete: 'off' },
    h('h1', {}, editing ? `Edit ${c.name}` : 'New connection'),
    h('p', { class: 'lead' }, 'Unlimited connections, free. This extension talks only to the server you type here: no telemetry, no update check, no license server.'),
    typeSel,
    h('div', { class: 'url-row' }, field('Paste a connection URL', url), urlBtn),
    field('Name', name),
    server, sqlite,
    h('label', { class: 'check' }, ro, ' Read-only: block every change on this connection (the server enforces it for PostgreSQL and MySQL)'),
    h('div', { class: 'buttons' }, test, save, cancel),
    status);
  app.append(form);

  function setType(t) {
    const prev = c.type;
    c.type = t;
    for (const b of typeSel.children) { const on = b.textContent === types.find((x) => x[0] === t)[1]; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    server.classList.toggle('hidden', t === 'sqlite');
    sqlite.classList.toggle('hidden', t !== 'sqlite');
    if (t !== 'sqlite' && (!port.value || Number(port.value) === PORTS[prev])) port.value = String(PORTS[t]);
    url.placeholder = t === 'mysql' ? 'mysql://user:password@host:3306/db' : (t === 'sqlite' ? 'sqlite:/path/to/app.db' : 'postgres://user:password@host:5432/db?sslmode=require');
  }
  setType(c.type);

  urlBtn.addEventListener('click', fillFromUrl);
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fillFromUrl(); } });
  url.addEventListener('paste', () => setTimeout(fillFromUrl, 0));
  function fillFromUrl() {
    if (!url.value.trim()) return;
    try {
      const p = parseUrl(url.value);
      setType(p.type);
      if (p.type === 'sqlite') { file.value = p.file; if (!name.value) name.value = p.file.split(/[\\/]/).pop(); }
      else {
        host.value = p.host; port.value = String(p.port); user.value = p.user || ''; database.value = p.database || '';
        if (p.password) password.value = p.password;
        ssl.value = p.sslMode || 'disable';
        if (!name.value) name.value = `${p.database || p.host}`;
      }
      url.value = '';
      say('Filled from the URL. The password stays in this form until you save.', 'ok');
    } catch (e) {
      say(e.message, 'bad');
    }
  }

  function collect() {
    return {
      id: c.id, type: c.type, name: name.value.trim(), host: host.value.trim(), port: Number(port.value), user: user.value,
      database: database.value.trim(), sslMode: ssl.value, caFile: ca.value.trim(), readOnly: ro.checked, file: file.value.trim(), savePassword: savePw.checked,
    };
  }
  const pw = () => (password.value === '' && editing && hasPassword ? undefined : password.value);

  // A URL still in the box is read first; if it cannot be read, its error stays on screen.
  const urlOk = () => { if (!url.value.trim()) return true; fillFromUrl(); return !url.value.trim(); };
  test.addEventListener('click', () => { if (!urlOk()) return; say('Connecting…', ''); vscode.postMessage({ type: 'test', conn: collect(), password: pw() }); });
  save.addEventListener('click', () => { if (!urlOk()) return; say('Saving…', ''); vscode.postMessage({ type: 'save', conn: collect(), password: pw() }); });
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  caBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse', what: 'ca' }));
  fileBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse', what: 'sqlite' }));
  form.addEventListener('submit', (e) => e.preventDefault());

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'browsed') { if (m.what === 'ca') ca.value = m.path; else { file.value = m.path; if (!name.value) name.value = m.path.split(/[\\/]/).pop(); } }
    if (m.type === 'tested' || m.type === 'saved') say(m.message, m.ok ? 'ok' : 'bad');
  });

  function say(text, cls) {
    status.textContent = text;
    status.className = `form-status ${cls}`;
  }
  (c.type === 'sqlite' ? file : (editing ? name : url)).focus();
  vscode.postMessage({ type: 'ready' });
}
