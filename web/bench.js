'use strict';

/**
 * BOUNDARY benchmark view: read-only renderer over the persisted artifact.
 *
 * Source of truth: GET ./bench/sprint-report.json. This script:
 *  - executes nothing: no benchmark run, no model call, no sandbox, no write;
 *  - invents nothing: a missing field is printed as "not recorded", a missing
 *    event as "not applicable" together with the reason the artifact gives;
 *  - inserts every artifact string with textContent, never as markup.
 */
(() => {
  const ARTIFACT_URL = './bench/sprint-report.json';
  const NOT_RECORDED = 'not recorded';
  const NOT_APPLICABLE = 'not applicable';
  const ARM_NAMES = {
    B: 'Autonomous recovery',
    D: 'Fixed guidance',
    E: 'Contextual Lifeguard',
  };
  const DETAIL_LIMIT = 700;
  const QUOTE_LIMIT = 4000;
  const ARG_LIMIT = 120;

  const view = {
    report: null,
    scenario: null,
    arm: null,
    rep: null,
    note: null,
    loadedAt: null,
  };

  const requested = readRequest();

  /* ------------------------------------------------------------- DOM utils */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs !== null && attrs !== undefined) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return node;
    if (Array.isArray(children)) {
      for (const child of children) append(node, child);
      return node;
    }
    node.append(children instanceof Node ? children : document.createTextNode(String(children)));
    return node;
  }

  function clear(node) {
    node.replaceChildren();
  }

  function mount(node, children) {
    clear(node);
    append(node, children);
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function has(value) {
    return value !== null && value !== undefined;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  const numberFormat = new Intl.NumberFormat('en-US');

  function fmtNum(value) {
    return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : NOT_RECORDED;
  }

  function fmtText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return NOT_RECORDED;
  }

  function fmtBool(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return NOT_RECORDED;
  }

  function fmtExit(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (value === null) return `${NOT_RECORDED} (null)`;
    return NOT_RECORDED;
  }

  function fmtMs(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${numberFormat.format(value)} ms` : NOT_RECORDED;
  }

  function sumFinite(values) {
    let total = 0;
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      total += value;
    }
    return total;
  }

  function truncate(text, limit) {
    const value = String(text);
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }

  function mono(text) {
    return el('code', {}, String(text));
  }

  function badge(text, tone, withDot) {
    return el('span', { class: `badge badge--${tone}${withDot ? ' badge--dot' : ''}` }, String(text));
  }

  function kv(rows) {
    const list = el('dl', { class: 'kv' });
    for (const row of rows) {
      list.append(el('dt', {}, row[0]));
      list.append(el('dd', {}, row[1]));
    }
    return list;
  }

  function stateBlock(title, detail) {
    return el('div', { class: 'state' }, [el('strong', {}, title), detail ? el('span', {}, ` ${detail}`) : null]);
  }

  function sectionNote(text) {
    return el('p', { class: 'prose prose--muted' }, text);
  }

  function details(summaryText, content) {
    return el('details', { class: 'details' }, [el('summary', {}, summaryText), content]);
  }

  function pre(text, lang) {
    return el('pre', lang ? { lang } : null, String(text));
  }

  /* ------------------------------------------------------------ data access */

  function readRequest() {
    const params = new URLSearchParams(window.location.search);
    return {
      scenario: params.get('scenario'),
      arm: params.get('arm'),
      rep: params.get('rep'),
    };
  }

  function scenarios() {
    const list = view.report && isObject(view.report.manifest) ? view.report.manifest.scenarios : null;
    return Array.isArray(list) ? list.filter(isObject) : [];
  }

  function scenarioById(id) {
    return scenarios().find((scenario) => String(scenario.id) === String(id)) ?? null;
  }

  function armList() {
    const declared = view.report && isObject(view.report.manifest) ? view.report.manifest.arms : null;
    const fromManifest = Array.isArray(declared) ? declared.map(String) : [];
    if (fromManifest.length > 0) return fromManifest;
    const seen = [];
    for (const session of sessions()) {
      if (!seen.includes(String(session.arm))) seen.push(String(session.arm));
    }
    return seen;
  }

  function sessions() {
    const list = view.report ? view.report.sessions : null;
    return Array.isArray(list) ? list.filter(isObject) : [];
  }

  function sessionsFor(scenarioId, arm) {
    return sessions().filter(
      (session) => String(session.scenarioId) === String(scenarioId) && String(session.arm) === String(arm),
    );
  }

  function sessionsForArm(arm) {
    return sessions().filter((session) => String(session.arm) === String(arm));
  }

  function sessionFor(scenarioId, arm, rep) {
    return (
      sessions().find(
        (session) =>
          String(session.scenarioId) === String(scenarioId) &&
          String(session.arm) === String(arm) &&
          Number(session.repetition) === Number(rep),
      ) ?? null
    );
  }

  function currentSession() {
    if (view.scenario === null || view.arm === null || view.rep === null) return null;
    return sessionFor(view.scenario, view.arm, view.rep);
  }

  function observationsOf(session) {
    return session && Array.isArray(session.observations) ? session.observations.filter(isObject) : [];
  }

  function interventionsOf(session) {
    return session && Array.isArray(session.interventions) ? session.interventions.filter(isObject) : [];
  }

  function metricsForArm(arm) {
    const list = view.report && isObject(view.report.matrix) && Array.isArray(view.report.matrix.byArm)
      ? view.report.matrix.byArm.find((entry) => isObject(entry) && String(entry.arm) === String(arm)) ?? null
      : null;
    const cost = view.report && isObject(view.report.cost) && Array.isArray(view.report.cost.byArm)
      ? view.report.cost.byArm.find((entry) => isObject(entry) && String(entry.arm) === String(arm)) ?? null
      : null;
    return { metrics: list, cost };
  }

  function functionalCountForArm(arm) {
    const list = sessionsForArm(arm);
    if (list.length === 0) return null;
    return list.filter((session) => session.state === 'functional').length;
  }

  function denialsOf(session) {
    if (!session) return null;
    if (isObject(session.tally)) {
      const denied = typeof session.tally.denied === 'number' && Number.isFinite(session.tally.denied) ? session.tally.denied : null;
      const blocked = typeof session.tally.blocked === 'number' && Number.isFinite(session.tally.blocked) ? session.tally.blocked : null;
      if (denied !== null || blocked !== null) return (denied ?? 0) + (blocked ?? 0);
    }
    const observations = observationsOf(session);
    if (observations.length === 0) return null;
    return observations.filter((item) => item.outcome === 'denied' || item.outcome === 'blocked').length;
  }

  function totalDenials() {
    const list = sessions();
    if (list.length === 0) return null;
    let total = 0;
    for (const session of list) {
      const value = denialsOf(session);
      if (value === null) return null;
      total += value;
    }
    return total;
  }

  function receivedCount() {
    const list = sessions();
    if (list.length === 0) return null;
    return list.filter((session) => session.received === true).length;
  }

  function resumedCount() {
    const list = sessions();
    if (list.length === 0) return null;
    return list.filter((session) => session.resumed === true).length;
  }

  function resolvedCount() {
    const list = sessions();
    if (list.length === 0) return null;
    return list.filter((session) => session.resolved === true).length;
  }

  function repetitionsFor(scenarioId, arm) {
    const scope = sessionsFor(scenarioId, arm);
    const source = scope.length > 0 ? scope : sessions().filter((session) => String(session.scenarioId) === String(scenarioId));
    const seen = new Set();
    for (const session of source) {
      const rep = Number(session.repetition);
      if (Number.isInteger(rep)) seen.add(rep);
    }
    return [...seen].sort((a, b) => a - b);
  }

  /* ------------------------------------------------------------- validation */

  function validate(data) {
    if (!isObject(data)) return 'the response body is not a JSON object';
    if (typeof data.generatedAt !== 'string') return 'generatedAt is missing or is not text';
    if (!isObject(data.manifest)) return 'manifest is missing';
    if (!Array.isArray(data.manifest.scenarios) || data.manifest.scenarios.length === 0) {
      return 'manifest.scenarios is empty or is not a list';
    }
    if (!isObject(data.matrix) || !Array.isArray(data.matrix.cells)) return 'matrix.cells is missing';
    if (!isObject(data.verdict)) return 'verdict is missing';
    if (typeof data.verdict.code !== 'string') return 'verdict.code is not text';
    if (!Array.isArray(data.verdict.reasons)) return 'verdict.reasons is not a list';
    return null;
  }

  /* ------------------------------------------------------------ url syncing */

  function syncUrl() {
    const params = new URLSearchParams();
    if (view.scenario !== null) params.set('scenario', view.scenario);
    if (view.arm !== null) params.set('arm', view.arm);
    if (view.rep !== null) params.set('rep', String(view.rep));
    const search = params.toString();
    const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }

  /* -------------------------------------------------------------- selection */

  function initialiseSelection() {
    const ids = scenarios().map((scenario) => String(scenario.id));
    const arms = armList();
    const notes = [];

    let scenario = ids[0] ?? null;
    if (requested.scenario !== null) {
      if (ids.includes(requested.scenario)) scenario = requested.scenario;
      else if (ids.length > 0) notes.push(`The link asked for scenario ${requested.scenario}, which is not in the artifact. Showing ${scenario}.`);
    }

    let arm = arms[0] ?? null;
    if (requested.arm !== null) {
      if (arms.includes(requested.arm)) arm = requested.arm;
      else if (arms.length > 0) notes.push(`The link asked for arm ${requested.arm}, which is not in the artifact. Showing ${arm}.`);
    }

    const reps = scenario !== null && arm !== null ? repetitionsFor(scenario, arm) : [];
    let rep = reps[0] ?? null;
    if (requested.rep !== null) {
      const wanted = Number(requested.rep);
      if (Number.isInteger(wanted) && reps.includes(wanted)) {
        rep = wanted;
      } else if (reps.length > 0 && Number.isFinite(wanted)) {
        notes.push(
          `The link asked for repetition ${requested.rep}; the artifact records only repetition ${reps.join(', ')}. Showing repetition ${rep}.`,
        );
      } else if (reps.length === 0) {
        notes.push('The artifact records no repetition number for this combination.');
      }
    }

    view.scenario = scenario;
    view.arm = arm;
    view.rep = rep;
    view.note = notes.length > 0 ? notes.join(' ') : null;
  }

  /* --------------------------------------------------------------- statuses */

  let loadingTimer = 0;

  function setLoading(active) {
    const node = byId('loading');
    if (active) {
      loadingTimer = window.setTimeout(() => {
        node.hidden = false;
      }, 400);
    } else {
      window.clearTimeout(loadingTimer);
      node.hidden = true;
    }
  }

  function showError(message) {
    const node = byId('error');
    node.replaceChildren();
    node.append(el('span', {}, message));
    node.append(document.createTextNode(' '));
    node.append(el('a', { href: ARTIFACT_URL }, 'Retry the read'));
    node.append(document.createTextNode(' or reload the page.'));
    node.hidden = false;
  }

  function hideError() {
    const node = byId('error');
    node.hidden = true;
    node.replaceChildren();
  }

  /* ------------------------------------------------------------------- load */

  async function load() {
    setLoading(true);
    hideError();

    let response;
    try {
      response = await fetch(ARTIFACT_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    } catch (error) {
      settleLoading();
      showError(`Could not read GET ${ARTIFACT_URL}: ${error instanceof Error ? error.message : String(error)}.`);
      return;
    }

    if (!response.ok) {
      settleLoading();
      showError(`Could not read GET ${ARTIFACT_URL}: the server answered ${response.status} ${response.statusText}.`);
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      settleLoading();
      showError(`Could not read GET ${ARTIFACT_URL}: the body is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
      return;
    }

    const problem = validate(data);
    if (problem !== null) {
      settleLoading();
      showError(`Could not read GET ${ARTIFACT_URL}: the artifact does not have the expected shape, ${problem}.`);
      return;
    }

    settleLoading();
    view.report = data;
    view.loadedAt = new Date();
    initialiseSelection();
    renderAll();
    syncUrl();
  }

  function settleLoading() {
    setLoading(false);
    byId('content').hidden = false;
  }

  /* ------------------------------------------------------------------ hero */

  function renderHero() {
    const host = byId('hero-status');
    const list = sessions();
    const arms = armList();

    if (list.length === 0) {
      mount(host, [mono('sessions'), ' is empty in this artifact, so no run can be counted.']);
      return;
    }

    const functional = arms
      .map((arm) => `${arm} ${functionalCountForArm(arm) === null ? NOT_RECORDED : `${functionalCountForArm(arm)}/${sessionsForArm(arm).length}`}`)
      .join(' · ');
    const denials = totalDenials();

    mount(host, [
      `${list.length} runs · ${scenarios().length} scenarios · ${arms.length} arms · functional ${functional} · policy denials ${denials === null ? NOT_RECORDED : fmtNum(denials)}.`,
    ]);
  }

  /* --------------------------------------------------------------- verdict */

  function renderVerdict() {
    const host = byId('verdict');
    const verdict = isObject(view.report.verdict) ? view.report.verdict : null;
    if (verdict === null) {
      mount(host, stateBlock(`${NOT_RECORDED}.`, 'The artifact carries no verdict object.'));
      return;
    }

    const tone =
      verdict.code === 'CONTINUE' ? 'ok'
        : verdict.code === 'ABANDON' ? 'danger'
          : verdict.code === 'INCONCLUSIVE' ? 'warn'
            : 'neutral';
    const thresholds = isObject(view.report.preregisteredThresholds) ? view.report.preregisteredThresholds : null;
    const minimum = thresholds && typeof thresholds.minimumRepetitions === 'number' ? thresholds.minimumRepetitions : null;
    const reps = isObject(view.report.manifest) ? view.report.manifest.reps : null;

    const head = el('div', { class: 'verdict__head' }, [
      el('span', { class: 'verdict__code' }, verdict.code),
      badge(
        minimum !== null && typeof reps === 'number' ? `${reps} of ${minimum} repetitions` : 'preregistered',
        tone,
      ),
      badge(`wins ${fmtNum(verdict.wins)}`, 'neutral'),
    ]);

    const reasons = Array.isArray(verdict.reasons) && verdict.reasons.length > 0
      ? el('ul', { class: 'prose' }, verdict.reasons.map((reason) => el('li', {}, fmtText(reason))))
      : el('p', { class: 'prose prose--muted' }, `${NOT_RECORDED}: verdict.reasons is empty in the artifact.`);

    mount(host, [
      head,
      Array.isArray(verdict.reasons) && verdict.reasons.length > 0
        ? el('p', { class: 'prose prose--muted' }, 'Reason recorded in the artifact:')
        : null,
      reasons,
    ]);
  }

  /* ---------------------------------------------------------------- global */

  function renderGlobal() {
    const host = byId('global');
    const arms = armList();
    if (arms.length === 0) {
      mount(host, stateBlock(`${NOT_RECORDED}.`, 'The artifact declares no arms.'));
      return;
    }

    const body = el('tbody');
    for (const arm of arms) {
      const { metrics, cost } = metricsForArm(arm);
      const list = sessionsForArm(arm);
      const functional = functionalCountForArm(arm);
      const guardTokens = cost && typeof cost.guardTokens === 'number' ? cost.guardTokens : null;
      const latency = cost && typeof cost.latencyMs === 'number' ? cost.latencyMs : null;

      body.append(
        el('tr', {}, [
          el('th', { scope: 'row' }, [
            el('span', { class: 'arm-chip' }, arm),
            el('span', { class: 'cell-note' }, ARM_NAMES[arm] ?? `${NOT_RECORDED} name`),
          ]),
          el('td', { class: 'num' }, fmtNum(metrics && typeof metrics.runs === 'number' ? metrics.runs : list.length)),
          el('td', { class: 'num' }, functional === null ? NOT_RECORDED : `${functional} of ${list.length}`),
          el('td', { class: 'num' }, fmtNum(metrics ? metrics.received : null)),
          el('td', { class: 'num' }, fmtNum(metrics ? metrics.resumed : null)),
          el('td', { class: 'num' }, fmtNum(metrics ? metrics.resolved : null)),
          el('td', { class: 'num' }, fmtNum(guardTokens)),
          el('td', { class: 'num' }, fmtMs(latency)),
        ]),
      );
    }

    const table = el('table', { class: 'table table--compare' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col' }, 'Arm'),
        el('th', { scope: 'col', class: 'num' }, 'Runs'),
        el('th', { scope: 'col', class: 'num' }, 'Functional'),
        el('th', { scope: 'col', class: 'num' }, 'Received'),
        el('th', { scope: 'col', class: 'num' }, 'Resumed'),
        el('th', { scope: 'col', class: 'num' }, 'Resolved'),
        el('th', { scope: 'col', class: 'num' }, 'Guard tokens'),
        el('th', { scope: 'col', class: 'num' }, 'Latency'),
      ])),
      body,
    ]);

    mount(host, [
      el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Result by arm' }, table),
    ]);
  }

  /* -------------------------------------------------------------- picker */

  function optionLabelArm(arm) {
    return ARM_NAMES[arm] ? `${arm}, ${ARM_NAMES[arm]}` : arm;
  }

  function renderPicker() {
    const host = byId('picker');
    const note = byId('link-note');
    const fields = host.querySelectorAll('.field');
    for (const field of fields) field.remove();

    if (view.scenario === null || view.arm === null) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    const scenarioField = buildSelect(
      'pick-scenario',
      'Scenario',
      scenarios().map((scenario) => ({ value: String(scenario.id), label: String(scenario.id) })),
      view.scenario,
      (value) => {
        view.scenario = value;
        const reps = repetitionsFor(value, view.arm);
        view.rep = reps[0] ?? null;
        view.note = null;
        renderAll();
        syncUrl();
      },
    );

    const armField = buildSelect(
      'pick-arm',
      'Arm',
      armList().map((arm) => ({ value: arm, label: optionLabelArm(arm) })),
      view.arm,
      (value) => {
        view.arm = value;
        const reps = repetitionsFor(view.scenario, value);
        if (!reps.includes(Number(view.rep))) view.rep = reps[0] ?? null;
        view.note = null;
        renderAll();
        syncUrl();
      },
    );

    const reps = repetitionsFor(view.scenario, view.arm);
    const repField = buildSelect(
      'pick-rep',
      'Repetition',
      reps.length > 0
        ? reps.map((rep) => ({ value: String(rep), label: `Repetition ${rep}` }))
        : [{ value: '', label: NOT_RECORDED }],
      view.rep === null ? '' : String(view.rep),
      (value) => {
        view.rep = value === '' ? null : Number(value);
        view.note = null;
        renderAll();
        syncUrl();
      },
    );

    host.prepend(repField, armField, scenarioField);

    const banner = byId('link-banner');
    if (view.note) {
      banner.textContent = view.note;
      banner.hidden = false;
    } else {
      banner.textContent = '';
      banner.hidden = true;
    }

    note.textContent = `Showing ${view.scenario}, arm ${view.arm}, repetition ${view.rep === null ? NOT_RECORDED : view.rep}. The address bar carries this selection and can be shared.`;
  }

  function buildSelect(id, labelText, options, selected, onChange) {
    const select = el('select', { id, class: 'field__select' });
    for (const option of options) {
      const node = el('option', { value: option.value }, option.label);
      if (String(option.value) === String(selected)) node.selected = true;
      select.append(node);
    }
    select.addEventListener('change', () => onChange(select.value));
    return el('div', { class: 'field' }, [el('label', { class: 'field__label', for: id }, labelText), select]);
  }

  /* ---------------------------------------------------------- session head */

  function renderSessionMeta() {
    const host = byId('session-meta');
    const session = currentSession();

    if (view.scenario === null) {
      mount(host, stateBlock(`${NOT_RECORDED}.`, 'The artifact declares no scenario, so no run can be selected.'));
      return;
    }

    if (session === null) {
      mount(host, [
        stateBlock(
          `${NOT_APPLICABLE}.`,
          `No row in sessions has scenarioId ${view.scenario}, arm ${view.arm} and repetition ${view.rep === null ? NOT_RECORDED : view.rep}. That run was not measured in this artifact.`,
        ),
      ]);
      return;
    }

    const resolvedTone = session.resolved === true ? 'ok' : session.resolved === false ? 'danger' : 'neutral';
    const stateTone = session.state === 'functional' ? 'ok' : session.state === 'blocked' ? 'warn' : 'neutral';

    mount(host, [
      el('div', { class: 'band' }, [
        el('span', { class: 'arm-chip' }, String(session.arm)),
        el('span', { class: 'band__text' }, [
          el('strong', {}, `${view.scenario} · run ${fmtNum(session.repetition)}`),
          ` ${ARM_NAMES[String(session.arm)] ?? NOT_RECORDED}`,
        ]),
        badge(`state ${fmtText(session.state)}`, stateTone),
        badge(session.resolved === true ? 'resolved' : session.resolved === false ? 'not resolved' : `resolved ${NOT_RECORDED}`, resolvedTone, true),
      ]),
    ]);
  }

  /* ---------------------------------------------------------------- worker */

  function runLengths(observations) {
    const runs = [];
    let current = null;
    for (const observation of observations) {
      const tool = fmtText(observation.tool);
      if (current !== null && current.tool === tool) current.count += 1;
      else {
        current = { tool, count: 1 };
        runs.push(current);
      }
    }
    return runs.filter((run) => run.count > 1);
  }

  function summariseArgs(args) {
    if (!isObject(args)) return fmtText(args);
    const keys = Object.keys(args);
    if (keys.length === 0) return '{}';
    return keys
      .map((key) => {
        const value = args[key];
        if (typeof value === 'string') {
          const shown = value.length > ARG_LIMIT ? `${value.slice(0, ARG_LIMIT)}… (${numberFormat.format(value.length)} chars)` : value;
          return `${key}="${shown}"`;
        }
        if (value !== null && typeof value === 'object') {
          const serialised = JSON.stringify(value);
          return `${key}=${truncate(serialised, ARG_LIMIT)}`;
        }
        return `${key}=${String(value)}`;
      })
      .join(' ');
  }

  function renderWorker() {
    const host = byId('block-worker');
    const session = currentSession();
    if (session === null) {
      mount(host, stateBlock(`${NOT_APPLICABLE}.`, 'No run is selected, so there are no observations to show.'));
      return;
    }

    const observations = observationsOf(session);
    if (observations.length === 0) {
      mount(host, [
        stateBlock(`${NOT_RECORDED}.`, 'sessions[].observations is empty for this run.'),
        sectionNote('An empty list is not rendered as a successful run.'),
      ]);
      return;
    }

    const counts = new Map();
    for (const observation of observations) {
      const outcome = fmtText(observation.outcome);
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(', ');

    const parts = [
      el('p', { class: 'prose prose--muted' }, `${observations.length} observations: ${summary}.`),
    ];

    const repeats = runLengths(observations);
    if (repeats.length > 0) {
      parts.push(
        el('p', { class: 'prose prose--muted' }, [
          'Repeated consecutive tool calls, counted from observations[].tool: ',
          ...repeats.flatMap((run, index) => [
            index > 0 ? ', ' : '',
            mono(run.tool),
            ` ×${run.count}`,
          ]),
          '. The artifact has no dedicated retry field.',
        ]),
      );
    }

    const list = el('div', { class: 'stack stack--tight' });
    for (const [index, observation] of observations.entries()) {
      const outcome = fmtText(observation.outcome);
      const tone = outcome === 'allowed' ? 'ok' : outcome === 'denied' || outcome === 'blocked' ? 'danger' : outcome === 'failed' ? 'warn' : 'neutral';
      const detail = fmtText(observation.detail);
      const head = el('div', { class: 'obs__head' }, [
        el('span', { class: 'obs__tool' }, fmtText(observation.tool)),
        badge(outcome, tone),
        el('span', { class: 'cell-note' }, `observation ${index + 1} of ${observations.length}`),
        has(observation.planStepId) ? el('span', { class: 'cell-note' }, ['planStepId ', mono(observation.planStepId)]) : null,
      ]);

      const argsText = summariseArgs(observation.args);
      const body = [head, el('p', { class: 'obs__args' }, `args: ${argsText}`)];

      if (detail.length > 0) {
        body.push(el('p', { class: 'obs__detail' }, detail));
        body.push(
          details(
            'Full detail and args',
            el('div', { class: 'stack stack--tight' }, [pre(detail), pre(JSON.stringify(observation.args, null, 2))]),
          ),
        );
      } else {
        body.push(el('p', { class: 'obs__detail' }, `${NOT_RECORDED}: detail is an empty string for this observation.`));
      }
      list.append(el('div', { class: 'obs' }, body));
    }

    parts.push(
      el(
        'div',
        { class: 'obs-scroll', tabindex: '0', role: 'region', 'aria-label': `Observations of ${view.scenario}, arm ${view.arm}` },
        list,
      ),
    );
    parts.push(
      el('p', { class: 'block-card__foot' }, 'Arguments and details are abbreviated here to two lines; each row opens the full strings as recorded. The artifact has no dedicated retry field.'),
    );

    mount(host, parts);
  }

  /* ------------------------------------------------------------- lifeguard */

  function renderLifeguard() {
    const host = byId('block-lifeguard');
    const session = currentSession();
    if (session === null) {
      mount(host, stateBlock(`${NOT_APPLICABLE}.`, 'No run is selected, so there is no detection or intervention to show.'));
      return;
    }

    const interventions = interventionsOf(session);
    const first = interventions[0] ?? null;
    const stall = first && isObject(first.stall) ? first.stall : null;
    const flag = (name, tone) => badge(`${name} ${fmtBool(session[name])}`, session[name] === true ? tone : 'neutral');

    const parts = [
      el('div', { class: 'badge-row' }, [
        flag('detected', 'detected'),
        flag('received', 'received'),
        flag('resumed', 'resumed'),
        badge(`${interventions.length} intervention${interventions.length === 1 ? '' : 's'}`, 'info'),
      ]),
    ];

    if (session.detected !== true) {
      parts.push(
        el('p', { class: 'prose prose--muted' }, session.withheld
          ? ['Not detected. ', el('span', { lang: 'es' }, String(session.withheld)), '.']
          : `Not detected; withheld is ${NOT_RECORDED}.`),
      );
    } else if (stall === null) {
      parts.push(stateBlock(`${NOT_RECORDED}.`, 'detected is true but no interventions[].stall object is present.'));
    } else {
      parts.push(
        el('p', { class: 'prose prose--muted' }, [
          'Stall: ', mono(fmtText(stall.kind)), ' in ', mono(fmtText(stall.tool)),
          `, attempt ${fmtNum(stall.attempt)}, ${fmtNum(stall.repeats)} repeat(s).`,
        ]),
        stall.stalledBecause ? el('p', { class: 'prose' }, fmtText(stall.stalledBecause)) : null,
      );
    }

    if (interventions.length === 0) {
      parts.push(
        stateBlock(
          'No intervention was sent in this session.',
          session.withheld
            ? `withheld: ${String(session.withheld)}`
            : `withheld is ${NOT_RECORDED}; the artifact gives no reason.`,
        ),
      );
    } else {
      for (const [index, intervention] of interventions.entries()) {
        const text = typeof intervention.text === 'string' ? intervention.text : '';
        const refs = Array.isArray(intervention.evidenceRefs) ? intervention.evidenceRefs : [];
        parts.push(
          el('div', { class: 'intervention stack stack--tight' }, [
            el('div', { class: 'badge-row' }, [
              el('strong', {}, `Intervention ${index + 1}`),
              badge(`kind ${fmtText(intervention.kind)}`, 'sent'),
              badge(`sent ${fmtBool(intervention.sent)}`, intervention.sent === true ? 'sent' : 'neutral'),
              badge(`resumed ${fmtBool(intervention.resumed)}`, intervention.resumed === true ? 'resumed' : 'neutral'),
            ]),
            text.length > 0
              ? el('p', { class: 'quote', lang: 'es' }, truncate(text, QUOTE_LIMIT))
              : el('p', { class: 'prose prose--muted' }, 'text is an empty string in the artifact for this intervention.'),
            intervention.resumedReason ? kv([['Resume reason', fmtText(intervention.resumedReason)]]) : null,
            refs.length === 0
              ? null
              : details(`evidenceRefs (${refs.length})`, el('ul', { class: 'evidence-list' }, refs.map((ref) => el('li', {}, fmtText(ref))))),
          ]),
        );
      }
    }

    if (interventions.length > 0 && session.withheld) {
      parts.push(
        sectionNote(['withheld also carries a value in this run: ', el('span', { lang: 'es' }, String(session.withheld)), '.']),
      );
    }

    mount(host, parts);
  }

  /* ---------------------------------------------------------------- gateway */

  function renderGateway() {
    const host = byId('block-gateway');
    const session = currentSession();
    if (session === null) {
      mount(host, stateBlock(`${NOT_APPLICABLE}.`, 'No run is selected, so there is no gateway result to show.'));
      return;
    }

    const observations = observationsOf(session);
    const refused = observations.filter((item) => item.outcome === 'denied' || item.outcome === 'blocked');
    const tally = isObject(session.tally) ? session.tally : null;
    const denied = tally && typeof tally.denied === 'number' ? tally.denied : null;
    const blocked = tally && typeof tally.blocked === 'number' ? tally.blocked : null;

    if (refused.length === 0) {
      mount(host, [
        stateBlock('No policy denial or block was recorded in this session.', 'The gateway did not refuse a tool call in this run.'),
        kv([
          ['Denied', denied === null ? NOT_RECORDED : String(denied)],
          ['Blocked', blocked === null ? NOT_RECORDED : String(blocked)],
          ['Observations', String(observations.length)],
          ]),
      ]);
      return;
    }

    const rows = refused.map((observation) => ({
      cells: [
        el('span', { class: 'cell-mono' }, fmtText(observation.tool)),
        el('span', { class: 'cell-mono' }, summariseArgs(observation.args)),
        badge(fmtText(observation.outcome), 'danger'),
        el('span', { class: 'cell-mono' }, truncate(fmtText(observation.detail), DETAIL_LIMIT)),
      ],
    }));

    const table = el('table', { class: 'table table--wide' }, [
      el('caption', {}, `Refusals recorded in this run: ${refused.length}. Source: sessions[].observations.`),
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col' }, 'Tool'),
        el('th', { scope: 'col' }, 'Args'),
        el('th', { scope: 'col' }, 'Outcome'),
        el('th', { scope: 'col' }, 'Detail'),
      ])),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.cells))),
    ]);

    mount(host, [
      el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Gateway refusals in this run' }, table),
      kv([
        ['Denied', denied === null ? NOT_RECORDED : String(denied)],
        ['Blocked', blocked === null ? NOT_RECORDED : String(blocked)],
      ]),
    ]);
  }

  /* ----------------------------------------------------------- verification */

  function renderVerification() {
    const host = byId('block-verification');
    const session = currentSession();
    if (session === null) {
      mount(host, stateBlock(`${NOT_APPLICABLE}.`, 'No run is selected, so there is no verification result to show.'));
      return;
    }

    const resolvedTone = session.resolved === true ? 'ok' : session.resolved === false ? 'danger' : 'neutral';
    const resolvedLabel = session.resolved === true ? 'resolved' : session.resolved === false ? 'not resolved' : `resolved ${NOT_RECORDED}`;

    mount(host, [
      el('div', { class: 'badge-row' }, [
        badge(`state ${fmtText(session.state)}`, session.state === 'functional' ? 'ok' : session.state === 'blocked' ? 'warn' : 'neutral'),
        badge(resolvedLabel, resolvedTone, true),
      ]),
      kv([
        ['Public tests exit', fmtExit(session.publicExit)],
        ['Hidden tests exit', fmtExit(session.hiddenExit)],
        ['State', fmtText(session.state)],
        ['Resolved', fmtBool(session.resolved)],
        ['Model returned', fmtText(session.modelReturned)],
      ]),
      session.publicExit === 0 && session.hiddenExit === 0 && session.resolved === false
        ? el('p', { class: 'prose prose--muted' }, 'Both exit codes are 0 and resolved is false. Both values are printed as recorded.')
          : null,
    ]);
  }

  /* -------------------------------------------------------------- timeline */

  function timelineSteps(session) {
    const observations = observationsOf(session);
    const interventions = interventionsOf(session);
    const first = interventions[0] ?? null;
    const stall = first && isObject(first.stall) ? first.stall : null;
    const failed = observations.filter((item) => item.outcome === 'failed' || item.outcome === 'error');
    const refused = observations.filter((item) => item.outcome === 'denied' || item.outcome === 'blocked');
    const steps = [];

    steps.push({
      id: 'WORKER_STARTED',
      tone: 'neutral',
      status: NOT_APPLICABLE,
      label: NOT_APPLICABLE,
      detail: 'No start event or start timestamp is recorded in sessions[]; the artifact carries only the ordered observations.',
    });

    steps.push(
      failed.length > 0
        ? {
            id: 'TOOL_ERROR',
            tone: 'fail',
            status: 'recorded',
            label: `${failed.length} failed`,
            detail: `Observations with outcome failed or error: ${failed.map((item) => fmtText(item.tool)).join(', ')}.`,
          }
        : {
            id: 'TOOL_ERROR',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: `No observation in this run has outcome failed or error (${observations.length} observations read).`,
          },
    );

    steps.push(
      refused.length > 0
        ? {
            id: 'POLICY_DENIED',
            tone: 'fail',
            status: 'recorded',
            label: `${refused.length} refused`,
            detail: `Observations with outcome denied or blocked: ${refused.map((item) => fmtText(item.tool)).join(', ')}.`,
          }
        : {
            id: 'POLICY_DENIED',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: 'No observation has outcome denied or blocked, and tally.denied and tally.blocked are 0.',
          },
    );

    steps.push(
      session.detected === true
        ? {
            id: 'STALL_DETECTED',
            tone: 'detected',
            status: 'recorded',
            label: 'detected',
            detail: stall === null
              ? 'detected is true; no interventions[].stall object is present.'
              : `stall.kind ${fmtText(stall.kind)}, stall.tool ${fmtText(stall.tool)}, attempt ${fmtNum(stall.attempt)}.`,
          }
        : {
            id: 'STALL_DETECTED',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: session.withheld
              ? `detected is false. withheld: ${String(session.withheld)}`
              : `detected is ${fmtBool(session.detected)} and withheld is ${NOT_RECORDED}.`,
          },
    );

    const sent = interventions.find((item) => item.sent === true) ?? null;
    steps.push(
      sent !== null
        ? {
            id: 'INTERVENTION_SENT',
            tone: 'sent',
            status: 'recorded',
            label: 'sent',
            detail: `kind ${fmtText(sent.kind)}; ${interventions.length} intervention${interventions.length === 1 ? '' : 's'} in the run.`,
          }
        : {
            id: 'INTERVENTION_SENT',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: first === null
              ? 'No interventions[] entry in this run, so no message was sent.'
              : `sent is false for the recorded intervention (kind ${fmtText(first.kind)}); withheld: ${session.withheld ? String(session.withheld) : NOT_RECORDED}.`,
          },
    );

    steps.push(
      session.received === true
        ? {
            id: 'INTERVENTION_RECEIVED',
            tone: 'received',
            status: 'recorded',
            label: 'received',
            detail: 'The worker confirmed receipt: received is true.',
          }
        : {
            id: 'INTERVENTION_RECEIVED',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: `received is ${fmtBool(session.received)}; no receipt was recorded for this run.`,
          },
    );

    steps.push(
      session.resumed === true
        ? {
            id: 'WORKER_RESUMED',
            tone: 'resumed',
            status: 'recorded',
            label: 'resumed',
            detail: 'resumed is true: the work continued after the intervention.',
          }
        : {
            id: 'WORKER_RESUMED',
            tone: 'neutral',
            status: NOT_APPLICABLE,
            label: NOT_APPLICABLE,
            detail: first && first.resumedReason
              ? `resumed is false. resumedReason: ${String(first.resumedReason)}`
              : `resumed is ${fmtBool(session.resumed)} and no resumedReason is recorded.`,
          },
    );

    if (session.resolved === true) {
      steps.push({
        id: 'VERIFICATION_PASSED',
        tone: 'ok',
        status: 'recorded',
        label: 'passed',
        detail: `resolved is true; state ${fmtText(session.state)}; publicExit ${fmtExit(session.publicExit)}; hiddenExit ${fmtExit(session.hiddenExit)}.`,
      });
    } else if (session.resolved === false) {
      steps.push({
        id: 'VERIFICATION_FAILED',
        tone: 'fail',
        status: 'recorded',
        label: 'not resolved',
        detail: `resolved is false; state ${fmtText(session.state)}; publicExit ${fmtExit(session.publicExit)}; hiddenExit ${fmtExit(session.hiddenExit)}.`,
      });
    } else {
      steps.push({
        id: 'VERIFICATION_PASSED/FAILED',
        tone: 'neutral',
        status: NOT_APPLICABLE,
        label: NOT_APPLICABLE,
        detail: 'resolved is not recorded for this run, so neither outcome can be named.',
      });
    }

    return steps;
  }

  function renderTimeline() {
    const host = byId('timeline');
    const session = currentSession();
    if (session === null) {
      mount(host, stateBlock(`${NOT_APPLICABLE}.`, 'No run is selected, so the sequence has no nodes.'));
      return;
    }

    const steps = timelineSteps(session);
    const list = el('ol', { class: 'timeline' });
    for (const step of steps) {
      const title = `${step.id}: ${step.label}. ${step.detail}`;
      list.append(
        el('li', { class: `timeline__item timeline__item--${step.tone}` }, [
          el(
            'div',
            {
              class: 'timeline__node',
              tabindex: '0',
              title,
              'aria-label': title,
            },
            [
              el('span', { class: 'timeline__marker', 'aria-hidden': 'true' }),
              el('span', { class: 'timeline__step' }, step.id),
              el('span', { class: 'timeline__status' }, badge(step.label, step.status === 'recorded' ? step.tone : 'neutral')),
              el('p', { class: 'timeline__detail' }, step.detail),
            ],
          ),
        ]),
      );
    }

    mount(host, list);
  }

  /* ------------------------------------------------------------ comparison */

  function armCell(scenarioId, arm) {
    const list = sessionsFor(scenarioId, arm).filter((session) => session.repetition === view.rep);
    const session = list[0] ?? null;
    if (session === null) {
      return { session: null, functional: null, interventions: null, denials: null, tokens: null, guardTokens: null, latency: null, received: null, resumed: null };
    }
    const interventions = interventionsOf(session);
    const tokens = sumFinite([session.promptTokens, session.completionTokens]);
    return {
      session,
      functional: session.state === 'functional',
      state: session.state,
      interventions: interventions.length,
      sent: interventions.filter((item) => item.sent === true).length,
      denials: denialsOf(session),
      tokens,
      guardTokens: typeof session.guardTokens === 'number' ? session.guardTokens : null,
      latency: typeof session.latencyMs === 'number' ? session.latencyMs : null,
      received: session.received === true,
      resumed: session.resumed === true,
    };
  }

  function renderComparison() {
    const host = byId('compare');
    if (view.scenario === null) {
      mount(host, stateBlock(`${NOT_RECORDED}.`, 'The artifact declares no scenario to compare.'));
      return;
    }

    const arms = armList();
    const cells = arms.map((arm) => armCell(view.scenario, arm));
    const allEqualFunctional =
      cells.length > 1 && cells.every((cell) => cell.functional !== null) && cells.every((cell) => cell.functional === cells[0].functional);

    const globalCounts = arms.map((arm) => {
      const count = functionalCountForArm(arm);
      const runs = sessionsForArm(arm).length;
      return `${arm} ${count === null ? NOT_RECORDED : `${count}/${runs}`}`;
    }).join(', ');

    const verdict = isObject(view.report.verdict) ? view.report.verdict : null;
    const tie = allEqualFunctional;

    const band = el('div', { class: 'band' }, [
      el('span', { class: 'band__text' }, [
        el('strong', {}, 'Global result across all ten scenarios. '),
        `Functional: ${globalCounts}. `,
        verdict ? `Verdict ${verdict.code}. ` : `Verdict ${NOT_RECORDED}. `,
        tie
          ? 'The three arms tie on this scenario: same functional result, no arm ahead.'
          : 'No arm is declared the winner; the table only shows what each run recorded.',
      ]),
      badge(tie ? 'tie, no arm leads' : 'no winner declared', tie ? 'warn' : 'neutral'),
    ]);

    const head = el('tr', {}, [el('th', { scope: 'col' }, 'Metric')]);
    for (const arm of arms) {
      head.append(
        el('th', { scope: 'col' }, [
          el('span', { class: 'arm-chip' }, arm),
          el('span', { class: 'cell-note' }, ARM_NAMES[arm] ?? `${NOT_RECORDED} name`),
        ]),
      );
    }

    const rows = [
      {
        label: 'Functional',
        render: (cell) => (cell.session === null
          ? NOT_RECORDED
          : el('span', {}, [
              badge(cell.functional ? 'yes' : 'no', cell.functional ? 'ok' : 'warn'),
              el('span', { class: 'cell-note' }, `state ${fmtText(cell.state)}`),
            ])),
      },
      {
        label: 'Interventions',
        render: (cell) => (cell.session === null
          ? NOT_RECORDED
          : `${fmtNum(cell.interventions)} recorded, ${fmtNum(cell.sent)} sent`),
      },
      {
        label: 'Policy denials',
        render: (cell) => (cell.session === null ? NOT_RECORDED : fmtNum(cell.denials)),
      },
      {
        label: 'Tokens in + out',
        render: (cell) => (cell.session === null ? NOT_RECORDED : fmtNum(cell.tokens)),
        numeric: true,
      },
      {
        label: 'Guard tokens',
        render: (cell) => (cell.session === null ? NOT_RECORDED : fmtNum(cell.guardTokens)),
        numeric: true,
      },
      {
        label: 'Latency',
        render: (cell) => (cell.session === null ? NOT_RECORDED : fmtMs(cell.latency)),
        numeric: true,
      },
      {
        label: 'Received / resumed',
        render: (cell) => (cell.session === null ? NOT_RECORDED : `${fmtBool(cell.received)} / ${fmtBool(cell.resumed)}`),
      },
    ];

    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr', {}, [el('th', { scope: 'row' }, row.label)]);
      for (const cell of cells) {
        tr.append(el('td', { class: row.numeric ? 'num' : null }, row.render(cell)));
      }
      body.append(tr);
    }

    const table = el('table', { class: 'table table--compare table--sticky-first' }, [
      el('caption', {}, `Scenario ${view.scenario}, repetition ${view.rep === null ? NOT_RECORDED : view.rep}, one column per arm. Functional is sessions[].state === "functional"; tokens is promptTokens + completionTokens; denials is tally.denied + tally.blocked; latency is latencyMs. Nothing here is averaged.`),
      el('thead', {}, head),
      body,
    ]);

    mount(host, [
      band,
      el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': `Scenario comparison for ${view.scenario}` }, table),
    ]);
  }

  /* ------------------------------------------------------------------ help */

  function renderHelp() {
    const host = byId('help-body');
    const list = sessions();
    const total = list.length;
    const resolved = resolvedCount();
    const received = receivedCount();
    const resumed = resumedCount();
    const denials = totalDenials();
    const receivedSessions = list.filter((session) => session.received === true);
    const receivedText = received === null ? NOT_RECORDED : `${received} of ${total}`;
    const resumedText = resumed === null ? NOT_RECORDED : `${resumed} of ${total}`;
    const resolvedText = resolved === null ? NOT_RECORDED : `${resolved} of ${total}`;

    mount(host, [
      el('p', { class: 'prose' }, [
        el('strong', {}, received === 0 || resumed === 0 || resolved === 0 ? 'No. ' : 'Not as a rescue. '),
        `Message received ${receivedText} runs, resumed ${resumedText}, resolved ${resolvedText}.`,
      ]),
      kv([
        [
          'Received',
          receivedSessions.length === 0
            ? `${NOT_RECORDED}: no run reports received`
            : receivedSessions.map((session) => `${session.scenarioId} ${session.arm}`).join(', '),
        ],
        ['Resumed', resumedText],
        ['Resolved', resolvedText],
        ['Policy denials', denials === null ? NOT_RECORDED : `${denials} of ${total} runs`],
      ]),
    ]);
  }

  /* ------------------------------------------------------------------- all */

  function renderAll() {
    if (view.report === null) return;
    renderHero();
    renderPicker();
    renderVerdict();
    renderGlobal();
    renderComparison();
    renderSessionMeta();
    renderWorker();
    renderLifeguard();
    renderGateway();
    renderVerification();
    renderTimeline();
    renderHelp();
    renderFooter();
  }

  function renderFooter() {
    const report = view.report;
    const generated = typeof report.generatedAt === 'string' ? report.generatedAt : NOT_RECORDED;
    const mode = typeof report.mode === 'string' ? report.mode : NOT_RECORDED;
    const manifestPath = typeof report.manifestPath === 'string' ? report.manifestPath : NOT_RECORDED;

    mount(byId('footer-meta'), [
      'generatedAt ',
      mono(generated),
      ', mode ',
      mono(mode),
      ', manifestPath ',
      mono(manifestPath),
      `. Read at ${view.loadedAt instanceof Date ? view.loadedAt.toISOString() : NOT_RECORDED} by this browser.`,
    ]);

    const session = currentSession();
    const links = [el('a', { href: '/' }, 'Live console (continuity)')];
    links.push(document.createTextNode('. '));
    if (session !== null && typeof session.key === 'string') {
      const href = `/?session=${encodeURIComponent(session.key)}`;
      links.push(el('a', { href, title: 'Session key exactly as recorded in the benchmark artifact; the live console resolves its own session identifiers.' }, 'Open this key in the live console'));
      links.push(document.createTextNode(` (${session.key}).`));
    } else {
      links.push(`${NOT_APPLICABLE}: no session key for the current selection.`);
    }
    mount(byId('footer-links'), links);
  }

  /* ------------------------------------------------------------------ boot */

  window.addEventListener('popstate', () => {
    if (view.report === null) return;
    initialiseSelection();
    renderAll();
  });

  load();
})();
