/**
 * License Manager (LICENSING.md 10.2). Plain DOM, no build step.
 * Everything from the server is inserted as text, never as HTML: customer and
 * device names are typed by other people.
 */

const root = document.getElementById('app');
const state = { view: 'licenses', plans: [], user: null, customerFilter: null };

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * `h()` drops the null and false that `cond && node` leaves behind, but
 * `replaceChildren` is the browser's own method and keeps them - on the page
 * they read as the words "null" and "false". Children going straight into the
 * DOM pass through here first.
 */
const shown = (...children) =>
  children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false);

function toast(message, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'X-HRD-LM': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/admin/api/login') {
    state.user = null;
    render();
    throw new Error('Сеанс завершён, войдите снова');
  }
  if (!res.ok) throw Object.assign(new Error(data.message || `Ошибка ${res.status}`), { code: data.error });
  return data;
}

/** Runs an action, reporting failure instead of throwing into the void. */
async function act(work, success) {
  try {
    const result = await work();
    if (success) toast(success);
    return result;
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  }
}

function download(file) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'application/json' }));
  const a = h('a', { href: url, download: file.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const date = value => (value ? new Date(value).toLocaleDateString('ru-RU') : '—');
const dateTime = value => (value ? new Date(value).toLocaleString('ru-RU') : '—');
const badge = value => h('span', { class: `badge ${value}` }, value);
const PLAN = { PERPETUAL: 'Бессрочная', ANNUAL: 'Годовая', QUARTERLY: 'Квартальная', MONTHLY: 'Месячная' };
const MODE = { ONLINE: 'онлайн', OFFLINE: 'офлайн' };
/** Payment sources entered by hand; a webhook's own source is shown as is. */
const PAYMENT_SOURCE = { cash: 'Наличные', bank_transfer: 'Банковский перевод', card: 'Карта', other: 'Другое' };


function table(columns, rows, onRow) {
  return h('table', {},
    h('thead', {}, h('tr', {}, columns.map(c => h('th', {}, c.title)))),
    h('tbody', {}, rows.length
      ? rows.map(row => h('tr', { class: onRow ? 'clickable' : undefined, onclick: onRow ? () => onRow(row) : undefined },
          columns.map(c => h('td', {}, c.value(row)))))
      : h('tr', {}, h('td', { colspan: columns.length, class: 'muted' }, 'Пусто'))));
}

/** A modal form; resolves with the field values, or null if cancelled. */
function ask(title, fields, confirmLabel = 'Сохранить', danger = false) {
  return new Promise(resolve => {
    const inputs = {};
    const dialog = h('dialog', {},
      h('form', { method: 'dialog' },
        h('h2', {}, title),
        fields.map(field => {
          if (field.note) return h('p', { class: 'muted' }, field.note);
          const input = field.options
            ? h('select', { name: field.name }, field.options.map(([value, label]) =>
                h('option', { value, selected: value === field.value }, label)))
            : h('input', { name: field.name, type: field.type ?? 'text', value: field.value ?? '', required: field.required,
                min: field.min, placeholder: field.placeholder });
          inputs[field.name] = input;
          return h('label', {}, field.label, input);
        }),
        h('div', { class: 'row' },
          h('span', { class: 'grow' }),
          h('button', { value: 'cancel', formnovalidate: true }, 'Отмена'),
          h('button', { value: 'ok', class: danger ? 'danger' : 'primary' }, confirmLabel))));
    dialog.addEventListener('close', () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
      dialog.remove();
      resolve(dialog.returnValue === 'ok' ? values : null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function showKey(license, key) {
  const dialog = h('dialog', {},
    h('form', { method: 'dialog' },
      h('h2', {}, `Лицензия ${license.id} создана`),
      h('p', {}, 'Ключ лицензии показывается один раз: на сервере хранится только его хэш. Сохраните его и передайте клиенту.'),
      h('div', { class: 'keybox mono' }, key),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => act(() => navigator.clipboard.writeText(key), 'Ключ скопирован') }, 'Копировать'),
        h('span', { class: 'grow' }),
        h('button', { value: 'ok', class: 'primary' }, 'Я сохранил ключ'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// -------------------------------------------------------------------- login

function loginView() {
  const username = h('input', { autocomplete: 'username', required: true, placeholder: 'owner', spellcheck: 'false' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  // The field wants the six digits the authenticator shows, not the secret
  // that was put into it once - a distinction worth spelling out, because
  // the browser only says "use the required format".
  const code = h('input', {
    inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6,
    required: true, placeholder: '000000', title: 'Шесть цифр из приложения-аутентификатора'
  });
  const form = h('form', {
    class: 'card login',
    onsubmit: async event => {
      event.preventDefault();
      const result = await act(() => api('POST', '/admin/api/login',
        { username: username.value, password: password.value, code: code.value }));
      if (result) {
        state.user = result.username;
        await start();
      }
    }
  },
  h('h1', {}, 'HRDesk License Manager'),
  h('label', {}, 'Имя администратора', username),
  h('label', {}, 'Пароль', password),
  h('label', {}, 'Одноразовый код', code,
    h('span', { class: 'muted' }, 'Шесть цифр из приложения-аутентификатора; меняются каждые 30 секунд')),
  h('button', { class: 'primary' }, 'Войти'));
  return form;
}

// ---------------------------------------------------------------- customers

async function customersView() {
  const customers = await api('GET', '/admin/api/customers');
  const create = async () => {
    const values = await ask('Новый клиент', [
      { name: 'name', label: 'Название', required: true },
      { name: 'contact', label: 'Контактное лицо' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Телефон' }
    ], 'Создать');
    if (values && await act(() => api('POST', '/admin/api/customers', values), 'Клиент создан')) render();
  };
  const edit = async customer => {
    const values = await ask(`Клиент ${customer.id}`, [
      { name: 'name', label: 'Название', value: customer.name, required: true },
      { name: 'contact', label: 'Контактное лицо', value: customer.contact },
      { name: 'email', label: 'Email', value: customer.email, type: 'email' },
      { name: 'phone', label: 'Телефон', value: customer.phone },
      { name: 'status', label: 'Статус', value: customer.status, options: [['ACTIVE', 'Активен'], ['ARCHIVED', 'В архиве']] }
    ]);
    if (values && await act(() => api('PATCH', `/admin/api/customers/${customer.id}`, values), 'Сохранено')) render();
  };

  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Клиенты'), h('button', { class: 'primary', onclick: create }, 'Новый клиент')),
    table([
      { title: 'Клиент', value: c => h('div', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, c.id)) },
      { title: 'Контакт', value: c => [c.contact, c.email && h('div', { class: 'muted' }, c.email), c.phone && h('div', { class: 'muted' }, c.phone)] },
      { title: 'Лицензий', value: c => h('button', { class: 'link', onclick: event => {
        event.stopPropagation();
        state.customerFilter = c;
        go('licenses');
      } }, String(c.licenses)) },
      { title: 'Статус', value: c => badge(c.status) }
    ], customers, edit));
}

// ----------------------------------------------------------------- licences

async function licensesView() {
  const filter = state.customerFilter;
  const licenses = await api('GET', `/admin/api/licenses${filter ? `?customer_id=${encodeURIComponent(filter.id)}` : ''}`);

  const create = async () => {
    const customers = (await api('GET', '/admin/api/customers')).filter(c => c.status === 'ACTIVE');
    if (!customers.length) return toast('Сначала создайте клиента', 'error');
    const values = await ask('Новая лицензия', [
      { name: 'customer_id', label: 'Клиент', value: filter?.id, options: customers.map(c => [c.id, `${c.name} (${c.id})`]) },
      { name: 'plan', label: 'Тариф', options: state.plans.map(p => [p.code, `${PLAN[p.code] ?? p.code} — ${p.allowed_modes.map(m => MODE[m]).join(', ')}`]) },
      { name: 'activation_mode', label: 'Режим', options: [['OFFLINE', 'Офлайн (обмен файлами)'], ['ONLINE', 'Онлайн']] },
      { name: 'seats', label: 'Мест (компьютеров)', type: 'number', value: 1, min: 1 },
      { name: 'start', label: 'Начало оплаченного периода', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'max_version', label: 'Версии HRDesk до (пусто — все)', value: '1.99.99' },
      { name: 'edition', label: 'Редакция', value: 'PRO' },
      { name: 'features', label: 'Модули через запятую (необязательно)' },
      { note: 'Месячный тариф продаётся только онлайн (ТЗ 2.1).' }
    ], 'Создать');
    if (!values) return;
    const body = {
      ...values,
      seats: Number(values.seats),
      features: values.features.split(',').map(s => s.trim()).filter(Boolean),
      start: values.start ? `${values.start}T00:00:00Z` : undefined
    };
    const result = await act(() => api('POST', '/admin/api/licenses', body));
    if (result) {
      showKey(result.license, result.license_key);
      render();
    }
  };

  return h('section', { class: 'card' },
    h('div', { class: 'row' },
      h('h2', { class: 'grow' }, filter ? `Лицензии: ${filter.name}` : 'Лицензии'),
      filter && h('button', { onclick: () => { state.customerFilter = null; render(); } }, 'Все клиенты'),
      h('button', { class: 'primary', onclick: create }, 'Новая лицензия')),
    table([
      { title: 'Номер', value: l => h('span', { class: 'mono' }, l.id) },
      { title: 'Клиент', value: l => l.customer_name },
      { title: 'Тариф', value: l => `${PLAN[l.plan] ?? l.plan}, ${MODE[l.activation_mode]}` },
      { title: 'Места', value: l => `${l.seats_used} из ${l.seats}` },
      { title: 'Оплачено до', value: l => l.paid_until ? date(l.paid_until) : 'бессрочно' },
      { title: 'Статус', value: l => badge(l.status) }
    ], licenses, l => { state.licenseId = l.id; go('license'); }));
}

async function licenseView() {
  const d = await api('GET', `/admin/api/licenses/${encodeURIComponent(state.licenseId)}`);
  const l = d.license;
  const revoked = l.status === 'REVOKED';

  const renew = async () => {
    const values = await ask(`Продление ${l.id}`, [
      { note: `Сейчас оплачено до ${date(l.paid_until)}. Оплата до конца льготного срока продлевает от старой даты, позже — от даты оплаты (ТЗ 5.4).` },
      { name: 'periods', label: `Периодов (${PLAN[l.plan]})`, type: 'number', value: 1, min: 1 },
      { name: 'source', label: 'Способ оплаты', value: 'cash', options: Object.entries(PAYMENT_SOURCE) },
      { name: 'paid_on', label: 'Дата фактической оплаты', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'amount', label: 'Сумма (необязательно)', type: 'number', min: 0 },
      { name: 'currency', label: 'Валюта', value: 'TMT' },
      { name: 'external_id', label: 'Номер квитанции, ордера или платежа (необязательно)' },
      { note: 'Для наличных укажите день, когда деньги получены: от него зависит, продлится ли срок от старой даты или от дня оплаты.' }
    ], 'Продлить');
    if (!values) return;
    const result = await act(() => api('POST', `/admin/api/licenses/${l.id}/renew`, {
      periods: Number(values.periods),
      source: values.source,
      paid_on: `${values.paid_on}T12:00:00Z`,
      amount: values.amount ? Number(values.amount) : null,
      currency: values.currency || null,
      external_id: values.external_id || null
    }), 'Лицензия продлена');
    if (!result) return;
    // 5.3: offline clients get their files right away, no request needed.
    result.files.forEach(download);
    if (result.files.length) toast(`Скачано файлов: ${result.files.length}. Отправьте их клиенту.`);
    render();
  };

  const revoke = async () => {
    const values = await ask(`Отозвать ${l.id}?`, [
      { note: l.activation_mode === 'OFFLINE'
        ? 'Офлайн-файл продолжит работать до окончания оплаченного срока с льготными днями (ТЗ 7.3): отозвать его технически нельзя. Новые файлы выпускаться не будут.'
        : 'Онлайн-клиенты перейдут в режим «только чтение» при ближайшем обновлении.' },
      { name: 'reason', label: 'Причина', required: true }
    ], 'Отозвать', true);
    if (values && await act(() => api('POST', `/admin/api/licenses/${l.id}/revoke`, values), 'Лицензия отозвана')) render();
  };

  const issue = async activation => {
    const file = await act(() => api('POST', `/admin/api/activations/${activation.id}/file`), 'Файл выпущен');
    if (file) { download(file); render(); }
  };
  const clockReset = async activation => {
    const values = await ask('Разблокировка часов', [
      { note: 'Для офлайн-клиента в состоянии «часы переведены назад» (ТЗ 6.3). Отметка времени клиента будет заменена указанной датой.' },
      { name: 'high_water_to', label: 'Новая отметка времени', type: 'date', value: new Date().toISOString().slice(0, 10) }
    ], 'Выпустить .hrdclock');
    if (!values) return;
    const file = await act(() => api('POST', `/admin/api/activations/${activation.id}/clock-reset`,
      { high_water_to: `${values.high_water_to}T00:00:00Z` }), 'Файл разблокировки выпущен');
    if (file) { download(file); render(); }
  };
  const clearFork = async activation => {
    const values = await ask(`Снять подозрение с ${activation.device_name}?`, [
      { note: 'FORK_SUSPECTED ставится, когда счётчик запросов устройства пошёл назад или повторился, либо место слишком часто перепривязывается. Невинные причины: восстановление из резервной копии, откат виртуальной машины. Если клиент это подтвердил, подозрение можно снять.' }
    ], 'Снять подозрение');
    if (values && await act(() => api('POST', `/admin/api/activations/${activation.id}/clear-fork`), 'Подозрение снято')) render();
  };
  const release = async activation => {
    const values = await ask(`Освободить место ${activation.device_name}?`, [
      { note: 'Используйте, когда клиент подтвердил, что больше не работает на этом компьютере. Файл лицензии на нём продолжит действовать до своего срока.' }
    ], 'Освободить', true);
    if (values && await act(() => api('POST', `/admin/api/activations/${activation.id}/release`), 'Место освобождено')) render();
  };

  return [
    h('section', { class: 'card' },
      h('div', { class: 'row' },
        h('button', { onclick: () => go('licenses') }, '← К списку'),
        h('h2', { class: 'grow' }, `Лицензия ${l.id}`),
        !revoked && l.plan !== 'PERPETUAL' && h('button', { class: 'primary', onclick: renew }, 'Продлить'),
        !revoked && h('button', { class: 'danger', onclick: revoke }, 'Отозвать')),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Клиент'), h('dd', {}, `${l.customer_name} (${l.customer_id})`),
        h('dt', {}, 'Статус'), h('dd', {}, badge(l.status)),
        h('dt', {}, 'Тариф'), h('dd', {}, `${PLAN[l.plan]}, ${MODE[l.activation_mode]}, редакция ${l.edition}`),
        h('dt', {}, 'Места'), h('dd', {}, `${d.activations.filter(a => a.status === 'ACTIVE' || a.status === 'FORK_SUSPECTED').length} из ${l.seats}`),
        h('dt', {}, 'Оплачено до'), h('dd', {}, l.paid_until ? `${date(l.paid_until)} + ${l.grace_days} льготных дн.` : 'бессрочно'),
        h('dt', {}, 'Версии HRDesk'), h('dd', {}, l.max_version ? `до ${l.max_version}` : 'все'),
        h('dt', {}, 'Переносы за год'), h('dd', {}, `${d.transfers_last_year} из ${d.plan.max_transfers_per_year}`),
        h('dt', {}, 'Создана'), h('dd', {}, dateTime(l.created_at)))),
    h('section', { class: 'card' },
      h('h2', {}, 'Компьютеры'),
      table([
        { title: 'Компьютер', value: a => h('div', {}, h('strong', {}, a.device_name), h('div', { class: 'muted mono' }, a.id)) },
        { title: 'Статус', value: a => badge(a.status) },
        { title: 'Ревизия', value: a => String(a.current_revision) },
        { title: 'Первая / последняя связь', value: a => [dateTime(a.first_seen), h('div', { class: 'muted' }, dateTime(a.last_seen))] },
        { title: '', value: a => (a.status === 'ACTIVE' || a.status === 'FORK_SUSPECTED') && !revoked
          ? h('div', { class: 'row' },
              a.status === 'FORK_SUSPECTED' && h('button', { onclick: () => clearFork(a) }, 'Снять подозрение'),
              h('button', { onclick: () => issue(a) }, 'Выпустить файл'),
              h('button', { onclick: () => clockReset(a) }, '.hrdclock'),
              h('button', { class: 'danger', onclick: () => release(a) }, 'Освободить'))
          : '' }
      ], d.activations)),
    h('section', { class: 'card' },
      h('h2', {}, 'Выданные файлы'),
      table([
        { title: 'Когда', value: f => dateTime(f.issued_at) },
        { title: 'Вид', value: f => f.kind },
        { title: 'Активация', value: f => h('span', { class: 'mono' }, f.activation_id) },
        { title: 'Ревизия', value: f => String(f.revision) },
        { title: 'Оплачено / действует до', value: f => `${date(f.paid_until)} / ${date(f.lease_until)}` }
      ], d.files)),
    d.transfers.length > 0 && h('section', { class: 'card' },
      h('h2', {}, 'Переносы и освобождения'),
      table([
        { title: 'Когда', value: t => dateTime(t.at) },
        { title: 'С активации', value: t => h('span', { class: 'mono' }, t.from_activation_id) },
        { title: 'На активацию', value: t => t.to_activation_id ?? '—' },
        { title: 'Способ', value: t => t.method === 'proof' ? 'подтверждение устройства' : 'вручную' }
      ], d.transfers)),
    d.payments.length > 0 && h('section', { class: 'card' },
      h('h2', {}, 'Оплаты'),
      table([
        { title: 'Дата оплаты', value: p => date(p.paid_on) },
        { title: 'Период', value: p => `${date(p.period_from)} → ${date(p.period_to)}` },
        { title: 'Сумма', value: p => p.amount === null ? '—' : `${p.amount} ${p.currency ?? ''}` },
        { title: 'Способ', value: p => [PAYMENT_SOURCE[p.source] ?? p.source, p.external_id && h('div', { class: 'muted' }, `№ ${p.external_id}`)] }
      ], d.payments))
  ];
}

// ------------------------------------------------------------ offline files

const ACTION = {
  ACTIVATE_NEW: 'Новая активация: займёт свободное место',
  REISSUE_SAME_DEVICE: 'Это устройство уже активировано: будет выпущен новый файл без занятия места',
  REBIND: 'Повторная привязка того же компьютера (переустановка Windows): не считается переносом',
  TRANSFER: 'Перенос на другой компьютер: старая активация освобождается',
  DEACTIVATE: 'Подтверждение деактивации: место будет освобождено'
};

function offlineView() {
  const output = h('div', { class: 'card', hidden: true });
  let request = null;
  const options = { transfer_from: '', approve_transfer: false, override_transfer_limit: false };

  const inspect = async () => {
    const decision = await act(() => api('POST', '/v1/offline/inspect', { request, ...options }));
    if (decision) showDecision(decision);
  };

  const run = async () => {
    const result = await act(() => api('POST', '/v1/offline/process', { request, ...options }), 'Выполнено');
    if (!result) return;
    if (result.file) download(result.file);
    output.replaceChildren(...shown(
      h('div', { class: 'notice ok' }, result.file
        ? `Файл ${result.file.filename} скачан. Передайте его клиенту.`
        : 'Место освобождено.'),
      result.decision.license && h('p', {}, h('button', { class: 'link', onclick: () => {
        state.licenseId = result.decision.license.id;
        go('license');
      } }, `Открыть лицензию ${result.decision.license.id}`))));
    request = null;
  };

  function showDecision(d) {
    const r = d.request;
    output.hidden = false;
    output.replaceChildren(...shown(
      h('h2', {}, 'Что просит файл'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Тип'), h('dd', {}, r.type),
        h('dt', {}, 'Компьютер'), h('dd', {}, r.device_name),
        h('dt', {}, 'Ключ устройства'), h('dd', { class: 'mono' }, `${r.device_key}…`),
        h('dt', {}, 'Версия HRDesk'), h('dd', {}, r.app_version),
        h('dt', {}, 'Время на компьютере'), h('dd', {}, dateTime(r.client_time)),
        r.license_key_hint && [h('dt', {}, 'Ключ лицензии'), h('dd', { class: 'mono' }, r.license_key_hint)],
        d.license && [h('dt', {}, 'Лицензия'), h('dd', {}, `${d.license.id} — ${d.license.customer_name}, ${PLAN[d.license.plan]}, ${MODE[d.license.activation_mode]}`)],
        d.seats && [h('dt', {}, 'Места'), h('dd', {}, `${d.seats.used} из ${d.seats.total}`)],
        d.fp_match !== null && [h('dt', {}, 'Совпадение отпечатка'), h('dd', {}, `${d.fp_match} из 3`)],
        d.transfers && [h('dt', {}, 'Переносы за год'), h('dd', {}, `${d.transfers.last_year} из ${d.transfers.limit}`)]),
      d.action && h('div', { class: 'notice' }, ACTION[d.action]),
      d.blocked && h('div', { class: 'notice bad' }, d.blocked.message),
      d.transfer_candidates.length > 0 && h('div', {},
        h('h3', {}, 'Перенести с компьютера (старый не работает):'),
        d.transfer_candidates.map(a => h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'from', checked: options.transfer_from === a.id,
            onchange: () => { options.transfer_from = a.id; inspect(); } }),
          `${a.device_name} — последняя связь ${dateTime(a.last_seen)}`))),
      (d.action === 'TRANSFER' || d.needs_approval) && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: options.approve_transfer,
          onchange: event => { options.approve_transfer = event.target.checked; inspect(); } }),
        'Одобряю перенос: клиент подтвердил, что старый компьютер не используется'),
      d.blocked?.code === 'TRANSFER_LIMIT' && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: options.override_transfer_limit,
          onchange: event => { options.override_transfer_limit = event.target.checked; inspect(); } }),
        'Разрешить сверх лимита (будет отмечено в журнале)'),
      h('div', { class: 'row' },
        h('span', { class: 'grow' }),
        h('button', { class: 'primary', disabled: Boolean(d.blocked) || d.needs_approval || !d.action, onclick: run },
          d.action === 'DEACTIVATE' ? 'Освободить место' : 'Выпустить файл лицензии'))));
  }

  const input = h('input', { type: 'file', accept: '.hrdreq,.hrddeact,application/json',
    onchange: async event => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        request = JSON.parse(await file.text());
      } catch {
        toast('Это не файл запроса HRDesk', 'error');
        return;
      }
      Object.assign(options, { transfer_from: '', approve_transfer: false, override_transfer_limit: false });
      await inspect();
      event.target.value = '';
    } });

  return [
    h('section', { class: 'card' },
      h('h2', {}, 'Офлайн-файлы'),
      h('p', { class: 'muted' }, 'Загрузите файл запроса (.hrdreq) или подтверждение деактивации (.hrddeact), полученный от клиента. Сначала будет показано, что он просит; ничего не меняется до подтверждения.'),
      input),
    output
  ];
}

