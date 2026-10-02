// Browser half of Cloud sessions: the dialog's Cloud options and the ☁ chip.
import { parseEnvironments, isEnvironmentId } from './environments.js';

// A cloud, as the one-<svg>-of-<path>s the link.chip icon allows.
const CLOUD_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>';

const isCloud = (draft) => draft?.runtime === 'cloud';

// The environments the dialog offers: "Account default" (empty), each valid item
// of the `environments` setting, and `defaultEnvironment` if the list doesn't
// already have it (the server allows it too, see lib/environments.js).
export function environmentOptions(settings) {
  const { valid } = parseEnvironments(settings?.environments);
  const out = [{ value: '', label: 'Account default' }, ...valid.map((e) => ({ value: e.id, label: e.label }))];
  const def = typeof settings?.defaultEnvironment === 'string' ? settings.defaultEnvironment.trim() : '';
  if (isEnvironmentId(def) && !out.some((o) => o.value === def)) out.push({ value: def, label: def });
  return out;
}

// The ☁ chip for a `cloud` link: a link to the session on claude.ai, or the
// failure marker the launch-watch sweep attaches when the create failed.
export function chip(link) {
  if (link?.type !== 'cloud') return null;
  if (link.key === 'failed') return { label: '☁ failed', icon: CLOUD_ICON };
  const href = typeof link.url === 'string' && link.url.startsWith('https://claude.ai/') ? link.url : '';
  return { label: '☁ cloud', href, icon: CLOUD_ICON };
}

function row(labelText, control) {
  const wrap = document.createElement('div');
  wrap.className = 'dispatch-field';
  const label = document.createElement('label');
  label.htmlFor = control.id;
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

export function createDispatchField() {
  // One contribution at one anchor, so one element: plain closure state is
  // enough. `active` is the last ctx's answer to "is Cloud selected?", since
  // fields(el) and ext(el) aren't handed the ctx.
  let api = null;
  let select = null;
  let ref = null;
  let refRow = null;
  let active = false;
  let populated = false;

  // --ref only means anything on the self-hosted (ccpool_) form.
  const syncRef = () => { if (refRow) refRow.hidden = !String(select?.value || '').startsWith('ccpool_'); };

  return {
    id: 'cloud-options',
    at: 'advanced',
    // Function form (1.19.0): the worktree box is hidden only while Cloud is
    // the chosen runtime. Filtered against the manifest's hideDispatchField.
    hides: (draft) => (isCloud(draft) ? ['worktree'] : []),

    mount(el, mountApi) {
      api = mountApi;
      select = document.createElement('select');
      select.id = 'cloud-environment';
      ref = document.createElement('input');
      ref.id = 'cloud-ref';
      ref.autocomplete = 'off';
      ref.placeholder = 'branch the pool checks out (optional)';
      refRow = row('Cloud ref', ref);
      select.addEventListener('change', syncRef);
      el.append(row('Cloud environment', select), refRow);
      el.hidden = true;
      populated = false;
    },

    // ctx: { mode, draft, agents }. Idempotent: called on open, on model and
    // runtime changes and whenever the extension set changes. Keeps the human's
    // pick while it is still offered; otherwise (and on first fill) preselects
    // the defaultEnvironment setting.
    update(el, ctx) {
      active = isCloud(ctx?.draft);
      el.hidden = !active;
      if (!select) return;
      const settings = (typeof api?.settings === 'function' ? api.settings() : null) || {};
      const opts = environmentOptions(settings);
      const keep = select.value;
      select.replaceChildren(...opts.map(({ value, label }) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        return o;
      }));
      const def = typeof settings.defaultEnvironment === 'string' ? settings.defaultEnvironment.trim() : '';
      const want = populated && opts.some((o) => o.value === keep) ? keep : def;
      select.value = opts.some((o) => o.value === want) ? want : '';
      populated = true;
      syncRef();
    },

    // Hiding the worktree box is presentation only, so the payload has to say
    // `worktree: false` itself, or the hidden checkbox's value would be sent.
    fields() {
      return active ? { worktree: false } : {};
    },

    // This extension's own slice of the dispatch bag, read by the runtime's
    // preflight and buildLaunch. An explicit '' means "Account default".
    ext() {
      if (!active || !select) return undefined;
      return { environmentId: select.value || '', ref: (ref?.value || '').trim() };
    },

    unmount() {
      api = null;
      select = null;
      ref = null;
      refRow = null;
      active = false;
      populated = false;
    },
  };
}

export default {
  register(slots) {
    slots.register('dispatch.field', createDispatchField());
    slots.register('link.chip', { id: 'cloud', chip });
  },
};