// ----------------------------------------------------------------- payments

function showSecret(name, secret) {
  const url = `${location.origin}/v1/payments/${name}`;
  const dialog = h('dialog', {},
    h('form', { method: 'dialog' },
      h('h2', {}, `Источник «${name}» создан`),
      h('p', {}, 'Секрет подписи показывается один раз. Передайте его вместе с адресом тому, кто настраивает отправку уведомлений (банк, эквайринг, 1С).'),
      h('label', {}, 'Адрес', h('div', { class: 'keybox mono' }, url)),
      h('label', {}, 'Секрет', h('div', { class: 'keybox mono' }, secret)),
      h('p', { class: 'muted' }, 'Формат уведомления и подписи описан в license-server/README.md, раздел «Webhook оплаты».'),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => act(() => navigator.clipboard.writeText(secret), 'Секрет скопирован') }, 'Копировать секрет'),
        h('span', { class: 'grow' }),
        h('button', { value: 'ok', class: 'primary' }, 'Я сохранил секрет'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function paymentsView() {
  const [sources, payments] = await Promise.all([
    api('GET', '/admin/api/webhook-sources'),
    api('GET', '/admin/api/payments')
  ]);
  const openLicense = id => { state.licenseId = id; go('license'); };

  const create = async () => {
    const values = await ask('Новый источник webhook', [
      { note: 'Источник — система, которая сообщает об оплатах: платёжный шлюз, банк, 1С. У каждого свой секрет подписи.' },
      { name: 'name', label: 'Имя (латиница, например bank или kassa)', required: true }
    ], 'Создать');
    if (!values) return;
    const result = await act(() => api('POST', '/admin/api/webhook-sources', { name: values.name.trim().toLowerCase() }));
    if (result) {
      showSecret(result.name, result.secret);
      render();
    }
  };
  const toggle = async source => {
    const next = source.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (next === 'DISABLED') {
      const values = await ask(`Отключить «${source.name}»?`, [
        { note: 'Уведомления от этого источника будут отклоняться. Включить обратно можно в любой момент; секрет не меняется.' }
      ], 'Отключить', true);
      if (!values) return;
    }
    if (await act(() => api('POST', `/admin/api/webhook-sources/${encodeURIComponent(source.name)}/status`, { status: next }),
      next === 'ACTIVE' ? 'Источник включён' : 'Источник отключён')) render();
  };

  return [
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Источники уведомлений об оплате'),
        h('button', { class: 'primary', onclick: create }, 'Новый источник')),
      table([
        { title: 'Имя', value: s => h('span', { class: 'mono' }, s.name) },
        { title: 'Адрес', value: s => h('span', { class: 'mono muted' }, `/v1/payments/${s.name}`) },
        { title: 'Статус', value: s => badge(s.status) },
        { title: 'Последнее уведомление', value: s => dateTime(s.last_used) },
        { title: '', value: s => h('button', { class: s.status === 'ACTIVE' ? 'danger' : undefined, onclick: () => toggle(s) },
          s.status === 'ACTIVE' ? 'Отключить' : 'Включить') }
      ], sources)),
    h('section', { class: 'card' },
      h('h2', {}, 'Оплаты'),
      table([
        { title: 'Дата оплаты', value: p => date(p.paid_on) },
        { title: 'Клиент', value: p => p.customer_name },
        { title: 'Лицензия', value: p => h('button', { class: 'link', onclick: () => openLicense(p.license_id) }, p.license_id) },
        { title: 'Сумма', value: p => p.amount === null ? '—' : `${p.amount} ${p.currency ?? ''}` },
        { title: 'Способ', value: p => [PAYMENT_SOURCE[p.source] ?? p.source, p.external_id && h('div', { class: 'muted' }, `№ ${p.external_id}`)] },
        { title: 'Продлено', value: p => `${date(p.period_from)} → ${date(p.period_to)}` },
        { title: '', value: p => p.activation_mode === 'OFFLINE' && p.source.startsWith('webhook:')
          ? h('button', { class: 'link', onclick: () => openLicense(p.license_id) }, 'выпустить файлы')
          : '' }
      ], payments))
  ];
}

// ------------------------------------------------------------------- events

async function eventsView() {
  const [suspicious, events] = await Promise.all([
    api('GET', '/admin/api/suspicious'),
    api('GET', `/admin/api/events${state.eventsWarnings ? '?severity=warning' : ''}`)
  ]);
  const openLicense = id => { state.licenseId = id; go('license'); };

  return [
    h('section', { class: 'card' },
      h('h2', {}, 'Подозрительное'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Ошибки подписи за 90 дней'), h('dd', {}, String(suspicious.signature_failures_90d)),
        h('dt', {}, 'Возможные клоны (FORK_SUSPECTED)'), h('dd', {}, String(suspicious.fork_suspected.length)),
        h('dt', {}, 'Лицензии с исчерпанным лимитом переносов'), h('dd', {}, String(suspicious.heavy_transfers.length))),
      suspicious.heavy_transfers.length > 0 && table([
        { title: 'Лицензия', value: t => h('button', { class: 'link', onclick: () => openLicense(t.license_id) }, t.license_id) },
        { title: 'Клиент', value: t => t.customer_name },
        { title: 'Переносов за год', value: t => `${t.transfers} (лимит ${t.limit_per_year})` }
      ], suspicious.heavy_transfers),
      suspicious.fork_suspected.length > 0 && table([
        { title: 'Активация', value: a => a.id },
        { title: 'Компьютер', value: a => a.device_name },
        { title: 'Лицензия', value: a => h('button', { class: 'link', onclick: () => openLicense(a.license_id) }, a.license_id) }
      ], suspicious.fork_suspected)),
    h('section', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { class: 'grow' }, 'Журнал'),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: Boolean(state.eventsWarnings),
            onchange: event => { state.eventsWarnings = event.target.checked; render(); } }),
          'Только предупреждения')),
      table([
        { title: 'Когда', value: e => dateTime(e.at) },
        { title: 'Кто', value: e => e.actor },
        { title: 'Событие', value: e => [badge(e.severity), ' ', e.action] },
        { title: 'Лицензия', value: e => e.license_id ? h('button', { class: 'link', onclick: () => openLicense(e.license_id) }, e.license_id) : '' },
        { title: 'Подробности', value: e => h('span', { class: 'mono muted' }, e.details === '{}' ? '' : e.details) }
      ], events))
  ];
}

// ------------------------------------------------------------------- layout

const VIEWS = {
  licenses: ['Лицензии', licensesView],
  customers: ['Клиенты', customersView],
  offline: ['Офлайн-файлы', offlineView],
  payments: ['Платежи', paymentsView],
  events: ['События', eventsView],
  license: [null, licenseView]
};

function go(view) {
  state.view = view;
  render();
}

async function render() {
  if (!state.user) {
    root.replaceChildren(loginView());
    return;
  }
  const main = h('main', {}, h('p', { class: 'muted' }, 'Загрузка…'));
  const current = state.view === 'license' ? 'licenses' : state.view;
  root.replaceChildren(
    h('header', {},
      h('h1', {}, 'HRDesk License Manager'),
      h('nav', {}, Object.entries(VIEWS).filter(([, [title]]) => title).map(([key, [title]]) =>
        h('button', { class: key === current ? 'active' : undefined, onclick: () => go(key) }, title))),
      h('span', { class: 'muted' }, state.user),
      h('button', { onclick: async () => {
        await act(() => api('POST', '/admin/api/logout'));
        state.user = null;
        render();
      } }, 'Выйти')),
    main);
  try {
    const content = await VIEWS[state.view][1]();
    main.replaceChildren(...[content].flat().filter(Boolean));
  } catch (error) {
    main.replaceChildren(h('div', { class: 'notice bad' }, error.message));
  }
}

async function start() {
  state.plans = await api('GET', '/admin/api/plans');
  render();
}

api('GET', '/admin/api/me')
  .then(me => { state.user = me.username; return start(); })
  .catch(() => render());
